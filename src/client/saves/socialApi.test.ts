import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_GAME_NAME } from "../../shared/shelf";
import { isPresenceGameName } from "../../shared/social";
import { SocialError, clearPresence, declineLinkRequest, presenceName, putPresence } from "./socialApi";

const ROM = "a".repeat(64);

afterEach(() => vi.unstubAllGlobals());

function answer(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => (status === 204 ? new Response(null, { status }) : Response.json(body, { status })));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sent(fetchMock: ReturnType<typeof answer>) {
  return fetchMock.mock.calls.map((call) => {
    const [url, init] = call as unknown as [string, RequestInit];
    return { url, method: init.method, body: JSON.parse(init.body as string), keepalive: init.keepalive === true };
  });
}

describe("presence", () => {
  it("sends the heartbeat with the open game, or none in the lobby", async () => {
    const fetchMock = answer({});
    await putPresence("tab-12345", false, { romHash: ROM, gameCode: "BPEE", name: "Emerald" });
    await putPresence("tab-12345", true, null);
    expect(sent(fetchMock)).toEqual([
      {
        url: "/api/social/presence",
        method: "PUT",
        body: { tabId: "tab-12345", hidden: false, game: { romHash: ROM, gameCode: "BPEE", name: "Emerald" } },
        keepalive: false,
      },
      { url: "/api/social/presence", method: "PUT", body: { tabId: "tab-12345", hidden: true, game: null }, keepalive: false },
    ]);
  });

  it("clears the tab with keepalive, so it goes out while the page closes", async () => {
    const fetchMock = answer(null, 204);
    await clearPresence("tab-12345");
    expect(sent(fetchMock)).toEqual([{ url: "/api/social/presence", method: "DELETE", body: { tabId: "tab-12345" }, keepalive: true }]);
  });

  it("says no to a link request by its id", async () => {
    const fetchMock = answer(null, 204);
    await declineLinkRequest("0f8b1c2e-1111-4222-8333-944445555666");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect([url, init.method]).toEqual(["/api/social/link-requests/0f8b1c2e-1111-4222-8333-944445555666", "DELETE"]);
  });

  it("says when the account has no profile yet", async () => {
    answer({ error: "profile_required" }, 409);
    await expect(putPresence("tab-12345", false, null)).rejects.toEqual(new SocialError("profile_required"));
  });

  it("makes game names the server accepts", () => {
    expect(presenceName("  Ruby   run #2 ")).toBe("Ruby run #2");
    expect(presenceName("Ru​by‮\u0007")).toBe("Ruby");
    expect(presenceName("​ ")).toBe("Unknown game");
    const long = presenceName(`${"x".repeat(MAX_GAME_NAME - 1)}😀`);
    expect(long).toBe("x".repeat(MAX_GAME_NAME - 1));
    for (const name of ["Ruby", long, presenceName("é".repeat(200))]) expect(isPresenceGameName(name)).toBe(true);
  });
});
