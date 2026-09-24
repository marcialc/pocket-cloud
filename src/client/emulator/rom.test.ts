import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { detectPlatform, isGameBoyGameId } from "../../shared/platforms";
import { RomError, defaultPalette, displayName, gameIdFromFileName, inspectRom, readHeader } from "./rom";

/** Builds a synthetic GBA ROM with a valid-looking header (no game content). */
function fakeGbaRom({ title = "POKEMON FIRE", code = "BPRE", fixed = 0x96, size = 0x40000 } = {}): ArrayBuffer {
  const bytes = new Uint8Array(size);
  bytes.set([0x24, 0xff, 0xae, 0x51, 0x69, 0x9a, 0xa2, 0x21], 0x04);
  bytes.set(Array.from(title, (c) => c.charCodeAt(0)), 0xa0);
  bytes.set(Array.from(code, (c) => c.charCodeAt(0)), 0xac);
  bytes[0xb2] = fixed;
  return bytes.buffer;
}

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
    const info = await inspectRom(rom, "red.gb");
    expect(info).toMatchObject({ platform: "gb", gameId: "POKEMON RED", title: "POKEMON RED", hasBattery: true, cgb: false, size: 0x8000 });
    expect(info.romHash).toBe(createHash("sha256").update(new Uint8Array(rom)).digest("hex"));
  });

  it("produces different fingerprints for different ROMs", async () => {
    const a = await inspectRom(fakeRom(), "red.gb");
    const b = new Uint8Array(fakeRom());
    b[0x300] = 1;
    expect((await inspectRom(b.buffer, "red.gb")).romHash).not.toBe(a.romHash);
  });

  it("detects carts without battery RAM", async () => {
    expect((await inspectRom(fakeRom({ cartType: 0x01 }), "tetris.gb")).hasBattery).toBe(false);
  });

  it("rejects files that are not Game Boy ROMs", async () => {
    await expect(inspectRom(new ArrayBuffer(100), "red.gb")).rejects.toBeInstanceOf(RomError);
    await expect(inspectRom(new ArrayBuffer(0x8000), "red.gb")).rejects.toThrow(/cartridge header/);
    await expect(inspectRom(new ArrayBuffer(0x8000), "notes.txt")).rejects.toThrow(/not a game ROM/);
  });

  it("maps well-known titles", () => {
    expect(displayName({ title: "POKEMON RED" })).toBe("Pokémon Red");
    expect(displayName({ title: "TETRIS" })).toBe("TETRIS");
    expect(defaultPalette({ title: "POKEMON RED" })).toBe(23);
    expect(defaultPalette({ title: "TETRIS" })).toBeUndefined();
  });
});

