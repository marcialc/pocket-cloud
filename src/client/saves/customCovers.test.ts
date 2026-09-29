import { afterEach, describe, expect, it } from "vitest";
import { closeCoversDb, deleteCustomCover, listCustomCovers, putCustomCover } from "./customCovers";

const A = "a".repeat(64);
const B = "b".repeat(64);

describe("custom covers", () => {
  afterEach(async () => {
    for (const c of await listCustomCovers()) await deleteCustomCover(c.romHash);
    await closeCoversDb();
  });

  it("keeps one image per game, and deletes it", async () => {
    await putCustomCover({ romHash: A, data: new Uint8Array([1, 2]).buffer, type: "image/jpeg" });
    await putCustomCover({ romHash: A, data: new Uint8Array([3]).buffer, type: "image/jpeg" });
    await putCustomCover({ romHash: B, data: new Uint8Array([4]).buffer, type: "image/png" });
    const all = await listCustomCovers();
    expect(all.map((c) => [c.romHash, [...new Uint8Array(c.data)], c.type])).toEqual([
      [A, [3], "image/jpeg"],
      [B, [4], "image/png"],
    ]);
    await deleteCustomCover(A);
    expect((await listCustomCovers()).map((c) => c.romHash)).toEqual([B]);
  });
});
