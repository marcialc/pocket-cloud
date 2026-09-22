import {
  base64ToBytes,
  bytesToBase64,
  type CloudSaveMeta,
  type CloudSaveResponse,
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

export async function deleteCloudSave(romHash: string): Promise<void> {
  const res = await call(`/saves/${romHash}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new CloudUnavailableError(`Unexpected status ${res.status}`);
}
