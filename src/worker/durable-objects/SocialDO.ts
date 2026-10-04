import { DurableObject } from "cloudflare:workers";
import {
  LINK_REQUEST_TIMEOUT_MS,
  type IncomingLinkRequest,
  type LinkRequestUnavailable,
  type OutgoingLinkRequest,
} from "../../shared/link";
import { canLink, type LinkGame } from "../../shared/linkCompat";
import {
  MAX_FRIENDS,
  MAX_PENDING_REQUESTS,
  PRESENCE_TIMEOUT_MS,
  type AddFriendResponse,
  type BoardId,
  type FriendsResponse,
  type GameLeaderboards,
  type Leaderboard,
  type MyProfile,
  type Presence,
  type PresenceGame,
  type Profile,
  type PutPresenceResponse,
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
  // Pairs of friends whose link room may hold something (a player plugged in,
  // or a save to pick up), so the Link panel only asks the link server about
  // those. One row per pair (player_a < player_b), set at plug-in and
  // cleared once the room is seen empty.
  `CREATE TABLE link_rooms (
     player_a TEXT NOT NULL,
     player_b TEXT NOT NULL,
     used_at  INTEGER NOT NULL,
     PRIMARY KEY (player_a, player_b)
   )`,
  `CREATE INDEX link_rooms_b ON link_rooms (player_b)`,
];

/** What one tab last said it was doing. `game` null is the lobby (the games page). */
type TabPresence = { game: PresenceGame | null; hidden: boolean; seenAt: number };

/** A player's presence with their game's ROM hash and game code: for the server only, never sent to friends. */
export type RawPresence = { status: "offline" } | { status: "lobby" } | { status: "playing"; game: PresenceGame };

/**
 * A friend as the Link panel's route sees them: their player id (to name the
 * link room), raw presence, and whether their link room with you may hold
 * something (see link_rooms).
 */
export type LinkCandidate = { playerId: string; profile: Profile; presence: RawPresence; roomUsed: boolean };

/**
 * For GET /api/link: your friends, and the game code of the game you asked
 * about, taken from your own newest tab that has it open (none if no tab does).
 */
export type LinkCandidates = { gameCode?: string; friends: LinkCandidate[] };

/**
 * For the plug route: whether the friend is online, the games open in their
 * tabs (each with whether that tab is in the background), and the other
 * friends whose link rooms with them may hold something (to find out whether
 * they're on the cable already). Every tab counts, not just the newest: a
 * games page left open in the background mustn't hide a game being played.
 */
export type LinkTarget = { online: boolean; games: { game: PresenceGame; hidden: boolean }[]; otherRooms: string[] };

/**
 * A link request from `from` to `to`, in memory like presence (a restart
 * drops it; the sender's app then gives up after a while). `game` is the
 * sender's game, with the game code read from their ROM; `gameName` is its
 * name on their shelf, which is all the friend sees of it.
 */
type LinkRequest = {
  id: string;
  from: string;
  to: string;
  game: LinkGame;
  gameName: string;
  createdAt: number;
  /** Set once it has ended. */
  ended?: { at: number } & (
    | { state: "declined" | "timed_out" | "cancelled" }
    | { state: "unavailable"; reason: LinkRequestUnavailable }
  );
};

/** How long an ended link request is still reported to its sender's heartbeat before it's dropped. */
const ENDED_REQUEST_KEPT_MS = 60_000;

/**
 * How often a heartbeat sweeps every player's quiet tabs (see prune). Only
 * housekeeping: presence reads skip tabs older than PRESENCE_TIMEOUT_MS anyway.
 */
const PRUNE_INTERVAL_MS = 30_000;

type ProfileRow = { player_id: string; name: string; friend_code: string; invite_token: string | null };
type ScoreRow = ProfileRow & { rom_hash: string; board: BoardId; value: number; title: string; updated_at: number };

