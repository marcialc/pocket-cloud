import { useEffect, useState } from "react";
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

type Props = {
  bindings: KeyBindings;
  onChange: (bindings: KeyBindings) => void;
  onClose: () => void;
};

/** Lets the player remap keyboard keys. Click a button, press a key; Esc cancels. */
export function ControlsPanel({ bindings, onChange, onClose }: Props) {
  const [listening, setListening] = useState<GameBoyButton | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Capture phase + stopImmediatePropagation: while this dialog is open the
      // game never sees keys, so pressing a key here can't also press it in-game.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type !== "keydown" || e.repeat) return;
      if (!listening) {
        if (e.code === "Escape") onClose();
        return;
      }
      if (e.code === "Escape") {
        setListening(null);
        return;
      }
      if (!isBindable(e.code)) {
        setNotice(`${e.key} is reserved for the browser — pick another key.`);
        return;
      }
      const stolenFrom = GAME_BOY_BUTTONS.find((b) => b !== listening && bindings[b].includes(e.code));
      onChange(rebind(bindings, listening, e.code));
      setNotice(
        stolenFrom
          ? `${keyLabel(e.code)} moved from ${BUTTON_LABELS[stolenFrom]} to ${BUTTON_LABELS[listening]}.`
          : null,
      );
      setListening(null);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
  }, [listening, bindings, onChange, onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="dialog panel" role="dialog" aria-labelledby="controls-title" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2 id="controls-title">Controls</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <p className="fine">Click a button, then press the key you want. Esc cancels. Saved on this device.</p>

        <div className="bindings">
          {GAME_BOY_BUTTONS.map((button) => {
            const keys = bindings[button];
            const active = listening === button;
            return (
              <button
                key={button}
                className={`binding${active ? " listening" : ""}${keys.length === 0 ? " unbound" : ""}`}
                onClick={() => {
                  setNotice(null);
                  setListening(active ? null : button);
                }}
              >
                <span className="binding-name">{BUTTON_LABELS[button]}</span>
                <span className="binding-keys">
                  {active ? (
                    <em>Press a key…</em>
                  ) : keys.length ? (
                    keys.map((code) => <kbd key={code}>{keyLabel(code)}</kbd>)
                  ) : (
                    <em>Not set</em>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        {notice && <p className="fine notice" role="status">{notice}</p>}

        <div className="panel-foot">
          <button
            className="btn small"
            disabled={sameBindings(bindings, DEFAULT_KEY_BINDINGS)}
            onClick={() => {
              onChange(DEFAULT_KEY_BINDINGS);
              setListening(null);
              setNotice("Restored the default keys.");
            }}
          >
            Reset to defaults
          </button>
        </div>
      </div>
    </div>
  );
}
