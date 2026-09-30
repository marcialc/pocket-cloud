import { DurableObject } from "cloudflare:workers";
import { HISTORY_LIMIT, type CloudSaveMeta } from "../../shared/api";

/**
 * One instance per player. Stores that player's battery saves (one row per
 * ROM fingerprint) in SQLite-backed Durable Object storage.
 *
 * This object never runs the emulator. It is the player's durable "memory
 * card", and the natural home for future per-player state: save states,
 * achievements, profile, Pokédex/badge stats, screenshot metadata. Cross-player
 * features (trading, battles) belong in their own objects (e.g. LinkCableDO,
 * BattleDO) that talk to this one over RPC.
 */

export type StoredSave = CloudSaveMeta & { sram: Uint8Array };

/** A save's metadata with its picture (PNG), if it has one. */
export type StoredVersion = CloudSaveMeta & { screenshot?: Uint8Array };

export type PutSaveInput = {
  romHash: string;
  gameId: string;
  sram: Uint8Array;
  sramHash: string;
  updatedAt: number;
  playTime?: number;
  rtcBase?: number;
  baseRevision: number | null;
  force?: boolean;
  /** PNG of the game shortly before it saved. */
  screenshot?: Uint8Array;
};

/**
 * How a request proved it may use this player: the anonymous player key, or
 * an email session for the account that owns it.
 */
export type PlayerAccess = { kind: "key" } | { kind: "session"; ownerId: string; epoch: number };

export type PutSaveResult =
  | { ok: true; save: CloudSaveMeta }
  | { ok: false; conflict: CloudSaveMeta };

type SaveRow = {
  rom_hash: string;
  game_id: string;
  sram: ArrayBuffer;
  sram_hash: string;
  revision: number;
  play_time: number | null;
  rtc_base: number | null;
  screenshot: ArrayBuffer | null;
  created_at: number;
  updated_at: number;
};

