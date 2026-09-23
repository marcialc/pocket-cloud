import type { GameBoyButton, GameBoyEmulator } from "./GameBoyEmulator";
import { loadBinjgb, type BinjgbModule } from "./binjgbModule";
import { hasRtc, rtcRegisters } from "./rtc";

/**
 * GameBoyEmulator adapter for binjgb (https://github.com/binji/binjgb).
 *
 * The frame loop, tick accounting and audio scheduling follow upstream's
 * docs/simple.js. Differences: rendering goes through a 2D canvas scaled with
 * CSS (crisp on every browser), volume goes through a GainNode, and rewind is
 * left out.
 *
 * Note: binjgb's JS wrapper keeps the active emulator in a C global, so only
 * one BinjgbEmulator should be alive at a time.
 */

const SCREEN_WIDTH = 160;
const SCREEN_HEIGHT = 144;
const CPU_TICKS_PER_SECOND = 4194304;
const EVENT_NEW_FRAME = 1;
const EVENT_AUDIO_BUFFER_FULL = 2;
const EVENT_UNTIL_TICKS = 4;
const AUDIO_FRAMES = 4096;
const AUDIO_LATENCY_SEC = 0.1;
const MAX_UPDATE_SEC = 5 / 60;
const CGB_COLOR_CURVE = 2; // Gambatte-style colour correction.
const SRAM_NOTIFY_INTERVAL_MS = 1000;

export type BinjgbOptions = {
  canvas: HTMLCanvasElement;
  /** Index into binjgb's built-in DMG palettes (builtin-palettes.def upstream). */
  palette?: number;
};

type JoypadSetter = (e: number, set: number) => void;

export class BinjgbEmulator implements GameBoyEmulator {
  private module: BinjgbModule | null = null;
  private e = 0;
  private romPtr = 0;
  private romSize = 0;
  private joypadPtr = 0;
  private rom: ArrayBuffer | null = null;
  /** Wall-clock time the cartridge clock read zero (see rtc.ts); null until setClock(). */
  private clockBase: number | null = null;
  /** The game has run since the core was created, so the mapper is no longer in its power-on state. */
  private coreStarted = false;
  private destroyed = false;

  private readonly ctx2d: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private readonly audioCtx: AudioContext;
  private readonly gain: GainNode;
  private audioStartSec = 0;
  private volume = 0.6;
  private muted = false;

  private rafId: number | null = null;
  private lastRafSec = 0;
  private leftoverTicks = 0;
  private readonly pressed = new Set<GameBoyButton>();

  private sramDirty = false;
  private sramTimer: ReturnType<typeof setInterval> | null = null;
  private readonly sramListeners = new Set<() => void>();
  private readonly unlockAudio = () => void this.audioCtx.resume();

  constructor(private readonly options: BinjgbOptions) {
    options.canvas.width = SCREEN_WIDTH;
    options.canvas.height = SCREEN_HEIGHT;
    const ctx = options.canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is not available.");
    this.ctx2d = ctx;
    this.image = ctx.createImageData(SCREEN_WIDTH, SCREEN_HEIGHT);

    this.audioCtx = new AudioContext();
    this.gain = this.audioCtx.createGain();
    this.gain.connect(this.audioCtx.destination);
    this.applyGain();
    // Browsers only allow audio after a user gesture.
    for (const type of ["pointerdown", "keydown", "touchend"] as const) {
      window.addEventListener(type, this.unlockAudio, { capture: true });
    }
  }

  get running(): boolean {
    return this.rafId !== null;
  }

  async loadRom(rom: ArrayBuffer): Promise<void> {
    const module = await loadBinjgb();
    if (this.destroyed) throw new Error("Emulator was destroyed while loading.");
    this.module = module;
    this.destroyCore();
    this.rom = rom.slice(0);
    this.clockBase = null;
    this.createCore();
  }

  start(): void {
    this.requireCore();
    if (this.running) return;
    this.coreStarted = true;
    this.lastRafSec = 0;
    this.leftoverTicks = 0;
    this.audioStartSec = 0;
    void this.audioCtx.resume();
    this.sramTimer ??= setInterval(() => this.flushSramNotification(), SRAM_NOTIFY_INTERVAL_MS);
    this.rafId = requestAnimationFrame(this.frame);
  }

  pause(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    void this.audioCtx.suspend();
    this.flushSramNotification();
  }

