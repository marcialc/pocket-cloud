import { GAME_BOY_BUTTONS, type GameBoyButton } from "./GameBoyEmulator";

/** Keyboard codes (KeyboardEvent.code) assigned to each Game Boy button. */
export type KeyBindings = Record<GameBoyButton, string[]>;

export const DEFAULT_KEY_BINDINGS: KeyBindings = {
  up: ["ArrowUp"],
  down: ["ArrowDown"],
  left: ["ArrowLeft"],
  right: ["ArrowRight"],
  a: ["KeyZ"],
  b: ["KeyX"],
  start: ["Enter", "NumpadEnter"],
  select: ["ShiftLeft", "ShiftRight"],
};

export const BUTTON_LABELS: Record<GameBoyButton, string> = {
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  a: "A",
  b: "B",
  start: "Start",
  select: "Select",
};

/**
 * Keys that can't be bound: Escape cancels rebinding, and the handler ignores
 * events while Ctrl/Alt/Meta are held so browser shortcuts keep working.
 */
const RESERVED = new Set(["Escape", "MetaLeft", "MetaRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "OSLeft", "OSRight"]);

export function isBindable(code: string): boolean {
  return code !== "" && code !== "Unidentified" && !RESERVED.has(code);
}

/** code -> button lookup for the key handler. */
export function keyMap(bindings: KeyBindings): Map<string, GameBoyButton> {
  const map = new Map<string, GameBoyButton>();
  for (const button of GAME_BOY_BUTTONS) for (const code of bindings[button]) map.set(code, button);
  return map;
}

/**
 * Assign `code` as the only key for `button`. If another button used that key
 * it loses it (a key drives exactly one button).
 */
export function rebind(bindings: KeyBindings, button: GameBoyButton, code: string): KeyBindings {
  const next = {} as KeyBindings;
  for (const b of GAME_BOY_BUTTONS) next[b] = b === button ? [code] : bindings[b].filter((c) => c !== code);
  return next;
}

/** Validates bindings loaded from storage; falls back to defaults per button. */
export function sanitizeBindings(value: unknown): KeyBindings {
  const input = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const result = {} as KeyBindings;
  for (const button of GAME_BOY_BUTTONS) {
    const raw = input[button];
    const codes = Array.isArray(raw)
      ? raw.filter((c): c is string => typeof c === "string" && isBindable(c) && !seen.has(c))
      : [...DEFAULT_KEY_BINDINGS[button]];
    codes.forEach((c) => seen.add(c));
    result[button] = codes;
  }
  return result;
}

export function sameBindings(a: KeyBindings, b: KeyBindings): boolean {
  return GAME_BOY_BUTTONS.every((btn) => a[btn].join() === b[btn].join());
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
