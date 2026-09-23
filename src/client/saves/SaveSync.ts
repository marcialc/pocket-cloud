import { sha256Hex, type CloudSaveMeta } from "../../shared/api";
import type { GameBoyEmulator } from "../emulator/GameBoyEmulator";
import type { RomInfo } from "../emulator/rom";
import { CloudUnavailableError, fetchCloudSave, pushCloudSave, type CloudSave } from "./cloudApi";
import { putLocalSave, type LocalGameSave } from "./localSaves";
import { decideLaunch, hasUnsyncedChanges, matchCloud, nextPushDelay, resolvePushConflict, retryDelay, type LaunchDecision } from "./sync";

/**
 * Pipeline: game writes SRAM -> emulator notifies (<=1/s) -> compare bytes ->
 * IndexedDB -> debounced cloud upload -> PlayerSaveDO.
 *
 * Everything here is async and fire-and-forget from the emulator's point of
 * view; a slow or offline cloud never stalls the frame loop.
 */

export type SyncStatus =
  | { state: "idle" }
  | { state: "local-only" }
  | { state: "saved-local"; at: number }
  | { state: "syncing" }
  | { state: "synced"; at: number }
  | { state: "offline"; retryAt: number }
  | { state: "conflict"; cloud: CloudSaveMeta };

const PUSH_TIMING = { debounceMs: 4000, maxWaitMs: 20_000 };
const LAUNCH_CLOUD_TIMEOUT_MS = 3000;

export type LaunchPlan = {
  local: LocalGameSave | null;
  cloud: CloudSave | null;
  decision: LaunchDecision;
  cloudReachable: boolean;
};

/** Decide which SRAM to boot with. Cloud lookup is bounded by a short timeout. */
export async function planLaunch(local: LocalGameSave | null, romHash: string, cloudEnabled: boolean): Promise<LaunchPlan> {
  if (!cloudEnabled) return { local, cloud: null, decision: decideLaunch(local, null), cloudReachable: false };
  try {
    const cloud = await fetchCloudSave(romHash, LAUNCH_CLOUD_TIMEOUT_MS);
    return { local, cloud, decision: decideLaunch(local, cloud), cloudReachable: true };
  } catch {
    // Offline: play from local; the sync loop will reconcile later.
    return { local, cloud: null, decision: local ? { use: "local", push: true } : { use: "none" }, cloudReachable: false };
  }
}

/** Builds the local record for a save adopted from the cloud. */
export function localFromCloud(cloud: CloudSave): LocalGameSave {
  const sram = cloud.sram.slice().buffer;
  return {
    gameId: cloud.gameId,
    romHash: cloud.romHash,
    sram,
    sramHash: cloud.sramHash,
    updatedAt: cloud.updatedAt,
    playTime: cloud.playTime ?? 0,
    ...(cloud.rtcBase !== undefined ? { rtcBase: cloud.rtcBase } : {}),
    cloud: { revision: cloud.revision, sramHash: cloud.sramHash, ...(cloud.rtcBase !== undefined ? { rtcBase: cloud.rtcBase } : {}) },
  };
}

export class SaveSync {
  private local: LocalGameSave | null;
  private status: SyncStatus;
  private readonly listeners = new Set<(s: SyncStatus) => void>();
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private firstDirtyAt = 0;
  private failures = 0;
  private pushing: Promise<void> | null = null;
  private forceNext = false;
  private capturing: Promise<void> = Promise.resolve();
  private playStartedAt: number | null = null;
  private readonly unsubscribe: () => void;
  private destroyed = false;

