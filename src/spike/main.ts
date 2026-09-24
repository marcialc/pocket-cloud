import { Nostalgist } from "nostalgist";

/**
 * Dev-only Nostalgist spike (spike.html). Answers, on a real phone, the
 * questions the future NostalgistEmulator adapter depends on:
 *
 * - Do the self-hosted 1.22.2 cores (public/vendor/retroarch) launch?
 * - Does READ_CORE_MEMORY round-trip through EmscriptenSendCommand /
 *   EmscriptenReceiveCommandReply, and how late is the reply?
 * - How long does an SRAM flush + read take if we skip saveSRAM() (which hangs
 *   on ROMs without SRAM, nostalgist#60) and read the .srm ourselves?
 * - Does exit + relaunch leak memory or AudioContexts?
 *
 * Everything lives in this file on purpose; lift pieces into the adapter once
 * they're proven.
 */

// ---------------------------------------------------------------------------
// RetroArch internals we reach past Nostalgist for. Nostalgist types the
// Module loosely (and without EmscriptenReceiveCommandReply), so we describe
// the parts we use. All of these are on Module in the 1.22.2 buildbot glue.

type EmscriptenStat = { size: number; mtime: Date; mode: number };

interface EmscriptenFs {
  stat(path: string): EmscriptenStat;
  readFile(path: string, options: { encoding: "binary" }): Uint8Array;
  readdir(path: string): string[];
  isDir(mode: number): boolean;
}

interface RetroArchModule {
  HEAPU8: Uint8Array;
  FS: EmscriptenFs;
  /** Queues a network-control-interface command; RetroArch polls one per frame. */
  EmscriptenSendCommand?: (command: string) => void;
  /** Next queued reply, or undefined when there's none. */
  EmscriptenReceiveCommandReply?: () => string | undefined;
  _cmd_savefiles?: () => void;
  /** Volume gain in dB (audio_set_float(AUDIO_ACTION_VOLUME_GAIN, db)). */
  _cmd_set_volume?: (db: number) => void;
}

interface EmscriptenBrowser {
  mainLoop?: { currentFrameNumber?: number };
}

type Core = "mgba" | "gambatte";
type Button = "up" | "down" | "left" | "right" | "a" | "b" | "l" | "r" | "start" | "select";

const CORE_BASE = new URL(`${import.meta.env.BASE_URL}vendor/retroarch/`, location.href);
/** Directory under saves/ is RetroArch's corename (Nostalgist's coreInfoMap). */
const CORE_SAVE_DIR: Record<Core, string> = { mgba: "mGBA", gambatte: "Gambatte" };
const SAVES_DIR = "/home/web_user/retroarch/userdata/saves";
const PROBE_INTERVAL_MS = 500;
/** A command sent to a Module that then exited (or a paused core) never replies. */
const PROBE_TIMEOUT_MS = 2000;
const SRAM_INTERVAL_MS = 1000;
/** Unanswered probe requests are dropped from the FIFO after this long. */
const PROBE_EXPIRY_MS = 10000;
const MUTED_DB = -80;

/**
 * Keyboard binds we write into retroarch.cfg. Nostalgist's pressDown() looks
 * the button up in this file and fires a synthetic KeyboardEvent with that
 * code straight into RetroArch's JSEvents handlers, so every button we drive
 * needs a bind here, even though real key presses never reach RetroArch.
 */
const BINDS: Record<Button, string> = {
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  a: "x",
  b: "z",
  l: "q",
  r: "w",
  start: "enter",
  select: "rshift",
};

/** Our own keyboard layout (KeyboardEvent.code → button). */
const KEYS: Record<string, Button> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  KeyX: "a",
  KeyZ: "b",
  KeyA: "l",
  KeyS: "r",
  Enter: "start",
  ShiftRight: "select",
  Backspace: "select",
};

