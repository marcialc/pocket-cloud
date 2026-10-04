import { describe, expect, it } from "vitest";
import { canLink } from "./linkCompat";

const A = "a".repeat(64);
const B = "b".repeat(64);

describe("canLink", () => {
  it("links two copies of the same ROM, whatever the game", () => {
    expect(canLink({ romHash: A, gameCode: "AMKE" }, { romHash: A, gameCode: "AMKE" })).toBe(true);
    // GB/GBC games have no game code.
    expect(canLink({ romHash: A }, { romHash: A })).toBe(true);
  });

  it("links Gen 3 Pokémon games with each other in any region", () => {
    const codes = ["AXVE", "AXPE", "BPEE", "BPRE", "BPGE", "BPEP", "AXVJ", "BPRD"];
    for (const a of codes) {
      for (const b of codes) expect(canLink({ romHash: A, gameCode: a }, { romHash: B, gameCode: b }), `${a} ${b}`).toBe(true);
    }
  });

  it("needs the same ROM for games not in the table, even the same game in the same region", () => {
    expect(canLink({ romHash: A, gameCode: "AMKE" }, { romHash: B, gameCode: "AMKE" })).toBe(false);
    expect(canLink({ romHash: A, gameCode: "AMKE" }, { romHash: B, gameCode: "AMKP" })).toBe(false);
  });

  it("doesn't link a table game with a game outside it, or with no game code", () => {
    expect(canLink({ romHash: A, gameCode: "BPEE" }, { romHash: B, gameCode: "AMKE" })).toBe(false);
    expect(canLink({ romHash: A, gameCode: "BPEE" }, { romHash: B })).toBe(false);
    expect(canLink({ romHash: A }, { romHash: B })).toBe(false);
    expect(canLink({ romHash: A, gameCode: "BPE" }, { romHash: B, gameCode: "BPEE" })).toBe(false);
  });
});
