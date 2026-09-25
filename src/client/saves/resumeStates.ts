/**
 * Where each game was left: a snapshot of the whole console (CPU, memory,
 * screen), so opening the game again carries on from that moment instead of
 * powering on. Kept in this browser only, in its own database: a snapshot is a
 * convenience, the battery save (localSaves.ts) stays the real save.
 *
 * A snapshot also holds the cartridge RAM, so it's only used while the battery
 * save is still the one it was taken with (`sramHash`); a newer save from the
 * cloud or another choice wins, and the game boots normally.
 */

import { sha256Hex } from "../../shared/api";
import type { Emulator } from "../emulator/Emulator";

export type ResumeState = {
  romHash: string;
  /** Emulator-specific snapshot (Emulator.saveState). */
  state: ArrayBuffer;
  /** SHA-256 of the cartridge RAM (Emulator.getSram) when the snapshot was taken; null if there was none. */
  sramHash: string | null;
  savedAt: number;
};

const DB_NAME = "pocket-cloud-resume";
const DB_VERSION = 1;
const STATES = "states";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STATES)) db.createObjectStore(STATES, { keyPath: "romHash" });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        if (dbPromise === opening) dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    // Another tab runs older code; snapshots are optional, so give up rather than wait.
    req.onblocked = () => reject(new Error("The resume database is busy in another tab."));
  });
  dbPromise = opening;
  opening.catch(() => {
    if (dbPromise === opening) dbPromise = null;
  });
  return opening;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await openDb()).transaction(STATES, mode).objectStore(STATES);
}

/** The battery save a snapshot has to match (see ResumeState.sramHash). */
export async function sramHashOf(sram: Uint8Array | null): Promise<string | null> {
  return sram ? sha256Hex(sram) : null;
}

export async function getResumeState(romHash: string): Promise<ResumeState | null> {
  return (await request((await store("readonly")).get(romHash))) ?? null;
}

/**
 * The snapshot to carry on from, or null to boot normally: none was taken, or
 * the battery save has changed since (`sramHash`: of the cartridge RAM just loaded).
 */
export async function resumeStateFor(romHash: string, sramHash: string | null): Promise<ArrayBuffer | null> {
  const saved = await getResumeState(romHash);
  return saved && saved.sramHash === sramHash ? saved.state : null;
}

export async function putResumeState(resume: ResumeState): Promise<void> {
  await request((await store("readwrite")).put(resume));
}

export async function deleteResumeState(romHash: string): Promise<void> {
  await request((await store("readwrite")).delete(romHash));
}

/**
 * Snapshots `emulator` as the place to carry on from, one at a time: a call
 * while one is under way waits for that one instead.
 */
export function resumeKeeper(emulator: Emulator, romHash: string): () => Promise<void> {
  let taking: Promise<void> | null = null;
  const take = async () => {
    if (!emulator.saveState) return;
    // Read at the same moment as the snapshot, which holds this cartridge RAM too.
    const sram = emulator.getSram();
    const state = await emulator.saveState();
    if (!state) return;
    await putResumeState({ romHash, state: state.slice().buffer, sramHash: await sramHashOf(sram), savedAt: Date.now() });
  };
  return () => (taking ??= take().finally(() => (taking = null)));
}

/** For tests. */
export async function closeResumeDb(): Promise<void> {
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
}
