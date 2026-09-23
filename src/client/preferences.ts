import { EMPTY_SHELF, sanitizeShelf, type Shelf } from "../shared/shelf";
import { DEFAULT_KEY_BINDINGS, sanitizeBindings, type KeyBindings } from "./emulator/keyBindings";

/** Small per-device UI preferences (localStorage). */
export type Preferences = {
  cloudSync: boolean;
  /**
   * Keep games (ROM files) in the signed-in account. "ask" until the player
   * answers the one-time prompt; nothing is uploaded before they say yes.
   */
  cloudRoms: "ask" | "on" | "off";
  rememberRom: boolean;
  volume: number;
  muted: boolean;
  keyBindings: KeyBindings;
  /** Chose "Continue without signing in" on the welcome screen; don't show it again. */
  skipSignIn: boolean;
  /** Soft clicks on menu buttons. Off by default. */
  uiSounds: boolean;
  /** Always keep screens still, even if the system doesn't ask for reduced motion. */
  reduceMotion: boolean;
  /** Vibrate on touch-gamepad presses (phones that support it). */
  haptics: boolean;
  /** Favorite games and groups in the library (follows the account when signed in). */
  shelf: Shelf;
};

const KEY = "pocket-cloud.prefs";
const DEFAULTS: Preferences = {
  cloudSync: true,
  cloudRoms: "ask",
  rememberRom: true,
  volume: 0.6,
  muted: false,
  keyBindings: DEFAULT_KEY_BINDINGS,
  skipSignIn: false,
  uiSounds: false,
  reduceMotion: false,
  haptics: true,
  shelf: EMPTY_SHELF,
};

export function loadPreferences(): Preferences {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return {
      ...DEFAULTS,
      ...stored,
      keyBindings: sanitizeBindings(stored.keyBindings ?? DEFAULT_KEY_BINDINGS),
      shelf: sanitizeShelf(stored.shelf ?? EMPTY_SHELF),
    };
  } catch {
    return DEFAULTS;
  }
}

export function savePreferences(prefs: Preferences): void {
  localStorage.setItem(KEY, JSON.stringify(prefs));
}

/**
 * The answer to "Keep your games in your account?" belongs to whoever gave it,
 * so it goes back to "ask" whenever the signed-in account changes. For code
 * that reloads the page right after; React state uses the returned value.
 */
export function resetCloudRomsChoice(): Preferences {
  const next = { ...loadPreferences(), cloudRoms: "ask" as const };
  savePreferences(next);
  return next;
}
