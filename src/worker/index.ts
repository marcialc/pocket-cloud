import {
  HASH_PATTERN,
  MAX_SCREENSHOT_BYTES,
  MAX_SRAM_BYTES,
  base64ToBytes,
  bytesToBase64,
  isKeyBindings,
  isPlatformKeyBindings,
  isPng,
  sha256Hex,
  type CloudSaveResponse,
  type ListSavesResponse,
  type PutSaveRequest,
  type PutSaveResponse,
  type PutSettingsRequest,
  type RestoreSaveResponse,
  type SaveHistoryResponse,
  type SaveVersion,
  type SettingsResponse,
} from "../shared/api";
import { isShelf } from "../shared/shelf";
import { verifyAccess } from "./access";
import { handleAdmin } from "./admin";
import { handleAuth } from "./auth/routes";
import { handleCovers } from "./covers";
import { clearSessionCookie } from "./auth/session";
import type { PlayerSaveDO, StoredVersion } from "./durable-objects/PlayerSaveDO";
import { isCrossSite, json, methodNotAllowed, readLimited } from "./http";
import { authenticate } from "./identity";
import { handleLink } from "./link";
import { handleRoms } from "./roms";
import { handleInvitePreview, handleSocial, recordSaveScores } from "./social";
import { track, trackSeen } from "./stats";

export { AuthDO } from "./durable-objects/AuthDO";
export { PlayerSaveDO } from "./durable-objects/PlayerSaveDO";
export { SocialDO } from "./durable-objects/SocialDO";
export { StatsDO } from "./durable-objects/StatsDO";

/**
 * API surface (everything else is static assets, see wrangler.jsonc):
 *
 *   GET    /api/health
 *   GET    /api/saves              list save metadata for this player
 *   GET    /api/saves/:romHash     fetch one save (with SRAM)
 *   PUT    /api/saves/:romHash     upload SRAM (optimistic concurrency via baseRevision)
 *   DELETE /api/saves/:romHash     delete one save (and its earlier versions)
 *   GET    /api/saves/:romHash/history                    current save and earlier versions (with pictures)
 *   GET    /api/saves/:romHash/history/:revision          fetch one earlier version (with SRAM)
 *   POST   /api/saves/:romHash/history/:revision/restore  make an earlier version the current save
 *   /api/roms/*                    cloud ROM library and cover images (email sign-in only), see roms.ts
 *   GET    /api/settings           account-wide settings (email sign-in only)
 *   PUT    /api/settings           replace the ones sent (controls, library shelf)
 *   /api/social/*                  friends and leaderboards (email sign-in only), see social.ts
 *   /api/link, /api/link/*         GBA link play with a friend (email sign-in only), see link.ts
 *   /api/admin/*                   usage dashboard (Cloudflare Access only), see admin.ts
 *   /api/auth/*                    email sign-in, see auth/routes.ts
 *   GET    /api/covers/*           game box art (no sign-in), see covers.ts
 *
 * Saves routes accept either an email session cookie or the anonymous player
 * key (`Authorization: Bearer <key>`); a key stops working once an account
 * has claimed its player.
 *
 * The saves routes only accept SRAM (battery save data). ROM bytes arrive
 * only on /api/roms, and only from a signed-in account.
 */
