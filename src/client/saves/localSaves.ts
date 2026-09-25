/**
 * IndexedDB persistence for battery saves (and, optionally, the last ROM so
 * the player can resume without re-picking the file). Everything here stays
 * in the browser.
 */

import { sha1Hex } from "../covers";

export type CloudSyncState = {
  /** Cloud revision this local save was last reconciled with. */
  revision: number;
  /** SRAM hash stored in the cloud at that revision. */
  sramHash: string;
  /** Cartridge clock base the cloud had (see LocalGameSave.rtcBase). */
  rtcBase?: number;
};

export type LocalGameSave = {
  gameId: string;
  romHash: string;
  sram: ArrayBuffer;
  sramHash: string;
  /** When this SRAM content was produced (ms since epoch). */
  updatedAt: number;
  /** Milliseconds of emulation accumulated with this save. */
  playTime: number;
  /**
   * Wall-clock time at which the cartridge's real-time clock read zero (see
   * emulator/rtc.ts): the clock chip's battery, kept with the save it belongs to.
   * Missing on saves made before the clock was emulated.
   */
  rtcBase?: number;
  cloud: CloudSyncState | null;
};

/**
 * A ROM kept in this browser so the player doesn't have to pick the file
 * again. ROM bytes never leave the device — this store is local only.
 */
export type StoredRom = {
  romHash: string;
  fileName: string;
  /** Cartridge header title, for the library list. */
  title: string;
  /**
   * Name the player gave this game before names moved to the synced shelf
   * (shared/shelf.ts). Moved there once and then removed (see legacyNames).
   */
  customName?: string;
  /** SHA-1 of the ROM, to find its box art (client/covers.ts). Added by putRom; older entries get it on getRom. */
  sha1?: string;
  data: ArrayBuffer;
  addedAt: number;
  lastPlayedAt: number;
};

/** Library entry without the ROM bytes (cheap to list). */
export type RomSummary = Omit<StoredRom, "data"> & { size: number };

const DB_NAME = "pocket-cloud";
/** 2: added ROM_SUMMARIES, so listing the library doesn't read every ROM's bytes. */
const DB_VERSION = 2;
const SAVES = "saves";
const ROMS = "roms";
/** Every ROM's RomSummary, kept in step with ROMS by every write to it. */
const ROM_SUMMARIES = "romSummaries";

/** Another tab still has the database open with an older version and won't let go. */
export class DbBlockedError extends Error {
  constructor() {
    super("Pocket Cloud is open in another tab that needs reloading. Close or reload it, then try again.");
    this.name = "DbBlockedError";
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  let blocked = false;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SAVES)) db.createObjectStore(SAVES, { keyPath: "romHash" });
      if (!db.objectStoreNames.contains(ROMS)) db.createObjectStore(ROMS, { keyPath: "romHash" });
      if (!db.objectStoreNames.contains(ROM_SUMMARIES)) {
        const summaries = db.createObjectStore(ROM_SUMMARIES, { keyPath: "romHash" });
        // Before version 2 only the full ROMs were kept: copy each one's details, one ROM at a time.
        // SHA-1s missing here are added later from the bytes (see getRom, addMissingSha1).
        if (event.oldVersion > 0) {
          req.transaction!.objectStore(ROMS).openCursor().onsuccess = (e) => {
            const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
            if (!cursor) return;
            summaries.put(summarize(cursor.value as StoredRom));
            cursor.continue();
          };
        }
      }
    };
    // Every connection this tab had is closed below on versionchange, so this means a tab running
    // older code (which never closes). Waiting would hang with no word why; say so instead.
    req.onblocked = () => {
      blocked = true;
      reject(new DbBlockedError());
    };
    req.onsuccess = () => {
      const db = req.result;
      // The other tab closed after all, but this open was already given up on.
      if (blocked) return db.close();
      // Another tab wants to upgrade (or delete) the database: let it, and reopen on next use.
      db.onversionchange = () => {
        db.close();
        if (dbPromise === opening) dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  dbPromise = opening;
  opening.catch(() => {
    if (dbPromise === opening) dbPromise = null;
  });
  return opening;
}

/** A ROM's library entry: everything but the bytes. */
function summarize({ data, ...rest }: StoredRom): RomSummary {
  return { ...rest, size: data.byteLength };
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await openDb()).transaction(name, mode).objectStore(name);
}

export async function getLocalSave(romHash: string): Promise<LocalGameSave | null> {
  return (await request((await store(SAVES, "readonly")).get(romHash))) ?? null;
}

export async function putLocalSave(save: LocalGameSave): Promise<void> {
  await request((await store(SAVES, "readwrite")).put(save));
}

export async function deleteLocalSave(romHash: string): Promise<void> {
  await request((await store(SAVES, "readwrite")).delete(romHash));
}

/**
 * Forget which cloud revision each local save was reconciled with. Needed when
 * the player identity changes: revisions from another player's saves mean
 * nothing, and trusting them could overwrite the restored cloud save.
 */
