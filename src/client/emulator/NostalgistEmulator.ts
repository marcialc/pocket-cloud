import type { Nostalgist } from "nostalgist";
import { PLATFORMS, type Button, type PlatformId } from "../../shared/platforms";
import type { Emulator } from "./Emulator";

/**
 * Emulator adapter for libretro cores run by RetroArch through Nostalgist
 * (https://nostalgist.js.org). Plays the GBA with mGBA; the cores are
 * self-hosted in public/vendor/retroarch.
 *
 * Nostalgist is imported on first use, so Game Boy players never download it.
 * What src/spike/main.ts proved on real devices, and this relies on:
 *
 * - SRAM: `_cmd_savefiles()` writes the .srm synchronously; we read it from the
 *   Emscripten FS and compare a cheap hash each second. Nostalgist's
 *   saveSRAM() is avoided: it waits forever on games without SRAM (#60).
 * - Input: RetroArch only takes keyboard events aimed at the canvas, and the
 *   canvas never keeps focus, so real keys don't reach it and remapping stays
 *   ours. Buttons go in through pressDown/pressUp, which need a key bind for
 *   each button in retroarch.cfg.
 * - Audio: RetroArch makes its own AudioContext and doesn't expose it, so we
 *   catch it while the core starts to unlock, suspend and close it.
 *
 * Not here yet: readMemory. RetroArch answers `READ_CORE_MEMORY <addr> <n>`
 * through Module.EmscriptenSendCommand / EmscriptenReceiveCommandReply, a
 * frame or two later (~30 ms), so it needs an async variant of
 * Emulator.readMemory before the leaderboards can follow other platforms.
 *
 * Like binjgb, only one NostalgistEmulator should be alive at a time.
 */

const SAVES_DIR = "/home/web_user/retroarch/userdata/saves";
/** RetroArch keeps each core's saves under its display name (Nostalgist's coreInfoMap). */
const CORE_SAVE_DIRS: Record<string, string> = { mgba: "mGBA" };
/** Any fixed name will do: it only decides where RetroArch puts the .srm. */
const ROM_BASE_NAME = "game";
const SRAM_POLL_INTERVAL_MS = 1000;
const MUTED_DB = -80;
const GESTURES = ["pointerdown", "keydown", "touchend"] as const;

/**
 * Keyboard binds written to retroarch.cfg, for pressDown/pressUp to look up.
 * RetroPad names; none of these keys is a RetroArch hotkey.
 */
const BINDS: Partial<Record<Button, string>> = {
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  a: "x",
  b: "z",
  x: "s",
  y: "a",
  l: "q",
  r: "w",
  l2: "e",
  r2: "r",
  start: "enter",
  select: "rshift",
};

/** The parts of RetroArch's Emscripten Module we reach past Nostalgist for. */
interface RetroArchModule {
  FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string, options: { encoding: "binary" }): Uint8Array;
  };
  _cmd_savefiles?: () => void;
  /** Volume gain in dB. */
  _cmd_set_volume?: (db: number) => void;
}

export type NostalgistEmulatorOptions = {
  canvas: HTMLCanvasElement;
  platform: PlatformId;
};

export class NostalgistEmulator implements Emulator {
  private nostalgist: Nostalgist | null = null;
  private rom: ArrayBuffer | null = null;
  /** The core has been started since loadRom(): SRAM now changes by a reset only. */
  private started = false;
  /** RetroArch is starting (first start() or a reset that reloads SRAM); input and SRAM reads wait. */
  private launching: Promise<void> | null = null;
  /** reset() came while launching; runs once the launch is done. */
  private resetQueued = false;
  private failed = false;
  private wantRunning = false;
  private destroyed = false;
  private readonly audioContexts = new Set<AudioContext>();
  private audioUnlockArmed = false;
  private restoreWakeLock: (() => void) | null = null;
  private volume = 0.6;
  private muted = false;
  private readonly pressed = new Set<Button>();
  lastInputAt = 0;

