import { SELF, env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64, sha256Hex } from "../shared/api";
import { CODE_ALPHABET } from "../shared/auth";
import { generateCode } from "./auth/code";
import { SESSION_COOKIE, createSessionCookie } from "./auth/session";
import type { AuthDO } from "./durable-objects/AuthDO";

const API = "https://example.com/api";
const ROM_HASH = "a".repeat(64);
let ip = 0;

afterEach(() => vi.restoreAllMocks());

/** Each test gets its own IP so the per-IP limiter doesn't leak between tests. */
function freshIp(): string {
  return `203.0.113.${++ip}`;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": freshIp(), ...headers },
    body: JSON.stringify(body),
  });
}

/** Requests a code over HTTP and returns what the email would have contained. */
async function requestCode(email: string): Promise<string> {
  // Tests sign in to one email repeatedly; skip the 60-second resend wait.
  await runInDurableObject(await authStub(email), (_: AuthDO, state) => state.storage.sql.exec("DELETE FROM code_sends"));
  const send = vi.spyOn(env.EMAIL, "send").mockResolvedValue({ messageId: "test" } as never);
  const res = await post("/auth/request", { email });
  expect(res.status).toBe(200);
  const text = (send.mock.calls.at(-1)![0] as { text: string }).text;
  return /code is: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(text)![1]!;
}

function cookieFrom(res: Response): string {
  const set = res.headers.get("Set-Cookie")!;
  return set.split(";")[0]!;
}

async function signIn(email: string, key?: string): Promise<string> {
  const code = await requestCode(email);
  const res = await post("/auth/verify", { email, code }, key ? { Authorization: `Bearer ${key}` } : {});
  expect(res.status).toBe(200);
  return cookieFrom(res);
}

