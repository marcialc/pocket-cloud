import { describe, expect, it } from "vitest";
import { ConflictPause } from "./conflictPause";

describe("ConflictPause", () => {
  it("pauses a running game when a conflict opens and resumes it after the choice", () => {
    const gate = new ConflictPause();
    expect(gate.update(true, true)).toBe("pause");
    expect(gate.update(false, false)).toBe("resume");
  });

  it("leaves a game the player had paused paused after the choice", () => {
    const gate = new ConflictPause();
    expect(gate.update(true, false)).toBeNull();
    expect(gate.update(false, false)).toBeNull();
  });

  it("holds a request to run until the conflict closes", () => {
    const gate = new ConflictPause();
    gate.update(true, false);
    // The player presses Resume, or the tab comes back into view, while the choice is open.
    expect(gate.mayRun()).toBe(false);
    expect(gate.update(false, false)).toBe("resume");
  });

  it("lets the game run while there's no conflict", () => {
    const gate = new ConflictPause();
    expect(gate.mayRun()).toBe(true);
    gate.update(true, true);
    gate.update(false, false);
    expect(gate.mayRun()).toBe(true);
    expect(gate.update(false, true)).toBeNull();
  });
});
