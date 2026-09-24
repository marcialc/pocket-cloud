import type { Emulator } from "./Emulator";
import { keyMap, type KeyBindings } from "./keyBindings";

const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "password", "url", "tel", "number"]);

/**
 * Only real text entry keeps keys from the game. Focused buttons, sliders and
 * checkboxes must not: e.g. after dragging the volume slider it keeps focus,
 * and the arrows/Enter would otherwise go to the slider instead of the game.
 */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type);
}

/** Wires keyboard input to the emulator using the given bindings. Returns a cleanup function. */
export function bindKeyboard(emulator: Emulator, bindings: KeyBindings, target: Window = window): () => void {
  const map = keyMap(bindings);
  const held = new Set<string>();

  const onKey = (down: boolean) => (e: KeyboardEvent) => {
    const button = map.get(e.code);
    if (!button || e.defaultPrevented || isTextEntry(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    // Also stops a focused button from being "clicked" by Enter/Space.
    e.preventDefault();
    if (down) {
      held.add(e.code);
      emulator.buttonDown(button);
    } else {
      held.delete(e.code);
      // Another key bound to the same button may still be down.
      if (![...held].some((code) => map.get(code) === button)) emulator.buttonUp(button);
    }
  };
  const keydown = onKey(true);
  const keyup = onKey(false);
  // Releasing everything on blur/unbind avoids "stuck" buttons after alt-tab or a rebind.
  const releaseAll = () => {
    for (const code of held) emulator.buttonUp(map.get(code)!);
    held.clear();
  };

  target.addEventListener("keydown", keydown);
  target.addEventListener("keyup", keyup);
  target.addEventListener("blur", releaseAll);
  return () => {
    releaseAll();
    target.removeEventListener("keydown", keydown);
    target.removeEventListener("keyup", keyup);
    target.removeEventListener("blur", releaseAll);
  };
}
