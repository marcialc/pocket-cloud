import { HASH_PATTERN, MAX_SRAM_BYTES, base64ToBytes } from "../shared/api";
import { normalizeFriendCode } from "../shared/social";
import { json, methodNotAllowed, readLimited } from "./http";
import { socialStub } from "./social";

/**
 * GBA link play between two friends (email sign-in only). Both games run in
 * the pocket-cloud-link Worker's container (link-server/); this checks who
 * is asking and that they're friends, then forwards. Each pair of friends
 * has one room.
 *
 *   GET  /api/link/:friendCode          { state, slot?, friendPluggedIn, saveWaiting, error? }
 *                                       (saveWaiting: the romHash of your save
 *                                       waiting to be picked up, or null)
 *   POST /api/link/:friendCode/plug     { romHash, sram? } plug in the cable with
 *                                       a game from your cloud library and your
 *                                       save (base64); linked once both have
 *   GET  /api/link/:friendCode/ws       WebSocket for your screen while linked
 *   POST /api/link/:friendCode/unplug   ends the link: { sram, romHash } is your save
 *                                       from it, or { ended } if there was none
 *                                       (not started, failed, or { saveLost })
 *   GET  /api/link/:friendCode/save     { sram, romHash } after your friend ended it (or
 *                                       it timed out), once; saveWaiting says so
 *
 * States: empty, waiting (one plugged in), starting, linked, ending, failed
 * (error says why; the next plug or unplug clears it).
 */

const METHODS: Record<string, string> = { "": "GET", plug: "POST", ws: "GET", unplug: "POST", save: "GET" };

type LinkRoomStatus = {
  state?: string;
  players?: { playerId: string; slot: number }[];
  savesWaiting?: { playerId: string; romHash: string }[];
  error?: string;
};

export async function handleLink(request: Request, env: Env, url: URL, playerId: string): Promise<Response> {
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
      const plug = await readPlug(request);
      if ("error" in plug) return json({ error: plug.error }, 400);
      // The link server loads each player's own copy; nobody's ROM goes to anyone else.
      if (!(await env.ROMS.head(`roms/${playerId}/${plug.romHash}`))) return json({ error: "rom_not_in_library" }, 409);
      const response = await env.LINK.fetch(`${room}/plug`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(plug),
      });
      return json(view(await response.json<LinkRoomStatus>(), playerId, friendId), response.status);
    }
    case "": {
      const response = await env.LINK.fetch(room, { headers });
      return json(view(await response.json<LinkRoomStatus>(), playerId, friendId), response.status);
    }
    default: {
      // unplug and save answer { sram }, { ended } or { error } as they are.
      const response = await env.LINK.fetch(`${room}/${action}`, { method: request.method, headers });
      return json(await response.json(), response.status);
    }
  }
}

/** One room per pair of friends, the same whoever asks. */
export function roomName(a: string, b: string): string {
  return a < b ? `pair:${a}:${b}` : `pair:${b}:${a}`;
}

/** The room as this player sees it: their own slot, not their friend's id. */
function view(status: LinkRoomStatus, playerId: string, friendId: string) {
  if (!status.state) return { error: status.error ?? "link_error" };
  const players = status.players ?? [];
  const slot = players.find((p) => p.playerId === playerId)?.slot;
  return {
    state: status.state,
    ...(slot !== undefined ? { slot } : {}),
    friendPluggedIn: players.some((p) => p.playerId === friendId),
    saveWaiting: (status.savesWaiting ?? []).find((s) => s.playerId === playerId)?.romHash ?? null,
    ...(status.error ? { error: status.error } : {}),
  };
}

async function readPlug(request: Request): Promise<{ romHash: string; sram?: string } | { error: string }> {
  // A 128 KiB save is about 175 KB of base64.
  const bytes = await readLimited(request, 256 * 1024);
  if (!bytes) return { error: "invalid_body" };
  let body: { romHash?: unknown; sram?: unknown };
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { error: "invalid_body" };
  }
  if (typeof body.romHash !== "string" || !HASH_PATTERN.test(body.romHash)) return { error: "invalid_rom_hash" };
  if (body.sram === undefined) return { romHash: body.romHash };
  if (typeof body.sram !== "string") return { error: "invalid_sram" };
  try {
    if (base64ToBytes(body.sram).length > MAX_SRAM_BYTES) return { error: "invalid_sram" };
  } catch {
    return { error: "invalid_sram" };
  }
  return { romHash: body.romHash, sram: body.sram };
}