  reset(): void {
    const wasRunning = this.running;
    this.pause();
    const sram = this.getSram();
    this.destroyCore();
    this.createCore();
    if (sram) this.loadSram(sram);
    // A power cycle doesn't stop the cartridge clock; this also corrects any drift.
    this.applyClock();
    for (const button of this.pressed) this.setButton(button, true);
    if (wasRunning) this.start();
  }

  buttonDown(button: GameBoyButton): void {
    this.pressed.add(button);
    this.setButton(button, true);
  }

  buttonUp(button: GameBoyButton): void {
    this.pressed.delete(button);
    this.setButton(button, false);
  }

  getSram(): Uint8Array | null {
    const m = this.module;
    if (!m || !this.e) return null;
    return this.withExtRam((fileData, size) => {
      if (size === 0) return null;
      m._emulator_write_ext_ram(this.e, fileData);
      return m.HEAPU8.slice(m._get_file_data_ptr(fileData), m._get_file_data_ptr(fileData) + size);
    });
  }

  loadSram(data: Uint8Array): void {
    const m = this.requireCore();
    this.withExtRam((fileData, size) => {
      if (size !== data.byteLength) {
        throw new Error(`Save size mismatch: cartridge has ${size} bytes, save has ${data.byteLength}.`);
      }
      m.HEAPU8.set(data, m._get_file_data_ptr(fileData));
      m._emulator_read_ext_ram(this.e, fileData);
    });
  }

  onSramWrite(listener: () => void): () => void {
    this.sramListeners.add(listener);
    return () => this.sramListeners.delete(listener);
  }

  flushSramWrites(): void {
    this.flushSramNotification();
  }

  setClock(baseMs: number): void {
    this.requireCore();
    this.clockBase = baseMs;
    // Writing the clock clobbers mapper state the running game relies on; reset() applies it instead.
    if (!this.coreStarted) this.applyClock();
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    this.applyGain();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyGain();
  }

  readMemory(address: number): number {
    const m = this.requireCore();
    return m._emulator_read_mem(this.e, address & 0xffff);
  }

  destroy(): void {
    this.destroyed = true;
    this.pause();
    if (this.sramTimer) clearInterval(this.sramTimer);
    this.sramTimer = null;
    this.sramListeners.clear();
    for (const type of ["pointerdown", "keydown", "touchend"] as const) {
      window.removeEventListener(type, this.unlockAudio, { capture: true });
    }
    this.destroyCore();
    void this.audioCtx.close();
    this.rom = null;
  }

  // --- internals -----------------------------------------------------------

  private createCore(): void {
    const m = this.module!;
    const rom = new Uint8Array(this.rom!);
    // binjgb expects the ROM buffer padded to a 32 KiB boundary.
    this.romSize = (rom.byteLength + 0x7fff) & ~0x7fff;
    this.romPtr = m._malloc(this.romSize);
    m.HEAPU8.fill(0, this.romPtr, this.romPtr + this.romSize);
    m.HEAPU8.set(rom, this.romPtr);
    this.coreStarted = false;
    this.e = m._emulator_new_simple(this.romPtr, this.romSize, this.audioCtx.sampleRate, AUDIO_FRAMES, CGB_COLOR_CURVE);
    if (!this.e) {
      m._free(this.romPtr);
      this.romPtr = 0;
      throw new Error("This file does not look like a valid Game Boy ROM.");
    }
    // Input is routed through binjgb's default joypad callback (buttons set via set_joyp_*).
    this.joypadPtr = m._joypad_new();
    m._emulator_set_default_joypad_callback(this.e, this.joypadPtr);
    if (this.options.palette !== undefined) m._emulator_set_builtin_palette(this.e, this.options.palette);
    this.ctx2d.fillStyle = "#000";
    this.ctx2d.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
  }

  private destroyCore(): void {
    const m = this.module;
    if (!m) return;
    if (this.e) m._emulator_delete(this.e);
    if (this.joypadPtr) m._joypad_delete(this.joypadPtr);
    if (this.romPtr) m._free(this.romPtr);
    this.e = this.joypadPtr = this.romPtr = 0;
  }

  private requireCore(): BinjgbModule {
    if (!this.module || !this.e) throw new Error("No ROM loaded.");
    return this.module;
  }

  private withExtRam<T>(fn: (fileData: number, size: number) => T): T {
    const m = this.module!;
    const fileData = m._ext_ram_file_data_new(this.e);
    try {
      return fn(fileData, m._get_file_data_size(fileData));
    } finally {
      m._file_data_delete(fileData);
    }
  }

