import { describe, expect, it } from "vitest";
import { readBcd, scoreWatcherFor } from "./scoreWatch";

function ram(score: [number, number, number], lastInputAt = 0) {
  return {
    readMemory: (address: number) => (address >= 0xc0a0 && address <= 0xc0a2 ? score[address - 0xc0a0]! : 0),
    lastInputAt,
  };
}

describe("readBcd", () => {
  it("reads little-endian packed BCD", () => {
    expect(readBcd([0x34, 0x12, 0x00])).toBe(1234);
    expect(readBcd([0x99, 0x99, 0x99])).toBe(999_999);
  });

  it("rejects bytes that aren't BCD", () => {
    expect(readBcd([0x0a, 0x00, 0x00])).toBeNull();
    expect(readBcd([0x00, 0xf0, 0x00])).toBeNull();
  });
});

describe("Tetris watcher", () => {
  it("only counts scores after a game has started from 0", () => {
    const w = scoreWatcherFor("TETRIS")!;
    w.sample(ram([0x00, 0x50, 0x00], 5), 10); // leftover RAM at boot
    expect(w.best()).toBe(0);
    w.sample(ram([0x00, 0x00, 0x00]), 20);
    w.sample(ram([0x40, 0x12, 0x00], 25), 30);
    w.sample(ram([0x00, 0x00, 0x00], 25), 40); // next game
    w.sample(ram([0x00, 0x01, 0x00], 45), 50);
    expect(w.best()).toBe(1240);
  });

  it("ignores the demo that plays itself on the title screen", () => {
    const w = scoreWatcherFor("TETRIS")!;
    w.sample(ram([0x00, 0x00, 0x00], 100), 200); // demo starts; the player last pressed a button before it
    w.sample(ram([0x00, 0x08, 0x00], 100), 300);
    expect(w.best()).toBe(0);
    w.sample(ram([0x00, 0x00, 0x00], 100), 400); // the player starts a game
    w.sample(ram([0x60, 0x00, 0x00], 450), 500);
    expect(w.best()).toBe(60);
  });

  it("is only there for games it knows", () => {
    expect(scoreWatcherFor("POKEMON RED")).toBeNull();
  });
});

describe("scoreWatcherFor", () => {
  it("only follows Game Boy games", () => {
    expect(scoreWatcherFor("TETRIS")).not.toBeNull();
    expect(scoreWatcherFor("nes:TETRIS")).toBeNull();
  });
});
