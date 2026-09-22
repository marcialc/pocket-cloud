import { DurableObject } from "cloudflare:workers";
import type { CloudSaveMeta } from "../../shared/api";

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

export type PutSaveInput = {
  romHash: string;
  gameId: string;
  sram: Uint8Array;
  sramHash: string;
  updatedAt: number;
  playTime?: number;
  baseRevision: number | null;
  force?: boolean;
};

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

  async listSaves(): Promise<CloudSaveMeta[]> {
    return this.sql
      .exec<SaveRow>("SELECT * FROM game_saves ORDER BY updated_at DESC")
      .toArray()
      .map(toMeta);
  }

  async getSave(romHash: string): Promise<StoredSave | null> {
    const row = this.readRow(romHash);
    return row ? { ...toMeta(row), sram: new Uint8Array(row.sram) } : null;
  }

  async putSave(input: PutSaveInput): Promise<PutSaveResult> {
    const existing = this.readRow(input.romHash);
    if (existing) {
      const current = toMeta(existing);
      // Same bytes already stored: idempotent success (e.g. a retried request).
      if (existing.sram_hash === input.sramHash) return { ok: true, save: current };
      if (!input.force && input.baseRevision !== existing.revision) {
        return { ok: false, conflict: current };
      }
    }

    const now = Date.now();
    const revision = (existing?.revision ?? 0) + 1;
    const createdAt = existing?.created_at ?? now;
    this.sql.exec(
      `INSERT INTO game_saves
         (rom_hash, game_id, sram, sram_hash, revision, play_time, created_at, updated_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (rom_hash) DO UPDATE SET
         game_id = excluded.game_id, sram = excluded.sram, sram_hash = excluded.sram_hash,
         revision = excluded.revision, play_time = excluded.play_time,
         updated_at = excluded.updated_at, received_at = excluded.received_at`,
      input.romHash,
      input.gameId,
      input.sram,
      input.sramHash,
      revision,
      input.playTime ?? null,
      createdAt,
      input.updatedAt,
      now,
    );
    return { ok: true, save: toMeta(this.readRow(input.romHash)!) };
  }

  async deleteSave(romHash: string): Promise<boolean> {
    return this.sql.exec("DELETE FROM game_saves WHERE rom_hash = ?", romHash).rowsWritten > 0;
  }

  private readRow(romHash: string): SaveRow | null {
    return this.sql.exec<SaveRow>("SELECT * FROM game_saves WHERE rom_hash = ?", romHash).toArray()[0] ?? null;
  }
}

function toMeta(row: SaveRow): CloudSaveMeta {
  return {
    romHash: row.rom_hash,
    gameId: row.game_id,
    sramHash: row.sram_hash,
    sramSize: row.sram.byteLength,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.play_time != null ? { playTime: row.play_time } : {}),
  };
}
