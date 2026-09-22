import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RomError, defaultPalette, displayName, inspectRom } from "./rom";

/** Builds a synthetic ROM with a valid-looking header (no game content). */
function fakeRom({ title = "POKEMON RED", cartType = 0x13, size = 0x8000, cgb = 0x00 } = {}): ArrayBuffer {
  const bytes = new Uint8Array(size);
  bytes.set([0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b], 0x104);
  bytes.set(Array.from(title, (c) => c.charCodeAt(0)), 0x134);
  bytes[0x143] = cgb;
  bytes[0x147] = cartType;
  bytes[0x200] = 0x42;
  return bytes.buffer;
}

describe("inspectRom", () => {
  it("parses the header and hashes the whole file locally", async () => {
    const rom = fakeRom();
    const info = await inspectRom(rom);
    expect(info).toMatchObject({ gameId: "POKEMON RED", title: "POKEMON RED", hasBattery: true, cgb: false, size: 0x8000 });
    expect(info.romHash).toBe(createHash("sha256").update(new Uint8Array(rom)).digest("hex"));
  });

  it("produces different fingerprints for different ROMs", async () => {
    const a = await inspectRom(fakeRom());
    const b = new Uint8Array(fakeRom());
    b[0x300] = 1;
    expect((await inspectRom(b.buffer)).romHash).not.toBe(a.romHash);
  });

  it("detects carts without battery RAM", async () => {
    expect((await inspectRom(fakeRom({ cartType: 0x01 }))).hasBattery).toBe(false);
  });

  it("rejects files that are not Game Boy ROMs", async () => {
    await expect(inspectRom(new ArrayBuffer(100))).rejects.toBeInstanceOf(RomError);
    await expect(inspectRom(new ArrayBuffer(0x8000))).rejects.toThrow(/cartridge header/);
  });

  it("maps well-known titles", () => {
    expect(displayName({ title: "POKEMON RED" })).toBe("Pokémon Red");
    expect(displayName({ title: "TETRIS" })).toBe("TETRIS");
    expect(defaultPalette({ title: "POKEMON RED" })).toBe(23);
    expect(defaultPalette({ title: "TETRIS" })).toBeUndefined();
  });
});
