import { DEFAULT_KEY_BINDINGS, sanitizeBindings, type KeyBindings } from "./emulator/keyBindings";

/** Small per-device UI preferences (localStorage). */
export type Preferences = {
  cloudSync: boolean;
  rememberRom: boolean;
  volume: number;
  muted: boolean;
  keyBindings: KeyBindings;
};

const KEY = "pocket-cloud.prefs";
const DEFAULTS: Preferences = {
  cloudSync: true,
  rememberRom: true,
  volume: 0.6,
  muted: false,
  keyBindings: DEFAULT_KEY_BINDINGS,
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
