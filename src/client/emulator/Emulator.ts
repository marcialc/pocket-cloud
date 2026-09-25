import type { Button } from "../../shared/platforms";

/**
 * Emulator-agnostic interface. The rest of the app only talks to this; the
 * binjgb specifics live in BinjgbEmulator. Swapping emulators means writing a
 * new adapter, not touching UI or save code.
 *
 * Optional members are capabilities only some cores have (the Game Boy's
 * real-time clock, raw memory reads); callers check before using them.
 */
export interface Emulator {
  loadRom(rom: ArrayBuffer): Promise<void>;
  /** Start or resume execution. */
  start(): void;
  pause(): void;
  /** Power-cycle the console. Battery RAM survives, like real hardware. */
  reset(): void;
  readonly running: boolean;

  /** Buttons the loaded platform doesn't have are ignored. */
  buttonDown(button: Button): void;
  /** `performance.now()` of the last button press, 0 if none: tells real play from a game's demo. */
  readonly lastInputAt: number;
  buttonUp(button: Button): void;

  /** Battery-backed cartridge RAM, or null if the cartridge has none. */
  getSram(): Uint8Array | null;
  /** Restore battery RAM. Call after loadRom() and before start(). */
  loadSram(data: Uint8Array): void;
  /**
   * Called (at most every `intervalMs`) after the game wrote to cartridge RAM.
   * Returns an unsubscribe function.
   */
  onSramWrite(listener: () => void): () => void;
  /**
   * Set the cartridge's real-time clock (Pokémon Gold/Silver/Crystal) as if its
   * battery went in at `baseMs`, so it reads the real time passed since then.
   * Applied at once if the game hasn't started since power-on (call after
   * loadRom(), before start()); otherwise at the next reset(). Survives reset(),
   * like the battery. No-op for cartridges without a clock.
   *
   * Only catches up with real time at power-on: while running, the clock
   * advances with emulated time, so it stops while paused or in a background
   * tab and falls behind until the next boot or reset().
   */
  setClock?(baseMs: number): void;
  /**
   * Called if the core fails after start() (cores that start asynchronously);
   * the game then stays stopped. Returns an unsubscribe function.
   */
  onError?(listener: (error: Error) => void): () => void;
  /**
   * Snapshot of the whole console (CPU, memory, cartridge RAM) to carry on
   * from later with loadState(); null if there's nothing to snapshot yet.
   */
  saveState?(): Promise<Uint8Array | null>;
  /**
   * Carry on from a saveState() snapshot of the same ROM instead of powering
   * on. Call after loadRom(), loadSram() and setClock(), before start(). Throws
   * if the snapshot doesn't fit this core; the console is then left as it was
   * (cores that start asynchronously find out then, and boot normally).
   * The cartridge clock resumes from the snapshot's time and catches up with
   * real time at the next reset().
   */
  loadState?(data: Uint8Array): void;
  /** Deliver any pending onSramWrite notification now (e.g. before the page unloads). */
  flushSramWrites(): void;

  setVolume(volume: number): void;
  setMuted(muted: boolean): void;

  /**
   * Read-only access to the CPU address space (0x0000-0xFFFF). Hook for later
   * game-state extraction (player position, party, badges...) using addresses
   * from pret/pokered's symbol file.
   */
  readMemory?(address: number): number;

  destroy(): void;
}
