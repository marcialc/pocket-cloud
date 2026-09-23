import { describe, expect, it } from "vitest";
import type { CloudSaveMeta } from "../../shared/api";
import type { LocalGameSave } from "./localSaves";
import { decideLaunch, hasUnsyncedChanges, matchCloud, nextPushDelay, resolvePushConflict, retryDelay } from "./sync";

const H = (c: string) => c.repeat(64);

const local = (over: Partial<LocalGameSave> = {}): LocalGameSave => ({
  gameId: "POKEMON RED",
  romHash: H("r"),
  sram: new ArrayBuffer(1),
  sramHash: H("a"),
  updatedAt: 1000,
  playTime: 0,
  cloud: { revision: 1, sramHash: H("a") },
  ...over,
});

const cloud = (over: Partial<CloudSaveMeta> = {}): CloudSaveMeta => ({
  gameId: "POKEMON RED",
  romHash: H("r"),
  sramHash: H("a"),
  sramSize: 32768,
  revision: 1,
  createdAt: 500,
  updatedAt: 1000,
  ...over,
});

describe("clock base", () => {
  it("counts a clock base the cloud doesn't have as unsynced", () => {
    expect(hasUnsyncedChanges(local())).toBe(false);
    expect(hasUnsyncedChanges(local({ rtcBase: 5 }))).toBe(true);
    expect(hasUnsyncedChanges(local({ rtcBase: 5, cloud: { revision: 1, sramHash: H("a"), rtcBase: 5 } }))).toBe(false);
    // The cloud kept another device's base; that's settled, not a reason to re-upload.
    expect(hasUnsyncedChanges(local({ rtcBase: 5, cloud: { revision: 1, sramHash: H("a"), rtcBase: 7 } }))).toBe(false);
  });

  it("takes the cloud's clock base when both hold the same bytes", () => {
    expect(matchCloud(local({ rtcBase: 5 }), cloud({ revision: 2, rtcBase: 7 }))).toMatchObject({
      rtcBase: 7,
      cloud: { revision: 2, sramHash: H("a"), rtcBase: 7 },
    });
  });

  it("keeps this device's clock base when the cloud has none", () => {
    const matched = matchCloud(local({ rtcBase: 5 }), cloud({ revision: 2 }));
    expect(matched.rtcBase).toBe(5);
    expect(matched.cloud).toEqual({ revision: 2, sramHash: H("a") });
    expect(hasUnsyncedChanges(matched)).toBe(true);
  });
});

describe("decideLaunch", () => {
  it("handles empty sides", () => {
    expect(decideLaunch(null, null)).toEqual({ use: "none" });
    expect(decideLaunch(local(), null)).toEqual({ use: "local", push: true });
    expect(decideLaunch(null, cloud())).toEqual({ use: "cloud" });
  });

  it("uses local when both sides hold identical bytes", () => {
    expect(decideLaunch(local({ cloud: null }), cloud({ revision: 9 }))).toEqual({ use: "local", push: false });
  });

  it("pushes local changes when the cloud has not moved", () => {
    const l = local({ sramHash: H("b"), updatedAt: 2000 });
    expect(decideLaunch(l, cloud())).toEqual({ use: "local", push: true });
  });

  it("fast-forwards to the cloud when only the cloud moved", () => {
    expect(decideLaunch(local(), cloud({ revision: 2, sramHash: H("c"), updatedAt: 3000 }))).toEqual({ use: "cloud" });
  });

  it("asks when both diverged and the cloud copy is newer", () => {
    const l = local({ sramHash: H("b"), updatedAt: 2000 });
    const c = cloud({ revision: 2, sramHash: H("c"), updatedAt: 3000 });
    expect(decideLaunch(l, c)).toEqual({ use: "ask", recommended: "cloud" });
  });

  it("keeps and force-pushes local when both diverged and local is newer", () => {
    const l = local({ sramHash: H("b"), updatedAt: 4000 });
    const c = cloud({ revision: 2, sramHash: H("c"), updatedAt: 3000 });
    expect(decideLaunch(l, c)).toEqual({ use: "local", push: true, force: true });
  });

  it("never auto-overwrites the cloud with a save that was never reconciled with it", () => {
    // Regression: a blank save captured on a fresh device right before
    // restoring a player key is "newer" by clock but must not win silently.
    const fresh = local({ cloud: null, sramHash: H("z"), updatedAt: 9999 });
    const real = cloud({ revision: 4, sramHash: H("c"), updatedAt: 1000 });
    expect(decideLaunch(fresh, real)).toEqual({ use: "ask", recommended: "local" });
  });
});

describe("resolvePushConflict", () => {
  it("adopts identical cloud content", () => {
    expect(resolvePushConflict(local(), cloud({ revision: 5 }))).toEqual({ action: "adopt" });
  });
  it("forces when local is newer and shares history", () => {
    expect(resolvePushConflict(local({ sramHash: H("b"), updatedAt: 5000 }), cloud({ revision: 2, sramHash: H("c") }))).toEqual({
      action: "force",
    });
  });
  it("surfaces a conflict when the cloud is newer", () => {
    expect(
      resolvePushConflict(local({ sramHash: H("b") }), cloud({ revision: 2, sramHash: H("c"), updatedAt: 9000 })),
    ).toEqual({ action: "conflict" });
  });
  it("surfaces a conflict when local never synced with this cloud", () => {
    expect(resolvePushConflict(local({ cloud: null, updatedAt: 9999 }), cloud({ sramHash: H("c") }))).toEqual({ action: "conflict" });
  });
});

describe("helpers", () => {
  it("detects unsynced changes", () => {
    expect(hasUnsyncedChanges(local())).toBe(false);
    expect(hasUnsyncedChanges(local({ sramHash: H("b") }))).toBe(true);
    expect(hasUnsyncedChanges(local({ cloud: null }))).toBe(true);
  });

  it("debounces uploads but caps the wait", () => {
    const t = { debounceMs: 4000, maxWaitMs: 20_000 };
    expect(nextPushDelay(1000, 1000, t)).toBe(4000);
    expect(nextPushDelay(18_000, 1000, t)).toBe(3000);
    expect(nextPushDelay(30_000, 1000, t)).toBe(0);
  });

  it("backs off exponentially with a cap", () => {
    expect(retryDelay(1)).toBe(5000);
    expect(retryDelay(3)).toBe(20_000);
    expect(retryDelay(50)).toBe(300_000);
  });
});
