import { describe, expect, it } from "vitest";
import { CONTROLS_IDS, PLATFORMS } from "../../shared/platforms";
import {
  DEFAULT_KEY_BINDINGS,
  isBindable,
  keyLabel,
  keyMap,
  rebind,
  sameAllBindings,
  sameBindings,
  sanitizeAllBindings,
  sanitizeBindings,
} from "./keyBindings";

const GB = DEFAULT_KEY_BINDINGS.gb;

describe("key bindings", () => {
  it("maps every default key to its button", () => {
    const map = keyMap(GB);
    expect(map.get("Enter")).toBe("start");
    expect(map.get("NumpadEnter")).toBe("start");
    expect(map.get("KeyZ")).toBe("a");
    expect(map.get("ShiftRight")).toBe("select");
  });

  it("rebinding replaces the button's keys and steals the key from other buttons", () => {
    const next = rebind(GB, "start", "KeyZ");
    expect(next.start).toEqual(["KeyZ"]);
    expect(next.a).toEqual([]);
    expect(keyMap(next).get("Enter")).toBeUndefined();
    expect(GB.start).toEqual(["Enter", "NumpadEnter"]); // not mutated
  });

  it("sanitizes stored bindings", () => {
    expect(sanitizeBindings(undefined)).toEqual(GB);
    const s = sanitizeBindings({ a: ["Space", 42, "Escape"], b: ["Space"], start: "Enter" });
    expect(s.a).toEqual(["Space"]);
    expect(s.b).toEqual([]); // duplicate key dropped
    expect(s.start).toEqual(GB.start); // malformed -> default
    expect(s.up).toEqual(["ArrowUp"]);
  });

  it("reserves browser/escape keys", () => {
    expect(isBindable("Escape")).toBe(false);
    expect(isBindable("MetaLeft")).toBe(false);
    expect(isBindable("KeyA")).toBe(true);
  });

  it("labels keys readably", () => {
    expect(keyLabel("KeyZ")).toBe("Z");
    expect(keyLabel("Digit7")).toBe("7");
    expect(keyLabel("ArrowLeft")).toBe("←");
    expect(keyLabel("Numpad4")).toBe("Num 4");
    expect(keyLabel("F5")).toBe("F5");
  });

  it("compares bindings", () => {
    expect(sameBindings(GB, sanitizeBindings(GB))).toBe(true);
    expect(sameBindings(GB, rebind(GB, "a", "KeyJ"))).toBe(false);
  });

  it("gives every platform a default key for each of its buttons, no key used twice", () => {
    for (const id of CONTROLS_IDS) {
      const bindings = DEFAULT_KEY_BINDINGS[id];
      expect(Object.keys(bindings).sort()).toEqual([...PLATFORMS[id].buttons].sort());
      const codes = Object.values(bindings).flat();
      expect(new Set(codes).size).toBe(codes.length);
      expect(sanitizeBindings(bindings, id)).toEqual(bindings);
    }
    expect(DEFAULT_KEY_BINDINGS.gba).toMatchObject({ ...GB, l: ["KeyA"], r: ["KeyS"] });
    expect(keyMap(DEFAULT_KEY_BINDINGS.snes).get("KeyQ")).toBe("l");
  });

  it("sanitizes a platform's bindings against its own buttons", () => {
    const s = sanitizeBindings({ l: ["KeyQ"], x: ["KeyW"] }, "gba");
    expect(s.l).toEqual(["KeyQ"]);
    expect(s.r).toEqual(["KeyS"]);
    expect(s).not.toHaveProperty("x"); // the GBA has no X
  });

  it("sanitizes every platform's bindings, defaulting the missing ones", () => {
    const custom = rebind(GB, "a", "KeyK");
    const all = sanitizeAllBindings({ gb: custom, snes: "junk" });
    expect(all.gb).toEqual(custom);
    expect(all.snes).toEqual(DEFAULT_KEY_BINDINGS.snes);
    expect(all.gba).toEqual(DEFAULT_KEY_BINDINGS.gba);
    expect(sameAllBindings(sanitizeAllBindings(undefined), DEFAULT_KEY_BINDINGS)).toBe(true);
    expect(sameAllBindings(all, DEFAULT_KEY_BINDINGS)).toBe(false);
  });
});