/**
 * Append-only schema migrations. Each entry runs exactly once per object, in
 * order. Add new tables (save_states, achievements, profile, ...) by appending.
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE game_saves (
     rom_hash    TEXT PRIMARY KEY,
     game_id     TEXT NOT NULL,
     sram        BLOB NOT NULL,
     sram_hash   TEXT NOT NULL,
     revision    INTEGER NOT NULL,
     play_time   INTEGER,
     created_at  INTEGER NOT NULL,
     updated_at  INTEGER NOT NULL,
     received_at INTEGER NOT NULL
   )`,
  // Set once an email account claims this player. From then on the anonymous
  // key is refused and only sessions for owner_id on the current epoch work.
  `CREATE TABLE owner (
     id         INTEGER PRIMARY KEY CHECK (id = 1),
     owner_id   TEXT NOT NULL,
     epoch      INTEGER NOT NULL,
     claimed_at INTEGER NOT NULL
   )`,
  // When the cartridge's real-time clock read zero (Pokémon Gold/Silver/Crystal).
  `ALTER TABLE game_saves ADD COLUMN rtc_base INTEGER`,
  // Account-wide preferences (e.g. "key_bindings"), one JSON value per name.
  `CREATE TABLE settings (
     name       TEXT PRIMARY KEY,
     value      TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  // Earlier versions of each save, kept when a newer one replaces them (see HISTORY_LIMIT).
  `CREATE TABLE save_history (
     rom_hash    TEXT NOT NULL,
     revision    INTEGER NOT NULL,
     game_id     TEXT NOT NULL,
     sram        BLOB NOT NULL,
     sram_hash   TEXT NOT NULL,
     play_time   INTEGER,
     rtc_base    INTEGER,
     created_at  INTEGER NOT NULL,
     updated_at  INTEGER NOT NULL,
     PRIMARY KEY (rom_hash, revision)
   )`,
  // A picture of the game from just before each save, shown when picking one to go back to.
  `ALTER TABLE game_saves ADD COLUMN screenshot BLOB`,
  `ALTER TABLE save_history ADD COLUMN screenshot BLOB`,
];

export class PlayerSaveDO extends DurableObject<Env> {
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

  /** Whether this request may read or write this player's saves. */
  async authorize(access: PlayerAccess): Promise<boolean> {
    const owner = this.readOwner();
    if (access.kind === "key") return owner === null;
    return owner !== null && owner.owner_id === access.ownerId && owner.epoch === access.epoch;
  }

  /**
   * Binds this player to an email account. Idempotent for the same owner (returns
   * the current session epoch); refused if another account already owns it.
   */
  async claim(ownerId: string): Promise<{ ok: true; epoch: number } | { ok: false }> {
    const owner = this.readOwner();
    if (owner) return owner.owner_id === ownerId ? { ok: true, epoch: owner.epoch } : { ok: false };
    this.sql.exec("INSERT INTO owner (id, owner_id, epoch, claimed_at) VALUES (1, ?, 1, ?)", ownerId, Date.now());
    return { ok: true, epoch: 1 };
  }

  /** "Sign out everywhere": invalidates every session issued so far for this owner. */
  async revokeSessions(ownerId: string): Promise<boolean> {
    return this.sql.exec("UPDATE owner SET epoch = epoch + 1 WHERE id = 1 AND owner_id = ?", ownerId).rowsWritten > 0;
  }

  async listSaves(): Promise<CloudSaveMeta[]> {
    // Every game's metadata only: not its SRAM or picture bytes, just their size and whether it has one.
    return this.sql
      .exec<Omit<SaveRow, "sram" | "screenshot"> & { sram_size: number; has_screenshot: number }>(
        `SELECT rom_hash, game_id, sram_hash, revision, play_time, rtc_base, created_at, updated_at,
           length(sram) AS sram_size, screenshot IS NOT NULL AS has_screenshot
         FROM game_saves ORDER BY updated_at DESC`,
      )
      .toArray()
      .map(({ sram_size, has_screenshot, ...row }) =>
        toMeta({ ...row, sram: new ArrayBuffer(0), screenshot: null }, { sramSize: sram_size, hasScreenshot: has_screenshot === 1 }),
      );
  }

  async getSave(romHash: string): Promise<StoredSave | null> {
    const row = this.readRow(romHash);
    return row ? { ...toMeta(row), sram: new Uint8Array(row.sram) } : null;
  }

  async putSave(input: PutSaveInput): Promise<PutSaveResult> {
    const existing = this.readRow(input.romHash);
    if (existing) {
      const current = toMeta(existing);
      if (existing.sram_hash === input.sramHash) {
        // An older save getting its clock base. The first one stored wins, so every
        // device converges on it (the response tells the client which one that is).
        if (existing.rtc_base == null && input.rtcBase !== undefined) {
          this.sql.exec("UPDATE game_saves SET rtc_base = ? WHERE rom_hash = ?", input.rtcBase, input.romHash);
          return { ok: true, save: toMeta(this.readRow(input.romHash)!) };
        }
        // Same bytes already stored: idempotent success (e.g. a retried request).
        return { ok: true, save: current };
      }
      if (!input.force && input.baseRevision !== existing.revision) {
        return { ok: false, conflict: current };
      }
    }

    const now = Date.now();
    const revision = (existing?.revision ?? 0) + 1;
    const createdAt = existing?.created_at ?? now;
    if (existing) this.keepInHistory(existing);
    this.sql.exec(
      `INSERT INTO game_saves
         (rom_hash, game_id, sram, sram_hash, revision, play_time, rtc_base, screenshot, created_at, updated_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (rom_hash) DO UPDATE SET
         game_id = excluded.game_id, sram = excluded.sram, sram_hash = excluded.sram_hash,
         revision = excluded.revision, play_time = excluded.play_time,
         rtc_base = COALESCE(excluded.rtc_base, game_saves.rtc_base), screenshot = excluded.screenshot,
         updated_at = excluded.updated_at, received_at = excluded.received_at`,
      input.romHash,
      input.gameId,
      input.sram,
      input.sramHash,
      revision,
      input.playTime ?? null,
      input.rtcBase ?? null,
      input.screenshot ?? null,
      createdAt,
      input.updatedAt,
      now,
    );
    return { ok: true, save: toMeta(this.readRow(input.romHash)!) };
  }

  async deleteSave(romHash: string): Promise<boolean> {
    this.sql.exec("DELETE FROM save_history WHERE rom_hash = ?", romHash);
    return this.sql.exec("DELETE FROM game_saves WHERE rom_hash = ?", romHash).rowsWritten > 0;
  }

  /** A game's current save and its earlier versions, newest first (each with the revision it had), with their pictures. */
  async listHistory(romHash: string): Promise<{ current: StoredVersion | null; versions: StoredVersion[] }> {
    const current = this.readRow(romHash);
    const versions = this.sql
      .exec<SaveRow>("SELECT * FROM save_history WHERE rom_hash = ? ORDER BY revision DESC", romHash)
      .toArray();
    return { current: current ? toVersion(current) : null, versions: versions.map(toVersion) };
  }

  async getHistorySave(romHash: string, revision: number): Promise<StoredSave | null> {
    const row = this.readHistoryRow(romHash, revision);
    return row ? { ...toMeta(row), sram: new Uint8Array(row.sram) } : null;
  }

  /**
   * Makes an earlier version the current save again, as a new revision dated now,
   * so every device takes it as the newest save. The save it replaces goes into
   * the history in its place. Null if that version isn't kept (any more).
   */
  async restoreSave(romHash: string, revision: number): Promise<CloudSaveMeta | null> {
    const old = this.readHistoryRow(romHash, revision);
    const current = this.readRow(romHash);
    if (!old || !current) return null;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM save_history WHERE rom_hash = ? AND revision = ?", romHash, revision);
      this.keepInHistory(current);
      const now = Date.now();
      this.sql.exec(
        `UPDATE game_saves SET game_id = ?, sram = ?, sram_hash = ?, revision = ?, play_time = ?, rtc_base = ?,
           screenshot = ?, updated_at = ?, received_at = ?
         WHERE rom_hash = ?`,
        old.game_id,
        old.sram,
        old.sram_hash,
        current.revision + 1,
        old.play_time,
        old.rtc_base ?? current.rtc_base,
        old.screenshot,
        now,
        now,
        romHash,
      );
    });
    return toMeta(this.readRow(romHash)!);
  }

  /** A stored setting's JSON value, or null if it was never set. */
  async getSetting(name: string): Promise<string | null> {
    return this.sql.exec<{ value: string }>("SELECT value FROM settings WHERE name = ?", name).toArray()[0]?.value ?? null;
  }

  async putSetting(name: string, value: string): Promise<void> {
    this.sql.exec(
      `INSERT INTO settings (name, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      name,
      value,
      Date.now(),
    );
  }

  /** Files a save that is about to be replaced, keeping only the newest HISTORY_LIMIT per game. */
  private keepInHistory(row: SaveRow): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO save_history
         (rom_hash, revision, game_id, sram, sram_hash, play_time, rtc_base, screenshot, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.rom_hash,
      row.revision,
      row.game_id,
      row.sram,
      row.sram_hash,
      row.play_time,
      row.rtc_base,
      row.screenshot,
      row.created_at,
      row.updated_at,
    );
    this.sql.exec(
      `DELETE FROM save_history WHERE rom_hash = ? AND revision NOT IN
         (SELECT revision FROM save_history WHERE rom_hash = ? ORDER BY revision DESC LIMIT ?)`,
      row.rom_hash,
      row.rom_hash,
      HISTORY_LIMIT,
    );
  }

  private readHistoryRow(romHash: string, revision: number): SaveRow | null {
    return (
      this.sql
        .exec<SaveRow>("SELECT * FROM save_history WHERE rom_hash = ? AND revision = ?", romHash, revision)
        .toArray()[0] ?? null
    );
  }

  private readOwner(): { owner_id: string; epoch: number } | null {
    return this.sql.exec<{ owner_id: string; epoch: number }>("SELECT owner_id, epoch FROM owner WHERE id = 1").toArray()[0] ?? null;
  }

  private readRow(romHash: string): SaveRow | null {
    return this.sql.exec<SaveRow>("SELECT * FROM game_saves WHERE rom_hash = ?", romHash).toArray()[0] ?? null;
  }
}

/** `known`: sizes read without loading the bytes (see listSaves). */
function toMeta(row: SaveRow, known?: { sramSize: number; hasScreenshot: boolean }): CloudSaveMeta {
  const hasScreenshot = known ? known.hasScreenshot : row.screenshot != null;
  return {
    romHash: row.rom_hash,
    gameId: row.game_id,
    sramHash: row.sram_hash,
    sramSize: known ? known.sramSize : row.sram.byteLength,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.play_time != null ? { playTime: row.play_time } : {}),
    ...(row.rtc_base != null ? { rtcBase: row.rtc_base } : {}),
    ...(hasScreenshot ? { hasScreenshot: true as const } : {}),
  };
}

function toVersion(row: SaveRow): StoredVersion {
  return { ...toMeta(row), ...(row.screenshot != null ? { screenshot: new Uint8Array(row.screenshot) } : {}) };
}
