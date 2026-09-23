import { DurableObject } from "cloudflare:workers";
import {
  MAX_FRIENDS,
  MAX_PENDING_REQUESTS,
  type AddFriendResponse,
  type BoardId,
  type FriendsResponse,
  type GameLeaderboards,
  type Leaderboard,
  type MyProfile,
  type Profile,
} from "../../shared/social";
import { generateCode, randomPlayerId } from "../auth/code";

/**
 * One instance for the whole app, named "social". Friends and leaderboards
 * look across players, so they live together here rather than in each
 * player's PlayerSaveDO. Players are only ever addressed by their friend code
 * from outside; player ids stay on the server.
 *
 * Every check-and-update runs synchronously on SQLite with no `await` in
 * between, so concurrent requests can't both pass a limit.
 */

export type AddFriendResult = AddFriendResponse | { error: "not_found" | "self" | "already_friends" | "too_many" };

export type AcceptInviteResult = { friend: Profile } | { error: "not_found" | "self" | "too_many" };

export type ScoreInput = { board: BoardId; value: number };

const MIGRATIONS: string[] = [
  `CREATE TABLE profiles (
     player_id   TEXT PRIMARY KEY,
     name        TEXT NOT NULL,
     friend_code TEXT NOT NULL UNIQUE,
     created_at  INTEGER NOT NULL
   )`,
  // One row per direction, so "my friends" is a single indexed lookup.
  `CREATE TABLE friends (
     player_id  TEXT NOT NULL,
     friend_id  TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (player_id, friend_id)
   )`,
  `CREATE TABLE friend_requests (
     from_id    TEXT NOT NULL,
     to_id      TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (from_id, to_id)
   )`,
  `CREATE INDEX friend_requests_to ON friend_requests (to_id)`,
  // Best value per player, game and board. Recorded even before a player has a profile.
  `CREATE TABLE scores (
     rom_hash   TEXT NOT NULL,
     player_id  TEXT NOT NULL,
     board      TEXT NOT NULL,
     value      INTEGER NOT NULL,
     title      TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (player_id, rom_hash, board)
   )`,
  // Secret behind the player's invite link; made on first use, replaced on reset.
  `ALTER TABLE profiles ADD COLUMN invite_token TEXT`,
  `CREATE UNIQUE INDEX profiles_invite_token ON profiles (invite_token)`,
];

type ProfileRow = { player_id: string; name: string; friend_code: string; invite_token: string | null };
type ScoreRow = ProfileRow & { rom_hash: string; board: BoardId; value: number; title: string; updated_at: number };

export class SocialDO extends DurableObject<Env> {
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

  async getProfile(playerId: string): Promise<Profile | null> {
    const row = this.profileRow(playerId);
    return row ? toProfile(row) : null;
  }

  /** The player's own profile, with the token for their invite link. */
  async getOwnProfile(playerId: string): Promise<MyProfile | null> {
    const row = this.profileRow(playerId);
    return row ? this.withInvite(row) : null;
  }

  /** Creates the player's profile (with a new friend code) or renames it. */
  async setProfile(playerId: string, name: string): Promise<MyProfile> {
    const existing = this.profileRow(playerId);
    if (existing) {
      this.sql.exec("UPDATE profiles SET name = ? WHERE player_id = ?", name, playerId);
      return this.withInvite({ ...existing, name });
    }
    // 31^8 codes: a clash is rare, so just draw again.
    let code = generateCode();
    while (this.playerByCode(code)) code = generateCode();
    this.sql.exec(
      "INSERT INTO profiles (player_id, name, friend_code, created_at) VALUES (?, ?, ?, ?)",
      playerId,
      name,
      code,
      Date.now(),
    );
    return this.withInvite(this.profileRow(playerId)!);
  }

  /** A new invite link; the old one stops working. Null without a profile. */
  async resetInvite(playerId: string): Promise<MyProfile | null> {
    const row = this.profileRow(playerId);
    return row ? this.withInvite({ ...row, invite_token: null }) : null;
  }

  /** Whose invite link this is, or null if it's unknown or was reset. */
  async inviter(token: string): Promise<Profile | null> {
    const row = this.sql.exec<ProfileRow>("SELECT * FROM profiles WHERE invite_token = ?", token).toArray()[0];
    return row ? toProfile(row) : null;
  }

