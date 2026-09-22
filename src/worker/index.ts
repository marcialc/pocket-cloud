import {
  HASH_PATTERN,
  MAX_SRAM_BYTES,
  base64ToBytes,
  bytesToBase64,
  sha256Hex,
  type CloudSaveResponse,
  type ListSavesResponse,
  type PutSaveRequest,
  type PutSaveResponse,
} from "../shared/api";
import { resolvePlayer } from "./identity";

export { PlayerSaveDO } from "./durable-objects/PlayerSaveDO";

/**
 * API surface (everything else is static assets, see wrangler.jsonc):
 *
 *   GET    /api/health
 *   GET    /api/saves              list save metadata for this player
 *   GET    /api/saves/:romHash     fetch one save (with SRAM)
 *   PUT    /api/saves/:romHash     upload SRAM (optimistic concurrency via baseRevision)
 *   DELETE /api/saves/:romHash     delete one save
 *
 * Only SRAM (battery save data) is ever accepted. ROM data is never sent here.
 */
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    try {
      return await route(request, env, url);
    } catch (err) {
      console.error(JSON.stringify({ message: "unhandled error", path: url.pathname, error: String(err) }));
      return json({ error: "internal_error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  if (path === "/api/health") return json({ ok: true, time: Date.now() });
  if (!path.startsWith("/api/saves")) return json({ error: "not_found" }, 404);

  const player = await resolvePlayer(request);
  if (!player) return json({ error: "unauthorized" }, 401);
  const stub = env.PLAYER_SAVE.getByName(`player:${player.playerId}`);

  if (path === "/api/saves") {
    if (request.method !== "GET") return methodNotAllowed();
    return json({ saves: await stub.listSaves() } satisfies ListSavesResponse);
  }

  const match = /^\/api\/saves\/([^/]+)$/.exec(path);
  const romHash = match?.[1];
  if (!romHash || !HASH_PATTERN.test(romHash)) return json({ error: "invalid_rom_hash" }, 400);

  switch (request.method) {
    case "GET": {
      const save = await stub.getSave(romHash);
      if (!save) return json({ error: "not_found" }, 404);
      const { sram, ...meta } = save;
      return json({ ...meta, sram: bytesToBase64(sram) } satisfies CloudSaveResponse);
    }
    case "PUT": {
      const parsed = await parsePut(request);
      if ("error" in parsed) return json({ error: parsed.error }, 400);
      const { body, sram } = parsed;
      const result = await stub.putSave({
        romHash,
        gameId: body.gameId,
        sram,
        sramHash: body.sramHash,
        updatedAt: body.updatedAt,
        baseRevision: body.baseRevision,
        ...(body.playTime !== undefined ? { playTime: body.playTime } : {}),
        ...(body.force ? { force: true } : {}),
      });
      return json(result satisfies PutSaveResponse, result.ok ? 200 : 409);
    }
    case "DELETE": {
      const deleted = await stub.deleteSave(romHash);
      return deleted ? new Response(null, { status: 204 }) : json({ error: "not_found" }, 404);
    }
    default:
      return methodNotAllowed();
  }
}

async function parsePut(
  request: Request,
): Promise<{ body: PutSaveRequest; sram: Uint8Array } | { error: string }> {
  // base64 of the largest SRAM plus JSON overhead.
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > MAX_SRAM_BYTES * 2) return { error: "payload_too_large" };

  let body: PutSaveRequest;
  try {
    body = await request.json();
  } catch {
    return { error: "invalid_json" };
  }
  if (typeof body !== "object" || body === null) return { error: "invalid_body" };
  if (typeof body.gameId !== "string" || body.gameId.length === 0 || body.gameId.length > 64) {
    return { error: "invalid_game_id" };
  }
  if (typeof body.sram !== "string" || typeof body.sramHash !== "string" || !HASH_PATTERN.test(body.sramHash)) {
    return { error: "invalid_sram" };
  }
  if (!Number.isSafeInteger(body.updatedAt) || body.updatedAt <= 0) return { error: "invalid_updated_at" };
  if (body.baseRevision !== null && !Number.isSafeInteger(body.baseRevision)) return { error: "invalid_base_revision" };
  if (body.playTime !== undefined && (!Number.isSafeInteger(body.playTime) || body.playTime < 0)) {
    return { error: "invalid_play_time" };
  }

  let sram: Uint8Array;
  try {
    sram = base64ToBytes(body.sram);
  } catch {
    return { error: "invalid_sram" };
  }
  if (sram.length === 0 || sram.length > MAX_SRAM_BYTES) return { error: "invalid_sram_size" };
  if ((await sha256Hex(sram)) !== body.sramHash) return { error: "sram_hash_mismatch" };
  return { body, sram };
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function methodNotAllowed(): Response {
  return json({ error: "method_not_allowed" }, 405);
}
