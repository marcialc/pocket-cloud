import { CONTROLS_IDS, PLATFORMS, type Button, type ControlsId } from "../../shared/platforms";
import type { Emulator } from "./Emulator";
import { keyMap } from "./keyBindings";

/**
 * Controller buttons assigned to each of one platform's buttons, as indexes of
 * the browser's "standard" gamepad layout (https://w3c.github.io/gamepad/#remapping),
 * or of the pad's own button order when the browser doesn't know it. A D-pad
 * the browser reports as a hat axis becomes HAT_UP..HAT_RIGHT.
 */
export type PadBindings = Partial<Record<Button, number[]>>;

/** Every platform's controller bindings (the Game Boy Color shares the Game Boy's). */
export type AllPadBindings = Record<ControlsId, PadBindings>;

/**
 * Pads the browser has no layout for (e.g. an 8BitDo Lite 2 in D-input mode on
 * macOS) report their D-pad as one "hat" axis instead of buttons 12-15. Its
 * directions get these indexes, after any real button.
 */
const HAT_UP = 32;
const HAT_DIRECTIONS = ["up", "down", "left", "right"] as const;

/**
 * Default buttons by position, so Nintendo-style pads (8BitDo, Switch Pro)
 * press A with the right face button and B with the bottom one, as printed.
 */
const STANDARD: Partial<Record<Button, number>> = {
  b: 0, // bottom
  a: 1, // right
  y: 2, // left
  x: 3, // top
  l: 4,
  r: 5,
  l2: 6,
  r2: 7,
  select: 8,
  start: 9,
  up: 12,
  down: 13,
  left: 14,
  right: 15,
};

function defaultIndexes(button: Button): number[] {
  const hat = HAT_DIRECTIONS.indexOf(button as (typeof HAT_DIRECTIONS)[number]);
  return [...(STANDARD[button] === undefined ? [] : [STANDARD[button]]), ...(hat < 0 ? [] : [HAT_UP + hat])];
}

export const DEFAULT_PAD_BINDINGS: AllPadBindings = Object.fromEntries(
  CONTROLS_IDS.map((id) => [id, Object.fromEntries(PLATFORMS[id].buttons.map((b) => [b, defaultIndexes(b)]))]),
) as AllPadBindings;

/** Real buttons, then the hat's four directions. */
const MAX_PAD_BUTTON = HAT_UP + 3;

/** Validates one platform's controller bindings loaded from storage; falls back to defaults per button. */
export function sanitizePadBindings(value: unknown, controls: ControlsId = "gb"): PadBindings {
  const input = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const seen = new Set<number>();
  const result: PadBindings = {};
  for (const button of PLATFORMS[controls].buttons) {
    const raw = input[button];
    const indexes = Array.isArray(raw)
      ? raw.filter((i): i is number => Number.isInteger(i) && i >= 0 && i <= MAX_PAD_BUTTON && !seen.has(i))
      : [...DEFAULT_PAD_BINDINGS[controls][button]!];
    indexes.forEach((i) => seen.add(i));
    result[button] = indexes;
  }
  return result;
}

/** Validates every platform's controller bindings; platforms missing from `value` get their defaults. */
export function sanitizeAllPadBindings(value: unknown): AllPadBindings {
  const input = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return Object.fromEntries(CONTROLS_IDS.map((id) => [id, sanitizePadBindings(input[id], id)])) as AllPadBindings;
}

/** How far the left stick has to lean before it counts as the D-pad. */
const STICK_THRESHOLD = 0.5;

type PadLike = Pick<Gamepad, "buttons" | "axes">;

/**
 * Chrome puts a hat at 9/7 (about 1.29) while it rests, and at (2n/7 - 1) for
 * direction n = 0 (up) to 7 (up-left), clockwise. No other axis goes past 1,
 * so an axis seen resting there is taken for a hat.
 */
const HAT_REST = 1.1;
/** Axes known to be hats, per pad (Gamepad objects are fresh snapshots, so keyed by the pad's id). */
const hatAxes = new Map<string, Set<number>>();

function hatIndexes(pad: PadLike & { id?: string }): number[] {
  const key = pad.id ?? "";
  let hats = hatAxes.get(key);
  pad.axes.forEach((v, axis) => {
    if (axis > 1 && v > HAT_REST && !hats?.has(axis)) hatAxes.set(key, (hats = new Set([...(hats ?? []), axis])));
  });
  const pressed = new Set<number>();
  for (const axis of hats ?? []) {
    const v = pad.axes[axis] ?? HAT_REST + 1;
    if (v > HAT_REST || v < -1.05) continue;
    const dir = ((Math.round(((v + 1) * 7) / 2) % 8) + 8) % 8;
    if (dir === 7 || dir <= 1) pressed.add(HAT_UP);
    if (dir >= 3 && dir <= 5) pressed.add(HAT_UP + 1);
    if (dir >= 5) pressed.add(HAT_UP + 2);
    if (dir >= 1 && dir <= 3) pressed.add(HAT_UP + 3);
  }
  return [...pressed];
}

