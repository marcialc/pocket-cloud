import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_KEY_BINDINGS, rebind } from "./emulator/keyBindings";
import { loadPreferences, savePreferences } from "./preferences";

const KEY = "pocket-cloud.prefs";
const REMAPPED = rebind(DEFAULT_KEY_BINDINGS.gb, "a", "KeyK");

let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("preferences", () => {
  it("starts with every platform's default controls", () => {
    expect(loadPreferences().controls).toEqual(DEFAULT_KEY_BINDINGS);
  });

  it("turns the controls saved before other platforms into the Game Boy's", () => {
    store.set(KEY, JSON.stringify({ volume: 0.3, keyBindings: REMAPPED }));
    const prefs = loadPreferences();
    expect(prefs.volume).toBe(0.3);
    expect(prefs.controls.gb).toEqual(REMAPPED);
    expect(prefs.controls.gba).toEqual(DEFAULT_KEY_BINDINGS.gba);
    expect(prefs).not.toHaveProperty("keyBindings");
  });

  it("stores only the platforms that aren't on their defaults", () => {
    const controls = { ...DEFAULT_KEY_BINDINGS, snes: rebind(DEFAULT_KEY_BINDINGS.snes, "y", "KeyD") };
    savePreferences({ ...loadPreferences(), controls });
    const stored = JSON.parse(store.get(KEY)!);
    expect(stored.keyBindings).toEqual(DEFAULT_KEY_BINDINGS.gb);
    expect(stored.controls).toEqual({ snes: controls.snes });
    expect(loadPreferences().controls).toEqual(controls);
  });

  it("takes Game Boy controls an older version changed after the migration", () => {
    const gba = rebind(DEFAULT_KEY_BINDINGS.gba, "l", "KeyQ");
    savePreferences({ ...loadPreferences(), controls: { ...DEFAULT_KEY_BINDINGS, gba } });
    // An old tab (or a rolled-back build) remaps A: it only knows `keyBindings`, and keeps the rest as it found it.
    const old = JSON.parse(store.get(KEY)!);
    store.set(KEY, JSON.stringify({ ...old, keyBindings: REMAPPED }));
    const prefs = loadPreferences();
    expect(prefs.controls.gb).toEqual(REMAPPED);
    expect(prefs.controls.gba).toEqual(gba);
  });

  it("keeps per-platform controls across a save, and the Game Boy's where older versions look", () => {
    const controls = { ...DEFAULT_KEY_BINDINGS, gb: REMAPPED, gba: rebind(DEFAULT_KEY_BINDINGS.gba, "l", "KeyQ") };
    savePreferences({ ...loadPreferences(), controls });
    expect(JSON.parse(store.get(KEY)!).keyBindings).toEqual(REMAPPED);
    expect(loadPreferences().controls).toEqual(controls);
  });
});
