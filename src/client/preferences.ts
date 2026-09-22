import { DEFAULT_KEY_BINDINGS, sanitizeBindings, type KeyBindings } from "./emulator/keyBindings";

/** Small per-device UI preferences (localStorage). */
export type Preferences = {
  cloudSync: boolean;
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
};

const KEY = "pocket-cloud.prefs";
const DEFAULTS: Preferences = {
  cloudSync: true,
  rememberRom: true,
  volume: 0.6,
  muted: false,
  keyBindings: DEFAULT_KEY_BINDINGS,
  skipSignIn: false,
  uiSounds: false,
  reduceMotion: false,
  haptics: true,
};

export function loadPreferences(): Preferences {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { ...DEFAULTS, ...stored, keyBindings: sanitizeBindings(stored.keyBindings ?? DEFAULT_KEY_BINDINGS) };
  } catch {
    return DEFAULTS;
  }
}

export function savePreferences(prefs: Preferences): void {
  localStorage.setItem(KEY, JSON.stringify(prefs));
}
