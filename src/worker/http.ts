export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export function methodNotAllowed(): Response {
  return json({ error: "method_not_allowed" }, 405);
}

/**
 * Rejects state-changing requests sent from another site. SameSite=Lax already
 * keeps the session cookie off them; this also covers the anonymous key and
 * any browser that ignores SameSite.
 */
export function isCrossSite(request: Request, url: URL): boolean {
  if (request.method === "GET" || request.method === "HEAD") return false;
  if (request.headers.get("Sec-Fetch-Site") === "cross-site") return true;
  const origin = request.headers.get("Origin");
  return origin !== null && origin !== url.origin;
}

/**
 * Reads the body, giving up (null) as soon as it passes `max` bytes, with or
 * without Content-Length. With one, the bytes go straight into a buffer of that
 * size, so a large body (a 32 MiB ROM) isn't held twice; without one, the
 * chunks are joined at the end.
 */
export async function readLimited(request: Request, max: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const declared = Number(request.headers.get("Content-Length") ?? Number.NaN);
  if (Number.isSafeInteger(declared) && declared >= 0 && declared <= max) {
    const out = new Uint8Array(declared);
    let offset = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return offset === declared ? out : out.subarray(0, offset);
      if (offset + value.byteLength > declared) {
        await reader.cancel();
        return null;
      }
      out.set(value, offset);
      offset += value.byteLength;
    }
  }
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
