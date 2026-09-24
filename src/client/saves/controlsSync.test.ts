import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_KEY_BINDINGS, customPlatformBindings, rebind, type AllKeyBindings } from "../emulator/keyBindings";
import { pushKeyBindings, syncKeyBindings } from "./controlsSync";

const EMAIL = "player@example.com";
const CUSTOM: AllKeyBindings = { ...DEFAULT_KEY_BINDINGS, gb: rebind(DEFAULT_KEY_BINDINGS.gb, "a", "KeyK") };

/** What the account stores for `bindings`: the Game Boy's where older clients look, other platforms' remaps beside them. */
function wire(bindings: AllKeyBindings) {
  return { keyBindings: bindings.gb, platformKeyBindings: customPlatformBindings(bindings) };
}

let store: Map<string, string>;
let server: { keyBindings: unknown; platformKeyBindings?: unknown };
let online: boolean;
let puts: unknown[];

beforeEach(() => {
  store = new Map();
  server = { keyBindings: null, platformKeyBindings: null };
  online = true;
  puts = [];
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (!online) throw new TypeError("offline");
    expect(url).toBe("/api/settings");
    if (init.method === "PUT") {
      const body = JSON.parse(init.body as string);
      puts.push(body);
      // Settings left out are kept.
      server = { ...server, ...body };
      return new Response(null, { status: 204 });
    }
    return Response.json(server);
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("controls sync", () => {
  it("uses the account's controls when it has some", async () => {
    server = wire(CUSTOM);
    expect(await syncKeyBindings(EMAIL, DEFAULT_KEY_BINDINGS)).toEqual(CUSTOM);
    expect(puts).toEqual([]);
  });

  it("gives an empty account this browser's custom controls, but not the defaults", async () => {
    expect(await syncKeyBindings(EMAIL, DEFAULT_KEY_BINDINGS)).toBeNull();
    expect(puts).toEqual([]);
    expect(await syncKeyBindings(EMAIL, CUSTOM)).toBeNull();
    await pushKeyBindings(EMAIL, CUSTOM); // waits for the queued upload
    expect(server).toEqual(wire(CUSTOM));
  });

  it("uploads changes in order so the last one sticks", async () => {
    const second = { ...CUSTOM, gba: rebind(CUSTOM.gba, "l", "KeyQ") };
    void pushKeyBindings(EMAIL, CUSTOM);
    await pushKeyBindings(EMAIL, second);
    expect(puts).toEqual([wire(CUSTOM), wire(second)]);
    expect(server).toEqual(wire(second));
  });

  it("sends a change that failed to upload instead of taking the account's copy", async () => {
    server = wire(DEFAULT_KEY_BINDINGS);
    online = false;
    await pushKeyBindings(EMAIL, CUSTOM);
    online = true;
    expect(await syncKeyBindings(EMAIL, CUSTOM)).toBeNull();
    await pushKeyBindings(EMAIL, CUSTOM);
    expect(server).toEqual(wire(CUSTOM));
    // Once through, the account's copy wins again.
    server = wire(DEFAULT_KEY_BINDINGS);
    expect(await syncKeyBindings(EMAIL, CUSTOM)).toEqual(DEFAULT_KEY_BINDINGS);
  });

  it("doesn't push one account's unsent change into another account", async () => {
    online = false;
    await pushKeyBindings(EMAIL, CUSTOM);
    online = true;
    server = wire(DEFAULT_KEY_BINDINGS);
    expect(await syncKeyBindings("other@example.com", CUSTOM)).toEqual(DEFAULT_KEY_BINDINGS);
    expect(puts).toEqual([]);
  });

  it("reads Game Boy controls saved by an older version, keeping this browser's for the other platforms", async () => {
    const local = { ...DEFAULT_KEY_BINDINGS, snes: rebind(DEFAULT_KEY_BINDINGS.snes, "y", "KeyD") };
    server = { keyBindings: CUSTOM.gb };
    const merged = { ...local, gb: CUSTOM.gb };
    expect(await syncKeyBindings(EMAIL, local)).toEqual(merged);
    // ...and the merged controls go up, so other browsers get the SNES remap too.
    await pushKeyBindings(EMAIL, merged);
    expect(puts[0]).toEqual(wire(merged));
    expect(wire(merged).platformKeyBindings).toEqual({ snes: local.snes });
  });

  it("only sends the platforms that aren't on their defaults, and reads the missing ones as defaults", async () => {
    const snes = { ...DEFAULT_KEY_BINDINGS, snes: rebind(DEFAULT_KEY_BINDINGS.snes, "y", "KeyD") };
    await pushKeyBindings(EMAIL, snes);
    expect(puts).toEqual([{ keyBindings: DEFAULT_KEY_BINDINGS.gb, platformKeyBindings: { snes: snes.snes } }]);
    // Put back to defaults on another browser: the account's (empty) list wins over this browser's remap.
    server = { keyBindings: DEFAULT_KEY_BINDINGS.gb, platformKeyBindings: {} };
    expect(await syncKeyBindings(EMAIL, snes)).toEqual(DEFAULT_KEY_BINDINGS);
  });

  it("throws when the account can't be reached", async () => {
    online = false;
    await expect(syncKeyBindings(EMAIL, CUSTOM)).rejects.toThrow();
  });
});
