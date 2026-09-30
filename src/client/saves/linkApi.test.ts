import { afterEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64 } from "../../shared/api";
import { LinkError, plugIn, takeLinkSave, unplug } from "./linkApi";

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
    expect(await unplug("ABCD1234")).toEqual({ save: { sram: new Uint8Array([1, 2, 3]), romHash: ROM }, lost: false });
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

  it("reports the server's refusal by its code", async () => {
    answer({ error: "rom_not_in_library" }, 409);
    await expect(plugIn("ABCD1234", ROM, null)).rejects.toEqual(new LinkError("rom_not_in_library"));
  });
});
