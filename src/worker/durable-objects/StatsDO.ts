import { DurableObject } from "cloudflare:workers";
import type { DailyStats, GameStats, PlatformStats, PlayerKind } from "../../shared/admin";
import { gameIdPlatform } from "../../shared/platforms";

/**
 * One instance, named "stats": usage counters for the admin page. The Worker
 * reports events here after answering (best effort, see stats.ts); nothing a
 * player does waits on or fails because of this object.
 *
 * Players are recorded by their random player id only. Emails, codes and
 * save data never reach it; games are known by the save's name (the ROM header
 * title, or "gba:<code>" for other platforms).
 */

export type StatsPlayerRow = {
  player_id: string;
  kind: PlayerKind;
  first_seen: number;
  last_seen: number;
  signed_up_at: number | null;
  saves_synced: number;
  link_plugs: number;
};

export type StatsReport = {
  trackingSince: number | null;
  totals: { players: number; accounts: number; anonymous: number; active1d: number; active7d: number; active30d: number };
  daily: DailyStats[];
  platforms: PlatformStats[];
  games: GameStats[];
  players: StatsPlayerRow[];
};

type Metric = "sign_ups" | "sign_ins" | "saves_synced" | "rom_uploads" | "link_plugs";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long the per-day active player lists are kept. */
export const ACTIVE_RETENTION_DAYS = 90;
const TOP_GAMES = 25;

