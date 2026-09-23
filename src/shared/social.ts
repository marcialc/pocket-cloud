/**
 * Friends and leaderboards: wire types and the score rules shared by the
 * browser client and the Worker.
 *
 * ROM files are never shared between accounts. A leaderboard is keyed by the
 * ROM's SHA-256, so two friends land on the same board when they each load
 * the same file.
 */

import { CODE_ALPHABET, CODE_LENGTH } from "./auth";

/**
 * What a board ranks (higher is better on every board).
 *
 *   playtime  ms played, taken from the play time uploaded with each save
 *   pokedex   Pokémon caught, read from the uploaded save (Red/Blue)
 *   tetris    best score seen while playing, reported by the browser
 */
export type BoardId = "playtime" | "pokedex" | "tetris";

export const BOARDS: Record<BoardId, { label: string; unit: "ms" | "count" | "points" }> = {
  playtime: { label: "Play time", unit: "ms" },
  pokedex: { label: "Pokédex caught", unit: "count" },
  tetris: { label: "High score", unit: "points" },
};

/** Boards the browser reports itself (the others are worked out from uploaded saves). */
export const CLIENT_BOARDS: readonly BoardId[] = ["tetris"];

export function isBoardId(value: unknown): value is BoardId {
  return typeof value === "string" && Object.hasOwn(BOARDS, value);
}

export type Profile = { name: string; friendCode: string };

/**
 * Your own profile. The invite token makes your invite link: whoever opens it
 * can add you straight away, so it's only shown to you and can be reset.
 */
export type MyProfile = Profile & { inviteToken: string };

export type ProfileResponse = { profile: MyProfile | null };

export const INVITE_TOKEN_PATTERN = /^[0-9a-f]{24}$/;

/** The page a friend opens to add you (the app reads `?invite=`). */
export function inviteLink(origin: string, token: string): string {
  return `${origin}/?invite=${token}`;
}

/** Who an invite link is from (anyone holding the link may ask). */
export type InviteResponse = { inviter: Profile };

export type AcceptInviteResponse = { friend: Profile };

export type PutProfileRequest = { name: string };

export type FriendsResponse = {
  friends: Profile[];
  /** Asked to be your friend; accept by adding their code. */
  incoming: Profile[];
  /** You asked; waiting for them. */
  outgoing: Profile[];
};

export type AddFriendRequest = { code: string };

/** `friends`: they had already asked you, so you're friends now. `requested`: waiting for them. */
export type AddFriendResponse = { status: "friends" | "requested"; friend: Profile };

export type LeaderboardEntry = Profile & { value: number; updatedAt: number; me: boolean };

export type Leaderboard = { board: BoardId; entries: LeaderboardEntry[] };

export type GameLeaderboards = {
  romHash: string;
  /** Cartridge header title (e.g. "POKEMON RED"). */
  title: string;
  /** How many of you and your friends have played it. */
  players: number;
  boards: Leaderboard[];
};

export type GamesResponse = { games: GameLeaderboards[] };

export type PutScoreRequest = { board: BoardId; value: number; title: string };

/** Friend codes look like sign-in codes: 8 characters without look-alikes, shown as XXXX-XXXX. */
const FRIEND_CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

/** The code in its stored form (no dash, upper case), or null if it can't be one. */
export function normalizeFriendCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.toUpperCase().replace(/[\s-]/g, "");
  return FRIEND_CODE_PATTERN.test(code) ? code : null;
}

export function formatFriendCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export const MAX_NAME_LENGTH = 20;

// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const HIDDEN_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;

/** Display name, trimmed with inner whitespace collapsed; null if empty, too long or has control characters. */
export function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length === 0 || [...name].length > MAX_NAME_LENGTH) return null;
  return HIDDEN_CHARACTERS.test(name) ? null : name;
}

/** A game title shown to friends (cartridge header title): 1-64 characters, no control or direction characters. */
export function isGameTitle(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && !HIDDEN_CHARACTERS.test(value);
}

/** Friends one account can have, and friend requests it can have waiting. */
export const MAX_FRIENDS = 200;
export const MAX_PENDING_REQUESTS = 50;

/** Largest value a client may report for a board it watches (Tetris tops out at 999,999). */
export const MAX_CLIENT_SCORE = 999_999;

/**
 * Pokémon Red/Blue keep the "owned" Pokédex flags (151 bits, #1 in bit 0 of
 * the first byte) at $A5A3 in SRAM bank 1: sGameData starts at $A598, and
 * the 11-byte player name comes before sMainData, which opens with
 * wPokedexOwned (pret/pokered ram/sram.asm, ram/wram.asm). Bank 1 starts
 * 0x2000 bytes into the save file.
 */
const POKEDEX_TITLES = new Set(["POKEMON RED", "POKEMON BLUE"]);
const POKEDEX_OWNED_OFFSET = 0x2000 + 0x598 + 11;
const POKEDEX_SIZE = 151;
const RED_BLUE_SRAM_BYTES = 32 * 1024;

/** Pokémon caught in a Red/Blue save, or null for any other game (or a save that isn't one). */
export function pokedexCaught(title: string, sram: Uint8Array): number | null {
  if (!POKEDEX_TITLES.has(title) || sram.length !== RED_BLUE_SRAM_BYTES) return null;
  let caught = 0;
  for (let i = 0; i < POKEDEX_SIZE; i++) {
    if (sram[POKEDEX_OWNED_OFFSET + (i >> 3)]! & (1 << (i & 7))) caught++;
  }
  return caught;
}
