import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudRomMeta, ListRomsResponse } from "../../shared/api";
import { CloudRomError, uploadCloudRom } from "./cloudApi";
import { forgetRoms, putRom, type RomSummary } from "./localSaves";
import { backUpLibrary, backUpRom, forgetBackUp, mergeLibrary, missingFromAccount, resetBackUpState } from "./romLibrary";

vi.mock("./cloudApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cloudApi")>()),
  uploadCloudRom: vi.fn(),
}));
const upload = vi.mocked(uploadCloudRom);

const local = (romHash: string, lastPlayedAt: number): RomSummary => ({
  romHash,
  fileName: `${romHash}.gb`,
  title: romHash.toUpperCase(),
  size: 32768,
  addedAt: lastPlayedAt,
  lastPlayedAt,
});

const cloud = (romHash: string, uploadedAt: number): CloudRomMeta => ({
  romHash,
  fileName: `${romHash}.gb`,
  title: "",
  size: 32768,
  uploadedAt,
});

describe("mergeLibrary", () => {
  it("lists local games only when signed out", () => {
    expect(mergeLibrary([local("a", 1)], null)).toEqual([expect.objectContaining({ romHash: "a", onDevice: true, inCloud: false })]);
  });

  it("marks games in both places and adds account-only games", () => {
    const merged = mergeLibrary([local("a", 10)], [cloud("a", 5), cloud("b", 20)]);
    expect(merged.map((e) => [e.romHash, e.onDevice, e.inCloud])).toEqual([
      ["b", false, true],
      ["a", true, true],
    ]);
    // No header title stored: fall back to the file name.
    expect(merged[0]!.title).toBe("b.gb");
  });
});

const stored = (romHash: string) =>
  putRom({ romHash, fileName: `${romHash}.gb`, title: "T", data: new Uint8Array(4).buffer, addedAt: 1, lastPlayedAt: 1 });

const account = (roms: string[], removed: string[] = []): ListRomsResponse => ({
  roms: roms.map((h) => cloud(h, 1)),
  removed,
});

describe("backing up to the account", () => {
  beforeEach(() => {
    resetBackUpState();
    upload.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => forgetRoms());

  it("uploads only games the account doesn't have and the player didn't remove", async () => {
    await Promise.all(["a", "b", "c"].map(stored));
    const n = await backUpLibrary(account(["a"], ["b"]), new AbortController().signal);
    expect(n).toBe(1);
    expect(upload.mock.calls.map(([rom]) => rom.romHash)).toEqual(["c"]);
  });

  it("stops at library_full", async () => {
    await Promise.all(["a", "b"].map(stored));
    upload.mockRejectedValue(new CloudRomError("library_full"));
    expect(await backUpLibrary(account([]), new AbortController().signal)).toBe(0);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("stops when aborted", async () => {
    await Promise.all(["a", "b"].map(stored));
    const stop = new AbortController();
    upload.mockImplementation(async () => stop.abort());
    expect(await backUpLibrary(account([]), stop.signal)).toBe(1);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("shares one request between concurrent uploads of the same game", async () => {
    const rom = { romHash: "a", fileName: "a.gb", title: "A", data: new ArrayBuffer(4) };
    await Promise.all([backUpRom(rom), backUpRom(rom)]);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("doesn't upload again from an out-of-date list after an upload finished", async () => {
    await stored("a");
    await backUpRom({ romHash: "a", fileName: "a.gb", title: "A", data: new ArrayBuffer(4) });
    const staleList = account([]);
    expect(missingFromAccount([local("a", 1)], staleList)).toEqual([]);
    expect(await backUpLibrary(staleList, new AbortController().signal)).toBe(0);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  const rom = { romHash: "a", fileName: "a.gb", title: "A", data: new ArrayBuffer(4) };

  it("uploads a picked game again after it was removed from the account", async () => {
    await backUpRom(rom);
    forgetBackUp("a");
    await backUpRom(rom, true);
    expect(upload.mock.calls.map(([, picked]) => picked)).toEqual([false, true]);
  });

  it("uploads a picked game even if this page uploaded it before (removed on another device)", async () => {
    await backUpRom(rom);
    await backUpRom(rom, true);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("forgets the previous account's uploads on account change", async () => {
    await backUpRom(rom);
    resetBackUpState();
    await backUpRom(rom);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("doesn't record an upload that finished after the account changed", async () => {
    let finish!: () => void;
    upload.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    const first = backUpRom(rom);
    resetBackUpState();
    finish();
    await first;
    await backUpRom(rom);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("a pick reuses a background upload of the same game that worked", async () => {
    let finish!: () => void;
    upload.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    const background = backUpRom(rom);
    const picked = backUpRom(rom, true);
    finish();
    await Promise.all([background, picked]);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("a pick uploads after a background upload of the same game was refused", async () => {
    let refuse!: () => void;
    upload.mockImplementationOnce(() => new Promise<void>((_, reject) => (refuse = () => reject(new CloudRomError("removed")))));
    const background = backUpRom(rom).catch(() => {});
    const picked = backUpRom(rom, true);
    refuse();
    await Promise.all([background, picked]);
    expect(upload.mock.calls.map(([, p]) => p)).toEqual([false, true]);
  });
});
