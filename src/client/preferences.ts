import { EMPTY_SHELF, sanitizeShelf, type Shelf } from "../shared/shelf";
import { DEFAULT_KEY_BINDINGS, customPlatformBindings, sanitizeAllBindings, type AllKeyBindings } from "./emulator/keyBindings";

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
  /** Keyboard controls per platform. */
  controls: AllKeyBindings;
  /** Chose "Continue without signing in" on the welcome screen; don't show it again. */
  skipSignIn: boolean;
  /** Soft clicks on menu buttons. Off by default. */
  uiSounds: boolean;
  /** Always keep screens still, even if the system doesn't ask for reduced motion. */
  reduceMotion: boolean;
  /** Vibrate on touch-gamepad presses (phones that support it). */
  haptics: boolean;
  /** How much of the space beside the controls the game screen fills, 0.5–1. */
  screenSize: number;
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
  controls: DEFAULT_KEY_BINDINGS,
  skipSignIn: false,
  uiSounds: false,
  reduceMotion: false,
  haptics: true,
  screenSize: 1,
  shelf: EMPTY_SHELF,
};

export function loadPreferences(): Preferences {
  try {
    // `keyBindings` holds the Game Boy controls, as it did before other platforms, and stays their
    // source of truth: an older version of the app (an open tab, a rollback) may still change them.
    // `controls` only holds the other platforms that aren't on their defaults.
    const { keyBindings, ...stored } = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return {
      ...DEFAULTS,
      ...stored,
      controls: sanitizeAllBindings({ ...stored.controls, ...(keyBindings ? { gb: keyBindings } : {}) }),
      shelf: sanitizeShelf(stored.shelf ?? EMPTY_SHELF),
      screenSize: clampScreenSize(stored.screenSize),
    };
  } catch {
    return DEFAULTS;
  }
}

export const MIN_SCREEN_SIZE = 0.5;

function clampScreenSize(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(MIN_SCREEN_SIZE, value)) : DEFAULTS.screenSize;
}

export function savePreferences(prefs: Preferences): void {
  const { controls, ...rest } = prefs;
  localStorage.setItem(KEY, JSON.stringify({ ...rest, keyBindings: controls.gb, controls: customPlatformBindings(controls) }));
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