// ---------------------------------------------------------------------------
// DOM

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const romInput = $<HTMLInputElement>("rom");
const startButton = $<HTMLButtonElement>("start");
const relaunchButton = $<HTMLButtonElement>("relaunch");
const relaunchCount = $<HTMLInputElement>("relaunch-count");
const closeAudioOnExit = $<HTMLInputElement>("close-audio");
const exitButton = $<HTMLButtonElement>("exit");
const volumeInput = $<HTMLInputElement>("volume");
const muteButton = $<HTMLButtonElement>("mute");
const canvas = $<HTMLCanvasElement>("screen");
const screenBox = $<HTMLDivElement>("screen-box");
const pad = $<HTMLDivElement>("pad");
const probeCmd = $<HTMLSelectElement>("probe-cmd");
const probeAddr = $<HTMLInputElement>("probe-addr");
const probeLen = $<HTMLInputElement>("probe-len");
const probeOn = $<HTMLInputElement>("probe-on");
const probeOut = $<HTMLDivElement>("probe-out");
const sramOn = $<HTMLInputElement>("sram-on");
const sramOut = $<HTMLDivElement>("sram-out");
const logEl = $<HTMLPreElement>("log");
const stat = (id: string) => $<HTMLElement>(id);

const t0 = performance.now();
function log(message: string, isError = false): void {
  const line = document.createElement("div");
  if (isError) line.className = "err";
  line.textContent = `${((performance.now() - t0) / 1000).toFixed(2).padStart(7)}s  ${message}`;
  logEl.append(line);
  logEl.scrollTop = logEl.scrollHeight;
  (isError ? console.error : console.info)("[spike]", message);
}
window.addEventListener("error", (e) => log(`window.onerror: ${e.message}`, true));
window.addEventListener("unhandledrejection", (e) => log(`unhandled rejection: ${String(e.reason)}`, true));

// ---------------------------------------------------------------------------
// AudioContext tracking. RetroArch's RWebAudio driver creates its own context
// inside callMain and doesn't expose it, so we wrap the constructor to see
// (and unlock, suspend, close) every context the core makes.

/** Contexts created by the current emulator instance. */
const audioContexts = new Set<AudioContext>();
/** Every context created on this page, to count the ones still alive (leaks). */
const allAudioContexts: AudioContext[] = [];
const liveAudioContexts = () => allAudioContexts.filter((ctx) => ctx.state !== "closed").length;
{
  const w = window as typeof window & { webkitAudioContext?: typeof AudioContext };
  const Native = window.AudioContext ?? w.webkitAudioContext;
  class TrackedAudioContext extends Native {
    constructor(options?: AudioContextOptions) {
      super(options);
      audioContexts.add(this);
      allAudioContexts.push(this);
      log(
        `AudioContext created (state ${this.state}, ${this.sampleRate} Hz); ` +
          `${allAudioContexts.length} created, ${liveAudioContexts()} live`,
      );
      this.addEventListener("statechange", () => log(`AudioContext → ${this.state}`));
    }
  }
  window.AudioContext = TrackedAudioContext;
  if (w.webkitAudioContext) w.webkitAudioContext = TrackedAudioContext;
}
const unlockAudio = () => {
  for (const ctx of audioContexts) if (ctx.state === "suspended") void ctx.resume();
};
for (const type of ["pointerdown", "keydown", "touchend"] as const) {
  window.addEventListener(type, unlockAudio, { capture: true });
}

// ---------------------------------------------------------------------------
// Session state

let romFile: File | null = null;
let core: Core = "gambatte";
let nostalgist: Nostalgist | null = null;
/** Nostalgist.prepare() result for the picked ROM, awaiting the Start click. */
let prepared: Promise<Nostalgist> | null = null;
/** Last SRAM we read, carried into the next launch so relaunches keep the save. */
let lastSram: Uint8Array | null = null;
let lastSramHash: string | null = null;
let sessionStart = 0;
let volumeDb = Number(volumeInput.value);
let muted = false;
let busy = false;

function module(): RetroArchModule | null {
  if (!nostalgist || nostalgist.getStatus() === "terminated") return null;
  try {
    return nostalgist.getEmscriptenModule() as unknown as RetroArchModule;
  } catch {
    return null;
  }
}

function coreFor(fileName: string): Core | null {
  const ext = fileName.toLowerCase().split(".").pop();
  if (ext === "gba") return "mgba";
  if (ext === "gb" || ext === "gbc") return "gambatte";
  return null;
}

