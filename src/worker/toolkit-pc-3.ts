import {
  HASH_PATTERN,
  MAX_STATE_BYTES,
  MAX_STATE_LABEL,
  MIN_ROM_BYTES,
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

export async function allow(
  env: Env,
  binding: "SAVES_LIMITER" | "ROMS_LIMITER",
  key: string,
): Promise<boolean> {
  const limiter = (env as unknown as Record<string, { limit: (a: { key: string }) => Promise<{ success: boolean }> }>)[binding];
  if (!limiter) return true;
  const { success } = await limiter.limit({ key });
  return success;
}


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
      if (body.label !== undefined && (typeof body.label !== "string" || body.label.length > MAX_STATE_LABEL)) {
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

const ROM_KEY = /^roms\/([^/]+)\/([0-9a-f]{64})$/;
const REMOVED_KEY = /^removed\/([^/]+)\/([0-9a-f]{64})$/;

const LIST_PAGE = 1000;

type PlayerStats = { roms: number; romBytes: number; removed: number };

function playerStats(map: Map<string, PlayerStats>, playerId: string): PlayerStats {
  let stats = map.get(playerId);
  if (!stats) {
    stats = { roms: 0, romBytes: 0, removed: 0 };
    map.set(playerId, stats);
  }
  return stats;
}

export async function runMaintenance(env: Env): Promise<void> {
  
  const apply = (env as { MAINTENANCE_APPLY?: string }).MAINTENANCE_APPLY === "1";

  const players = new Map<string, PlayerStats>();
  const suspects: { key: string; size: number }[] = [];
  const foreign: { key: string; size: number }[] = [];
  let romObjects = 0;
  let removedMarkers = 0;
  let romBytesTotal = 0;

  
  let cursor: string | undefined;
  do {
    const page = await env.ROMS.list({ limit: LIST_PAGE, ...(cursor ? { cursor } : {}) });
    for (const object of page.objects) {
      const romMatch = ROM_KEY.exec(object.key);
      if (romMatch) {
        romObjects++;
        romBytesTotal += object.size;
        const stats = playerStats(players, romMatch[1]!);
        stats.roms++;
        stats.romBytes += object.size;
        
        if (object.size < MIN_ROM_BYTES) suspects.push({ key: object.key, size: object.size });
        continue;
      }
      const removedMatch = REMOVED_KEY.exec(object.key);
      if (removedMatch) {
        removedMarkers++;
        playerStats(players, removedMatch[1]!).removed++;
        continue;
      }
      
      foreign.push({ key: object.key, size: object.size });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  let deletedSuspects = 0;
  if (apply && suspects.length > 0) {
    for (let i = 0; i < suspects.length; i += LIST_PAGE) {
      await env.ROMS.delete(suspects.slice(i, i + LIST_PAGE).map((s) => s.key));
    }
    deletedSuspects = suspects.length;
  }
  
  console.log(
    JSON.stringify({
      message: "maintenance",
      apply,
      romObjects,
      romBytesTotal,
      removedMarkers,
      foreignKeys: foreign.length,
      ...(foreign.length > 0 ? { foreignSample: foreign.slice(0, 10) } : {}),
      players: [...players.entries()].map(([playerId, stats]) => ({ playerId, ...stats })),
      suspectObjects: suspects,
      deletedSuspects,
    }),
  );
}
