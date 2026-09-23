import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bytesToBase64, sha256Hex, type CloudSaveResponse, type PutSaveRequest } from "../shared/api";

const ROM_HASH = "a".repeat(64);
const API = "https://example.com/api";

function playerKey(): string {
  return crypto.randomUUID();
}

async function putBody(sram: Uint8Array, over: Partial<PutSaveRequest> = {}): Promise<PutSaveRequest> {
  return {
    gameId: "POKEMON RED",
    sram: bytesToBase64(sram),
    sramHash: await sha256Hex(sram),
    updatedAt: 1_000,
    baseRevision: null,
    ...over,
  };
}

function put(key: string, body: unknown, romHash = ROM_HASH) {
  return SELF.fetch(`${API}/saves/${romHash}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(key: string, romHash = ROM_HASH) {
  return SELF.fetch(`${API}/saves/${romHash}`, { headers: { Authorization: `Bearer ${key}` } });
}

describe("HTTP API", () => {
  it("reports health without auth", async () => {
    const res = await SELF.fetch(`${API}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("rejects requests without a valid player key", async () => {
    expect((await SELF.fetch(`${API}/saves`)).status).toBe(401);
    expect((await get("not-a-uuid")).status).toBe(401);
  });

  it("round-trips SRAM", async () => {
    const key = playerKey();
    const sram = new Uint8Array(32 * 1024).map((_, i) => i & 0xff);
    const res = await put(key, await putBody(sram, { playTime: 42 }));
    expect(res.status).toBe(200);
    const created = await res.json<{ ok: true; save: { revision: number } }>();
    expect(created.save.revision).toBe(1);

    const fetched = await (await get(key)).json<CloudSaveResponse>();
    expect(fetched).toMatchObject({ gameId: "POKEMON RED", romHash: ROM_HASH, revision: 1, sramSize: 32768, playTime: 42 });
    expect(fetched.sram).toBe(bytesToBase64(sram));

    const list = await (await SELF.fetch(`${API}/saves`, { headers: { Authorization: `Bearer ${key}` } })).json<{
      saves: unknown[];
    }>();
    expect(list.saves).toHaveLength(1);
  });

  it("keeps the cartridge clock base with the save", async () => {
    const key = playerKey();
    await put(key, await putBody(new Uint8Array([1]), { rtcBase: 1_234 }));
    expect(await (await get(key)).json()).toMatchObject({ rtcBase: 1_234 });
    // A client that doesn't send one (older version) must not erase it.
    await put(key, await putBody(new Uint8Array([2]), { baseRevision: 1 }));
    expect(await (await get(key)).json()).toMatchObject({ revision: 2, rtcBase: 1_234 });
    expect((await put(key, await putBody(new Uint8Array([3]), { baseRevision: 2, rtcBase: -1 }))).status).toBe(400);
  });

  it("stores the first clock base sent for a save that has none, without a new revision", async () => {
    const key = playerKey();
    await put(key, await putBody(new Uint8Array([1])));
    const first = await put(key, await putBody(new Uint8Array([1]), { baseRevision: 1, rtcBase: 1_000 }));
    expect(await first.json()).toMatchObject({ ok: true, save: { revision: 1, rtcBase: 1_000 } });
    // A second device's base for the same bytes loses; the response tells it which one won.
    const second = await put(key, await putBody(new Uint8Array([1]), { baseRevision: 1, rtcBase: 2_000 }));
    expect(await second.json()).toMatchObject({ ok: true, save: { revision: 1, rtcBase: 1_000 } });
  });

  it("isolates players", async () => {
    const a = playerKey();
    await put(a, await putBody(new Uint8Array([1, 2, 3])));
    expect((await get(playerKey())).status).toBe(404);
  });

  it("detects conflicts via baseRevision and allows forced overwrite", async () => {
    const key = playerKey();
    await put(key, await putBody(new Uint8Array([1])));
    // Second device writes different data without having seen revision 1.
    const stale = await put(key, await putBody(new Uint8Array([2]), { baseRevision: null, updatedAt: 2_000 }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ ok: false, conflict: { revision: 1 } });

    const ok = await put(key, await putBody(new Uint8Array([2]), { baseRevision: 1, updatedAt: 2_000 }));
    expect(ok.status).toBe(200);
    const forced = await put(key, await putBody(new Uint8Array([3]), { baseRevision: 1, force: true }));
    expect(await forced.json()).toMatchObject({ ok: true, save: { revision: 3 } });
  });

  it("treats re-sending identical SRAM as a no-op", async () => {
    const key = playerKey();
    const body = await putBody(new Uint8Array([9, 9]));
    await put(key, body);
    const again = await put(key, body);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ save: { revision: 1 } });
  });

  it("validates payloads", async () => {
    const key = playerKey();
    const body = await putBody(new Uint8Array([1]));
    expect((await put(key, { ...body, sramHash: "b".repeat(64) })).status).toBe(400);
    expect((await put(key, { ...body, gameId: "" })).status).toBe(400);
    expect((await put(key, await putBody(new Uint8Array(128 * 1024 + 1)))).status).toBe(400);
    expect((await put(key, body, "not-a-hash")).status).toBe(400);
  });

  it("deletes saves", async () => {
    const key = playerKey();
    await put(key, await putBody(new Uint8Array([1])));
    const del = await SELF.fetch(`${API}/saves/${ROM_HASH}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(del.status).toBe(204);
    expect((await get(key)).status).toBe(404);
  });
});

describe("PlayerSaveDO", () => {
  it("persists across object instances via SQLite storage", async () => {
    const stub = env.PLAYER_SAVE.getByName("player:persist-test");
    const sram = new Uint8Array([4, 5, 6]);
    await stub.putSave({
      romHash: ROM_HASH,
      gameId: "POKEMON RED",
      sram,
      sramHash: await sha256Hex(sram),
      updatedAt: 5,
      baseRevision: null,
    });
    const again = env.PLAYER_SAVE.getByName("player:persist-test");
    const save = await again.getSave(ROM_HASH);
    expect(save?.revision).toBe(1);
    expect(Array.from(save!.sram)).toEqual([4, 5, 6]);
    expect(save!.createdAt).toBeGreaterThan(0);
  });
});