function setStatus(text: string): void {
  stat("status").textContent = text;
}

function setControls(): void {
  const running = nostalgist !== null && nostalgist.getStatus() !== "terminated";
  startButton.disabled = busy || !prepared || running;
  relaunchButton.disabled = busy || !running;
  exitButton.disabled = busy || !running;
}

// ---------------------------------------------------------------------------
// Launch / exit

function launchOptions(file: File): Parameters<typeof Nostalgist.launch>[0] {
  return {
    core,
    // A bare File would get a random name (and so a random .srm path); pass the name.
    rom: { fileName: file.name, fileContent: file },
    sram: lastSram ?? undefined,
    element: canvas,
    // Inline, so it survives RetroArch changing the canvas id (Nostalgist also
    // stops Emscripten from removing inline width/height).
    style: { width: "100%", height: "100%" },
    // Bind RetroArch's keyboard handlers to the canvas, and only for events
    // targeting it. Real keys are swallowed by our window capture listener, so
    // only Nostalgist's synthetic events (pressDown/pressUp) reach the core.
    respondToGlobalEvents: false,
    // Self-hosted cores. URL objects, since Nostalgist's URL sniffing on bare
    // "/vendor/..." strings is heuristic.
    resolveCoreJs: (name) => new URL(`${String(name)}_libretro.js`, CORE_BASE),
    resolveCoreWasm: (name) => new URL(`${String(name)}_libretro.wasm`, CORE_BASE),
    // Keep the downloaded core in memory across exit/relaunch.
    cache: { core: true },
    retroarchConfig: {
      ...Object.fromEntries(Object.entries(BINDS).map(([button, key]) => [`input_player1_${button}`, key])),
      input_menu_toggle: "nul",
      input_menu_toggle_gamepad_combo: 0,
      savestate_auto_load: false,
      savestate_thumbnail_enable: false,
      audio_volume: volumeDb,
      audio_mute_enable: muted,
    },
  };
}

/**
 * Downloads the core and builds the FS without running it, so the Start
 * click can call start() inside its user gesture: RetroArch creates its
 * AudioContext during callMain, and Safari only lets it start "running" there.
 */
function prepare(): void {
  if (!romFile) return;
  const began = performance.now();
  prepared = Nostalgist.prepare(launchOptions(romFile));
  prepared.then(
    () => log(`prepared ${core} in ${Math.round(performance.now() - began)} ms`),
    (error) => log(`prepare failed: ${String(error)}`, true),
  );
}

/** Full launch without a gesture (relaunch loop); audio unlocks on the next tap. */
async function launch(): Promise<Nostalgist> {
  if (!romFile) throw new Error("No ROM picked.");
  const began = performance.now();
  const instance = await Nostalgist.launch(launchOptions(romFile));
  log(`launched ${core} with ${romFile.name} in ${Math.round(performance.now() - began)} ms`);
  afterLaunch(instance);
  return instance;
}

function afterLaunch(instance: Nostalgist): void {
  probePending.length = 0;
  // Nostalgist focuses the canvas when respondToGlobalEvents is false; keep
  // focus off it so a stray real key can't reach RetroArch.
  canvas.blur();
  const m = instance.getEmscriptenModule() as unknown as RetroArchModule;
  log(
    `Module: EmscriptenSendCommand=${typeof m.EmscriptenSendCommand}, ` +
      `EmscriptenReceiveCommandReply=${typeof m.EmscriptenReceiveCommandReply}, ` +
      `_cmd_savefiles=${typeof m._cmd_savefiles}, _cmd_set_volume=${typeof m._cmd_set_volume}`,
  );
}

function exitCurrent(): void {
  if (!nostalgist || nostalgist.getStatus() === "terminated") return;
  const before = audioContexts.size;
  nostalgist.exit({ removeCanvas: false });
  probePending.length = 0;
  // Nostalgist doesn't close RetroArch's AudioContext; iOS caps how many can exist.
  const open = [...audioContexts].filter((ctx) => ctx.state !== "closed");
  if (open.length) {
    const close = closeAudioOnExit.checked;
    log(`exit left ${open.length}/${before} AudioContext(s) open; ${close ? "closing them" : "leaving them open"}`);
    if (close) for (const ctx of open) void ctx.close();
  }
  audioContexts.clear();
}

