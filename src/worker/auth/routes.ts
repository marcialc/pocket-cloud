import { sha256Hex } from "../../shared/api";
import {
  normalizeCode,
  normalizeEmail,
  type AccountResponse,
  type AuthErrorResponse,
} from "../../shared/auth";
import { json, methodNotAllowed } from "../http";
import { resolvePlayer } from "../identity";
import { sendCodeEmail } from "./email";
import {
  SESSION_MAX_AGE_S,
  clearSessionCookie,
  createSessionCookie,
  readSession,
  sessionSecret,
  type Session,
} from "./session";

/**
 * Email sign-in:
 *
 *   POST /api/auth/request  { email }          emails an 8-character code
 *   POST /api/auth/verify   { email, code }    redeems it, sets the session cookie
 *   GET  /api/auth/me                          { email } or 401
 *   POST /api/auth/logout   { everywhere? }    clears the cookie (and optionally all sessions)
 *
 * Emails and codes are never logged.
 */
export async function handleAuth(request: Request, env: Env, path: string): Promise<Response> {
  const secret = sessionSecret(env);
  if (!secret) {
    console.error(JSON.stringify({ message: "auth disabled: SESSION_SECRET missing or too short" }));
    return json({ error: "auth_unavailable" } satisfies AuthErrorResponse, 503);
  }

  switch (path) {
    case "/api/auth/request":
      return request.method === "POST" ? requestCode(request, env) : methodNotAllowed();
    case "/api/auth/verify":
      return request.method === "POST" ? verifyCode(request, env, secret) : methodNotAllowed();
    case "/api/auth/me":
      return request.method === "GET" ? me(request, env, secret) : methodNotAllowed();
    case "/api/auth/logout":
      return request.method === "POST" ? logout(request, env, secret) : methodNotAllowed();
    default:
      return json({ error: "not_found" }, 404);
  }
}

async function requestCode(request: Request, env: Env): Promise<Response> {
  const limited = await ipLimited(request, env);
  if (limited) return limited;
  const body = await readJson(request);
  if (!body) return error("invalid_body", 400);
  const email = normalizeEmail(body.email);
  if (!email) return error("invalid_email", 400);

  const issued = await authStub(env, await ownerIdFor(email)).issueCode();
  if (!issued.ok) return json({ error: "rate_limited", retryAfter: issued.retryAfter } satisfies AuthErrorResponse, 429);

  try {
    await sendCodeEmail(env, email, issued.code);
  } catch (err) {
    console.error(JSON.stringify({ message: "sign-in email failed", error: String(err) }));
    return error("email_failed", 502);
  }
  // Same answer whether or not the email already has an account.
  return json({ ok: true });
}

async function verifyCode(request: Request, env: Env, secret: string): Promise<Response> {
  const limited = await ipLimited(request, env);
  if (limited) return limited;
  const body = await readJson(request);
  if (!body) return error("invalid_body", 400);
  const email = normalizeEmail(body.email);
  if (!email) return error("invalid_email", 400);
  const code = normalizeCode(body.code);
  if (!code) return error("invalid_code", 400);

  // The browser's anonymous player, adopted as the account's player on first sign-in.
  const candidate = (await resolvePlayer(request))?.playerId ?? null;
  const ownerId = await ownerIdFor(email);
  const result = await authStub(env, ownerId).verifyCode(code, ownerId, candidate);
  if (!result.ok) return error(result.error, result.error === "account_unavailable" ? 409 : 400);

  const cookie = await createSessionCookie(
    secret,
    { pid: result.playerId, oid: ownerId, em: email, ep: result.epoch },
    request.url,
  );
  return json({ email } satisfies AccountResponse, 200, { "Set-Cookie": cookie });
}

async function me(request: Request, env: Env, secret: string): Promise<Response> {
  const session = await activeSession(request, env, secret);
  if (session === "invalid") return json({ error: "signed_out" }, 401, { "Set-Cookie": clearSessionCookie(request.url) });
  if (!session) return error("signed_out", 401);
  // Sliding expiry: renew once the cookie is past half its life, so active players stay signed in.
  const headers: Record<string, string> = {};
  if (session.exp - Date.now() < (SESSION_MAX_AGE_S * 1000) / 2) {
    headers["Set-Cookie"] = await createSessionCookie(
      secret,
      { pid: session.pid, oid: session.oid, em: session.em, ep: session.ep },
      request.url,
    );
  }
  return json({ email: session.em } satisfies AccountResponse, 200, headers);
}

async function logout(request: Request, env: Env, secret: string): Promise<Response> {
  const body = (await readJson(request)) ?? {};
  const session = await activeSession(request, env, secret);
  if (session && session !== "invalid" && body.everywhere === true) {
    await env.PLAYER_SAVE.getByName(`player:${session.pid}`).revokeSessions(session.oid);
  }
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie(request.url) });
}

/** The request's session if it is valid and still on the player's current epoch. */
async function activeSession(request: Request, env: Env, secret: string): Promise<Session | "invalid" | null> {
  const session = await readSession(request, secret);
  if (!session || session === "invalid") return session;
  const ok = await env.PLAYER_SAVE.getByName(`player:${session.pid}`).authorize({
    kind: "session",
    ownerId: session.oid,
    epoch: session.ep,
  });
  return ok ? session : "invalid";
}

/** Per-IP limit on the sign-in endpoints, on top of the per-email limits in AuthDO. */
async function ipLimited(request: Request, env: Env): Promise<Response | null> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.AUTH_LIMITER.limit({ key: ip });
  return success ? null : json({ error: "rate_limited", retryAfter: 60 } satisfies AuthErrorResponse, 429);
}

/** Small JSON object bodies only; also forces a CORS preflight for cross-origin callers. */
async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) return null;
  const text = await request.text();
  if (text.length > 1024) return null;
  try {
    const body: unknown = JSON.parse(text);
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function ownerIdFor(email: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(email));
}

function authStub(env: Env, ownerId: string) {
  return env.AUTH.getByName(`auth:${ownerId}`);
}

function error(code: string, status: number): Response {
  return json({ error: code } satisfies AuthErrorResponse, status);
}
