import {
  ADMIN_STATS_DAYS,
  MAX_ADMIN_PLAYERS,
  type AdminPlayer,
  type AdminStatsResponse,
} from "../shared/admin";
import { json, methodNotAllowed } from "./http";
import { socialStub } from "./social";
import { statsStub } from "./stats";

/**
 * Read-only admin dashboard data (email sign-in, admins only):
 *
 *   GET /api/admin/stats?days=7|30|90   see AdminStatsResponse
 *
 * Admins are the player ids listed in the ADMIN_PLAYER_IDS Worker secret
 * (comma separated). Anyone else signed in gets 403 with their own player id,
 * so whoever runs the site can find the id to add.
 */
export async function handleAdmin(request: Request, env: Env, url: URL, playerId: string): Promise<Response> {
  if (!isAdmin(env, playerId)) return json({ error: "not_admin", playerId }, 403);
  if (url.pathname !== "/api/admin/stats") return json({ error: "not_found" }, 404);
  if (request.method !== "GET") return methodNotAllowed();
  const days = Number(url.searchParams.get("days") ?? 30);
  if (!(ADMIN_STATS_DAYS as readonly number[]).includes(days)) return json({ error: "invalid_days" }, 400);
  return json(await adminStats(env, days));
}

export function isAdmin(env: Env, playerId: string): boolean {
  const ids = (env.ADMIN_PLAYER_IDS ?? "").split(",").map((id) => id.trim().toLowerCase());
  return ids.includes(playerId);
}

async function adminStats(env: Env, days: number): Promise<AdminStatsResponse> {
  const [report, social, storage] = await Promise.all([
    statsStub(env).report(days, MAX_ADMIN_PLAYERS),
    socialStub(env).adminSummary(),
    bucketUsage(env),
  ]);

  // Everyone the StatsDO has seen, plus players known only by a profile or ROMs from before tracking began.
  const players = new Map<string, AdminPlayer>();
  const blank = (playerId: string): AdminPlayer => ({
    playerId,
    name: null,
    kind: null,
    firstSeen: null,
    lastSeen: null,
    signedUpAt: null,
    savesSynced: 0,
    linkPlugs: 0,
    roms: 0,
    romBytes: 0,
  });
  for (const row of report.players) {
    players.set(row.player_id, {
      ...blank(row.player_id),
      kind: row.kind,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      signedUpAt: row.signed_up_at,
      savesSynced: row.saves_synced,
      linkPlugs: row.link_plugs,
    });
  }
  for (const profile of social.profiles) {
    const player = players.get(profile.playerId) ?? blank(profile.playerId);
    player.name = profile.name;
    player.firstSeen ??= profile.createdAt;
    players.set(profile.playerId, player);
  }
  for (const [playerId, usage] of storage.perPlayer) {
    const player = players.get(playerId) ?? blank(playerId);
    player.roms = usage.roms;
    player.romBytes = usage.bytes;
    players.set(playerId, player);
  }
  const list = [...players.values()].sort(
    (a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0) || (b.firstSeen ?? 0) - (a.firstSeen ?? 0),
  );

  return {
    generatedAt: Date.now(),
    trackingSince: report.trackingSince,
    totals: report.totals,
    daily: report.daily,
    platforms: report.platforms,
    games: report.games,
    social: {
      profiles: social.profiles.length,
      friendships: social.friendships,
      pendingRequests: social.pendingRequests,
      scores: social.scores,
    },
    storage: {
      roms: storage.roms,
      romBytes: storage.romBytes,
      covers: storage.covers,
      coverBytes: storage.coverBytes,
      playersWithRoms: storage.perPlayer.size,
      truncated: storage.truncated,
    },
    players: list.slice(0, MAX_ADMIN_PLAYERS),
    playerCount: list.length,
  };
}

/** Listing pages read per prefix (1,000 objects each) before giving up. */
const MAX_LIST_PAGES = 20;

async function bucketUsage(env: Env) {
  const perPlayer = new Map<string, { roms: number; bytes: number }>();
  let truncated = false;
  const walk = async (prefix: string, each: (key: string, size: number) => void) => {
    let cursor: string | undefined;
    let total = 0;
    let bytes = 0;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = await env.ROMS.list({ prefix, ...(cursor ? { cursor } : {}) });
      for (const object of result.objects) {
        total++;
        bytes += object.size;
        each(object.key.slice(prefix.length), object.size);
      }
      cursor = result.truncated ? result.cursor : undefined;
      if (!cursor) return { total, bytes };
    }
    truncated = true;
    return { total, bytes };
  };
  const [roms, covers] = await Promise.all([
    walk("roms/", (key, size) => {
      const playerId = key.split("/")[0]!;
      const usage = perPlayer.get(playerId) ?? { roms: 0, bytes: 0 };
      usage.roms++;
      usage.bytes += size;
      perPlayer.set(playerId, usage);
    }),
    walk("covers/", () => {}),
  ]);
  return { roms: roms.total, romBytes: roms.bytes, covers: covers.total, coverBytes: covers.bytes, perPlayer, truncated };
}
