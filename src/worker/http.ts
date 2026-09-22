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