async function start(): Promise<void> {
  if (busy || !prepared) return;
  busy = true;
  setControls();
  setStatus("launching…");
  try {
    const instance = await prepared;
    prepared = null;
    await instance.start();
    nostalgist = instance;
    log(`started ${core} (AudioContexts: ${[...audioContexts].map((ctx) => ctx.state).join(", ") || "none"})`);
    afterLaunch(instance);
    sessionStart = performance.now();
    setStatus("running");
  } catch (error) {
    log(`launch failed: ${String(error)}`, true);
    setStatus("error");
  } finally {
    busy = false;
    setControls();
  }
}

async function relaunchLoop(): Promise<void> {
  if (busy || !nostalgist) return;
  busy = true;
  setControls();
  try {
    const cycles = Math.max(1, Math.min(200, Math.floor(Number(relaunchCount.value)) || 20));
    await pollSram();
    reportMemory("before relaunch");
    for (let i = 1; i <= cycles; i++) {
      setStatus(`relaunch ${i}/${cycles}`);
      exitCurrent();
      await delay(300);
      nostalgist = await launch();
      sessionStart = performance.now();
      await delay(2000);
      reportMemory(`after relaunch ${i}`);
    }
    setStatus("running");
  } catch (error) {
    log(`relaunch failed: ${String(error)}`, true);
    setStatus("error");
  } finally {
    busy = false;
    setControls();
  }
}

function reportMemory(label: string): void {
  const wasm = module()?.HEAPU8.buffer.byteLength;
  const heap = jsHeapBytes();
  log(
    `${label}: wasm memory ${wasm === undefined ? "n/a" : mb(wasm)}, ` +
      `JS heap ${heap === null ? "n/a (performance.memory is Chromium-only)" : mb(heap)}, ` +
      `AudioContexts ${allAudioContexts.length} created / ${liveAudioContexts()} live`,
  );
}

function jsHeapBytes(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? memory.usedJSHeapSize : null;
}

// ---------------------------------------------------------------------------
// Input: on-screen pad + our own keyboard mapping, both via pressDown/pressUp.

const held = new Map<Button, Set<string>>();

function press(button: Button, source: string): void {
  const sources = held.get(button) ?? new Set();
  const wasDown = sources.size > 0;
  sources.add(source);
  held.set(button, sources);
  if (wasDown || !nostalgist || nostalgist.getStatus() !== "running") return;
  nostalgist.pressDown(button);
  pad.querySelector(`[data-button="${button}"]`)?.classList.add("down");
}

function release(button: Button, source: string): void {
  const sources = held.get(button);
  if (!sources?.delete(source) || sources.size > 0) return;
  pad.querySelector(`[data-button="${button}"]`)?.classList.remove("down");
  if (nostalgist && nostalgist.getStatus() !== "terminated") nostalgist.pressUp(button);
}

for (const el of pad.querySelectorAll<HTMLButtonElement>("button[data-button]")) {
  const button = el.dataset.button as Button;
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    press(button, `pointer${e.pointerId}`);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
    el.addEventListener(type, (e) => release(button, `pointer${e.pointerId}`));
  }
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}

// Registered before any launch, so it runs ahead of RetroArch's listeners.
// Swallows every key outside form fields so RetroArch never sees a real one.
function onKey(e: KeyboardEvent): void {
  const target = e.target as HTMLElement | null;
  if (target?.closest("input, select, textarea")) return;
  e.stopImmediatePropagation();
  const button = KEYS[e.code];
  if (!button) return;
  e.preventDefault();
  if (e.type === "keydown") {
    if (!e.repeat) press(button, "keyboard");
  } else {
    release(button, "keyboard");
  }
}
window.addEventListener("keydown", onKey, { capture: true });
window.addEventListener("keyup", onKey, { capture: true });

// ---------------------------------------------------------------------------
// Volume. _cmd_set_volume takes dB and works while running; audio_volume /
// audio_mute_enable in retroarchConfig set the value a launch starts with.