  /** Last SRAM seen (loaded or read back), and its hash for cheap change checks. */
  private sram: Uint8Array | null = null;
  private sramHash: string | null = null;
  /** Holds a real save (not the blank buffer a game has before its first save). */
  private sramReal = false;
  /** Loaded while the game ran; applied by the next reset(), like swapping the cartridge's battery RAM. */
  private sramToLoad: Uint8Array | null = null;
  private sramDirty = false;
  private sramTimer: ReturnType<typeof setInterval> | null = null;
  private readonly sramListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();

  // Browsers only allow audio after a user gesture, and the core starts after an await.
  private readonly unlockAudio = () => this.resumeAudio();
  // RetroArch focuses the canvas on launch and on every tap; real keys aimed at it would reach the core.
  private readonly blurCanvas = () => this.options.canvas.blur();

  constructor(private readonly options: NostalgistEmulatorOptions) {
    options.canvas.addEventListener("focus", this.blurCanvas);
  }

  get running(): boolean {
    return this.wantRunning && this.rom !== null && !this.failed;
  }

  async loadRom(rom: ArrayBuffer): Promise<void> {
    this.exitCore();
    this.rom = rom.slice(0);
    this.started = false;
    this.failed = false;
    this.setSram(null);
    this.sramToLoad = null;
    const nostalgist = await this.prepare();
    if (this.destroyed) {
      exitNostalgist(nostalgist);
      throw new Error("Emulator was destroyed while loading.");
    }
    this.nostalgist = nostalgist;
  }

  start(): void {
    if (this.failed) return;
    if (!this.rom || (!this.nostalgist && !this.launching)) throw new Error("No ROM loaded.");
    if (this.wantRunning) return;
    this.wantRunning = true;
    this.sramTimer ??= setInterval(() => {
      this.pollSram();
      this.flushSramNotification();
    }, SRAM_POLL_INTERVAL_MS);
    if (!this.started) {
      this.started = true;
      this.launch(this.boot(this.nostalgist!));
    } else if (!this.launching) {
      this.nostalgist!.resume();
      this.resumeAudio();
    }
  }

  pause(): void {
    if (!this.wantRunning) return;
    this.pollSram();
    this.wantRunning = false;
    if (this.nostalgist && this.started && !this.launching) this.nostalgist.pause();
    this.suspendAudio();
    this.flushSramNotification();
  }

  reset(): void {
    if (!this.started || this.failed) return;
    if (this.launching) {
      this.resetQueued = true;
      return;
    }
    // RetroArch only reads the .srm when a game loads, so a new save needs a fresh launch.
    if (this.sramToLoad) this.relaunch();
    else this.nostalgist!.sendCommand("RESET");
  }

  buttonDown(button: Button): void {
    this.lastInputAt = performance.now();
    this.pressed.add(button);
    if (this.hasButton(button)) this.liveCore()?.pressDown(button);
  }

  buttonUp(button: Button): void {
    this.pressed.delete(button);
    if (this.hasButton(button)) this.liveCore()?.pressUp(button);
  }

  getSram(): Uint8Array | null {
    if (this.sramToLoad) return this.sramToLoad.slice();
    // A fresh read, but the poll's view stays put so it still reports the write.
    const data = this.readSram() ?? this.sram;
    return data && (this.sramReal || !isBlank(data)) ? data.slice() : null;
  }

  loadSram(data: Uint8Array): void {
    if (!this.rom) throw new Error("No ROM loaded.");
    if (this.started) {
      this.sramToLoad = data.slice();
      return;
    }
    this.writeSramFile(data);
    this.setSram(data);
  }

  onSramWrite(listener: () => void): () => void {
    this.sramListeners.add(listener);
    return () => this.sramListeners.delete(listener);
  }

  /** Called if RetroArch fails to start (the game then stays stopped). */
  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  flushSramWrites(): void {
    this.pollSram();
    this.flushSramNotification();
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    this.applyVolume();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyVolume();
  }

