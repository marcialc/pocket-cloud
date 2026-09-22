import { DurableObject } from "cloudflare:workers";
import { sha256Hex } from "../../shared/api";
import { generateCode, randomPlayerId } from "../auth/code";

/**
 * One instance per email address, named `auth:<sha256(email)>`. Holds the
 * pending sign-in code (hashed), the per-email send history for rate limiting,
 * and the account's link to its player id. The email itself is never stored.
 *
 * Every check-and-update below runs synchronously on SQLite before the next
 * `await`, so concurrent requests for the same email can't both pass a limit
 * or both redeem one code.
 */

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const RESEND_INTERVAL_MS = 60 * 1000;
export const MAX_SENDS_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;

export type IssueCodeResult = { ok: true; code: string } | { ok: false; retryAfter: number };

export type VerifyCodeResult =
  | { ok: true; playerId: string; epoch: number }
  | { ok: false; error: "invalid_code" | "code_expired" | "too_many_attempts" | "account_unavailable" };

const MIGRATIONS: string[] = [
  `CREATE TABLE account (
     id         INTEGER PRIMARY KEY CHECK (id = 1),
     player_id  TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE pending_code (
     id         INTEGER PRIMARY KEY CHECK (id = 1),
     code_hash  TEXT NOT NULL,
     expires_at INTEGER NOT NULL,
     attempts   INTEGER NOT NULL
   )`,
  `CREATE TABLE code_sends (sent_at INTEGER NOT NULL)`,
];

type PendingRow = { code_hash: string; expires_at: number; attempts: number };

export class AuthDO extends DurableObject<Env> {
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

  /** New code for this email, replacing any pending one; rate limited per email. */
  async issueCode(now = Date.now()): Promise<IssueCodeResult> {
    this.sql.exec("DELETE FROM code_sends WHERE sent_at <= ?", now - HOUR_MS);
    const sends = this.sql
      .exec<{ sent_at: number }>("SELECT sent_at FROM code_sends ORDER BY sent_at ASC")
      .toArray()
      .map((r) => r.sent_at);
    const last = sends.at(-1);
    if (last !== undefined && now - last < RESEND_INTERVAL_MS) {
      return { ok: false, retryAfter: Math.ceil((last + RESEND_INTERVAL_MS - now) / 1000) };
    }
    if (sends.length >= MAX_SENDS_PER_HOUR) {
      return { ok: false, retryAfter: Math.ceil((sends[0]! + HOUR_MS - now) / 1000) };
    }
    // Reserve the send slot before awaiting the hash.
    this.sql.exec("INSERT INTO code_sends (sent_at) VALUES (?)", now);

    const code = generateCode();
    const codeHash = await sha256Hex(new TextEncoder().encode(code));
    this.sql.exec(
      `INSERT INTO pending_code (id, code_hash, expires_at, attempts) VALUES (1, ?, ?, 0)
       ON CONFLICT (id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`,
      codeHash,
      now + CODE_TTL_MS,
    );
    return { ok: true, code };
  }

  /**
   * Redeems a code. On success returns the account's player id, creating the
   * account on first sign-in: it adopts `candidatePlayerId` (the browser's
   * anonymous player) when that player is still unclaimed, else a new player.
   */
  async verifyCode(
    code: string,
    ownerId: string,
    candidatePlayerId: string | null,
    now = Date.now(),
  ): Promise<VerifyCodeResult> {
    const submitted = new TextEncoder().encode(await sha256Hex(new TextEncoder().encode(code)));

    // From here to consuming the code: no awaits.
    const pending = this.sql.exec<PendingRow>("SELECT * FROM pending_code WHERE id = 1").toArray()[0];
    if (!pending) return { ok: false, error: "invalid_code" };
    if (pending.expires_at <= now) {
      this.sql.exec("DELETE FROM pending_code WHERE id = 1");
      return { ok: false, error: "code_expired" };
    }
    const expected = new TextEncoder().encode(pending.code_hash);
    if (!crypto.subtle.timingSafeEqual(submitted, expected)) {
      const attempts = pending.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        this.sql.exec("DELETE FROM pending_code WHERE id = 1");
        return { ok: false, error: "too_many_attempts" };
      }
      this.sql.exec("UPDATE pending_code SET attempts = ? WHERE id = 1", attempts);
      return { ok: false, error: "invalid_code" };
    }
    this.sql.exec("DELETE FROM pending_code WHERE id = 1");

    const account = this.readAccount();
    if (account) {
      const claimed = await this.player(account.player_id).claim(ownerId);
      return claimed.ok ? { ok: true, playerId: account.player_id, epoch: claimed.epoch } : { ok: false, error: "account_unavailable" };
    }

    // First sign-in for this email.
    let playerId = candidatePlayerId;
    let claimed = playerId ? await this.player(playerId).claim(ownerId) : ({ ok: false } as const);
    if (!claimed.ok) {
      playerId = randomPlayerId();
      claimed = await this.player(playerId).claim(ownerId);
    }
    if (!claimed.ok || !playerId) return { ok: false, error: "account_unavailable" };

    // Another sign-in may have created the account while we were claiming.
    const raced = this.readAccount();
    if (raced) {
      const again = await this.player(raced.player_id).claim(ownerId);
      return again.ok ? { ok: true, playerId: raced.player_id, epoch: again.epoch } : { ok: false, error: "account_unavailable" };
    }
    this.sql.exec("INSERT INTO account (id, player_id, created_at) VALUES (1, ?, ?)", playerId, now);
    return { ok: true, playerId, epoch: claimed.epoch };
  }

  private readAccount(): { player_id: string } | null {
    return this.sql.exec<{ player_id: string }>("SELECT player_id FROM account WHERE id = 1").toArray()[0] ?? null;
  }

  private player(playerId: string) {
    return this.env.PLAYER_SAVE.getByName(`player:${playerId}`);
  }
}
