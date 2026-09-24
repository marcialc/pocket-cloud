import { SELF, env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex, type CloudRomMeta } from "../shared/api";
import type { AuthDO } from "./durable-objects/AuthDO";

const API = "https://example.com/api";
let ip = 100;

afterEach(() => vi.restoreAllMocks());

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": `203.0.113.${++ip}`, ...headers },
    body: JSON.stringify(body),
  });
}

async function signIn(): Promise<string> {
  const email = `player-${crypto.randomUUID()}@example.com`;
  const stub = env.AUTH.getByName(`auth:${await sha256Hex(new TextEncoder().encode(email))}`);
  await runInDurableObject(stub, (_: AuthDO, state) => state.storage.sql.exec("DELETE FROM code_sends"));
  const send = vi.spyOn(env.EMAIL, "send").mockResolvedValue({ messageId: "test" } as never);
  expect((await post("/auth/request", { email })).status).toBe(200);
  const code = /code is: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec((send.mock.calls.at(-1)![0] as { text: string }).text)![1]!;
  const res = await post("/auth/verify", { email, code });
  expect(res.status).toBe(200);
  return res.headers.get("Set-Cookie")!.split(";")[0]!;
}

async function makeRom(seed: number): Promise<{ data: Uint8Array; hash: string }> {
  const data = new Uint8Array(32 * 1024).map((_, i) => (i * seed) & 0xff);
  return { data, hash: await sha256Hex(data) };
}

function putRom(cookie: string, hash: string, data: Uint8Array | ReadableStream, name = "red.gb", picked = false) {
  return SELF.fetch(`${API}/roms/${hash}?name=${encodeURIComponent(name)}&title=POKEMON%20RED${picked ? "&picked=1" : ""}`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/octet-stream" },
    body: data,
  });
}

function listRoms(cookie: string) {
  return SELF.fetch(`${API}/roms`, { headers: { Cookie: cookie } });
}

