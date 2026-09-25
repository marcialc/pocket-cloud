import { afterEach, describe, expect, it, vi } from "vitest";
import { lockGame, waitForGame } from "./gameLock";

/** Exclusive-only stand-in for navigator.locks (Node has none). */
function fakeLocks() {
  const held = new Set<string>();
  const waiting: { name: string; grant: () => void }[] = [];
  const run = async (name: string, callback: LockGrantedCallback<unknown>) => {
    held.add(name);
    try {
      return await callback({ name, mode: "exclusive" } as Lock);
    } finally {
      held.delete(name);
      waiting.find((w) => w.name === name)?.grant();
    }
  };
  return {
    held,
    request(name: string, options: LockOptions, callback: LockGrantedCallback<unknown>): Promise<unknown> {
      if (!held.has(name)) return run(name, callback);
      if (options.ifAvailable) return Promise.resolve(callback(null));
      return new Promise((resolve, reject) => {
        const entry = { name, grant: () => (waiting.splice(waiting.indexOf(entry), 1), resolve(run(name, callback))) };
        waiting.push(entry);
        options.signal?.addEventListener("abort", () => (waiting.splice(waiting.indexOf(entry), 1), reject(options.signal!.reason)));
      });
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("lockGame", () => {
  it("lets one tab play a game at a time", async () => {
    const locks = fakeLocks();
    vi.stubGlobal("navigator", { locks });
    const first = await lockGame("a", 20);
    expect(first).not.toBeNull();
    expect(locks.held.has("pocket-cloud:game:a")).toBe(true);
    expect(await lockGame("a", 20)).toBeNull(); // the other tab
    expect(await lockGame("b", 20)).not.toBeNull(); // a different game is fine

    first!.release();
    await vi.waitFor(() => expect(locks.held.has("pocket-cloud:game:a")).toBe(false));
    expect(await lockGame("a", 20)).not.toBeNull();
  });

  it("waits briefly for a tab that is still closing the game", async () => {
    vi.stubGlobal("navigator", { locks: fakeLocks() });
    const closing = await lockGame("a", 20);
    const next = lockGame("a", 1000);
    setTimeout(() => closing!.release(), 10);
    expect(await next).not.toBeNull();
  });

  it("plays without the guard where Web Locks are missing", async () => {
    vi.stubGlobal("navigator", {});
    expect(await lockGame("a")).not.toBeNull();
    expect(await lockGame("a")).not.toBeNull();
  });
});

describe("waitForGame", () => {
  it("gets the game once the other tab lets go", async () => {
    const locks = fakeLocks();
    vi.stubGlobal("navigator", { locks });
    const other = await lockGame("a", 20);
    const waiting = waitForGame("a", new AbortController().signal);
    await new Promise((r) => setTimeout(r, 30));
    other!.release();
    expect(await waiting).not.toBeNull();
    expect(locks.held.has("pocket-cloud:game:a")).toBe(true);
  });

  it("stops waiting when aborted", async () => {
    vi.stubGlobal("navigator", { locks: fakeLocks() });
    await lockGame("a", 20);
    const abort = new AbortController();
    const waiting = waitForGame("a", abort.signal);
    abort.abort();
    expect(await waiting).toBeNull();
  });
});
