import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameBoyEmulator } from "../emulator/GameBoyEmulator";
import type { RomInfo } from "../emulator/rom";
import { deleteLocalSave, getLocalSave } from "./localSaves";
import { SaveSync } from "./SaveSync";

const ROM: RomInfo = {
  gameId: "POKEMON RED", title: "POKEMON RED", romHash: "e".repeat(64),
  cartridgeType: 0x13, hasBattery: true, cgb: false, size: 0x100000,
};

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
    const sync = new SaveSync(emu, ROM, null, false);
    await sync.flush();
    expect(await getLocalSave(ROM.romHash)).toBeNull();
    sync.destroy();
  });

  it("persists game writes to IndexedDB and skips identical content", async () => {
    const emu = fakeEmulator();
    const sync = new SaveSync(emu, ROM, null, false);
    emu.gameWrites([1, 2, 3]);
    await sync.flush();
    const first = await getLocalSave(ROM.romHash);
    expect(Array.from(new Uint8Array(first!.sram)).slice(0, 3)).toEqual([1, 2, 3]);
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
      return Response.json({ ok: true, save: { ...body, romHash: ROM.romHash, sramSize: 16, revision: 1, createdAt: 1, sram: undefined } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const emu = fakeEmulator();
    const sync = new SaveSync(emu, ROM, null, true);
    emu.gameWrites([7]);
    await sync.flush();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((await getLocalSave(ROM.romHash))!.cloud?.revision).toBe(1);
    expect(sync.getStatus().state).toBe("synced");
    sync.destroy();
  });
});
