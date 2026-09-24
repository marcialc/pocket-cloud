import { afterEach, describe, expect, it } from "vitest";
import {
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
  forgetLegacyNames,
  legacyNames,
  touchRom,
  type LocalGameSave,
  type StoredRom,
} from "./localSaves";

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

  it("keeps each ROM's SHA-1, and works it out for ROMs stored before it was kept", async () => {
    const base: StoredRom = { romHash: "1", fileName: "a.gb", title: "A", data: new ArrayBuffer(4), addedAt: 1, lastPlayedAt: 1 };
    await putRom(base);
    expect((await getRom("1"))!.sha1).toBe("9069ca78e7450a285173431b3e52c5c25299e473");

    // An entry from before: written straight to IndexedDB, without the hash.
    await closeDb();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("pocket-cloud");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("roms", "readwrite");
      tx.objectStore("roms").put({ ...base, romHash: "2", data: new ArrayBuffer(8) });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    const list = await listRoms();
    expect(list.find((r) => r.romHash === "2")!.sha1).toBe("05fe405753166f125559e7c9ac558654f107c7e9");
    expect((await getRom("2"))!.sha1).toBe("05fe405753166f125559e7c9ac558654f107c7e9");
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
