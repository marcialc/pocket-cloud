/**
 * Moving around the app with a game controller, like a console menu: the D-pad
 * (or left stick) moves the focus to the nearest control that way, A picks it,
 * B goes back (Escape). On the library page it only visits the games
 * (`data-pad-target`), and A plays one. Nothing to switch on: the first press
 * shows the focus, and the mouse, a touch or a key hides it again.
 *
 * Stands aside while the controller is playing a game (a game on screen with no
 * dialog over it) and while a dialog is waiting for a button to bind
 * (`data-pad-capture`).
 */
import { menuButtons, pollGamepads, pressedIndexes } from "./emulator/gamepad";

type Direction = "up" | "down" | "left" | "right";

const FOCUSABLE = 'button, a[href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';
/** Topmost first: a dialog, else the whole page. */
const DIALOG = '[aria-modal="true"], [role="alertdialog"]';
const STICK = 0.5;
/** Holding a direction moves once, then again after this long, then every REPEAT_MS. */
const FIRST_REPEAT_MS = 380;
const REPEAT_MS = 110;
/** How far a list scrolls when there's nothing more to focus that way. */
const SCROLL_STEP = 160;

/** The D-pad's standard indexes, and where a hat puts them (see gamepad.ts). */
const DPAD: Record<Direction, number[]> = { up: [12, 32], down: [13, 33], left: [14, 34], right: [15, 35] };

function directionsHeld(pad: Gamepad, pressed: number[]): Set<Direction> {
  const held = new Set<Direction>();
  for (const d of Object.keys(DPAD) as Direction[]) if (DPAD[d].some((i) => pressed.includes(i))) held.add(d);
  const [x = 0, y = 0] = pad.axes;
  if (x <= -STICK) held.add("left");
  if (x >= STICK) held.add("right");
  if (y <= -STICK) held.add("up");
  if (y >= STICK) held.add("down");
  return held;
}

/** Where the controller acts: the topmost dialog, the page, or nowhere (it's playing a game). */
export function navScope(doc: Document = document): HTMLElement | null {
  if (doc.querySelector("[data-pad-capture]")) return null;
  const dialogs = doc.querySelectorAll<HTMLElement>(DIALOG);
  const top = dialogs[dialogs.length - 1];
  if (top) return top;
  return doc.querySelector(".game") ? null : doc.body;
}

function shown(el: HTMLElement): boolean {
  if (el.closest("[hidden], [inert], [aria-hidden='true']")) return false;
  if (el.getClientRects().length === 0) return false;
  return getComputedStyle(el).visibility !== "hidden";
}

/**
 * Controls the focus can land on inside `scope`, in page order. Where some are
 * marked `data-pad-target` (the library's games), only those: the controller
 * goes from game to game, not through every button on each card.
 */
export function focusables(scope: HTMLElement): HTMLElement[] {
  const targets = scope.querySelectorAll<HTMLElement>("[data-pad-target]");
  return [...(targets.length ? targets : scope.querySelectorAll<HTMLElement>(FOCUSABLE))].filter(
    (el) => !(el as HTMLButtonElement).disabled && shown(el),
  );
}

type Box = Pick<DOMRect, "left" | "right" | "top" | "bottom">;

/**
 * The box nearest `from` in `direction`, like a console menu: the next row (or
 * column) that way first, then the one in it closest to straight ahead. Null
 * when nothing lies that way.
 */
