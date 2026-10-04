import { unzlibSync, zlibSync } from "fflate";
import { base64ToBytes, bytesToBase64 } from "../../shared/api";
import type { LinkFriend, LinkFriendsResponse, LinkStatus, PlugResponse } from "../../shared/link";

/**
 * GBA link play with a friend (/api/link, see src/worker/link.ts). Needs the
 * email session cookie, which the browser sends on its own.
 */

export type { LinkState, LinkStatus } from "../../shared/link";

/**
 * What a link left, for the game it was played in: the save (null if the game
 * never saved during it) and where the game was left (the core's own
 * snapshot, null if the link server couldn't take one).
 */
export type LinkSave = { sram: Uint8Array | null; state: Uint8Array | null; romHash: string };

/** The server refused, with its error code ("network" if it couldn't be reached). */
export class LinkError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

async function call(path: string, init: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`/api/link${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init.headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new LinkError("network");
  }
  if (!res.ok) {
    const body: { error?: string } = await res.json().catch(() => ({}));
    throw new LinkError(body.error ?? `http_${res.status}`);
  }
  return res;
}

const room = (friendCode: string) => `/${encodeURIComponent(friendCode)}`;

/**
 * Every friend with whether they can link with the game open now (its
 * romHash), and their link room as you see it. One request for the whole
 * Link panel.
 */
export async function fetchLinkFriends(romHash: string): Promise<LinkFriend[]> {
  const body: LinkFriendsResponse = await (await call(`?romHash=${encodeURIComponent(romHash)}`)).json();
  return body.friends;
}

export async function fetchLinkStatus(friendCode: string): Promise<LinkStatus> {
  return (await call(room(friendCode))).json();
}

/**
 * Plug in the cable with this game, its save and where it is (the core's own
 * snapshot, so the link carries on from there; without one the game powers on
 * from the save). When the friend is already plugged in, this starts the link
 * and answers once both games run, which takes a few seconds. With `ask`, the
 * friend is asked to plug in too (requestId says which request; their answer
 * comes with the heartbeat).
 */
export async function plugIn(
  friendCode: string,
  romHash: string,
  sram: Uint8Array | null,
  state: Uint8Array | null = null,
  ask = false,
): Promise<PlugResponse> {
  const body = {
    romHash,
    ...(ask ? { ask: true } : {}),
    ...(sram ? { sram: bytesToBase64(sram) } : {}),
    // mGBA's snapshot is about 400 KB, mostly zeros and repeats.
    ...(state ? { state: bytesToBase64(zlibSync(state)) } : {}),
  };
  return (await call(`${room(friendCode)}/plug`, { method: "POST", body: JSON.stringify(body) }, 60_000)).json();
}

/**
 * Pull the cable, ending the link for both. `save` is what it left: null when
 * the link hadn't started or had failed, and then the save you plugged in
 * with still stands. `lost` says the link server couldn't hand the saves back.
 */
export async function unplug(friendCode: string): Promise<{ save: LinkSave | null; lost: boolean }> {
  const res = await call(`${room(friendCode)}/unplug`, { method: "POST" }, 30_000);
  const body: LinkSaveBody & { saveLost?: boolean } = await res.json();
  return { save: toSave(body), lost: body.saveLost === true };
}

/** Your save from a link your friend ended (or that timed out), or null if there's none. */
export async function takeLinkSave(friendCode: string): Promise<LinkSave | null> {
  try {
    return toSave(await (await call(`${room(friendCode)}/save`)).json());
  } catch (err) {
    if (err instanceof LinkError && err.code === "not_found") return null;
    throw err;
  }
}

export function linkSocketUrl(friendCode: string): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/link${room(friendCode)}/ws`;
}

type LinkSaveBody = { sram?: string; state?: string; romHash?: string };

/**
 * An empty or blank save (every byte 0x00 or 0xFF, the fresh cartridge the
 * link server starts with) means the game never saved during the link:
 * nothing to keep, like the emulator's own getSram(). A snapshot that doesn't
 * unpack is dropped: the game then carries on from the save alone.
 */
function toSave(body: LinkSaveBody): LinkSave | null {
  if (!body.romHash) return null;
  let sram: Uint8Array | null = body.sram ? base64ToBytes(body.sram) : null;
  const first = sram?.[0];
  if (sram && (first === 0x00 || first === 0xff) && sram.every((b) => b === first)) sram = null;
  let state: Uint8Array | null = null;
  try {
    state = body.state ? unzlibSync(base64ToBytes(body.state)) : null;
  } catch (err) {
    console.warn("The link's snapshot didn't unpack", err);
  }
  return sram || state ? { sram, state, romHash: body.romHash } : null;
}

export function linkErrorMessage(err: unknown): string {
  switch (err instanceof LinkError ? err.code : typeof err === "string" ? err : "unknown") {
    case "rom_not_in_library":
      return "Add this game to your cloud library first, so the link can load your copy.";
    case "not_friends":
      return "You can only link with friends.";
    case "room_full":
      return "Your friend is already linked with someone else.";
    case "collect_save_first":
      return "There’s a save from your last link with this friend to pick up first. Open the game it was played in.";
    case "busy":
      return "The link is starting or ending. Try again in a moment.";
    case "link_unavailable":
      return "Linking isn’t available here.";
    case "friend_offline":
      return "Your friend is offline.";
    case "friend_not_in_game":
      return "Your friend isn’t in a game right now.";
    case "games_cannot_link":
      return "Your friend’s game can’t link with this one. Linking needs the same game file, or two of Pokémon Ruby, Sapphire, Emerald, FireRed and LeafGreen.";
    case "friend_not_looking":
      return "Your friend isn’t looking at the game right now.";
    case "friend_linked":
      return "Your friend is already on the cable with someone else.";
    case "rom_missing":
      return "One of the games isn’t in its player’s cloud library any more.";
    case "link_lost":
      return "The link stopped unexpectedly. Your save from before the link is kept.";
    case "start_timeout":
    case "container_timeout":
    case "start_failed":
      return "The link couldn’t start. Try again.";
    case "network":
      return "Can’t reach the server. Check your connection.";
    default:
      return "Something went wrong with the link. Try again.";
  }
}
