/**
 * Wire types shared by the browser client and the Worker.
 *
 * SRAM travels as base64 inside JSON. A Game Boy cartridge has at most 128 KiB
 * of battery RAM (Pokémon Red uses 32 KiB), so the overhead is negligible.
 */

import { CONTROLS_IDS, PLATFORMS, type ControlsId } from "./platforms";
import type { Shelf } from "./shelf";

/** Largest battery RAM any supported cartridge type exposes (MBC5: 128 KiB). */
export const MAX_SRAM_BYTES = 128 * 1024;

/** SHA-256 hex digest. Used for both ROM fingerprints and SRAM content hashes. */
export const HASH_PATTERN = /^[0-9a-f]{64}$/;

export type CloudSaveMeta = {
  gameId: string;
  romHash: string;
  /** SHA-256 of the SRAM bytes, so clients can detect identical content. */
  sramHash: string;
  sramSize: number;
  /** Server-assigned, increments on every accepted write. Used for conflict detection. */
  revision: number;
  createdAt: number;
  /** Client wall-clock time at which this SRAM content was produced. */
  updatedAt: number;
  playTime?: number;
  /** Wall-clock time at which the cartridge's real-time clock read zero. */
  rtcBase?: number;
};

export type CloudSaveResponse = CloudSaveMeta & {
  /** base64-encoded SRAM. */
  sram: string;
};

export type PutSaveRequest = {
  gameId: string;
  sram: string;
  sramHash: string;
  updatedAt: number;
  playTime?: number;
  rtcBase?: number;
  /**
   * The cloud revision this write is based on (null = "I have never seen a
   * cloud save for this ROM"). If it does not match the server's current
   * revision the write is rejected with 409 unless `force` is set.
   */
  baseRevision: number | null;
  force?: boolean;
};

export type PutSaveResponse =
  | { ok: true; save: CloudSaveMeta }
  | { ok: false; conflict: CloudSaveMeta };

export type ListSavesResponse = { saves: CloudSaveMeta[] };

/** Largest ROM of a supported platform (GBA: 32 MiB). */
export const MAX_ROM_BYTES = 32 * 1024 * 1024;
/** Smallest file the cloud library takes; real ROMs are bigger (NES and Master System from 16 KiB). */
export const MIN_ROM_BYTES = 1024;

/** Games one account can keep in the cloud library. */
export const MAX_CLOUD_ROMS = 100;

/** A ROM in the signed-in player's cloud library (bytes fetched separately). */
export type CloudRomMeta = {
  romHash: string;
  fileName: string;
  /** Cartridge header title. */
  title: string;
  size: number;
  uploadedAt: number;
};

export type ListRomsResponse = {
  roms: CloudRomMeta[];
  /** Games the player removed from the account; background uploads of these are refused. */
  removed: string[];
};

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Account-wide settings for a signed-in player: the keyboard controls and how
 * the game library is organized. Each is null until the account has saved it.
 *
 * `keyBindings` are the Game Boy controls, as before other platforms existed,
 * so older clients keep reading and writing them; `platformKeyBindings` holds
 * the other platforms' controls by platform id ("gba", "snes", ...).
 */
export type SettingsResponse = {
  keyBindings: Record<string, string[]> | null;
  platformKeyBindings: Record<string, Record<string, string[]>> | null;
  shelf: Shelf | null;
};

/** Sends some of the settings; the ones left out are kept. */
export type PutSettingsRequest = {
  keyBindings?: Record<string, string[]>;
  platformKeyBindings?: Record<string, Record<string, string[]>>;
  shelf?: Shelf;
};

/**
 * Structural check for stored key bindings (button -> KeyboardEvent.code list).
 * The client still sanitizes what it loads, so this only keeps junk and bulk out.
 */
export function isKeyBindings(value: unknown): value is Record<string, string[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 16 &&
    entries.every(
      ([button, codes]) =>
        /^[a-z][a-z0-9]{0,15}$/.test(button) &&
        Array.isArray(codes) &&
        codes.length <= 8 &&
        codes.every((c) => typeof c === "string" && c.length > 0 && c.length <= 32),
    )
  );
}

/**
 * Check for the other platforms' key bindings: known platforms other than the
 * Game Boy (whose controls are `keyBindings`), each with only its own buttons.
 */
export function isPlatformKeyBindings(value: unknown): value is Record<string, Record<string, string[]>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([id, bindings]) =>
      id !== "gb" &&
      CONTROLS_IDS.some((c) => c === id) &&
      isKeyBindings(bindings) &&
      Object.keys(bindings).every((button) => PLATFORMS[id as ControlsId].buttons.some((b) => b === button)),
  );
}
