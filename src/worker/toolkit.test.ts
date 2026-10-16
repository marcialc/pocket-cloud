import { SELF, env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64, sha256Hex, type PutSaveRequest } from "../shared/api";
import type { AuthDO } from "./durable-objects/AuthDO";
import { allow } from "./toolkit";

const API = "https://example.com/api";
const ROM_HASH = "a".repeat(64);

afterEach(() => vi.restoreAllMocks());

/** The rate-limit bindings are typed in the generated Env only after a typegen run. */
function limiter(name: "SAVES_LIMITER" | "ROMS_LIMITER"): RateLimit {
  return (env as unknown as Record<string, RateLimit>)[name]!;
}

function denyWrites(name: "SAVES_LIMITER" | "ROMS_LIMITER"): void {
  vi.spyOn(limiter(name), "limit").mockResolvedValue({ success: false });
}

async function putBody(): Promise<PutSaveRequest> {
  const sram = new Uint8Array([1, 2, 3]);
  return { gameId: "POKEMON RED", sram: bytesToBase64(sram), sramHash: await sha256Hex(sram), updatedAt: 1_000, baseRevision: null };
}

let ip = 100;

function post(path: string, body: unknown) {
  return SELF.fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": `203.0.113.${++ip}` },
    body: JSON.stringify(body),
  });
}

async function signIn(): Promise<string> {
  const email = `player-${crypto.randomUUID()}@example.com`;
  const stub = env.AUTH.getByName(`auth:${await sha256Hex(new TextEncoder().encode(email))}`);
  await runInDurableObject(stub, (_: AuthDO, state) => state.storage.sql.exec("DELETE FROM code_sends"));
  const send = vi.spyOn(env.EMAIL, "send").mockResolvedValue({ messageId: "test" } as never);
  expect((await post("/auth/request", { email })).status).toBe(200);
  const code = /code is: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec((send.mock.calls.at(-1)![0] as { text: string }).text)![1]!;
  const res = await post("/auth/verify", { email, code });
  expect(res.status).toBe(200);
  return res.headers.get("Set-Cookie")!.split(";")[0]!;
}

describe("allow()", () => {
  it("allows the request when no limiter binding is configured", async () => {
    // Local dev and previews may not have the bindings; a missing one must not
    // start refusing every write.
    expect(await allow({} as unknown as Env, "SAVES_LIMITER", "player")).toBe(true);
    expect(await allow({} as unknown as Env, "ROMS_LIMITER", "player")).toBe(true);
  });

  it("allows the request while the limiter has room", async () => {
    vi.spyOn(limiter("SAVES_LIMITER"), "limit").mockResolvedValue({ success: true });
    expect(await allow(env, "SAVES_LIMITER", "player")).toBe(true);
  });

  it("refuses the request once the limiter is out of room", async () => {
    denyWrites("SAVES_LIMITER");
    expect(await allow(env, "SAVES_LIMITER", "player")).toBe(false);
  });
});

describe("capped routes", () => {
  it("answers 429 on a saves write once the limiter is out of room", async () => {
    denyWrites("SAVES_LIMITER");
    const key = crypto.randomUUID();
    const res = await SELF.fetch(`${API}/saves/${ROM_HASH}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(await putBody()),
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
  });

  it("leaves saves reads uncapped", async () => {
    denyWrites("SAVES_LIMITER");
    const key = crypto.randomUUID();
    // Nothing stored yet, so 404 rather than 429: GET never consults the limiter.
    const res = await SELF.fetch(`${API}/saves/${ROM_HASH}`, { headers: { Authorization: `Bearer ${key}` } });
    expect(res.status).toBe(404);
  });

  it("still stores a save when the limiter has room", async () => {
    vi.spyOn(limiter("SAVES_LIMITER"), "limit").mockResolvedValue({ success: true });
    const key = crypto.randomUUID();
    const res = await SELF.fetch(`${API}/saves/${ROM_HASH}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(await putBody()),
    });
    expect(res.status).toBe(200);
  });

  it("answers 429 on a ROMs upload once the limiter is out of room", async () => {
    denyWrites("ROMS_LIMITER");
    const cookie = await signIn();
    const res = await SELF.fetch(`${API}/roms/${ROM_HASH}?name=red.gb&title=POKEMON%20RED`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(32 * 1024),
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
  });
});
