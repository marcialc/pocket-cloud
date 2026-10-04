/**
 * Which two games can share a link cable. A lookup, not a guess: the same
 * answer every time, so the server can check it at plug-in and tests can pin it.
 *
 * A GBA header game code has 4 characters: the first three name the game
 * (`BPE` = Emerald), the last one is the region (`E` US, `P` Europe, `J` Japan).
 */

/** One side of a link: the ROM file's hash and its GBA header game code, if it has one. */
export type LinkGame = { romHash: string; gameCode?: string | null };

/**
 * Games that link with each other, by the first three characters of the game
 * code, in any region or revision. Many GBA games use a different link
 * protocol per region, so only games listed here link across regions; any
 * other game needs the same ROM.
 *
 * Check each entry against No-Intro data before adding it.
 */
const LINK_FAMILIES: readonly (readonly string[])[] = [
  // Gen 3 Pokémon: Ruby, Sapphire, Emerald, FireRed, LeafGreen.
  ["AXV", "AXP", "BPE", "BPR", "BPG"],
];

const FAMILY_BY_GAME = new Map(LINK_FAMILIES.flatMap((family, i) => family.map((game) => [game, i] as const)));

/**
 * True when the two games can link:
 *
 * 1. the same ROM file (whether or not the game has a link mode), or
 * 2. both games are in the same LINK_FAMILIES entry.
 */
export function canLink(a: LinkGame, b: LinkGame): boolean {
  if (a.romHash === b.romHash) return true;
  const familyA = familyOf(a.gameCode);
  return familyA !== undefined && familyA === familyOf(b.gameCode);
}

function familyOf(gameCode: string | null | undefined): number | undefined {
  return gameCode && gameCode.length === 4 ? FAMILY_BY_GAME.get(gameCode.slice(0, 3)) : undefined;
}
