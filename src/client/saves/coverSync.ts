import { deleteCloudCover, downloadCloudCover, listCloudCovers, uploadCloudCover } from "./cloudApi";
import { listCoverRecords, updateCustomCover, type CustomCover } from "./customCovers";

/**
 * Keeps the cover images picked for games in the signed-in account, so they show
 * on every device. The account's list is the truth, except for changes made here
 * that haven't reached it yet: an image picked here (no version) is uploaded, and
 * one removed here (a `removed` marker) is deleted from it. Then this browser
 * takes every image the account has that it lacks or holds an older version of,
 * and drops synced images the account no longer has (removed on another device).
 * A cover the player changes while this runs is left for the next run.
 *
 * Runs one at a time. Resolves true when the covers to show changed.
 * Throws when the account can't be reached (or the player isn't signed in).
 */
export function syncCovers(): Promise<boolean> {
  const run = queue.then(syncOnce, syncOnce);
  queue = run.catch(() => false);
  return run;
}

let queue: Promise<boolean> = Promise.resolve(false);

/** Holds an image the account has, not a change made here. */
const synced = (c: CustomCover | undefined): c is CustomCover => !!c && c.version !== undefined && !c.removed;

async function syncOnce(): Promise<boolean> {
  const cloud = new Map((await listCloudCovers()).map((c) => [c.romHash, c.version]));
  let changed = false;
  for (const record of await listCoverRecords()) {
    const { romHash } = record;
    if (record.removed) {
      await deleteCloudCover(romHash);
      await updateCustomCover(romHash, (c) => (c?.removed ? null : undefined));
      cloud.delete(romHash);
    } else if (record.version === undefined) {
      const { version } = await uploadCloudCover(romHash, record.data, record.type);
      await updateCustomCover(romHash, (c) => (c && !c.removed && !c.version && c.edited === record.edited ? { ...c, version } : undefined));
      cloud.delete(romHash);
    } else if (!cloud.has(romHash)) {
      await updateCustomCover(romHash, (c) => (synced(c) && c.version === record.version ? null : undefined));
      changed = true;
    } else if (cloud.get(romHash) === record.version) {
      cloud.delete(romHash);
    }
  }
  // Left: images this browser doesn't have, or has an older version of.
  for (const [romHash, version] of cloud) {
    const image = await downloadCloudCover(romHash);
    if (!image) continue;
    await updateCustomCover(romHash, (c) => (!c || synced(c) ? { romHash, data: image.data, type: image.type, version } : undefined));
    changed = true;
  }
  return changed;
}
