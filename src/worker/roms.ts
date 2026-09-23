import {
  HASH_PATTERN,
  MAX_CLOUD_ROMS,
  MAX_ROM_BYTES,
  MIN_ROM_BYTES,
  sha256Hex,
  type CloudRomMeta,
  type ListRomsResponse,
} from "../shared/api";
import { json, methodNotAllowed } from "./http";

/**
 * Cloud ROM library for signed-in players (R2, one object per ROM):
 *
 *   GET    /api/roms                 list this account's games (+ removed hashes)
 *   GET    /api/roms/:romHash        ROM bytes
 *   PUT    /api/roms/:romHash?name=&title=[&picked=1]   raw ROM bytes (application/octet-stream)
 *   DELETE /api/roms/:romHash
 *
 * Objects live under roms/<playerId>/ and are only reachable through an email
 * session for that player; the anonymous key can't use them.
 *
 * Removing a game leaves an empty marker at removed/<playerId>/<romHash>, so
 * another browser that still has the file can't quietly put it back: uploads
 * of a removed game are refused (409 removed) unless the player picked the file
 * themselves (`picked=1`), which clears the marker.
 */
export async function handleRoms(request: Request, env: Env, url: URL, playerId: string): Promise<Response> {
  const prefix = `roms/${playerId}/`;
  const removedPrefix = `removed/${playerId}/`;
  if (url.pathname === "/api/roms") {
    if (request.method !== "GET") return methodNotAllowed();
    const [roms, removed] = await Promise.all([listRoms(env, prefix), listKeys(env, removedPrefix)]);
    return json({ roms, removed } satisfies ListRomsResponse);
  }

  const romHash = /^\/api\/roms\/([^/]+)$/.exec(url.pathname)?.[1];
  if (!romHash || !HASH_PATTERN.test(romHash)) return json({ error: "invalid_rom_hash" }, 400);
  const key = prefix + romHash;

  switch (request.method) {
    case "GET": {
      const object = await env.ROMS.get(key);
      if (!object) return json({ error: "not_found" }, 404);
      return new Response(object.body, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(object.size),
          "Cache-Control": "private, no-store",
        },
      });
    }
    case "PUT":
      return putRom(request, env, url, prefix, removedPrefix, romHash);
    case "DELETE": {
      if (!(await env.ROMS.head(key))) return json({ error: "not_found" }, 404);
      await env.ROMS.put(removedPrefix + romHash, new Uint8Array(0));
      await env.ROMS.delete(key);
      return new Response(null, { status: 204 });
    }
    default:
      return methodNotAllowed();
  }
}

async function putRom(
  request: Request,
  env: Env,
  url: URL,
  prefix: string,
  removedPrefix: string,
  romHash: string,
): Promise<Response> {
  const fileName = url.searchParams.get("name") ?? "";
  const title = url.searchParams.get("title") ?? "";
  if (fileName.length === 0 || fileName.length > 255 || title.length > 64) return json({ error: "invalid_name" }, 400);

  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > MAX_ROM_BYTES) return json({ error: "payload_too_large" }, 413);

  // Already stored: the hash names the content, so there's nothing to replace.
  const existing = await env.ROMS.head(prefix + romHash);
  if (existing) return json({ rom: toMeta(prefix, existing) });

  const picked = url.searchParams.get("picked") === "1";
  if (!picked && (await env.ROMS.head(removedPrefix + romHash))) return json({ error: "removed" }, 409);

  if ((await countObjects(env, prefix, MAX_CLOUD_ROMS)) >= MAX_CLOUD_ROMS) return json({ error: "library_full" }, 403);

  const data = await readLimited(request.body, MAX_ROM_BYTES);
  if (!data) return json({ error: "payload_too_large" }, 413);
  if (data.byteLength < MIN_ROM_BYTES) return json({ error: "invalid_rom_size" }, 400);
  if ((await sha256Hex(data)) !== romHash) return json({ error: "rom_hash_mismatch" }, 400);

  const object = await env.ROMS.put(prefix + romHash, data, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { fileName, title },
  });
  // Parallel uploads can all pass the check above; whoever lands past the limit backs out.
  if ((await countObjects(env, prefix, MAX_CLOUD_ROMS + 1)) > MAX_CLOUD_ROMS) {
    await env.ROMS.delete(prefix + romHash);
    return json({ error: "library_full" }, 403);
  }
  if (picked) {
    await env.ROMS.delete(removedPrefix + romHash);
  } else if (await env.ROMS.head(removedPrefix + romHash)) {
    // Removed while this upload was on its way: removal wins.
    await env.ROMS.delete(prefix + romHash);
    return json({ error: "removed" }, 409);
  }
  return json({ rom: toMeta(prefix, object) });
}

/** Reads the body, giving up (null) as soon as it passes `max` bytes, with or without Content-Length. */
async function readLimited(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function countObjects(env: Env, prefix: string, limit: number): Promise<number> {
  return (await env.ROMS.list({ prefix, limit })).objects.length;
}

async function listKeys(env: Env, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.ROMS.list({ prefix, ...(cursor ? { cursor } : {}) });
    keys.push(...page.objects.map((o) => o.key.slice(prefix.length)));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

async function listRoms(env: Env, prefix: string): Promise<CloudRomMeta[]> {
  const roms: CloudRomMeta[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.ROMS.list({ prefix, include: ["customMetadata"], ...(cursor ? { cursor } : {}) });
    roms.push(...page.objects.map((o) => toMeta(prefix, o)));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return roms.sort((a, b) => b.uploadedAt - a.uploadedAt);
}

function toMeta(prefix: string, object: R2Object): CloudRomMeta {
  const romHash = object.key.slice(prefix.length);
  return {
    romHash,
    fileName: object.customMetadata?.fileName ?? `${romHash.slice(0, 8)}.gb`,
    title: object.customMetadata?.title ?? "",
    size: object.size,
    uploadedAt: object.uploaded.getTime(),
  };
}