describe("platforms", () => {
  it("tells Game Boy from Game Boy Color by the header, whatever the file is called", async () => {
    expect(detectPlatform("game.bin", new Uint8Array(fakeRom()))).toBe("gb");
    expect(detectPlatform("game.gb", new Uint8Array(fakeRom({ cgb: 0xc0 })))).toBe("gbc");
    expect(await inspectRom(fakeRom({ title: "POKEMON_CRY", cgb: 0x80 }), "crystal.gbc")).toMatchObject({ platform: "gbc", cgb: true });
  });

  it("detects the other platforms by header signature or extension", () => {
    const at = (offset: number, text: string, size = 0x8000) => {
      const bytes = new Uint8Array(size);
      bytes.set(Array.from(text, (c) => c.charCodeAt(0)), offset);
      return bytes;
    };
    expect(detectPlatform("x.bin", new Uint8Array(fakeGbaRom()))).toBe("gba");
    expect(detectPlatform("x.bin", at(0, "NES\x1a"))).toBe("nes");
    expect(detectPlatform("x.bin", at(0, "LYNX"))).toBe("lynx");
    expect(detectPlatform("x.bin", at(0x100, "SEGA MEGA DRIVE"))).toBe("genesis");
    const sms = at(0x7ff0, "TMR SEGA");
    expect(detectPlatform("x.bin", sms)).toBe("sms");
    sms[0x7fff] = 0x6c;
    expect(detectPlatform("x.bin", sms)).toBe("gamegear");
    expect(detectPlatform("Chrono Trigger.SFC", new Uint8Array(0x8000))).toBe("snes");
    expect(detectPlatform("game.gg", new Uint8Array(0x8000))).toBe("gamegear");
    expect(detectPlatform("game.chd", new Uint8Array(0x8000))).toBe("psx");
    expect(detectPlatform("readme.txt", new Uint8Array(0x8000))).toBeNull();
  });

  it("reads the GBA header: title at 0xA0, game code at 0xAC", () => {
    expect(readHeader(new Uint8Array(fakeGbaRom()), "gba", "firered.gba")).toMatchObject({
      platform: "gba",
      gameId: "gba:BPRE",
      title: "POKEMON FIRE",
      hasBattery: true,
      size: 0x40000,
    });
    expect(readHeader(new Uint8Array(fakeGbaRom({ code: "\0\0\0\0" })), "gba", "x.gba").gameId).toBe("gba:POKEMON FIRE");
    expect(() => readHeader(new Uint8Array(fakeGbaRom({ fixed: 0 })), "gba", "x.gba")).toThrow(/not a GBA ROM/);
    expect(() => readHeader(new Uint8Array(0x40), "gba", "x.gba")).toThrow(RomError);
  });

  it("plays GBA games and refuses platforms that can't be played yet", async () => {
    expect(await inspectRom(fakeGbaRom(), "firered.gba")).toMatchObject({ platform: "gba", gameId: "gba:BPRE" });
    await expect(inspectRom(new ArrayBuffer(0x8000), "mario.sfc")).rejects.toThrow("SNES games aren't supported yet.");
    // A .gba file without a GBA header is reported as such, not as unsupported.
    await expect(inspectRom(new ArrayBuffer(0x8000), "fake.gba")).rejects.toThrow(/not a GBA ROM/);
  });

  it("names other platforms' games after the file", () => {
    expect(readHeader(new Uint8Array(0x8000), "snes", "Super Metroid (USA).sfc")).toMatchObject({
      platform: "snes",
      gameId: "snes:Super Metroid (USA)",
      title: "Super Metroid (USA)",
      hasBattery: true,
    });
    expect(gameIdFromFileName("roms/sub\\Zelda\u0000 \t  III.smc")).toBe("Zelda III");
    expect(gameIdFromFileName(`${"x".repeat(63)}\u{1f3ae}.nes`)).toBe("x".repeat(63));
    expect(gameIdFromFileName("a".repeat(100) + ".nes")).toHaveLength(64);
    expect(readHeader(new Uint8Array(16), "nes", ".nes").gameId).toBe("nes:UNKNOWN");
    expect(readHeader(new Uint8Array(16), "nes", "a".repeat(100) + ".nes").gameId).toBe(`nes:${"a".repeat(60)}`);
  });

  it("keeps other platforms' gameIds apart from Game Boy header titles", async () => {
    const gb = await inspectRom(fakeRom(), "red.gb");
    expect(gb.gameId).toBe("POKEMON RED");
    expect(isGameBoyGameId(gb.gameId)).toBe(true);
    const nes = readHeader(new Uint8Array(16), "nes", "POKEMON RED.nes");
    expect(nes.gameId).toBe("nes:POKEMON RED");
    expect(isGameBoyGameId(nes.gameId)).toBe(false);
    expect(isGameBoyGameId(readHeader(new Uint8Array(fakeGbaRom()), "gba", "x.gba").gameId)).toBe(false);
    // A Game Boy title with a colon in it is still a Game Boy title.
    expect(isGameBoyGameId("ZELDA: LINK")).toBe(true);
    expect(isGameBoyGameId("constructor:x")).toBe(true);
  });
});
