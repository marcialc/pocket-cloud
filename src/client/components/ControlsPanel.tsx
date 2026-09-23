import { useEffect, useRef, useState } from "react";
import { GAME_BOY_BUTTONS, type GameBoyButton } from "../emulator/GameBoyEmulator";
import {
  BUTTON_LABELS,
  DEFAULT_KEY_BINDINGS,
  isBindable,
  keyLabel,
  rebind,
  sameBindings,
  type KeyBindings,
} from "../emulator/keyBindings";
import { Icon } from "./icons";
import { SidePanel } from "./SidePanel";

type Props = {
  bindings: KeyBindings;
  /** Signed in: changes are saved to the account, not just this device. */
  signedIn: boolean;
  onChange: (bindings: KeyBindings) => void;
  onClose: () => void;
};

/** List order: two columns reading D-pad on the left, buttons on the right. */
const ORDER: GameBoyButton[] = ["up", "a", "down", "b", "left", "start", "right", "select"];

/** Where each button sits on the drawn handheld (px inside a 456×200 box). */
const DIAGRAM: Record<GameBoyButton, { x: number; y: number; w: number; h: number; shape: "arm" | "round" | "pill" }> = {
  up: { x: 90, y: 46, w: 28, h: 36, shape: "arm" },
  down: { x: 90, y: 106, w: 28, h: 36, shape: "arm" },
  left: { x: 56, y: 80, w: 36, h: 28, shape: "arm" },
  right: { x: 116, y: 80, w: 36, h: 28, shape: "arm" },
  b: { x: 296, y: 76, w: 54, h: 54, shape: "round" },
  a: { x: 376, y: 46, w: 54, h: 54, shape: "round" },
  select: { x: 190, y: 156, w: 44, h: 14, shape: "pill" },
  start: { x: 254, y: 156, w: 44, h: 14, shape: "pill" },
};

type Notice = { tone: "warn" | "info"; text: string };

/** Remap keyboard keys. Pick a button (diagram or list), press a key; Esc cancels. */
export function ControlsPanel({ bindings, signedIn, onChange, onClose }: Props) {
  const [listening, setListening] = useState<GameBoyButton | null>(null);
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
        setNotice({ tone: "info", text: `Cancelled. ${BUTTON_LABELS[listening]} keeps its key.` });
        return;
      }
      if (!isBindable(e.code)) {
        setNotice({ tone: "warn", text: `${e.key} is reserved for the browser. Pick another key.` });
        return;
      }
      const stolenFrom = GAME_BOY_BUTTONS.find((b) => b !== listening && bindings[b].includes(e.code));
      const next = rebind(bindings, listening, e.code);
      onChange(next);
      if (stolenFrom) {
        const orphan = next[stolenFrom].length === 0;
        setNotice({
          tone: "warn",
          text: `${keyLabel(e.code)} was already used by ${BUTTON_LABELS[stolenFrom]}, so it moved to ${BUTTON_LABELS[listening]}.${
            orphan ? ` ${BUTTON_LABELS[stolenFrom]} has no key now; pick one for it.` : ""
          }`,
        });
      } else {
        setNotice({ tone: "info", text: `${BUTTON_LABELS[listening]} is now ${keyLabel(e.code)}.` });
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

  const pick = (button: GameBoyButton) => {
    setNotice(null);
    setListening(listening === button ? null : button);
    document.getElementById(`bind-${button}`)?.focus();
  };

  const unbound = GAME_BOY_BUTTONS.filter((b) => bindings[b].length === 0);

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
            disabled={sameBindings(bindings, DEFAULT_KEY_BINDINGS)}
            onClick={() => {
              onChange(DEFAULT_KEY_BINDINGS);
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

      <div className="pad-diagram" aria-label="Handheld buttons" role="group">
        <span className="pad-well" aria-hidden />
        <span className="pad-hub" aria-hidden />
        {GAME_BOY_BUTTONS.map((b) => {
          const d = DIAGRAM[b];
          return (
            <button
              key={b}
              type="button"
              className={`hw hw-${d.shape}${listening === b ? " listen" : ""}`}
              style={at(d.x, d.y, d.w, d.h)}
              aria-label={`${BUTTON_LABELS[b]} button, set to ${describeKeys(bindings[b])}. Activate to change.`}
              onClick={() => pick(b)}
            />
          );
        })}
        <span className="hw-label" style={at(318, 136)} aria-hidden>B</span>
        <span className="hw-label" style={at(398, 106)} aria-hidden>A</span>
        <span className="hw-label small" style={at(186, 178)} aria-hidden>SELECT</span>
        <span className="hw-label small" style={at(254, 178)} aria-hidden>START</span>
      </div>

      {(notice || unbound.length > 0) && (
        <div className={`notice ${notice?.tone ?? "warn"}`} role="status">
          <Icon name={notice?.tone === "info" ? "info" : "warn"} size={18} />
          <span>
            {notice?.text ?? `${unbound.map((b) => BUTTON_LABELS[b]).join(", ")} ${unbound.length > 1 ? "have" : "has"} no key.`}
          </span>
        </div>
      )}

      <ul className="bind-list">
        {ORDER.map((button) => {
          const keys = bindings[button];
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
                    ? `Waiting for a key for ${BUTTON_LABELS[button]}. Escape cancels.`
                    : `${BUTTON_LABELS[button]}, set to ${describeKeys(keys)}. Activate to change.`
                }
              >
                <span className="bind-name">
                  {BUTTON_LABELS[button]}
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
