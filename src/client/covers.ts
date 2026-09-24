import { coverUrl, isCoverPlatform, type CoverPlatform } from "../shared/covers";

/** Lookup built from public/covers.json. */
export type CoverIndex = {
  /** By the first 12 hex digits of the ROM's SHA-1. */
  bySha1: Map<string, [CoverPlatform, string]>;
  /** By No-Intro name, for ROM files that are named that way. */
  byName: Map<string, CoverPlatform>;
};

export function parseCoverIndex(json: unknown): CoverIndex {
  const bySha1 = new Map<string, [CoverPlatform, string]>();
  const byName = new Map<string, CoverPlatform>();
  const games = (json as { games?: unknown } | null)?.games;
  if (typeof games === "object" && games !== null) {
    for (const [sha1, value] of Object.entries(games)) {
      if (!Array.isArray(value) || typeof value[0] !== "string" || typeof value[1] !== "string") continue;
      const [platform, name] = value as [string, string];
      if (!isCoverPlatform(platform)) continue;
      bySha1.set(sha1, [platform, name]);
      byName.set(name, platform);
    }
  }
  return { bySha1, byName };
}

let indexPromise: Promise<CoverIndex> | null = null;

/** Fetched once per page; a failed fetch is retried on the next call. */
export function loadCoverIndex(): Promise<CoverIndex> {
  indexPromise ??= fetch("/covers.json")
    .then((res) => {
      if (!res.ok) throw new Error(`covers.json: HTTP ${res.status}`);
      return res.json();
    })
    .then(parseCoverIndex);
  indexPromise.catch(() => (indexPromise = null));
  return indexPromise;
}

/**
 * Box art URL for a game: by the ROM's SHA-1 when this device has computed it,
 * otherwise by a file name that is the game's No-Intro name. Null if neither matches.
 */
export function coverFor(index: CoverIndex, game: { sha1?: string | undefined; fileName: string }): string | null {
  const known = game.sha1 ? index.bySha1.get(game.sha1.slice(0, 12)) : undefined;
  if (known) return coverUrl(...known);
  const base = game.fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "").trim();
  const platform = index.byName.get(base);
  return platform ? coverUrl(platform, base) : null;
}

export async function sha1Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", data as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