  destroy(): void {
    this.destroyed = true;
    this.wantRunning = false;
    if (this.sramTimer) clearInterval(this.sramTimer);
    this.sramTimer = null;
    this.sramListeners.clear();
    this.errorListeners.clear();
    this.disarmAudioUnlock();
    this.options.canvas.removeEventListener("focus", this.blurCanvas);
    this.exitCore();
    this.restoreWakeLock?.();
    this.restoreWakeLock = null;
    this.rom = null;
  }

  // --- internals -----------------------------------------------------------

  private async prepare(): Promise<Nostalgist> {
    const { Nostalgist } = await import("nostalgist");
    const platform = PLATFORMS[this.options.platform];
    const coreBase = new URL(`${import.meta.env.BASE_URL}vendor/retroarch/`, location.href);
    const binds = Object.fromEntries(
      platform.buttons.flatMap((button) => (BINDS[button] ? [[`input_player1_${button}`, BINDS[button]]] : [])),
    );
    // Downloads the core (kept in memory for later launches) and fills its file system; start() runs it.
    return Nostalgist.prepare({
      core: platform.core,
      // A bare buffer would get a random name, and so a random .srm path. Not an ArrayBuffer:
      // Nostalgist takes that for a name to resolve.
      rom: { fileName: `${ROM_BASE_NAME}${platform.extensions[0]}`, fileContent: new Uint8Array(this.rom!) },
      element: this.options.canvas,
      // Only events aimed at the canvas reach RetroArch, and the canvas never keeps focus.
      respondToGlobalEvents: false,
      // URL objects: Nostalgist's sniffing of bare "/vendor/..." strings is heuristic.
      resolveCoreJs: (core) => new URL(`${String(core)}_libretro.js`, coreBase),
      resolveCoreWasm: (core) => new URL(`${String(core)}_libretro.wasm`, coreBase),
      cache: { core: true },
      retroarchConfig: {
        ...binds,
        input_menu_toggle: "nul",
        input_menu_toggle_gamepad_combo: 0,
        savestate_auto_load: false,
        savestate_thumbnail_enable: false,
        // Crisp pixels; RetroArch sizes its framebuffer to the canvas in device pixels.
        video_smooth: false,
        audio_volume: this.volumeDb(),
      },
    });
  }

  /** Runs RetroArch (the first time after loadRom, or after a relaunch). */
  private async boot(nostalgist: Nostalgist): Promise<void> {
    this.restoreWakeLock ??= swallowWakeLockErrors();
    const contexts = new Set<AudioContext>();
    const release = catchAudioContexts(contexts);
    try {
      await nostalgist.start();
    } finally {
      release();
    }
    if (this.destroyed || this.nostalgist !== nostalgist) {
      // Torn down or replaced while starting: this core must not keep running.
      exitNostalgist(nostalgist);
      closeAudio(contexts);
      return;
    }
    for (const ctx of contexts) this.audioContexts.add(ctx);
    // Still launching, so not through applyVolume(): the volume may have changed since prepare().
    (nostalgist.getEmscriptenModule() as unknown as RetroArchModule)._cmd_set_volume?.(this.volumeDb());
    for (const button of this.pressed) if (this.hasButton(button)) nostalgist.pressDown(button);
    if (this.wantRunning) {
      this.resumeAudio();
    } else {
      nostalgist.pause();
      this.suspendAudio();
    }
  }

  private launch(launching: Promise<void>): void {
    const done = launching
      .catch((err: unknown) => this.fail(err))
      .finally(() => {
        if (this.launching !== done) return;
        this.launching = null;
        if (this.resetQueued && !this.destroyed) {
          this.resetQueued = false;
          this.reset();
        }
      });
    this.launching = done;
  }

  /** Power-cycles with the save from loadSram(): exit RetroArch and launch the game again. */
  private relaunch(): void {
    this.exitCore();
    this.launch(
      (async () => {
        const nostalgist = await this.prepare();
        if (this.destroyed) return exitNostalgist(nostalgist);
        // Taken only now: loadSram() may have brought a newer save while the core downloaded.
        const sram = this.sramToLoad;
        this.sramToLoad = null;
        this.nostalgist = nostalgist;
        if (sram) {
          this.writeSramFile(sram);
          this.setSram(sram);
        }
        await this.boot(nostalgist);
      })(),
    );
  }