  /**
   * Opening someone's invite link and adding them: the link is their consent,
   * so you're friends at once. Already being friends counts as success.
   */
  async acceptInvite(playerId: string, token: string): Promise<AcceptInviteResult> {
    const target = this.sql.exec<ProfileRow>("SELECT * FROM profiles WHERE invite_token = ?", token).toArray()[0];
    if (!target) return { error: "not_found" };
    if (target.player_id === playerId) return { error: "self" };
    const friend = toProfile(target);
    if (this.isFriend(playerId, target.player_id)) return { friend };
    if (this.friendCount(playerId) >= MAX_FRIENDS || this.friendCount(target.player_id) >= MAX_FRIENDS) {
      return { error: "too_many" };
    }
    this.makeFriends(playerId, target.player_id);
    return { friend };
  }

  async listFriends(playerId: string): Promise<FriendsResponse> {
    const list = (query: string) => this.sql.exec<ProfileRow>(query, playerId).toArray().map(toProfile);
    return {
      friends: list(
        "SELECT p.* FROM friends f JOIN profiles p ON p.player_id = f.friend_id WHERE f.player_id = ? ORDER BY p.name COLLATE NOCASE",
      ),
      incoming: list(
        "SELECT p.* FROM friend_requests r JOIN profiles p ON p.player_id = r.from_id WHERE r.to_id = ? ORDER BY r.created_at DESC",
      ),
      outgoing: list(
        "SELECT p.* FROM friend_requests r JOIN profiles p ON p.player_id = r.to_id WHERE r.from_id = ? ORDER BY r.created_at DESC",
      ),
    };
  }

  /**
   * Adds a friend by code. If they had already asked, that's the acceptance
   * and you're friends; otherwise it waits as a request until they add yours.
   */
  async addFriend(playerId: string, code: string): Promise<AddFriendResult> {
    const target = this.playerByCode(code);
    if (!target) return { error: "not_found" };
    if (target.player_id === playerId) return { error: "self" };
    const friend = toProfile(target);
    if (this.isFriend(playerId, target.player_id)) return { error: "already_friends" };

    const theyAsked = this.sql
      .exec("SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?", target.player_id, playerId)
      .toArray().length > 0;
    if (theyAsked) {
      if (this.friendCount(playerId) >= MAX_FRIENDS || this.friendCount(target.player_id) >= MAX_FRIENDS) {
        return { error: "too_many" };
      }
      this.makeFriends(playerId, target.player_id);
      return { status: "friends", friend };
    }

    const pending = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM friend_requests WHERE from_id = ?", playerId)
      .one().n;
    const alreadyAsked = this.sql
      .exec("SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?", playerId, target.player_id)
      .toArray().length > 0;
    if (!alreadyAsked) {
      if (pending >= MAX_PENDING_REQUESTS || this.friendCount(playerId) >= MAX_FRIENDS) return { error: "too_many" };
      this.sql.exec(
        "INSERT INTO friend_requests (from_id, to_id, created_at) VALUES (?, ?, ?)",
        playerId,
        target.player_id,
        Date.now(),
      );
    }
    return { status: "requested", friend };
  }

  /** Unfriends, declines their request or cancels yours: whatever links the two of you goes. */
  async removeFriend(playerId: string, code: string): Promise<boolean> {
    const target = this.playerByCode(code);
    if (!target) return false;
    let removed = 0;
    this.ctx.storage.transactionSync(() => {
      removed += this.sql.exec(
        "DELETE FROM friends WHERE (player_id = ? AND friend_id = ?) OR (player_id = ? AND friend_id = ?)",
        playerId,
        target.player_id,
        target.player_id,
        playerId,
      ).rowsWritten;
      removed += this.sql.exec(
        "DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)",
        playerId,
        target.player_id,
        target.player_id,
        playerId,
      ).rowsWritten;
    });
    return removed > 0;
  }

  /** Keeps the best value seen for each board (a restarted save doesn't lower it). */
  async recordScores(playerId: string, romHash: string, title: string, scores: ScoreInput[]): Promise<void> {
    const now = Date.now();
    for (const { board, value } of scores) {
      this.sql.exec(
        `INSERT INTO scores (rom_hash, player_id, board, value, title, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (player_id, rom_hash, board) DO UPDATE SET
           value = excluded.value, title = excluded.title, updated_at = excluded.updated_at
         WHERE excluded.value > scores.value`,
        romHash,
        playerId,
        board,
        value,
        title,
        now,
      );
    }
  }