async function putSave(auth: Record<string, string>, bytes: number[]) {
  const sram = new Uint8Array(bytes);
  return SELF.fetch(`${API}/saves/${ROM_HASH}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({
      gameId: "TEST",
      sram: bytesToBase64(sram),
      sramHash: await sha256Hex(sram),
      updatedAt: 1000,
      baseRevision: null,
    }),
  });
}

function getSave(auth: Record<string, string>) {
  return SELF.fetch(`${API}/saves/${ROM_HASH}`, { headers: auth });
}

function uniqueEmail(): string {
  return `player-${crypto.randomUUID()}@example.com`;
}

function authStub(email: string) {
  return sha256Hex(new TextEncoder().encode(email)).then((id) => env.AUTH.getByName(`auth:${id}`));
}

describe("sign-in codes", () => {
  it("are 8 characters from the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCode();
      expect(code).toHaveLength(8);
      for (const ch of code) expect(CODE_ALPHABET).toContain(ch);
    }
  });

  it("emails a code in the XXXX-XXXX format and sets a secure cookie on verify", async () => {
    const email = uniqueEmail();
    const code = await requestCode(email);
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const res = await post("/auth/verify", { email: `  ${email.toUpperCase()} `, code: code.toLowerCase().replace("-", " ") });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email });
    const set = res.headers.get("Set-Cookie")!;
    expect(set).toContain(`${SESSION_COOKIE}=`);
    for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) expect(set).toContain(flag);

    const me = await SELF.fetch(`${API}/auth/me`, { headers: { Cookie: cookieFrom(res) } });
    expect(await me.json()).toEqual({ email });
  });

  it("can only be used once", async () => {
    const email = uniqueEmail();
    const code = await requestCode(email);
    expect((await post("/auth/verify", { email, code })).status).toBe(200);
    const again = await post("/auth/verify", { email, code });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: "invalid_code" });
  });

  it("locks the code after 5 wrong attempts", async () => {
    const email = uniqueEmail();
    const code = await requestCode(email);
    const wrong = code.startsWith("A") ? "BBBB-BBBB" : "AAAA-AAAA";
    for (let i = 0; i < 4; i++) {
      expect(await (await post("/auth/verify", { email, code: wrong })).json()).toEqual({ error: "invalid_code" });
    }
    expect(await (await post("/auth/verify", { email, code: wrong })).json()).toEqual({ error: "too_many_attempts" });
    // Even the right code is dead now.
    expect((await post("/auth/verify", { email, code })).status).toBe(400);
  });

  it("expires after 10 minutes", async () => {
    const stub = await authStub(uniqueEmail());
    const issued = await stub.issueCode(1_000);
    if (!issued.ok) throw new Error("not issued");
    const result = await stub.verifyCode(issued.code, "f".repeat(64), null, 1_000 + 10 * 60 * 1000);
    expect(result).toEqual({ ok: false, error: "code_expired" });
  });

  it("rate limits per email: one per minute, five per hour", async () => {
    const stub = await authStub(uniqueEmail());
    const t0 = 10_000_000;
    expect((await stub.issueCode(t0)).ok).toBe(true);
    expect(await stub.issueCode(t0 + 30_000)).toEqual({ ok: false, retryAfter: 30 });
    for (let i = 1; i < 5; i++) expect((await stub.issueCode(t0 + i * 61_000)).ok).toBe(true);
    const sixth = await stub.issueCode(t0 + 5 * 61_000);
    expect(sixth.ok).toBe(false);
    expect((await stub.issueCode(t0 + 60 * 60 * 1000 + 1)).ok).toBe(true);
  });

  it("answers 429 over HTTP when the email is rate limited", async () => {
    const email = uniqueEmail();
    await requestCode(email);
    const res = await post("/auth/request", { email });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
  });

  it("stores only a hash of the code", async () => {
    const email = uniqueEmail();
    const code = (await requestCode(email)).replace("-", "");
    const stub = await authStub(email);
    const stored = await runInDurableObject(stub, (_: AuthDO, state) =>
      state.storage.sql.exec<{ code_hash: string }>("SELECT code_hash FROM pending_code").one().code_hash,
    );
    expect(stored).not.toContain(code);
    expect(stored).toBe(await sha256Hex(new TextEncoder().encode(code)));
  });

  it("rejects malformed input", async () => {
    expect((await post("/auth/request", { email: "not-an-email" })).status).toBe(400);
    expect((await post("/auth/verify", { email: uniqueEmail(), code: "0000-0000" })).status).toBe(400);
    const noJson = await SELF.fetch(`${API}/auth/request`, { method: "POST", body: "email=a@b.co" });
    expect(noJson.status).toBe(400);
  });

  it("blocks cross-site requests", async () => {
    const res = await post("/auth/request", { email: uniqueEmail() }, { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("does not reveal whether an email has an account", async () => {
    const known = uniqueEmail();
    await signIn(known);
    vi.restoreAllMocks();
    // Next minute's request for the known email vs a brand new one: same response shape.
    const stub = await authStub(known);
    await runInDurableObject(stub, (_: AuthDO, state) => state.storage.sql.exec("DELETE FROM code_sends"));
    vi.spyOn(env.EMAIL, "send").mockResolvedValue({ messageId: "t" } as never);
    const a = await post("/auth/request", { email: known });
    const b = await post("/auth/request", { email: uniqueEmail() });
    expect([a.status, await a.json()]).toEqual([b.status, await b.json()]);
  });
});

describe("accounts and saves", () => {
  it("adopts the browser's anonymous saves on first sign-in and retires the key", async () => {
    const key = crypto.randomUUID();
    expect((await putSave({ Authorization: `Bearer ${key}` }, [1, 2, 3])).status).toBe(200);

    const cookie = await signIn(uniqueEmail(), key);
    expect((await getSave({ Cookie: cookie })).status).toBe(200);

    const withKey = await getSave({ Authorization: `Bearer ${key}` });
    expect(withKey.status).toBe(401);
    expect(await withKey.json()).toEqual({ error: "key_retired" });
  });

  it("gives a second device the same saves", async () => {
    const email = uniqueEmail();
    const first = await signIn(email, crypto.randomUUID());
    expect((await putSave({ Cookie: first }, [9, 9])).status).toBe(200);

    // Another browser with its own anonymous key signs in to the same email.
    const second = await signIn(email, crypto.randomUUID());
    const save = await getSave({ Cookie: second });
    expect(save.status).toBe(200);
    expect(await save.json()).toMatchObject({ sramSize: 2 });
  });

  it("prefers the session over a key sent alongside it", async () => {
    const cookie = await signIn(uniqueEmail());
    expect((await putSave({ Cookie: cookie, Authorization: `Bearer ${crypto.randomUUID()}` }, [5])).status).toBe(200);
    expect((await getSave({ Cookie: cookie })).status).toBe(200);
  });

  it("rejects forged, tampered and expired cookies without falling back to the key", async () => {
    const key = crypto.randomUUID();
    const cookie = await signIn(uniqueEmail());
    const [name, value] = cookie.split("=") as [string, string];
    const [body, sig] = value.split(".") as [string, string];
    const tampered = `${name}=${body.slice(0, -2)}AA.${sig}`;
    const forged = await createSessionCookie("some-other-secret-0123456789abcdefgh", {
      pid: "a".repeat(64), oid: "b".repeat(64), em: "x@y.co", ep: 1,
    }, API);
    const expired = await createSessionCookie(
      "test-session-secret-0123456789abcdef",
      { pid: "a".repeat(64), oid: "b".repeat(64), em: "x@y.co", ep: 1 },
      API,
      Date.now() - 31 * 24 * 60 * 60 * 1000,
    );
    for (const bad of [tampered, forged.split(";")[0]!, expired.split(";")[0]!]) {
      const res = await getSave({ Cookie: bad, Authorization: `Bearer ${key}` });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "session_invalid" });
      expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
    }
  });

  it("signs out one browser, or every browser", async () => {
    const email = uniqueEmail();
    const a = await signIn(email);
    const b = await signIn(email);

    const out = await post("/auth/logout", {}, { Cookie: a });
    expect(out.headers.get("Set-Cookie")).toContain("Max-Age=0");
    // Plain sign-out only clears this browser's cookie; the other is untouched.
    expect((await SELF.fetch(`${API}/auth/me`, { headers: { Cookie: b } })).status).toBe(200);

    await post("/auth/logout", { everywhere: true }, { Cookie: b });
    for (const cookie of [a, b]) {
      expect((await SELF.fetch(`${API}/auth/me`, { headers: { Cookie: cookie } })).status).toBe(401);
      expect((await getSave({ Cookie: cookie })).status).toBe(401);
    }
    // Signing in again works and sees the same account.
    const c = await signIn(email);
    expect((await SELF.fetch(`${API}/auth/me`, { headers: { Cookie: c } })).status).toBe(200);
  });

  it("never lets a second account take over a claimed player", async () => {
    const key = crypto.randomUUID();
    const first = await signIn(uniqueEmail(), key);
    await putSave({ Cookie: first }, [7]);
    // Someone else signs in presenting the same (now retired) key.
    const other = await signIn(uniqueEmail(), key);
    expect((await getSave({ Cookie: other })).status).toBe(404);
  });

  it("reports signed out without a cookie", async () => {
    expect((await SELF.fetch(`${API}/auth/me`)).status).toBe(401);
  });
});
