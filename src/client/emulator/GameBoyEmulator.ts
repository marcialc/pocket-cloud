/**
 * Emulator-agnostic interface. The rest of the app only talks to this; the
 * binjgb specifics live in BinjgbEmulator. Swapping emulators means writing a
 * new adapter, not touching UI or save code.
 */

export type GameBoyButton = "up" | "down" | "left" | "right" | "a" | "b" | "start" | "select";

export const GAME_BOY_BUTTONS: readonly GameBoyButton[] = [
  "up", "down", "left", "right", "a", "b", "start", "select",
];

export interface GameBoyEmulator {
  loadRom(rom: ArrayBuffer): Promise<void>;
  /** Start or resume execution. */
  start(): void;
  pause(): void;
  /** Power-cycle the console. Battery RAM survives, like real hardware. */
  reset(): void;
  readonly running: boolean;

  buttonDown(button: GameBoyButton): void;
  buttonUp(button: GameBoyButton): void;

  /** Battery-backed cartridge RAM, or null if the cartridge has none. */
  getSram(): Uint8Array | null;
  /** Restore battery RAM. Call after loadRom() and before start(). */
  loadSram(data: Uint8Array): void;
  /**
   * Called (at most every `intervalMs`) after the game wrote to cartridge RAM.
   * Returns an unsubscribe function.
   */
  onSramWrite(listener: () => void): () => void;
  /** Deliver any pending onSramWrite notification now (e.g. before the page unloads). */
  flushSramWrites(): void;

  setVolume(volume: number): void;
  setMuted(muted: boolean): void;

  /**
   * Read-only access to the CPU address space (0x0000-0xFFFF). Hook for later
   * game-state extraction (player position, party, badges...) using addresses
   * from pret/pokered's symbol file.
   */
  readMemory(address: number): number;

  destroy(): void;
}
