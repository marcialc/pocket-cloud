import {
  HASH_PATTERN,
  MAX_STATE_BYTES,
  MAX_STATE_LABEL,
  base64ToBytes,
  bytesToBase64,
  sha256Hex,
  type ListStatesResponse,
  type PutSaveStateRequest,
  type SaveStateMeta,
  type SaveStateResponse,
} from "../shared/api";
import type { PlayerSaveDO } from "./durable-objects/PlayerSaveDO";
import { json, methodNotAllowed, readLimited } from "./http";

/**
 * Small helpers shared by the saves and ROMs routes.
 */

/**
 * Per-player fairness cap backed by the Worker rate-limit bindings
 * (see `ratelimits` in wrangler.jsonc).
 *
 * The binding is deliberately optional: local dev, previews and the test
 * harness may not configure one, and a missing limiter must allow the write
 * rather than refuse every request.
 */
export async function allow(
  env: Env,
  binding: "SAVES_LIMITER" | "ROMS_LIMITER",
  key: string,
): Promise<boolean> {
  const limiter = (
    env as unknown as Record<string, { limit: (a: { key: string }) => Promise<{ success: boolean }> } | undefined>
  )[binding];
  if (!limiter) return true;
  const { success } = await limiter.limit({ key });
  return success;
}

/**
 * Save-state routes for one game:
 *
 *   GET    /api/saves/:romHash/states        list the stored slots
 *   GET    /api/saves/:romHash/states/:slot  one state (with its bytes)
 *   PUT    /api/saves/:romHash/states/:slot  store a state
 *   DELETE /api/saves/:romHash/states/:slot  drop a state
 *
 * The bytes are the emulator's own snapshot, opaque here; the hash the client
 * sends must match them, so a state can't be stored corrupted.
 */
export async function handleStates(
  request: Request,
  stub: DurableObjectStub<PlayerSaveDO>,
  romHash: string,
  path: string,
): Promise<Response> {
  const rest = path.slice(`/api/saves/${romHash}/states`.length);
  const slotMatch = /^\/([0-5])$/.exec(rest);

  if (rest === "" || rest === "/") {
    if (request.method !== "GET") return methodNotAllowed();
    const states: SaveStateMeta[] = await stub.listStates(romHash);
    return json({ states } satisfies ListStatesResponse);
  }

  if (!slotMatch) return json({ error: "invalid_slot" }, 400);
  const slot = Number(slotMatch[1]);

  switch (request.method) {
    case "GET": {
      const state = await stub.getState(romHash, slot);
      if (!state) return json({ error: "not_found" }, 404);
      const { state: bytes, ...meta } = state;
      return json({ ...meta, state: bytesToBase64(bytes) } satisfies SaveStateResponse);
    }
    case "PUT": {
      const declared = Number(request.headers.get("Content-Length") ?? 0);
      if (declared > MAX_STATE_BYTES * 2) return json({ error: "payload_too_large" }, 400);
      const bytes = await readLimited(request, MAX_STATE_BYTES * 2);
      if (!bytes) return json({ error: "payload_too_large" }, 400);
      let body: PutSaveStateRequest;
      try {
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      if (typeof body.state !== "string" || typeof body.stateHash !== "string" || !HASH_PATTERN.test(body.stateHash)) {
        return json({ error: "invalid_state" }, 400);
      }
      if (body.label !== undefined && body.label !== null && (typeof body.label !== "string" || body.label.length > MAX_STATE_LABEL)) {
        return json({ error: "invalid_label" }, 400);
      }
      let state: Uint8Array;
      try {
        state = base64ToBytes(body.state);
      } catch {
        return json({ error: "invalid_state" }, 400);
      }
      if (state.length === 0 || state.length > MAX_STATE_BYTES) return json({ error: "invalid_state_size" }, 400);
      if ((await sha256Hex(state)) !== body.stateHash) return json({ error: "state_hash_mismatch" }, 400);
      const meta = await stub.putState({
        romHash,
        slot,
        ...(body.label ? { label: body.label } : {}),
        state,
        stateHash: body.stateHash,
      });
      return json(meta satisfies SaveStateMeta);
    }
    case "DELETE": {
      const deleted = await stub.deleteState(romHash, slot);
      return deleted ? new Response(null, { status: 204 }) : json({ error: "not_found" }, 404);
    }
    default:
      return methodNotAllowed();
  }
}

