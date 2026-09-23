import { DEFAULT_KEY_BINDINGS, sameBindings, sanitizeBindings, type KeyBindings } from "../emulator/keyBindings";
import { fetchCloudSettings, putCloudSettings } from "./cloudApi";

/**
 * Keeps the keyboard controls in the signed-in account, so every browser the
 * player signs into uses the same keys. The account's copy wins when a browser
 * loads, except when this browser changed the controls and couldn't upload them
 * yet (offline, server down): then this browser's copy is sent instead.
 */

/** Email of the account whose controls changed here but haven't reached the server. */
const UNSYNCED = "pocket-cloud.controlsUnsynced";

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

/** Saves the controls to the account. Returns once this upload has settled (never rejects). */
export function pushKeyBindings(email: string, bindings: KeyBindings): Promise<void> {
  setUnsynced(email);
  queue = queue.then(
    () => putCloudSettings({ keyBindings: bindings }).then(
      () => setUnsynced(null),
      (err) => {
        setUnsynced(email);
        console.warn("Could not save the controls to the account", err);
      },
    ),
  );
  return queue;
}

/**
 * Run once the signed-in account is known. Returns the account's controls to
 * use here, or null to keep this browser's (uploading them if the account has
 * none yet and they aren't the defaults). Throws if the account can't be reached.
 */
export async function syncKeyBindings(email: string, local: KeyBindings): Promise<KeyBindings | null> {
  if (unsyncedFor() === email) {
    void pushKeyBindings(email, local);
    return null;
  }
  const { keyBindings } = await fetchCloudSettings();
  // Changed here while the request was out: that change is on its way up and wins.
  if (unsyncedFor() === email) return null;
  if (keyBindings) return sanitizeBindings(keyBindings);
  if (!sameBindings(local, DEFAULT_KEY_BINDINGS)) void pushKeyBindings(email, local);
  return null;
}
