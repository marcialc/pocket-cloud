import { base64ToBytes, bytesToBase64 } from "../../shared/api";

/**
 * GBA link play with a friend (/api/link, see src/worker/link.ts). Needs the
 * email session cookie, which the browser sends on its own.
 */

export type LinkState = "empty" | "waiting" | "starting" | "linked" | "ending" | "failed";

export type LinkStatus = {
  state: LinkState;
  /** Your place on the cable, once plugged in (1 or 2). */
  slot?: number;
  friendPluggedIn: boolean;
  /** The romHash of your save from a link that ended, still to be picked up. */
  saveWaiting: string | null;
  /** Why a link failed. */
  error?: string;
};

/** A save from a link, for the game it was played in. */
export type LinkSave = { sram: Uint8Array; romHash: string };

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

export async function fetchLinkStatus(friendCode: string): Promise<LinkStatus> {
  return (await call(room(friendCode))).json();
}

/**
 * Plug in the cable with this game and its save. When the friend is already
 * plugged in, this starts the link and answers once both games run, which
 * takes a few seconds.
 */
export async function plugIn(friendCode: string, romHash: string, sram: Uint8Array | null): Promise<LinkStatus> {
  const body = { romHash, ...(sram ? { sram: bytesToBase64(sram) } : {}) };
  return (await call(`${room(friendCode)}/plug`, { method: "POST", body: JSON.stringify(body) }, 60_000)).json();
}

/**
 * Pull the cable, ending the link for both. `save` is your save from it:
 * null when the game made none (or the link hadn't started or had failed),
 * and then the save you plugged in with still stands. `lost` says the link
 * server couldn't hand the saves back.
 */
export async function unplug(friendCode: string): Promise<{ save: LinkSave | null; lost: boolean }> {
  const res = await call(`${room(friendCode)}/unplug`, { method: "POST" }, 30_000);
  const body: { sram?: string; romHash?: string; saveLost?: boolean } = await res.json();
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

/**
 * An empty or blank save (every byte 0x00 or 0xFF, the fresh cartridge the
 * link server starts with) means the game never saved during the link:
 * nothing to keep, like the emulator's own getSram().
 */
function toSave(body: { sram?: string; romHash?: string }): LinkSave | null {
  if (!body.sram || !body.romHash) return null;
  const sram = base64ToBytes(body.sram);
  const first = sram[0];
  if ((first === 0x00 || first === 0xff) && sram.every((b) => b === first)) return null;
  return { sram, romHash: body.romHash };
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
