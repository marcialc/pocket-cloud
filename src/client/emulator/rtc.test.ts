import { describe, expect, it } from "vitest";
import { hasRtc, rtcRegisters } from "./rtc";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("hasRtc", () => {
  it("is true only for MBC3 cartridges with a timer", () => {
    expect(hasRtc(0x10)).toBe(true); // Pokémon Gold/Silver/Crystal
    expect(hasRtc(0x0f)).toBe(true);
    expect(hasRtc(0x13)).toBe(false); // MBC3+RAM+BATTERY (Pokémon Red)
    expect(hasRtc(0x1b)).toBe(false);
  });
});

describe("rtcRegisters", () => {
  const base = 1_700_000_000_000;

  it("reads zero when the battery just went in", () => {
    expect(rtcRegisters(base, base)).toEqual({ sec: 0, min: 0, hour: 0, day: 0, carry: false });
  });

  it("counts the real time that passed since the base", () => {
    expect(rtcRegisters(base, base + 3 * DAY + 5 * HOUR + 26 * MIN + 15 * SEC + 999)).toEqual({
      sec: 15, min: 26, hour: 5, day: 3, carry: false,
    });
  });

  it("wraps the 9-bit day counter and sets the carry flag like the chip", () => {
    expect(rtcRegisters(base, base + 511 * DAY)).toMatchObject({ day: 511, carry: false });
    expect(rtcRegisters(base, base + 512 * DAY + HOUR)).toMatchObject({ day: 0, hour: 1, carry: true });
  });

  it("treats a base in the future as a freshly started clock", () => {
    expect(rtcRegisters(base, base - HOUR)).toEqual({ sec: 0, min: 0, hour: 0, day: 0, carry: false });
  });
});
