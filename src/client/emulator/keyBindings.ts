import { CONTROLS_IDS, PLATFORMS, type Button, type ControlsId } from "../../shared/platforms";

/** Keyboard codes (KeyboardEvent.code) assigned to each of one platform's buttons. */
export type KeyBindings = Partial<Record<Button, string[]>>;

/** Every platform's bindings (the Game Boy Color shares the Game Boy's; see ControlsId). */
export type AllKeyBindings = Record<ControlsId, KeyBindings>;

const GAME_BOY: KeyBindings = {
  up: ["ArrowUp"],
  down: ["ArrowDown"],
  left: ["ArrowLeft"],
  right: ["ArrowRight"],
  a: ["KeyZ"],
  b: ["KeyX"],
  start: ["Enter", "NumpadEnter"],
  select: ["ShiftLeft", "ShiftRight"],
};

/** Extra buttons sit next to Z and X: A and S (GBA shoulders, SNES Y and X), C, then Q and W for shoulders. */
export const DEFAULT_KEY_BINDINGS: AllKeyBindings = {
  gb: GAME_BOY,
  gba: { ...GAME_BOY, l: ["KeyA"], r: ["KeyS"] },
  nes: GAME_BOY,
  snes: { ...GAME_BOY, x: ["KeyS"], y: ["KeyA"], l: ["KeyQ"], r: ["KeyW"] },
  genesis: { ...pick(GAME_BOY, "up", "down", "left", "right", "a", "b", "start"), c: ["KeyC"] },
  sms: pick(GAME_BOY, "up", "down", "left", "right", "a", "b", "start"),
  gamegear: pick(GAME_BOY, "up", "down", "left", "right", "a", "b", "start"),
  lynx: { ...pick(GAME_BOY, "up", "down", "left", "right", "a", "b", "start"), l: ["KeyA"], r: ["KeyS"] },
  psx: { ...GAME_BOY, x: ["KeyS"], y: ["KeyA"], l: ["KeyQ"], r: ["KeyW"], l2: ["Digit1"], r2: ["Digit2"] },
};

function pick(bindings: KeyBindings, ...buttons: Button[]): KeyBindings {
  return Object.fromEntries(buttons.map((b) => [b, bindings[b] ?? []]));
}

/**
 * Keys that can't be bound: Escape cancels rebinding, and the handler ignores
 * events while Ctrl/Alt/Meta are held so browser shortcuts keep working.
 */
const RESERVED = new Set(["Escape", "MetaLeft", "MetaRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "OSLeft", "OSRight"]);

export function isBindable(code: string): boolean {
  return code !== "" && code !== "Unidentified" && !RESERVED.has(code);
}

/** code -> button lookup for the key handler. */
export function keyMap(bindings: KeyBindings): Map<string, Button> {
  const map = new Map<string, Button>();
  for (const [button, codes] of Object.entries(bindings) as [Button, string[]][]) for (const code of codes) map.set(code, button);
  return map;
}

/**
 * Assign `code` as the only key for `button`. If another button used that key
 * it loses it (a key drives exactly one button).
 */
export function rebind(bindings: KeyBindings, button: Button, code: string): KeyBindings {
  const next: KeyBindings = {};
  for (const [b, codes] of Object.entries(bindings) as [Button, string[]][]) next[b] = codes.filter((c) => c !== code);
  next[button] = [code];
  return next;
}

/** Validates one platform's bindings loaded from storage; falls back to defaults per button. */
export function sanitizeBindings(value: unknown, controls: ControlsId = "gb"): KeyBindings {
  const input = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const result: KeyBindings = {};
  for (const button of PLATFORMS[controls].buttons) {
    const raw = input[button];
    const codes = Array.isArray(raw)
      ? raw.filter((c): c is string => typeof c === "string" && isBindable(c) && !seen.has(c))
      : [...DEFAULT_KEY_BINDINGS[controls][button]!];
    codes.forEach((c) => seen.add(c));
    result[button] = codes;
  }
  return result;
}

/** Validates every platform's bindings; platforms missing from `value` get their defaults. */
export function sanitizeAllBindings(value: unknown): AllKeyBindings {
  const input = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return Object.fromEntries(CONTROLS_IDS.map((id) => [id, sanitizeBindings(input[id], id)])) as AllKeyBindings;
}

export function sameBindings(a: KeyBindings, b: KeyBindings): boolean {
  const buttons = new Set([...Object.keys(a), ...Object.keys(b)] as Button[]);
  return [...buttons].every((btn) => (a[btn] ?? []).join() === (b[btn] ?? []).join());
}

/**
 * The platforms other than the Game Boy whose bindings aren't the defaults:
 * what gets stored and sent. The Game Boy's always go on their own (`keyBindings`),
 * where older versions of the app read them.
 */
export function customPlatformBindings(all: AllKeyBindings): Partial<AllKeyBindings> {
  return Object.fromEntries(
    CONTROLS_IDS.filter((id) => id !== "gb" && !sameBindings(all[id], DEFAULT_KEY_BINDINGS[id])).map((id) => [id, all[id]]),
  );
}

export function sameAllBindings(a: AllKeyBindings, b: AllKeyBindings): boolean {
  return CONTROLS_IDS.every((id) => sameBindings(a[id], b[id]));
}

const NAMED: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Enter: "Enter",
  NumpadEnter: "Num Enter",
  ShiftLeft: "L Shift",
  ShiftRight: "R Shift",
  Space: "Space",
  Backspace: "Backspace",
  Tab: "Tab",
  CapsLock: "Caps Lock",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

/** Human label for a KeyboardEvent.code (layout-independent, like the binding itself). */
export function keyLabel(code: string): string {
  if (NAMED[code]) return NAMED[code];
  const m = /^(?:Key|Digit)(.)$/.exec(code);
  if (m) return m[1]!;
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  return code;
}
