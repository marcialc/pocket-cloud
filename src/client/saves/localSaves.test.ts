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
  renameRom,
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

  it("re-adding a ROM replaces the entry instead of duplicating it", async () => {
    const base: StoredRom = { romHash: "1", fileName: "a.gb", title: "A", data: new ArrayBuffer(4), addedAt: 1, lastPlayedAt: 1 };
    await putRom(base);
    await putRom({ ...base, lastPlayedAt: 9 });
    const list = await listRoms();
    expect(list).toHaveLength(1);
    expect(list[0]!.lastPlayedAt).toBe(9);
  });

  it("renames a library entry and resets it with a blank name", async () => {
    const base: StoredRom = { romHash: "1", fileName: "a.gbc", title: "PM_CRYSTAL", data: new ArrayBuffer(4), addedAt: 1, lastPlayedAt: 1 };
    await putRom(base);
    await renameRom("1", "  Complete Crystal  ");
    expect((await listRoms())[0]!.title).toBe("Complete Crystal");
    expect((await getRom("1"))!.title).toBe("PM_CRYSTAL");

    await renameRom("1", "   ");
    expect((await listRoms())[0]!.title).toBe("PM_CRYSTAL");
    expect(await getRom("1")).not.toHaveProperty("customName");
  });
});
