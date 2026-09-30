import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncCovers } from "./coverSync";
import { closeCoversDb, deleteCustomCover, listCoverRecords, listCustomCovers, pickCustomCover, removeCustomCover } from "./customCovers";

const A = "a".repeat(64);
const B = "b".repeat(64);

/** The account's covers: bytes and version by ROM hash. */
let server: Map<string, { data: number[]; type: string; version: string }>;
let online: boolean;
let nextVersion: number;

const bytes = (...b: number[]) => new Uint8Array(b).buffer;
const shown = async () => (await listCustomCovers()).map((c) => [c.romHash, [...new Uint8Array(c.data)]]);

beforeEach(() => {
  server = new Map();
  online = true;
  nextVersion = 1;
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (!online) throw new TypeError("offline");
    if (url === "/api/roms/covers") {
      return Response.json({ covers: [...server].map(([romHash, c]) => ({ romHash, version: c.version })) });
    }
    const hash = /^\/api\/roms\/([0-9a-f]{64})\/cover$/.exec(url)![1]!;
    switch (init.method ?? "GET") {
      case "PUT": {
        const version = `v${nextVersion++}`;
        const type = new Headers(init.headers).get("Content-Type")!;
        server.set(hash, { data: [...new Uint8Array(init.body as ArrayBuffer)], type, version });
        return Response.json({ cover: { romHash: hash, version } });
      }
      case "DELETE":
        server.delete(hash);
        return new Response(null, { status: 204 });
      default: {
        const c = server.get(hash);
        return c ? new Response(new Uint8Array(c.data), { headers: { "Content-Type": c.type } }) : Response.json({}, { status: 404 });
      }
    }
  });
});
afterEach(async () => {
  for (const c of await listCoverRecords()) await deleteCustomCover(c.romHash);
  await closeCoversDb();
  vi.unstubAllGlobals();
});

describe("syncCovers", () => {
  it("sends a cover picked here to the account", async () => {
    await pickCustomCover(A, bytes(1, 2), "image/jpeg");
    expect(await syncCovers()).toBe(false);
    expect(server.get(A)).toMatchObject({ data: [1, 2], type: "image/jpeg" });
    // Already there: nothing more to send.
    server.get(A)!.data = [7];
    await syncCovers();
    expect(server.get(A)!.data).toEqual([7]);
  });

  it("brings in covers picked on other devices, and newer versions of ones it has", async () => {
    server.set(A, { data: [5], type: "image/png", version: "v9" });
    expect(await syncCovers()).toBe(true);
    expect(await shown()).toEqual([[A, [5]]]);
    server.set(A, { data: [6], type: "image/png", version: "v10" });
    expect(await syncCovers()).toBe(true);
    expect(await shown()).toEqual([[A, [6]]]);
    expect(await syncCovers()).toBe(false);
  });

  it("drops a cover removed on another device", async () => {
    server.set(A, { data: [5], type: "image/jpeg", version: "v9" });
    await syncCovers();
    server.delete(A);
    expect(await syncCovers()).toBe(true);
    expect(await shown()).toEqual([]);
  });

  it("removes a cover from the account when it's removed here", async () => {
    await pickCustomCover(A, bytes(1), "image/jpeg");
    await syncCovers();
    await removeCustomCover(A);
    expect(await shown()).toEqual([]);
    await syncCovers();
    expect(server.has(A)).toBe(false);
    expect(await listCoverRecords()).toEqual([]);
  });

  it("keeps changes made offline until the account can be reached", async () => {
    await pickCustomCover(A, bytes(1), "image/jpeg");
    await syncCovers();
    online = false;
    await removeCustomCover(A);
    await pickCustomCover(B, bytes(2), "image/jpeg");
    await expect(syncCovers()).rejects.toThrow();
    online = true;
    await syncCovers();
    expect([...server.keys()]).toEqual([B]);
    expect(await shown()).toEqual([[B, [2]]]);
  });

  it("lets a cover picked here win over the account's older one", async () => {
    server.set(A, { data: [5], type: "image/jpeg", version: "v9" });
    await syncCovers();
    await pickCustomCover(A, bytes(8), "image/jpeg");
    await syncCovers();
    expect(server.get(A)!.data).toEqual([8]);
    expect(await shown()).toEqual([[A, [8]]]);
  });

  it("forgets a cover never sent to the account without asking it", async () => {
    online = false;
    await pickCustomCover(A, bytes(1), "image/jpeg");
    await removeCustomCover(A);
    expect(await listCoverRecords()).toEqual([]);
  });
});
