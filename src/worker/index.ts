import {
  HASH_PATTERN,
  MAX_SRAM_BYTES,
  base64ToBytes,
  bytesToBase64,
  isKeyBindings,
  sha256Hex,
  type CloudSaveResponse,
  type ListSavesResponse,
  type PutSaveRequest,
  type PutSaveResponse,
  type PutSettingsRequest,
  type SettingsResponse,
} from "../shared/api";
import { handleAuth } from "./auth/routes";
import { clearSessionCookie } from "./auth/session";
import type { PlayerSaveDO } from "./durable-objects/PlayerSaveDO";
import { isCrossSite, json, methodNotAllowed } from "./http";
import { authenticate } from "./identity";
import { handleRoms } from "./roms";

export { AuthDO } from "./durable-objects/AuthDO";
export { PlayerSaveDO } from "./durable-objects/PlayerSaveDO";

/**
 * API surface (everything else is static assets, see wrangler.jsonc):
 *
 *   GET    /api/health
 *   GET    /api/saves              list save metadata for this player
 *   GET    /api/saves/:romHash     fetch one save (with SRAM)
 *   PUT    /api/saves/:romHash     upload SRAM (optimistic concurrency via baseRevision)
 *   DELETE /api/saves/:romHash     delete one save
 *   /api/roms/*                    cloud ROM library (email sign-in only), see roms.ts
 *   GET    /api/settings           account-wide settings (email sign-in only)
 *   PUT    /api/settings           replace them
 *   /api/auth/*                    email sign-in, see auth/routes.ts
 *
 * Saves routes accept either an email session cookie or the anonymous player
 * key (`Authorization: Bearer <key>`); a key stops working once an account
 * has claimed its player.
 *
 * The saves routes only accept SRAM (battery save data). ROM bytes arrive
 * only on /api/roms, and only from a signed-in account.
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
  if (isCrossSite(request, url)) return json({ error: "forbidden" }, 403);
  if (path.startsWith("/api/auth/")) return handleAuth(request, env, path);
  const roms = path === "/api/roms" || path.startsWith("/api/roms/");
  const settings = path === "/api/settings";
  if (!roms && !settings && !path.startsWith("/api/saves")) return json({ error: "not_found" }, 404);

  const identity = await authenticate(request, env);
  if ("error" in identity) {
    const headers: HeadersInit = identity.error === "session_invalid" ? { "Set-Cookie": clearSessionCookie(request.url) } : {};
    return json({ error: identity.error }, 401, headers);
  }
  const stub = env.PLAYER_SAVE.getByName(`player:${identity.playerId}`);
  if (!(await stub.authorize(identity.access))) {
    return identity.access.kind === "key"
      ? json({ error: "key_retired" }, 401)
      : json({ error: "session_invalid" }, 401, { "Set-Cookie": clearSessionCookie(request.url) });
  }
  if (roms) {
    // ROMs are stored only for accounts, never for an anonymous key.
    if (identity.access.kind !== "session") return json({ error: "sign_in_required" }, 403);
    return handleRoms(request, env, url, identity.playerId);
  }
  if (settings) {
    // Settings follow the account; an anonymous key keeps them on its device.
    if (identity.access.kind !== "session") return json({ error: "sign_in_required" }, 403);
    return handleSettings(request, stub);
  }

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
        ...(body.rtcBase !== undefined ? { rtcBase: body.rtcBase } : {}),
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

const KEY_BINDINGS = "key_bindings";
const MAX_SETTINGS_BYTES = 4096;

async function handleSettings(request: Request, stub: DurableObjectStub<PlayerSaveDO>): Promise<Response> {
  switch (request.method) {
    case "GET": {
      const stored = await stub.getSetting(KEY_BINDINGS);
      return json({ keyBindings: stored ? JSON.parse(stored) : null } satisfies SettingsResponse);
    }
    case "PUT": {
      if (Number(request.headers.get("Content-Length") ?? 0) > MAX_SETTINGS_BYTES) return json({ error: "payload_too_large" }, 400);
      let body: PutSettingsRequest;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      if (typeof body !== "object" || body === null || !isKeyBindings(body.keyBindings)) {
        return json({ error: "invalid_key_bindings" }, 400);
      }
      await stub.putSetting(KEY_BINDINGS, JSON.stringify(body.keyBindings));
      return new Response(null, { status: 204 });
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
  if (body.rtcBase !== undefined && (!Number.isSafeInteger(body.rtcBase) || body.rtcBase <= 0)) {
    return { error: "invalid_rtc_base" };
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
