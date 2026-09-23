import { HASH_PATTERN } from "../shared/api";
import {
  CLIENT_BOARDS,
  INVITE_TOKEN_PATTERN,
  isGameTitle,
  MAX_CLIENT_SCORE,
  isBoardId,
  normalizeFriendCode,
  normalizeName,
  pokedexCaught,
  type AcceptInviteResponse,
  type AddFriendRequest,
  type GamesResponse,
  type InviteResponse,
  type ProfileResponse,
  type PutProfileRequest,
  type PutScoreRequest,
} from "../shared/social";
import type { ScoreInput } from "./durable-objects/SocialDO";
import { json, methodNotAllowed } from "./http";

/**
 * Friends and leaderboards for signed-in players:
 *
 *   GET    /api/social/profile              { profile } (null until the player picks a name)
 *   PUT    /api/social/profile   { name }   create it (with a friend code) or rename it
 *   POST   /api/social/profile/invite       new invite link (the old one stops working)
 *   GET    /api/social/invites/:token       whose invite link it is (no sign-in needed)
 *   POST   /api/social/invites/:token       add them: friends at once
 *   GET    /api/social/friends              friends plus incoming and outgoing requests
 *   POST   /api/social/friends   { code }   ask, or accept if they asked first
 *   DELETE /api/social/friends/:code        unfriend, decline or cancel
 *   GET    /api/social/games                leaderboards for games you and your friends play
 *   GET    /api/social/games/:romHash       one game's leaderboards
 *   PUT    /api/social/scores/:romHash  { board, value, title }   a score the browser watched
 *
 * Everything but /profile and /scores needs a profile first (409 profile_required).
 * Play time and Pokédex boards are filled from uploaded saves, see
 * `recordSaveScores`; only the boards in CLIENT_BOARDS come from the browser.
 */
export async function handleSocial(request: Request, env: Env, url: URL, playerId: string): Promise<Response> {
  const social = socialStub(env);
  const path = url.pathname;

  if (path === "/api/social/profile") {
    switch (request.method) {
      case "GET":
        return json({ profile: await social.getOwnProfile(playerId) } satisfies ProfileResponse);
      case "PUT": {
        const body = await readJson<PutProfileRequest>(request);
        const name = normalizeName(body?.name);
        if (!name) return json({ error: "invalid_name" }, 400);
        return json({ profile: await social.setProfile(playerId, name) } satisfies ProfileResponse);
      }
      default:
        return methodNotAllowed();
    }
  }

  if (path === "/api/social/profile/invite") {
    if (request.method !== "POST") return methodNotAllowed();
    const profile = await social.resetInvite(playerId);
    return profile ? json({ profile } satisfies ProfileResponse) : json({ error: "profile_required" }, 409);
  }

  // Like the save-based boards, recorded before the player has a profile.
  const scoreHash = /^\/api\/social\/scores\/([^/]+)$/.exec(path)?.[1];
  if (scoreHash !== undefined) {
    if (request.method !== "PUT") return methodNotAllowed();
    if (!HASH_PATTERN.test(scoreHash)) return json({ error: "invalid_rom_hash" }, 400);
    const body = await readJson<PutScoreRequest>(request);
    if (!body || !isBoardId(body.board) || !CLIENT_BOARDS.includes(body.board)) return json({ error: "invalid_board" }, 400);
    const value = body.value;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_CLIENT_SCORE) {
      return json({ error: "invalid_value" }, 400);
    }
    if (!isGameTitle(body.title)) return json({ error: "invalid_title" }, 400);
    await social.recordScores(playerId, scoreHash, body.title, [{ board: body.board, value }]);
    return new Response(null, { status: 204 });
  }

  if (!(await social.getProfile(playerId))) return json({ error: "profile_required" }, 409);

  const inviteToken = /^\/api\/social\/invites\/([^/]+)$/.exec(path)?.[1];
  if (inviteToken !== undefined) {
    if (request.method !== "POST") return methodNotAllowed();
    if (!INVITE_TOKEN_PATTERN.test(inviteToken)) return json({ error: "not_found" }, 404);
    const result = await social.acceptInvite(playerId, inviteToken);
    if ("error" in result) {
      const status = result.error === "not_found" ? 404 : result.error === "too_many" ? 403 : 409;
      return json({ error: result.error }, status);
    }
    return json(result satisfies AcceptInviteResponse);
  }

  if (path === "/api/social/friends") {
    switch (request.method) {
      case "GET":
        return json(await social.listFriends(playerId));
      case "POST": {
        const code = normalizeFriendCode((await readJson<AddFriendRequest>(request))?.code);
        if (!code) return json({ error: "invalid_code" }, 400);
        const result = await social.addFriend(playerId, code);
        if ("error" in result) {
          const status = result.error === "not_found" ? 404 : result.error === "too_many" ? 403 : 409;
          return json({ error: result.error }, status);
        }
        return json(result);
      }
      default:
        return methodNotAllowed();
    }
  }

  const friendCode = /^\/api\/social\/friends\/([^/]+)$/.exec(path)?.[1];
  if (friendCode !== undefined) {
    if (request.method !== "DELETE") return methodNotAllowed();
    const code = normalizeFriendCode(decodeURIComponent(friendCode));
    if (!code) return json({ error: "invalid_code" }, 400);
    return (await social.removeFriend(playerId, code)) ? new Response(null, { status: 204 }) : json({ error: "not_found" }, 404);
  }

  if (path === "/api/social/games") {
    if (request.method !== "GET") return methodNotAllowed();
    return json({ games: await social.leaderboards(playerId) } satisfies GamesResponse);
  }

  const gameHash = /^\/api\/social\/games\/([^/]+)$/.exec(path)?.[1];
  if (gameHash !== undefined) {
    if (request.method !== "GET") return methodNotAllowed();
    if (!HASH_PATTERN.test(gameHash)) return json({ error: "invalid_rom_hash" }, 400);
    return json({ games: await social.leaderboards(playerId, gameHash) } satisfies GamesResponse);
  }

  return json({ error: "not_found" }, 404);
}