export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    try {
      return withRobotsTag(url, await route(request, env, url, ctx));
    } catch (err) {
      console.error(JSON.stringify({ message: "unhandled error", path: url.pathname, error: String(err) }));
      return withRobotsTag(url, json({ error: "internal_error" }, 500));
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * Keep API responses, and anything served from the *.workers.dev host (preview
 * and default URLs), out of search indexes. Static assets on workers.dev get the
 * same header from public/_headers.
 */
function withRobotsTag(url: URL, response: Response): Response {
  if (!url.pathname.startsWith("/api/") && !url.hostname.endsWith(".workers.dev")) return response;
  const out = new Response(response.body, response);
  out.headers.set("X-Robots-Tag", "noindex");
  return out;
}

async function route(request: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const path = url.pathname;
  if (path === "/api/health") return json({ ok: true, time: Date.now() });
  if (path.startsWith("/api/covers/")) return handleCovers(request, path);
  if (isCrossSite(request, url)) return json({ error: "forbidden" }, 403);
  if (path.startsWith("/api/auth/")) return handleAuth(request, env, path, ctx);
  const roms = path === "/api/roms" || path.startsWith("/api/roms/");
  const settings = path === "/api/settings";
  const social = path.startsWith("/api/social/");
  const link = path === "/api/link" || path.startsWith("/api/link/");
  const admin = path.startsWith("/api/admin/");
  if (social) {
    const preview = await handleInvitePreview(request, env, path);
    if (preview) return preview;
  }
  if (!roms && !settings && !social && !link && !admin && !path.startsWith("/api/saves")) return json({ error: "not_found" }, 404);
  if (admin) {
    // Admins are whoever the Access policy lets through; no Pocket Cloud sign-in needed.
    const access = await verifyAccess(request, env);
    if (!access.ok) return json({ error: access.error }, access.error === "access_not_configured" ? 503 : 403);
    return handleAdmin(request, env, url);
  }

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
  trackSeen(ctx, env, identity.playerId, identity.access.kind === "session" ? "account" : "anonymous");
  if (roms) {
    // ROMs are stored only for accounts, never for an anonymous key.
    if (identity.access.kind !== "session") return json({ error: "sign_in_required" }, 403);
    return handleRoms(request, env, url, identity.playerId, ctx);
  }
  if (settings) {
    // Settings follow the account; an anonymous key keeps them on its device.
    if (identity.access.kind !== "session") return json({ error: "sign_in_required" }, 403);
    return handleSettings(request, stub);
  }
  if (social) {
    // Friends know each other by account; an anonymous key has no profile.
    if (identity.access.kind !== "session") return json({ error: "sign_in_required" }, 403);
    return handleSocial(request, env, url, identity.playerId);
  }
  if (link) {
    // Linking is between friends, who know each other by account.
    if (identity.access.kind !== "session") return json({ error: "sign_in_required" }, 403);
    return handleLink(request, env, url, identity.playerId, ctx);
  }

  if (path === "/api/saves") {
    if (request.method !== "GET") return methodNotAllowed();
    return json({ saves: await stub.listSaves() } satisfies ListSavesResponse);
  }

  const history = /^\/api\/saves\/([^/]+)\/history(?:\/(\d{1,15})(\/restore)?)?$/.exec(path);
  if (history) return handleHistory(request, stub, history[1]!, history[2], history[3] !== undefined);

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
      const { body, sram, screenshot } = parsed;
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
        ...(screenshot ? { screenshot } : {}),
      });
      if (result.ok) {
        const kind = identity.access.kind === "session" ? "account" : "anonymous";
        track(ctx, env, (stats) => stats.saveSynced(identity.playerId, kind, body.gameId));
      }
      // Leaderboards are best effort: the save answers without waiting on the shared SocialDO.
      if (result.ok && identity.access.kind === "session") {
        ctx.waitUntil(
          recordSaveScores(env, identity.playerId, {
            romHash,
            gameId: body.gameId,
            sram,
            ...(body.playTime !== undefined ? { playTime: body.playTime } : {}),
          }),
        );
      }
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

async function handleHistory(
  request: Request,
  stub: DurableObjectStub<PlayerSaveDO>,
  romHash: string,
  revisionParam: string | undefined,
  restore: boolean,
): Promise<Response> {
  if (!HASH_PATTERN.test(romHash)) return json({ error: "invalid_rom_hash" }, 400);
  if (revisionParam === undefined) {
    if (request.method !== "GET") return methodNotAllowed();
    const { current, versions } = await stub.listHistory(romHash);
    return json({ current: current && toWireVersion(current), versions: versions.map(toWireVersion) } satisfies SaveHistoryResponse);
  }
  const revision = Number(revisionParam);
  if (restore) {
    if (request.method !== "POST") return methodNotAllowed();
    const save = await stub.restoreSave(romHash, revision);
    return save ? json({ save } satisfies RestoreSaveResponse) : json({ error: "not_found" }, 404);
  }
  if (request.method !== "GET") return methodNotAllowed();
  const version = await stub.getHistorySave(romHash, revision);
  if (!version) return json({ error: "not_found" }, 404);
  const { sram, ...meta } = version;
  return json({ ...meta, sram: bytesToBase64(sram) } satisfies CloudSaveResponse);
}

