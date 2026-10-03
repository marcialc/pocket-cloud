import { SELF, env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminStatsResponse } from "../shared/admin";
import { bytesToBase64, sha256Hex } from "../shared/api";
import type { AuthDO } from "./durable-objects/AuthDO";
import type { StatsDO } from "./durable-objects/StatsDO";

const API = "https://example.com/api";
const DAY = 24 * 60 * 60 * 1000;
// ADMIN_PLAYER_IDS in vitest.config.ts is this key's player.
const ADMIN_KEY = "0a0a0a0a-0000-4000-8000-00000000ad01";
let ip = 120;

afterEach(() => vi.restoreAllMocks());

// Stand-in for the Access team's signing key; its public half is served as the team's certs.
const TEAM = "pocket-test.cloudflareaccess.com";
const AUD = "test-access-aud";
const KID = "test-kid";
let signingKey: CryptoKey;
let publicJwk: JsonWebKey;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  signingKey = pair.privateKey;
  publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
});

beforeEach(() => {
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `https://${TEAM}/cdn-cgi/access/certs`) return Promise.resolve(Response.json({ keys: [{ ...publicJwk, kid: KID }] }));
    return realFetch(input, init);
  });
});

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A Cf-Access-Jwt-Assertion like the one Access adds, with claims overridden as given. */
async function accessToken(claims: Record<string, unknown> = {}, key: CryptoKey = signingKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const encode = (v: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(v)));
  const body = `${encode({ alg: "RS256", kid: KID, typ: "JWT" })}.${encode({
    aud: [AUD],
    iss: `https://${TEAM}`,
    email: "admin@example.com",
    iat: now,
    nbf: now,
    exp: now + 600,
    ...claims,
  })}`;
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(body)));
  return `${body}.${base64Url(signature)}`;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": `198.51.100.${++ip}`, ...headers },
    body: JSON.stringify(body),
  });
}

/** Signs in a new email; with `key`, its anonymous player becomes the account's. */
async function signIn(key?: string): Promise<string> {
  const email = `player-${crypto.randomUUID()}@example.com`;
  const stub = env.AUTH.getByName(`auth:${await sha256Hex(new TextEncoder().encode(email))}`);
  await runInDurableObject(stub, (_: AuthDO, state) => state.storage.sql.exec("DELETE FROM code_sends"));
  const send = vi.spyOn(env.EMAIL, "send").mockResolvedValue({ messageId: "test" } as never);
  expect((await post("/auth/request", { email })).status).toBe(200);
  const code = /code is: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec((send.mock.calls.at(-1)![0] as { text: string }).text)![1]!;
  const res = await post("/auth/verify", { email, code }, key ? { Authorization: `Bearer ${key}` } : {});
  expect(res.status).toBe(200);
  return res.headers.get("Set-Cookie")!.split(";")[0]!;
}

let adminCookie: string | undefined;
async function admin(): Promise<string> {
  adminCookie ??= await signIn(ADMIN_KEY);
  return adminCookie;
}

async function stats(cookie: string, days = 30) {
  return SELF.fetch(`${API}/admin/stats?days=${days}`, { headers: { Cookie: cookie, "Cf-Access-Jwt-Assertion": await accessToken() } });
}

async function putSave(auth: { Cookie: string } | { Authorization: string }, gameId: string) {
  const sram = crypto.getRandomValues(new Uint8Array(64));
  const res = await SELF.fetch(`${API}/saves/${await sha256Hex(sram)}`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ gameId, sram: bytesToBase64(sram), sramHash: await sha256Hex(sram), updatedAt: Date.now(), baseRevision: null }),
  });
  expect(res.status).toBe(200);
}

describe("admin access", () => {
  it("needs a valid Cloudflare Access token before anything else", async () => {
    const cookie = await admin();
    const refused = async (headers: Record<string, string>) => {
      const res = await SELF.fetch(`${API}/admin/stats`, { headers: { Cookie: cookie, ...headers } });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "access_required" });
    };
    await refused({});
    await refused({ "Cf-Access-Jwt-Assertion": "not.a.token" });
    await refused({ "Cf-Access-Jwt-Assertion": await accessToken({ aud: ["another-app"] }) });
    await refused({ "Cf-Access-Jwt-Assertion": await accessToken({ iss: "https://someone-else.cloudflareaccess.com" }) });
    await refused({ "Cf-Access-Jwt-Assertion": await accessToken({ exp: Math.floor(Date.now() / 1000) - 1 }) });
    const forged = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      false,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    await refused({ "Cf-Access-Jwt-Assertion": await accessToken({}, forged.privateKey) });
    // A tampered payload breaks the signature.
    const [head, , sig] = (await accessToken()).split(".");
    const payload = base64Url(new TextEncoder().encode(JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, exp: 9e9 })));
    await refused({ "Cf-Access-Jwt-Assertion": `${head}.${payload}.${sig}` });

    expect((await SELF.fetch(`${API}/admin/stats`, { headers: { Cookie: cookie, "Cf-Access-Jwt-Assertion": await accessToken() } })).status).toBe(200);
  });

  it("then needs a signed-in admin", async () => {
    const access = { "Cf-Access-Jwt-Assertion": await accessToken() };
    expect((await SELF.fetch(`${API}/admin/stats`, { headers: access })).status).toBe(401);
    const anonymous = await SELF.fetch(`${API}/admin/stats`, { headers: { ...access, Authorization: `Bearer ${crypto.randomUUID()}` } });
    expect(anonymous.status).toBe(403);
    expect(await anonymous.json()).toEqual({ error: "sign_in_required" });

    const res = await stats(await signIn());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_admin", playerId: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("lets an admin read the stats, for 7, 30 or 90 days only", async () => {
    const cookie = await admin();
    const res = await stats(cookie, 7);
    expect(res.status).toBe(200);
    expect((await res.json<AdminStatsResponse>()).daily).toHaveLength(7);
    expect((await stats(cookie, 12)).status).toBe(400);
    expect((await SELF.fetch(`${API}/admin/nope`, { headers: { Cookie: cookie, "Cf-Access-Jwt-Assertion": await accessToken() } })).status).toBe(404);
  });
});

describe("admin stats", () => {
  it("counts sign-ups, saves, games and players, with display names and no emails", async () => {
    const cookie = await admin();
    const before = await (await stats(cookie)).json<AdminStatsResponse>();

    const player = await signIn();
    const profile = await SELF.fetch(`${API}/social/profile`, {
      method: "PUT",
      headers: { Cookie: player, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ash" }),
    });
    expect(profile.status).toBe(200);
    const game = `ADMIN ${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    await putSave({ Cookie: player }, game);
    await putSave({ Authorization: `Bearer ${crypto.randomUUID()}` }, game);
    await putSave({ Cookie: player }, "gba:BPRE");

    await vi.waitFor(async () => {
      const after = await (await stats(cookie)).json<AdminStatsResponse>();
      const today = after.daily.at(-1)!;
      const todayBefore = before.daily.at(-1)!;
      expect(today.signUps).toBe(todayBefore.signUps + 1);
      expect(today.savesSynced).toBe(todayBefore.savesSynced + 3);
      expect(after.games.find((g) => g.gameId === game)).toMatchObject({ platform: "gb", players: 2, saves: 2 });
      expect(after.platforms.find((p) => p.platform === "gba")?.players).toBeGreaterThanOrEqual(1);
      expect(after.social.profiles).toBe(before.social.profiles + 1);
      const ash = after.players.find((p) => p.name === "Ash");
      expect(ash).toMatchObject({ kind: "account", savesSynced: 2 });
      expect(after.totals.anonymous).toBeGreaterThan(before.totals.anonymous);
      expect(JSON.stringify(after)).not.toContain("@example.com");
    });
  });

  it("counts ROM uploads and shows each player's library size", async () => {
    const cookie = await admin();
    const player = await signIn();
    const rom = crypto.getRandomValues(new Uint8Array(1024));
    const res = await SELF.fetch(`${API}/roms/${await sha256Hex(rom)}?name=game.gb&title=GAME`, {
      method: "PUT",
      headers: { Cookie: player, "Content-Type": "application/octet-stream" },
      body: rom,
    });
    expect(res.status).toBe(200);

    await vi.waitFor(async () => {
      const after = await (await stats(cookie)).json<AdminStatsResponse>();
      expect(after.daily.at(-1)!.romUploads).toBeGreaterThanOrEqual(1);
      expect(after.storage.roms).toBeGreaterThanOrEqual(1);
      expect(after.players.some((p) => p.roms === 1 && p.romBytes === 1024 && p.kind === "account")).toBe(true);
    });
  });
});

