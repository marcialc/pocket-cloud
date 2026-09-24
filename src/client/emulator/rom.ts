import { MAX_ROM_BYTES, sha256Hex } from "../../shared/api";
import { GB_LOGO_PREFIX, MAX_GAME_ID, PLATFORMS, detectPlatform, platformGameId, type PlatformId } from "../../shared/platforms";

/** What the app knows about a ROM: its platform, header details and fingerprint. */
export type RomInfo = {
  platform: PlatformId;
  /**
   * Stable, human-readable identifier: the header title on the Game Boy (e.g.
   * "POKEMON RED"); elsewhere the platform id and the game code on the GBA
   * ("gba:BPRE") or the file name ("nes:Tetris"). At most 64 characters.
   */
  gameId: string;
  title: string;
  /** SHA-256 of the full ROM, computed locally. Identifies saves; the ROM itself never leaves the device. */
  romHash: string;
  /** Game Boy cartridge type (header 0x147); 0 on other platforms. */
  cartridgeType: number;
  /** Unknown on platforms without a header that says; true there. */
  hasBattery: boolean;
  /** Game Boy Color game; false on other platforms. */
  cgb: boolean;
  size: number;
};

const MIN_ROM_SIZE = 0x8000;
const MAX_GB_ROM_SIZE = 8 * 1024 * 1024;
const GBA_HEADER_SIZE = 0xc0;
const NINTENDO_LOGO_START = 0x104;
const BATTERY_CART_TYPES = new Set([0x03, 0x06, 0x09, 0x0d, 0x0f, 0x10, 0x13, 0x1b, 0x1e, 0x22, 0xff]);

export class RomError extends Error {}

/** Detects the platform from the file name and header, then reads the header. */
export async function inspectRom(rom: ArrayBuffer, fileName: string): Promise<RomInfo> {
  const bytes = new Uint8Array(rom);
  const platform = detectPlatform(fileName, bytes);
  if (!platform) throw new RomError("That file is not a game ROM we recognize.");
  const header = readHeader(bytes, platform, fileName);
  if (!PLATFORMS[platform].enabled) throw new RomError(`${PLATFORMS[platform].shortName} games aren't supported yet.`);
  return { ...header, romHash: await sha256Hex(bytes) };
}

/** Reads (and checks) the header of a ROM for `platform`. Throws RomError if it isn't one. */
export function readHeader(bytes: Uint8Array, platform: PlatformId, fileName: string): Omit<RomInfo, "romHash"> {
  switch (platform) {
    case "gb":
    case "gbc":
      return readGameBoyHeader(bytes);
    case "gba":
      return readGbaHeader(bytes);
    default: {
      if (bytes.length === 0 || bytes.length > MAX_ROM_BYTES) {
        throw new RomError(`That file is not a ${PLATFORMS[platform].name} ROM (unexpected size).`);
      }
      const name = gameIdFromFileName(fileName);
      return {
        platform,
        gameId: platformGameId(platform, name || "UNKNOWN"),
        title: name || "Unknown game",
        cartridgeType: 0,
        hasBattery: true,
        cgb: false,
        size: bytes.length,
      };
    }
  }
}

/** Cartridge header at 0x0100-0x014F. */
function readGameBoyHeader(bytes: Uint8Array): Omit<RomInfo, "romHash"> {
  if (bytes.length < MIN_ROM_SIZE || bytes.length > MAX_GB_ROM_SIZE) {
    throw new RomError("That file is not a Game Boy ROM (unexpected size).");
  }
  if (!GB_LOGO_PREFIX.every((b, i) => bytes[NINTENDO_LOGO_START + i] === b)) {
    throw new RomError("That file is not a Game Boy ROM (missing cartridge header).");
  }
  const cgbFlag = bytes[0x143]!;
  const cgb = cgbFlag === 0x80 || cgbFlag === 0xc0;
  // Title is 16 bytes, or 11/15 on CGB-era carts where the tail holds other fields.
  const title = asciiField(bytes.subarray(0x134, cgb ? 0x143 : 0x144));
  const cartridgeType = bytes[0x147]!;
  return {
    platform: cgb ? "gbc" : "gb",
    gameId: title || "UNKNOWN",
    title: title || "Unknown game",
    cartridgeType,
    hasBattery: BATTERY_CART_TYPES.has(cartridgeType),
    cgb,
    size: bytes.length,
  };
}

/** Cartridge header at 0x00-0xBF: 12-byte title at 0xA0, 4-byte game code at 0xAC, 0x96 at 0xB2. */
function readGbaHeader(bytes: Uint8Array): Omit<RomInfo, "romHash"> {
  if (bytes.length < GBA_HEADER_SIZE || bytes.length > MAX_ROM_BYTES) {
    throw new RomError("That file is not a GBA ROM (unexpected size).");
  }
  if (bytes[0xb2] !== 0x96) throw new RomError("That file is not a GBA ROM (missing cartridge header).");
  const title = asciiField(bytes.subarray(0xa0, 0xac));
  const code = asciiField(bytes.subarray(0xac, 0xb0));
  return {
    platform: "gba",
    // The game code (e.g. "BPRE") tells apart games whose titles match, like regional releases.
    gameId: platformGameId("gba", code || title || "UNKNOWN"),
    title: title || "Unknown game",
    cartridgeType: 0,
    // Save type (SRAM, flash, EEPROM) isn't in the header.
    hasBattery: true,
    cgb: false,
    size: bytes.length,
  };
}

/** Printable ASCII up to the first NUL, trimmed. */
function asciiField(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes)
    .replace(/\0.*$/s, "")
    .replace(/[^\x20-\x7e]/g, "")
    .trim();
}

/** A save name from a file name: no extension or invisible characters, at most 64 characters. */
export function gameIdFromFileName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
  return base
    .replace(/\p{C}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_GAME_ID)
    // Don't leave half of a character cut at the end.
    .replace(/[\ud800-\udbff]$/, "")
    .trim();
}

/** Friendly display name for well-known titles. */
export function displayName(info: Pick<RomInfo, "title">): string {
  const known: Record<string, string> = {
    "POKEMON RED": "Pokémon Red",
    "POKEMON BLUE": "Pokémon Blue",
    "POKEMON YELLOW": "Pokémon Yellow",
  };
  return known[info.title] ?? info.title;
}

/** binjgb built-in palette that matches the Game Boy Color's automatic colourisation. */
export function defaultPalette(info: Pick<RomInfo, "title">): number | undefined {
  const palettes: Record<string, number> = { "POKEMON RED": 23, "POKEMON BLUE": 21, "POKEMON GREEN": 24 };
  return palettes[info.title];
}
