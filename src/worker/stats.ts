import type { PlayerKind } from "../shared/admin";
import type { StatsDO } from "./durable-objects/StatsDO";
import { utcDay } from "./durable-objects/StatsDO";

/**
 * Usage events for the admin page, sent to the StatsDO after the response
 * (ctx.waitUntil). Best effort: a failure is logged and never reaches the player.
 */
export function track(ctx: ExecutionContext, env: Env, event: (stats: DurableObjectStub<StatsDO>) => Promise<unknown>): void {
  ctx.waitUntil(
    event(statsStub(env)).catch((err) => console.error(JSON.stringify({ message: "could not record stats", error: String(err) }))),
  );
}

export function statsStub(env: Env) {
  return env.STATS.getByName("stats");
}

// Players this isolate already reported as active today, so most requests skip the StatsDO.
const seenToday = new Map<string, string>();
const MAX_SEEN = 10_000;

/** The player made an authorized request: active today. */
export function trackSeen(ctx: ExecutionContext, env: Env, playerId: string, kind: PlayerKind, now = Date.now()): void {
  const day = utcDay(now);
  if (seenToday.get(playerId) === `${day}:${kind}`) return;
  if (seenToday.size >= MAX_SEEN) seenToday.clear();
  seenToday.set(playerId, `${day}:${kind}`);
  track(ctx, env, (stats) => stats.seen(playerId, kind, now));
}