  private fail(err: unknown): void {
    console.error("The emulator failed to start", err);
    this.failed = true;
    this.wantRunning = false;
    this.resetQueued = false;
    this.exitCore();
    if (this.destroyed) return;
    const error = new Error("The emulator failed to start.", { cause: err });
    for (const listener of this.errorListeners) listener(error);
  }

  private exitCore(): void {
    const nostalgist = this.nostalgist;
    this.nostalgist = null;
    if (nostalgist) exitNostalgist(nostalgist);
    // Nostalgist leaves RetroArch's AudioContext open, and iOS only allows a few.
    closeAudio(this.audioContexts);
    this.audioContexts.clear();
    this.disarmAudioUnlock();
  }

  /** Nostalgist once RetroArch runs the game; null before, while (re)launching and after exit. */
  private liveCore(): Nostalgist | null {
    const nostalgist = this.nostalgist;
    if (!nostalgist || !this.started || this.launching || nostalgist.getStatus() === "terminated") return null;
    return nostalgist;
  }

  private module(): RetroArchModule | null {
    return (this.liveCore()?.getEmscriptenModule() as unknown as RetroArchModule | undefined) ?? null;
  }

  private hasButton(button: Button): boolean {
    return PLATFORMS[this.options.platform].buttons.includes(button) && BINDS[button] !== undefined;
  }

  private sramPath(): string {
    const { core } = PLATFORMS[this.options.platform];
    return `${SAVES_DIR}/${CORE_SAVE_DIRS[core] ?? core}/${ROM_BASE_NAME}.srm`;
  }

  /** Flushes and reads the .srm; null if the core isn't running or the game has no save file. */
  private readSram(): Uint8Array | null {
    const m = this.module();
    if (!m) return null;
    m._cmd_savefiles?.();
    let data: Uint8Array;
    try {
      data = m.FS.readFile(this.sramPath(), { encoding: "binary" }).slice();
    } catch {
      return null;
    }
    // mGBA writes the whole save chip, 0xFF past what a smaller loaded save held (an 8 KiB save
    // comes back as 32 KiB). Keep the loaded size, so an unplayed boot isn't a new save to sync.
    const size = this.sramReal ? this.sram!.length : 0;
    return size && data.length > size && data.subarray(size).every((b) => b === 0xff) ? data.subarray(0, size) : data;
  }

  /** Before the game starts, where RetroArch loads it from. */
  private writeSramFile(data: Uint8Array): void {
    const m = this.nostalgist!.getEmscriptenModule() as unknown as RetroArchModule;
    const path = this.sramPath();
    m.FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));
    m.FS.writeFile(path, data);
  }

  private setSram(data: Uint8Array | null): void {
    this.sram = data && data.slice();
    this.sramHash = data && fnv1a(data);
    this.sramReal = data !== null && !isBlank(data);
  }

  private pollSram(): void {
    if (!this.wantRunning) return;
    const data = this.readSram();
    if (!data) return;
    const hash = fnv1a(data);
    if (hash === this.sramHash) return;
    this.sram = data;
    this.sramHash = hash;
    // Until a game first saves, its save area is blank. That's no save, not a new one to sync.
    if (!this.sramReal && isBlank(data)) return;
    this.sramReal = true;
    this.sramDirty = true;
  }

  private flushSramNotification(): void {
    if (!this.sramDirty) return;
    this.sramDirty = false;
    for (const listener of this.sramListeners) listener();
  }

  /** Resumes RetroArch's audio; if the browser holds it back until a gesture, tries again on the next one. */
  private resumeAudio(): void {
    if (!this.wantRunning) return;
    const waiting = [...this.audioContexts].filter((ctx) => ctx.state === "suspended");
    if (!waiting.length) return this.disarmAudioUnlock();
    this.armAudioUnlock();
    void Promise.all(waiting.map((ctx) => ctx.resume())).then(
      () => {
        if (![...this.audioContexts].some((ctx) => ctx.state === "suspended")) this.disarmAudioUnlock();
      },
      () => {},
    );
  }

  private suspendAudio(): void {
    for (const ctx of this.audioContexts) if (ctx.state === "running") void ctx.suspend();
  }

  private armAudioUnlock(): void {
    if (this.audioUnlockArmed || this.destroyed) return;
    this.audioUnlockArmed = true;
    for (const type of GESTURES) window.addEventListener(type, this.unlockAudio, { capture: true });
  }

  private disarmAudioUnlock(): void {
    if (!this.audioUnlockArmed) return;
    this.audioUnlockArmed = false;
    for (const type of GESTURES) window.removeEventListener(type, this.unlockAudio, { capture: true });
  }

  private volumeDb(): number {
    return this.muted || this.volume === 0 ? MUTED_DB : Math.max(MUTED_DB, 20 * Math.log10(this.volume));
  }

  private applyVolume(): void {
    this.module()?._cmd_set_volume?.(this.volumeDb());
  }
}

