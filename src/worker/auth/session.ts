/**
 * Signed session cookie for email sign-in.
 *
 * The cookie holds a small JSON payload plus an HMAC-SHA256 signature made
 * with the SESSION_SECRET Worker secret, so nothing about sessions is stored
 * server side. The `ep` (epoch) field is checked against the player's Durable
 * Object on every request: "sign out everywhere" bumps the epoch there, which
 * invalidates every cookie issued before it.
 *
 * `__Host-` prefix: the browser only accepts it with Secure, Path=/ and no
 * Domain, so it can't be set or overridden by a subdomain. HttpOnly keeps it
 * away from page scripts; SameSite=Lax keeps it off cross-site POST/PUT/DELETE.
 * Chrome refuses `__Host-` on http://localhost, so local dev drops the prefix.
 */

export const SESSION_COOKIE = "__Host-pc_session";
const DEV_SESSION_COOKIE = "pc_session";
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
const MIN_SECRET_LENGTH = 32;

export type Session = {
  /** Player id (names the PlayerSaveDO). */
  pid: string;
  /** Account owner id: SHA-256 of the normalised email. */
  oid: string;
  /** Email, for display only. */
  em: string;
  /** Session epoch the player's DO must still be on. */
  ep: number;
  /** Expiry, ms since epoch. */
  exp: number;
};

/** The configured secret, or null when sign-in is not set up (missing/too short). */
export function sessionSecret(env: Env): string | null {
  const secret = env.SESSION_SECRET;
  return typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

function cookieName(url: string): string {
  const { hostname } = new URL(url);
  return hostname === "localhost" || hostname === "127.0.0.1" ? DEV_SESSION_COOKIE : SESSION_COOKIE;
}

/** Set-Cookie value for a new session on the site `url` belongs to. */
export async function createSessionCookie(
  secret: string,
  session: Omit<Session, "exp">,
  url: string,
  now = Date.now(),
): Promise<string> {
  const payload: Session = { ...session, exp: now + SESSION_MAX_AGE_S * 1000 };
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(body)));
  return `${cookieName(url)}=${body}.${toBase64Url(sig)}; Max-Age=${SESSION_MAX_AGE_S}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export function clearSessionCookie(url: string): string {
  return `${cookieName(url)}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

/**
 * The request's session: `null` when there is no session cookie, `"invalid"`
 * when there is one but it is forged, malformed or expired.
 */
export async function readSession(request: Request, secret: string, now = Date.now()): Promise<Session | "invalid" | null> {
  const value = readCookie(request.headers.get("Cookie"), cookieName(request.url));
  if (value === null) return null;
  const [body, sig, extra] = value.split(".");
  if (!body || !sig || extra !== undefined) return "invalid";

  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64Url(sig);
  } catch {
    return "invalid";
  }
  // crypto.subtle.verify compares in constant time.
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), sigBytes, new TextEncoder().encode(body));
  if (!ok) return "invalid";

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body)));
  } catch {
    return "invalid";
  }
  if (!isSession(payload) || payload.exp <= now) return "invalid";
  return payload;
}

function isSession(v: unknown): v is Session {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.pid === "string" && /^[0-9a-f]{64}$/.test(s.pid) &&
    typeof s.oid === "string" && /^[0-9a-f]{64}$/.test(s.oid) &&
    typeof s.em === "string" &&
    Number.isSafeInteger(s.ep) &&
    Number.isSafeInteger(s.exp)
  );
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("bad base64url");
  const binary = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
