import { SELF, env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64, sha256Hex } from "../shared/api";
import type { AddFriendResponse, FriendsResponse, GamesResponse, ProfileResponse } from "../shared/social";
import type { AuthDO } from "./durable-objects/AuthDO";

const API = "https://example.com/api";
let ip = 50;

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
  return SELF.fetch(`${API}/social${path}`, {
    method,
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** A signed-in player with a profile. */
async function player(name: string): Promise<{ cookie: string; code: string }> {
  const cookie = await signIn();
  const res = await call(cookie, "PUT", "/profile", { name });
  expect(res.status).toBe(200);
  return { cookie, code: (await res.json<ProfileResponse>()).profile!.friendCode };
}

async function befriend(a: { cookie: string; code: string }, b: { cookie: string; code: string }) {
  expect(await (await call(a.cookie, "POST", "/friends", { code: b.code })).json()).toMatchObject({ status: "requested" });
  expect(await (await call(b.cookie, "POST", "/friends", { code: a.code })).json()).toMatchObject({ status: "friends" });
}

async function putSave(cookie: string, romHash: string, gameId: string, sram: Uint8Array, playTime: number, baseRevision: number | null = null) {
  const res = await SELF.fetch(`${API}/saves/${romHash}`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      gameId,
      sram: bytesToBase64(sram),
      sramHash: await sha256Hex(sram),
      updatedAt: Date.now(),
      baseRevision,
      playTime,
    }),
  });
  expect(res.status).toBe(200);
}

async function games(cookie: string, romHash?: string): Promise<GamesResponse["games"]> {
  const res = await call(cookie, "GET", romHash ? `/games/${romHash}` : "/games");
  expect(res.status).toBe(200);
  return (await res.json<GamesResponse>()).games;
}

function randomHash(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("friends", () => {
  it("needs an email session and a profile", async () => {
    expect((await SELF.fetch(`${API}/social/profile`)).status).toBe(401);
    const key = await SELF.fetch(`${API}/social/profile`, { headers: { Authorization: `Bearer ${crypto.randomUUID()}` } });
    expect(key.status).toBe(403);

    const cookie = await signIn();
    expect(await (await call(cookie, "GET", "/profile")).json()).toEqual({ profile: null });
    const noProfile = await call(cookie, "GET", "/friends");
    expect(noProfile.status).toBe(409);
    expect(await noProfile.json()).toMatchObject({ error: "profile_required" });
  });

  it("gives a profile a friend code and keeps it across renames", async () => {
    const cookie = await signIn();
    expect((await call(cookie, "PUT", "/profile", { name: "   " })).status).toBe(400);
    expect((await call(cookie, "PUT", "/profile", { name: "x".repeat(21) })).status).toBe(400);
    const created = (await (await call(cookie, "PUT", "/profile", { name: "  Ash   K " })).json<ProfileResponse>()).profile!;
    expect(created.name).toBe("Ash K");
    expect(created.friendCode).toMatch(/^[A-Z2-9]{8}$/);
    const renamed = (await (await call(cookie, "PUT", "/profile", { name: "Red" })).json<ProfileResponse>()).profile!;
    expect(renamed).toEqual({ name: "Red", friendCode: created.friendCode, inviteToken: created.inviteToken });
  });

  it("becomes friends once both sides add each other", async () => {
    const ash = await player("Ash");
    const misty = await player("Misty");

    // Codes work with or without the dash, in any case.
    const asked = await call(ash.cookie, "POST", "/friends", { code: `${misty.code.slice(0, 4)}-${misty.code.slice(4)}`.toLowerCase() });
    expect(await asked.json<AddFriendResponse>()).toEqual({ status: "requested", friend: { name: "Misty", friendCode: misty.code } });
    expect(await (await call(ash.cookie, "GET", "/friends")).json<FriendsResponse>()).toMatchObject({
      friends: [],
      outgoing: [{ name: "Misty" }],
    });
    expect(await (await call(misty.cookie, "GET", "/friends")).json<FriendsResponse>()).toMatchObject({
      friends: [],
      incoming: [{ name: "Ash" }],
    });

    expect(await (await call(misty.cookie, "POST", "/friends", { code: ash.code })).json()).toMatchObject({ status: "friends" });
    expect(await (await call(ash.cookie, "GET", "/friends")).json()).toEqual({
      friends: [{ name: "Misty", friendCode: misty.code }],
      incoming: [],
      outgoing: [],
    });
    const again = await call(ash.cookie, "POST", "/friends", { code: misty.code });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "already_friends" });
  });

  it("refuses your own code and codes nobody has", async () => {
    const ash = await player("Ash");
    expect(await (await call(ash.cookie, "POST", "/friends", { code: ash.code })).json()).toMatchObject({ error: "self" });
    expect((await call(ash.cookie, "POST", "/friends", { code: "nope" })).status).toBe(400);
    const unknown = ash.code === "ZZZZZZZZ" ? "YYYYYYYY" : "ZZZZZZZZ";
    expect((await call(ash.cookie, "POST", "/friends", { code: unknown })).status).toBe(404);
  });

  it("unfriends, declines and cancels with DELETE", async () => {
    const ash = await player("Ash");
    const misty = await player("Misty");
    const brock = await player("Brock");
    await befriend(ash, misty);
    await call(brock.cookie, "POST", "/friends", { code: ash.code });

    expect((await call(ash.cookie, "DELETE", `/friends/${misty.code}`)).status).toBe(204);
    expect((await call(ash.cookie, "DELETE", `/friends/${brock.code}`)).status).toBe(204);
    expect(await (await call(misty.cookie, "GET", "/friends")).json()).toEqual({ friends: [], incoming: [], outgoing: [] });
    expect(await (await call(brock.cookie, "GET", "/friends")).json()).toEqual({ friends: [], incoming: [], outgoing: [] });
    expect((await call(ash.cookie, "DELETE", `/friends/${brock.code}`)).status).toBe(404);
  });
});

