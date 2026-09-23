import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_SHELF, toggleFavorite } from "../../shared/shelf";
import { pushShelf, syncShelf } from "./shelfSync";

const EMAIL = "player@example.com";
const FAVORITE = toggleFavorite(EMPTY_SHELF, "a".repeat(64));

let store: Map<string, string>;
let server: { shelf: unknown };
let online: boolean;
let puts: unknown[];
let reject: boolean;

beforeEach(() => {
  store = new Map();
  server = { shelf: null };
  online = true;
  puts = [];
  reject = false;
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (!online) throw new TypeError("offline");
    expect(url).toBe("/api/settings");
    if (init.method === "PUT") {
      if (reject) return Response.json({ error: "invalid_shelf" }, { status: 400 });
      const body = JSON.parse(init.body as string);
      expect(Object.keys(body)).toEqual(["shelf"]);
      puts.push(body.shelf);
      server = body;
      return new Response(null, { status: 204 });
    }
    return Response.json({ keyBindings: null, ...server });
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("library shelf sync", () => {
  it("uses the account's shelf when it has one", async () => {
    server = { shelf: FAVORITE };
    expect(await syncShelf(EMAIL, EMPTY_SHELF)).toEqual(FAVORITE);
    expect(puts).toEqual([]);
  });

  it("gives an empty account this browser's shelf, but not an empty one", async () => {
    expect(await syncShelf(EMAIL, EMPTY_SHELF)).toBeNull();
    expect(puts).toEqual([]);
    expect(await syncShelf(EMAIL, FAVORITE)).toBeNull();
    await pushShelf(EMAIL, FAVORITE);
    expect(server.shelf).toEqual(FAVORITE);
  });

  it("keeps a change made offline and sends it on the next load", async () => {
    online = false;
    await pushShelf(EMAIL, FAVORITE);
    online = true;
    server = { shelf: EMPTY_SHELF };
    expect(await syncShelf(EMAIL, FAVORITE)).toBeNull();
    await pushShelf(EMAIL, FAVORITE);
    expect(server.shelf).toEqual(FAVORITE);
    // Uploaded: the account's copy wins again.
    server = { shelf: EMPTY_SHELF };
    expect(await syncShelf(EMAIL, FAVORITE)).toEqual(EMPTY_SHELF);
  });

  it("stops retrying an upload the server turned down, and takes the account's copy again", async () => {
    reject = true;
    await pushShelf(EMAIL, FAVORITE);
    reject = false;
    server = { shelf: EMPTY_SHELF };
    expect(await syncShelf(EMAIL, FAVORITE)).toEqual(EMPTY_SHELF);
    expect(puts).toEqual([]);
  });
});
