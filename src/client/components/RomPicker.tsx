import { useEffect, useRef, useState, type DragEvent } from "react";
import type { Preferences } from "../preferences";
import { requestPersistentStorage, storageUsage, type RomSummary } from "../saves/localSaves";
import { ControlsPanel } from "./ControlsPanel";
import { formatWhen } from "./format";

type Props = {
  busy: string | null;
  error?: string | undefined;
  library: RomSummary[];
  prefs: Preferences;
  onPrefs: (patch: Partial<Preferences>) => void;
  onOpen: (data: ArrayBuffer, fileName: string) => void;
  onPlayStored: (romHash: string) => void;
  onRemoveStored: (romHash: string, alsoSave: boolean) => void;
  onRenameStored: (romHash: string, name: string) => void;
};

const ACCEPT = ".gb,.gbc,.sgb,application/octet-stream";

export function RomPicker({ busy, error, library, prefs, onPrefs, onOpen, onPlayStored, onRemoveStored, onRenameStored }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<RomSummary | null>(null);
  const [renaming, setRenaming] = useState<RomSummary | null>(null);
  const [storage, setStorage] = useState<{ usage: number; persisted: boolean } | null>(null);

  useEffect(() => {
    storageUsage().then(setStorage, () => setStorage(null));
  }, [library]);

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
      className={`landing${dragging ? " dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="cartridge">
        <div className="cartridge-notch" aria-hidden />
        <div className="cartridge-label">
          <p className="eyebrow">Pocket Cloud</p>
          <h1>Game Boy</h1>
          <p className="lede">{library.length ? "Pick a game or load a new ROM" : "Load your Game Boy ROM"}</p>
        </div>

        {busy ? (
          <p className="busy" role="status">
            <span className="blink">▶</span> {busy}
          </p>
        ) : (
          <>
            {library.length > 0 && (
              <ul className="library">
                {library.map((rom) => (
                  <li key={rom.romHash}>
                    <button className="library-item" onClick={() => onPlayStored(rom.romHash)}>
                      <span className="library-title">{rom.title}</span>
                      <span className="library-meta">
                        {formatSize(rom.size)} · played {formatWhen(rom.lastPlayedAt)}
                      </span>
                    </button>
                    <button
                      className="icon-btn library-rename"
                      title={`Rename ${rom.title}`}
                      aria-label={`Rename ${rom.title}`}
                      onClick={() => setRenaming(rom)}
                    >
                      ✎
                    </button>
                    <button
                      className="icon-btn library-remove"
                      title={`Remove ${rom.title} from this device`}
                      aria-label={`Remove ${rom.title}`}
                      onClick={() => setConfirmRemove(rom)}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="actions">
              <button className={`btn${library.length ? "" : " primary"}`} onClick={() => input.current?.click()}>
                {library.length ? "Add another ROM" : "Choose ROM"}
              </button>
            </div>
          </>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

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

        <p className="privacy">
          <LockIcon /> Your ROMs stay on this device. Only save data is synced.
        </p>

        <div className="options">
          <label>
            <input type="checkbox" checked={prefs.cloudSync} onChange={(e) => onPrefs({ cloudSync: e.target.checked })} />
            Cloud save sync
          </label>
          <label>
            <input type="checkbox" checked={prefs.rememberRom} onChange={(e) => onPrefs({ rememberRom: e.target.checked })} />
            Keep games in this browser
          </label>
          <button className="link" onClick={() => setControlsOpen(true)}>
            Keyboard controls
          </button>
        </div>

        {storage && storage.usage > 0 && (
          <p className="fine storage-line">
            {formatSize(storage.usage)} stored on this device
            {!storage.persisted && library.length > 0 && (
              <button
                className="link"
                onClick={async () => setStorage({ ...storage, persisted: await requestPersistentStorage() })}
              >
                Keep permanently
              </button>
            )}
          </p>
        )}
      </div>

      {confirmRemove && (
        <RemoveDialog
          rom={confirmRemove}
          onCancel={() => setConfirmRemove(null)}
          onRemove={(alsoSave) => {
            onRemoveStored(confirmRemove.romHash, alsoSave);
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

      {controlsOpen && (
        <ControlsPanel
          bindings={prefs.keyBindings}
          onChange={(keyBindings) => onPrefs({ keyBindings })}
          onClose={() => setControlsOpen(false)}
        />
      )}
      <p className="hint">Drop a .gb / .gbc file anywhere · Bring your own legally dumped cartridge</p>
    </main>
  );
}

function RemoveDialog({
  rom,
  onRemove,
  onCancel,
}: {
  rom: RomSummary;
  onRemove: (alsoSave: boolean) => void;
  onCancel: () => void;
}) {
  const [alsoSave, setAlsoSave] = useState(false);
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="dialog" role="dialog" aria-labelledby="remove-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="remove-title">Remove {rom.title}?</h2>
        <p>
          The ROM file is deleted from this browser. You can add it again from your own copy at any time.
        </p>
        <label className="toggle">
          <input type="checkbox" checked={alsoSave} onChange={(e) => setAlsoSave(e.target.checked)} />
          <span>
            <strong>Also delete this game's save on this device</strong>
            <small>Your cloud save is kept either way.</small>
          </span>
        </label>
        <div className="panel-foot">
          <button className="btn small" onClick={onCancel}>Cancel</button>
          <button className="btn small danger" onClick={() => onRemove(alsoSave)}>Remove</button>
        </div>
      </div>
    </div>
  );
}

function RenameDialog({
  rom,
  onRename,
  onCancel,
}: {
  rom: RomSummary;
  onRename: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(rom.title);
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form
        className="dialog"
        role="dialog"
        aria-labelledby="rename-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onRename(name);
        }}
      >
        <h2 id="rename-title">Rename game</h2>
        <p>Only changes the name in your list. Saves are not affected. Leave it blank to use the cartridge name.</p>
        <input
          className="rename-input"
          value={name}
          maxLength={60}
          autoFocus
          onFocus={(e) => e.target.select()}
          onChange={(e) => setName(e.target.value)}
          aria-label="Game name"
        />
        <div className="panel-foot">
          <button type="button" className="btn small" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn small primary">Save</button>
        </div>
      </form>
    </div>
  );
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden shapeRendering="crispEdges">
      <path fill="currentColor" d="M3 5V3h1V2h4v1h1v2h1v6H2V5zm1 0h4V3H4z" />
    </svg>
  );
}
