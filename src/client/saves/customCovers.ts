/**
 * Images the player chose as a game's cover, by ROM hash. Kept in this browser
 * only (unlike box art picked by name, which the synced shelf carries), in a
 * database of their own so adding them never has to upgrade the main one.
 */

export type CustomCover = { romHash: string; data: ArrayBuffer; type: string };

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

export async function listCustomCovers(): Promise<CustomCover[]> {
  return run("readonly", (s) => s.getAll());
}

export async function putCustomCover(cover: CustomCover): Promise<void> {
  await run("readwrite", (s) => s.put(cover));
}

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
