import { describe, expect, it } from "vitest";
import { formatFriendCode, normalizeFriendCode, normalizeName, pokedexCaught } from "./social";

describe("friend codes", () => {
  it("accepts dashes, spaces and lower case", () => {
    expect(normalizeFriendCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normalizeFriendCode(" ABCD EFGH ")).toBe("ABCDEFGH");
    expect(formatFriendCode("ABCDEFGH")).toBe("ABCD-EFGH");
  });

  it("rejects look-alike characters and wrong lengths", () => {
    expect(normalizeFriendCode("ABCD-EFG0")).toBeNull();
    expect(normalizeFriendCode("ABCD-EFGI")).toBeNull();
    expect(normalizeFriendCode("ABCDEFG")).toBeNull();
    expect(normalizeFriendCode(42)).toBeNull();
  });
});

describe("display names", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeName("  Ash \t Ketchum ")).toBe("Ash Ketchum");
  });

  it("rejects empty, long and control-character names", () => {
    expect(normalizeName("   ")).toBeNull();
    expect(normalizeName("x".repeat(21))).toBeNull();
    expect(normalizeName("x".repeat(20))).toBe("x".repeat(20));
    expect(normalizeName("Ash‮evil")).toBeNull();
    expect(normalizeName(null)).toBeNull();
  });
});

describe("pokedexCaught", () => {
  const OWNED = 0x25a3;

  it("counts the owned flags in a Red/Blue save", () => {
    const sram = new Uint8Array(32 * 1024);
    expect(pokedexCaught("POKEMON BLUE", sram)).toBe(0);
    sram.fill(0xff, OWNED, OWNED + 19);
    expect(pokedexCaught("POKEMON RED", sram)).toBe(151);
  });

  it("ignores the byte after the Pokédex", () => {
    const sram = new Uint8Array(32 * 1024);
    sram[OWNED + 19] = 0xff; // first byte of the "seen" flags
    sram[OWNED + 18] = 0x80; // spare bit past #151
    expect(pokedexCaught("POKEMON RED", sram)).toBe(0);
  });

  it("only reads Red and Blue saves of the right size", () => {
    expect(pokedexCaught("POKEMON YELLOW", new Uint8Array(32 * 1024))).toBeNull();
    expect(pokedexCaught("POKEMON RED", new Uint8Array(8 * 1024))).toBeNull();
  });
});
