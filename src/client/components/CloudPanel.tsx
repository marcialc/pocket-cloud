import { useState } from "react";
import { getPlayerKey, isValidPlayerKey, setPlayerKey } from "../saves/identity";
import { clearCloudSyncState } from "../saves/localSaves";

type Props = {
  cloudSync: boolean;
  onCloudSync: (enabled: boolean) => void;
  onDownloadSave: (() => void) | null;
  /** Persist and stop syncing the current game before the identity changes. */
  onBeforeRestore: () => Promise<void>;
  onClose: () => void;
};

export function CloudPanel({ cloudSync, onCloudSync, onDownloadSave, onBeforeRestore, onClose }: Props) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [restoreKey, setRestoreKey] = useState("");
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const key = getPlayerKey();

  const copy = async () => {
    await navigator.clipboard.writeText(key);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const restore = async () => {
    if (restoreKey.trim().toLowerCase() === key) return setRestoreError("That is already this browser’s key.");
    if (!isValidPlayerKey(restoreKey)) return setRestoreError("That doesn’t look like a player key.");
    await onBeforeRestore();
    setPlayerKey(restoreKey);
    await clearCloudSyncState();
    // Re-run the launch flow so the restored cloud save is picked up.
    window.location.reload();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="dialog panel" role="dialog" aria-labelledby="cloud-title" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2 id="cloud-title">Saves</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <label className="toggle">
          <input type="checkbox" checked={cloudSync} onChange={(e) => onCloudSync(e.target.checked)} />
          <span>
            <strong>Cloud sync</strong>
            <small>In-game saves are backed up to the cloud a few seconds after you save. Only save data is uploaded — never the ROM.</small>
          </span>
        </label>

        <section>
          <h3>Your player key</h3>
          <p className="fine">This key is your identity — anyone who has it can load your saves. Use it to continue on another browser.</p>
          <div className="key-row">
            <code>{revealed ? key : "••••••••-••••-••••-••••-" + key.slice(-6)}</code>
            <button className="btn small" onClick={() => setRevealed(!revealed)}>{revealed ? "Hide" : "Show"}</button>
            <button className="btn small" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
          </div>
        </section>

        <section>
          <h3>Restore from another device</h3>
          <div className="key-row">
            <input
              value={restoreKey}
              onChange={(e) => {
                setRestoreKey(e.target.value);
                setRestoreError(null);
              }}
              placeholder="Paste player key"
              spellCheck={false}
              autoComplete="off"
            />
            <button className="btn small" onClick={() => void restore()} disabled={!restoreKey.trim()}>Use key</button>
          </div>
          {restoreError && <p className="error">{restoreError}</p>}
          <p className="fine">The page reloads; pick the same ROM and the cloud save is offered.</p>
        </section>

        {onDownloadSave && (
          <section>
            <h3>Backup</h3>
            <button className="btn small" onClick={onDownloadSave}>Download .sav file</button>
          </section>
        )}
      </div>
    </div>
  );
}
