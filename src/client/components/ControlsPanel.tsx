import { useEffect, useRef, useState } from "react";
import { CONTROLS_IDS, PLATFORM_IDS, PLATFORMS, buttonLabel, type Button, type ControlsId, type PlatformId } from "../../shared/platforms";
import { DEFAULT_KEY_BINDINGS, isBindable, keyLabel, rebind, sameBindings, type AllKeyBindings } from "../emulator/keyBindings";
import { Icon } from "./icons";
import { SidePanel } from "./SidePanel";

type Props = {
  bindings: AllKeyBindings;
  /** The game being played: its platform's controls. Left out on the start screen, where the player picks. */
  platform?: PlatformId;
  /** Signed in: changes are saved to the account, not just this device. */
  signedIn: boolean;
  onChange: (bindings: AllKeyBindings) => void;
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

/** Remap keyboard keys. Pick a button (diagram or list), press a key; Esc cancels. */
export function ControlsPanel({ bindings: all, platform, signedIn, onChange: onChangeAll, onClose }: Props) {
  const [picked, setPicked] = useState<ControlsId>(PLAYABLE[0] ?? "gb");
  const controls = platform ? PLATFORMS[platform].controls : picked;
  const buttons = PLATFORMS[controls].buttons;
  const bindings = all[controls];
  const onChange = (next: typeof bindings) => onChangeAll({ ...all, [controls]: next });
  const label = (button: Button) => buttonLabel(controls, button);
  const [listening, setListening] = useState<Button | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // The keyup of the key just bound must not "click" the focused button (Space/Enter).
  const swallowUp = useRef<string | null>(null);

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
        setNotice({ tone: "info", text: `Cancelled. ${label(listening)} keeps its key.` });
        return;
      }
      if (!isBindable(e.code)) {
        setNotice({ tone: "warn", text: `${e.key} is reserved for the browser. Pick another key.` });
        return;
      }
      const stolenFrom = buttons.find((b) => b !== listening && bindings[b]?.includes(e.code));
      const next = rebind(bindings, listening, e.code);
      onChange(next);
      if (stolenFrom) {
        const orphan = next[stolenFrom]?.length === 0;
        setNotice({
          tone: "warn",
          text: `${keyLabel(e.code)} was already used by ${label(stolenFrom)}, so it moved to ${label(listening)}.${
            orphan ? ` ${label(stolenFrom)} has no key now; pick one for it.` : ""
          }`,
        });
      } else {
        setNotice({ tone: "info", text: `${label(listening)} is now ${keyLabel(e.code)}.` });
      }
      setListening(null);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
  }, [listening, bindings, onChange, onClose]);

  const pick = (button: Button) => {
    setNotice(null);
    setListening(listening === button ? null : button);
    document.getElementById(`bind-${button}`)?.focus();
  };

  const unbound = buttons.filter((b) => !bindings[b]?.length);

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
            disabled={sameBindings(bindings, DEFAULT_KEY_BINDINGS[controls])}
            onClick={() => {
              onChange(DEFAULT_KEY_BINDINGS[controls]);
              setListening(null);
              setNotice({ tone: "info", text: "Restored the default keys." });
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
      <p className="muted">Pick a button on the handheld or in the list, then press the key you want for it.{" "}
        {signedIn ? "Saved to your account." : "Saved on this device."}
      </p>

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

      <div className="pad-diagram" aria-label="Handheld buttons" role="group">
        <span className="pad-well" aria-hidden />
        <span className="pad-hub" aria-hidden />
        {buttons.map((b) => {
          const d = spotOf(buttons, b);
          return (
            <button
              key={b}
              type="button"
              className={`hw hw-${d.shape}${listening === b ? " listen" : ""}`}
              style={at(d.x, d.y, d.w, d.h)}
              aria-label={`${label(b)} button, set to ${describeKeys(bindings[b] ?? [])}. Activate to change.`}
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
            {notice?.text ?? `${unbound.map((b) => label(b)).join(", ")} ${unbound.length > 1 ? "have" : "has"} no key.`}
          </span>
        </div>
      )}

      <ul className="bind-list">
        {listOrder(buttons).map((button) => {
          const keys = bindings[button] ?? [];
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
                    ? `Waiting for a key for ${label(button)}. Escape cancels.`
                    : `${label(button)}, set to ${describeKeys(keys)}. Activate to change.`
                }
              >
                <span className="bind-name">
                  {label(button)}
                  {keys.length === 0 && <Icon name="warn" size={15} />}
                </span>
                <span className="bind-keys">
                  {active ? (
                    <kbd className="listening">PRESS A KEY</kbd>
                  ) : keys.length ? (
                    keys.map((code) => <kbd key={code}>{keyLabel(code)}</kbd>)
                  ) : (
                    <kbd className="empty">NONE</kbd>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="fine">Esc cancels while a button is waiting for a key.</p>
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

function describeKeys(codes: string[]): string {
  return codes.length ? codes.map(keyLabel).join(" or ") : "no key";
}
