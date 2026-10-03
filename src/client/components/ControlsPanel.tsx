import { useEffect, useRef, useState } from "react";
import { CONTROLS_IDS, PLATFORM_IDS, PLATFORMS, buttonLabel, type Button, type ControlsId, type PlatformId } from "../../shared/platforms";
import {
  DEFAULT_PAD_BINDINGS,
  MENU,
  heldButtons,
  padButtonName,
  padName,
  pollGamepads,
  pressedIndexes,
  type AllPadBindings,
  type PadAction,
  type PadBindings,
} from "../emulator/gamepad";
import { DEFAULT_KEY_BINDINGS, isBindable, keyLabel, keyMap, rebind, sameBindings, type AllKeyBindings, type KeyBindings } from "../emulator/keyBindings";
import { Icon, KeyName } from "./icons";
import { SidePanel } from "./SidePanel";

type Props = {
  bindings: AllKeyBindings;
  /** Game controller buttons; remapped here too while a controller is connected. */
  padBindings: AllPadBindings;
  /** The game being played: its platform's controls. Left out on the start screen, where the player picks. */
  platform?: PlatformId;
  /** Signed in: changes are saved to the account, not just this device. */
  signedIn: boolean;
  onChange: (bindings: AllKeyBindings) => void;
  onPadChange: (bindings: AllPadBindings) => void;
  onClose: () => void;
};

const DPAD: readonly Button[] = ["up", "down", "left", "right"];

/** Platforms that can be played, one per set of controls. */
const PLAYABLE = CONTROLS_IDS.filter((id) => PLATFORM_IDS.some((p) => PLATFORMS[p].enabled && PLATFORMS[p].controls === id));

/** List order: two columns reading D-pad on the left, buttons on the right, then the rest in pairs. */
function listOrder(buttons: readonly Button[]): Button[] {
  const others = buttons.filter((b) => !DPAD.includes(b));
  return [...DPAD.flatMap((d, i) => (others[i] ? [d, others[i]] : [d])), ...others.slice(DPAD.length)];
}

type Spot = {
  x: number;
  y: number;
  w: number;
  h: number;
  shape: "arm" | "round" | "pill" | "shoulder";
  /** Where the printed name goes, if the handheld shows one. */
  label?: { x: number; y: number; small?: boolean };
};

/** Where each button sits on the drawn handheld (px inside a 456×200 box). */
const DIAGRAM: Record<Button, Spot> = {
  up: { x: 90, y: 46, w: 28, h: 36, shape: "arm" },
  down: { x: 90, y: 106, w: 28, h: 36, shape: "arm" },
  left: { x: 56, y: 80, w: 36, h: 28, shape: "arm" },
  right: { x: 116, y: 80, w: 36, h: 28, shape: "arm" },
  b: { x: 296, y: 76, w: 54, h: 54, shape: "round", label: { x: 318, y: 136 } },
  a: { x: 376, y: 46, w: 54, h: 54, shape: "round", label: { x: 398, y: 106 } },
  c: { x: 400, y: 48, w: 46, h: 46, shape: "round", label: { x: 418, y: 98 } },
  x: { x: 340, y: 34, w: 44, h: 44, shape: "round", label: { x: 358, y: 82 } },
  y: { x: 292, y: 78, w: 44, h: 44, shape: "round", label: { x: 310, y: 126 } },
  l: { x: 36, y: 4, w: 80, h: 14, shape: "shoulder", label: { x: 72, y: 22, small: true } },
  r: { x: 350, y: 4, w: 80, h: 14, shape: "shoulder", label: { x: 386, y: 22, small: true } },
  l2: { x: 124, y: 4, w: 60, h: 14, shape: "shoulder", label: { x: 148, y: 22, small: true } },
  r2: { x: 272, y: 4, w: 60, h: 14, shape: "shoulder", label: { x: 296, y: 22, small: true } },
  select: { x: 190, y: 156, w: 44, h: 14, shape: "pill", label: { x: 186, y: 178, small: true } },
  start: { x: 254, y: 156, w: 44, h: 14, shape: "pill", label: { x: 254, y: 178, small: true } },
};

/** Four face buttons (SNES, PlayStation) sit in a diamond around X at the top. */
const DIAMOND: Partial<Record<Button, Spot>> = {
  a: { x: 388, y: 78, w: 44, h: 44, shape: "round", label: { x: 406, y: 126 } },
  b: { x: 340, y: 122, w: 44, h: 44, shape: "round", label: { x: 358, y: 170 } },
};

