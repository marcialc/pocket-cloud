import { SELF, env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../shared/api";
import type { AuthDO } from "./durable-objects/AuthDO";

const API = "https://example.com/api";
let ip = 150;

afterEach(() => vi.restoreAllMocks());

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": `203.0.113.${++ip}`, ...headers },
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

function getSettings(cookie: string) {
  return SELF.fetch(`${API}/settings`, { headers: { Cookie: cookie } });
}

function putSettings(cookie: string, body: unknown) {
  return SELF.fetch(`${API}/settings`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const CUSTOM = { up: ["KeyW"], down: ["KeyS"], left: ["KeyA"], right: ["KeyD"], a: ["KeyK"], b: ["KeyJ"], start: ["Enter"], select: [] };

describe("account settings", () => {
  it("needs an email session, not the anonymous key", async () => {
    expect((await SELF.fetch(`${API}/settings`)).status).toBe(401);
    const res = await SELF.fetch(`${API}/settings`, { headers: { Authorization: `Bearer ${crypto.randomUUID()}` } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "sign_in_required" });
  });

  it("starts empty, then round-trips key bindings", async () => {
    const cookie = await signIn();
    expect(await (await getSettings(cookie)).json()).toEqual({ keyBindings: null, platformKeyBindings: null, shelf: null });
    expect((await putSettings(cookie, { keyBindings: CUSTOM })).status).toBe(204);
    expect(await (await getSettings(cookie)).json()).toEqual({ keyBindings: CUSTOM, platformKeyBindings: null, shelf: null });
    const changed = { ...CUSTOM, a: ["Space"] };
    expect((await putSettings(cookie, { keyBindings: changed })).status).toBe(204);
    expect(await (await getSettings(cookie)).json()).toEqual({ keyBindings: changed, platformKeyBindings: null, shelf: null });
  });

  it("keeps each account's settings separate", async () => {
    const a = await signIn();
    const b = await signIn();
    await putSettings(a, { keyBindings: CUSTOM });
    expect(await (await getSettings(b)).json()).toEqual({ keyBindings: null, platformKeyBindings: null, shelf: null });
  });

  it("rejects malformed bindings", async () => {
    const cookie = await signIn();
    for (const keyBindings of [null, [], "KeyZ", { a: "KeyZ" }, { a: [42] }, { "A!": ["KeyZ"] }, { a: ["x".repeat(33)] }]) {
      expect((await putSettings(cookie, { keyBindings })).status).toBe(400);
    }
    expect((await putSettings(cookie, CUSTOM)).status).toBe(400);
    expect(await (await getSettings(cookie)).json()).toEqual({ keyBindings: null, platformKeyBindings: null, shelf: null });
  });

  it("keeps the other platforms' controls beside the Game Boy's, each saved on its own", async () => {
    const cookie = await signIn();
    const platformKeyBindings = { gba: { ...CUSTOM, l: ["KeyA"], r: ["KeyS"] }, psx: { l2: ["Digit1"], r2: ["Digit2"] } };
    expect((await putSettings(cookie, { keyBindings: CUSTOM, platformKeyBindings })).status).toBe(204);
    expect(await (await getSettings(cookie)).json()).toEqual({ keyBindings: CUSTOM, platformKeyBindings, shelf: null });
    // An older client only sends the Game Boy controls; the others stay.
    const changed = { ...CUSTOM, a: ["Space"] };
    expect((await putSettings(cookie, { keyBindings: changed })).status).toBe(204);
    expect(await (await getSettings(cookie)).json()).toEqual({ keyBindings: changed, platformKeyBindings, shelf: null });
    for (const bad of [
      null,
      [],
      { gba: "KeyA" },
      { gba: { l: "KeyA" } },
      { "GBA!": { l: ["KeyA"] } },
      { gb: { a: ["KeyZ"] } }, // the Game Boy's go in keyBindings
      { n64: { a: ["KeyZ"] } }, // not a platform
      { gba: { x: ["KeyZ"] } }, // not a GBA button
    ]) {
      expect((await putSettings(cookie, { platformKeyBindings: bad })).status).toBe(400);
    }
    expect(await (await getSettings(cookie)).json()).toEqual({ keyBindings: changed, platformKeyBindings, shelf: null });
  });

  it("caps a settings body sent without Content-Length", async () => {
    const cookie = await signIn();
    const text = JSON.stringify({ keyBindings: CUSTOM, padding: "x".repeat(70 * 1024) });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
    const res = await SELF.fetch(`${API}/settings`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "payload_too_large" });
    expect(await (await getSettings(cookie)).json()).toEqual({ keyBindings: null, platformKeyBindings: null, shelf: null });
  });

  it("keeps the library shelf beside the controls, each saved on its own", async () => {
    const cookie = await signIn();
    const shelf = { favorites: ["a".repeat(64)], groups: [{ id: "g1", name: "RPGs", roms: ["b".repeat(64)] }] };
    expect((await putSettings(cookie, { shelf })).status).toBe(204);
    expect(await (await getSettings(cookie)).json()).toEqual({ keyBindings: null, platformKeyBindings: null, shelf });
    expect((await putSettings(cookie, { keyBindings: CUSTOM })).status).toBe(204);
    expect(await (await getSettings(cookie)).json()).toEqual({ keyBindings: CUSTOM, platformKeyBindings: null, shelf });
  });

  it("rejects a malformed shelf without saving anything", async () => {
    const cookie = await signIn();
    for (const shelf of [null, [], { favorites: ["x"], groups: [] }, { favorites: [], groups: [{ id: "g1", name: "", roms: [] }] }]) {
      expect((await putSettings(cookie, { shelf })).status).toBe(400);
    }
    expect((await putSettings(cookie, { keyBindings: CUSTOM, shelf: null })).status).toBe(400);
    expect(await (await getSettings(cookie)).json()).toEqual({ keyBindings: null, platformKeyBindings: null, shelf: null });
  });
});