const MIGRATIONS: string[] = [
  `CREATE TABLE players (
     player_id    TEXT PRIMARY KEY,
     kind         TEXT NOT NULL,
     first_seen   INTEGER NOT NULL,
     last_seen    INTEGER NOT NULL,
     signed_up_at INTEGER,
     saves_synced INTEGER NOT NULL DEFAULT 0,
     link_plugs   INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX players_last_seen ON players (last_seen)`,
  // One counter per UTC day and metric.
  `CREATE TABLE daily (
     day    TEXT NOT NULL,
     metric TEXT NOT NULL,
     value  INTEGER NOT NULL,
     PRIMARY KEY (day, metric)
   )`,
  // Who was active each day, for distinct active counts; pruned after ACTIVE_RETENTION_DAYS.
  `CREATE TABLE daily_active (
     day       TEXT NOT NULL,
     player_id TEXT NOT NULL,
     PRIMARY KEY (day, player_id)
   )`,
  `CREATE TABLE games (
     game_id     TEXT PRIMARY KEY,
     platform    TEXT NOT NULL,
     saves       INTEGER NOT NULL,
     last_synced INTEGER NOT NULL
   )`,
  `CREATE TABLE game_players (
     game_id   TEXT NOT NULL,
     player_id TEXT NOT NULL,
     PRIMARY KEY (game_id, player_id)
   )`,
];

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export class StatsDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate(): void {
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
    );
    const applied = this.sql.exec<{ v: number | null }>("SELECT MAX(version) AS v FROM _migrations").one().v ?? 0;
    for (let version = applied + 1; version <= MIGRATIONS.length; version++) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(MIGRATIONS[version - 1]!);
        this.sql.exec("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)", version, Date.now());
      });
    }
  }

  /** The player made an authorized request. */
  async seen(playerId: string, kind: PlayerKind, now = Date.now()): Promise<void> {
    this.touch(playerId, kind, now);
  }

  /** An email sign-in; `created` when it made the account. */
  async signedIn(playerId: string, created: boolean, now = Date.now()): Promise<void> {
    this.touch(playerId, "account", now);
    this.bump("sign_ins", now);
    if (created) {
      this.bump("sign_ups", now);
      this.sql.exec("UPDATE players SET signed_up_at = ? WHERE player_id = ?", now, playerId);
    }
  }

  async saveSynced(playerId: string, kind: PlayerKind, gameId: string, now = Date.now()): Promise<void> {
    this.touch(playerId, kind, now);
    this.bump("saves_synced", now);
    this.sql.exec("UPDATE players SET saves_synced = saves_synced + 1 WHERE player_id = ?", playerId);
    this.sql.exec(
      `INSERT INTO games (game_id, platform, saves, last_synced) VALUES (?, ?, 1, ?)
       ON CONFLICT (game_id) DO UPDATE SET saves = saves + 1, last_synced = excluded.last_synced`,
      gameId,
      gameIdPlatform(gameId) ?? "gb",
      now,
    );
    this.sql.exec("INSERT OR IGNORE INTO game_players (game_id, player_id) VALUES (?, ?)", gameId, playerId);
  }

  async romUploaded(playerId: string, now = Date.now()): Promise<void> {
    this.touch(playerId, "account", now);
    this.bump("rom_uploads", now);
  }

  async linkPlugged(playerId: string, now = Date.now()): Promise<void> {
    this.touch(playerId, "account", now);
    this.bump("link_plugs", now);
    this.sql.exec("UPDATE players SET link_plugs = link_plugs + 1 WHERE player_id = ?", playerId);
  }

  /** Which of these players this object has never seen (e.g. accounts from before tracking began). */
  async untracked(playerIds: string[]): Promise<string[]> {
    const seen = new Set<string>();
    // SQLite in Durable Objects binds at most 100 parameters per statement.
    for (let i = 0; i < playerIds.length; i += 100) {
      const chunk = playerIds.slice(i, i + 100);
      for (const row of this.sql.exec<{ player_id: string }>(
        `SELECT player_id FROM players WHERE player_id IN (${chunk.map(() => "?").join(",")})`,
        ...chunk,
      )) {
        seen.add(row.player_id);
      }
    }
    return playerIds.filter((id) => !seen.has(id));
  }

  /** The last `days` UTC days (today included) and the players most recently seen. */
  async report(days: number, maxPlayers: number, now = Date.now()): Promise<StatsReport> {
    const today = Date.parse(utcDay(now));
    const dayList = Array.from({ length: days }, (_, i) => utcDay(today - (days - 1 - i) * DAY_MS));
    const first = dayList[0]!;

    const counters = new Map<string, Partial<Record<Metric, number>>>();
    for (const row of this.sql.exec<{ day: string; metric: Metric; value: number }>(
      "SELECT day, metric, value FROM daily WHERE day >= ?",
      first,
    )) {
      const entry = counters.get(row.day) ?? {};
      entry[row.metric] = row.value;
      counters.set(row.day, entry);
    }
    const active = new Map<string, number>();
    for (const row of this.sql.exec<{ day: string; n: number }>(
      "SELECT day, COUNT(*) AS n FROM daily_active WHERE day >= ? GROUP BY day",
      first,
    )) {
      active.set(row.day, row.n);
    }
    const daily = dayList.map((day): DailyStats => {
      const c = counters.get(day) ?? {};
      return {
        day,
        activePlayers: active.get(day) ?? 0,
        signUps: c.sign_ups ?? 0,
        signIns: c.sign_ins ?? 0,
        savesSynced: c.saves_synced ?? 0,
        romUploads: c.rom_uploads ?? 0,
        linkPlugs: c.link_plugs ?? 0,
      };
    });

    const activeSince = (n: number) =>
      this.sql
        .exec<{ n: number }>("SELECT COUNT(DISTINCT player_id) AS n FROM daily_active WHERE day >= ?", utcDay(today - (n - 1) * DAY_MS))
        .one().n;
    const kinds = this.sql
      .exec<{ accounts: number | null; anonymous: number | null; players: number }>(
        `SELECT COUNT(*) AS players,
                SUM(kind = 'account') AS accounts,
                SUM(kind = 'anonymous') AS anonymous
         FROM players`,
      )
      .one();

    return {
      trackingSince: this.sql.exec<{ t: number | null }>("SELECT MIN(first_seen) AS t FROM players").one().t,
      totals: {
        players: kinds.players,
        accounts: kinds.accounts ?? 0,
        anonymous: kinds.anonymous ?? 0,
        active1d: activeSince(1),
        active7d: activeSince(7),
        active30d: activeSince(30),
      },
      daily,
      platforms: this.sql
        .exec<PlatformStats>(
          `SELECT g.platform AS platform, COUNT(DISTINCT gp.player_id) AS players,
                  (SELECT SUM(saves) FROM games WHERE platform = g.platform) AS saves
           FROM games g JOIN game_players gp ON gp.game_id = g.game_id
           GROUP BY g.platform ORDER BY players DESC, saves DESC`,
        )
        .toArray(),
      games: this.sql
        .exec<GameStats>(
          `SELECT g.game_id AS gameId, g.platform AS platform, COUNT(gp.player_id) AS players,
                  g.saves AS saves, g.last_synced AS lastSynced
           FROM games g JOIN game_players gp ON gp.game_id = g.game_id
           GROUP BY g.game_id ORDER BY players DESC, saves DESC LIMIT ?`,
          TOP_GAMES,
        )
        .toArray(),
      players: this.sql
        .exec<StatsPlayerRow>("SELECT * FROM players ORDER BY last_seen DESC LIMIT ?", maxPlayers)
        .toArray(),
    };
  }

  private touch(playerId: string, kind: PlayerKind, now: number): void {
    // A player only ever goes from anonymous to account (signing in adopts it), never back.
    this.sql.exec(
      `INSERT INTO players (player_id, kind, first_seen, last_seen) VALUES (?, ?, ?, ?)
       ON CONFLICT (player_id) DO UPDATE SET
         last_seen = MAX(last_seen, excluded.last_seen),
         kind = CASE WHEN excluded.kind = 'account' THEN 'account' ELSE kind END`,
      playerId,
      kind,
      now,
      now,
    );
    const day = utcDay(now);
    const inserted = this.sql.exec("INSERT OR IGNORE INTO daily_active (day, player_id) VALUES (?, ?)", day, playerId).rowsWritten;
    // A player's first activity of the day: a cheap moment to drop days past retention.
    if (inserted > 0) {
      this.sql.exec("DELETE FROM daily_active WHERE day < ?", utcDay(now - ACTIVE_RETENTION_DAYS * DAY_MS));
    }
  }

  private bump(metric: Metric, now: number): void {
    this.sql.exec(
      `INSERT INTO daily (day, metric, value) VALUES (?, ?, 1)
       ON CONFLICT (day, metric) DO UPDATE SET value = value + 1`,
      utcDay(now),
      metric,
    );
  }
}
