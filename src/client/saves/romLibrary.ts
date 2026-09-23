import type { CloudRomMeta, ListRomsResponse } from "../../shared/api";
import { CloudRomError, uploadCloudRom, type RomUpload } from "./cloudApi";
import { getRom, listRoms, type RomSummary } from "./localSaves";

/**
 * The start screen's game list: this browser's ROMs plus, when signed in, the
 * games kept in the account (which a new device downloads on first play).
 */
export type LibraryEntry = RomSummary & { onDevice: boolean; inCloud: boolean };

export function mergeLibrary(local: RomSummary[], cloud: CloudRomMeta[] | null): LibraryEntry[] {
  const inCloud = new Set(cloud?.map((r) => r.romHash));
  const onDevice = new Set(local.map((r) => r.romHash));
  const entries: LibraryEntry[] = local.map((r) => ({ ...r, onDevice: true, inCloud: inCloud.has(r.romHash) }));
  for (const r of cloud ?? []) {
    if (onDevice.has(r.romHash)) continue;
    entries.push({
      romHash: r.romHash,
      fileName: r.fileName,
      title: r.title || r.fileName,
      size: r.size,
      addedAt: r.uploadedAt,
      // Only for ordering: this device has never played it (the card says so).
      lastPlayedAt: r.uploadedAt,
      onDevice: false,
      inCloud: true,
    });
  }
  return entries.sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);
}

/** Games in this browser that aren't in the account and weren't removed from it. */
export function missingFromAccount(local: RomSummary[], cloud: ListRomsResponse): RomSummary[] {
  const skip = new Set([...cloud.roms.map((r) => r.romHash), ...cloud.removed]);
  return local.filter((r) => !skip.has(r.romHash) && !backedUp.has(r.romHash));
}

const uploading = new Map<string, Promise<void>>();
/**
 * Uploaded to the signed-in account during this page's life, so a list fetched
 * earlier can't cause a second upload. Cleared on account change; a game drops
 * out when it's removed from the account.
 */
const backedUp = new Set<string>();
/** Bumped by resetBackUpState, so an upload that finishes after an account change isn't recorded. */
let generation = 0;

/**
 * Uploads one ROM to the account. A background call for a game that's already
 * uploading shares that request; a picked call waits for it and only uploads if
 * it didn't get the game there (e.g. it was refused because the game was removed).
 * A picked call doesn't trust `backedUp`: the caller has just checked the account's
 * list, and the game may have been removed from another device since.
 */
export function backUpRom(rom: RomUpload, picked = false): Promise<void> {
  const current = uploading.get(rom.romHash);
  if (current && !picked) return current;
  const started = generation;
  const pending: Promise<void> = (async () => {
    if (current && (await current.then(() => true, () => false))) return;
    if (!picked && backedUp.has(rom.romHash)) return;
    await uploadCloudRom(rom, picked);
    if (generation === started) backedUp.add(rom.romHash);
  })().finally(() => {
    if (uploading.get(rom.romHash) === pending) uploading.delete(rom.romHash);
  });
  uploading.set(rom.romHash, pending);
  return pending;
}

/** The game was removed from the account: a later pick must upload it again. */
export function forgetBackUp(romHash: string): void {
  backedUp.delete(romHash);
}

/**
 * Uploads every ROM in this browser the account doesn't have yet, one at a
 * time, skipping games the player removed from the account. Returns how many
 * were uploaded. Stops when `signal` aborts (e.g. sign-out) or the library is full.
 */
export async function backUpLibrary(cloud: ListRomsResponse, signal: AbortSignal): Promise<number> {
  let uploaded = 0;
  for (const summary of missingFromAccount(await listRoms(), cloud)) {
    if (signal.aborted) break;
    const rom = await getRom(summary.romHash);
    if (!rom || signal.aborted) continue;
    try {
      await backUpRom({ romHash: rom.romHash, fileName: rom.fileName, title: rom.title, data: rom.data });
      uploaded++;
    } catch (err) {
      if (err instanceof CloudRomError && err.code === "library_full") break;
      if (!(err instanceof CloudRomError && err.code === "removed")) console.warn("Could not back up a ROM to the account", err);
    }
  }
  return uploaded;
}

/** Forget everything about the previous account's uploads (sign-in, sign-out, tests). */
export function resetBackUpState(): void {
  generation++;
  uploading.clear();
  backedUp.clear();
}