export async function clearCloudSyncState(): Promise<void> {
  const saves: LocalGameSave[] = await request((await store(SAVES, "readonly")).getAll());
  const s = await store(SAVES, "readwrite");
  await Promise.all(saves.map((save) => request(s.put({ ...save, cloud: null }))));
}

/** Adds or updates a ROM in the library. */
export async function putRom(rom: StoredRom): Promise<void> {
  const full = { ...rom, sha1: rom.sha1 ?? (await sha1Hex(rom.data)) };
  const tx = (await openDb()).transaction([ROMS, ROM_SUMMARIES], "readwrite");
  tx.objectStore(ROMS).put(full);
  tx.objectStore(ROM_SUMMARIES).put(summarize(full));
  await done(tx);
}

/** Library entries, most recently played first (ROM bytes not read). */
export async function listRoms(): Promise<RomSummary[]> {
  const all: RomSummary[] = await request((await store(ROM_SUMMARIES, "readonly")).getAll());
  return all
    .map((rom) => ({
      ...rom,
      title: rom.title || rom.fileName,
      addedAt: rom.addedAt ?? rom.lastPlayedAt,
    }))
    .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);
}

/** Stores a ROM's SHA-1, unless it was removed or re-added (with the hash) meanwhile. */
async function addSha1(rom: StoredRom, sha1: string): Promise<void> {
  const tx = (await openDb()).transaction([ROMS, ROM_SUMMARIES], "readwrite");
  const summaries = tx.objectStore(ROM_SUMMARIES);
  const current: RomSummary | undefined = await request(summaries.get(rom.romHash));
  if (current && !current.sha1) {
    tx.objectStore(ROMS).put({ ...rom, sha1 });
    summaries.put({ ...current, sha1 });
  }
  await done(tx);
}

export async function getRom(romHash: string): Promise<StoredRom | null> {
  const rom: StoredRom | undefined = await request((await store(ROMS, "readonly")).get(romHash));
  if (!rom || rom.sha1) return rom ?? null;
  // Stored before SHA-1s were kept: the bytes are here now, so work it out once.
  const sha1 = await sha1Hex(rom.data);
  // Best effort: without it the hash is just worked out again next time.
  await addSha1(rom, sha1).catch(() => {});
  return { ...rom, sha1 };
}

/**
 * Works out the SHA-1 (for box art) of ROMs stored before it was kept, reading
 * one ROM's bytes at a time. Returns how many were added.
 */
export async function addMissingSha1(): Promise<number> {
  let added = 0;
  for (const summary of await listRoms()) {
    if (summary.sha1) continue;
    if ((await getRom(summary.romHash))?.sha1) added++;
  }
  return added;
}

export async function touchRom(romHash: string): Promise<void> {
  const rom = await getRom(romHash);
  if (rom) await putRom({ ...rom, lastPlayedAt: Date.now() });
}

/** Names given in this browser before they moved to the shelf, by ROM hash. */
export async function legacyNames(): Promise<Record<string, string>> {
  const all: RomSummary[] = await request((await store(ROM_SUMMARIES, "readonly")).getAll());
  return Object.fromEntries(all.flatMap((r) => (r.customName ? [[r.romHash, r.customName]] : [])));
}

/** The shelf has taken these games' names over. */
export async function forgetLegacyNames(romHashes: string[]): Promise<void> {
  for (const romHash of romHashes) {
    const rom = await getRom(romHash);
    if (!rom?.customName) continue;
    const { customName: _moved, ...rest } = rom;
    await putRom(rest);
  }
}

export async function deleteRom(romHash: string): Promise<void> {
  const tx = (await openDb()).transaction([ROMS, ROM_SUMMARIES], "readwrite");
  tx.objectStore(ROMS).delete(romHash);
  tx.objectStore(ROM_SUMMARIES).delete(romHash);
  await done(tx);
}

export async function forgetRoms(): Promise<void> {
  const tx = (await openDb()).transaction([ROMS, ROM_SUMMARIES], "readwrite");
  tx.objectStore(ROMS).clear();
  tx.objectStore(ROM_SUMMARIES).clear();
  await done(tx);
}

/** Bytes used by this origin, for the "stored on this device" line. */
export async function storageUsage(): Promise<{ usage: number; persisted: boolean } | null> {
  if (!navigator.storage?.estimate) return null;
  const { usage = 0 } = await navigator.storage.estimate();
  const persisted = (await navigator.storage.persisted?.()) ?? false;
  return { usage, persisted };
}

/**
 * Ask the browser not to evict this origin's data (ROMs and saves) when disk
 * space runs low. Chrome decides silently; Firefox prompts, so this is only
 * called from an explicit button.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  return (await navigator.storage?.persist?.()) ?? false;
}

/** For tests. */
export async function closeDb(): Promise<void> {
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
}
