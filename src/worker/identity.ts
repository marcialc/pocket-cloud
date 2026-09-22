import { sha256Hex } from "../shared/api";
import { readSession, sessionSecret, type Session } from "./auth/session";
import type { PlayerAccess } from "./durable-objects/PlayerSaveDO";

/**
 * MVP anonymous identity.
 *
 * The browser generates a random UUID ("player key") and sends it as a bearer
 * token. The key is a secret: anyone holding it can read and write that
 * player's saves, which is also how a player restores their saves in another
 * browser. The Durable Object is named after a hash of the key so the secret
 * itself is never used as an identifier or logged.
 *
 * To add real authentication later, replace this function (e.g. verify a
 * session cookie / JWT and return the account id). Nothing else changes.
 */
export type Player = { playerId: string };

const KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function resolvePlayer(request: Request): Promise<Player | null> {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/.exec(header);
  if (!match || !KEY_PATTERN.test(match[1]!)) return null;
  const playerId = await sha256Hex(new TextEncoder().encode(match[1]!.toLowerCase()));
  return { playerId };
}

export type Identity = { playerId: string; access: PlayerAccess; session: Session | null };

/**
 * Who is calling: an email session (cookie) wins over the anonymous key. A
 * session cookie that fails verification is an error, not a silent fallback
 * to the key, so an expired sign-in never writes into an anonymous player.
 * The caller must still ask the player's DO to `authorize` the access.
 */
export async function authenticate(request: Request, env: Env): Promise<Identity | { error: "unauthorized" | "session_invalid" }> {
  const secret = sessionSecret(env);
  if (secret) {
    const session = await readSession(request, secret);
    if (session === "invalid") return { error: "session_invalid" };
    if (session) {
      return { playerId: session.pid, access: { kind: "session", ownerId: session.oid, epoch: session.ep }, session };
    }
  }
  const player = await resolvePlayer(request);
  return player ? { playerId: player.playerId, access: { kind: "key" }, session: null } : { error: "unauthorized" };
}