describe("invite links", () => {
  async function inviteToken(cookie: string): Promise<string> {
    return (await (await call(cookie, "GET", "/profile")).json<ProfileResponse>()).profile!.inviteToken;
  }

  it("says whose link it is, even before sign-in", async () => {
    const ash = await player("Ash");
    const res = await SELF.fetch(`${API}/social/invites/${await inviteToken(ash.cookie)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inviter: { name: "Ash", friendCode: ash.code } });
    expect((await SELF.fetch(`${API}/social/invites/${"0".repeat(24)}`)).status).toBe(404);
    expect((await SELF.fetch(`${API}/social/invites/nope`)).status).toBe(404);
  });

  it("makes you friends at once, with no request to accept", async () => {
    const ash = await player("Ash");
    const misty = await player("Misty");
    const token = await inviteToken(ash.cookie);
    const res = await call(misty.cookie, "POST", `/invites/${token}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ friend: { name: "Ash", friendCode: ash.code } });
    expect(await (await call(ash.cookie, "GET", "/friends")).json()).toEqual({
      friends: [{ name: "Misty", friendCode: misty.code }],
      incoming: [],
      outgoing: [],
    });
    // Opening the link again is harmless.
    expect((await call(misty.cookie, "POST", `/invites/${token}`)).status).toBe(200);
  });

  it("settles a pending friend request between the two", async () => {
    const ash = await player("Ash");
    const misty = await player("Misty");
    await call(misty.cookie, "POST", "/friends", { code: ash.code });
    await call(misty.cookie, "POST", `/invites/${await inviteToken(ash.cookie)}`);
    expect(await (await call(misty.cookie, "GET", "/friends")).json()).toMatchObject({ incoming: [], outgoing: [] });
  });

  it("needs a signed-in player with a profile to accept, and not your own link", async () => {
    const ash = await player("Ash");
    const token = await inviteToken(ash.cookie);
    expect((await SELF.fetch(`${API}/social/invites/${token}`, { method: "POST" })).status).toBe(401);
    const noProfile = await signIn();
    expect((await call(noProfile, "POST", `/invites/${token}`)).status).toBe(409);
    expect(await (await call(ash.cookie, "POST", `/invites/${token}`)).json()).toMatchObject({ error: "self" });
  });

  it("stops working once reset", async () => {
    const ash = await player("Ash");
    const misty = await player("Misty");
    const old = await inviteToken(ash.cookie);
    const reset = await (await call(ash.cookie, "POST", "/profile/invite")).json<ProfileResponse>();
    expect(reset.profile!.inviteToken).not.toBe(old);
    expect(reset.profile!.friendCode).toBe(ash.code);
    expect((await call(misty.cookie, "POST", `/invites/${old}`)).status).toBe(404);
    expect((await call(misty.cookie, "POST", `/invites/${reset.profile!.inviteToken}`)).status).toBe(200);
  });
});

