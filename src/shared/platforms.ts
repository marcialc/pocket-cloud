/**
 * Consoles the app knows about. Only the enabled ones can be played; the rest
 * are listed so ROM detection, controls and the UI already have a place for
 * them when an emulator core is added (see client/emulator/createEmulator.ts).
 */

export type PlatformId = "gb" | "gbc" | "gba" | "nes" | "snes" | "genesis" | "sms" | "gamegear" | "lynx" | "psx";

/**
 * Every button any platform has, named after the libretro RetroPad where one
 * fits (x/y, l/r). Each platform uses a subset and may print other names on
 * them (`labels`), e.g. the Master System's 1 and 2 are b and a.
 */
export type Button =
  | "up" | "down" | "left" | "right"
  | "a" | "b" | "c" | "x" | "y"
  | "l" | "r" | "l2" | "r2"
  | "start" | "select";

/** Platforms whose key bindings are their own. The Game Boy Color uses the Game Boy's. */
export type ControlsId = Exclude<PlatformId, "gbc">;

export type Platform = {
  name: string;
  /** For messages ("GBA games aren't supported yet."). */
  shortName: string;
  /** Lower-case file extensions, with the dot. */
  extensions: readonly string[];
  /** libretro core Nostalgist would run it with. */
  core: string;
  /** In the order the controls list shows them: D-pad first. */
  buttons: readonly Button[];
  /** Names printed on the console where they differ from BUTTON_LABELS. */
  labels?: Partial<Record<Button, string>>;
  /** Native screen size in pixels. */
  screen: { width: number; height: number };
  controls: ControlsId;
  /** Has an emulator in this build. */
  enabled: boolean;
};

const DPAD = ["up", "down", "left", "right"] as const;

export const PLATFORMS: Record<PlatformId, Platform> = {
  gb: {
    name: "Game Boy", shortName: "Game Boy", extensions: [".gb", ".sgb"], core: "gambatte",
    buttons: [...DPAD, "a", "b", "start", "select"], screen: { width: 160, height: 144 }, controls: "gb", enabled: true,
  },
  gbc: {
    name: "Game Boy Color", shortName: "Game Boy Color", extensions: [".gbc"], core: "gambatte",
    buttons: [...DPAD, "a", "b", "start", "select"], screen: { width: 160, height: 144 }, controls: "gb", enabled: true,
  },
  gba: {
    name: "Game Boy Advance", shortName: "GBA", extensions: [".gba"], core: "mgba",
    buttons: [...DPAD, "a", "b", "l", "r", "start", "select"], screen: { width: 240, height: 160 }, controls: "gba", enabled: true,
  },
  nes: {
    name: "NES", shortName: "NES", extensions: [".nes"], core: "fceumm",
    buttons: [...DPAD, "a", "b", "start", "select"], screen: { width: 256, height: 240 }, controls: "nes", enabled: false,
  },
  snes: {
    name: "Super Nintendo", shortName: "SNES", extensions: [".sfc", ".smc"], core: "snes9x",
    buttons: [...DPAD, "a", "b", "x", "y", "l", "r", "start", "select"], screen: { width: 256, height: 224 }, controls: "snes", enabled: false,
  },
  genesis: {
    // .bin is left out: PlayStation images use it too. Such files are still found by their header.
    name: "Sega Genesis", shortName: "Genesis", extensions: [".md", ".gen", ".smd"], core: "genesis_plus_gx",
    buttons: [...DPAD, "a", "b", "c", "start"], screen: { width: 320, height: 224 }, controls: "genesis", enabled: false,
  },
  sms: {
    name: "Master System", shortName: "Master System", extensions: [".sms"], core: "genesis_plus_gx",
    buttons: [...DPAD, "b", "a", "start"], labels: { b: "1", a: "2", start: "Pause" },
    screen: { width: 256, height: 192 }, controls: "sms", enabled: false,
  },
  gamegear: {
    name: "Game Gear", shortName: "Game Gear", extensions: [".gg"], core: "genesis_plus_gx",
    buttons: [...DPAD, "b", "a", "start"], labels: { b: "1", a: "2" },
    screen: { width: 160, height: 144 }, controls: "gamegear", enabled: false,
  },
  lynx: {
    name: "Atari Lynx", shortName: "Lynx", extensions: [".lnx"], core: "handy",
    buttons: [...DPAD, "a", "b", "l", "r", "start"], labels: { l: "Option 1", r: "Option 2", start: "Pause" },
    screen: { width: 160, height: 102 }, controls: "lynx", enabled: false,
  },
  psx: {
    // Disc images; .cue/.bin sets need more than one file, so only single-file formats for now.
    name: "PlayStation", shortName: "PlayStation", extensions: [".chd", ".pbp"], core: "pcsx_rearmed",
    buttons: [...DPAD, "b", "a", "y", "x", "l", "r", "l2", "r2", "start", "select"],
    labels: { b: "✕", a: "○", y: "□", x: "△", l: "L1", r: "R1" },
    screen: { width: 320, height: 240 }, controls: "psx", enabled: false,
  },
};

