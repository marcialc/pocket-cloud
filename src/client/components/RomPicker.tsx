import { useEffect, useRef, useState, type DragEvent } from "react";
import type { CloudSaveMeta } from "../../shared/api";
import type { Preferences } from "../preferences";
import { listCloudSaves } from "../saves/cloudApi";
import { getLocalSave, requestPersistentStorage, storageUsage } from "../saves/localSaves";
import type { LibraryEntry } from "../saves/romLibrary";
import { decideLaunch } from "../saves/sync";
import { formatWhen } from "./format";
import { Brand, Icon, Ridges } from "./icons";
import { Modal } from "./Modal";
import { Badge, type BadgeKind } from "./SyncBadge";

type Props = {
  busy: string | null;
  error?: string | undefined;
  /** null while the library is still loading. */
  library: LibraryEntry[] | null;
  /** Signed in with cloud backup on: the account's games are listed too. */
  cloudLibrary: boolean;
  /** Ask once whether to keep games in the account; `missing` = games here that would be uploaded. */
  offerKeepGames: { missing: number } | null;
  onKeepGames: (on: boolean) => void;
  /** Games in this browser are being uploaded to the account. */
  backingUp: boolean;
  prefs: Preferences;
  onPrefs: (patch: Partial<Preferences>) => void;
  onOpen: (data: ArrayBuffer, fileName: string) => void;
  onPlayStored: (romHash: string) => void;
  onRemoveStored: (romHash: string, alsoSave: boolean, alsoCloud: boolean) => void;
  onRenameStored: (romHash: string, name: string) => void;
  /** Signed-in email, or null. */
  account: string | null;
  onAccount: () => void;
  onControls: () => void;
};

const ACCEPT = ".gb,.gbc,.sgb,application/octet-stream";

/** Label stripe colors, picked from the ROM hash so a game keeps its color. */
const HUES = ["#d6384a", "#2a615c", "#c98a1b", "#6a5a8c", "#4f7a3a", "#a4506f"];

type GameSync = { kind: BadgeKind; label: string } | null;