/** Indexes of the buttons (and hat directions) a gamepad is pressing right now. */
export function pressedIndexes(pad: PadLike & { id?: string }): number[] {
  return [...pad.buttons.flatMap((b, i) => (b.pressed ? [i] : [])), ...hatIndexes(pad)];
}

/** Whether any of these gamepads is being played with right now: a button, hat or stick is pressed. */
export function padsInUse(pads: readonly (PadLike & { id?: string })[]): boolean {
  return pads.some((pad) => {
    const [x = 0, y = 0] = pad.axes;
    return pressedIndexes(pad).length > 0 || Math.abs(x) >= STICK_THRESHOLD || Math.abs(y) >= STICK_THRESHOLD;
  });
}

/** The buttons one gamepad is holding right now; the left stick always doubles as the D-pad. */
export function padButtons(pad: PadLike & { id?: string }, bindings: PadBindings): Set<Button> {
  const map = keyMap(bindings);
  const held = new Set<Button>();
  for (const i of pressedIndexes(pad)) {
    const button = map.get(i);
    if (button) held.add(button);
  }
  const [x = 0, y = 0] = pad.axes;
  if (x <= -STICK_THRESHOLD) held.add("left");
  if (x >= STICK_THRESHOLD) held.add("right");
  if (y <= -STICK_THRESHOLD) held.add("up");
  if (y >= STICK_THRESHOLD) held.add("down");
  return held;
}

/** Calls `onPads` every frame with the connected gamepads. Returns a stop function. */
export function pollGamepads(onPads: (pads: Gamepad[]) => void, target: Window = window): () => void {
  if (!target.navigator.getGamepads) return () => {};
  let frame = 0;
  const poll = () => {
    onPads(target.navigator.getGamepads().filter((pad): pad is Gamepad => !!pad?.connected));
    frame = target.requestAnimationFrame(poll);
  };
  frame = target.requestAnimationFrame(poll);
  return () => target.cancelAnimationFrame(frame);
}

/** What several pads hold together: a button is down while any pad holds it. */
export function heldButtons(pads: readonly (PadLike & { id?: string })[], bindings: PadBindings): Set<Button> {
  const held = new Set<Button>();
  for (const pad of pads) for (const b of padButtons(pad, bindings)) held.add(b);
  return held;
}

/**
 * Forwards presses on connected gamepads to the emulator.
 * Returns a cleanup function.
 */
export function bindGamepads(emulator: Emulator, bindings: PadBindings, target: Window = window): () => void {
  let held = new Set<Button>();

  const apply = (next: Set<Button>) => {
    for (const b of held) if (!next.has(b)) emulator.buttonUp(b);
    for (const b of next) if (!held.has(b)) emulator.buttonDown(b);
    held = next;
  };

  // Frames stop in a background tab, so let go of everything rather than leave buttons stuck.
  const releaseAll = () => apply(new Set());
  const onVisibility = () => target.document.hidden && releaseAll();

  const stop = pollGamepads((pads) => apply(heldButtons(pads, bindings)), target);
  target.addEventListener("blur", releaseAll);
  target.document.addEventListener("visibilitychange", onVisibility);
  return () => {
    stop();
    releaseAll();
    target.removeEventListener("blur", releaseAll);
    target.document.removeEventListener("visibilitychange", onVisibility);
  };
}

/**
 * A readable name from Gamepad.id, which browsers pad with vendor details:
 * "8BitDo Lite 2 (STANDARD GAMEPAD Vendor: 2dc8 Product: 5112)" in Chrome,
 * "2dc8-5112-8BitDo Lite 2" in Firefox.
 */
export function padName(id: string): string {
  return id.replace(/\s*\(.*\)\s*$/, "").replace(/^[0-9a-f]{1,4}-[0-9a-f]{1,4}-/i, "").trim() || "Controller";
}

/** Nintendo and 8BitDo pads print A on the right; the rest (Xbox-style) print A at the bottom. */
const NINTENDO = /8bitdo|nintendo|pro controller|joy-con|057e|2dc8/i;
const DPAD_NAMES = ["D-pad ↑", "D-pad ↓", "D-pad ←", "D-pad →"];
const NINTENDO_NAMES = ["B", "A", "Y", "X", "L", "R", "ZL", "ZR", "−", "+", "L3", "R3", ...DPAD_NAMES, "Home"];
const XBOX_NAMES = ["A", "B", "X", "Y", "LB", "RB", "LT", "RT", "View", "Menu", "LS", "RS", ...DPAD_NAMES, "Guide"];

/**
 * The name printed on the controller for button `index`. Without the standard
 * layout the browser doesn't say which button is which, so it's only numbered.
 */
export function padButtonName(pad: Pick<Gamepad, "id" | "mapping">, index: number): string {
  if (index >= HAT_UP) return DPAD_NAMES[index - HAT_UP] ?? `Button ${index}`;
  if (pad.mapping !== "standard") return `Button ${index}`;
  return (NINTENDO.test(pad.id) ? NINTENDO_NAMES : XBOX_NAMES)[index] ?? `Button ${index}`;
}
