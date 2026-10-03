/**
 * Cloudflare Access in front of the admin routes. Access sits on
 * pocketcloud.app/admin* and /api/admin/* (Zero Trust → Access → "Pocket Cloud
 * admin") and adds a signed token to every request it lets through, in the
 * Cf-Access-Jwt-Assertion header. Checking it here means a request that didn't
 * come through Access (the workers.dev URL, say) is refused too.
 *
 * ACCESS_TEAM_DOMAIN and ACCESS_AUD (the application's audience tag) are vars
 * in wrangler.jsonc. Local dev (localhost) has no Access in front and skips this.
 */

type AccessJwk = JsonWebKey & { kid: string };
type AccessClaims = { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string };

const CERTS_TTL_MS = 60 * 60 * 1000;
let certs: { team: string; keys: AccessJwk[]; fetchedAt: number } | null = null;

export type AccessResult = { ok: true } | { ok: false; error: "access_required" | "access_not_configured" };

export async function verifyAccess(request: Request, env: Env, now = Date.now()): Promise<AccessResult> {
  const { hostname } = new URL(request.url);
  if (hostname === "localhost" || hostname === "127.0.0.1") return { ok: true };
  const team = env.ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD;
  if (!team || !aud) {
    console.error(JSON.stringify({ message: "admin refused: ACCESS_TEAM_DOMAIN or ACCESS_AUD missing" }));
    return { ok: false, error: "access_not_configured" };
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  const claims = token ? await verifyToken(token, team, now) : null;
  if (!claims) return { ok: false, error: "access_required" };
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const valid =
    audiences.includes(aud) &&
    claims.iss === `https://${team}` &&
    typeof claims.exp === "number" &&
    claims.exp * 1000 > now &&
    (claims.nbf === undefined || claims.nbf * 1000 <= now + 60_000);
  return valid ? { ok: true } : { ok: false, error: "access_required" };
}

/** The token's claims if its RS256 signature is from one of the team's keys, else null. */
async function verifyToken(token: string, team: string, now: number): Promise<AccessClaims | null> {
  const [headerPart, payloadPart, signaturePart, extra] = token.split(".");
  if (!headerPart || !payloadPart || !signaturePart || extra !== undefined) return null;
  let header: { alg?: string; kid?: string };
  let claims: AccessClaims;
  let signature: Uint8Array;
  try {
    header = JSON.parse(new TextDecoder().decode(fromBase64Url(headerPart)));
    claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadPart)));
    signature = fromBase64Url(signaturePart);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;

  let jwk = (await teamKeys(team, now, false)).find((k) => k.kid === header.kid);
  // Access rotates its keys; a kid we haven't seen may be a new one.
  jwk ??= (await teamKeys(team, now, true)).find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  return ok ? claims : null;
}

async function teamKeys(team: string, now: number, refresh: boolean): Promise<AccessJwk[]> {
  if (!refresh && certs && certs.team === team && now - certs.fetchedAt < CERTS_TTL_MS) return certs.keys;
  const response = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!response.ok) return certs?.team === team ? certs.keys : [];
  const { keys } = await response.json<{ keys?: AccessJwk[] }>();
  certs = { team, keys: keys ?? [], fetchedAt: now };
  return certs.keys;
}

function fromBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("bad base64url");
  const binary = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
