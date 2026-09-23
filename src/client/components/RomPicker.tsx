import { useEffect, useRef, useState, type DragEvent } from "react";
import type { CloudSaveMeta } from "../../shared/api";
import {
  MAX_GROUP_NAME,
  MAX_GROUPS,
  addGroup,
  removeGroup,
  renameGroup,
  setGameGroups,
  toggleFavorite,
  type Shelf,
  type ShelfGroup,
} from "../../shared/shelf";
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
  /** Friends and leaderboards (signed in only). */
  onFriends: () => void;
};

const ACCEPT = ".gb,.gbc,.sgb,application/octet-stream";

/** Label stripe colors, picked from the ROM hash so a game keeps its color. */
const HUES = ["#d6384a", "#2a615c", "#c98a1b", "#6a5a8c", "#4f7a3a", "#a4506f"];

type GameSync = { kind: BadgeKind; label: string } | null;

const SHELF_FULL = "Your favorites and groups are full. Take some games out of them to add more.";

/** Which games the shelf shows: all, favorites, or one group (by id). */
type View = "all" | "favorites" | (string & {});

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
  onFriends,
}: Props) {
  const library = loadedLibrary ?? [];
  const keepingGames = cloudLibrary && prefs.cloudRoms === "on";
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<LibraryEntry | null>(null);
  const [renaming, setRenaming] = useState<LibraryEntry | null>(null);
  const [storage, setStorage] = useState<{ usage: number; persisted: boolean } | null>(null);
  const [syncByRom, setSyncByRom] = useState<Record<string, GameSync>>({});
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("all");
  const [grouping, setGrouping] = useState<LibraryEntry | null>(null);
  const [groupName, setGroupName] = useState<{ group: ShelfGroup | null } | null>(null);
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState<ShelfGroup | null>(null);

  const shelf = prefs.shelf;
  // A change the shelf had no room for comes back as the same shelf.
  const [shelfFull, setShelfFull] = useState(false);
  const setShelf = (next: Shelf) => {
    setShelfFull(next === shelf);
    if (next !== shelf) onPrefs({ shelf: next });
  };
  const favorites = new Set(shelf.favorites);
  // A group deleted here or on another device falls back to showing everything.
  const activeGroup = shelf.groups.find((g) => g.id === view) ?? null;
  const current: View = view === "favorites" || activeGroup ? view : "all";
  const countOf = (hashes: string[]) => library.filter((rom) => hashes.includes(rom.romHash)).length;
  // Favorites first; otherwise the library's own order (most recently played first).
  const ordered = [...library.filter((rom) => favorites.has(rom.romHash)), ...library.filter((rom) => !favorites.has(rom.romHash))];
  const inView =
    current === "all"
      ? ordered
      : ordered.filter((rom) => (activeGroup ? activeGroup.roms.includes(rom.romHash) : favorites.has(rom.romHash)));
  const search = query.trim().toLowerCase();
  const shown = search
    ? inView.filter((rom) => rom.title.toLowerCase().includes(search) || rom.fileName.toLowerCase().includes(search))
    : inView;

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
          {account && (
            <button type="button" className="btn small" onClick={onFriends}>
              <Icon name="friends" size={18} />
              <span className="hide-narrow">FRIENDS</span>
              <span className="sr-only">Friends and leaderboards</span>
            </button>
          )}
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
          <h2 id="recent-title" className="px">LIBRARY</h2>
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
        {library.length > 0 && (
          <div className="shelf-tools">
            <label className="search-field">
              <Icon name="search" size={18} />
              <input
                type="search"
                className="field"
                placeholder="Search your games"
                aria-label="Search your games"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="chips" role="group" aria-label="Show">
              <Chip label="All" count={library.length} pressed={current === "all"} onClick={() => setView("all")} />
              <Chip
                icon="star"
                label="Favorites"
                count={countOf(shelf.favorites)}
                pressed={current === "favorites"}
                onClick={() => setView("favorites")}
              />
              {shelf.groups.map((g) => (
                <Chip
                  key={g.id}
                  icon="folder"
                  label={g.name}
                  count={countOf(g.roms)}
                  pressed={current === g.id}
                  onClick={() => setView(g.id)}
                />
              ))}
              {shelf.groups.length < MAX_GROUPS && (
                <button type="button" className="chip add" onClick={() => setGroupName({ group: null })}>
                  <Icon name="plus" size={14} /> New group
                </button>
              )}
            </div>
            {activeGroup && (
              <div className="group-bar">
                <button type="button" className="link on-dark" onClick={() => setGroupName({ group: activeGroup })}>
                  Rename group
                </button>
                <button type="button" className="link on-dark" onClick={() => setConfirmDeleteGroup(activeGroup)}>
                  Delete group
                </button>
              </div>
            )}
          </div>
        )}
        {shelfFull && (
          <p className="dim" role="alert">
            {SHELF_FULL}
          </p>
        )}
        {library.length > 0 && shown.length === 0 && (
          <p className="shelf-none dim" role="status">
            {search
              ? `No games match “${query.trim()}”.`
              : current === "favorites"
                ? "No favorites yet. Tap the star on a game to pin it to the top."
                : "No games in this group yet. Use the folder button on a game to add it."}
          </p>
        )}
        {shown.length ? (
          <ul className="shelf">
            {shown.map((rom) => {
              const sync = syncByRom[rom.romHash];
              const favorite = favorites.has(rom.romHash);
              return (
                <li key={rom.romHash} className="game-card plastic">
                  <button
                    type="button"
                    className={`fav-toggle tip tip-below${favorite ? " on" : ""}`}
                    data-tip={favorite ? "Remove from favorites" : "Add to favorites"}
                    aria-label={`Favorite ${rom.title}`}
                    aria-pressed={favorite}
                    onClick={() => setShelf(toggleFavorite(shelf, rom.romHash))}
                  >
                    <Icon name="star" size={18} />
                  </button>
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
                      <button
                        type="button"
                        className="ibtn small tip"
                        data-tip="Groups"
                        aria-label={`Groups for ${rom.title}`}
                        onClick={() => setGrouping(rom)}
                      >
                        <Icon name="folder" size={16} />
                      </button>
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
        ) : loadedLibrary && !library.length ? (
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

      {grouping && (
        <GroupsDialog
          rom={grouping}
          shelf={shelf}
          onCancel={() => setGrouping(null)}
          onSave={(next) => {
            setShelf(next);
            setGrouping(null);
          }}
        />
      )}

      {groupName && (
        <GroupNameDialog
          group={groupName.group}
          onCancel={() => setGroupName(null)}
          onSave={(name) => {
            if (groupName.group) {
              setShelf(renameGroup(shelf, groupName.group.id, name));
            } else {
              const id = crypto.randomUUID();
              setShelf(addGroup(shelf, name, id));
              setView(id);
            }
            setGroupName(null);
          }}
        />
      )}

      {confirmDeleteGroup && (
        <Modal labelledBy="delete-group-title" onClose={() => setConfirmDeleteGroup(null)}>
          <h2 id="delete-group-title">Delete {confirmDeleteGroup.name}?</h2>
          <p className="muted">Only the group goes. The games in it stay in your library.</p>
          <div className="dialog-foot">
            <button type="button" className="btn small" onClick={() => setConfirmDeleteGroup(null)} autoFocus>
              Cancel
            </button>
            <button
              type="button"
              className="btn small primary"
              onClick={() => {
                setShelf(removeGroup(shelf, confirmDeleteGroup.id));
                setView("all");
                setConfirmDeleteGroup(null);
              }}
            >
              Delete
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}

function Chip({
  label,
  count,
  pressed,
  onClick,
  icon,
}: {
  label: string;
  count: number;
  pressed: boolean;
  onClick: () => void;
  icon?: "star" | "folder";
}) {
  return (
    <button type="button" className="chip" aria-pressed={pressed} onClick={onClick}>
      {icon && <Icon name={icon} size={14} />}
      <span className="chip-label">{label}</span>
      <span className="chip-count">{count}</span>
    </button>
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

/** Picks which groups a game is in, and can make a new group on the spot. */
function GroupsDialog({
  rom,
  shelf,
  onSave,
  onCancel,
}: {
  rom: LibraryEntry;
  shelf: Shelf;
  onSave: (shelf: Shelf) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(shelf);
  const [picked, setPicked] = useState(() => new Set(shelf.groups.filter((g) => g.roms.includes(rom.romHash)).map((g) => g.id)));
  const [newName, setNewName] = useState("");
  const [full, setFull] = useState(false);
  const addNew = () => {
    const id = crypto.randomUUID();
    const next = addGroup(draft, newName, id);
    setFull(next === draft);
    if (next === draft) return;
    setDraft(next);
    setPicked(new Set([...picked, id]));
    setNewName("");
  };
  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };
  return (
    <Modal labelledBy="groups-title" onClose={onCancel}>
      <h2 id="groups-title">Groups for {rom.title}</h2>
      {draft.groups.length ? (
        <div className="stack-sm group-list">
          {draft.groups.map((g) => (
            <label key={g.id} className="check-row">
              <input className="check" type="checkbox" checked={picked.has(g.id)} onChange={(e) => toggle(g.id, e.target.checked)} />
              <span>
                <strong>{g.name}</strong>
              </span>
            </label>
          ))}
        </div>
      ) : (
        <p className="muted">No groups yet. Make one below, like “RPGs” or “Playing now”.</p>
      )}
      {draft.groups.length < MAX_GROUPS && (
        <div className="new-group">
          <input
            className="field"
            value={newName}
            maxLength={MAX_GROUP_NAME}
            placeholder="New group name"
            aria-label="New group name"
            autoFocus={!draft.groups.length}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addNew();
              }
            }}
          />
          <button type="button" className="btn small" disabled={!newName.trim()} onClick={addNew}>
            <Icon name="plus" size={14} /> Add
          </button>
        </div>
      )}
      {full && (
        <p className="error" role="alert">
          {SHELF_FULL}
        </p>
      )}
      <div className="dialog-foot">
        <button type="button" className="btn small" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn small primary"
          onClick={() => {
            const next = setGameGroups(draft, rom.romHash, picked);
            const changed = draft.groups.some((g) => g.roms.includes(rom.romHash) !== picked.has(g.id));
            if (changed && next === draft) setFull(true);
            else onSave(next);
          }}
        >
          Done
        </button>
      </div>
    </Modal>
  );
}

/** Names a new group, or renames one (`group`). */
function GroupNameDialog({
  group,
  onSave,
  onCancel,
}: {
  group: ShelfGroup | null;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(group?.name ?? "");
  return (
    <Modal labelledBy="group-name-title" onClose={onCancel}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onSave(name);
        }}
      >
        <h2 id="group-name-title">{group ? "Rename group" : "New group"}</h2>
        <p className="muted">
          {group ? "Games in the group stay in it." : "Sort games into groups, like “RPGs” or “Playing now”. A game can be in more than one."}
        </p>
        <input
          className="field"
          value={name}
          maxLength={MAX_GROUP_NAME}
          autoFocus
          onFocus={(e) => e.target.select()}
          onChange={(e) => setName(e.target.value)}
          aria-label="Group name"
        />
        <div className="dialog-foot">
          <button type="button" className="btn small" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn small primary" disabled={!name.trim()}>
            {group ? "Save" : "Create"}
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