/** Three face buttons (Genesis) climb in a row: A, B, C. */
const ROW: Partial<Record<Button, Spot>> = {
  a: { x: 280, y: 96, w: 46, h: 46, shape: "round", label: { x: 298, y: 146 } },
  b: { x: 340, y: 72, w: 46, h: 46, shape: "round", label: { x: 358, y: 122 } },
};

function spotOf(buttons: readonly Button[], button: Button): Spot {
  if (buttons.includes("x")) return DIAMOND[button] ?? DIAGRAM[button];
  if (buttons.includes("c")) return ROW[button] ?? DIAGRAM[button];
  return DIAGRAM[button];
}

type Notice = { tone: "warn" | "info"; text: string };

function sameSet<T>(a: Set<T>, b: Set<T>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/**
 * Remap keyboard keys and, with one connected, a game controller's buttons.
 * Pick a button (diagram or list), then press a key or controller button; Esc
 * cancels. Keys and controller buttons being held light up on the diagram.
 */
export function ControlsPanel({
  bindings: all,
  padBindings: allPad,
  platform,
  signedIn,
  onChange: onChangeAll,
  onPadChange: onPadChangeAll,
  onClose,
}: Props) {
  const [picked, setPicked] = useState<ControlsId>(PLAYABLE[0] ?? "gb");
  const controls = platform ? PLATFORMS[platform].controls : picked;
  const buttons = PLATFORMS[controls].buttons;
  const bindings = all[controls];
  const padBindings = allPad[controls];
  const onChange = (next: KeyBindings) => onChangeAll({ ...all, [controls]: next });
  const onPadChange = (next: PadBindings) => onPadChangeAll({ ...allPad, [controls]: next });
  const label = (button: PadAction) => (button === MENU ? "Menu" : buttonLabel(controls, button));
  const [listening, setListening] = useState<PadAction | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // The keyup of the key just bound must not "click" the focused button (Space/Enter).
  const swallowUp = useRef<string | null>(null);
  const [keysHeld, setKeysHeld] = useState<Set<Button>>(new Set());
  const [padsHeld, setPadsHeld] = useState<Set<Button>>(new Set());
  const [padInfo, setPadInfo] = useState<Pick<Gamepad, "id" | "mapping"> | null>(null);
  const [source, setSource] = useState<"keyboard" | "controller">("keyboard");
  // Falls back to the keys if the controller goes away.
  const showPad = source === "controller" && padInfo !== null;
  const noun = showPad ? "button" : "key";
  // The controller also has a menu button, which the console doesn't.
  const actions: readonly PadAction[] = showPad ? [...buttons, MENU] : buttons;

  /** Makes `code` (a key or controller button, called `name`) the only one for the button being picked. */
  function assign<T>(current: Partial<Record<PadAction, T[]>>, code: T, name: string, write: (next: Partial<Record<PadAction, T[]>>) => void) {
    if (!listening) return;
    const stolenFrom = actions.find((b) => b !== listening && current[b]?.includes(code));
    const next = rebind(current, listening, code);
    write(next);
    if (stolenFrom) {
      const orphan = next[stolenFrom]?.length === 0;
      setNotice({
        tone: "warn",
        text: `${name[0]!.toUpperCase()}${name.slice(1)} was already used by ${label(stolenFrom)}, so it moved to ${label(listening)}.${
          orphan ? ` ${label(stolenFrom)} has no ${noun} now; pick one for it.` : ""
        }`,
      });
    } else {
      setNotice({ tone: "info", text: `${label(listening)} is now ${name}.` });
    }
    setListening(null);
  }

  // The poll below runs for the panel's whole life; these hand it the current render's values.
  const padBindingsRef = useRef(padBindings);
  padBindingsRef.current = padBindings;
  const onPadPress = useRef<(pad: Gamepad, index: number) => void>(() => {});
  onPadPress.current = (pad, index) => {
    if (showPad && listening) assign(padBindings, index, `the controller's ${padButtonName(pad, index)}`, onPadChange);
  };

  useEffect(() => {
    // Controller buttons held last frame, as "pad:button", so only fresh presses bind.
    let down = new Set<string>();
    return pollGamepads((pads) => {
      const first = pads[0];
      setPadInfo((prev) =>
        prev?.id === first?.id && prev?.mapping === first?.mapping ? prev : first ? { id: first.id, mapping: first.mapping } : null,
      );
      const held = heldButtons(pads, padBindingsRef.current);
      setPadsHeld((prev) => (sameSet(prev, held) ? prev : held));
      const now = new Set<string>();
      let fresh: [Gamepad, number] | null = null;
      for (const pad of pads)
        for (const i of pressedIndexes(pad)) {
          const k = `${pad.index}:${i}`;
          now.add(k);
          if (!down.has(k)) fresh ??= [pad, i];
        }
      down = now;
      // One per frame: the next only sees the new bindings after a render.
      if (fresh) onPadPress.current(...fresh);
    });
  }, []);

  useEffect(() => {
    const clear = () => setKeysHeld(new Set());
    window.addEventListener("blur", clear);
    return () => window.removeEventListener("blur", clear);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Tab keeps moving focus so the panel stays keyboard-navigable.
      if (e.code === "Tab") {
        if (listening) setListening(null);
        return;
      }
      // Capture phase + stopImmediatePropagation: while this panel is open the
      // game never sees keys, so pressing a key here can't also press it in-game.
      e.stopImmediatePropagation();
      // Light up the button the key drives (keyup always, so nothing stays lit after a rebind).
      const held = keyMap(bindings).get(e.code);
      if (held && (e.type === "keyup" || !listening))
        setKeysHeld((prev) => {
          if (prev.has(held) === (e.type === "keydown")) return prev;
          const next = new Set(prev);
          if (e.type === "keydown") next.add(held);
          else next.delete(held);
          return next;
        });
      if (e.type === "keyup" && swallowUp.current === e.code) {
        e.preventDefault();
        swallowUp.current = null;
        return;
      }
      if (!listening) {
        if (e.type === "keydown" && e.code === "Escape") onClose();
        // Let Enter/Space activate the focused control.
        return;
      }
      e.preventDefault();
      if (e.type !== "keydown" || e.repeat) return;
      swallowUp.current = e.code;
      if (e.code === "Escape") {
        setListening(null);
        setNotice({ tone: "info", text: `Cancelled. ${label(listening)} keeps its ${noun}.` });
        return;
      }
      // Waiting for a controller button: other keys do nothing.
      if (showPad) return;
      if (!isBindable(e.code)) {
        setNotice({ tone: "warn", text: `${e.key} is reserved for the browser. Pick another key.` });
        return;
      }
      assign(bindings, e.code, keyLabel(e.code), onChange);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
  }, [listening, bindings, showPad, onChange, onClose]);

  const pick = (button: PadAction) => {
    setNotice(null);
    setListening(listening === button ? null : button);
    document.getElementById(`bind-${button}`)?.focus();
  };

  /** What drives `button` in the view shown: key names, or controller button names. */
  const names = (button: PadAction): string[] =>
    showPad
      ? // A standard pad's D-pad buttons and a hat's directions share a name.
        [...new Set((padBindings[button] ?? []).map((i) => padButtonName(padInfo, i)))]
      : button === MENU
        ? []
        : (bindings[button] ?? []).map(keyLabel);
  const unbound = buttons.filter((b) => names(b).length === 0);
  const pressed = (b: Button) => keysHeld.has(b) || padsHeld.has(b);
  const atDefaults = showPad
    ? sameBindings(padBindings, DEFAULT_PAD_BINDINGS[controls])
    : sameBindings(bindings, DEFAULT_KEY_BINDINGS[controls]);

  const bindRow = (button: PadAction) => {
    const keys = names(button);
    const active = listening === button;
    return (
      <li key={button}>
        <button
          id={`bind-${button}`}
          type="button"
          className={`bind${active ? " listening" : ""}${keys.length === 0 ? " unbound" : ""}`}
          onClick={() => pick(button)}
          aria-label={
            active
              ? `Waiting for a ${noun} for ${label(button)}. Escape cancels.`
              : `${label(button)}, set to ${describeKeys(keys, noun)}. Activate to change.`
          }
        >
          <span className="bind-name">
            {label(button)}
            {keys.length === 0 && <Icon name="warn" size={15} />}
          </span>
          <span className="bind-keys">
            {active ? (
              <kbd className="listening">PRESS A {noun.toUpperCase()}</kbd>
            ) : keys.length ? (
              keys.map((name, i) => (
                <kbd key={i}>
                  <KeyName name={name} />
                </kbd>
              ))
            ) : (
              <kbd className="empty">NONE</kbd>
            )}
          </span>
        </button>
      </li>
    );
  };

  return (
    <SidePanel
      id="controls-title"
      title="CONTROLS"
      onClose={onClose}
      handleEscape={false}
      footer={
        <>
          <button
            type="button"
            className="btn small"
            disabled={atDefaults}
            onClick={() => {
              if (showPad) onPadChange(DEFAULT_PAD_BINDINGS[controls]);
              else onChange(DEFAULT_KEY_BINDINGS[controls]);
              setListening(null);
              setNotice({ tone: "info", text: showPad ? "Restored the default controller buttons." : "Restored the default keys." });
            }}
          >
            Reset to defaults
          </button>
          <button type="button" className="btn small primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      {showPad ? (
        <p className="muted">Pick a button on the handheld or in the list, then press the controller button you want for it. Saved on this device.</p>
      ) : (
        <p className="muted">Pick a button on the handheld or in the list, then press the key you want for it.{" "}
          {signedIn ? "Saved to your account." : "Saved on this device."}
        </p>
      )}

      {padInfo && (
        <div className="chips" role="group" aria-label="Input">
          {(["keyboard", "controller"] as const).map((s) => (
            <button
              key={s}
              type="button"
              className="chip"
              aria-pressed={(s === "controller") === showPad}
              onClick={() => {
                setSource(s);
                setListening(null);
                setNotice(null);
              }}
            >
              <Icon name={s === "controller" ? "gamepad" : "keyboard"} size={16} />
              <span className="chip-label">{s === "controller" ? padName(padInfo.id) : "Keyboard"}</span>
            </button>
          ))}
        </div>
      )}

      {!platform && PLAYABLE.length > 1 && (
        <div className="chips" role="group" aria-label="Console">
          {PLAYABLE.map((id) => (
            <button
              key={id}
              type="button"
              className="chip"
              aria-pressed={id === controls}
              onClick={() => {
                setPicked(id);
                setListening(null);
                setNotice(null);
              }}
            >
              <span className="chip-label">{PLATFORMS[id].name}</span>
            </button>
          ))}
        </div>
      )}

      {/* Controllers don't move around this panel (padNav.ts): their buttons light up the drawing and get bound. */}
      <div className="pad-diagram" aria-label="Handheld buttons" role="group" data-pad-capture>
        <span className="pad-well" aria-hidden />
        <span className="pad-hub" aria-hidden />
        {buttons.map((b) => {
          const d = spotOf(buttons, b);
          return (
            <button
              key={b}
              type="button"
              className={`hw hw-${d.shape}${listening === b ? " listen" : ""}${pressed(b) ? " pressed" : ""}`}
              style={at(d.x, d.y, d.w, d.h)}
              aria-label={`${label(b)} button, set to ${describeKeys(names(b), noun)}. Activate to change.`}
              onClick={() => pick(b)}
            />
          );
        })}
        {buttons.map((b) => {
          const l = spotOf(buttons, b).label;
          return (
            l && (
              <span key={b} className={`hw-label${l.small ? " small" : ""}`} style={at(l.x, l.y)} aria-hidden>
                {label(b).toUpperCase()}
              </span>
            )
          );
        })}
      </div>

      {(notice || unbound.length > 0) && (
        <div className={`notice ${notice?.tone ?? "warn"}`} role="status">
          <Icon name={notice?.tone === "info" ? "info" : "warn"} size={18} />
          <span>
            {notice?.text ?? `${unbound.map((b) => label(b)).join(", ")} ${unbound.length > 1 ? "have" : "has"} no ${noun}.`}
          </span>
        </div>
      )}

      <ul className="bind-list">
        {listOrder(buttons).map(bindRow)}
      </ul>
      {showPad && (
        <>
          <ul className="bind-list">{bindRow(MENU)}</ul>
          <p className="fine">Menu opens the menu over a game, with the way back to your games.</p>
        </>
      )}
      <p className="fine">
        {showPad
          ? "Esc cancels while a button is waiting for a controller button. The left stick always moves like the D-pad."
          : "Esc cancels while a button is waiting for a key."}
      </p>
    </SidePanel>
  );
}

/** Diagram coordinates as percentages so the drawing scales with the panel. */
function at(x: number, y: number, w?: number, h?: number) {
  return {
    left: `${(x / 456) * 100}%`,
    top: `${(y / 200) * 100}%`,
    ...(w !== undefined && h !== undefined ? { width: `${(w / 456) * 100}%`, height: `${(h / 200) * 100}%` } : {}),
  };
}

function describeKeys(names: string[], noun: string): string {
  return names.length ? names.join(" or ") : `no ${noun}`;
}
