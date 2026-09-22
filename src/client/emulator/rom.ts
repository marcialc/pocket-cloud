import { sha256Hex } from "../../shared/api";

/** Parsed cartridge header (0x0100-0x014F). */
export type RomInfo = {
  /** Stable, human-readable identifier derived from the header title, e.g. "POKEMON RED". */
  gameId: string;
  title: string;
  /** SHA-256 of the full ROM, computed locally. Identifies saves; the ROM itself never leaves the device. */
  romHash: string;
  cartridgeType: number;
  hasBattery: boolean;
  cgb: boolean;
  size: number;
};

const MIN_ROM_SIZE = 0x8000;
const MAX_ROM_SIZE = 8 * 1024 * 1024;
const NINTENDO_LOGO_START = 0x104;
// First bytes of the logo bitmap every licensed cartridge header carries.
const LOGO_PREFIX = [0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b];
const BATTERY_CART_TYPES = new Set([0x03, 0x06, 0x09, 0x0d, 0x0f, 0x10, 0x13, 0x1b, 0x1e, 0x22, 0xff]);

export class RomError extends Error {}

export async function inspectRom(rom: ArrayBuffer): Promise<RomInfo> {
  const bytes = new Uint8Array(rom);
  if (bytes.length < MIN_ROM_SIZE || bytes.length > MAX_ROM_SIZE) {
    throw new RomError("That file is not a Game Boy ROM (unexpected size).");
  }
  if (!LOGO_PREFIX.every((b, i) => bytes[NINTENDO_LOGO_START + i] === b)) {
    throw new RomError("That file is not a Game Boy ROM (missing cartridge header).");
  }
  const cgbFlag = bytes[0x143]!;
  const cgb = cgbFlag === 0x80 || cgbFlag === 0xc0;
  // Title is 16 bytes, or 11/15 on CGB-era carts where the tail holds other fields.
  const titleBytes = bytes.subarray(0x134, cgb ? 0x143 : 0x144);
  const title = String.fromCharCode(...titleBytes)
    .replace(/\0.*$/s, "")
    .replace(/[^\x20-\x7e]/g, "")
    .trim();
  const cartridgeType = bytes[0x147]!;
  return {
    gameId: title || "UNKNOWN",
    title: title || "Unknown game",
    romHash: await sha256Hex(bytes),
    cartridgeType,
    hasBattery: BATTERY_CART_TYPES.has(cartridgeType),
    cgb,
    size: bytes.length,
  };
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
