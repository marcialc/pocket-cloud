import { useCallback, useEffect, useState } from "react";
import type { CloudSaveMeta } from "../../shared/api";
import type { Preferences } from "../preferences";
import { authErrorMessage, fetchAccount } from "../saves/authApi";
import { deleteCloudSave, fetchCloudSave, listCloudSaves } from "../saves/cloudApi";
import { getPlayerKey, isValidPlayerKey, setPlayerKey } from "../saves/identity";
import { clearCloudSyncState, listRoms } from "../saves/localSaves";
import type { SyncStatus } from "../saves/SaveSync";
import { backupName, downloadBytes } from "./download";
import { formatWhen } from "./format";
import { Icon } from "./icons";
import { SidePanel } from "./SidePanel";
import { SignInForm } from "./SignInForm";
import { Badge, describeStatus } from "./SyncBadge";

type Props = {
  prefs: Preferences;
  onPrefs: (patch: Partial<Preferences>) => void;
  /** Sign-in finished (session cookie set). */
  onSignedIn: (email: string) => Promise<void>;
  onSignOut: (everywhere: boolean) => Promise<void>;
  /** Persist and stop syncing the current game before the player key changes. */
  onBeforeRestore?: () => Promise<void>;
  /** In-game: the running game's live status, and its save can't be deleted while it runs. */
  current?: { romHash: string; status: SyncStatus; onDownload: () => void } | undefined;
  onClose: () => void;
};

type CloudList = { state: "loading" } | { state: "error" } | { state: "ready"; saves: CloudSaveMeta[] };

