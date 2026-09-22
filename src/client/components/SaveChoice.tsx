import { useState } from "react";
import type { CloudSaveMeta } from "../../shared/api";
import type { LocalGameSave } from "../saves/localSaves";
import { formatPlayTime, formatWhen } from "./format";
import { Icon } from "./icons";
import { Modal } from "./Modal";

type Side = "local" | "cloud";

type Props = {
  title: string;
  local: Pick<LocalGameSave, "updatedAt" | "playTime">;
  cloud: Pick<CloudSaveMeta, "updatedAt" | "playTime">;
  recommended: Side;
  /** `backup`: download the save that is about to be replaced before replacing it. */
  onChoose: (choice: Side, backup: boolean) => void | Promise<void>;
  /** Shown mid-game: choosing cloud restarts the console. */
  inGame?: boolean;
};

/** Two saves disagree: compare them side by side, pick one, confirm. */
export function SaveChoice({ title, local, cloud, recommended, onChoose, inGame }: Props) {
  const [choice, setChoice] = useState<Side | null>(null);
  const [backup, setBackup] = useState(true);
  const [busy, setBusy] = useState(false);
  const newer: Side = cloud.updatedAt > local.updatedAt ? "cloud" : "local";

  const cards: { side: Side; heading: string; icon: "device" | "cloud"; where: string; save: { updatedAt: number; playTime?: number | undefined }; action: string }[] = [
    { side: "local", heading: "THIS DEVICE", icon: "device", where: "This browser", save: local, action: "Use this device’s save" },
    { side: "cloud", heading: "CLOUD", icon: "cloud", where: "Your cloud backup", save: cloud, action: "Use cloud save" },
  ];

  const replaced = choice === "local" ? "cloud save" : "save on this device";
  const confirm = async () => {
    if (!choice) return;
    setBusy(true);
    try {
      await onChoose(choice, backup);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={inGame ? "" : "page page-dim"}>
      <Modal labelledBy="save-choice-title" className="conflict">
        <div className="stack-sm">
          <span className="px eyebrow">
            <Icon name="warn" size={14} /> SAVE CHECK
          </span>
          <h2 id="save-choice-title">Two saves for {title}</h2>
          <p className="muted">
            This device and the cloud each have a different save. Pick the one you want to keep playing. Nothing changes
            until you confirm.
          </p>
        </div>
        <div className="save-cards">
          {cards.map((c) => (
            <article key={c.side} className={`save-card${choice === c.side ? " picked" : ""}`} aria-labelledby={`save-${c.side}`}>
              <div className="save-card-head">
                <h3 id={`save-${c.side}`} className="px">
                  <Icon name={c.icon} size={20} /> {c.heading}
                </h3>
                {newer === c.side && <span className="px tag">NEWER</span>}
              </div>
              <dl className="save-rows">
                <div>
                  <dt>Last saved</dt>
                  <dd>{formatWhen(c.save.updatedAt)}</dd>
                </div>
                <div>
                  <dt>Where</dt>
                  <dd>{c.where}</dd>
                </div>
                <div>
                  <dt>Play time</dt>
                  <dd>{c.save.playTime ? formatPlayTime(c.save.playTime) : "Not recorded"}</dd>
                </div>
              </dl>
              <button
                type="button"
                className={`btn wide${choice === c.side ? " primary" : ""}`}
                aria-pressed={choice === c.side}
                disabled={busy}
                onClick={() => setChoice(c.side)}
              >
                {c.action}
              </button>
              {recommended === c.side && !choice && <p className="fine center">Suggested</p>}
            </article>
          ))}
        </div>
        {choice ? (
          <div className="confirm-bar enter" role="region" aria-label="Confirm your choice">
            <p>
              <Icon name="warn" size={20} />
              <span>
                The {replaced} will be replaced{inGame && choice === "cloud" ? " and the game restarts" : ""}.
              </span>
            </p>
            <div className="confirm-actions">
              <label className="check-row">
                <input className="check" type="checkbox" checked={backup} onChange={(e) => setBackup(e.target.checked)} />
                <span>Download a backup of the {replaced} first</span>
              </label>
              <div className="row">
                <button type="button" className="btn small" disabled={busy} onClick={() => setChoice(null)}>
                  Cancel
                </button>
                <button type="button" className="btn small primary" disabled={busy} onClick={() => void confirm()}>
                  {choice === "local" ? "Replace cloud save" : "Replace this device’s save"}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <p className="fine note">
            <Icon name="info" size={18} /> The newer save isn’t always the one you want, for example if you played further
            on another device.
          </p>
        )}
        <p className="sr-only" aria-live="polite">
          {choice ? `The ${replaced} will be replaced. Confirm to continue.` : ""}
        </p>
      </Modal>
    </div>
  );
}