function applyVolume(): void {
  module()?._cmd_set_volume?.(muted ? MUTED_DB : volumeDb);
}
volumeInput.addEventListener("input", () => {
  volumeDb = Number(volumeInput.value);
  applyVolume();
});
muteButton.addEventListener("click", () => {
  muted = !muted;
  muteButton.textContent = muted ? "Unmute" : "Mute";
  applyVolume();
});

// ---------------------------------------------------------------------------
// Memory probe: READ_CORE_MEMORY <hexaddr> <n> → "READ_CORE_MEMORY <addr> XX XX …"
// or "READ_CORE_MEMORY <addr> -1 <error>". RetroArch parses one queued command
// per frame, so the reply arrives on a later tick.

/** A request awaiting its reply. Latency is measured from the first send, even across resends. */
type ProbeRequest = { command: string; address: string; sentAt: number; resends: number };

/** FIFO of outstanding requests for the current Module (cleared on exit and when hidden). */
const probePending: ProbeRequest[] = [];
let probeStale = 0;

/** Only probe a running, visible game: a paused core still answers, but hidden tabs throttle timers. */
function probeActive(): boolean {
  return nostalgist?.getStatus() === "running" && document.visibilityState === "visible";
}

function pollProbe(): void {
  const m = module();
  if (!m || !probeOn.checked || !probeActive()) return;
  if (!m.EmscriptenSendCommand || !m.EmscriptenReceiveCommandReply) {
    probeOut.textContent = "EmscriptenSendCommand / EmscriptenReceiveCommandReply not exported by this core build.";
    return;
  }
  drainProbeReplies();
  const now = performance.now();
  while (probePending.length && now - probePending[0].sentAt > PROBE_EXPIRY_MS) {
    const expired = probePending.shift()!;
    log(`probe: ${expired.command} ${expired.address} expired unanswered after ${expired.resends} resend(s)`, true);
  }
  const addr = probeAddr.value.trim().replace(/^0x/i, "");
  const len = Math.max(1, Math.min(256, Number(probeLen.value) || 1));
  if (!/^[0-9a-f]+$/i.test(addr)) {
    probeOut.textContent = "Address must be hex.";
    return;
  }
  // RetroArch echoes the address with "%x": lowercase, no leading zeros.
  const address = parseInt(addr, 16).toString(16);
  const command = probeCmd.value;
  const pending = probePending.find((req) => req.command === command && req.address === address);
  if (pending) {
    if (now - pending.sentAt < PROBE_TIMEOUT_MS * (pending.resends + 1)) return;
    pending.resends++;
    log(`probe: no reply after ${Math.round(now - pending.sentAt)} ms; resend #${pending.resends}`, true);
  } else {
    probePending.push({ command, address, sentAt: now, resends: 0 });
  }
  m.EmscriptenSendCommand(`${command} ${addr} ${len}`);
}

/**
 * Runs every animation frame so the logged round trip is frame-accurate, not
 * interval-bound. A reply is matched to the oldest pending request with the
 * same command and address; one with no pending request (sent to an exited
 * Module, before a pause, or an extra answer to a resend) is labelled stale.
 */
function drainProbeReplies(): void {
  const receive = module()?.EmscriptenReceiveCommandReply;
  if (!receive) return;
  for (let reply = receive(); reply !== undefined; reply = receive()) {
    const text = reply.trim();
    const [command, address] = text.split(/\s+/);
    const index = probePending.findIndex((req) => req.command === command && req.address === address);
    if (index < 0) {
      probeStale++;
      log(`probe: stale reply dropped (#${probeStale}): ${text.slice(0, 80)}`);
      continue;
    }
    const [request] = probePending.splice(index, 1);
    const latency = (performance.now() - request.sentAt).toFixed(1);
    const resent = request.resends ? `, resent ${request.resends}×` : "";
    probeOut.textContent = describeReply(text, `${latency} ms from first send${resent}`) + `\nstale replies dropped: ${probeStale}`;
  }
}