export class SocialDO extends DurableObject<Env> {
  private sql: SqlStorage;
  /**
   * Presence by player, then by tab. In memory, not SQLite: it's refreshed
   * every few seconds, so a restart only costs one heartbeat, and it saves a
   * row write per player per heartbeat.
   */
  private presence = new Map<string, Map<string, TabPresence>>();
  /** When prune last swept every player's tabs. */
  private prunedAt = 0;
  /**
   * Link requests by sender: one each, since a player plugs in with one
   * friend at a time. Pending ones end within LINK_REQUEST_TIMEOUT_MS and
   * ended ones are dropped ENDED_REQUEST_KEPT_MS later (see settleLinkRequests).
   */
  private linkRequests = new Map<string, LinkRequest>();

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
    const rows = (query: string) => this.sql.exec<ProfileRow>(query, playerId).toArray();
    const list = (query: string) => rows(query).map(toProfile);
    const now = Date.now();
    return {
      friends: rows(
        "SELECT p.* FROM friends f JOIN profiles p ON p.player_id = f.friend_id WHERE f.player_id = ? ORDER BY p.name COLLATE NOCASE",
      ).map((row) => ({ ...toProfile(row), presence: this.presenceOf(row.player_id, now) })),
      incoming: list(
        "SELECT p.* FROM friend_requests r JOIN profiles p ON p.player_id = r.from_id WHERE r.to_id = ? ORDER BY r.created_at DESC",
      ),
      outgoing: list(
        "SELECT p.* FROM friend_requests r JOIN profiles p ON p.player_id = r.to_id WHERE r.from_id = ? ORDER BY r.created_at DESC",
      ),
    };
  }

  /**
   * A heartbeat from one of the player's tabs. The reply carries the oldest
   * link request waiting for the player (to a tab in a game only, since only
   * a game can answer it) and the state of the one they sent.
   */
  async setPresence(playerId: string, tabId: string, game: PresenceGame | null, hidden: boolean): Promise<PutPresenceResponse> {
    const now = Date.now();
    let tabs = this.presence.get(playerId);
    if (!tabs) {
      tabs = new Map();
      this.presence.set(playerId, tabs);
    }
    // Re-inserted so the map runs oldest to newest, which settles ties in seenAt.
    tabs.delete(tabId);
    tabs.set(tabId, { game, hidden, seenAt: now });
    // The sender's own quiet tabs go every time; everyone else's every PRUNE_INTERVAL_MS.
    for (const [id, tab] of tabs) {
      if (now - tab.seenAt > PRESENCE_TIMEOUT_MS) tabs.delete(id);
    }
    if (now - this.prunedAt >= PRUNE_INTERVAL_MS) this.prune(now);
    this.settleLinkRequests(now);

    const reply: PutPresenceResponse = {};
    let oldest: LinkRequest | null = null;
    if (game) {
      for (const request of this.linkRequests.values()) {
        // Only a tab in a game that links with the sender's can answer.
        if (request.to !== playerId || request.ended || !canLink(request.game, game)) continue;
        if (!oldest || request.createdAt < oldest.createdAt) oldest = request;
      }
    }
    const from = oldest && this.profileRow(oldest.from);
    if (oldest && from) reply.incoming = { id: oldest.id, from: toProfile(from), gameName: oldest.gameName } satisfies IncomingLinkRequest;
    const sent = this.linkRequests.get(playerId);
    const to = sent && this.profileRow(sent.to);
    if (sent && to) {
      const { ended } = sent;
      const base = { id: sent.id, to: toProfile(to) };
      reply.outgoing = (
        !ended
          ? { ...base, state: "pending" }
          : ended.state === "unavailable"
            ? { ...base, state: "unavailable", reason: ended.reason }
            : { ...base, state: ended.state }
      ) satisfies OutgoingLinkRequest;
    }
    return reply;
  }

  /** What the plug route needs to know about the friend before plugging in (see LinkTarget). */
  async linkTarget(playerId: string, friendId: string): Promise<LinkTarget> {
    const now = Date.now();
    const otherRooms = this.sql
      .exec<{ other: string }>(
        "SELECT CASE WHEN player_a = ?1 THEN player_b ELSE player_a END AS other FROM link_rooms WHERE player_a = ?1 OR player_b = ?1",
        friendId,
      )
      .toArray()
      .map((row) => row.other)
      .filter((other) => other !== playerId);
    const tabs = this.liveTabs(friendId, now);
    const games = tabs.flatMap(({ game, hidden }) => (game ? [{ game, hidden }] : []));
    return { online: tabs.length > 0, games, otherRooms };
  }

  /**
   * The player plugged in with the friend, and the link server took it.
   *
   * - A request from the friend to the player is answered: the link starts
   *   (or the player is now waiting for them), so it's removed, even if it
   *   had just ended.
   * - The player's own earlier request is over, whatever it was.
   * - Anyone else waiting on the player is turned down: they're on the cable now.
   *
   * With `ask` (the player's game, its code read from their ROM), a request
   * to the friend is recorded and its id returned.
   */
  async linkPlugged(playerId: string, friendId: string, ask: LinkGame | null): Promise<string | null> {
    const now = Date.now();
    this.settleLinkRequests(now);
    // Even one that just ended (timed out, say) and they haven't heard yet: they mustn't unplug what starts now.
    if (this.linkRequests.get(friendId)?.to === playerId) this.linkRequests.delete(friendId);
    this.linkRequests.delete(playerId);
    for (const request of this.linkRequests.values()) {
      if (request.to === playerId && !request.ended) request.ended = { at: now, state: "unavailable", reason: "linked" };
    }
    if (!ask) return null;
    // The name the game has on the player's shelf, from their heartbeat.
    let gameName = "a game";
    for (const tab of this.presence.get(playerId)?.values() ?? []) {
      if (tab.game?.romHash === ask.romHash) gameName = tab.game.name;
    }
    const id = crypto.randomUUID();
    this.linkRequests.set(playerId, { id, from: playerId, to: friendId, game: ask, gameName, createdAt: now });
    return id;
  }

  /** The player stopped waiting for the friend (unplugged): their request to them, if still open, is cancelled. */
  async cancelLinkRequest(playerId: string, friendId: string): Promise<void> {
    const request = this.linkRequests.get(playerId);
    if (request?.to === friendId && !request.ended) request.ended = { at: Date.now(), state: "cancelled" };
  }

  /** The player said no to a request sent to them. False if there's no such open request. */
  async declineLinkRequest(playerId: string, id: string): Promise<boolean> {
    const now = Date.now();
    this.settleLinkRequests(now);
    for (const request of this.linkRequests.values()) {
      if (request.id !== id || request.to !== playerId || request.ended) continue;
      request.ended = { at: now, state: "declined" };
      return true;
    }
    return false;
  }

  /**
   * Friends with their raw presence, for the Link panel. Server side only:
   * the ROM hashes and game codes in it must not reach other players.
   */
  async linkCandidates(playerId: string, romHash: string): Promise<LinkCandidates> {
    const now = Date.now();
    const rooms = new Set(
      this.sql
        .exec<{ other: string }>(
          "SELECT CASE WHEN player_a = ?1 THEN player_b ELSE player_a END AS other FROM link_rooms WHERE player_a = ?1 OR player_b = ?1",
          playerId,
        )
        .toArray()
        .map((row) => row.other),
    );
    const friends = this.sql
      .exec<ProfileRow>(
        "SELECT p.* FROM friends f JOIN profiles p ON p.player_id = f.friend_id WHERE f.player_id = ? ORDER BY p.name COLLATE NOCASE",
        playerId,
      )
      .toArray()
      .map((row) => ({
        playerId: row.player_id,
        profile: toProfile(row),
        presence: this.rawPresenceOf(row.player_id, now),
        roomUsed: rooms.has(row.player_id),
      }));
    // The game code of your own game, from the newest of your tabs that has it open.
    let own: TabPresence | null = null;
    for (const tab of this.presence.get(playerId)?.values() ?? []) {
      if (now - tab.seenAt > PRESENCE_TIMEOUT_MS || tab.game?.romHash !== romHash) continue;
      if (!own || tab.seenAt >= own.seenAt) own = tab;
    }
    const gameCode = own?.game?.gameCode;
    return { ...(gameCode ? { gameCode } : {}), friends };
  }

  /** Someone plugged in to this pair's link room: it may hold a seat or a save until it's seen empty. */
  async noteLinkRoom(a: string, b: string): Promise<void> {
    const [first, second] = a < b ? [a, b] : [b, a];
    this.sql.exec(
      `INSERT INTO link_rooms (player_a, player_b, used_at) VALUES (?, ?, ?)
       ON CONFLICT (player_a, player_b) DO UPDATE SET used_at = excluded.used_at`,
      first,
      second,
      Date.now(),
    );
  }

  /**
   * These friends' link rooms with the player were seen empty. A room someone
   * plugged in to since `seenBefore` (while the link server was being asked) is kept.
   */
  async forgetLinkRooms(playerId: string, friendIds: string[], seenBefore: number): Promise<void> {
    for (const friendId of friendIds) {
      const [first, second] = playerId < friendId ? [playerId, friendId] : [friendId, playerId];
      this.sql.exec("DELETE FROM link_rooms WHERE player_a = ? AND player_b = ? AND used_at < ?", first, second, seenBefore);
    }
  }

  /** That tab closed. The player's other tabs keep them online. */
  async clearPresence(playerId: string, tabId: string): Promise<void> {
    const tabs = this.presence.get(playerId);
    if (!tabs) return;
    tabs.delete(tabId);
    if (tabs.size === 0) this.presence.delete(playerId);
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

  /** The player behind a friend code, but only if they're this player's friend. */
  async friendIdByCode(playerId: string, code: string): Promise<string | null> {
    const target = this.playerByCode(code);
    return target && this.isFriend(playerId, target.player_id) ? target.player_id : null;
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

  /** Totals and every profile's name, for the admin page. */
  async adminSummary(): Promise<{
    profiles: { playerId: string; name: string; createdAt: number }[];
    friendships: number;
    pendingRequests: number;
    scores: number;
  }> {
    const count = (table: string) => this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
    return {
      profiles: this.sql
        .exec<{ playerId: string; name: string; createdAt: number }>(
          "SELECT player_id AS playerId, name, created_at AS createdAt FROM profiles",
        )
        .toArray(),
      // Stored once per direction.
      friendships: count("friends") / 2,
      pendingRequests: count("friend_requests"),
      scores: count("scores"),
    };
  }

  /** What the player's newest tab says, as friends see it. */
  private presenceOf(playerId: string, now: number): Presence {
    const presence = this.rawPresenceOf(playerId, now);
    return presence.status === "playing" ? { status: "playing", name: presence.game.name } : presence;
  }

  /** What the player's newest tab says, or offline if no tab has been seen within PRESENCE_TIMEOUT_MS. */
  private rawPresenceOf(playerId: string, now: number): RawPresence {
    const newest = this.newestTab(playerId, now);
    if (!newest) return { status: "offline" };
    return newest.game ? { status: "playing", game: newest.game } : { status: "lobby" };
  }

  /** The player's newest tab, or null if none has been seen within PRESENCE_TIMEOUT_MS. */
  private newestTab(playerId: string, now: number): TabPresence | null {
    let newest: TabPresence | null = null;
    for (const tab of this.presence.get(playerId)?.values() ?? []) {
      if (!newest || tab.seenAt >= newest.seenAt) newest = tab;
    }
    return newest && now - newest.seenAt <= PRESENCE_TIMEOUT_MS ? newest : null;
  }

  /** The player's tabs seen within PRESENCE_TIMEOUT_MS. */
  private liveTabs(playerId: string, now: number): TabPresence[] {
    return [...(this.presence.get(playerId)?.values() ?? [])].filter((tab) => now - tab.seenAt <= PRESENCE_TIMEOUT_MS);
  }

  /**
   * Ends link requests that can't be answered any more, and drops ended ones
   * their sender has had time to hear about. A pending request ends when:
   *
   * - nobody answered within LINK_REQUEST_TIMEOUT_MS (timed_out);
   * - the sender left the game (no tab has it open), so they're not waiting (cancelled);
   * - the friend went offline, has no tab in a game that links with the
   *   sender's, or only has such tabs in the background (unavailable, with
   *   that reason). All their tabs count, as in LinkTarget.
   *
   * The friend's game is matched with the game code from their heartbeat;
   * the plug route checks it against their ROM when they accept.
   */
  private settleLinkRequests(now: number): void {
    for (const [from, request] of this.linkRequests) {
      if (request.ended) {
        if (now - request.ended.at > ENDED_REQUEST_KEPT_MS) this.linkRequests.delete(from);
        continue;
      }
      const end = (ended: NonNullable<LinkRequest["ended"]>) => (request.ended = ended);
      if (now - request.createdAt > LINK_REQUEST_TIMEOUT_MS) {
        end({ at: now, state: "timed_out" });
        continue;
      }
      if (!this.liveTabs(from, now).some((tab) => tab.game?.romHash === request.game.romHash)) {
        end({ at: now, state: "cancelled" });
        continue;
      }
      const tabs = this.liveTabs(request.to, now);
      const inGame = tabs.filter((tab) => tab.game && canLink(request.game, tab.game));
      if (tabs.length === 0) end({ at: now, state: "unavailable", reason: "offline" });
      else if (inGame.length === 0) end({ at: now, state: "unavailable", reason: "not_in_game" });
      else if (inGame.every((tab) => tab.hidden)) end({ at: now, state: "unavailable", reason: "hidden" });
    }
  }

  /**
   * Drops tabs that have gone quiet, so closed tabs that never said goodbye
   * don't pile up. Memory only: every read skips such tabs itself.
   */
  private prune(now: number): void {
    this.prunedAt = now;
    for (const [playerId, tabs] of this.presence) {
      for (const [tabId, tab] of tabs) {
        if (now - tab.seenAt > PRESENCE_TIMEOUT_MS) tabs.delete(tabId);
      }
      if (tabs.size === 0) this.presence.delete(playerId);
    }
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
