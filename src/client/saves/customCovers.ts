/**
 * Images the player chose as a game's cover, by ROM hash, in a database of
 * their own so adding them never has to upgrade the main one. Signed in, they
 * also go to the account (coverSync.ts), so they show on every device.
 *
 * `version` is the account's name for the image this record holds; a record
 * without one was picked here and hasn't reached the account yet. A cover
 * removed here that the account still has is kept as a `removed` marker until
 * the account forgets it too.
 */

export type CustomCover = {
  romHash: string;
  data: ArrayBuffer;
  type: string;
  version?: string;
  removed?: true;
  /** When it was picked here; an upload only marks the record it started from as synced. */
  edited?: number;
};

const DB_NAME = "pocket-cloud-covers";
const COVERS = "covers";
/** Longest side of a stored cover, in pixels: plenty for a card, and a few tens of KB each. */
export const COVER_SIZE = 480;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(COVERS, { keyPath: "romHash" });
    req.onsuccess = () => {
      const db = req.result;
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

async function run<T>(mode: IDBTransactionMode, use: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const req = use((await openDb()).transaction(COVERS, mode).objectStore(COVERS));
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** The covers to show. */
export async function listCustomCovers(): Promise<CustomCover[]> {
  return (await listCoverRecords()).filter((c) => !c.removed);
}

/** Every record, including removals the account hasn't heard about yet. */
export async function listCoverRecords(): Promise<CustomCover[]> {
  return run("readonly", (s) => s.getAll());
}

export async function putCustomCover(cover: CustomCover): Promise<void> {
  await run("readwrite", (s) => s.put(cover));
}

/** The player picked this image for the game here: shown now, sent to the account on the next sync. */
export async function pickCustomCover(romHash: string, data: ArrayBuffer, type: string): Promise<void> {
  await putCustomCover({ romHash, data, type, edited: Date.now() });
}

/** The player took the game's image away here: every device should lose it, once the account knows. */
export async function removeCustomCover(romHash: string): Promise<void> {
  await updateCustomCover(romHash, (current) =>
    current?.version ? { romHash, data: new ArrayBuffer(0), type: "", version: current.version, removed: true } : current ? null : undefined,
  );
}

/**
 * Reads the game's record and writes what `change` makes of it, in one transaction, so a cover the
 * player picks meanwhile is never overwritten by an older decision. `change` returns the new record,
 * null to delete it, or undefined to leave it.
 */
export async function updateCustomCover(
  romHash: string,
  change: (current: CustomCover | undefined) => CustomCover | null | undefined,
): Promise<void> {
  const store = (await openDb()).transaction(COVERS, "readwrite").objectStore(COVERS);
  await new Promise<void>((resolve, reject) => {
    const get = store.get(romHash);
    get.onsuccess = () => {
      const next = change(get.result as CustomCover | undefined);
      if (next === null) store.delete(romHash);
      else if (next) store.put(next);
    };
    store.transaction.oncomplete = () => resolve();
    store.transaction.onerror = () => reject(store.transaction.error);
  });
}

/** Forgets the record outright (no marker). */
export async function deleteCustomCover(romHash: string): Promise<void> {
  await run("readwrite", (s) => s.delete(romHash));
}

/** For tests. */
export async function closeCoversDb(): Promise<void> {
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
}

/** The picked image scaled down to COVER_SIZE (never up), as a JPEG. Throws if it isn't an image the browser can read. */
export async function shrinkCover(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, COVER_SIZE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d")!;
  // Transparent images get the label's paper color instead of JPEG black.
  ctx.fillStyle = "#f4eedc";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the cover"))), "image/jpeg", 0.85),
  );
}