/** Account, cloud saves and settings. */
export function CloudPanel({ prefs, onPrefs, onSignedIn, onSignOut, onBeforeRestore, current, onClose }: Props) {
  // undefined = still checking, null = signed out.
  const [account, setAccount] = useState<string | null | undefined>(undefined);
  const [cloud, setCloud] = useState<CloudList>({ state: "loading" });
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");

  useEffect(() => {
    let live = true;
    fetchAccount().then((email) => live && setAccount(email));
    listRoms().then(
      (roms) => live && setTitles(Object.fromEntries(roms.map((r) => [r.romHash, r.title]))),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

  const refresh = useCallback(() => {
    if (!prefs.cloudSync) return;
    setCloud({ state: "loading" });
    listCloudSaves().then(
      (saves) => setCloud({ state: "ready", saves: saves.sort((a, b) => b.updatedAt - a.updatedAt) }),
      () => setCloud({ state: "error" }),
    );
  }, [prefs.cloudSync]);
  useEffect(refresh, [refresh]);

  const nameOf = (s: CloudSaveMeta) => titles[s.romHash] ?? s.gameId;

  const download = async (s: CloudSaveMeta) => {
    try {
      const full = await fetchCloudSave(s.romHash);
      if (!full) return setAnnounce(`${nameOf(s)} has no cloud save any more.`);
      downloadBytes(full.sram, backupName(s.gameId, "cloud"));
      setAnnounce(`Downloaded a backup of ${nameOf(s)}.`);
    } catch {
      setAnnounce("Couldn’t reach the cloud to download that save.");
    }
  };

  const remove = async (s: CloudSaveMeta) => {
    try {
      await deleteCloudSave(s.romHash);
      setConfirmDelete(null);
      setCloud((c) => (c.state === "ready" ? { state: "ready", saves: c.saves.filter((x) => x.romHash !== s.romHash) } : c));
      setAnnounce(`Deleted the cloud save for ${nameOf(s)}.`);
    } catch {
      setAnnounce("Couldn’t delete that save. Check your connection and try again.");
    }
  };

  return (
    <SidePanel id="account-title" title="ACCOUNT" onClose={onClose}>
      {account === undefined ? (
        <p className="px dim-ink blink">CHECKING…</p>
      ) : account ? (
        <SignedIn email={account} onSignOut={onSignOut} />
      ) : (
        <div className="card stack">
          <SignedOutArt />
          <h3 className="h-lg">Keep your saves safe</h3>
          <p className="muted">
            Sign in with your email and your saves back up to your account, then follow you to any browser. No password:
            we email you a one-time code.
          </p>
          <ul className="ticks">
            <li>
              <Icon name="check" size={16} /> Backs up after every in-game save
            </li>
            <li>
              <Icon name="check" size={16} /> Pick up where you left off on another device
            </li>
            <li>
              <Icon name="check" size={16} /> Your games follow you too, no re-picking files
            </li>
            <li>
              <Icon name="check" size={16} /> Download a backup any time
            </li>
          </ul>
          <SignInForm onSignedIn={onSignedIn} />
        </div>
      )}

      {prefs.cloudSync && (
        <section className="stack-sm" aria-labelledby="saves-h">
          <h3 id="saves-h" className="px h-section">
            SAVES IN THE CLOUD
          </h3>
          <OverallStatus cloud={cloud} current={current?.status} onRetry={refresh} />
          {cloud.state === "ready" && cloud.saves.length === 0 && (
            <p className="card fine">No saves in the cloud yet. Play a game and they back up here after it saves.</p>
          )}
          {cloud.state === "ready" && cloud.saves.length > 0 && (
            <ul className="save-list">
              {cloud.saves.map((s) => {
                const playing = current?.romHash === s.romHash;
                const confirming = confirmDelete === s.romHash;
                return (
                  <li key={s.romHash} className="card save-row">
                    <div className="save-row-main">
                      <span className="mini-cart" aria-hidden />
                      <span className="save-row-text">
                        <strong>{nameOf(s)}</strong>
                        <small>
                          Updated {formatWhen(s.updatedAt)} · {formatBytes(s.sramSize)}
                          {playing ? " · playing now" : ""}
                        </small>
                      </span>
                      {!confirming && (
                        <>
                          <button
                            type="button"
                            className="ibtn small tip"
                            data-tip="Download backup"
                            aria-label={`Download backup of ${nameOf(s)}`}
                            onClick={() => (playing ? current!.onDownload() : void download(s))}
                          >
                            <Icon name="download" size={17} />
                          </button>
                          <button
                            type="button"
                            className="ibtn small tip danger-ink"
                            data-tip={playing ? "Can’t delete while playing" : "Delete cloud save"}
                            aria-label={`Delete cloud save for ${nameOf(s)}`}
                            disabled={playing}
                            onClick={() => {
                              setConfirmDelete(s.romHash);
                              setTimeout(() => document.getElementById(`keep-${s.romHash}`)?.focus(), 0);
                            }}
                          >
                            <Icon name="trash" size={17} />
                          </button>
                        </>
                      )}
                    </div>
                    {confirming && (
                      <div className="confirm-inline enter" role="alertdialog" aria-labelledby={`del-${s.romHash}`}>
                        <p id={`del-${s.romHash}`}>
                          Delete the cloud save for <strong>{nameOf(s)}</strong>? A copy saved in this browser stays, and backs
                          up again the next time you play it here. Download a backup first if you might want it.
                        </p>
                        <div className="row end">
                          <button id={`keep-${s.romHash}`} type="button" className="btn small" onClick={() => setConfirmDelete(null)}>
                            Keep it
                          </button>
                          <button type="button" className="btn small primary" onClick={() => void remove(s)}>
                            Delete
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {current && (
        <button type="button" className="btn small self-start" onClick={current.onDownload}>
          <Icon name="download" size={16} /> Download this game’s save
        </button>
      )}

      {account === null && <PlayerKey onBeforeRestore={onBeforeRestore} />}

      <section className="stack-sm" aria-labelledby="settings-h">
        <h3 id="settings-h" className="px h-section">
          SETTINGS
        </h3>
        <div className="card settings">
          <Setting
            title="Cloud backup"
            desc={
              account
                ? "Save files back up a few seconds after the game saves."
                : "Save files back up a few seconds after the game saves. Only save data is uploaded, never the ROM."
            }
            on={prefs.cloudSync}
            onChange={(cloudSync) => onPrefs({ cloudSync })}
          />
          {account && prefs.cloudSync && (
            <Setting
              title="Keep games in my account"
              desc="Upload the ROM files you open, privately, so they’re ready on any device you sign in to."
              on={prefs.cloudRoms === "on"}
              onChange={(on) => onPrefs({ cloudRoms: on ? "on" : "off" })}
            />
          )}
          <Setting
            title="UI sounds"
            desc="Soft clicks when you press buttons in menus. Never during play."
            on={prefs.uiSounds}
            onChange={(uiSounds) => onPrefs({ uiSounds })}
          />
          <Setting
            title="Reduce motion"
            desc="Keep screens still. Follows your system setting unless you turn this on."
            on={prefs.reduceMotion}
            onChange={(reduceMotion) => onPrefs({ reduceMotion })}
          />
          <Setting
            title="Remember games"
            desc="Keep opened games in this browser for one-click play."
            on={prefs.rememberRom}
            onChange={(rememberRom) => onPrefs({ rememberRom })}
          />
        </div>
      </section>

      <p className="lock-line">
        <Icon name="lock" size={15} />{" "}
        {account && prefs.cloudSync && prefs.cloudRoms === "on"
          ? "Your games and saves are private to your account."
          : "Only save files sync. The ROM never leaves your device."}
      </p>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </SidePanel>
  );
}

function SignedIn({ email, onSignOut }: { email: string; onSignOut: (everywhere: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signOut = async (everywhere: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await onSignOut(everywhere);
    } catch (err) {
      setError(authErrorMessage(err));
      setBusy(false);
    }
  };
  return (
    <div className="card stack-sm">
      <div className="who">
        <span className="avatar px" aria-hidden>
          {email[0]?.toUpperCase()}
        </span>
        <span className="who-text">
          <strong>{email}</strong>
          <small>Signed in with an email code</small>
        </span>
        <button type="button" className="btn small" disabled={busy} onClick={() => void signOut(false)}>
          Sign out
        </button>
      </div>
      <button type="button" className="link self-start" disabled={busy} onClick={() => void signOut(true)}>
        Sign out on all devices
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function OverallStatus({ cloud, current, onRetry }: { cloud: CloudList; current?: SyncStatus | undefined; onRetry: () => void }) {
  if (current) {
    const d = describeStatus(current);
    return (
      <p className="status-line">
        <Badge kind={d.kind} label={d.label} /> <span>{d.detail}</span>
      </p>
    );
  }
  if (cloud.state === "loading") return <p className="px dim-ink blink">LOADING…</p>;
  if (cloud.state === "error")
    return (
      <p className="status-line">
        <Badge kind="offline" label="OFFLINE" /> <span>Can’t reach the cloud right now.</span>
        <button type="button" className="link" onClick={onRetry}>
          Try again
        </button>
      </p>
    );
  const n = cloud.saves.length;
  return (
    <p className="status-line">
      <Badge kind="synced" label="SYNCED" />
      <span>{n ? `${n} ${n === 1 ? "save" : "saves"} backed up.` : "Cloud backup is on."}</span>
    </p>
  );
}

function Setting({ title, desc, on, onChange }: { title: string; desc: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="setting">
      <span>
        <strong>{title}</strong>
        <small>{desc}</small>
      </span>
      <input className="switch" type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** Anonymous identity: show/copy the player key, or restore one from another browser. */
function PlayerKey({ onBeforeRestore }: { onBeforeRestore?: (() => Promise<void>) | undefined }) {
  const key = getPlayerKey();
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [restoreKey, setRestoreKey] = useState("");
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const copy = async () => {
    await navigator.clipboard.writeText(key);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const restore = async () => {
    if (restoreKey.trim().toLowerCase() === key) return setRestoreError("That is already this browser’s key.");
    if (!isValidPlayerKey(restoreKey)) return setRestoreError("That doesn’t look like a player key.");
    await onBeforeRestore?.();
    setPlayerKey(restoreKey);
    await clearCloudSyncState();
    // Re-run the launch flow so the restored cloud save is picked up.
    window.location.reload();
  };

  return (
    <details className="card disclosure">
      <summary>
        <span className="px">PLAYER KEY</span>
        <small>Use your saves on another browser without an account</small>
      </summary>
      <div className="stack-sm">
        <p className="fine">This key is your identity: anyone who has it can load your saves.</p>
        <div className="row">
          <code className="key">{revealed ? key : "••••••••-••••-••••-••••-" + key.slice(-6)}</code>
          <button type="button" className="btn small" onClick={() => setRevealed(!revealed)}>
            {revealed ? "Hide" : "Show"}
          </button>
          <button type="button" className="btn small" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <label htmlFor="restore-key" className="field-label">
          Restore from another device
        </label>
        <div className="row">
          <input
            id="restore-key"
            className="field"
            value={restoreKey}
            onChange={(e) => {
              setRestoreKey(e.target.value);
              setRestoreError(null);
            }}
            placeholder="Paste player key"
            spellCheck={false}
            autoComplete="off"
          />
          <button type="button" className="btn small" onClick={() => void restore()} disabled={!restoreKey.trim()}>
            Use key
          </button>
        </div>
        {restoreError && (
          <p className="error" role="alert">
            {restoreError}
          </p>
        )}
        <p className="fine">The page reloads; open the same game and the cloud save is offered.</p>
      </div>
    </details>
  );
}

function SignedOutArt() {
  return (
    <svg width="72" height="48" viewBox="0 0 18 12" shapeRendering="crispEdges" aria-hidden>
      <path fill="#2a615c" d="M6 1h4v1H6zM4 2h2v1H4zM10 2h2v1h-2zM3 3h1v2H3zM12 3h1v1h-1zM13 4h2v1h-2zM1 5h2v1H1zM15 5h1v1h-1zM0 6h1v4H0zM16 6h1v4h-1zM1 10h15v1H1z" />
      <path fill="#d6384a" d="M7 5h1v1H7zM9 5h1v1H9zM6 7h1v1H6zM10 7h1v1h-1zM7 8h3v1H7z" />
    </svg>
  );
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
}
