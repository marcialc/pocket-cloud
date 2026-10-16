import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  bytesToBase64,
  sha256Hex,
  type ListStatesResponse,
  type SaveStateMeta,
  type SaveStateResponse,
} from "../shared/api";

const API = "https://example.com/api";
const ROM_HASH = "b".repeat(64);

function playerKey(): string {
  return crypto.randomUUID();
}

function auth(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` };
}

async function stateBody(state: Uint8Array, over: Record<string, unknown> = {}) {
  return { state: bytesToBase64(state), stateHash: await sha256Hex(state), ...over };
}

function putState(key: string, slot: number, body: unknown, romHash = ROM_HASH) {
  return SELF.fetch(`${API}/saves/${romHash}/states/${slot}`, {
    method: "PUT",
    headers: { ...auth(key), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function listStates(key: string, romHash = ROM_HASH) {
  return SELF.fetch(`${API}/saves/${romHash}/states`, { headers: auth(key) });
}

function getState(key: string, slot: number, romHash = ROM_HASH) {
  return SELF.fetch(`${API}/saves/${romHash}/states/${slot}`, { headers: auth(key) });
}

describe("save states", () => {
  it("stores a state and reads it back with its bytes", async () => {
    const key = playerKey();
    const state = new Uint8Array([1, 2, 3, 4]);
    const put = await putState(key, 2, await stateBody(state, { label: "Boss" }));
    expect(put.status).toBe(200);
    expect(await put.json<SaveStateMeta>()).toMatchObject({ romHash: ROM_HASH, slot: 2, label: "Boss", stateSize: 4 });

    const list = await (await listStates(key)).json<ListStatesResponse>();
    expect(list.states).toMatchObject([{ slot: 2, label: "Boss", stateSize: 4 }]);

    const got = await (await getState(key, 2)).json<SaveStateResponse>();
    expect(got.state).toBe(bytesToBase64(state));
    expect(got).toMatchObject({ slot: 2, label: "Boss", stateHash: await sha256Hex(state) });
  });

  it("keeps slots independent and replaces a slot in place", async () => {
    const key = playerKey();
    await putState(key, 0, await stateBody(new Uint8Array([1])));
    await putState(key, 1, await stateBody(new Uint8Array([2])));
    const replaced = await putState(key, 0, await stateBody(new Uint8Array([3, 3])));
    expect(replaced.status).toBe(200);
    const list = await (await listStates(key)).json<ListStatesResponse>();
    expect(list.states.map((s) => s.slot)).toEqual([0, 1]);
    expect(list.states[0]).toMatchObject({ stateSize: 2 });
  });

  it("refuses a state whose hash does not match its bytes", async () => {
    const key = playerKey();
    const res = await putState(key, 0, { state: bytesToBase64(new Uint8Array([1])), stateHash: "c".repeat(64) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "state_hash_mismatch" });
  });

  it("refuses an empty state and one past the size cap", async () => {
    const key = playerKey();
    expect((await putState(key, 0, await stateBody(new Uint8Array(0)))).status).toBe(400);
    expect((await putState(key, 0, await stateBody(new Uint8Array(512 * 1024 + 1)))).status).toBe(400);
  });

  it("refuses a label past the length cap", async () => {
    const key = playerKey();
    const res = await putState(key, 0, await stateBody(new Uint8Array([1]), { label: "x".repeat(65) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_label" });
  });

  it("answers 404 for a slot never stored, and 400 for a slot out of range", async () => {
    const key = playerKey();
    expect((await getState(key, 5)).status).toBe(404);
    expect((await getState(key, 6)).status).toBe(400);
  });

  it("deletes a state, then reports it missing", async () => {
    const key = playerKey();
    await putState(key, 3, await stateBody(new Uint8Array([9])));
    const del = await SELF.fetch(`${API}/saves/${ROM_HASH}/states/3`, { method: "DELETE", headers: auth(key) });
    expect(del.status).toBe(204);
    expect((await (await listStates(key)).json<ListStatesResponse>()).states).toEqual([]);
    expect((await SELF.fetch(`${API}/saves/${ROM_HASH}/states/3`, { method: "DELETE", headers: auth(key) })).status).toBe(404);
  });

  it("refuses a state write without a valid player", async () => {
    const res = await SELF.fetch(`${API}/saves/${ROM_HASH}/states/0`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });
});
