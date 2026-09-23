/**
 * The MBC3 real-time clock (Pokémon Gold/Silver/Crystal). On a real cartridge
 * a watch battery keeps the clock chip counting whether or not the Game Boy is
 * on; the game only stores an offset from the chip's count in battery RAM.
 *
 * We model the battery with one number per save, `rtcBase`: the wall-clock
 * time at which the chip read day 0, 00:00:00. The chip's count at any moment
 * is simply how much real time has passed since then.
 */

/** Cartridge types (header byte 0x147) with a clock chip: MBC3+TIMER+BATTERY, MBC3+TIMER+RAM+BATTERY. */
const RTC_CART_TYPES = new Set([0x0f, 0x10]);

export function hasRtc(cartridgeType: number): boolean {
  return RTC_CART_TYPES.has(cartridgeType);
}

export type RtcRegisters = {
  sec: number;
  min: number;
  hour: number;
  /** 9-bit day counter (0-511). */
  day: number;
  /** Set once the day counter has overflowed past 511, like the real chip. */
  carry: boolean;
};

/** What the clock chip reads at `nowMs` if its battery went in at `baseMs`. */
export function rtcRegisters(baseMs: number, nowMs: number): RtcRegisters {
  // A clock set in the future (device clock moved back) reads as freshly started.
  const totalSec = Math.floor(Math.max(0, nowMs - baseMs) / 1000);
  const days = Math.floor(totalSec / 86_400);
  return {
    sec: totalSec % 60,
    min: Math.floor(totalSec / 60) % 60,
    hour: Math.floor(totalSec / 3600) % 24,
    day: days % 512,
    carry: days >= 512,
  };
}
