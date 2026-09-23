import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_KEY_BINDINGS, rebind } from "../emulator/keyBindings";
import { pushKeyBindings, syncKeyBindings } from "./controlsSync";

const EMAIL = "player@example.com";
const CUSTOM = rebind(DEFAULT_KEY_BINDINGS, "a", "KeyK");

let store: Map<string, string>;
let server: { keyBindings: unknown };
let online: boolean;
let puts: unknown[];

beforeEach(() => {
  store = new Map();
  server = { keyBindings: null };
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
      puts.push(body.keyBindings);
      server = body;
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
    server = { keyBindings: CUSTOM };
    expect(await syncKeyBindings(EMAIL, DEFAULT_KEY_BINDINGS)).toEqual(CUSTOM);
    expect(puts).toEqual([]);
  });

  it("gives an empty account this browser's custom controls, but not the defaults", async () => {
    expect(await syncKeyBindings(EMAIL, DEFAULT_KEY_BINDINGS)).toBeNull();
    expect(puts).toEqual([]);
    expect(await syncKeyBindings(EMAIL, CUSTOM)).toBeNull();
    await pushKeyBindings(EMAIL, CUSTOM); // waits for the queued upload
    expect(server.keyBindings).toEqual(CUSTOM);
  });

  it("uploads changes in order so the last one sticks", async () => {
    const second = rebind(CUSTOM, "b", "KeyL");
    void pushKeyBindings(EMAIL, CUSTOM);
    await pushKeyBindings(EMAIL, second);
    expect(puts).toEqual([CUSTOM, second]);
    expect(server.keyBindings).toEqual(second);
  });

  it("sends a change that failed to upload instead of taking the account's copy", async () => {
    server = { keyBindings: DEFAULT_KEY_BINDINGS };
    online = false;
    await pushKeyBindings(EMAIL, CUSTOM);
    online = true;
    expect(await syncKeyBindings(EMAIL, CUSTOM)).toBeNull();
    await pushKeyBindings(EMAIL, CUSTOM);
    expect(server.keyBindings).toEqual(CUSTOM);
    // Once through, the account's copy wins again.
    server = { keyBindings: DEFAULT_KEY_BINDINGS };
    expect(await syncKeyBindings(EMAIL, CUSTOM)).toEqual(DEFAULT_KEY_BINDINGS);
  });

  it("doesn't push one account's unsent change into another account", async () => {
    online = false;
    await pushKeyBindings(EMAIL, CUSTOM);
    online = true;
    server = { keyBindings: DEFAULT_KEY_BINDINGS };
    expect(await syncKeyBindings("other@example.com", CUSTOM)).toEqual(DEFAULT_KEY_BINDINGS);
    expect(puts).toEqual([]);
  });

  it("throws when the account can't be reached", async () => {
    online = false;
    await expect(syncKeyBindings(EMAIL, CUSTOM)).rejects.toThrow();
  });
});
