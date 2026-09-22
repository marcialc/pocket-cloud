#!/usr/bin/env node
/**
 * Headless smoke test for the vendored binjgb core.
 *
 * Boots a ROM you provide (it is read locally and never copied anywhere),
 * plays a scripted sequence of button presses, writes PNG screenshots and
 * reports battery-RAM activity. Useful to verify emulator upgrades without a
 * browser.
 *
 *   node scripts/smoke.mjs <rom.gb> [--out dir] [--sram in.sav] [--save-sram out.sav] [--script "..."]
 *
 * Script syntax (space separated): `wait:<frames>` | `<button>` (tap) |
 * `<button>*<n>` (tap n times) | `shot:<name>`. Buttons: up down left right a b start select.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import zlib from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const vendor = join(here, "..", "public", "vendor", "binjgb");

const args = process.argv.slice(2);
const romPath = args[0];
if (!romPath) {
  console.error("usage: node scripts/smoke.mjs <rom.gb> [--out dir] [--sram in.sav] [--save-sram out.sav] [--script ...]");
  process.exit(1);
}
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const outDir = resolve(opt("out", "smoke-out"));
const script = opt("script", "wait:240 shot:boot start wait:120 shot:after-start");
mkdirSync(outDir, { recursive: true });

// Load the Emscripten glue in a sandbox that looks enough like a browser.
const wasm = readFileSync(join(vendor, "binjgb.wasm"));
const sandbox = {
  console,
  URL,
  WebAssembly,
  TextDecoder,
  setTimeout,
  clearTimeout,
  fetch: async () => new Response(wasm, { headers: { "Content-Type": "application/wasm" } }),
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(vendor, "binjgb.js"), "utf8"), sandbox);
const m = await vm.runInContext("Binjgb", sandbox)({ locateFile: (p) => p });

const rom = readFileSync(romPath);
const size = (rom.length + 0x7fff) & ~0x7fff;
const romPtr = m._malloc(size);
m.HEAPU8.fill(0, romPtr, romPtr + size);
m.HEAPU8.set(rom, romPtr);
const e = m._emulator_new_simple(romPtr, size, 44100, 4096, 2);
if (!e) throw new Error("binjgb rejected the ROM");
m._emulator_set_default_joypad_callback(e, m._joypad_new());
m._emulator_set_builtin_palette(e, 23);

const withExtRam = (fn) => {
  const fd = m._ext_ram_file_data_new(e);
  try {
    return fn(m._get_file_data_ptr(fd), m._get_file_data_size(fd), fd);
  } finally {
    m._file_data_delete(fd);
  }
};
const sramIn = opt("sram");
if (sramIn) {
  const data = readFileSync(sramIn);
  withExtRam((ptr, len, fd) => {
    if (len !== data.length) throw new Error(`SRAM size ${data.length} != cartridge ${len}`);
    m.HEAPU8.set(data, ptr);
    m._emulator_read_ext_ram(e, fd);
  });
}
const readSram = () =>
  withExtRam((ptr, len, fd) => {
    m._emulator_write_ext_ram(e, fd);
    return Buffer.from(m.HEAPU8.slice(ptr, ptr + len));
  });

const setters = {
  up: m._set_joyp_up, down: m._set_joyp_down, left: m._set_joyp_left, right: m._set_joyp_right,
  a: m._set_joyp_A, b: m._set_joyp_B, start: m._set_joyp_start, select: m._set_joyp_select,
};

let frames = 0;
let audioBuffers = 0;
let sramWrites = 0;
let nonSilentAudio = 0;
function runFrame() {
  for (;;) {
    const ev = m._emulator_run_until_f64(e, m._emulator_get_ticks_f64(e) + 70224);
    if (ev & 2) {
      audioBuffers++;
      const a = m.HEAPU8.subarray(m._get_audio_buffer_ptr(e), m._get_audio_buffer_ptr(e) + 8192);
      if (a.some((v) => v !== a[0])) nonSilentAudio++;
    }
    if (ev & 4) break;
  }
  if (m._emulator_was_ext_ram_updated(e)) sramWrites++;
  frames++;
}
const wait = (n) => { for (let i = 0; i < n; i++) runFrame(); };
const tap = (button) => {
  setters[button](e, 1);
  wait(6);
  setters[button](e, 0);
  wait(14);
};

function png(name) {
  const ptr = m._get_frame_buffer_ptr(e);
  const rgba = m.HEAPU8.slice(ptr, ptr + 160 * 144 * 4);
  const raw = Buffer.alloc(144 * (1 + 160 * 4));
  for (let y = 0; y < 144; y++) {
    raw[y * (1 + 640)] = 0;
    for (let x = 0; x < 160 * 4; x += 4) {
      const o = y * 640 + x;
      raw.set([rgba[o], rgba[o + 1], rgba[o + 2], 255], y * 641 + 1 + x);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(160, 0); ihdr.writeUInt32BE(144, 4); ihdr[8] = 8; ihdr[9] = 6;
  const file = join(outDir, `${name}.png`);
  writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]));
  console.log(`frame ${frames}: ${file}`);
}

const initialSram = readSram();
for (const step of script.split(/\s+/).filter(Boolean)) {
  const [cmd, arg] = step.split(":");
  if (cmd === "wait") wait(Number(arg));
  else if (cmd === "shot") png(arg);
  else {
    const [button, times] = cmd.split("*");
    if (!setters[button]) throw new Error(`unknown step ${step}`);
    for (let i = 0; i < Number(times ?? 1); i++) tap(button);
  }
}

const finalSram = readSram();
const saveOut = opt("save-sram");
if (saveOut) writeFileSync(saveOut, finalSram);
console.log(JSON.stringify({
  frames,
  audioBuffers,
  nonSilentAudioBuffers: nonSilentAudio,
  sramSize: finalSram.length,
  sramWriteFrames: sramWrites,
  sramChanged: !initialSram.equals(finalSram),
}, null, 2));
