import { isGameBoyGameId } from "../../shared/platforms";
import type { BoardId } from "../../shared/social";
import type { Emulator } from "./Emulator";

/**
 * Leaderboard scores that live only in a game's work RAM (arcade-style games
 * with no battery save), read while it runs. Saves-based boards (play time,
 * Pokédex) are worked out by the server instead.
 */

/** Follows one game's score from its RAM and remembers the best one seen this session. */
export type ScoreWatcher = {
  board: BoardId;
  sample(emulator: Pick<Emulator, "readMemory" | "lastInputAt">, now?: number): void;
  best(): number;
};

/** Little-endian packed BCD (two decimal digits per byte), or null if any nibble isn't a digit. */
export function readBcd(bytes: number[]): number | null {
  let value = 0;
  for (let i = bytes.length - 1; i >= 0; i--) {
    const hi = bytes[i]! >> 4;
    const lo = bytes[i]! & 0xf;
    if (hi > 9 || lo > 9) return null;
    value = value * 100 + hi * 10 + lo;
  }
  return value;
}

/**
 * Tetris keeps the running score at $C0A0-$C0A2 as 3 BCD bytes (Data Crystal's
 * Tetris RAM map). A round counts only if the score read 0 (a new game clears
 * it; before that RAM holds leftovers) and the player pressed a button after
 * that, so the title screen's demo, which plays itself, never scores.
 */
function tetris(): ScoreWatcher {
  let roundStartedAt: number | null = null;
  let best = 0;
  return {
    board: "tetris",
    sample(emulator, now = performance.now()) {
      if (!emulator.readMemory) return;
      const score = readBcd([emulator.readMemory(0xc0a0), emulator.readMemory(0xc0a1), emulator.readMemory(0xc0a2)]);
      if (score === null) return;
      if (score === 0) roundStartedAt = now;
      else if (roundStartedAt !== null && emulator.lastInputAt > roundStartedAt) best = Math.max(best, score);
    },
    best: () => best,
  };
}

const WATCHERS: Record<string, () => ScoreWatcher> = {
  TETRIS: tetris,
};

/** A watcher for this cartridge (by header title), or null if it has no RAM score we follow. Game Boy only. */
export function scoreWatcherFor(gameId: string): ScoreWatcher | null {
  if (!isGameBoyGameId(gameId)) return null;
  return WATCHERS[gameId]?.() ?? null;
}
