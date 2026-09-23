import { HASH_PATTERN } from "./api";

/**
 * How the player organizes their game library: favorite games (listed first)
 * and named groups. Games are referenced by ROM hash, so this follows the
 * account to other devices whether or not they have the ROM yet.
 */
export type ShelfGroup = { id: string; name: string; roms: string[] };
export type Shelf = { favorites: string[]; groups: ShelfGroup[] };

export const EMPTY_SHELF: Shelf = { favorites: [], groups: [] };

/** Games in the favorites list, or in any one group. */
export const MAX_LIST_GAMES = 500;
export const MAX_GROUPS = 50;
export const MAX_GROUP_NAME = 40;
/**
 * The whole shelf as JSON (about 67 bytes per game in a list). The server's
 * settings request limit leaves room for this plus the controls, and the client
 * helpers refuse changes past it, so the server never has to turn a shelf away.
 */
export const MAX_SHELF_BYTES = 48 * 1024;
const ID_PATTERN = /^[a-z0-9-]{1,36}$/;
/** Values the start screen already uses for its own filters. */
const RESERVED_IDS = new Set(["all", "favorites"]);

function isHashList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_LIST_GAMES &&
    value.every((h) => typeof h === "string" && HASH_PATTERN.test(h)) &&
    new Set(value).size === value.length
  );
}

export function shelfBytes(shelf: Shelf): number {
  return new TextEncoder().encode(JSON.stringify(shelf)).length;
}

/** Structural check for a stored shelf. */
export function isShelf(value: unknown): value is Shelf {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { favorites, groups } = value as Record<string, unknown>;
  return (
    isHashList(favorites) &&
    Array.isArray(groups) &&
    groups.length <= MAX_GROUPS &&
    groups.every(
      (g) =>
        typeof g === "object" &&
        g !== null &&
        typeof g.id === "string" &&
        ID_PATTERN.test(g.id) &&
        !RESERVED_IDS.has(g.id) &&
        typeof g.name === "string" &&
        g.name.trim().length > 0 &&
        g.name.length <= MAX_GROUP_NAME &&
        isHashList(g.roms),
    ) &&
    new Set(groups.map((g: ShelfGroup) => g.id)).size === groups.length &&
    shelfBytes(value as Shelf) <= MAX_SHELF_BYTES
  );
}

/** The change, or the shelf unchanged if the result wouldn't be a valid shelf (e.g. it's full). */
function checked(shelf: Shelf, next: Shelf): Shelf {
  return isShelf(next) ? next : shelf;
}

/** A usable shelf from whatever was stored (bad data becomes an empty shelf). */
export function sanitizeShelf(value: unknown): Shelf {
  return isShelf(value) ? value : EMPTY_SHELF;
}

export function isFavorite(shelf: Shelf, romHash: string): boolean {
  return shelf.favorites.includes(romHash);
}

export function toggleFavorite(shelf: Shelf, romHash: string): Shelf {
  return isFavorite(shelf, romHash)
    ? { ...shelf, favorites: shelf.favorites.filter((h) => h !== romHash) }
    : checked(shelf, { ...shelf, favorites: [...shelf.favorites, romHash] });
}

export function cleanGroupName(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, MAX_GROUP_NAME);
}

/** Adds a group (with these games in it). Returns the shelf unchanged if the name is blank or the shelf is full. */
export function addGroup(shelf: Shelf, name: string, id: string, roms: string[] = []): Shelf {
  return checked(shelf, { ...shelf, groups: [...shelf.groups, { id, name: cleanGroupName(name), roms }] });
}

export function renameGroup(shelf: Shelf, id: string, name: string): Shelf {
  const clean = cleanGroupName(name);
  return checked(shelf, { ...shelf, groups: shelf.groups.map((g) => (g.id === id ? { ...g, name: clean } : g)) });
}

/** Deletes the group only; its games stay in the library. */
export function removeGroup(shelf: Shelf, id: string): Shelf {
  return { ...shelf, groups: shelf.groups.filter((g) => g.id !== id) };
}

/** Puts a game in exactly the groups listed in `ids` (or leaves the shelf unchanged if that doesn't fit). */
export function setGameGroups(shelf: Shelf, romHash: string, ids: ReadonlySet<string>): Shelf {
  return checked(shelf, {
    ...shelf,
    groups: shelf.groups.map((g) => {
      const has = g.roms.includes(romHash);
      if (ids.has(g.id) === has) return g;
      return { ...g, roms: has ? g.roms.filter((h) => h !== romHash) : [...g.roms, romHash] };
    }),
  });
}

/** The game left the library for good: drop it from favorites and groups. */
export function forgetGame(shelf: Shelf, romHash: string): Shelf {
  if (!isFavorite(shelf, romHash) && !shelf.groups.some((g) => g.roms.includes(romHash))) return shelf;
  return {
    favorites: shelf.favorites.filter((h) => h !== romHash),
    groups: shelf.groups.map((g) => ({ ...g, roms: g.roms.filter((h) => h !== romHash) })),
  };
}

export function sameShelf(a: Shelf, b: Shelf): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
