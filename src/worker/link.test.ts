import { SELF, env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../shared/api";
import { LINK_REQUEST_TIMEOUT_MS, type LinkFriend, type LinkFriendsResponse, type PlugResponse } from "../shared/link";
import type { ProfileResponse, PutPresenceResponse } from "../shared/social";
import type { AuthDO } from "./durable-objects/AuthDO";
import type { SocialDO } from "./durable-objects/SocialDO";
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

type Player = { cookie: string; code: string; romHash: string; gameCode: string; tabId: string };

/**
 * A signed-in player with a profile and one game in their cloud library, with
 * `gameCode` in its header (none if empty). The same seed and code make the
 * same ROM file.
 */
async function player(name: string, seed: number, gameCode = "BPEE"): Promise<Player> {
  const cookie = await signIn();
  const res = await call(cookie, "PUT", "/social/profile", { name });
  const code = (await res.json<ProfileResponse>()).profile!.friendCode;
  const rom = new Uint8Array(32 * 1024).map((_, i) => (i * seed) & 0xff);
  rom.set(gameCode ? new TextEncoder().encode(gameCode) : [0, 0, 0, 0], 0xac);
  const romHash = await sha256Hex(rom);
  const put = await SELF.fetch(`${API}/roms/${romHash}?name=game.gba&title=POKEMON%20EMER`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/octet-stream" },
    body: rom,
  });
  expect(put.status).toBe(200);
  return { cookie, code, romHash, gameCode, tabId: crypto.randomUUID() };
}

/** Heartbeat from the player's tab: their game open (or the lobby), in the background if `hidden`. */
async function beat(p: Player, { hidden = false, lobby = false } = {}): Promise<PutPresenceResponse> {
  const game = lobby ? null : { romHash: p.romHash, ...(p.gameCode ? { gameCode: p.gameCode } : {}), name: "My game" };
  const res = await call(p.cookie, "PUT", "/social/presence", { tabId: p.tabId, hidden, game });
  expect(res.status).toBe(200);
  return res.json();
}

/** The player's tab closed: offline. */
async function leave(p: Player) {
  expect((await call(p.cookie, "DELETE", "/social/presence", { tabId: p.tabId })).status).toBe(204);
}

async function befriend(a: { cookie: string; code: string }, b: { cookie: string; code: string }) {
  await call(a.cookie, "POST", "/social/friends", { code: b.code });
  await call(b.cookie, "POST", "/social/friends", { code: a.code });
}

