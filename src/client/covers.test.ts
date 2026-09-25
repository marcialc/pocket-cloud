import { describe, expect, it } from "vitest";
import { coverFor, parseCoverIndex, sha1Hex } from "./covers";

const index = parseCoverIndex({
  games: {
    f3ae088181bf: ["gba", "Pokemon - Emerald Version (USA, Europe)"],
    "0123456789ab": ["gb", "Kirby's Dream Land (USA, Europe)"],
    bad: ["nes", "Tetris (World)"],
  },
});

describe("box art lookup", () => {
  it("finds a game by its ROM's SHA-1", () => {
    expect(coverFor(index, { sha1: "f3ae088181bf" + "0".repeat(28), fileName: "emerald.gba" })).toBe(
      "/api/covers/gba/Pokemon%20-%20Emerald%20Version%20(USA%2C%20Europe).png",
    );
  });

  it("falls back to a file named after the game", () => {
    expect(coverFor(index, { fileName: "Kirby's Dream Land (USA, Europe).gb" })).toBe(
      "/api/covers/gb/Kirby's%20Dream%20Land%20(USA%2C%20Europe).png",
    );
    expect(coverFor(index, { sha1: "f".repeat(40), fileName: "kirby.gb" })).toBeNull();
  });

  it("skips entries for consoles without box art here", () => {
    expect(coverFor(index, { fileName: "Tetris (World).nes" })).toBeNull();
    expect(parseCoverIndex(null).bySha1.size).toBe(0);
  });

  it("hashes with SHA-1", async () => {
    expect(await sha1Hex(new Uint8Array(4))).toBe("9069ca78e7450a285173431b3e52c5c25299e473");
  });
});
