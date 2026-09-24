import { describe, expect, it, vi } from "vitest";
import { createEmulator } from "./createEmulator";
import type { RomInfo } from "./rom";

vi.mock("./BinjgbEmulator", () => ({ BinjgbEmulator: vi.fn(function (this: object, options: object) {
  Object.assign(this, { kind: "binjgb", options });
}) }));
vi.mock("./NostalgistEmulator", () => ({ NostalgistEmulator: vi.fn(function (this: object, options: object) {
  Object.assign(this, { kind: "nostalgist", options });
}) }));

function rom(platform: RomInfo["platform"], title = "GAME"): RomInfo {
  return { platform, gameId: title, title, romHash: "0".repeat(64), cartridgeType: 0, hasBattery: true, cgb: false, size: 0 };
}

const canvas = {} as HTMLCanvasElement;

describe("createEmulator", () => {
  it("plays Game Boy and Game Boy Color on binjgb, with the game's palette", () => {
    expect(createEmulator(rom("gb", "POKEMON RED"), canvas)).toMatchObject({ kind: "binjgb", options: { canvas, palette: 23 } });
    expect(createEmulator(rom("gbc"), canvas)).toMatchObject({ kind: "binjgb" });
  });

  it("plays the GBA through Nostalgist", () => {
    expect(createEmulator(rom("gba"), canvas)).toMatchObject({ kind: "nostalgist", options: { canvas, platform: "gba" } });
  });

  it("refuses platforms without an emulator", () => {
    expect(() => createEmulator(rom("snes"), canvas)).toThrow("SNES games can't be played yet.");
  });
});
