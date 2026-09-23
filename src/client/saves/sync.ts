import type { CloudSaveMeta } from "../../shared/api";
import type { LocalGameSave } from "./localSaves";

/**
 * Pure save-reconciliation rules. Kept free of I/O so they are easy to test.
 *
 * Vocabulary:
 * - "local has unsynced changes": the local SRAM differs from what we last
 *   saw in the cloud (or we never synced).
 * - "cloud moved": the cloud revision differs from the one we last reconciled
 *   with, i.e. another device uploaded since.
 */

export type LaunchDecision =
  | { use: "none" }
  | { use: "local"; push: boolean; force?: boolean }
  | { use: "cloud" }
  /** Both sides changed in ways we can't safely order: let the player choose. */
  | { use: "ask"; recommended: "cloud" | "local" };

export function hasUnsyncedChanges(local: LocalGameSave): boolean {
  if (local.cloud?.sramHash !== local.sramHash) return true;
  // An older save that just got its clock base: the cloud needs it too.
  return local.rtcBase !== undefined && local.cloud.rtcBase === undefined;
}

/** What this device records after seeing `cloud` hold the same bytes as `local`. */
export function matchCloud(local: LocalGameSave, cloud: CloudSaveMeta): LocalGameSave {
  // The cloud's clock base wins, so every device shows the same in-game time.
  const rtcBase = cloud.rtcBase ?? local.rtcBase;
  return {
    ...local,
    ...(rtcBase !== undefined ? { rtcBase } : {}),
    cloud: { revision: cloud.revision, sramHash: cloud.sramHash, ...(cloud.rtcBase !== undefined ? { rtcBase: cloud.rtcBase } : {}) },
  };
}

export function decideLaunch(local: LocalGameSave | null, cloud: CloudSaveMeta | null): LaunchDecision {
  if (!local && !cloud) return { use: "none" };
  if (!cloud) return { use: "local", push: true };
  if (!local) return { use: "cloud" };

  if (cloud.sramHash === local.sramHash) return { use: "local", push: false };

  const cloudMoved = local.cloud?.revision !== cloud.revision;
  const localChanged = hasUnsyncedChanges(local);

  if (!cloudMoved) return { use: "local", push: localChanged };
  // Cloud has a newer revision and we have nothing unsynced: fast-forward.
  if (!localChanged) return { use: "cloud" };
  const newer = cloud.updatedAt > local.updatedAt ? "cloud" : "local";
  // Never reconciled with this player's cloud (new device, restored identity):
  // there is no common ancestor, so clocks alone can't justify overwriting.
  if (!local.cloud) return { use: "ask", recommended: newer };
  // Diverged from a shared revision. Newest wins, but never silently discard a newer cloud save.
  if (newer === "cloud") return { use: "ask", recommended: "cloud" };
  return { use: "local", push: true, force: true };
}

export type PushConflictResolution =
  /** Cloud already has these bytes; just record its revision. */
  | { action: "adopt" }
  /** Local is newer; overwrite the cloud copy. */
  | { action: "force" }
  /** Cloud is newer (or unrelated); the player has to decide. */
  | { action: "conflict" };

/** What to do when an upload is rejected because the cloud moved underneath us. */
export function resolvePushConflict(local: LocalGameSave, cloud: CloudSaveMeta): PushConflictResolution {
  if (cloud.sramHash === local.sramHash) return { action: "adopt" };
  // Without a shared revision we can't tell which side is the continuation.
  if (!local.cloud) return { action: "conflict" };
  if (local.updatedAt >= cloud.updatedAt) return { action: "force" };
  return { action: "conflict" };
}

/** Debounce schedule for cloud uploads: wait for quiet, but never longer than maxWait. */
export function nextPushDelay(
  now: number,
  firstDirtyAt: number,
  { debounceMs, maxWaitMs }: { debounceMs: number; maxWaitMs: number },
): number {
  return Math.max(0, Math.min(debounceMs, firstDirtyAt + maxWaitMs - now));
}

/** Exponential backoff for failed uploads, capped. */
export function retryDelay(attempt: number, baseMs = 5000, capMs = 5 * 60_000): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
}