  constructor(
    private readonly emulator: GameBoyEmulator,
    private readonly rom: RomInfo,
    initial: LocalGameSave | null,
    private cloudEnabled: boolean,
    /** The cartridge clock base the emulator was started with (see emulator/rtc.ts). */
    private rtcBase: number,
  ) {
    this.local = initial;
    if (initial && initial.rtcBase !== this.rtcBase) {
      // Older save without a clock base: keep the one this boot chose, so the clock stops restarting.
      this.local = { ...initial, rtcBase: this.rtcBase };
      putLocalSave(this.local).catch((err) => console.error("could not store the clock base", err));
    }
    this.status = cloudEnabled ? { state: "idle" } : { state: "local-only" };
    this.unsubscribe = emulator.onSramWrite(() => void this.capture());
    // Bytes already in the cloud but the clock base isn't: send it now rather than at the next
    // in-game save, so a second device picks it up instead of choosing its own.
    if (this.local && this.local.cloud?.sramHash === this.local.sramHash && hasUnsyncedChanges(this.local)) {
      this.schedulePush(0);
    }
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  /** The most recent save known on this device. */
  getLocal(): LocalGameSave | null {
    return this.local;
  }

  subscribe(listener: (s: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The cartridge clock base belonging to the current save. */
  getRtcBase(): number {
    return this.rtcBase;
  }

  /** Track play time while the emulator runs. */
  setPlaying(playing: boolean): void {
    if (playing && this.playStartedAt === null) this.playStartedAt = Date.now();
    if (!playing && this.playStartedAt !== null) {
      this.bankPlayTime();
      this.playStartedAt = null;
    }
  }

  setCloudEnabled(enabled: boolean): void {
    this.cloudEnabled = enabled;
    if (!enabled) {
      this.clearTimer();
      this.setStatus({ state: "local-only" });
    } else if (this.local && hasUnsyncedChanges(this.local)) {
      this.schedulePush(0);
    } else {
      this.setStatus(this.local?.cloud ? { state: "synced", at: Date.now() } : { state: "idle" });
    }
  }

  /** Queue an upload right after launch (e.g. local save never reached the cloud). */
  requestPush(force = false): void {
    this.forceNext ||= force;
    this.schedulePush(0);
  }

  /** Persist immediately and try a best-effort upload (page hide / unload). */
  async flush(): Promise<void> {
    // Only real writes by the game trigger a capture (via onSramWrite); never
    // snapshot SRAM speculatively, or a freshly booted game could produce a
    // blank "save" that competes with a real one.
    this.emulator.flushSramWrites();
    await this.capturing;
    if (this.cloudEnabled && this.local && hasUnsyncedChanges(this.local)) {
      this.clearTimer();
      await this.push({ keepalive: true });
    }
  }

  /** Player chose to keep this device's save over a newer cloud copy. */
  keepLocal(): void {
    this.forceNext = true;
    this.schedulePush(0);
  }

  /** Player chose the cloud copy. Returns its SRAM so the caller can reboot with it. */
  async takeCloud(): Promise<Uint8Array | null> {
    const cloud = await fetchCloudSave(this.rom.romHash);
    if (!cloud) return null;
    this.local = localFromCloud(cloud);
    // A cloud save from before the clock was emulated keeps this device's clock.
    this.rtcBase = this.local.rtcBase ??= this.rtcBase;
    await putLocalSave(this.local);
    this.setStatus({ state: "synced", at: Date.now() });
    return cloud.sram;
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribe();
    this.clearTimer();
    this.listeners.clear();
  }

  // --- internals -----------------------------------------------------------

  private capture(): Promise<void> {
    // Serialise captures so two quick notifications can't race each other.
    this.capturing = this.capturing.then(() => this.captureNow()).catch((err) => console.error("save capture failed", err));
    return this.capturing;
  }

  private async captureNow(): Promise<void> {
    const sram = this.emulator.getSram();
    if (!sram) return;
    const sramHash = await sha256Hex(sram);
    if (sramHash === this.local?.sramHash) return; // RAM-enable toggles etc. without real changes.
    this.bankPlayTime();
    this.local = {
      gameId: this.rom.gameId,
      romHash: this.rom.romHash,
      sram: sram.slice().buffer,
      sramHash,
      updatedAt: Date.now(),
      playTime: this.local?.playTime ?? 0,
      rtcBase: this.rtcBase,
      cloud: this.local?.cloud ?? null,
    };
    await putLocalSave(this.local);
    if (this.destroyed) return;
    if (!this.cloudEnabled) {
      this.setStatus({ state: "local-only" });
      return;
    }
    this.setStatus({ state: "saved-local", at: this.local.updatedAt });
    if (!this.firstDirtyAt) this.firstDirtyAt = Date.now();
    this.schedulePush(nextPushDelay(Date.now(), this.firstDirtyAt, PUSH_TIMING));
  }

  private bankPlayTime(): void {
    if (this.playStartedAt === null || !this.local) return;
    const now = Date.now();
    this.local.playTime += now - this.playStartedAt;
    this.playStartedAt = now;
  }

  private schedulePush(delayMs: number): void {
    if (!this.cloudEnabled || this.destroyed) return;
    this.clearTimer();
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.push();
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
  }

  private push(options: { keepalive?: boolean } = {}): Promise<void> {
    // One upload at a time; a later capture reschedules itself.
    this.pushing ??= this.pushNow(options).finally(() => (this.pushing = null));
    return this.pushing;
  }

  private async pushNow(options: { keepalive?: boolean }): Promise<void> {
    const local = this.local;
    if (!local || !this.cloudEnabled || !hasUnsyncedChanges(local)) return;
    if (this.status.state === "conflict" && !this.forceNext) return;
    const force = this.forceNext;
    this.setStatus({ state: "syncing" });
    try {
      const result = await pushCloudSave(
        local.romHash,
        {
          gameId: local.gameId,
          sram: new Uint8Array(local.sram),
          sramHash: local.sramHash,
          updatedAt: local.updatedAt,
          playTime: Math.round(local.playTime),
          ...(local.rtcBase !== undefined ? { rtcBase: local.rtcBase } : {}),
          baseRevision: local.cloud?.revision ?? null,
          ...(force ? { force: true } : {}),
        },
        options,
      );
      this.failures = 0;
      this.forceNext = false;
      if (result.ok) {
        await this.recordCloud(result.save);
        return;
      }
      const resolution = resolvePushConflict(local, result.conflict);
      if (resolution.action === "adopt") {
        await this.recordCloud(result.conflict);
      } else if (resolution.action === "force") {
        this.forceNext = true;
        this.schedulePush(0);
      } else {
        this.setStatus({ state: "conflict", cloud: result.conflict });
      }
    } catch (err) {
      if (!(err instanceof CloudUnavailableError)) throw err;
      this.failures++;
      const delay = retryDelay(this.failures);
      this.setStatus({ state: "offline", retryAt: Date.now() + delay });
      this.schedulePush(delay);
    }
  }

  private async recordCloud(meta: CloudSaveMeta): Promise<void> {
    if (!this.local) return;
    if (meta.sramHash === this.local.sramHash) {
      // If another device's clock base got there first, it wins; this session's clock picks it up at the next boot.
      this.local = matchCloud(this.local, meta);
      this.rtcBase = this.local.rtcBase ?? this.rtcBase;
    } else {
      this.local.cloud = { revision: meta.revision, sramHash: meta.sramHash, ...(meta.rtcBase !== undefined ? { rtcBase: meta.rtcBase } : {}) };
    }
    await putLocalSave(this.local);
    if (hasUnsyncedChanges(this.local)) {
      // The game saved again while we were uploading.
      this.schedulePush(nextPushDelay(Date.now(), this.firstDirtyAt || Date.now(), PUSH_TIMING));
    } else {
      this.firstDirtyAt = 0;
      this.setStatus({ state: "synced", at: Date.now() });
    }
  }

  private setStatus(status: SyncStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }
}
