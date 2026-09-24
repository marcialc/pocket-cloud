/**
 * IndexedDB persistence for battery saves (and, optionally, the last ROM so
 * the player can resume without re-picking the file). Everything here stays
 * in the browser.
 */

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
  data: ArrayBuffer;
  addedAt: number;
  lastPlayedAt: number;
};

/** Library entry without the ROM bytes (cheap to list). */
export type RomSummary = Omit<StoredRom, "data"> & { size: number };

const DB_NAME = "pocket-cloud";
const DB_VERSION = 1;
const SAVES = "saves";
const ROMS = "roms";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SAVES)) db.createObjectStore(SAVES, { keyPath: "romHash" });
      if (!db.objectStoreNames.contains(ROMS)) db.createObjectStore(ROMS, { keyPath: "romHash" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
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
  await request((await store(ROMS, "readwrite")).put(rom));
}

/** Library entries, most recently played first (ROM bytes not included). */
export async function listRoms(): Promise<RomSummary[]> {
  const all: StoredRom[] = await request((await store(ROMS, "readonly")).getAll());
  return all
    .map(({ data, ...rest }) => ({
      ...rest,
      size: data.byteLength,
      title: rest.title || rest.fileName,
      addedAt: rest.addedAt ?? rest.lastPlayedAt,
    }))
    .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);
}

export async function getRom(romHash: string): Promise<StoredRom | null> {
  return (await request((await store(ROMS, "readonly")).get(romHash))) ?? null;
}

export async function touchRom(romHash: string): Promise<void> {
  const rom = await getRom(romHash);
  if (rom) await putRom({ ...rom, lastPlayedAt: Date.now() });
}

/** Names given in this browser before they moved to the shelf, by ROM hash. */
export async function legacyNames(): Promise<Record<string, string>> {
  const all: StoredRom[] = await request((await store(ROMS, "readonly")).getAll());
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
  await request((await store(ROMS, "readwrite")).delete(romHash));
}

export async function forgetRoms(): Promise<void> {
  await request((await store(ROMS, "readwrite")).clear());
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
