/**
 * Pictures for saves. While the game runs, a frame is kept every couple of
 * seconds, and a save gets one from a few seconds before it was made: at the
 * moment the game writes its save, the screen is usually its own save menu
 * ("SAVING... Don't turn off the power"), not where the player was.
 */

import { MAX_SCREENSHOT_BYTES } from "../../shared/api";
import type { Emulator } from "../emulator/Emulator";

/** How often a frame is kept while the game runs, unless the emulator asks for less (Emulator.screenshotEveryMs). */
export const SHOT_EVERY_MS = 2000;
/** How long before a save its picture is from. */
export const SHOT_LEAD_MS = 5000;
/** Frames kept: enough to reach SHOT_LEAD_MS back at any interval, with some to spare. */
const KEEP = 6;

export type Shot = { at: number; png: Blob };

/**
 * The frame for a save made at `savedAt`: the newest one taken at least
 * `leadMs` before it, or else the oldest kept (the game had only just started).
 */
export function pickShot(shots: readonly Shot[], savedAt: number, leadMs = SHOT_LEAD_MS): Shot | null {
  let best: Shot | null = null;
  for (const shot of shots) if (shot.at <= savedAt - leadMs && (!best || shot.at > best.at)) best = shot;
  if (best) return best;
  for (const shot of shots) if (!best || shot.at < best.at) best = shot;
  return best;
}

export class ScreenKeeper {
  private shots: Shot[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private taking = false;

  constructor(
    private readonly emulator: Emulator,
    private readonly now: () => number = Date.now,
  ) {}

  /** Starts keeping frames (while the game runs; paused games are skipped). */
  start(): void {
    if (this.timer || !this.emulator.screenshot) return;
    this.timer = setInterval(() => void this.take(), this.emulator.screenshotEveryMs ?? SHOT_EVERY_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Forget the frames kept so far (the console was reset, or another save loaded). */
  clear(): void {
    this.shots = [];
  }

  /** PNG bytes for a save made at `savedAt`, or null if there's no frame (or it's too big to keep). */
  async forSave(savedAt: number): Promise<ArrayBuffer | null> {
    const shot = pickShot(this.shots, savedAt);
    if (!shot || shot.png.size > MAX_SCREENSHOT_BYTES) return null;
    return shot.png.arrayBuffer();
  }

  /** Takes one frame now (exposed for tests; the timer calls it). */
  async take(): Promise<void> {
    if (this.taking || !this.emulator.running || !this.emulator.screenshot) return;
    this.taking = true;
    const at = this.now();
    try {
      const png = await this.emulator.screenshot();
      if (!png) return;
      this.shots.push({ at, png });
      if (this.shots.length > KEEP) this.shots.shift();
    } catch (err) {
      console.warn("Could not take a picture of the game", err);
    } finally {
      this.taking = false;
    }
  }
}