describe("leaderboards", () => {
  it("puts friends who play the same ROM on one board, best first", async () => {
    const ash = await player("Ash");
    const misty = await player("Misty");
    const stranger = await player("Gary");
    await befriend(ash, misty);
    const rom = randomHash();

    await putSave(ash.cookie, rom, "ZELDA", new Uint8Array([1]), 60_000);
    await putSave(misty.cookie, rom, "ZELDA", new Uint8Array([2]), 90_000);
    await putSave(stranger.cookie, rom, "ZELDA", new Uint8Array([3]), 999_000);

    const [game] = await games(ash.cookie, rom);
    expect(game).toMatchObject({ romHash: rom, title: "ZELDA", players: 2 });
    expect(game!.boards).toEqual([
      {
        board: "playtime",
        entries: [
          expect.objectContaining({ name: "Misty", value: 90_000, me: false }),
          expect.objectContaining({ name: "Ash", value: 60_000, me: true }),
        ],
      },
    ]);
  });

  it("keeps the best value when a later save is lower", async () => {
    const ash = await player("Ash");
    const rom = randomHash();
    await putSave(ash.cookie, rom, "ZELDA", new Uint8Array([1]), 80_000);
    await putSave(ash.cookie, rom, "ZELDA", new Uint8Array([2]), 10_000, 1);
    expect((await games(ash.cookie, rom))[0]!.boards[0]!.entries[0]!.value).toBe(80_000);
  });

  it("counts the Pokédex in a Pokémon Red save", async () => {
    const ash = await player("Ash");
    const rom = randomHash();
    const sram = new Uint8Array(32 * 1024);
    sram[0x25a3] = 0b0000_0111; // Bulbasaur, Ivysaur, Venusaur
    sram[0x25a3 + 18] = 0b0100_0000; // Mew (#151)
    await putSave(ash.cookie, rom, "POKEMON RED", sram, 5_000);
    const [game] = await games(ash.cookie, rom);
    expect(game!.boards.map((b) => [b.board, b.entries[0]!.value])).toEqual([
      ["pokedex", 4],
      ["playtime", 5_000],
    ]);
  });

  it("keeps other platforms' saves and scores off the boards", async () => {
    const ash = await player("Ash");
    const rom = randomHash();
    const sram = new Uint8Array(32 * 1024);
    sram[0x25a3] = 0b0000_0111;
    // A NES file named like a Game Boy title isn't a Pokémon Red save.
    await putSave(ash.cookie, rom, "nes:POKEMON RED", sram, 5_000);
    const res = await call(ash.cookie, "PUT", `/scores/${rom}`, { board: "tetris", value: 100, title: "nes:TETRIS" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unsupported_game" });
    expect(await games(ash.cookie, rom)).toEqual([]);
  });

  it("takes browser-reported scores only for boards the browser watches", async () => {
    const ash = await player("Ash");
    const rom = randomHash();
    const put = (body: unknown) => call(ash.cookie, "PUT", `/scores/${rom}`, body);
    expect((await put({ board: "tetris", value: 1_200, title: "TETRIS" })).status).toBe(204);
    expect((await put({ board: "tetris", value: 800, title: "TETRIS" })).status).toBe(204);
    expect((await put({ board: "playtime", value: 1, title: "TETRIS" })).status).toBe(400);
    expect((await put({ board: "tetris", value: 1_000_000, title: "TETRIS" })).status).toBe(400);
    expect((await put({ board: "tetris", value: -1, title: "TETRIS" })).status).toBe(400);
    const [game] = await games(ash.cookie, rom);
    expect(game!.boards).toEqual([{ board: "tetris", entries: [expect.objectContaining({ value: 1_200, me: true })] }]);
  });

  it("keeps browser-reported scores from before the player picked a name", async () => {
    const cookie = await signIn();
    const rom = randomHash();
    expect((await call(cookie, "PUT", `/scores/${rom}`, { board: "tetris", value: 500, title: "TETRIS" })).status).toBe(204);
    await call(cookie, "PUT", "/profile", { name: "Ash" });
    expect((await games(cookie, rom))[0]!.boards[0]!.entries[0]!.value).toBe(500);
  });

  it("refuses titles with control or direction characters", async () => {
    const ash = await player("Ash");
    const rom = randomHash();
    const put = (title: string) => call(ash.cookie, "PUT", `/scores/${rom}`, { board: "tetris", value: 1, title });
    expect((await put("TETRIS\u202e")).status).toBe(400);
    expect((await put("TET\nRIS")).status).toBe(400);
    expect((await put("")).status).toBe(400);
    await putSave(ash.cookie, rom, "ZELDA\u200b", new Uint8Array([1]), 1_000);
    expect(await games(ash.cookie, rom)).toEqual([]);
  });

  it("names a shared game after your own copy, so a friend can't rename it", async () => {
    const ash = await player("Ash");
    const misty = await player("Misty");
    await befriend(ash, misty);
    const rom = randomHash();
    await putSave(ash.cookie, rom, "ZELDA", new Uint8Array([1]), 1_000);
    await call(misty.cookie, "PUT", `/scores/${rom}`, { board: "tetris", value: 1, title: "RENAMED" });
    expect((await games(ash.cookie, rom))[0]!.title).toBe("ZELDA");
    // Someone who hasn't played it sees the first title recorded, not the latest.
    const brock = await player("Brock");
    await befriend(brock, ash);
    await befriend(brock, misty);
    expect((await games(brock.cookie, rom))[0]!.title).toBe("ZELDA");
  });

  it("lists shared games before games only one of you plays", async () => {
    const ash = await player("Ash");
    const misty = await player("Misty");
    await befriend(ash, misty);
    const shared = randomHash();
    const solo = randomHash();
    await putSave(ash.cookie, shared, "ZELDA", new Uint8Array([1]), 1_000);
    await putSave(misty.cookie, shared, "ZELDA", new Uint8Array([1]), 2_000);
    await putSave(misty.cookie, solo, "KIRBY", new Uint8Array([1]), 3_000);
    expect((await games(ash.cookie)).map((g) => [g.title, g.players])).toEqual([
      ["ZELDA", 2],
      ["KIRBY", 1],
    ]);
  });

  it("still accepts anonymous saves (they have no board to go on)", async () => {
    const key = crypto.randomUUID();
    const sram = new Uint8Array([1]);
    const res = await SELF.fetch(`${API}/saves/${randomHash()}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ gameId: "ZELDA", sram: bytesToBase64(sram), sramHash: await sha256Hex(sram), updatedAt: 1, baseRevision: null, playTime: 5 }),
    });
    expect(res.status).toBe(200);
  });
});
