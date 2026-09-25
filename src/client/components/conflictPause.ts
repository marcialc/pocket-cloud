/**
 * A save conflict freezes the game until the player picks a save: an in-game
 * save made meanwhile would be the newest one and replace the other device's
 * save. Resuming waits for the choice.
 */
export class ConflictPause {
  private open = false;
  /** The game should run once the conflict closes (it was running, or the player asked to resume). */
  private resumeAfter = false;

  /** Whether a request to run the game may go ahead now; if not, it runs once the conflict closes. */
  mayRun(): boolean {
    if (!this.open) return true;
    this.resumeAfter = true;
    return false;
  }

  /** The conflict opened or closed: whether to pause or resume the game, or leave it be. */
  update(inConflict: boolean, running: boolean): "pause" | "resume" | null {
    this.open = inConflict;
    if (inConflict && running) {
      this.resumeAfter = true;
      return "pause";
    }
    if (!inConflict && this.resumeAfter) {
      this.resumeAfter = false;
      return "resume";
    }
    return null;
  }
}
