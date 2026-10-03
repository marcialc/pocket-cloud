/**
 * GET /api/admin/stats: everything the admin page shows. Players are known by
 * their random player id (and display name, if they picked one); emails are
 * never stored, so they never appear here.
 */

/** "account" signed in with email; "anonymous" uses the browser's player key. */
export type PlayerKind = "account" | "anonymous";

export type DailyStats = {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  activePlayers: number;
  signUps: number;
  signIns: number;
  savesSynced: number;
  romUploads: number;
  linkPlugs: number;
};

export type PlatformStats = { platform: string; players: number; saves: number };

export type GameStats = { gameId: string; platform: string; players: number; saves: number; lastSynced: number };

export type AdminPlayer = {
  playerId: string;
  /** Display name for friends and leaderboards, if they picked one. */
  name: string | null;
  /** Null for players seen only through their profile or ROMs (before tracking began). */
  kind: PlayerKind | null;
  firstSeen: number | null;
  lastSeen: number | null;
  signedUpAt: number | null;
  /** Since tracking began. */
  savesSynced: number;
  linkPlugs: number;
  /** In the cloud library now. */
  roms: number;
  romBytes: number;
};

export type AdminStatsResponse = {
  generatedAt: number;
  /** When tracking began (first recorded event), or null if nothing yet. */
  trackingSince: number | null;
  totals: {
    players: number;
    accounts: number;
    anonymous: number;
    active1d: number;
    active7d: number;
    active30d: number;
  };
  /** Oldest first, one row per day of the range, zeros included. */
  daily: DailyStats[];
  platforms: PlatformStats[];
  /** Most players first. */
  games: GameStats[];
  social: { profiles: number; friendships: number; pendingRequests: number; scores: number };
  storage: {
    roms: number;
    romBytes: number;
    covers: number;
    coverBytes: number;
    playersWithRoms: number;
    /** The bucket listing stopped early; the totals are a lower bound. */
    truncated: boolean;
  };
  /** Most recently seen first, at most MAX_ADMIN_PLAYERS. */
  players: AdminPlayer[];
  /** All players known, including any past the list's cut-off. */
  playerCount: number;
};

export const ADMIN_STATS_DAYS = [7, 30, 90] as const;
export const MAX_ADMIN_PLAYERS = 500;

export type AdminErrorResponse = { error: "not_admin"; playerId: string } | { error: string };