  /**
   * Writes the clock registers the same way a game sets the time: enable RAM,
   * latch (binjgb ignores clock writes unless latched), select each register at
   * 0x4000 and write it at 0xA000. Only safe before the game runs its first
   * instruction; the mapper is then put back in its power-on state.
   * binjgb keeps counting from here in emulated time.
   */
  private applyClock(): void {
    const m = this.module!;
    if (this.clockBase === null || !hasRtc(new Uint8Array(this.rom!)[0x147]!)) return;
    const { sec, min, hour, day, carry } = rtcRegisters(this.clockBase, Date.now());
    const write = (address: number, value: number) => m._emulator_write_mem(this.e, address, value);
    write(0x0000, 0x0a);
    write(0x6000, 0x00);
    write(0x6000, 0x01);
    for (const [register, value] of [
      [0x08, sec],
      [0x09, min],
      [0x0a, hour],
      [0x0b, day & 0xff],
      // Day bit 8, carry in bit 7; halt (bit 6) stays clear so the clock runs.
      [0x0c, (day >> 8) | (carry ? 0x80 : 0)],
    ] as const) {
      write(0x4000, register);
      write(0xa000, value);
    }
    write(0x4000, 0x00);
    write(0x6000, 0x00);
    write(0x0000, 0x00);
  }

  private setButton(button: GameBoyButton, down: boolean): void {
    const m = this.module;
    if (!m || !this.e) return;
    const setters: Record<GameBoyButton, JoypadSetter> = {
      up: m._set_joyp_up, down: m._set_joyp_down, left: m._set_joyp_left, right: m._set_joyp_right,
      a: m._set_joyp_A, b: m._set_joyp_B, start: m._set_joyp_start, select: m._set_joyp_select,
    };
    setters[button](this.e, down ? 1 : 0);
  }

  private applyGain(): void {
    this.gain.gain.value = this.muted ? 0 : this.volume;
  }

  private flushSramNotification(): void {
    if (!this.sramDirty) return;
    this.sramDirty = false;
    for (const listener of this.sramListeners) listener();
  }

  private readonly frame = (nowMs: number): void => {
    this.rafId = requestAnimationFrame(this.frame);
    const m = this.module!;
    const nowSec = nowMs / 1000;
    const deltaSec = Math.max(nowSec - (this.lastRafSec || nowSec), 0);
    const deltaTicks = Math.min(deltaSec, MAX_UPDATE_SEC) * CPU_TICKS_PER_SECOND;
    const untilTicks = m._emulator_get_ticks_f64(this.e) + deltaTicks - this.leftoverTicks;
    this.runUntil(untilTicks);
    this.leftoverTicks = (m._emulator_get_ticks_f64(this.e) - untilTicks) | 0;
    this.lastRafSec = nowSec;
    this.ctx2d.putImageData(this.image, 0, 0);
  };

  private runUntil(ticks: number): void {
    const m = this.module!;
    for (;;) {
      const event = m._emulator_run_until_f64(this.e, ticks);
      if (event & EVENT_NEW_FRAME) {
        const ptr = m._get_frame_buffer_ptr(this.e);
        this.image.data.set(m.HEAPU8.subarray(ptr, ptr + SCREEN_WIDTH * SCREEN_HEIGHT * 4));
      }
      if (event & EVENT_AUDIO_BUFFER_FULL) this.pushAudio();
      if (event & EVENT_UNTIL_TICKS) break;
    }
    if (m._emulator_was_ext_ram_updated(this.e)) this.sramDirty = true;
  }

  private pushAudio(): void {
    const m = this.module!;
    const ctx = this.audioCtx;
    if (ctx.state !== "running") return;
    const now = ctx.currentTime;
    this.audioStartSec ||= now + AUDIO_LATENCY_SEC;
    if (this.audioStartSec < now) {
      // Fell behind (tab throttled, GC pause...): resync instead of queueing stale audio.
      this.audioStartSec = now + AUDIO_LATENCY_SEC;
      return;
    }
    const src = m.HEAPU8.subarray(m._get_audio_buffer_ptr(this.e));
    const buffer = ctx.createBuffer(2, AUDIO_FRAMES, ctx.sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let i = 0; i < AUDIO_FRAMES; i++) {
      left[i] = src[2 * i]! / 255;
      right[i] = src[2 * i + 1]! / 255;
    }
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.gain);
    node.start(this.audioStartSec);
    this.audioStartSec += AUDIO_FRAMES / ctx.sampleRate;
  }
}
