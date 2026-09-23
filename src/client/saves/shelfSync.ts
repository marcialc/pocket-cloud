import { EMPTY_SHELF, sameShelf, sanitizeShelf, type Shelf } from "../../shared/shelf";
import { SettingsRejectedError, fetchCloudSettings, putCloudSettings } from "./cloudApi";

/**
 * Keeps the library's favorites and groups in the signed-in account, so every
 * browser the player signs into shows them. Works like the controls sync: the
 * account's copy wins when a browser loads, unless this browser changed the
 * shelf and couldn't upload it yet (then this browser's copy is sent instead).
 */

/** Email of the account whose shelf changed here but hasn't reached the server. */
const UNSYNCED = "pocket-cloud.shelfUnsynced";

function unsyncedFor(): string | null {
  try {
    return localStorage.getItem(UNSYNCED);
  } catch {
    return null;
  }
}

function setUnsynced(email: string | null): void {
  try {
    if (email) localStorage.setItem(UNSYNCED, email);
    else localStorage.removeItem(UNSYNCED);
  } catch {
    // Storage blocked: the account's copy wins on the next load.
  }
}

// Uploads run one at a time, in order, so the last change is the one that sticks.
let queue: Promise<void> = Promise.resolve();

/** Saves the shelf to the account. Returns once this upload has settled (never rejects). */
export function pushShelf(email: string, shelf: Shelf): Promise<void> {
  setUnsynced(email);
  queue = queue.then(
    () => putCloudSettings({ shelf }).then(
      () => setUnsynced(null),
      (err) => {
        // Turned down for good: stop retrying it, so the next load takes the account's copy again.
        setUnsynced(err instanceof SettingsRejectedError ? null : email);
        console.warn("Could not save the library groups to the account", err);
      },
    ),
  );
  return queue;
}

/** Signing out: this browser's unsent changes belonged to that account, so drop them. */
export function forgetUnsyncedShelf(): void {
  setUnsynced(null);
}

/**
 * Run once the signed-in account is known. Returns the account's shelf to use
 * here, or null to keep this browser's (uploading it if the account has none
 * yet and it isn't empty). Throws if the account can't be reached.
 */
export async function syncShelf(email: string, local: Shelf): Promise<Shelf | null> {
  if (unsyncedFor() === email) {
    void pushShelf(email, local);
    return null;
  }
  const { shelf } = await fetchCloudSettings();
  // Changed here while the request was out: that change is on its way up and wins.
  if (unsyncedFor() === email) return null;
  if (shelf) return sanitizeShelf(shelf);
  if (!sameShelf(local, EMPTY_SHELF)) void pushShelf(email, local);
  return null;
}
