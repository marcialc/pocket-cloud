import { PLATFORMS } from "../../shared/platforms";
import { BinjgbEmulator } from "./BinjgbEmulator";
import type { Emulator } from "./Emulator";
import { NostalgistEmulator } from "./NostalgistEmulator";
import { defaultPalette, type RomInfo } from "./rom";

/**
 * The emulator for a ROM's platform. binjgb plays Game Boy and Game Boy Color;
 * libretro cores through Nostalgist play the rest that are enabled in
 * shared/platforms.ts (the GBA, with mGBA).
 */
export function createEmulator(rom: RomInfo, canvas: HTMLCanvasElement): Emulator {
  switch (rom.platform) {
    case "gb":
    case "gbc":
      return new BinjgbEmulator({ canvas, palette: defaultPalette(rom) });
    case "gba":
      return new NostalgistEmulator({ canvas, platform: rom.platform });
    default:
      throw new Error(`${PLATFORMS[rom.platform].shortName} games can't be played yet.`);
  }
}
