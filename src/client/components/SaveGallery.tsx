import { useCallback, useEffect, useState } from "react";
import { HISTORY_LIMIT, type SaveVersion } from "../../shared/api";
import { fetchCloudSave, fetchCloudSaveVersion, listCloudSaveHistory, restoreCloudSaveVersion } from "../saves/cloudApi";
import { backupName, downloadBytes } from "./download";
import { formatPlayTime, formatWhen } from "./format";
import { Icon } from "./icons";
import { Modal } from "./Modal";

type Props = {
  romHash: string;
  title: string;
  /** Cloud backup is on; previous saves are only kept in the cloud. */
  cloudSync: boolean;
  /**
   * Restores `version` in a running game (reboots it with that save). Without it the
   * cloud save is switched and the game loads it the next time it's opened.
   */
  onRestore?: ((version: SaveVersion) => Promise<void>) | undefined;
  /** Why restoring can't happen right now, if it can't. */
  restoreBlocked?: string | null | undefined;
  onClose: () => void;
};

type Gallery =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; current: SaveVersion | null; versions: SaveVersion[] };

/** A game's saves in the cloud, each with a picture of where the player was: go back to one. */
export function SaveGallery({ romHash, title, cloudSync, onRestore, restoreBlocked, onClose }: Props) {
  const [gallery, setGallery] = useState<Gallery>({ state: "loading" });
  const [confirm, setConfirm] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!cloudSync) return;
    setGallery({ state: "loading" });
    listCloudSaveHistory(romHash).then(
      ({ current, versions }) => setGallery({ state: "ready", current, versions }),
      () => setGallery({ state: "error" }),
    );
  }, [romHash, cloudSync]);
  useEffect(load, [load]);

  const download = async (v: SaveVersion, isCurrent: boolean) => {
    try {
      const full = isCurrent ? await fetchCloudSave(v.romHash) : await fetchCloudSaveVersion(v.romHash, v.revision);
      if (!full) return setMessage("That save isn’t kept any more.");
      downloadBytes(full.sram, backupName(v.gameId, "cloud"));
    } catch {
      setMessage("Couldn’t reach the cloud to download that save.");
    }
  };

  const restore = async (v: SaveVersion) => {
    setBusy(true);
    setMessage(null);
    try {
      if (onRestore) {
        await onRestore(v);
        return onClose();
      }
      const restored = await restoreCloudSaveVersion(v.romHash, v.revision);
      setConfirm(null);
      setMessage(restored ? "Restored. The game carries on from this save the next time you play it." : "That save isn’t kept any more.");
      load();
    } catch (err) {
      setMessage(err instanceof Error && err.message ? err.message : "Couldn’t restore that save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const card = (v: SaveVersion, isCurrent: boolean) => (
    <li key={v.revision} className={`shot-card${isCurrent ? " current" : ""}`}>
      {v.screenshot ? (
        <img className="shot" src={`data:image/png;base64,${v.screenshot}`} alt={`${title} when this save was made`} />
      ) : (
        <span className="shot shot-empty">No picture</span>
      )}
      <span className="shot-meta">
        {isCurrent && <span className="tag px">CURRENT</span>}
        <strong>{formatWhen(v.updatedAt)}</strong>
        {v.playTime ? <small>{formatPlayTime(v.playTime)} played</small> : null}
      </span>
      {confirm === v.revision ? (
        <div className="confirm-inline enter" role="alertdialog" aria-labelledby={`restore-${v.revision}`}>
          <p id={`restore-${v.revision}`}>
            {onRestore
              ? "Go back to this save? The game restarts from it. Your current save is kept here, so you can switch back."
              : "Go back to this save? Your current save is kept here, so you can switch back."}
          </p>
          <div className="row end">
            <button type="button" className="btn small" disabled={busy} onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button type="button" className="btn small primary" disabled={busy} onClick={() => void restore(v)}>
              {busy ? "Restoring…" : "Restore"}
            </button>
          </div>
        </div>
      ) : (
        <span className="row shot-actions">
          <button
            type="button"
            className="ibtn small tip"
            data-tip="Download"
            aria-label={`Download the save from ${formatWhen(v.updatedAt)}`}
            onClick={() => void download(v, isCurrent)}
          >
            <Icon name="download" size={17} />
          </button>
          {!isCurrent && (
            <button
              type="button"
              className="btn small grow"
              disabled={busy || !!restoreBlocked}
              title={restoreBlocked ?? undefined}
              onClick={() => {
                setMessage(null);
                setConfirm(v.revision);
              }}
            >
              Restore
            </button>
          )}
        </span>
      )}
    </li>
  );

  return (
    <Modal labelledBy="gallery-title" onClose={busy ? undefined : onClose} className="gallery">
      <div className="gallery-head">
        <h2 id="gallery-title">Previous saves · {title}</h2>
        <button type="button" className="ibtn" autoFocus onClick={onClose} disabled={busy} aria-label="Close">
          <Icon name="close" size={18} />
        </button>
      </div>
      {!cloudSync ? (
        <p className="muted">Previous saves are kept in the cloud. Turn on Cloud backup in Account to start keeping them.</p>
      ) : gallery.state === "loading" ? (
        <p className="px dim-ink blink">LOADING…</p>
      ) : gallery.state === "error" ? (
        <p className="muted">
          Couldn’t reach the cloud.{" "}
          <button type="button" className="link" onClick={load}>
            Try again
          </button>
        </p>
      ) : !gallery.current ? (
        <p className="muted">No saves in the cloud for this game yet. Play it and they back up here after it saves.</p>
      ) : (
        <>
          <p className="fine">
            Each time the game saves, the one before is kept, up to {HISTORY_LIMIT}. Pictures are from a few seconds before the game saved.
          </p>
          {restoreBlocked && <p className="fine gallery-warn">{restoreBlocked}</p>}
          <ul className="gallery-grid">
            {card(gallery.current, true)}
            {gallery.versions.map((v) => card(v, false))}
          </ul>
          {gallery.versions.length === 0 && <p className="fine">No earlier saves yet. They show up here as you keep playing.</p>}
        </>
      )}
      {message && (
        <p className="fine" role="status">
          {message}
        </p>
      )}
    </Modal>
  );
}