function describeReply(reply: string, timing: string): string {
  const [command, address, ...rest] = reply.split(/\s+/);
  if (rest[0] === "-1") return `${command} ${address}: error "${rest.slice(1).join(" ")}" (${timing})\nraw: ${reply}`;
  const bytes = rest.map((hex) => parseInt(hex, 16));
  if (bytes.some(Number.isNaN)) return `unparsed reply (${timing}): ${reply}`;
  return (
    `${command} ${address}: ${rest.join(" ")}\n` +
    `LE BCD: ${bcdLittleEndian(bytes)}   LE uint: ${uintLittleEndian(bytes)}   (${timing})`
  );
}

/** Little-endian packed BCD (Tetris stores its score at C0A0 this way). */
function bcdLittleEndian(bytes: number[]): string {
  let digits = "";
  for (let i = bytes.length - 1; i >= 0; i--) digits += bytes[i].toString(16).padStart(2, "0");
  const value = digits.replace(/^0+(?=.)/, "");
  return /[a-f]/.test(value) ? `${value} (not BCD)` : value;
}

function uintLittleEndian(bytes: number[]): string {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]);
  return value.toString();
}

// ---------------------------------------------------------------------------
// SRAM poll. Instead of saveSRAM() (unlink + _cmd_savefiles + wait up to ~60 s
// for the file, which hangs when the game has no SRAM), flush and read the
// .srm straight from the Emscripten FS. A missing file just means "no SRAM".

let sramPolling = false;

async function pollSram(): Promise<void> {
  const m = module();
  if (!m || !nostalgist || sramPolling || !sramOn.checked) return;
  sramPolling = true;
  try {
    const path = sramPath(nostalgist);
    const began = performance.now();
    const before = statOrNull(m.FS, path);
    m._cmd_savefiles?.();
    // Is the write synchronous? Check right away, then for a few frames.
    let after = statOrNull(m.FS, path);
    let waitedFrames = 0;
    while (waitedFrames < 5 && (!after || (before && after.mtime.getTime() === before.mtime.getTime()))) {
      await nextFrame();
      waitedFrames++;
      after = statOrNull(m.FS, path);
    }
    if (!after) {
      sramOut.textContent = `no ${path} after flush (${Math.round(performance.now() - began)} ms). Saves dir:\n${listSaves(m.FS)}`;
      return;
    }
    const data = m.FS.readFile(path, { encoding: "binary" });
    const hash = fnv1a(data);
    const ms = (performance.now() - began).toFixed(1);
    const rewritten = !before || after.mtime.getTime() !== before.mtime.getTime();
    const how = !rewritten
      ? "NOT flushed: mtime unchanged after 5 frames"
      : waitedFrames === 0
        ? "flushed synchronously"
        : `flushed after ${waitedFrames} frame(s)`;
    const content = lastSramHash === null ? "first read" : hash === lastSramHash ? "content unchanged" : "CONTENT CHANGED";
    sramOut.textContent = `${path}\n${data.length} bytes, fnv1a ${hash}, ${ms} ms\n${how}; ${content}`;
    if (hash !== lastSramHash) {
      if (lastSramHash !== null) log(`save changed at ${new Date().toLocaleTimeString()} (${data.length} bytes, fnv1a ${hash}, poll ${ms} ms)`);
      else log(`first SRAM read: ${data.length} bytes, fnv1a ${hash}, poll ${ms} ms (${how})`);
      lastSramHash = hash;
    }
    lastSram = data.slice();
  } catch (error) {
    sramOut.textContent = `SRAM poll failed: ${String(error)}`;
  } finally {
    sramPolling = false;
  }
}

function sramPath(instance: Nostalgist): string {
  const options = instance.getEmulatorOptions();
  const dir = CORE_SAVE_DIR[options.core.name as Core] ?? options.core.name;
  return `${SAVES_DIR}/${dir}/${options.rom[0].baseName}.srm`;
}

function statOrNull(fs: EmscriptenFs, path: string): EmscriptenStat | null {
  try {
    return fs.stat(path);
  } catch {
    return null;
  }
}

