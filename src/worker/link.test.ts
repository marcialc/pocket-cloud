import { SELF, env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../shared/api";
import type { ProfileResponse } from "../shared/social";
import type { AuthDO } from "./durable-objects/AuthDO";
import { roomName } from "./link";

// The link server itself is an in-memory stand-in here (testing/fakeLink.ts).

const API = "https://example.com/api";
let ip = 150;

afterEach(() => vi.restoreAllMocks());

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": `198.51.100.${++ip}`, ...headers },
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

function call(cookie: string, method: string, path: string, body?: unknown) {
  return SELF.fetch(`${API}${path}`, {
    method,
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

type Player = { cookie: string; code: string; romHash: string };

/** A signed-in player with a profile and one game in their cloud library. */
async function player(name: string, seed: number): Promise<Player> {
  const cookie = await signIn();
  const res = await call(cookie, "PUT", "/social/profile", { name });
  const code = (await res.json<ProfileResponse>()).profile!.friendCode;
  const rom = new Uint8Array(32 * 1024).map((_, i) => (i * seed) & 0xff);
  const romHash = await sha256Hex(rom);
  const put = await SELF.fetch(`${API}/roms/${romHash}?name=game.gba&title=POKEMON%20EMER`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/octet-stream" },
    body: rom,
  });
  expect(put.status).toBe(200);
  return { cookie, code, romHash };
}

async function friends(name: string): Promise<[Player, Player]> {
  const a = await player(`${name} A`, 3);
  const b = await player(`${name} B`, 5);
  await call(a.cookie, "POST", "/social/friends", { code: b.code });
  await call(b.cookie, "POST", "/social/friends", { code: a.code });
  return [a, b];
}

describe("link play", () => {
  it("needs an email session", async () => {
    const res = await SELF.fetch(`${API}/link/ABCD1234`, { headers: { Authorization: `Bearer ${crypto.randomUUID()}` } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "sign_in_required" });
  });

  it("only links friends", async () => {
    const a = await player("Stranger A", 7);
    const b = await player("Stranger B", 9);
    const res = await call(a.cookie, "POST", `/link/${b.code}/plug`, { romHash: a.romHash });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_friends" });
  });

  it("needs the game in the player's own cloud library", async () => {
    const [a, b] = await friends("Library");
    const res = await call(a.cookie, "POST", `/link/${b.code}/plug`, { romHash: b.romHash });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "rom_not_in_library" });
  });

  it("refuses a malformed plug", async () => {
    const [a, b] = await friends("Malformed");
    expect((await call(a.cookie, "POST", `/link/${b.code}/plug`, { romHash: "nope" })).status).toBe(400);
    expect((await call(a.cookie, "POST", `/link/${b.code}/plug`, { romHash: a.romHash, sram: 5 })).status).toBe(400);
    expect((await call(a.cookie, "GET", `/link/${b.code}/plug`)).status).toBe(405);
  });

  it("puts both friends in one room and shows each only their own slot", async () => {
    const [a, b] = await friends("Room");
    const first = await call(a.cookie, "POST", `/link/${b.code}/plug`, { romHash: a.romHash, sram: btoa("my save") });
    expect(await first.json()).toEqual({ state: "waiting", slot: 1, friendPluggedIn: false, saveWaiting: null });

    const seen = await call(b.cookie, "GET", `/link/${a.code}`);
    expect(await seen.json()).toEqual({ state: "waiting", friendPluggedIn: true, saveWaiting: null });

    const second = await call(b.cookie, "POST", `/link/${a.code}/plug`, { romHash: b.romHash });
    const linked = await second.json<Record<string, unknown>>();
    expect(linked).toEqual({ state: "linked", slot: 2, friendPluggedIn: true, saveWaiting: null });
    expect(JSON.stringify(linked)).not.toMatch(/[0-9a-f]{64}/);
  });

  it("gives each friend their own save when the cable is pulled", async () => {
    const [a, b] = await friends("Unplug");
    await call(a.cookie, "POST", `/link/${b.code}/plug`, { romHash: a.romHash });
    await call(b.cookie, "POST", `/link/${a.code}/plug`, { romHash: b.romHash });

    const unplug = await call(a.cookie, "POST", `/link/${b.code}/unplug`);
    expect(await unplug.json()).toEqual({ sram: btoa("save of player 1"), romHash: a.romHash });
    // B's side sees there's a save to pick up.
    expect(await (await call(b.cookie, "GET", `/link/${a.code}`)).json()).toMatchObject({ state: "empty", saveWaiting: b.romHash });
    expect(await (await call(b.cookie, "GET", `/link/${a.code}/save`)).json()).toEqual({ sram: btoa("save of player 2"), romHash: b.romHash });
    expect(await (await call(b.cookie, "GET", `/link/${a.code}`)).json()).toMatchObject({ saveWaiting: null });
    expect((await call(b.cookie, "GET", `/link/${a.code}/save`)).status).toBe(404);
  });

  it("wants a WebSocket for the screen", async () => {
    const [a, b] = await friends("Screen");
    expect((await call(a.cookie, "GET", `/link/${b.code}/ws`)).status).toBe(426);
  });

  it("names the room the same whoever asks", () => {
    const x = "a".repeat(64);
    const y = "b".repeat(64);
    expect(roomName(x, y)).toBe(roomName(y, x));
    expect(roomName(x, y)).toBe(`pair:${x}:${y}`);
  });
});
