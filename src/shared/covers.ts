/**
 * Box art for the library cards, from libretro's thumbnail server
 * (thumbnails.libretro.com/<system>/Named_Boxarts/<No-Intro name>.png). The
 * browser asks the Worker (/api/covers/:platform/:name.png), which fetches and
 * caches the image, so libretro never sees who has which game.
 *
 * public/covers.json (scripts/update-covers.mjs) maps a ROM's SHA-1 to its
 * No-Intro name.
 */

export type CoverPlatform = "gb" | "gbc" | "gba";

export const COVER_SYSTEMS: Record<CoverPlatform, string> = {
  gb: "Nintendo - Game Boy",
  gbc: "Nintendo - Game Boy Color",
  gba: "Nintendo - Game Boy Advance",
};

export function isCoverPlatform(value: string): value is CoverPlatform {
  return Object.hasOwn(COVER_SYSTEMS, value);
}

/** Longest thumbnail name the Worker asks libretro for (No-Intro names are well under this). */
export const MAX_COVER_NAME = 200;

/** A No-Intro name as libretro files its thumbnail: these characters become "_". */
export function thumbnailName(name: string): string {
  return name.replace(/[&*/:`<>?\\|"]/g, "_");
}

/** A thumbnail name the Worker will look up: no path separators or control characters. */
export function isCoverName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_COVER_NAME && !/[/\\\p{C}]/u.test(name) && name !== "." && name !== "..";
}

/** Where the app loads a game's box art. */
export function coverUrl(platform: CoverPlatform, name: string): string {
  return `/api/covers/${platform}/${encodeURIComponent(thumbnailName(name))}.png`;
}