export const PLATFORM_IDS = Object.keys(PLATFORMS) as PlatformId[];

export const CONTROLS_IDS = PLATFORM_IDS.filter((p): p is ControlsId => PLATFORMS[p].controls === p);

export const BUTTON_LABELS: Record<Button, string> = {
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  a: "A",
  b: "B",
  c: "C",
  x: "X",
  y: "Y",
  l: "L",
  r: "R",
  l2: "L2",
  r2: "R2",
  start: "Start",
  select: "Select",
};

/** Name of `button` as printed on this platform's console. */
export function buttonLabel(platform: PlatformId, button: Button): string {
  return PLATFORMS[platform].labels?.[button] ?? BUTTON_LABELS[button];
}

/** Extensions of the platforms that can be played, for a file picker's `accept`. */
export function enabledExtensions(): string[] {
  return PLATFORM_IDS.filter((p) => PLATFORMS[p].enabled).flatMap((p) => PLATFORMS[p].extensions);
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot < 0 ? "" : fileName.slice(dot).toLowerCase();
}

function hasBytes(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return bytes.length >= offset + expected.length && expected.every((b, i) => bytes[offset + i] === b);
}

function hasText(bytes: Uint8Array, offset: number, text: string): boolean {
  return hasBytes(bytes, offset, Array.from(text, (c) => c.charCodeAt(0)));
}

// First bytes of the Nintendo logo bitmap every licensed Game Boy header carries (at 0x104).
export const GB_LOGO_PREFIX = [0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b];
// First bytes of the compressed Nintendo logo in a GBA header (at 0x04).
const GBA_LOGO_PREFIX = [0x24, 0xff, 0xae, 0x51, 0x69, 0x9a, 0xa2, 0x21];

/**
 * Which console a ROM is for: a header signature when the format has one,
 * otherwise the file extension. Null if neither says.
 */
export function detectPlatform(fileName: string, bytes: Uint8Array): PlatformId | null {
  if (hasBytes(bytes, 0x104, GB_LOGO_PREFIX)) return bytes[0x143] === 0x80 || bytes[0x143] === 0xc0 ? "gbc" : "gb";
  if (hasBytes(bytes, 0x04, GBA_LOGO_PREFIX) && bytes[0xb2] === 0x96) return "gba";
  if (hasText(bytes, 0, "NES\x1a")) return "nes";
  if (hasText(bytes, 0, "LYNX")) return "lynx";
  if (hasText(bytes, 0x100, "SEGA")) return "genesis";
  const ext = extensionOf(fileName);
  const byExtension = PLATFORM_IDS.find((p) => PLATFORMS[p].extensions.includes(ext)) ?? null;
  // Master System and Game Gear share a header; its region nibble tells them apart when the extension doesn't.
  if (!byExtension && hasText(bytes, 0x7ff0, "TMR SEGA")) return (bytes[0x7fff]! >> 4) >= 5 ? "gamegear" : "sms";
  return byExtension;
}

/** Longest save name (gameId) the Worker accepts. */
export const MAX_GAME_ID = 64;

/**
 * Save name (gameId) of a game from a platform other than the Game Boy: its
 * platform id first ("gba:BPRE", "nes:Tetris"), so it can never match a Game
 * Boy header title. Cut to MAX_GAME_ID characters.
 */
export function platformGameId(platform: Exclude<PlatformId, "gb" | "gbc">, name: string): string {
  return `${platform}:${name}`
    .slice(0, MAX_GAME_ID)
    // Don't leave half of a character cut at the end.
    .replace(/[\ud800-\udbff]$/, "")
    .trimEnd();
}

/** The platform a gameId belongs to, from its prefix. No prefix: a Game Boy or Game Boy Color header title. */
export function gameIdPlatform(gameId: string): PlatformId | null {
  const prefix = /^([a-z]+):/.exec(gameId)?.[1];
  const platform = PLATFORM_IDS.find((p) => p === prefix);
  return platform && platform !== "gb" && platform !== "gbc" ? platform : null;
}

/** Game Boy / Game Boy Color saves: the only ones the leaderboards read (by header title). */
export function isGameBoyGameId(gameId: string): boolean {
  return gameIdPlatform(gameId) === null;
}