function exitNostalgist(nostalgist: Nostalgist): void {
  if (nostalgist.getStatus() === "terminated") return;
  try {
    nostalgist.exit({ removeCanvas: false });
  } catch (err) {
    // A core that never started has little to tear down.
    console.warn("Could not exit the emulator cleanly", err);
  }
}

function closeAudio(contexts: Set<AudioContext>): void {
  for (const ctx of contexts) if (ctx.state !== "closed") void ctx.close();
}

/** All bytes 0x00 or all 0xFF: memory no game has written. */
function isBlank(data: Uint8Array): boolean {
  const first = data[0];
  return (first === 0x00 || first === 0xff) && data.every((b) => b === first);
}

/** Cheap non-crypto hash: only tells "changed" apart; SaveSync fingerprints saves with SHA-256. */
function fnv1a(data: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i]!, 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Replaces `target[key]` until the returned function puts the original property back. */
function patch<T extends object>(target: T, key: PropertyKey, value: unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  return () => {
    if (original) Object.defineProperty(target, key, original);
    else delete (target as Record<PropertyKey, unknown>)[key];
  };
}

/** Boots in progress, oldest first; the constructor stays wrapped while there are any. */
const audioCatchers = new Set<Set<AudioContext>>();
let restoreAudioContext: (() => void) | null = null;

/**
 * AudioContexts created until the returned function is called go into
 * `contexts` (RetroArch makes its own while it starts). Overlapping calls share
 * one wrapper, and the last release puts the browser's own constructors back.
 */
function catchAudioContexts(contexts: Set<AudioContext>): () => void {
  const w = window as typeof window & { webkitAudioContext?: typeof AudioContext };
  audioCatchers.add(contexts);
  const Native = w.AudioContext ?? w.webkitAudioContext;
  if (!restoreAudioContext && Native) {
    class TrackedAudioContext extends Native {
      constructor(options?: AudioContextOptions) {
        super(options);
        // The newest boot is the live one: an older one still in progress is about to be thrown away.
        [...audioCatchers].at(-1)?.add(this);
      }
    }
    const restores = [patch(window, "AudioContext", TrackedAudioContext)];
    if (w.webkitAudioContext) restores.push(patch(window, "webkitAudioContext", TrackedAudioContext));
    restoreAudioContext = () => restores.reverse().forEach((restore) => restore());
  }
  return () => {
    if (!audioCatchers.delete(contexts) || audioCatchers.size > 0) return;
    restoreAudioContext?.();
    restoreAudioContext = null;
  };
}

/** RetroArch asks for a screen wake lock and leaves the rejection unhandled when it's denied. */
function swallowWakeLockErrors(): () => void {
  const wakeLock = typeof navigator === "undefined" ? undefined : navigator.wakeLock;
  if (!wakeLock) return () => {};
  const request = wakeLock.request;
  return patch(wakeLock, "request", function (this: WakeLock, type?: WakeLockType) {
    const sentinel = request.call(this, type);
    sentinel.catch(() => {});
    return sentinel;
  });
}
