/**
 * One tab per game: two tabs playing the same game each keep their own save and
 * overwrite each other's in the cloud. A Web Lock named after the ROM is held
 * for the whole session; a second tab can't get it and doesn't boot.
 */

export type GameLock = { release: () => void };

// A tab that just closed the game may still be saving it (and React's dev
// remount does the same); give it this long before calling the game taken.
const WAIT_MS = 2000;

/** Holds the game's lock until `release()`. Null: another tab is playing it. */
export async function lockGame(romHash: string, waitMs = WAIT_MS): Promise<GameLock | null> {
  const locks = globalThis.navigator?.locks;
  // No Web Locks (old browser, non-secure origin): play without the guard.
  if (!locks) return { release: () => {} };
  const name = `pocket-cloud:game:${romHash}`;
  return (
    (await hold(locks, name, { ifAvailable: true })) ??
    (await hold(locks, name, { signal: AbortSignal.timeout(waitMs) }).catch(() => null))
  );
}

/**
 * Waits for the game's lock however long the other tab keeps the game open.
 * Null if `signal` aborts first.
 */
export async function waitForGame(romHash: string, signal: AbortSignal): Promise<GameLock | null> {
  const locks = globalThis.navigator?.locks;
  if (!locks) return { release: () => {} };
  return hold(locks, `pocket-cloud:game:${romHash}`, { signal }).catch(() => null);
}

function hold(locks: LockManager, name: string, options: LockOptions): Promise<GameLock | null> {
  return new Promise((resolve, reject) => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    locks
      .request(name, options, (lock) => {
        resolve(lock ? { release } : null);
        return lock ? held : undefined;
      })
      .catch(reject);
  });
}