export function nearest<T>(from: Box, direction: Direction, candidates: readonly { item: T; box: Box }[]): T | null {
  const horizontal = direction === "left" || direction === "right";
  const forward = direction === "right" || direction === "down";
  // Positions along the way we're going (flipped for left and up, so further is always more).
  const span = (b: Box) => {
    const [lo, hi] = horizontal ? [b.left, b.right] : [b.top, b.bottom];
    return forward ? [lo, hi] : [-hi, -lo];
  };
  const across = (b: Box) => (horizontal ? [b.top, b.bottom] : [b.left, b.right]);
  const [fromStart, fromEnd] = span(from);
  const fromMid = (fromStart! + fromEnd!) / 2;
  const ahead = candidates
    .map((c) => ({ ...c, span: span(c.box) }))
    .filter((c) => (c.span[0]! + c.span[1]!) / 2 > fromMid + 1);
  if (ahead.length === 0) return null;
  // The row: whatever overlaps, along the way, the first control that way.
  const first = ahead.reduce((a, b) => (b.span[0]! < a.span[0]! ? b : a));
  const row = ahead.filter((c) => c.span[0]! < first.span[1]! && c.span[1]! > first.span[0]!);
  const [fromLo, fromHi] = across(from);
  const aside = (b: Box) => {
    const [lo, hi] = across(b);
    // Zero while the two overlap side to side; then by centres, so the most lined-up wins.
    return Math.max(0, lo! - fromHi!, fromLo! - hi!) + Math.abs((lo! + hi!) / 2 - (fromLo! + fromHi!) / 2) * 0.01;
  };
  return row.reduce((a, b) => (aside(b.box) < aside(a.box) ? b : a)).item;
}

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if ((overflowY === "auto" || overflowY === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

function focus(el: HTMLElement) {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function move(scope: HTMLElement, direction: Direction) {
  const active = document.activeElement as HTMLElement | null;
  const candidates = focusables(scope);
  if (!active || !candidates.includes(active)) {
    if (candidates[0]) focus(candidates[0]);
    return;
  }
  // Sliders take left and right themselves.
  if (active instanceof HTMLInputElement && active.type === "range" && (direction === "left" || direction === "right")) {
    if (direction === "right") active.stepUp();
    else active.stepDown();
    active.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  const next = nearest(
    active.getBoundingClientRect(),
    direction,
    candidates.filter((el) => el !== active).map((el) => ({ item: el, box: el.getBoundingClientRect() })),
  );
  if (next) return focus(next);
  // Nothing more that way: show the rest of the text, if there is any.
  if (direction === "up" || direction === "down") scrollParent(active)?.scrollBy({ top: direction === "down" ? SCROLL_STEP : -SCROLL_STEP });
}

function confirm(scope: HTMLElement) {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !scope.contains(active) || !focusables(scope).includes(active)) {
    const first = focusables(scope)[0];
    if (first) focus(first);
    return;
  }
  // Text can't be typed with a controller; it stays focused for the keyboard.
  if (active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) return;
  if (active instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit"].includes(active.type)) return;
  active.click();
}

function back(scope: HTMLElement) {
  const active = document.activeElement as HTMLElement | null;
  const target = active && scope.contains(active) ? active : scope;
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
}

/** Starts listening to controllers for moving around the app. Returns a stop function. */
export function bindPadNavigation(target: Window = window): () => void {
  const root = target.document.documentElement;
  // Buttons held last frame, as "pad:index", so only fresh presses act.
  let down = new Set<string>();
  const repeats = new Map<Direction, number>();

  const showFocus = () => (root.dataset.input = "pad");
  const hideFocus = () => delete root.dataset.input;
  // Not the Escape sent by B, nor the mousemove browsers send when the page scrolls under the pointer.
  const onInput = (e: Event) => {
    if (!e.isTrusted) return;
    if (e instanceof MouseEvent && e.type === "mousemove" && e.movementX === 0 && e.movementY === 0) return;
    hideFocus();
  };

  const stopPolling = pollGamepads((pads) => {
    const now = target.performance.now();
    const scope = navScope(target.document);
    const held = new Set<Direction>();
    const fresh: ("confirm" | "back")[] = [];
    const nowDown = new Set<string>();
    for (const pad of pads) {
      const pressed = pressedIndexes(pad);
      for (const d of directionsHeld(pad, pressed)) held.add(d);
      const { confirm: a, back: b } = menuButtons(pad);
      for (const i of pressed) {
        const key = `${pad.index}:${i}`;
        nowDown.add(key);
        if (down.has(key)) continue;
        if (i === a) fresh.push("confirm");
        if (i === b) fresh.push("back");
      }
    }
    down = nowDown;

    const moves: Direction[] = [];
    for (const d of [...repeats.keys()]) if (!held.has(d)) repeats.delete(d);
    for (const d of held) {
      const due = repeats.get(d);
      if (due === undefined) {
        repeats.set(d, now + FIRST_REPEAT_MS);
        moves.push(d);
      } else if (now >= due) {
        repeats.set(d, now + REPEAT_MS);
        moves.push(d);
      }
    }

    // Still tracked above while standing aside, so a press made during a game or a rebind
    // doesn't act the moment the controller gets back here.
    if (!scope) {
      for (const d of held) repeats.set(d, Infinity);
      return;
    }
    if (moves.length === 0 && fresh.length === 0) return;
    showFocus();
    for (const d of moves) move(scope, d);
    if (fresh.includes("confirm")) confirm(scope);
    else if (fresh.includes("back")) back(scope);
  }, target);

  target.addEventListener("pointerdown", onInput, true);
  target.addEventListener("mousemove", onInput, true);
  target.addEventListener("keydown", onInput, true);
  return () => {
    stopPolling();
    hideFocus();
    target.removeEventListener("pointerdown", onInput, true);
    target.removeEventListener("mousemove", onInput, true);
    target.removeEventListener("keydown", onInput, true);
  };
}
