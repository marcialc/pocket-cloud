import { describe, expect, it } from "vitest";
import { CONTROLS_IDS, PLATFORMS } from "../../shared/platforms";
import {
  DEFAULT_PAD_BINDINGS,
  MENU,
  heldButtons,
  menuButtons,
  menuHeld,
  padButtonName,
  padButtons,
  padName,
  padsInUse,
  sanitizeAllPadBindings,
  sanitizePadBindings,
} from "./gamepad";
import { rebind } from "./keyBindings";

const GB = DEFAULT_PAD_BINDINGS.gb;
const SNES = DEFAULT_PAD_BINDINGS.snes;

function pad(pressed: number[], axes: number[] = [0, 0]) {
  const buttons = Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), touched: false, value: 0 }));
  return { buttons, axes };
}

const sorted = (set: Set<string>) => [...set].sort();

describe("gamepad", () => {
  it("sees a controller in use once a button or the stick moves, not while it rests", () => {
    expect(padsInUse([])).toBe(false);
    expect(padsInUse([pad([])])).toBe(false);
    expect(padsInUse([pad([], [0.2, -0.1])])).toBe(false);
    expect(padsInUse([pad([]), pad([0])])).toBe(true);
    expect(padsInUse([pad([], [0, -0.9])])).toBe(true);
  });

  it("maps standard-layout buttons by position by default", () => {
    expect(sorted(padButtons(pad([1, 0, 9, 8]), GB))).toEqual(["a", "b", "select", "start"]);
    expect(sorted(padButtons(pad([12, 15, 4, 5, 2, 3]), SNES))).toEqual(["l", "r", "right", "up", "x", "y"]);
  });

  it("gives each platform defaults for exactly its own buttons", () => {
    for (const id of CONTROLS_IDS)
      expect(Object.keys(DEFAULT_PAD_BINDINGS[id]).sort()).toEqual([...PLATFORMS[id].buttons, MENU].sort());
    expect(GB.a).toEqual([1]);
    expect(padButtons(pad([2, 3]), GB).size).toBe(0);
  });

  it("follows remapped buttons", () => {
    const swapped = rebind(rebind(GB, "a", 0), "b", 1);
    expect(sorted(padButtons(pad([0]), swapped))).toEqual(["a"]);
    expect(sorted(padButtons(pad([1]), swapped))).toEqual(["b"]);
  });

  it("treats the left stick as the D-pad past the threshold", () => {
    expect(sorted(padButtons(pad([], [-0.9, 0.8]), GB))).toEqual(["down", "left"]);
    expect(padButtons(pad([], [0.3, -0.3]), GB).size).toBe(0);
  });

  it("ignores unbound buttons", () => {
    expect(padButtons(pad([10]), GB).size).toBe(0);
  });

  it("keeps the menu button out of the game", () => {
    expect(GB[MENU]).toEqual([16]);
    expect(padButtons(pad([16, 1]), GB)).toEqual(new Set(["a"]));
    expect(menuHeld([pad([]), pad([16])], GB)).toBe(true);
    expect(menuHeld([pad([1])], GB)).toBe(false);
    const onL = rebind(GB, MENU, 4);
    expect(menuHeld([pad([4])], onL)).toBe(true);
    expect(menuHeld([pad([16])], onL)).toBe(false);
  });

  it("combines several pads", () => {
    expect(sorted(heldButtons([pad([1]), pad([9])], GB))).toEqual(["a", "start"]);
  });

  it("sanitizes stored bindings", () => {
    expect(sanitizeAllPadBindings(undefined)).toEqual(DEFAULT_PAD_BINDINGS);
    expect(sanitizePadBindings({ a: [3, "x", -1, 1.5, 99], b: [3], start: [] }, "gb")).toEqual({
      ...GB,
      a: [3],
      b: [],
      start: [],
    });
    // The menu can't take a button the console uses.
    expect(sanitizePadBindings({ a: [16] }, "gb")[MENU]).toEqual([]);
    expect(sanitizePadBindings({ [MENU]: [1, 10] }, "gb")[MENU]).toEqual([10]);
  });

  it("picks with A and goes back with B, as printed on the pad", () => {
    expect(menuButtons({ id: "Xbox Wireless Controller", mapping: "standard" })).toEqual({ confirm: 0, back: 1 });
    expect(menuButtons({ id: "Pro Controller (STANDARD GAMEPAD Vendor: 057e)", mapping: "standard" })).toEqual({ confirm: 1, back: 0 });
    expect(menuButtons({ id: "Some pad", mapping: "" })).toEqual({ confirm: 1, back: 0 });
  });

  it("names pads without the browser's vendor details", () => {
    expect(padName("8BitDo Lite 2 (STANDARD GAMEPAD Vendor: 2dc8 Product: 5112)")).toBe("8BitDo Lite 2");
    expect(padName("2dc8-5112-8BitDo Lite 2")).toBe("8BitDo Lite 2");
    expect(padName("")).toBe("Controller");
  });

  it("names controller buttons as printed", () => {
    const lite = { id: "8BitDo Lite 2 (STANDARD GAMEPAD Vendor: 2dc8 Product: 5112)", mapping: "standard" as const };
    expect(padButtonName(lite, 1)).toBe("A");
    expect(padButtonName(lite, 0)).toBe("B");
    expect(padButtonName(lite, 8)).toBe("−");
    expect(padButtonName(lite, 12)).toBe("D-pad ↑");
    expect(padButtonName({ id: "Xbox Wireless Controller", mapping: "standard" }, 1)).toBe("B");
    expect(padButtonName(lite, 20)).toBe("Button 20");
  });

  it("only numbers the buttons of pads without the standard layout", () => {
    const raw = { id: "8BitDo Lite 2 (Vendor: 2dc8 Product: 5112)", mapping: "" as const };
    expect(padButtonName(raw, 1)).toBe("Button 1");
    expect(padButtonName(raw, 12)).toBe("Button 12");
    expect(padButtonName(raw, 32)).toBe("D-pad ↑");
  });

  it("reads a D-pad reported as a hat axis", () => {
    // Chrome: 9/7 at rest, 2n/7 - 1 for direction n clockwise from up.
    const hat = (value: number | null) => ({ ...pad([], [0, 0, 0, 0, 0, 0, 0, 0, 0, value ?? 9 / 7]), id: "hat pad" });
    const at = (n: number) => hat((2 * n) / 7 - 1);
    expect(padButtons(hat(null), GB).size).toBe(0);
    expect(sorted(padButtons(at(0), GB))).toEqual(["up"]);
    expect(sorted(padButtons(at(2), GB))).toEqual(["right"]);
    expect(sorted(padButtons(at(3), GB))).toEqual(["down", "right"]);
    expect(sorted(padButtons(at(4), GB))).toEqual(["down"]);
    expect(sorted(padButtons(at(6), GB))).toEqual(["left"]);
    expect(sorted(padButtons(at(7), GB))).toEqual(["left", "up"]);
  });

  it("doesn't take a trigger or second stick for a hat", () => {
    const other = { ...pad([], [0, 0, -1, 1, 0.5]), id: "no hat pad" };
    expect(padButtons(other, GB).size).toBe(0);
  });
});