export function RomPicker({
  busy,
  error,
  library: loadedLibrary,
  cloudLibrary,
  offerKeepGames,
  onKeepGames,
  backingUp,
  prefs,
  onPrefs,
  onOpen,
  onPlayStored,
  onRemoveStored,
  onRenameStored,
  account,
  onAccount,
  onControls,
}: Props) {
  const library = loadedLibrary ?? [];
  const keepingGames = cloudLibrary && prefs.cloudRoms === "on";
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<LibraryEntry | null>(null);
  const [renaming, setRenaming] = useState<LibraryEntry | null>(null);
  const [storage, setStorage] = useState<{ usage: number; persisted: boolean } | null>(null);
  const [syncByRom, setSyncByRom] = useState<Record<string, GameSync>>({});

  useEffect(() => {
    storageUsage().then(setStorage, () => setStorage(null));
  }, [loadedLibrary]);

  // Per-game sync badge: compare each game's local save with the cloud list.
  useEffect(() => {
    let live = true;
    (async () => {
      let cloud: Map<string, CloudSaveMeta> | null = null;
      if (prefs.cloudSync) {
        try {
          cloud = new Map((await listCloudSaves()).map((s) => [s.romHash, s]));
        } catch {
          cloud = null;
        }
      }
      const entries = await Promise.all(
        library.map(async (rom): Promise<[string, GameSync]> => {
          if (!prefs.cloudSync) return [rom.romHash, { kind: "offline", label: "DEVICE ONLY" }];
          if (!cloud) return [rom.romHash, { kind: "offline", label: "OFFLINE" }];
          const local = await getLocalSave(rom.romHash).catch(() => null);
          const d = decideLaunch(local, cloud.get(rom.romHash) ?? null);
          if (d.use === "none") return [rom.romHash, null];
          if (d.use === "ask") return [rom.romHash, { kind: "conflict", label: "CONFLICT" }];
          if (d.use === "local" && d.push) return [rom.romHash, { kind: "syncing", label: "PENDING" }];
          return [rom.romHash, { kind: "synced", label: "SYNCED" }];
        }),
      );
      if (live) setSyncByRom(Object.fromEntries(entries));
    })();
    return () => {
      live = false;
    };
  }, [loadedLibrary, prefs.cloudSync]);

  const openFile = async (file: File | undefined) => {
    if (!file) return;
    onOpen(await file.arrayBuffer(), file.name);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void openFile(e.dataTransfer.files[0]);
  };

  return (
    <main
      className="page picker"
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="page-head">
        <Brand />
        <div className="head-actions">
          <button type="button" className="btn small" onClick={onControls}>
            <Icon name="gamepad" size={18} />
            <span className="hide-narrow">CONTROLS</span>
            <span className="sr-only">Keyboard controls</span>
          </button>
          <button type="button" className="btn small" onClick={onAccount}>
            <Icon name="user" size={18} />
            <span className="hide-narrow">{account ? "ACCOUNT" : "SIGN IN"}</span>
            <span className="sr-only">{account ? `Account, signed in as ${account}` : "Sign in and saves"}</span>
          </button>
        </div>
      </header>

      <section className="insert plastic" aria-labelledby="insert-title">
        <div className={`slot${dragging ? " over" : ""}${busy ? " busy" : ""}`}>
          <span className="slot-mouth" aria-hidden />
          {busy ? (
            <p className="px slot-headline blink" role="status">
              {busy}
            </p>
          ) : (
            <>
              <p className="px slot-headline">{dragging ? "RELEASE TO INSERT" : "DROP A CARTRIDGE HERE"}</p>
              <p className="muted">
                {dragging ? "Let go and it loads in your browser." : "Drag a .gb or .gbc file onto this page."}
              </p>
            </>
          )}
          {error && !busy && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="insert-side">
          <h1 id="insert-title" className="px">INSERT A CARTRIDGE</h1>
          <p className="muted">Load a .gb or .gbc dump of a cartridge you own. It opens right here in your browser.</p>
          <div>
            <button type="button" className="btn primary" disabled={!!busy} onClick={() => input.current?.click()}>
              <Icon name="upload" size={16} /> Choose file
            </button>
          </div>
          <label className="switch-row">
            <input
              className="switch"
              type="checkbox"
              role="switch"
              checked={prefs.rememberRom}
              onChange={(e) => onPrefs({ rememberRom: e.target.checked })}
            />
            <span>
              <strong>Remember this game</strong>
              <small>
                {keepingGames
                  ? "Keeps a copy in this browser, so it’s one click next time."
                  : "Keeps a copy in this browser only, so it’s one click next time. Never uploaded."}
              </small>
            </span>
          </label>
          <p className="lock-line">
            <Icon name="lock" size={15} />{" "}
            {keepingGames
              ? "Games you open are kept privately in your account, on any device you sign in to."
              : "The ROM never leaves your device."}
          </p>
        </div>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            void openFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </section>

      {offerKeepGames && (
        <section className="notice info stack-sm" aria-labelledby="keep-games-title">
          <Icon name="upload" size={18} />
          <div className="stack-sm">
            <strong id="keep-games-title">Keep your games in your account?</strong>
            <span>
              Your ROM files are uploaded privately to your account, so they’re ready on any device you sign in to.
              {offerKeepGames.missing > 0 &&
                ` ${offerKeepGames.missing} ${offerKeepGames.missing === 1 ? "game" : "games"} in this browser will be backed up now.`}{" "}
              You can change this under Account.
            </span>
            <div className="row">
              <button type="button" className="btn small primary" onClick={() => onKeepGames(true)}>
                Keep my games
              </button>
              <button type="button" className="btn small" onClick={() => onKeepGames(false)}>
                Not now
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="recent" aria-labelledby="recent-title">
        <div className="recent-head">
          <h2 id="recent-title" className="px">RECENT GAMES</h2>
          {loadedLibrary && (
            <span className="dim">
              {backingUp
                ? "Backing up to your account…"
                : library.length
                  ? `${library.length} ${cloudLibrary ? "in your library" : "in this browser"}`
                  : "Nothing here yet"}
            </span>
          )}
        </div>
        {library.length ? (
          <ul className="shelf">
            {library.map((rom) => {
              const sync = syncByRom[rom.romHash];
              return (
                <li key={rom.romHash} className="game-card plastic">
                  <button
                    type="button"
                    className="game-card-play"
                    disabled={!!busy}
                    onClick={() => onPlayStored(rom.romHash)}
                    aria-label={`Play ${rom.title}, ${rom.onDevice ? `played ${formatWhen(rom.lastPlayedAt)}` : "not played on this device"}${sync ? `, ${sync.label.toLowerCase()}` : ""}`}
                  >
                    <span className="cart-grip small">
                      <Ridges />
                      <Ridges />
                    </span>
                    <span className="game-label">
                      <span className="label-stripe" style={{ background: hueFor(rom.romHash) }} />
                      <span className="px game-title">{rom.title}</span>
                      <span className="game-file">{rom.onDevice ? rom.fileName : "In your account · downloads on play"}</span>
                      <span className="game-when">
                        <Icon name="clock" size={14} />{" "}
                        {rom.onDevice ? `Played ${formatWhen(rom.lastPlayedAt)}` : "Not played on this device"}
                      </span>
                    </span>
                  </button>
                  <div className="game-card-foot">
                    {sync ? <Badge kind={sync.kind} label={sync.label} /> : <span className="dim-ink">No save yet</span>}
                    <span className="game-card-tools">
                      {rom.onDevice && (
                        <button
                          type="button"
                          className="ibtn small tip"
                          data-tip="Rename"
                          aria-label={`Rename ${rom.title}`}
                          onClick={() => setRenaming(rom)}
                        >
                          <Icon name="pencil" size={16} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="ibtn small tip"
                        data-tip={rom.onDevice ? "Remove from this browser" : "Remove from your account"}
                        aria-label={`Remove ${rom.title} from ${rom.onDevice ? "this browser" : "your account"}`}
                        onClick={() => setConfirmRemove(rom)}
                      >
                        <Icon name="trash" size={16} />
                      </button>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : loadedLibrary ? (
          <div className="shelf-empty">
            <EmptyShelfArt />
            <div className="stack-sm">
              <p className="px">YOUR SHELF IS EMPTY</p>
              <p className="dim">
                {keepingGames
                  ? "Games you open show up here so you can jump back in, on any device you sign in to."
                  : "Games you open show up here so you can jump back in. With “Remember this game” on, they stay in this browser only."}
              </p>
            </div>
          </div>
        ) : null}
      </section>

      <footer className="page-foot dim">
        {storage && storage.usage > 0 && (
          <span>
            {formatSize(storage.usage)} stored on this device
            {!storage.persisted && library.length > 0 && (
              <>
                {" · "}
                <button
                  type="button"
                  className="link on-dark"
                  onClick={async () => setStorage({ ...storage, persisted: await requestPersistentStorage() })}
                >
                  Keep permanently
                </button>
              </>
            )}
          </span>
        )}
        <span>Bring your own legally dumped cartridge.</span>
      </footer>

      {confirmRemove && (
        <RemoveDialog
          rom={confirmRemove}
          onCancel={() => setConfirmRemove(null)}
          onRemove={(alsoSave, alsoCloud) => {
            onRemoveStored(confirmRemove.romHash, alsoSave, alsoCloud);
            setConfirmRemove(null);
          }}
        />
      )}

      {renaming && (
        <RenameDialog
          rom={renaming}
          onCancel={() => setRenaming(null)}
          onRename={(name) => {
            onRenameStored(renaming.romHash, name);
            setRenaming(null);
          }}
        />
      )}
    </main>
  );
}

function hueFor(romHash: string): string {
  return HUES[parseInt(romHash.slice(0, 6), 16) % HUES.length]!;
}

function RemoveDialog({
  rom,
  onRemove,
  onCancel,
}: {
  rom: LibraryEntry;
  onRemove: (alsoSave: boolean, alsoCloud: boolean) => void;
  onCancel: () => void;
}) {
  const [alsoSave, setAlsoSave] = useState(false);
  // A game that's only in the account can only be removed from the account.
  const [alsoCloud, setAlsoCloud] = useState(!rom.onDevice);
  return (
    <Modal labelledBy="remove-title" onClose={onCancel}>
      <h2 id="remove-title">Remove {rom.title}?</h2>
      <p className="muted">
        {rom.onDevice
          ? "The ROM file is deleted from this browser. You can add it again from your own copy at any time."
          : "The ROM file is removed from your account, so your devices stop listing it. Browsers that still have their own copy keep it. You can add it again from your own copy at any time."}
      </p>
      {rom.onDevice && rom.inCloud && (
        <label className="check-row">
          <input className="check" type="checkbox" checked={alsoCloud} onChange={(e) => setAlsoCloud(e.target.checked)} />
          <span>
            <strong>Also remove it from your account</strong>
            <small>Otherwise it stays in your library on your other devices. Browsers that have their own copy keep it either way.</small>
          </span>
        </label>
      )}
      <label className="check-row">
        <input className="check" type="checkbox" checked={alsoSave} onChange={(e) => setAlsoSave(e.target.checked)} />
        <span>
          <strong>Also delete this game’s save on this device</strong>
          <small>Your cloud save is kept either way.</small>
        </span>
      </label>
      <div className="dialog-foot">
        <button type="button" className="btn small" onClick={onCancel} autoFocus>
          Cancel
        </button>
        <button type="button" className="btn small primary" onClick={() => onRemove(alsoSave, alsoCloud)}>
          Remove
        </button>
      </div>
    </Modal>
  );
}

function RenameDialog({
  rom,
  onRename,
  onCancel,
}: {
  rom: LibraryEntry;
  onRename: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(rom.title);
  return (
    <Modal labelledBy="rename-title" onClose={onCancel}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          onRename(name);
        }}
      >
        <h2 id="rename-title">Rename game</h2>
        <p className="muted">Only changes the name in your list. Saves are not affected. Leave it blank to use the cartridge name.</p>
        <input
          className="field"
          value={name}
          maxLength={60}
          autoFocus
          onFocus={(e) => e.target.select()}
          onChange={(e) => setName(e.target.value)}
          aria-label="Game name"
        />
        <div className="dialog-foot">
          <button type="button" className="btn small" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn small primary">
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EmptyShelfArt() {
  return (
    <svg width="132" height="120" viewBox="0 0 33 30" shapeRendering="crispEdges" aria-hidden>
      <path fill="#4a4254" d="M4 10h18v1H4zM3 11h1v18H3zM22 11h1v4h-1zM23 15h1v14h-1zM4 29h19v1H4z" />
      <path fill="#d9d4c7" d="M4 11h18v4H4zM4 15h19v14H4z" />
      <path fill="#a39d90" d="M6 12h1v2H6zM8 12h1v2H8zM10 12h1v2H10zM12 12h1v2h-1zM14 12h1v2h-1z" />
      <path fill="#f4eedc" d="M6 17h15v9H6z" />
      <path fill="#d6384a" d="M7 18h13v1H7z" />
      <path fill="#2a615c" d="M7 20h13v1H7z" />
      <path fill="#efe9f5" d="M20 2h6v1h-6zM18 3h10v1H18zM17 4h13v1H17zM17 5h14v1H17zM18 6h12v1H18z" />
      <path fill="#b3a9bf" d="M26 0h2v1h-1v1h1v1h-2V2h1V1h-1zM30 1h2v1h-1v1h1v1h-2V3h1V2h-1z" />
    </svg>
  );
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}
