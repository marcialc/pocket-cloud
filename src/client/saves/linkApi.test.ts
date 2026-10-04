import { unzlibSync, zlibSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { base64ToBytes, bytesToBase64 } from "../../shared/api";
import { LinkError, linkErrorMessage, plugIn, takeLinkSave, unplug } from "./linkApi";

const ROM = "a".repeat(64);

afterEach(() => vi.unstubAllGlobals());

function answer(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => Response.json(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("linkApi", () => {
  it("hands back the save from a link with the game it belongs to", async () => {
    answer({ sram: bytesToBase64(new Uint8Array([1, 2, 3])), romHash: ROM });
    expect(await unplug("ABCD1234")).toEqual({ save: { sram: new Uint8Array([1, 2, 3]), state: null, romHash: ROM }, lost: false });
  });

  it("brings back where the game was left, even when it never saved", async () => {
    const state = bytesToBase64(zlibSync(new Uint8Array([9, 9, 9])));
    answer({ sram: bytesToBase64(new Uint8Array([1])), state, romHash: ROM });
    expect(await takeLinkSave("ABCD1234")).toEqual({ sram: new Uint8Array([1]), state: new Uint8Array([9, 9, 9]), romHash: ROM });
    answer({ sram: bytesToBase64(new Uint8Array(16).fill(0xff)), state, romHash: ROM });
    expect(await takeLinkSave("ABCD1234")).toEqual({ sram: null, state: new Uint8Array([9, 9, 9]), romHash: ROM });
  });

  it("keeps the save when the snapshot doesn't unpack", async () => {
    vi.spyOn(console, "warn").mockImplementationOnce(() => {});
    answer({ sram: bytesToBase64(new Uint8Array([1])), state: bytesToBase64(new Uint8Array([1, 2, 3])), romHash: ROM });
    expect(await takeLinkSave("ABCD1234")).toEqual({ sram: new Uint8Array([1]), state: null, romHash: ROM });
  });

  it("treats a blank save as none: the game never saved during the link", async () => {
    answer({ sram: bytesToBase64(new Uint8Array(131072).fill(0xff)), romHash: ROM });
    expect(await unplug("ABCD1234")).toEqual({ save: null, lost: false });
    answer({ sram: "", romHash: ROM });
    expect(await takeLinkSave("ABCD1234")).toBeNull();
  });

  it("says when the link server lost the saves", async () => {
    answer({ ended: true, saveLost: true });
    expect(await unplug("ABCD1234")).toEqual({ save: null, lost: true });
  });

  it("has no save to pick up when there's none waiting", async () => {
    answer({ error: "not_found" }, 404);
    expect(await takeLinkSave("ABCD1234")).toBeNull();
  });

  it("plugs in with the save, and without one for a new game", async () => {
    const fetchMock = answer({ state: "waiting", slot: 1, friendPluggedIn: false, saveWaiting: null });
    await plugIn("ABCD1234", ROM, new Uint8Array([7]));
    await plugIn("ABCD1234", ROM, null);
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string));
    expect(bodies).toEqual([{ romHash: ROM, sram: bytesToBase64(new Uint8Array([7])) }, { romHash: ROM }]);
  });

  it("plugs in with where the game is, compressed", async () => {
    const fetchMock = answer({ state: "waiting", slot: 1, friendPluggedIn: false, saveWaiting: null });
    await plugIn("ABCD1234", ROM, null, new Uint8Array(1000).fill(3));
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(unzlibSync(base64ToBytes(body.state))).toEqual(new Uint8Array(1000).fill(3));
    expect(body.state.length).toBeLessThan(100);
  });

  it("reports the server's refusal by its code", async () => {
    answer({ error: "rom_not_in_library" }, 409);
    await expect(plugIn("ABCD1234", ROM, null)).rejects.toEqual(new LinkError("rom_not_in_library"));
  });

  it("asks the friend to plug in too, and hands back the request's id", async () => {
    const fetchMock = answer({ state: "waiting", slot: 1, friendPluggedIn: false, saveWaiting: null, requestId: "r-1" });
    expect(await plugIn("ABCD1234", ROM, null, null, true)).toMatchObject({ requestId: "r-1" });
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ romHash: ROM, ask: true });
  });

  it("explains why a friend can't be linked with", () => {
    const fallback = linkErrorMessage(new LinkError("something_new"));
    for (const code of ["friend_offline", "friend_not_in_game", "games_cannot_link", "friend_not_looking", "friend_linked"]) {
      expect(linkErrorMessage(new LinkError(code))).not.toBe(fallback);
    }
  });
});
