import { afterEach, describe, expect, it } from "vitest";
import {
  addMissingSha1,
  clearCloudSyncState,
  closeDb,
  deleteLocalSave,
  deleteRom,
  forgetRoms,
  getLocalSave,
  getRom,
  listRoms,
  putLocalSave,
  putRom,
  DbBlockedError,
  forgetLegacyNames,
  legacyNames,
  touchRom,
  type LocalGameSave,
  type StoredRom,
} from "./localSaves";

/** Opens the database directly, as another tab (or older code) would. */
function openRaw(version?: number, upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = version === undefined ? indexedDB.open("pocket-cloud") : indexedDB.open("pocket-cloud", version);
    req.onupgradeneeded = () => upgrade?.(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function write(db: IDBDatabase, name: string, values: object[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, "readwrite");
    for (const value of values) tx.objectStore(name).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase("pocket-cloud");
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

const save = (over: Partial<LocalGameSave> = {}): LocalGameSave => ({
  gameId: "POKEMON RED",
  romHash: "a".repeat(64),
  sram: new Uint8Array([1, 2, 3, 255]).buffer,
  sramHash: "b".repeat(64),
  updatedAt: 1000,
  playTime: 5000,
  cloud: { revision: 3, sramHash: "c".repeat(64) },
  ...over,
});

afterEach(async () => {
  await deleteLocalSave("a".repeat(64));
  await deleteLocalSave("d".repeat(64));
  await forgetRoms();
});

describe("IndexedDB saves", () => {
  it("round-trips SRAM bytes and metadata", async () => {
    await putLocalSave(save());
    await closeDb(); // Force a fresh connection, like a page reload.
    const loaded = await getLocalSave("a".repeat(64));
    expect(loaded).toMatchObject({ gameId: "POKEMON RED", updatedAt: 1000, playTime: 5000, cloud: { revision: 3 } });
    expect(Array.from(new Uint8Array(loaded!.sram))).toEqual([1, 2, 3, 255]);
  });

  it("returns null for unknown ROMs and overwrites existing entries", async () => {
    expect(await getLocalSave("f".repeat(64))).toBeNull();
    await putLocalSave(save());
    await putLocalSave(save({ updatedAt: 2000 }));
    expect((await getLocalSave("a".repeat(64)))!.updatedAt).toBe(2000);
  });

  it("clears cloud sync state for every save when identity changes", async () => {
    await putLocalSave(save());
    await putLocalSave(save({ romHash: "d".repeat(64) }));
    await clearCloudSyncState();
    expect((await getLocalSave("a".repeat(64)))!.cloud).toBeNull();
    expect((await getLocalSave("d".repeat(64)))!.cloud).toBeNull();
    expect((await getLocalSave("a".repeat(64)))!.sramHash).toBe("b".repeat(64));
  });

  it("keeps a library of ROMs, newest played first", async () => {
    const rom = (over: Partial<StoredRom>): StoredRom => ({
      romHash: "1",
      fileName: "a.gb",
      title: "Game A",
      data: new ArrayBuffer(4),
      addedAt: 1,
      lastPlayedAt: 1,
      ...over,
    });
    await putRom(rom({}));
    await putRom(rom({ romHash: "2", fileName: "b.gb", title: "Game B", data: new ArrayBuffer(8), lastPlayedAt: 5 }));
    await putRom(rom({ romHash: "3", fileName: "c.gb", title: "Game C", lastPlayedAt: 3 }));

    const list = await listRoms();
    expect(list.map((r) => r.title)).toEqual(["Game B", "Game C", "Game A"]);
    expect(list[0]).toMatchObject({ size: 8, fileName: "b.gb" });
    expect(list[0]).not.toHaveProperty("data");

    expect((await getRom("1"))!.data.byteLength).toBe(4);
    await touchRom("1");
    expect((await listRoms())[0]!.title).toBe("Game A");

    await deleteRom("1");
    expect(await getRom("1")).toBeNull();
    expect(await listRoms()).toHaveLength(2);
  });

  it("keeps each ROM's SHA-1", async () => {
    const base: StoredRom = { romHash: "1", fileName: "a.gb", title: "A", data: new ArrayBuffer(4), addedAt: 1, lastPlayedAt: 1 };
    await putRom(base);
    expect((await getRom("1"))!.sha1).toBe("9069ca78e7450a285173431b3e52c5c25299e473");
    expect((await listRoms())[0]!.sha1).toBe("9069ca78e7450a285173431b3e52c5c25299e473");
  });

  it("carries a version 1 library and saves over the upgrade, and works out SHA-1s it didn't keep", async () => {
    await closeDb();
    await deleteDb();
    const old = await openRaw(1, (db) => {
      db.createObjectStore("saves", { keyPath: "romHash" });
      db.createObjectStore("roms", { keyPath: "romHash" });
    });
    const withHash: StoredRom = { romHash: "1", fileName: "a.gb", title: "A", sha1: "known", data: new ArrayBuffer(4), addedAt: 1, lastPlayedAt: 2 };
    const withoutHash: StoredRom = { romHash: "2", fileName: "b.gb", title: "B", customName: "Bee", data: new ArrayBuffer(8), addedAt: 1, lastPlayedAt: 1 };
    await write(old, "roms", [withHash, withoutHash]);
    await write(old, "saves", [save()]);
    old.close();

    expect(await listRoms()).toEqual([
      { romHash: "1", fileName: "a.gb", title: "A", sha1: "known", addedAt: 1, lastPlayedAt: 2, size: 4 },
      { romHash: "2", fileName: "b.gb", title: "B", customName: "Bee", addedAt: 1, lastPlayedAt: 1, size: 8 },
    ]);
    expect(await legacyNames()).toEqual({ "2": "Bee" });
    expect(Array.from(new Uint8Array((await getLocalSave("a".repeat(64)))!.sram))).toEqual([1, 2, 3, 255]);
    expect((await getRom("1"))!.data.byteLength).toBe(4);

    // The missing SHA-1 is worked out from the bytes, once, and then listed.
    expect(await addMissingSha1()).toBe(1);
    expect(await addMissingSha1()).toBe(0);
    expect((await listRoms()).find((r) => r.romHash === "2")!.sha1).toBe("05fe405753166f125559e7c9ac558654f107c7e9");
    expect((await getRom("2"))!.sha1).toBe("05fe405753166f125559e7c9ac558654f107c7e9");
  });

  it("lets another tab upgrade the database, and reopens on next use", async () => {
    await putRom({ romHash: "1", fileName: "a.gb", title: "A", data: new ArrayBuffer(4), addedAt: 1, lastPlayedAt: 1 });
    // A newer version opening elsewhere: this tab's connection must close rather than block it.
    const newer = await openRaw(3);
    newer.close();
    await deleteDb();
    expect(await listRoms()).toEqual([]);
  });

  it("fails clearly instead of hanging when an old tab holds the database open", async () => {
    await closeDb();
    await deleteDb();
    // Older code: an open connection that ignores versionchange.
    const old = await openRaw(1, (db) => {
      db.createObjectStore("saves", { keyPath: "romHash" });
      db.createObjectStore("roms", { keyPath: "romHash" });
    });
    await expect(listRoms()).rejects.toBeInstanceOf(DbBlockedError);
    old.close();
    expect(await listRoms()).toEqual([]);
  });

  it("re-adding a ROM replaces the entry instead of duplicating it", async () => {
    const base: StoredRom = { romHash: "1", fileName: "a.gb", title: "A", data: new ArrayBuffer(4), addedAt: 1, lastPlayedAt: 1 };
    await putRom(base);
    await putRom({ ...base, lastPlayedAt: 9 });
    const list = await listRoms();
    expect(list).toHaveLength(1);
    expect(list[0]!.lastPlayedAt).toBe(9);
  });

  it("lists names given before they moved to the shelf, and forgets them once moved", async () => {
    const base: StoredRom = { romHash: "1", fileName: "a.gbc", title: "PM_CRYSTAL", data: new ArrayBuffer(4), addedAt: 1, lastPlayedAt: 1 };
    await putRom({ ...base, customName: "Complete Crystal" });
    await putRom({ ...base, romHash: "2" });
    expect(await legacyNames()).toEqual({ "1": "Complete Crystal" });
    // The library shows the cartridge title; the shelf supplies names now.
    expect((await listRoms()).map((r) => r.title)).toEqual(["PM_CRYSTAL", "PM_CRYSTAL"]);

    await forgetLegacyNames(["1", "2"]);
    expect(await legacyNames()).toEqual({});
    expect(await getRom("1")).not.toHaveProperty("customName");
    expect((await getRom("1"))!.title).toBe("PM_CRYSTAL");
  });
});
