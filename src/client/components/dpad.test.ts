import { describe, expect, it } from "vitest";
import { DEADZONE_PX, dpadDirections, type Direction } from "./dpad";

const R = 60;
const at = (deg: number, current: Direction[] = [], r = R) => {
  const rad = (deg * Math.PI) / 180;
  return [...dpadDirections(Math.cos(rad) * r, Math.sin(rad) * r, new Set(current))].sort();
};

describe("dpadDirections", () => {
  it("presses nothing inside the dead zone", () => {
    expect(at(0, [], DEADZONE_PX - 1)).toEqual([]);
    expect(at(0, [], DEADZONE_PX + 1)).toEqual(["right"]);
  });

  it("maps the four axes (screen y grows downward)", () => {
    expect(at(0)).toEqual(["right"]);
    expect(at(90)).toEqual(["down"]);
    expect(at(180)).toEqual(["left"]);
    expect(at(-90)).toEqual(["up"]);
  });

  it("keeps a thumb 30° off an axis on the straight direction", () => {
    expect(at(-90 + 30)).toEqual(["up"]);
    expect(at(-90 - 30)).toEqual(["up"]);
    expect(at(180 - 30)).toEqual(["left"]);
  });

  it("presses a diagonal near 45°", () => {
    expect(at(-45)).toEqual(["right", "up"]);
    expect(at(135)).toEqual(["down", "left"]);
  });

  it("holds the current press past its sector edge", () => {
    // 36° off the up axis: a fresh touch is a diagonal, a held "up" stays up.
    expect(at(-90 + 36)).toEqual(["right", "up"]);
    expect(at(-90 + 36, ["up"])).toEqual(["up"]);
    // 30° off the up axis: a fresh touch is up, a held diagonal stays diagonal.
    expect(at(-90 + 30, ["right", "up"])).toEqual(["right", "up"]);
    // Well past the edge the press changes.
    expect(at(-90 + 42, ["up"])).toEqual(["right", "up"]);
    expect(at(-90 + 20, ["right", "up"])).toEqual(["up"]);
  });
});
