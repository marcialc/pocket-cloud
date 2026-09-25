import { COVER_SYSTEMS, isCoverName, isCoverPlatform } from "../shared/covers";
import { json, methodNotAllowed } from "./http";

/**
 *   GET /api/covers/:platform/:name.png   box art from thumbnails.libretro.com
 *
 * No sign-in needed. The Worker fetches the image so the player's browser never
 * talks to libretro, and Cloudflare's cache keeps each image after the first ask.
 */
const THUMBNAILS = "https://thumbnails.libretro.com/";
const DAY = 24 * 60 * 60;

export async function handleCovers(request: Request, path: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed();
  const match = /^\/api\/covers\/([a-z]+)\/([^/]+)\.png$/.exec(path);
  if (!match) return json({ error: "not_found" }, 404);
  const [, platform, encoded] = match as unknown as [string, string, string];
  let name: string;
  try {
    name = decodeURIComponent(encoded);
  } catch {
    return json({ error: "invalid_cover_name" }, 400);
  }
  if (!isCoverPlatform(platform) || !isCoverName(name)) return json({ error: "invalid_cover_name" }, 400);

  const upstream = `${THUMBNAILS}${encodeURIComponent(COVER_SYSTEMS[platform])}/Named_Boxarts/${encodeURIComponent(name)}.png`;
  let res: Response;
  try {
    res = await fetch(upstream, { cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 30 * DAY, "404": DAY, "500-599": 0 } } });
  } catch {
    return json({ error: "cover_unavailable" }, 502);
  }
  if (res.status === 404) return json({ error: "not_found" }, 404, { "Cache-Control": `public, max-age=${DAY}` });
  if (!res.ok || res.headers.get("Content-Type") !== "image/png") return json({ error: "cover_unavailable" }, 502);
  return new Response(request.method === "HEAD" ? null : res.body, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": `public, max-age=${7 * DAY}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
