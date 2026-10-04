import { HASH_PATTERN, MAX_LINK_STATE_BYTES, MAX_SRAM_BYTES, base64ToBytes } from "../shared/api";
import type { LinkAvailability, LinkFriend, LinkFriendsResponse, LinkState, LinkStatus, PlugResponse } from "../shared/link";
import { canLink, type LinkGame } from "../shared/linkCompat";
import { GAME_CODE_PATTERN, normalizeFriendCode } from "../shared/social";
import type { RawPresence } from "./durable-objects/SocialDO";
import { json, methodNotAllowed, readLimited } from "./http";
import { socialStub } from "./social";
import { track } from "./stats";

/**
 * GBA link play between two friends (email sign-in only). Both games run in
 * the pocket-cloud-link Worker's container (link-server/); this checks who
 * is asking and that they're friends, then forwards. Each pair of friends
 * has one room.
 *
 *   GET  /api/link?romHash=             { friends: LinkFriend[] } every friend, whether
 *                                       they can link with that game (the one you
 *                                       have open), and your room with them
 *   GET  /api/link/:friendCode          { state, slot?, friendPluggedIn, saveWaiting, error? }
 *                                       (saveWaiting: the romHash of your save
 *                                       waiting to be picked up, or null)
 *   POST /api/link/:friendCode/plug     { romHash, sram?, state?, ask? } plug in the cable
 *                                       with a game from your cloud library, your
 *                                       save (base64) and where the game is (a
 *                                       snapshot: mGBA's own, zlib, base64), so
 *                                       it carries on from there; linked once
 *                                       both have. With ask, it also asks the
 *                                       friend to plug in (a link request, see
 *                                       SocialDO), and answers its requestId
 *   GET  /api/link/:friendCode/ws       WebSocket for your screen while linked
 *   POST /api/link/:friendCode/unplug   ends the link: { sram, state?, romHash } is your
 *                                       save from it and where the game was left
 *                                       (as plug takes it), or { ended } if there
 *                                       was none (not started, failed, or { saveLost })
 *   GET  /api/link/:friendCode/save     { sram, state?, romHash } after your friend ended
 *                                       it (or it timed out), once; saveWaiting says so
 *
 * States: empty, waiting (one plugged in), starting, linked, ending, failed
 * (error says why; the next plug or unplug clears it).
 *
 * Plugging in needs the friend online with a game that links with yours open
 * in one of their tabs (canLink, with both game codes read from the ROMs), or 409
 * friend_not_in_game / games_cannot_link. Asking also needs them looking at
 * the game and not on the cable with someone else, or 409 friend_offline /
 * friend_not_looking / friend_linked. Picking up your save from your last
 * link with them, in this game, is always allowed (and asks nobody).
 * For now (deploy window, see plugRefusal), a plain plug to a friend with
 * no presence at all is also let through.
 * Unplugging cancels a request still waiting for an answer.
 */

const METHODS: Record<string, string> = { "": "GET", plug: "POST", ws: "GET", unplug: "POST", save: "GET" };

type LinkRoomStatus = {
  state?: string;
  players?: { playerId: string; slot: number }[];
  savesWaiting?: { playerId: string; romHash: string }[];
  error?: string;
};