  /**
   * Leaderboards for every game you or a friend has played, games you share
   * first. With `romHash`, just that game (empty if nobody in the circle has played it).
   */
  async leaderboards(playerId: string, romHash?: string): Promise<GameLeaderboards[]> {
    const rows = this.sql
      .exec<ScoreRow>(
        `SELECT s.*, p.name, p.friend_code FROM scores s JOIN profiles p ON p.player_id = s.player_id
         WHERE (s.player_id = ?1 OR s.player_id IN (SELECT friend_id FROM friends WHERE player_id = ?1))
           ${romHash ? "AND s.rom_hash = ?2" : ""}
         ORDER BY s.value DESC, s.updated_at ASC`,
        ...(romHash ? [playerId, romHash] : [playerId]),
      )
      .toArray();

    // A game's name: your own copy's title, else the first one a friend recorded (so nobody can rename it later).
    const games = new Map<string, { title: string; titleAt: number; mine: boolean; players: Set<string>; latest: number; boards: Map<BoardId, Leaderboard> }>();
    for (const row of rows) {
      let game = games.get(row.rom_hash);
      if (!game) {
        game = { title: row.title, titleAt: row.updated_at, mine: false, players: new Set(), latest: 0, boards: new Map() };
        games.set(row.rom_hash, game);
      }
      const mine = row.player_id === playerId;
      if ((mine && !game.mine) || (mine === game.mine && row.updated_at < game.titleAt)) {
        game.title = row.title;
        game.titleAt = row.updated_at;
        game.mine = mine;
      }
      game.players.add(row.player_id);
      game.latest = Math.max(game.latest, row.updated_at);
      let board = game.boards.get(row.board);
      if (!board) {
        board = { board: row.board, entries: [] };
        game.boards.set(row.board, board);
      }
      board.entries.push({ ...toProfile(row), value: row.value, updatedAt: row.updated_at, me: row.player_id === playerId });
    }

    return [...games.entries()]
      .sort(([, a], [, b]) => Number(b.players.size > 1) - Number(a.players.size > 1) || b.latest - a.latest)
      .map(([hash, g]) => ({
        romHash: hash,
        title: g.title,
        players: g.players.size,
        // Play time last: the game's own score says more.
        boards: [...g.boards.values()].sort((a, b) => Number(a.board === "playtime") - Number(b.board === "playtime")),
      }));
  }

  /** Friends both ways, and any request between the two of them is settled. */
  private makeFriends(a: string, b: string): void {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)",
        a,
        b,
        b,
        a,
      );
      this.sql.exec("INSERT INTO friends (player_id, friend_id, created_at) VALUES (?, ?, ?)", a, b, now);
      this.sql.exec("INSERT INTO friends (player_id, friend_id, created_at) VALUES (?, ?, ?)", b, a, now);
    });
  }

  /** The row as the player's own profile, giving it an invite token if it has none yet. */
  private withInvite(row: ProfileRow): MyProfile {
    let token = row.invite_token;
    if (!token) {
      token = randomPlayerId().slice(0, 24);
      this.sql.exec("UPDATE profiles SET invite_token = ? WHERE player_id = ?", token, row.player_id);
    }
    return { ...toProfile(row), inviteToken: token };
  }

  private profileRow(playerId: string): ProfileRow | null {
    return this.sql.exec<ProfileRow>("SELECT * FROM profiles WHERE player_id = ?", playerId).toArray()[0] ?? null;
  }

  private playerByCode(code: string): ProfileRow | null {
    return this.sql.exec<ProfileRow>("SELECT * FROM profiles WHERE friend_code = ?", code).toArray()[0] ?? null;
  }

  private isFriend(playerId: string, otherId: string): boolean {
    return this.sql.exec("SELECT 1 FROM friends WHERE player_id = ? AND friend_id = ?", playerId, otherId).toArray().length > 0;
  }

  private friendCount(playerId: string): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM friends WHERE player_id = ?", playerId).one().n;
  }
}

function toProfile(row: ProfileRow): Profile {
  return { name: row.name, friendCode: row.friend_code };
}