function toWireVersion({ screenshot, ...meta }: StoredVersion): SaveVersion {
  return { ...meta, ...(screenshot ? { screenshot: bytesToBase64(screenshot) } : {}) };
}

const KEY_BINDINGS = "key_bindings";
const PLATFORM_KEY_BINDINGS = "platform_key_bindings";
const SHELF = "shelf";
const MAX_SETTINGS_BYTES = 64 * 1024;

async function handleSettings(request: Request, stub: DurableObjectStub<PlayerSaveDO>): Promise<Response> {
  switch (request.method) {
    case "GET": {
      const [keyBindings, platformKeyBindings, shelf] = await Promise.all([
        stub.getSetting(KEY_BINDINGS),
        stub.getSetting(PLATFORM_KEY_BINDINGS),
        stub.getSetting(SHELF),
      ]);
      return json({
        keyBindings: keyBindings ? JSON.parse(keyBindings) : null,
        platformKeyBindings: platformKeyBindings ? JSON.parse(platformKeyBindings) : null,
        shelf: shelf ? JSON.parse(shelf) : null,
      } satisfies SettingsResponse);
    }
    case "PUT": {
      if (Number(request.headers.get("Content-Length") ?? 0) > MAX_SETTINGS_BYTES) return json({ error: "payload_too_large" }, 400);
      // Also caps a body sent without Content-Length (chunked).
      const bytes = await readLimited(request, MAX_SETTINGS_BYTES);
      if (!bytes) return json({ error: "payload_too_large" }, 400);
      let body: PutSettingsRequest;
      try {
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      if (typeof body !== "object" || body === null || !("keyBindings" in body || "platformKeyBindings" in body || "shelf" in body)) {
        return json({ error: "invalid_settings" }, 400);
      }
      if ("keyBindings" in body && !isKeyBindings(body.keyBindings)) return json({ error: "invalid_key_bindings" }, 400);
      if ("platformKeyBindings" in body && !isPlatformKeyBindings(body.platformKeyBindings)) {
        return json({ error: "invalid_key_bindings" }, 400);
      }
      if ("shelf" in body && !isShelf(body.shelf)) return json({ error: "invalid_shelf" }, 400);
      if (body.keyBindings) await stub.putSetting(KEY_BINDINGS, JSON.stringify(body.keyBindings));
      if (body.platformKeyBindings) await stub.putSetting(PLATFORM_KEY_BINDINGS, JSON.stringify(body.platformKeyBindings));
      if (body.shelf) await stub.putSetting(SHELF, JSON.stringify(body.shelf));
      return new Response(null, { status: 204 });
    }
    default:
      return methodNotAllowed();
  }
}

async function parsePut(
  request: Request,
): Promise<{ body: PutSaveRequest; sram: Uint8Array; screenshot?: Uint8Array } | { error: string }> {
  // base64 of the largest SRAM and screenshot plus JSON overhead.
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > (MAX_SRAM_BYTES + MAX_SCREENSHOT_BYTES) * 2) return { error: "payload_too_large" };

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
  return { body, sram, ...parseScreenshot(body.screenshot) };
}

/**
 * The save's picture. It's only for the gallery, so one that's missing, too big
 * or not a PNG is dropped and the save stored without it (refusing the save would
 * leave the client retrying it forever).
 */
function parseScreenshot(value: unknown): { screenshot?: Uint8Array } {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4) return {};
  try {
    const screenshot = base64ToBytes(value);
    return isPng(screenshot) ? { screenshot } : {};
  } catch {
    return {};
  }
}
