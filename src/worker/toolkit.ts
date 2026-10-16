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
