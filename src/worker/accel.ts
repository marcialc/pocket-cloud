import { MIN_ROM_BYTES, sha256Hex } from "../shared/api";

export type Job =
  | { type: "rom_hash_check"; key: string; romHash: string }
  | { type: "sweep_chunk"; cursor?: string };


const ALPHA = 0.25;
const WARMUP_SAMPLES = 5;

const BUDGETS = {
  rom_put: 250,
} as const;

export type LoadKind = keyof typeof BUDGETS;

type Gauge = { ema: number; samples: number };
const gauges = new Map<LoadKind, Gauge>();

export async function measured<T>(kind: LoadKind, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    const ms = Date.now() - start;
    const g = gauges.get(kind) ?? { ema: BUDGETS[kind], samples: 0 };
    g.ema = ALPHA * ms + (1 - ALPHA) * g.ema;
    g.samples++;
    gauges.set(kind, g);
  }
}

export function shouldOffload(kind: LoadKind): boolean {
  const g = gauges.get(kind);
  return !!g && g.samples >= WARMUP_SAMPLES && g.ema > BUDGETS[kind];
}

export function shedding(kind: LoadKind): boolean {
  const g = gauges.get(kind);
  return !!g && g.samples >= WARMUP_SAMPLES && g.ema > BUDGETS[kind] * 2.5;
}


type QueueLike = { send(messages: { body: unknown; contentType?: string }[]): Promise<void> };

function backlog(env: Env): QueueLike | undefined {
  return (env as unknown as Record<string, QueueLike | undefined>)["BACKLOG"];
}

export function hasBacklog(env: Env): boolean {
  return !!backlog(env);
}

export async function enqueue(env: Env, job: Job): Promise<boolean> {
  const queue = backlog(env);
  if (!queue) return false;
  await queue.send([{ body: job }]);
  return true;
}

export function shedResponse(kind: LoadKind): Response {
  return new Response(JSON.stringify({ error: "overloaded", kind }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": "15" },
  });
}


export async function handleQueue(batch: MessageBatch<Job>, env: Env): Promise<void> {
  if (batch.queue.includes("dlq")) {
    for (const message of batch.messages) {
      
      console.error(
        JSON.stringify({
          message: "dlq_quarantine",
          queue: batch.queue,
          job: message.body,
          attempts: message.attempts,
        }),
      );
      message.ack();
    }
    return;
  }

  for (const message of batch.messages) {
    const lagMs = Date.now() - (message.timestamp ?? Date.now());
    try {
      switch (message.body?.type) {
        case "rom_hash_check":
          await checkRomHash(env, message.body);
          break;
        case "sweep_chunk":
          await sweepChunk(env, message.body);
          break;
        default:
          
          console.error(JSON.stringify({ message: "job_unknown", job: message.body }));
          message.ack();
          continue;
      }
      message.ack();
      if (lagMs > 60_000) {
        console.error(JSON.stringify({ message: "queue_lag_high", lagMs, job: message.body.type }));
      }
    } catch (err) {
      console.error(JSON.stringify({ message: "job_failed", job: message.body, error: String(err) }));
      message.retry();
    }
  }
}


async function checkRomHash(env: Env, job: { key: string; romHash: string }): Promise<void> {
  const object = await env.ROMS.get(job.key);
  if (!object) return;
  const digest = await sha256Hex(await object.arrayBuffer());
  if (digest !== job.romHash) {
    await env.ROMS.delete(job.key);
    console.error(JSON.stringify({ message: "rom_hash_mismatch_deleted", key: job.key }));
  }
}

const ROM_KEY = /^roms\/([^/]+)\/([0-9a-f]{64})$/;
const REMOVED_KEY = /^removed\/([^/]+)\/([0-9a-f]{64})$/;
const LIST_PAGE = 1000;

type PlayerStats = { roms: number; removed: number };

async function sweepChunk(env: Env, job: { cursor?: string }): Promise<void> {
  const apply = (env as { MAINTENANCE_APPLY?: string }).MAINTENANCE_APPLY === "1";
  const page = await env.ROMS.list({ limit: LIST_PAGE, ...(job.cursor ? { cursor: job.cursor } : {}) });

  const players = new Map<string, PlayerStats>();
  const suspectKeys: string[] = [];
  let roms = 0;
  let removed = 0;
  let foreign = 0;

  for (const object of page.objects) {
    const romMatch = ROM_KEY.exec(object.key);
    if (romMatch) {
      roms++;
      let stats = players.get(romMatch[1]!);
      if (!stats) players.set(romMatch[1]!, (stats = { roms: 0, removed: 0 }));
      stats.roms++;
      if (object.size < MIN_ROM_BYTES) suspectKeys.push(object.key);
      continue;
    }
    const removedMatch = REMOVED_KEY.exec(object.key);
    if (removedMatch) {
      removed++;
      let stats = players.get(removedMatch[1]!);
      if (!stats) players.set(removedMatch[1]!, (stats = { roms: 0, removed: 0 }));
      stats.removed++;
      continue;
    }
    foreign++;
  }

  let deleted = 0;
  if (apply && suspectKeys.length > 0) {
    await env.ROMS.delete(suspectKeys);
    deleted = suspectKeys.length;
  }

  console.log(
    JSON.stringify({
      message: "sweep_chunk",
      cursor: job.cursor ?? null,
      roms,
      removed,
      foreign,
      suspects: suspectKeys.length,
      applied: apply,
      deleted,
      players: [...players.entries()].map(([playerId, s]) => ({ playerId, ...s })),
    }),
  );

  if (page.truncated) {
    const queued = await enqueue(env, { type: "sweep_chunk", cursor: page.cursor });
    if (!queued) {
      console.error(JSON.stringify({ message: "sweep_continuation_lost", cursor: page.cursor }));
    }
  }
}