export async function handleLink(request: Request, env: Env, url: URL, playerId: string, ctx: ExecutionContext): Promise<Response> {
  if (url.pathname === "/api/link") {
    if (request.method !== "GET") return methodNotAllowed();
    const romHash = url.searchParams.get("romHash");
    if (!romHash || !HASH_PATTERN.test(romHash)) return json({ error: "invalid_rom_hash" }, 400);
    if (!env.LINK) return json({ error: "link_unavailable" }, 503);
    return json({ friends: await linkFriends(env, env.LINK, playerId, romHash) } satisfies LinkFriendsResponse);
  }
  const match = /^\/api\/link\/([^/]+)(?:\/([a-z]+))?$/.exec(url.pathname);
  const action = match?.[2] ?? "";
  if (!match || !(action in METHODS)) return json({ error: "not_found" }, 404);
  if (request.method !== METHODS[action]) return methodNotAllowed();
  const code = normalizeFriendCode(decodeURIComponent(match[1]!));
  if (!code) return json({ error: "invalid_code" }, 400);
  // Worker Previews have no link server.
  if (!env.LINK) return json({ error: "link_unavailable" }, 503);

  const friendId = await socialStub(env).friendIdByCode(playerId, code);
  if (!friendId) return json({ error: "not_friends" }, 404);
  const room = `https://link/rooms/${roomName(playerId, friendId)}`;
  const headers = { "X-Player-Id": playerId };

  switch (action) {
    case "ws":
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "websocket_required" }, 426);
      // Where the player connects from goes in the link server's logs, to tell distance from other lag.
      return env.LINK.fetch(
        new Request(`${room}/ws`, { headers: { ...headers, Upgrade: "websocket", "X-Client-Colo": String(request.cf?.colo ?? "") } }),
      );
    case "plug": {
      const read = await readPlug(request);
      if ("error" in read) return json({ error: read.error }, 400);
      // `ask` is for this Worker only; the link server gets the rest.
      const { ask: asking, ...plug } = read;
      // One line per plug: what was sent and what the link server made of it (ids shortened).
      const logged = {
        message: "link plug request",
        player: playerId.slice(0, 8),
        friend: friendId.slice(0, 8),
        romHash: plug.romHash.slice(0, 8),
        stateSent: plug.state !== undefined,
        stateBytes: base64Bytes(plug.state),
        sramSent: plug.sram !== undefined,
        sramBytes: base64Bytes(plug.sram),
        ask: asking ?? false,
      };
      // The link server loads each player's own copy; nobody's ROM goes to anyone else.
      const mine = await romGame(env, playerId, plug.romHash);
      if (!mine) {
        console.log(JSON.stringify({ ...logged, gameCode: null, error: "rom_not_in_library" }));
        return json({ error: "rom_not_in_library" }, 409);
      }
      const social = socialStub(env);
      let ask = asking ?? false;
      const refusal = await plugRefusal(env, env.LINK, playerId, friendId, mine, ask);
      if (refusal) {
        if (!(await saveWaitingIn(env.LINK, playerId, friendId, plug.romHash))) {
          console.log(JSON.stringify({ ...logged, gameCode: mine.gameCode ?? null, refusal, error: refusal }));
          return json({ error: refusal }, 409);
        }
        // Picking up the save from your last link: always allowed, and nobody is asked.
        ask = false;
      }
      const response = await env.LINK.fetch(`${room}/plug`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(plug),
      });
      if (response.ok) track(ctx, env, (stats) => stats.linkPlugged(playerId));
      // Whatever the answer, the room may now hold a seat or a save: the Link panel keeps asking about it.
      await social.noteLinkRoom(playerId, friendId);
      const seen = view(await response.json<LinkRoomStatus>(), playerId, friendId);
      console.log(
        JSON.stringify({
          ...logged,
          gameCode: mine.gameCode ?? null,
          ...(refusal ? { refusal } : {}),
          linkStatus: response.status,
          // Not saveWaiting: it's a full ROM hash.
          link: "error" in seen ? { error: seen.error } : { state: seen.state, slot: seen.slot, friendPluggedIn: seen.friendPluggedIn },
        }),
      );
      if (!response.ok || "error" in seen) return json(seen, response.status);
      // The friend was already waiting: the link starts, nobody needs asking.
      const asked = ask && seen.state === "waiting" && !seen.friendPluggedIn;
      const requestId = await social.linkPlugged(playerId, friendId, asked ? mine : null);
      return json({ ...seen, ...(requestId ? { requestId } : {}) } satisfies PlugResponse, response.status);
    }
    case "": {
      const response = await env.LINK.fetch(room, { headers });
      return json(view(await response.json<LinkRoomStatus>(), playerId, friendId), response.status);
    }
    default: {
      // Not waiting any more: a request still open is cancelled.
      if (action === "unplug") await socialStub(env).cancelLinkRequest(playerId, friendId);
      // unplug and save answer { sram }, { ended } or { error } as they are.
      const response = await env.LINK.fetch(`${room}/${action}`, { method: request.method, headers });
      return json(await response.json(), response.status);
    }
  }
}

