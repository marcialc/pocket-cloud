import { describe, expect, it, vi } from "vitest";
import type { Emulator } from "../emulator/Emulator";
import { pickShot, ScreenKeeper, SHOT_LEAD_MS, type Shot } from "./saveShots";

const shot = (at: number): Shot => ({ at, png: new Blob([String(at)], { type: "image/png" }) });

describe("pickShot", () => {
  it("takes the newest frame from at least the lead time before the save", () => {
    const shots = [0, 2000, 4000, 6000, 8000, 10_000].map(shot);
    expect(pickShot(shots, 10_500)?.at).toBe(4000);
    expect(pickShot(shots, 10_500, 1000)?.at).toBe(8000);
  });

  it("falls back to the oldest frame when the game only just started", () => {
    expect(pickShot([shot(1000), shot(3000)], 3500)?.at).toBe(1000);
  });

  it("has nothing without frames", () => {
    expect(pickShot([], 10_000)).toBeNull();
  });
});

describe("ScreenKeeper", () => {
  function emulatorWith(screenshot: () => Promise<Blob | null>, running = true) {
    return { running, screenshot } as unknown as Emulator;
  }

  it("keeps the frames it takes and hands one to a save", async () => {
    let now = 0;
    const emu = emulatorWith(async () => new Blob([String(now)], { type: "image/png" }));
    const keeper = new ScreenKeeper(emu, () => now);
    for (now = 0; now <= 10_000; now += 2000) await keeper.take();
    const png = await keeper.forSave(10_000);
    expect(new TextDecoder().decode(png!)).toBe(String(10_000 - SHOT_LEAD_MS - 1000));
  });

  it("skips paused games and forgets frames on clear", async () => {
    const screenshot = vi.fn(async () => new Blob(["x"]));
    const paused = new ScreenKeeper(emulatorWith(screenshot, false));
    await paused.take();
    expect(screenshot).not.toHaveBeenCalled();

    const keeper = new ScreenKeeper(emulatorWith(screenshot), () => 0);
    await keeper.take();
    expect(await keeper.forSave(10_000)).not.toBeNull();
    keeper.clear();
    expect(await keeper.forSave(10_000)).toBeNull();
  });

  it("gives no picture that's too big to upload", async () => {
    const keeper = new ScreenKeeper(emulatorWith(async () => new Blob([new Uint8Array(200 * 1024)])), () => 0);
    await keeper.take();
    expect(await keeper.forSave(10_000)).toBeNull();
  });
});