describe("StatsDO", () => {
  const stub = () => env.STATS.getByName(`stats-test-${crypto.randomUUID()}`);

  it("fills every day of the range and counts each active player once a day", async () => {
    const stats = stub();
    const now = Date.parse("2026-03-10T12:00:00Z");
    await stats.seen("p1", "anonymous", now - 2 * DAY);
    await stats.seen("p1", "anonymous", now);
    await stats.seen("p1", "anonymous", now + 1000);
    await stats.seen("p2", "anonymous", now);
    await stats.signedIn("p2", true, now);
    await stats.signedIn("p2", false, now);

    const report = await stats.report(7, 10, now);
    expect(report.daily.map((d) => d.day)).toEqual([
      "2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10",
    ]);
    expect(report.daily.at(-1)).toMatchObject({ activePlayers: 2, signUps: 1, signIns: 2 });
    expect(report.daily.at(-3)).toMatchObject({ activePlayers: 1, signUps: 0 });
    expect(report.totals).toEqual({ players: 2, accounts: 1, anonymous: 1, active1d: 2, active7d: 2, active30d: 2 });
    expect(report.trackingSince).toBe(now - 2 * DAY);
    expect(report.players.find((p) => p.player_id === "p2")).toMatchObject({ kind: "account", signed_up_at: now });
  });

  it("never turns an account back into an anonymous player", async () => {
    const stats = stub();
    await stats.signedIn("p1", true, 1_000);
    await stats.saveSynced("p1", "anonymous", "TETRIS", 2_000);
    expect((await stats.report(1, 10, 2_000)).players[0]).toMatchObject({ kind: "account", last_seen: 2_000, saves_synced: 1 });
  });

  it("drops the per-day active lists after the retention period", async () => {
    const stats = stub();
    const now = Date.parse("2026-06-01T00:00:00Z");
    await stats.seen("old", "anonymous", now - 120 * DAY);
    await stats.seen("new", "anonymous", now);
    const rows = await runInDurableObject(stats, (_: StatsDO, state) =>
      state.storage.sql.exec<{ player_id: string }>("SELECT player_id FROM daily_active").toArray(),
    );
    expect(rows.map((r) => r.player_id)).toEqual(["new"]);
  });
});