const NO_ROOM: LinkStatus = { state: "empty", friendPluggedIn: false, saveWaiting: null };

/**
 * The Link panel's list. The link server is only asked about the rooms of
 * friends who can link now and of rooms that may hold something (someone
 * plugged in, or a save waiting); every other room is empty.
 *
 * Your game's code comes from your own presence. If none of your tabs has
 * said yet that this game is open (the heartbeat goes out when it opens, so
 * only for a moment), the game is matched by its ROM hash alone: nobody shows
 * as can_link just because the game code is unknown.
 */
async function linkFriends(env: Env, link: Fetcher, playerId: string, romHash: string): Promise<LinkFriend[]> {
  const social = socialStub(env);
  const { gameCode, friends } = await social.linkCandidates(playerId, romHash);
  const mine: LinkGame = { romHash, gameCode };
  const askedAt = Date.now();
  const seenEmpty: string[] = [];
  const list = await Promise.all(
    friends.map(async ({ playerId: friendId, profile, presence, roomUsed }): Promise<LinkFriend> => {
      const availability = availabilityOf(mine, presence);
      let status = NO_ROOM;
      if (availability === "can_link" || roomUsed) {
        const room = await roomStatus(link, playerId, friendId);
        if (room) {
          const seen = view(room, playerId, friendId);
          if (!("error" in seen)) status = seen;
          const empty = room.state === "empty" && !room.players?.length && !room.savesWaiting?.length;
          if (empty && roomUsed) seenEmpty.push(friendId);
        }
      }
      return {
        friend: profile,
        availability,
        ...(availability === "other_game" && presence.status === "playing" ? { playing: presence.game.name } : {}),
        link: status,
      };
    }),
  );
  if (seenEmpty.length) await social.forgetLinkRooms(playerId, seenEmpty, askedAt);
  return list;
}

function availabilityOf(mine: LinkGame, presence: RawPresence): LinkAvailability {
  if (presence.status !== "playing") return presence.status;
  return canLink(mine, presence.game) ? "can_link" : "other_game";
}

/**
 * The game in the player's cloud library, with the game code read from its
 * header (bytes 0xAC-0xAF; a ranged read, not the whole ROM). Null if the
 * ROM isn't there. No game code if those bytes aren't one (GB/GBC games).
 */
async function romGame(env: Env, playerId: string, romHash: string): Promise<LinkGame | null> {
  const object = await env.ROMS.get(`roms/${playerId}/${romHash}`, { range: { offset: 0xac, length: 4 } });
  if (!object) return null;
  const gameCode = new TextDecoder().decode(await object.arrayBuffer());
  return GAME_CODE_PATTERN.test(gameCode) ? { romHash, gameCode } : { romHash };
}

/**
 * Why the player can't plug in with the friend now, or null if they can: the
 * friend must be online in a game that links with the player's (game codes
 * from both ROMs, not from heartbeats). Asking also needs the friend looking
 * at the game and not on the cable with anyone else.
 */
async function plugRefusal(env: Env, link: Fetcher, playerId: string, friendId: string, mine: LinkGame, ask: boolean): Promise<string | null> {
  const target = await socialStub(env).linkTarget(playerId, friendId);
  // Deploy window: a browser that loaded the app before presence heartbeats
  // existed sends none, so its player has no tabs here. A plain plug to them
  // is let through unchecked, as before the guard. Asks keep the full guard.
  // Remove once those browsers have reloaded (a few days after the deploy).
  if (!ask && !target.online) return null;
  if (ask && !target.online) return "friend_offline";
  if (target.games.length === 0) return "friend_not_in_game";
  // Each game open in one of their tabs (usually one), with its code read from their copy.
  const linkable = new Map<string, boolean>();
  for (const { game } of target.games) {
    if (linkable.has(game.romHash)) continue;
    const theirs = game.romHash === mine.romHash ? mine : ((await romGame(env, friendId, game.romHash)) ?? { romHash: game.romHash });
    linkable.set(game.romHash, canLink(mine, theirs));
  }
  const tabs = target.games.filter(({ game }) => linkable.get(game.romHash));
  if (tabs.length === 0) return "games_cannot_link";
  if (!ask) return null;
  if (tabs.every((tab) => tab.hidden)) return "friend_not_looking";
  const rooms = await Promise.all(target.otherRooms.map((other) => roomStatus(link, friendId, other)));
  if (rooms.some((room) => room?.players?.some((p) => p.playerId === friendId))) return "friend_linked";
  return null;
}