describe("cloud ROM library", () => {
  it("needs an email session, not the anonymous key", async () => {
    expect((await SELF.fetch(`${API}/roms`)).status).toBe(401);
    const res = await SELF.fetch(`${API}/roms`, { headers: { Authorization: `Bearer ${crypto.randomUUID()}` } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "sign_in_required" });
  });

  it("round-trips a ROM and lists it", async () => {
    const cookie = await signIn();
    const rom = await makeRom(3);
    const put = await putRom(cookie, rom.hash, rom.data, "Pokémon Red.gb");
    expect(put.status).toBe(200);

    const list = await (await listRoms(cookie)).json<{ roms: CloudRomMeta[] }>();
    expect(list.roms).toEqual([
      expect.objectContaining({ romHash: rom.hash, fileName: "Pokémon Red.gb", title: "POKEMON RED", size: 32 * 1024 }),
    ]);

    const got = await SELF.fetch(`${API}/roms/${rom.hash}`, { headers: { Cookie: cookie } });
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(rom.data);
  });

  it("keeps each account's library separate", async () => {
    const a = await signIn();
    const b = await signIn();
    const rom = await makeRom(5);
    await putRom(a, rom.hash, rom.data);
    expect((await (await listRoms(b)).json<{ roms: unknown[] }>()).roms).toHaveLength(0);
    expect((await SELF.fetch(`${API}/roms/${rom.hash}`, { headers: { Cookie: b } })).status).toBe(404);
  });

  it("rejects bytes that don't match the hash, and bad sizes", async () => {
    const cookie = await signIn();
    const rom = await makeRom(7);
    const other = await makeRom(9);
    expect((await putRom(cookie, other.hash, rom.data)).status).toBe(400);
    const tiny = new Uint8Array(100);
    expect((await putRom(cookie, await sha256Hex(tiny), tiny)).status).toBe(400);
    expect((await putRom(cookie, "not-a-hash", rom.data)).status).toBe(400);
  });

  it("deletes a ROM", async () => {
    const cookie = await signIn();
    const rom = await makeRom(11);
    await putRom(cookie, rom.hash, rom.data);
    const del = await SELF.fetch(`${API}/roms/${rom.hash}`, { method: "DELETE", headers: { Cookie: cookie } });
    expect(del.status).toBe(204);
    expect((await SELF.fetch(`${API}/roms/${rom.hash}`, { headers: { Cookie: cookie } })).status).toBe(404);
  });

  it("refuses background re-uploads of a removed game until the player picks the file again", async () => {
    const cookie = await signIn();
    const rom = await makeRom(13);
    await putRom(cookie, rom.hash, rom.data);
    await SELF.fetch(`${API}/roms/${rom.hash}`, { method: "DELETE", headers: { Cookie: cookie } });

    const list = await (await listRoms(cookie)).json<{ roms: unknown[]; removed: string[] }>();
    expect(list).toEqual({ roms: [], removed: [rom.hash] });

    const again = await putRom(cookie, rom.hash, rom.data);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "removed" });

    expect((await putRom(cookie, rom.hash, rom.data, "red.gb", true)).status).toBe(200);
    const after = await (await listRoms(cookie)).json<{ roms: unknown[]; removed: string[] }>();
    expect(after.roms).toHaveLength(1);
    expect(after.removed).toEqual([]);
  });

  it("lets a removal win over a background upload that was already on its way", async () => {
    const cookie = await signIn();
    const rom = await makeRom(23);
    // Device B starts a background upload and is slow to send the bytes...
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = new ReadableStream<Uint8Array>({
      async start(controller) {
        await gate;
        controller.enqueue(rom.data);
        controller.close();
      },
    });
    const background = putRom(cookie, rom.hash, slow);
    await new Promise((r) => setTimeout(r, 50));
    // ...meanwhile device A adds the game and removes it again.
    expect((await putRom(cookie, rom.hash, rom.data, "red.gb", true)).status).toBe(200);
    expect((await SELF.fetch(`${API}/roms/${rom.hash}`, { method: "DELETE", headers: { Cookie: cookie } })).status).toBe(204);
    release();

    expect((await background).status).toBe(409);
    const list = await (await listRoms(cookie)).json<{ roms: unknown[]; removed: string[] }>();
    expect(list).toEqual({ roms: [], removed: [rom.hash] });
  });

  it("stops reading a body without Content-Length once it passes 32 MiB", async () => {
    const cookie = await signIn();
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 33) controller.enqueue(chunk);
        else controller.close();
      },
    });
    expect((await putRom(cookie, "c".repeat(64), body)).status).toBe(413);
  });

  it("takes small ROMs (a 16 KiB NES game) but not tiny files", async () => {
    const cookie = await signIn();
    const nes = new Uint8Array(16 * 1024 + 16).map((_, i) => (i * 29) & 0xff);
    expect((await putRom(cookie, await sha256Hex(nes), nes, "game.nes")).status).toBe(200);
    const tiny = new Uint8Array(512).fill(1);
    const res = await putRom(cookie, await sha256Hex(tiny), tiny, "tiny.nes");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_rom_size" });
  });

  it("stops at 100 games", async () => {
    const cookie = await signIn();
    // Find this account's prefix from a first upload, then fill the rest directly in R2.
    const first = await makeRom(17);
    await putRom(cookie, first.hash, first.data);
    const key = (await env.ROMS.list({ prefix: "roms/" })).objects.find((o) => o.key.endsWith(first.hash))!.key;
    const prefix = key.slice(0, -first.hash.length);
    for (let i = 1; i < 100; i++) await env.ROMS.put(`${prefix}${i.toString(16).padStart(64, "0")}`, new Uint8Array(1));

    const rom = await makeRom(19);
    const res = await putRom(cookie, rom.hash, rom.data);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "library_full" });
  });
});
