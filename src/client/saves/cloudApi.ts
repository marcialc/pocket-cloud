import {
  base64ToBytes,
  bytesToBase64,
  type CloudSaveMeta,
  type CloudSaveResponse,
  type ListRomsResponse,
  type ListSavesResponse,
  type PutSaveRequest,
  type PutSaveResponse,
} from "../../shared/api";
import { getPlayerKey } from "./identity";

export type CloudSave = CloudSaveMeta & { sram: Uint8Array };

export class CloudUnavailableError extends Error {}

const TIMEOUT_MS = 8000;

async function call(path: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<Response> {
  try {
    const res = await fetch(`/api${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${getPlayerKey()}`, "Content-Type": "application/json", ...init.headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 500) throw new CloudUnavailableError(`Cloud error ${res.status}`);
    return res;
  } catch (err) {
    if (err instanceof CloudUnavailableError) throw err;
    throw new CloudUnavailableError(err instanceof Error ? err.message : String(err));
  }
}

export async function fetchCloudSave(romHash: string, timeoutMs?: number): Promise<CloudSave | null> {
  const res = await call(`/saves/${romHash}`, {}, timeoutMs);
  if (res.status === 404) return null;
  if (!res.ok) throw new CloudUnavailableError(`Unexpected status ${res.status}`);
  const body: CloudSaveResponse = await res.json();
  return { ...body, sram: base64ToBytes(body.sram) };
}

export async function pushCloudSave(
  romHash: string,
  save: Omit<PutSaveRequest, "sram"> & { sram: Uint8Array },
  options: { keepalive?: boolean } = {},
): Promise<PutSaveResponse> {
  const res = await call(`/saves/${romHash}`, {
    method: "PUT",
    body: JSON.stringify({ ...save, sram: bytesToBase64(save.sram) } satisfies PutSaveRequest),
    ...(options.keepalive ? { keepalive: true } : {}),
  });
  if (res.status !== 200 && res.status !== 409) throw new CloudUnavailableError(`Unexpected status ${res.status}`);
  return res.json();
}

/** Metadata (no SRAM) for every cloud save this player has. */
export async function listCloudSaves(): Promise<CloudSaveMeta[]> {
  const res = await call("/saves");
  if (!res.ok) throw new CloudUnavailableError(`Unexpected status ${res.status}`);
  const body: ListSavesResponse = await res.json();
  return body.saves;
}

export async function deleteCloudSave(romHash: string): Promise<void> {
  const res = await call(`/saves/${romHash}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new CloudUnavailableError(`Unexpected status ${res.status}`);
}

/** The server refused a ROM request (e.g. "sign_in_required", "library_full"). */
export class CloudRomError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** A ROM can be up to 8 MiB; give slow connections time. */
const ROM_TIMEOUT_MS = 120_000;

async function romError(res: Response): Promise<CloudRomError> {
  const body: { error?: string } = await res.json().catch(() => ({}));
  return new CloudRomError(body.error ?? `http_${res.status}`);
}

/** Games in the signed-in account's cloud library, and the ones the player removed from it. */
export async function listCloudRoms(): Promise<ListRomsResponse> {
  const res = await call("/roms");
  if (!res.ok) throw await romError(res);
  return res.json();
}

export type RomUpload = { romHash: string; fileName: string; title: string; data: ArrayBuffer };

/**
 * `picked`: the player chose this file just now, so it goes back into the
 * account even if they removed it before. Otherwise a removed game is refused
 * (CloudRomError "removed").
 */
export async function uploadCloudRom(rom: RomUpload, picked = false): Promise<void> {
  const query = new URLSearchParams({ name: rom.fileName.slice(0, 255), title: rom.title.slice(0, 64) });
  if (picked) query.set("picked", "1");
  const res = await call(
    `/roms/${rom.romHash}?${query}`,
    { method: "PUT", body: rom.data, headers: { "Content-Type": "application/octet-stream" } },
    ROM_TIMEOUT_MS,
  );
  if (!res.ok) throw await romError(res);
}

/** The ROM bytes, or null if the account doesn't have that game. */
export async function downloadCloudRom(romHash: string): Promise<ArrayBuffer | null> {
  const res = await call(`/roms/${romHash}`, {}, ROM_TIMEOUT_MS);
  if (res.status === 404) return null;
  if (!res.ok) throw await romError(res);
  return res.arrayBuffer();
}

export async function deleteCloudRom(romHash: string): Promise<void> {
  const res = await call(`/roms/${romHash}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw await romError(res);
}