/** Whether the player's save from their last link with the friend is waiting, for this game. */
async function saveWaitingIn(link: Fetcher, playerId: string, friendId: string, romHash: string): Promise<boolean> {
  const room = await roomStatus(link, playerId, friendId);
  return room?.savesWaiting?.some((save) => save.playerId === playerId && save.romHash === romHash) ?? false;
}

/** The room's status from the link server, or null if it couldn't say. */
async function roomStatus(link: Fetcher, playerId: string, friendId: string): Promise<LinkRoomStatus | null> {
  try {
    const response = await link.fetch(`https://link/rooms/${roomName(playerId, friendId)}`, { headers: { "X-Player-Id": playerId } });
    return await response.json<LinkRoomStatus>();
  } catch (err) {
    console.error(JSON.stringify({ message: "link room status failed", error: String(err) }));
    return null;
  }
}

/** One room per pair of friends, the same whoever asks. */
export function roomName(a: string, b: string): string {
  return a < b ? `pair:${a}:${b}` : `pair:${b}:${a}`;
}

/** The room as this player sees it: their own slot, not their friend's id. */
function view(status: LinkRoomStatus, playerId: string, friendId: string): LinkStatus | { error: string } {
  if (!status.state) return { error: status.error ?? "link_error" };
  const players = status.players ?? [];
  const slot = players.find((p) => p.playerId === playerId)?.slot;
  return {
    state: status.state as LinkState,
    ...(slot !== undefined ? { slot } : {}),
    friendPluggedIn: players.some((p) => p.playerId === friendId),
    saveWaiting: (status.savesWaiting ?? []).find((s) => s.playerId === playerId)?.romHash ?? null,
    ...(status.error ? { error: status.error } : {}),
  };
}

type Plug = { romHash: string; sram?: string; state?: string };

async function readPlug(request: Request): Promise<(Plug & { ask?: boolean }) | { error: string }> {
  // A 128 KiB save is about 175 KB of base64, a snapshot at most 1.4 MB.
  const bytes = await readLimited(request, 2 * 1024 * 1024);
  if (!bytes) return { error: "invalid_body" };
  let body: { romHash?: unknown; sram?: unknown; state?: unknown; ask?: unknown };
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { error: "invalid_body" };
  }
  if (typeof body.romHash !== "string" || !HASH_PATTERN.test(body.romHash)) return { error: "invalid_rom_hash" };
  if (body.ask !== undefined && typeof body.ask !== "boolean") return { error: "invalid_body" };
  const plug: Plug & { ask?: boolean } = { romHash: body.romHash, ...(body.ask ? { ask: true } : {}) };
  if (body.sram !== undefined) {
    if (!fitsBase64(body.sram, MAX_SRAM_BYTES)) return { error: "invalid_sram" };
    plug.sram = body.sram;
  }
  if (body.state !== undefined) {
    if (!fitsBase64(body.state, MAX_LINK_STATE_BYTES)) return { error: "invalid_state" };
    plug.state = body.state;
  }
  return plug;
}

/** How many bytes a base64 string holds, without decoding it (0 for none). */
function base64Bytes(value: string | undefined): number {
  if (!value) return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

function fitsBase64(value: unknown, maxBytes: number): value is string {
  if (typeof value !== "string") return false;
  try {
    return base64ToBytes(value).length <= maxBytes;
  } catch {
    return false;
  }
}