/** Two friends online in games that link: Emerald (A) and FireRed (B). */
async function friends(name: string): Promise<[Player, Player]> {
  const a = await player(`${name} A`, 3, "BPEE");
  const b = await player(`${name} B`, 5, "BPRE");
  await befriend(a, b);
  await beat(a);
  await beat(b);
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
    expect((await call(a.cookie, "POST", `/link/${b.code}/plug`, { romHash: a.romHash, state: "not base64!" })).status).toBe(400);
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

  it("passes the snapshot each friend plugged in with on to the link, and back", async () => {
    const [a, b] = await friends("Snapshot");
    await call(a.cookie, "POST", `/link/${b.code}/plug`, { romHash: a.romHash, sram: btoa("my save"), state: btoa("where I am") });
    await call(b.cookie, "POST", `/link/${a.code}/plug`, { romHash: b.romHash });

    const unplug = await call(a.cookie, "POST", `/link/${b.code}/unplug`);
    expect(await unplug.json()).toEqual({ sram: btoa("save of player 1"), state: btoa("where I am"), romHash: a.romHash });
    // Plugged in without one (an older app): just the save.
    expect(await (await call(b.cookie, "GET", `/link/${a.code}/save`)).json()).toEqual({ sram: btoa("save of player 2"), romHash: b.romHash });
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

describe("link panel", () => {
  const randomHash = () => crypto.randomUUID().replaceAll("-", "").repeat(2);

  async function profile(name: string): Promise<Pick<Player, "cookie" | "code">> {
    const cookie = await signIn();
    const res = await call(cookie, "PUT", "/social/profile", { name });
    return { cookie, code: (await res.json<ProfileResponse>()).profile!.friendCode };
  }

  function heartbeat(cookie: string, game: { romHash: string; gameCode?: string; name: string } | null) {
    return call(cookie, "PUT", "/social/presence", { tabId: crypto.randomUUID(), hidden: false, game });
  }

  async function panel(cookie: string, romHash: string): Promise<LinkFriend[]> {
    const res = await call(cookie, "GET", `/link?romHash=${romHash}`);
    expect(res.status).toBe(200);
    return (await res.json<LinkFriendsResponse>()).friends;
  }

  const byName = (rows: LinkFriend[], name: string) => rows.find((row) => row.friend.name === name);
  const noRoom = { state: "empty", friendPluggedIn: false, saveWaiting: null };

  it("says which friends can link with your game, and why the others can't", async () => {
    const ash = await profile("Ash");
    const mine = randomHash();
    await heartbeat(ash.cookie, { romHash: mine, gameCode: "BPEE", name: "Emerald" });

    const others = {
      same: { romHash: mine, name: "My Emerald" },
      table: { romHash: randomHash(), gameCode: "BPRP", name: "FireRed EU" },
      other: { romHash: randomHash(), gameCode: "AMKE", name: "Kart run" },
    };
    const secrets = [mine, others.table.romHash, others.other.romHash, "BPEE", "BPRP", "AMKE"];
    for (const [name, game] of Object.entries(others)) {
      const friend = await profile(name);
      await befriend(ash, friend);
      await heartbeat(friend.cookie, game);
    }
    const lobby = await profile("lobby");
    await befriend(ash, lobby);
    await heartbeat(lobby.cookie, null);
    await befriend(ash, await profile("offline"));

    const link = vi.spyOn(env.LINK, "fetch");
    const res = await call(ash.cookie, "GET", `/link?romHash=${mine}`);
    const body = await res.text();
    const rows = (JSON.parse(body) as LinkFriendsResponse).friends;
    expect(byName(rows, "same")).toMatchObject({ availability: "can_link", link: noRoom });
    expect(byName(rows, "table")).toMatchObject({ availability: "can_link", link: noRoom });
    expect(byName(rows, "other")).toEqual({ friend: expect.anything(), availability: "other_game", playing: "Kart run", link: noRoom });
    expect(byName(rows, "lobby")).toEqual({ friend: expect.anything(), availability: "lobby", link: noRoom });
    expect(byName(rows, "offline")).toEqual({ friend: expect.anything(), availability: "offline", link: noRoom });
    for (const row of rows) expect(Object.keys(row.friend).sort()).toEqual(["friendCode", "name"]);
    // Only the two who can link have their room asked about.
    expect(link).toHaveBeenCalledTimes(2);
    // Nobody's ROM hash or game code goes out (friend codes aside, which could hold the same letters by chance).
    const sent = body.replace(/"friendCode":"[^"]*"/g, "");
    for (const secret of secrets) expect(sent).not.toContain(secret);
  });

  it("matches by ROM hash alone while your own presence doesn't have this game yet", async () => {
    const ash = await profile("Ash");
    const mine = randomHash();
    await heartbeat(ash.cookie, { romHash: randomHash(), gameCode: "BPEE", name: "Emerald" });
    const same = await profile("same");
    const table = await profile("table");
    await befriend(ash, same);
    await befriend(ash, table);
    await heartbeat(same.cookie, { romHash: mine, name: "Same file" });
    await heartbeat(table.cookie, { romHash: randomHash(), gameCode: "BPEE", name: "Emerald" });

    const rows = await panel(ash.cookie, mine);
    expect(byName(rows, "same")?.availability).toBe("can_link");
    expect(byName(rows, "table")).toMatchObject({ availability: "other_game", playing: "Emerald" });
  });

  it("shows a friend who plugged in as waiting for you", async () => {
    const [a, b] = await friends("Waiting");
    await heartbeat(a.cookie, { romHash: a.romHash, gameCode: "BPEE", name: "Emerald" });
    await heartbeat(b.cookie, { romHash: b.romHash, gameCode: "BPRE", name: "FireRed" });
    await call(a.cookie, "POST", `/link/${b.code}/plug`, { romHash: a.romHash });

    const [row] = await panel(b.cookie, b.romHash);
    expect(row).toMatchObject({ availability: "can_link", link: { state: "waiting", friendPluggedIn: true, saveWaiting: null } });
  });

  it("keeps a save waiting from your last link reachable whatever your friend is doing, then stops asking", async () => {
    const [a, b] = await friends("Leftover");
    await call(a.cookie, "POST", `/link/${b.code}/plug`, { romHash: a.romHash });
    await call(b.cookie, "POST", `/link/${a.code}/plug`, { romHash: b.romHash });
    await call(a.cookie, "POST", `/link/${b.code}/unplug`);
    await leave(a);

    // A is offline, but B's save from the link is still found.
    const link = vi.spyOn(env.LINK, "fetch");
    const [row] = await panel(b.cookie, b.romHash);
    expect(row).toMatchObject({ availability: "offline", link: { state: "empty", saveWaiting: b.romHash } });
    expect(link).toHaveBeenCalledTimes(1);

    // Picked up: the room is seen empty once more, then left alone.
    await call(b.cookie, "GET", `/link/${a.code}/save`);
    link.mockClear();
    expect((await panel(b.cookie, b.romHash))[0]!.link).toEqual(noRoom);
    expect(link).toHaveBeenCalledTimes(1);
    expect((await panel(b.cookie, b.romHash))[0]!.link).toEqual(noRoom);
    expect(link).toHaveBeenCalledTimes(1);
  });

  it("wants the ROM hash of the open game", async () => {
    const ash = await profile("Ash");
    expect((await call(ash.cookie, "GET", "/link")).status).toBe(400);
    expect(await (await call(ash.cookie, "GET", "/link?romHash=nope")).json()).toEqual({ error: "invalid_rom_hash" });
    expect((await call(ash.cookie, "GET", `/link?romHash=${"A".repeat(64)}`)).status).toBe(400);
    expect((await call(ash.cookie, "POST", `/link?romHash=${randomHash()}`)).status).toBe(405);
  });
});

describe("plug guard", () => {
  it("needs the friend online in a game", async () => {
    const [a, b] = await friends("Guard online");
    await beat(b, { lobby: true });
    const lobby = await call(a.cookie, "POST", `/link/${b.code}/plug`, { romHash: a.romHash });
    expect(lobby.status).toBe(409);
    expect(await lobby.json()).toEqual({ error: "friend_not_in_game" });
    // Nobody was plugged in.
    expect(await (await call(b.cookie, "GET", `/link/${a.code}`)).json()).toMatchObject({ state: "empty", friendPluggedIn: false });
  });

  // Deploy window (see plugRefusal): remove with the allowance.
  it("lets a plain plug through to a friend with no presence at all, but not an ask", async () => {
    const [a, b] = await friends("Guard no presence");
    await leave(b);
    const ask = await call(a.cookie, "POST", `/link/${b.code}/plug`, { romHash: a.romHash, ask: true });
    expect(await ask.json()).toEqual({ error: "friend_offline" });
    const plug = await call(a.cookie, "POST", `/link/${b.code}/plug`, { romHash: a.romHash });
    expect(plug.status).toBe(200);
    expect(await plug.json()).toMatchObject({ state: "waiting", friendPluggedIn: false });
    // Nobody was asked.
    expect(await beat(a)).toEqual({});
  });

  it("reads both game codes from the ROMs, not from heartbeats", async () => {
    const a = await player("Guard codes A", 3, "BPEE");
    const b = await player("Guard codes B", 5, "AMKE");
    await befriend(a, b);
    await beat(a);
    // B's heartbeat claims FireRed; their ROM says Mario Kart.
    await call(b.cookie, "PUT", "/social/presence", { tabId: b.tabId, hidden: false, game: { romHash: b.romHash, gameCode: "BPRE", name: "FireRed" } });
    const res = await call(a.cookie, "POST", `/link/${b.code}/plug`, { romHash: a.romHash });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "games_cannot_link" });
  });

  it("links the same ROM file, game code or not", async () => {
    const a = await player("Guard same A", 11, "");
    const b = await player("Guard same B", 11, "");
    expect(a.romHash).toBe(b.romHash);
    await befriend(a, b);
    await beat(a);
    await beat(b);
    expect((await call(a.cookie, "POST", `/link/${b.code}/plug`, { romHash: a.romHash })).status).toBe(200);
    expect(await (await call(b.cookie, "POST", `/link/${a.code}/plug`, { romHash: b.romHash })).json()).toMatchObject({ state: "linked" });
  });

  it("checks the player plugging in second (accepting) as well", async () => {
    const [a, b] = await friends("Guard second");
    await call(a.cookie, "POST", `/link/${b.code}/plug`, { romHash: a.romHash });
    // A wandered off to the lobby while waiting.
    await beat(a, { lobby: true });
    const res = await call(b.cookie, "POST", `/link/${a.code}/plug`, { romHash: b.romHash });
    expect(await res.json()).toEqual({ error: "friend_not_in_game" });
  });

  it("always lets you pick up the save from your last link, in that game", async () => {
    const [a, b] = await friends("Guard save");
    await call(a.cookie, "POST", `/link/${b.code}/plug`, { romHash: a.romHash });
    await call(b.cookie, "POST", `/link/${a.code}/plug`, { romHash: b.romHash });
    await call(a.cookie, "POST", `/link/${b.code}/unplug`);
    await leave(a);

    // A is offline, yet B's plug gets through to the link server, which hands B their save first.
    const plug = await call(b.cookie, "POST", `/link/${a.code}/plug`, { romHash: b.romHash, ask: true });
    expect(plug.status).toBe(409);
    expect(await plug.json()).toEqual({ error: "collect_save_first" });
    expect((await call(b.cookie, "GET", `/link/${a.code}/save`)).status).toBe(200);
    // Picked up: linking again needs A back in a game.
    await beat(a, { lobby: true });
    expect(await (await call(b.cookie, "POST", `/link/${a.code}/plug`, { romHash: b.romHash })).json()).toEqual({ error: "friend_not_in_game" });
  });

  it("refuses an ask that isn't true or false", async () => {
    const [a, b] = await friends("Guard ask");
    expect((await call(a.cookie, "POST", `/link/${b.code}/plug`, { romHash: a.romHash, ask: "yes" })).status).toBe(400);
  });
});

describe("link requests", () => {
  async function ask(from: Player, to: Player): Promise<string> {
    const res = await call(from.cookie, "POST", `/link/${to.code}/plug`, { romHash: from.romHash, ask: true });
    expect(res.status).toBe(200);
    const body = await res.json<PlugResponse>();
    expect(body).toMatchObject({ state: "waiting", slot: 1, friendPluggedIn: false });
    return body.requestId!;
  }

  const profileOf = (p: Player, name: string) => ({ name, friendCode: p.code });

  it("reaches the friend with the next heartbeat, and is gone once they accept", async () => {
    const [a, b] = await friends("Accept");
    const id = await ask(a, b);

    expect(await beat(b)).toEqual({ incoming: { id, from: profileOf(a, "Accept A"), gameName: "My game" } });
    expect(await beat(a)).toEqual({ outgoing: { id, to: profileOf(b, "Accept B"), state: "pending" } });
    // Only a tab in a game that links hears about it, and another tab on the games page doesn't turn it down.
    const lobbyTab = { ...b, tabId: crypto.randomUUID() };
    expect(await beat(lobbyTab, { lobby: true, hidden: true })).toEqual({});
    expect((await beat(b)).incoming).toMatchObject({ id });

    // B accepts: B plugs in, which links the two.
    expect(await (await call(b.cookie, "POST", `/link/${a.code}/plug`, { romHash: b.romHash })).json()).toMatchObject({ state: "linked" });
    expect(await beat(b)).toEqual({});
    expect(await beat(a)).toEqual({});
  });

  it("is forgotten when the friend accepts just after it timed out, so the asker doesn't unplug", async () => {
    const [a, b] = await friends("Late accept");
    const start = Date.now();
    await ask(a, b);
    vi.spyOn(Date, "now").mockReturnValue(start + LINK_REQUEST_TIMEOUT_MS + 1_000);
    expect(await beat(b)).toEqual({});
    // B's modal was still up: B accepts before A has heard of the timeout.
    expect(await (await call(b.cookie, "POST", `/link/${a.code}/plug`, { romHash: b.romHash })).json()).toMatchObject({ state: "linked" });
    expect(await beat(a)).toEqual({});
  });

  it("tells the asker when the friend says no", async () => {
    const [a, b] = await friends("Decline");
    const id = await ask(a, b);
    expect((await call(b.cookie, "DELETE", `/social/link-requests/${id}`)).status).toBe(204);

    expect(await beat(a)).toEqual({ outgoing: { id, to: profileOf(b, "Decline B"), state: "declined" } });
    expect(await beat(b)).toEqual({});
    expect((await call(b.cookie, "DELETE", `/social/link-requests/${id}`)).status).toBe(404);
    // A's app unplugs on hearing it; the answer stands.
    expect((await call(a.cookie, "POST", `/link/${b.code}/unplug`)).status).toBe(200);
    expect((await beat(a)).outgoing).toMatchObject({ state: "declined" });
  });

  it("only lets the friend asked say no", async () => {
    const [a, b] = await friends("Decline who");
    const id = await ask(a, b);
    expect((await call(a.cookie, "DELETE", `/social/link-requests/${id}`)).status).toBe(404);
    expect((await call(a.cookie, "DELETE", `/social/link-requests/nope`)).status).toBe(404);
    expect((await call(a.cookie, "POST", `/social/link-requests/${id}`)).status).toBe(405);
    expect((await beat(a)).outgoing).toMatchObject({ state: "pending" });
  });

  it("times out after a minute without an answer, then is forgotten", async () => {
    const [a, b] = await friends("Timeout");
    const start = Date.now();
    const id = await ask(a, b);

    vi.spyOn(Date, "now").mockReturnValue(start + LINK_REQUEST_TIMEOUT_MS - 5_000);
    expect((await beat(b)).incoming).toMatchObject({ id });
    vi.spyOn(Date, "now").mockReturnValue(start + LINK_REQUEST_TIMEOUT_MS + 1_000);
    expect(await beat(b)).toEqual({});
    expect(await beat(a)).toEqual({ outgoing: { id, to: profileOf(b, "Timeout B"), state: "timed_out" } });

    // Kept a while for A's heartbeat to hear, then dropped.
    vi.spyOn(Date, "now").mockReturnValue(start + 2 * LINK_REQUEST_TIMEOUT_MS + 5_000);
    await beat(b);
    expect(await beat(a)).toEqual({});
  });

  it("is cancelled when the asker stops waiting", async () => {
    const [a, b] = await friends("Cancel");
    const id = await ask(a, b);
    expect((await call(a.cookie, "POST", `/link/${b.code}/unplug`)).status).toBe(200);
    expect(await beat(b)).toEqual({});
    expect(await beat(a)).toEqual({ outgoing: { id, to: profileOf(b, "Cancel B"), state: "cancelled" } });
  });

  it("is cancelled when the asker leaves the game", async () => {
    const [a, b] = await friends("Asker leaves");
    await ask(a, b);
    await beat(a, { lobby: true });
    expect(await beat(b)).toEqual({});
    expect((await beat(a)).outgoing).toMatchObject({ state: "cancelled" });
  });

  it("is turned down when the friend leaves the game", async () => {
    const [a, b] = await friends("Leaves");
    const id = await ask(a, b);
    await beat(b, { lobby: true });
    expect(await beat(a)).toEqual({ outgoing: { id, to: profileOf(b, "Leaves B"), state: "unavailable", reason: "not_in_game" } });
    // Back in the game: it stays turned down.
    expect(await beat(b)).toEqual({});
  });

  it("is turned down when the friend hides the tab", async () => {
    const [a, b] = await friends("Hides");
    await ask(a, b);
    expect(await beat(b, { hidden: true })).toEqual({});
    expect((await beat(a)).outgoing).toMatchObject({ state: "unavailable", reason: "hidden" });
  });

  it("is turned down when the friend goes offline", async () => {
    const [a, b] = await friends("Offline");
    await ask(a, b);
    await leave(b);
    expect((await beat(a)).outgoing).toMatchObject({ state: "unavailable", reason: "offline" });
  });

  it("is turned down when the friend plugs in with someone else", async () => {
    const [a, b] = await friends("Elsewhere");
    const c = await player("Elsewhere C", 7, "BPGE");
    await befriend(b, c);
    await beat(c);
    await ask(a, b);
    await ask(c, b);
    // B accepts C's.
    expect(await (await call(b.cookie, "POST", `/link/${c.code}/plug`, { romHash: b.romHash })).json()).toMatchObject({ state: "linked" });
    expect((await beat(a)).outgoing).toMatchObject({ state: "unavailable", reason: "linked" });
    expect(await beat(c)).toEqual({});
  });

  it("is turned down at once, without plugging in, when the friend can't answer", async () => {
    const [a, b] = await friends("At once");
    const refused = async (error: string) => {
      const res = await call(a.cookie, "POST", `/link/${b.code}/plug`, { romHash: a.romHash, ask: true });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error });
      expect(await (await call(b.cookie, "GET", `/link/${a.code}`)).json()).toMatchObject({ state: "empty", friendPluggedIn: false });
    };

    await beat(b, { hidden: true });
    await refused("friend_not_looking");
    await beat(b, { lobby: true });
    await refused("friend_not_in_game");
    await leave(b);
    await refused("friend_offline");
    expect(await beat(a)).toEqual({});

    // On the cable with someone else (here, waiting for them).
    const c = await player("At once C", 7, "BPGE");
    await befriend(b, c);
    await beat(b);
    await beat(c);
    await ask(b, c);
    await refused("friend_linked");
  });

  it("shows several requests one at a time, oldest first", async () => {
    const [a, b] = await friends("Several");
    const c = await player("Several C", 7, "AXVE");
    await befriend(b, c);
    await beat(c);
    const start = Date.now();
    const first = await ask(a, b);
    vi.spyOn(Date, "now").mockReturnValue(start + 1_000);
    const second = await ask(c, b);

    expect((await beat(b)).incoming).toMatchObject({ id: first, from: { friendCode: a.code } });
    await call(b.cookie, "DELETE", `/social/link-requests/${first}`);
    expect((await beat(b)).incoming).toMatchObject({ id: second, from: { friendCode: c.code } });
  });

  it("isn't sent when the friend is already waiting for you: the link just starts", async () => {
    const [a, b] = await friends("Already waiting");
    await ask(b, a);
    const res = await call(a.cookie, "POST", `/link/${b.code}/plug`, { romHash: a.romHash, ask: true });
    const body = await res.json<PlugResponse>();
    expect(body).toMatchObject({ state: "linked" });
    expect(body.requestId).toBeUndefined();
    expect(await beat(a)).toEqual({});
    expect(await beat(b)).toEqual({});
  });

  it("leaves the link poll to the link server", async () => {
    const [a, b] = await friends("Poll");
    await ask(a, b);
    // The poll's only call to the social object is the friend lookup it always made: none for presence or requests.
    // Spied on the class, not the instance: RPC only calls methods from the prototype.
    const social: SocialDO = await runInDurableObject(env.SOCIAL.getByName("social"), (instance: SocialDO) => Object.getPrototypeOf(instance));
    const calls = [
      "setPresence",
      "clearPresence",
      "linkCandidates",
      "linkTarget",
      "linkPlugged",
      "cancelLinkRequest",
      "declineLinkRequest",
      "noteLinkRoom",
      "forgetLinkRooms",
    ] as const;
    const spies = calls.map((name) => vi.spyOn(social, name));
    expect((await call(a.cookie, "GET", `/link/${b.code}`)).status).toBe(200);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    // The spies see calls (sanity): a heartbeat goes through setPresence.
    await beat(a);
    expect(spies[calls.indexOf("setPresence")]).toHaveBeenCalled();
  });
});
