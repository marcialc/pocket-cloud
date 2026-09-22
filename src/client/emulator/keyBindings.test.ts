import { describe, expect, it } from "vitest";
import { DEFAULT_KEY_BINDINGS, isBindable, keyLabel, keyMap, rebind, sameBindings, sanitizeBindings } from "./keyBindings";

describe("key bindings", () => {
  it("maps every default key to its button", () => {
    const map = keyMap(DEFAULT_KEY_BINDINGS);
    expect(map.get("Enter")).toBe("start");
    expect(map.get("NumpadEnter")).toBe("start");
    expect(map.get("KeyZ")).toBe("a");
    expect(map.get("ShiftRight")).toBe("select");
  });

  it("rebinding replaces the button's keys and steals the key from other buttons", () => {
    const next = rebind(DEFAULT_KEY_BINDINGS, "start", "KeyZ");
    expect(next.start).toEqual(["KeyZ"]);
    expect(next.a).toEqual([]);
    expect(keyMap(next).get("Enter")).toBeUndefined();
    expect(DEFAULT_KEY_BINDINGS.start).toEqual(["Enter", "NumpadEnter"]); // not mutated
  });

  it("sanitizes stored bindings", () => {
    expect(sanitizeBindings(undefined)).toEqual(DEFAULT_KEY_BINDINGS);
    const s = sanitizeBindings({ a: ["Space", 42, "Escape"], b: ["Space"], start: "Enter" });
    expect(s.a).toEqual(["Space"]);
    expect(s.b).toEqual([]); // duplicate key dropped
    expect(s.start).toEqual(DEFAULT_KEY_BINDINGS.start); // malformed -> default
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
    expect(sameBindings(DEFAULT_KEY_BINDINGS, sanitizeBindings(DEFAULT_KEY_BINDINGS))).toBe(true);
    expect(sameBindings(DEFAULT_KEY_BINDINGS, rebind(DEFAULT_KEY_BINDINGS, "a", "KeyJ"))).toBe(false);
  });
});
