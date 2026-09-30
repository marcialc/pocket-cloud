import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAccount, signOut, verifySignInCode } from "./authApi";

const EMAIL = "player@example.com";

let store: Map<string, string>;
/** What /api/auth/me answers: an email (200), a status, or "offline" (fetch rejects). */
let me: string | number | "offline";

beforeEach(() => {
  store = new Map();
  me = EMAIL;
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === "/api/auth/verify") return Response.json({ email: EMAIL });
    if (url === "/api/auth/logout") return new Response(null, { status: 204 });
    expect(url).toBe("/api/auth/me");
    if (me === "offline") throw new TypeError("offline");
    if (typeof me === "number") return Response.json({ error: "x" }, { status: me });
    return Response.json({ email: me });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchAccount", () => {
  it("keeps a signed-in player signed in while the server can't be reached", async () => {
    expect(await fetchAccount()).toBe(EMAIL);
    me = "offline";
    expect(await fetchAccount()).toBe(EMAIL);
    me = 503;
    expect(await fetchAccount()).toBe(EMAIL);
  });

  it("remembers the account from sign-in", async () => {
    me = "offline";
    await verifySignInCode(EMAIL, "123456");
    expect(await fetchAccount()).toBe(EMAIL);
  });

  it("is signed out offline when never signed in", async () => {
    me = "offline";
    expect(await fetchAccount()).toBeNull();
  });

  it("forgets the account when the server says signed out", async () => {
    await fetchAccount();
    me = 401;
    expect(await fetchAccount()).toBeNull();
    me = "offline";
    expect(await fetchAccount()).toBeNull();
  });

  it("forgets the account on sign-out", async () => {
    await fetchAccount();
    await signOut(false);
    me = "offline";
    expect(await fetchAccount()).toBeNull();
  });
});
