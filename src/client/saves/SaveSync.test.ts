import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameBoyEmulator } from "../emulator/GameBoyEmulator";
import type { RomInfo } from "../emulator/rom";
import { bytesToBase64 } from "../../shared/api";
import { deleteLocalSave, getLocalSave, type LocalGameSave } from "./localSaves";
import { SaveSync } from "./SaveSync";

const ROM: RomInfo = {
  gameId: "POKEMON RED", title: "POKEMON RED", romHash: "e".repeat(64),
  cartridgeType: 0x13, hasBattery: true, cgb: false, size: 0x100000,
};
const RTC_BASE = 1_700_000_000_000;

/** Minimal emulator double: SRAM is a plain array, writes are announced on flush. */
function fakeEmulator() {
  let sram = new Uint8Array(16);
  let pending = false;
  const listeners = new Set<() => void>();
  const emu = {
    getSram: () => sram.slice(),
    onSramWrite: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
    flushSramWrites: () => {
      if (pending) listeners.forEach((l) => l());
      pending = false;
    },
    gameWrites(bytes: number[]) {
      sram = new Uint8Array(16);
      sram.set(bytes);
      pending = true;
    },
  };
  return emu as unknown as GameBoyEmulator & typeof emu;
}

beforeEach(() => {
  // identity.ts keeps the player key in localStorage, which Node lacks.
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await deleteLocalSave(ROM.romHash);
});

describe("SaveSync", () => {
  it("does not invent a save when the game never wrote SRAM", async () => {
    const emu = fakeEmulator();
    const sync = new SaveSync(emu, ROM, null, false, RTC_BASE);
    await sync.flush();
    expect(await getLocalSave(ROM.romHash)).toBeNull();
    sync.destroy();
  });

  it("persists game writes to IndexedDB and skips identical content", async () => {
    const emu = fakeEmulator();
    const sync = new SaveSync(emu, ROM, null, false, RTC_BASE);
    emu.gameWrites([1, 2, 3]);
    await sync.flush();
    const first = await getLocalSave(ROM.romHash);
    expect(Array.from(new Uint8Array(first!.sram)).slice(0, 3)).toEqual([1, 2, 3]);
    expect(first!.rtcBase).toBe(RTC_BASE);
    expect(sync.getStatus()).toEqual({ state: "local-only" });

    emu.gameWrites([1, 2, 3]); // e.g. RAM-enable toggle with no real change
    await sync.flush();
    expect((await getLocalSave(ROM.romHash))!.updatedAt).toBe(first!.updatedAt);
    sync.destroy();
  });

  it("uploads with the last known revision and records the new one", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.baseRevision).toBeNull();
      expect(body.rtcBase).toBe(RTC_BASE);
      return Response.json({ ok: true, save: { ...body, romHash: ROM.romHash, sramSize: 16, revision: 1, createdAt: 1, sram: undefined } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const emu = fakeEmulator();
    const sync = new SaveSync(emu, ROM, null, true, RTC_BASE);
    emu.gameWrites([7]);
    await sync.flush();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((await getLocalSave(ROM.romHash))!.cloud?.revision).toBe(1);
    expect(sync.getStatus().state).toBe("synced");
    sync.destroy();
  });

  it("sends an older save's new clock base right away and adopts the one the cloud keeps", async () => {
    const puts: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      puts.push(body);
      // Another device got its base in first.
      return Response.json({ ok: true, save: { ...body, romHash: ROM.romHash, sramSize: 16, revision: 3, createdAt: 1, sram: undefined, rtcBase: 42 } });
    }));
    const synced: LocalGameSave = {
      gameId: ROM.gameId, romHash: ROM.romHash, sram: new Uint8Array(16).buffer, sramHash: "0".repeat(64),
      updatedAt: 1, playTime: 0, cloud: { revision: 3, sramHash: "0".repeat(64) },
    };
    const sync = new SaveSync(fakeEmulator(), ROM, synced, true, RTC_BASE);
    await vi.waitFor(() => expect(sync.getStatus().state).toBe("synced"));
    expect(puts).toMatchObject([{ rtcBase: RTC_BASE, baseRevision: 3 }]);
    expect(sync.getRtcBase()).toBe(42);
    expect(await getLocalSave(ROM.romHash)).toMatchObject({ rtcBase: 42, cloud: { revision: 3, rtcBase: 42 } });
    sync.destroy();
  });

  it("takeCloud() uses the cloud's clock base, or keeps this device's when it has none", async () => {
    const cloudSave = (rtcBase?: number) =>
      Response.json({
        gameId: ROM.gameId, romHash: ROM.romHash, sramHash: "1".repeat(64), sramSize: 1, revision: 5, createdAt: 1, updatedAt: 2,
        sram: bytesToBase64(new Uint8Array([9])), ...(rtcBase !== undefined ? { rtcBase } : {}),
      });

    vi.stubGlobal("fetch", vi.fn(async () => cloudSave(77)));
    const a = new SaveSync(fakeEmulator(), ROM, null, true, RTC_BASE);
    expect(Array.from((await a.takeCloud())!)).toEqual([9]);
    expect(a.getRtcBase()).toBe(77);
    expect((await getLocalSave(ROM.romHash))!.rtcBase).toBe(77);
    a.destroy();

    vi.stubGlobal("fetch", vi.fn(async () => cloudSave()));
    const b = new SaveSync(fakeEmulator(), ROM, null, true, RTC_BASE);
    await b.takeCloud();
    expect(b.getRtcBase()).toBe(RTC_BASE);
    expect((await getLocalSave(ROM.romHash))!.rtcBase).toBe(RTC_BASE);
    b.destroy();
  });

  it("gives an older save without a clock base the one this boot started with", async () => {
    const old: LocalGameSave = {
      gameId: ROM.gameId, romHash: ROM.romHash, sram: new Uint8Array(16).buffer, sramHash: "0".repeat(64),
      updatedAt: 1, playTime: 0, cloud: null,
    };
    const sync = new SaveSync(fakeEmulator(), ROM, old, false, RTC_BASE);
    expect(sync.getLocal()?.rtcBase).toBe(RTC_BASE);
    await vi.waitFor(async () => expect((await getLocalSave(ROM.romHash))?.rtcBase).toBe(RTC_BASE));
    sync.destroy();
  });
});
