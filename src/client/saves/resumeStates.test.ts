import { afterEach, describe, expect, it, vi } from "vitest";
import type { Emulator } from "../emulator/Emulator";
import {
  closeResumeDb,
  deleteResumeState,
  getResumeState,
  putResumeState,
  resumeKeeper,
  resumeStateFor,
  sramHashOf,
} from "./resumeStates";

const ROM = "a".repeat(64);

afterEach(async () => {
  await deleteResumeState(ROM);
  await closeResumeDb();
});

function fakeEmulator(sram: Uint8Array | null, state: Uint8Array | null) {
  return {
    getSram: vi.fn(() => sram),
    saveState: vi.fn(async () => state),
  } as unknown as Emulator & { saveState: ReturnType<typeof vi.fn> };
}

describe("resumeStates", () => {
  it("hands back the snapshot only while the cartridge RAM is the one it was taken with", async () => {
    const sramHash = await sramHashOf(new Uint8Array([1, 2]));
    await putResumeState({ romHash: ROM, state: new Uint8Array([9]).buffer, sramHash, savedAt: 1 });

    expect(new Uint8Array((await resumeStateFor(ROM, sramHash))!)).toEqual(new Uint8Array([9]));
    // A newer save (another device, the cloud) wins over the old spot.
    expect(await resumeStateFor(ROM, await sramHashOf(new Uint8Array([1, 3])))).toBeNull();
    expect(await resumeStateFor(ROM, null)).toBeNull();
    expect(await resumeStateFor("b".repeat(64), sramHash)).toBeNull();
  });

  it("matches games without cartridge RAM", async () => {
    await putResumeState({ romHash: ROM, state: new Uint8Array([9]).buffer, sramHash: null, savedAt: 1 });
    expect(await resumeStateFor(ROM, null)).not.toBeNull();
  });

  it("keeps the snapshot with the cartridge RAM it holds", async () => {
    const emu = fakeEmulator(new Uint8Array([1, 2]), new Uint8Array([4, 5, 6]));
    await resumeKeeper(emu, ROM)();
    const saved = await getResumeState(ROM);
    expect(new Uint8Array(saved!.state)).toEqual(new Uint8Array([4, 5, 6]));
    expect(saved!.sramHash).toBe(await sramHashOf(new Uint8Array([1, 2])));
  });

  it("stores nothing when there's nothing to snapshot", async () => {
    await resumeKeeper(fakeEmulator(null, null), ROM)();
    expect(await getResumeState(ROM)).toBeNull();
  });

  it("takes one snapshot at a time", async () => {
    const emu = fakeEmulator(null, new Uint8Array([1]));
    const keep = resumeKeeper(emu, ROM);
    await Promise.all([keep(), keep()]);
    expect(emu.saveState).toHaveBeenCalledTimes(1);
    await keep();
    expect(emu.saveState).toHaveBeenCalledTimes(2);
  });

  it("forgets a game's spot", async () => {
    await putResumeState({ romHash: ROM, state: new Uint8Array([9]).buffer, sramHash: null, savedAt: 1 });
    await deleteResumeState(ROM);
    expect(await getResumeState(ROM)).toBeNull();
  });
});
