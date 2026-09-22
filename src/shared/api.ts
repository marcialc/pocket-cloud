/**
 * Wire types shared by the browser client and the Worker.
 *
 * SRAM travels as base64 inside JSON. A Game Boy cartridge has at most 128 KiB
 * of battery RAM (Pokémon Red uses 32 KiB), so the overhead is negligible.
 */

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