/**
 * GET /api/social/invites/:token before sign-in, so the invite can say who
 * it's from. Null for any other request (they go through the signed-in routes).
 */
export async function handleInvitePreview(request: Request, env: Env, path: string): Promise<Response | null> {
  const token = /^\/api\/social\/invites\/([^/]+)$/.exec(path)?.[1];
  if (token === undefined || request.method !== "GET") return null;
  const inviter = INVITE_TOKEN_PATTERN.test(token) ? await socialStub(env).inviter(token) : null;
  return inviter ? json({ inviter } satisfies InviteResponse) : json({ error: "not_found" }, 404);
}

/**
 * After an account uploads a save: its play time, and the Pokédex count for
 * Red/Blue, go on the game's leaderboard. Best effort; a failure here never
 * fails the save.
 */
export async function recordSaveScores(
  env: Env,
  playerId: string,
  save: { romHash: string; gameId: string; sram: Uint8Array; playTime?: number },
): Promise<void> {
  const scores: ScoreInput[] = [];
  if (save.playTime !== undefined && save.playTime > 0) scores.push({ board: "playtime", value: save.playTime });
  const caught = pokedexCaught(save.gameId, save.sram);
  if (caught !== null) scores.push({ board: "pokedex", value: caught });
  // Real cartridge titles are plain ASCII; anything else isn't shown to friends.
  if (scores.length === 0 || !isGameTitle(save.gameId)) return;
  try {
    await socialStub(env).recordScores(playerId, save.romHash, save.gameId, scores);
  } catch (err) {
    console.error(JSON.stringify({ message: "could not record leaderboard scores", error: String(err) }));
  }
}

function socialStub(env: Env) {
  return env.SOCIAL.getByName("social");
}

async function readJson<T>(request: Request): Promise<Partial<T> | null> {
  if (Number(request.headers.get("Content-Length") ?? 0) > 1024) return null;
  const text = await request.text();
  if (text.length > 1024) return null;
  try {
    const body: unknown = JSON.parse(text);
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Partial<T>) : null;
  } catch {
    return null;
  }
}