function listSaves(fs: EmscriptenFs, dir = SAVES_DIR, depth = 0): string {
  let out = "";
  let names: string[];
  try {
    names = fs.readdir(dir).filter((name) => name !== "." && name !== "..");
  } catch {
    return `${"  ".repeat(depth)}(missing ${dir})\n`;
  }
  for (const name of names) {
    const path = `${dir}/${name}`;
    const s = statOrNull(fs, path);
    out += `${"  ".repeat(depth)}${name}${s && fs.isDir(s.mode) ? "/" : ` (${s?.size ?? "?"} B)`}\n`;
    if (s && fs.isDir(s.mode) && depth < 2) out += listSaves(fs, path, depth + 1);
  }
  return out || `${"  ".repeat(depth)}(empty)\n`;
}

/** Cheap non-crypto hash; crypto.subtle needs a secure context, and phones on the LAN dev server aren't one. */
function fnv1a(data: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Stats: emulated FPS from Emscripten's main-loop frame counter, session timer.

let lastFrame: number | null = null;
let lastFrameAt = 0;

function updateStats(): void {
  stat("audio").textContent = `${allAudioContexts.length} created / ${liveAudioContexts()} live`;
  const running = nostalgist !== null && nostalgist.getStatus() !== "terminated";
  stat("core").textContent = romFile ? core : "–";
  if (!running) {
    stat("fps").textContent = "–";
    lastFrame = null;
    return;
  }
  const secs = Math.floor((performance.now() - sessionStart) / 1000);
  stat("session").textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  let browser: EmscriptenBrowser | null = null;
  try {
    browser = nostalgist!.getEmscripten().Browser as EmscriptenBrowser;
  } catch {
    // Not ready yet.
  }
  const frame = browser?.mainLoop?.currentFrameNumber;
  const now = performance.now();
  if (frame !== undefined && lastFrame !== null) {
    stat("fps").textContent = ((frame - lastFrame) / ((now - lastFrameAt) / 1000)).toFixed(1);
  } else if (frame === undefined) {
    stat("fps").textContent = "n/a";
  }
  lastFrame = frame ?? null;
  lastFrameAt = now;
  const wasm = module()?.HEAPU8.buffer.byteLength;
  stat("wasm").textContent = wasm === undefined ? "–" : mb(wasm);
  const heap = jsHeapBytes();
  stat("heap").textContent = heap === null ? "n/a" : mb(heap);
}

// ---------------------------------------------------------------------------
// Lifecycle

document.addEventListener("visibilitychange", () => {
  if (!nostalgist || nostalgist.getStatus() === "terminated") return;
  if (document.visibilityState === "hidden") {
    void pollSram();
    nostalgist.pause();
    // Replies to these would measure the time spent hidden; treat them as stale.
    probePending.length = 0;
    for (const ctx of audioContexts) void ctx.suspend();
    log("hidden → paused");
    setStatus("paused (hidden)");
  } else {
    nostalgist.resume();
    unlockAudio();
    log("visible → resumed");
    setStatus("running");
  }
});

romInput.addEventListener("change", () => {
  const file = romInput.files?.[0] ?? null;
  if (!file) return;
  const picked = coreFor(file.name);
  if (!picked) {
    log(`unsupported extension: ${file.name}`, true);
    return;
  }
  exitCurrent();
  nostalgist = null;
  romFile = file;
  core = picked;
  lastSram = null;
  lastSramHash = null;
  screenBox.classList.toggle("gba", core === "mgba");
  log(`picked ${file.name} (${file.size} bytes) → ${core}; press Start (audio needs this gesture)`);
  prepare();
  setStatus("ready");
  setControls();
});

startButton.addEventListener("click", () => void start());
relaunchButton.addEventListener("click", () => void relaunchLoop());
exitButton.addEventListener("click", () => {
  exitCurrent();
  setStatus("exited");
  reportMemory("after exit");
  setControls();
});

setInterval(pollProbe, PROBE_INTERVAL_MS);
const drainLoop = () => {
  drainProbeReplies();
  requestAnimationFrame(drainLoop);
};
requestAnimationFrame(drainLoop);
setInterval(() => void pollSram(), SRAM_INTERVAL_MS);
setInterval(updateStats, 1000);
log(`cores from ${CORE_BASE.href}; Nostalgist loaded`);

// ---------------------------------------------------------------------------
// Helpers

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function mb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
