import { DurableObject } from "cloudflare:workers";

/**
 * pocket-cloud-link: link sessions between two players' GBAs.
 *
 * Internal API, called by the pocket-cloud Worker over a service binding,
 * never from the internet. The caller has already checked sign-in and that
 * the two players are friends; it picks the room name (one per pair of
 * friends) and says who is asking with the X-Player-Id header.
 *
 *   GET  /rooms/:room          the room's state (see RoomStatus)
 *   POST /rooms/:room/plug     {romHash, sram?, state?} plug in the cable
 *                              with this game and save (base64), and where
 *                              the game is (a snapshot: mGBA's own, zlib,
 *                              base64); the link starts once both players
 *                              have
 *   GET  /rooms/:room/ws       WebSocket for the caller's screen (linked only);
 *                              protocol in link-server/src/linkd.c
 *   POST /rooms/:room/unplug   ends the link for both and answers the
 *                              caller's save ({ sram, state? }), or { ended }
 *                              when there was no link to take a save from
 *   GET  /rooms/:room/save     the caller's save from the last link, once:
 *                              { sram, state?, romHash } (the game it
 *                              belongs to; state as plugging in takes it)
 *
 * While linked, both games run in one container (linkd), which this Durable
 * Object starts, feeds with the two ROMs (each from its owner's library) and
 * saves (and snapshots, so each game carries on from where it was instead of
 * powering on), and stops again. Every way a link can go wrong (linkd failing,
 * the container dying, a start that never finished) ends in a state the
 * next plug or unplug clears, so a pair of friends is never stuck.
 *
 * A link nobody is watching ends by itself after IDLE_MS, keeping both saves
 * for their owners to pick up, and a player left waiting for a friend who
 * never plugs in is taken out after WAIT_MS (both vars in wrangler.jsonc,
 * checked every CHECK_EVERY_MS).
 */

const LINKD_PORT = 8080;
const PLAYER_ID = /^[0-9a-f]{64}$/;
const ROM_HASH = /^[0-9a-f]{64}$/;
const ROOM_NAME = /^[A-Za-z0-9:_-]{1,200}$/;
const MAX_SRAM_BYTES = 128 * 1024;
/** A snapshot as sent (compressed), and unpacked: mGBA's is about 400 KB plus the save. */
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_UNPACKED_STATE_BYTES = 2 * 1024 * 1024;

const START_TIMEOUT_MS = 60_000;

type RoomState = "empty" | "waiting" | "starting" | "linked" | "ending" | "failed";

type Seat = { playerId: string; romHash: string; slot: 1 | 2 };

/** A player's save from a link that ended, and where the game was (compressed), kept until they pick it up. */
type Result = { romHash: string; sram: Uint8Array; state?: Uint8Array };

type RoomStatus = {
  state: RoomState;
  players: { playerId: string; slot: 1 | 2 }[];
  /** Saves from the last link still to pick up, and the game each belongs to. */
  savesWaiting: { playerId: string; romHash: string }[];
  error?: string;
};

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/rooms\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
    const room = match?.[1];
    if (!room || !ROOM_NAME.test(room)) return json({ error: "not_found" }, 404);
    const playerId = request.headers.get("X-Player-Id") ?? "";
    if (!PLAYER_ID.test(playerId)) return json({ error: "player_required" }, 400);
    return env.LINK_ROOM.getByName(room).fetch(request);
  },
} satisfies ExportedHandler<Env>;

export class LinkRoom extends DurableObject<Env> {
  private readonly idleMs = Number(this.env.IDLE_MS);
  private readonly waitMs = Number(this.env.WAIT_MS);
  private readonly checkEveryMs = Number(this.env.CHECK_EVERY_MS);

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = /^\/rooms\/[^/]+(?:\/([a-z]+))?$/.exec(url.pathname)?.[1] ?? "";
    const playerId = request.headers.get("X-Player-Id")!;
    switch (`${request.method} ${action}`) {
      case "GET ":
        return json(await this.status());
      case "POST plug":
        return this.plug(playerId, request);
      case "GET ws":
        return this.openScreen(playerId, request);
      case "POST unplug":
        return this.unplug(playerId);
      case "GET save":
        return this.takeSave(playerId);
      default:
        return json({ error: "not_found" }, 404);
    }
  }

  /** The room's state, after noticing a link that died or a start that hung. */
  private async status(): Promise<RoomStatus> {
    let state = await this.state();
    if (state === "linked" && !this.ctx.container?.running) {
      await this.fail("link_lost");
      state = "failed";
    } else if (state === "starting" || state === "ending") {
      const since = (await this.ctx.storage.get<number>("since")) ?? 0;
      if (Date.now() - since > START_TIMEOUT_MS) {
        await this.fail(state === "starting" ? "start_timeout" : "end_timeout");
        state = "failed";
      }
    }
    const seats = await this.seats();
    const error = await this.ctx.storage.get<string>("error");
    const results = await this.ctx.storage.list<Result>({ prefix: "result:" });
    return {
      state,
      players: seats.map(({ playerId, slot }) => ({ playerId, slot })),
      savesWaiting: [...results].map(([key, { romHash }]) => ({ playerId: key.slice("result:".length), romHash })),
      ...(error ? { error } : {}),
    };
  }

  private async plug(playerId: string, request: Request): Promise<Response> {
    let body: { romHash?: unknown; sram?: unknown; state?: unknown };
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    if (typeof body.romHash !== "string" || !ROM_HASH.test(body.romHash)) return json({ error: "invalid_rom_hash" }, 400);
    let sram: Uint8Array = new Uint8Array(0);
    if (body.sram !== undefined) {
      if (typeof body.sram !== "string") return json({ error: "invalid_sram" }, 400);
      try {
        sram = base64ToBytes(body.sram);
      } catch {
        return json({ error: "invalid_sram" }, 400);
      }
      if (sram.length > MAX_SRAM_BYTES) return json({ error: "invalid_sram" }, 400);
    }
    // No snapshot (an older app, or it couldn't take one) powers the game on from its save.
    let snapshot: Uint8Array = new Uint8Array(0);
    if (body.state !== undefined) {
      if (typeof body.state !== "string") return json({ error: "invalid_state" }, 400);
      try {
        snapshot = base64ToBytes(body.state);
      } catch {
        return json({ error: "invalid_state" }, 400);
      }
      if (snapshot.length > MAX_STATE_BYTES) return json({ error: "invalid_state" }, 400);
    }
    // A save from the last link that this player hasn't picked up yet would
    // be lost if a new link started, so they collect it first.
    if (await this.ctx.storage.get(`result:${playerId}`)) return json({ error: "collect_save_first" }, 409);

    let { state } = await this.status();
    if (state === "failed") {
      await this.stopContainer();
      await this.reset();
      state = "empty";
    }
    let seats = await this.seats();
    const seated = seats.find((seat) => seat.playerId === playerId);
    if (seated) {
      // Plugging in again (a reload, a second tab) keeps the same seat.
      console.log(JSON.stringify({ message: "link plug again", room: this.logId(), slot: seated.slot, state }));
      return json({ slot: seated.slot, ...(await this.status()) });
    }
    if (seats.length >= 2) return json({ error: "room_full" }, 409);

    const slot: 1 | 2 = seats.some((seat) => seat.slot === 1) ? 2 : 1;
    seats = [...seats, { playerId, romHash: body.romHash, slot }];
    const starting = seats.length === 2;
    await this.ctx.storage.put({
      seats,
      [`sram:${slot}`]: sram,
      [`snapshot:${slot}`]: snapshot,
      state: starting ? "starting" : "waiting",
      since: Date.now(),
    });
    await this.ctx.storage.setAlarm(Date.now() + (starting ? this.checkEveryMs : this.waitMs));
    console.log(
      JSON.stringify({
        message: "link plug",
        room: this.logId(),
        slot,
        player: playerId.slice(0, 8),
        romHash: body.romHash.slice(0, 8),
        sramBytes: sram.length,
        snapshotBytes: snapshot.length,
        starting,
      }),
    );
    if (starting) {
      try {
        await this.startLink(seats);
        await this.ctx.storage.put({ state: "linked", since: Date.now() });
        await this.ctx.storage.delete("idleSince");
        await this.relayLinkdLog();
      } catch (err) {
        console.error(JSON.stringify({ message: "link start failed", error: String(err) }));
        await this.relayLinkdLog();
        await this.fail(err instanceof LinkError ? err.code : "start_failed");
      }
    }
    return json({ slot, ...(await this.status()) });
  }

  /** Starts linkd and hands it both games; resolves once they're running. */
  private async startLink(seats: Seat[]): Promise<void> {
    const container = this.ctx.container;
    if (!container) throw new LinkError("no_container");
    const startedAt = Date.now();
    console.log(JSON.stringify({ message: "link container start", room: this.logId(), wasRunning: container.running }));
    if (!container.running) container.start();
    // The alarm keeps this object (and so the container) alive while linked;
    // this is a backstop in case it doesn't.
    await container.setInactivityTimeout(this.idleMs + 2 * this.checkEveryMs);
    await this.waitForLinkd();
    for (const seat of seats) {
      const rom = await this.env.ROMS.get(`roms/${seat.playerId}/${seat.romHash}`);
      if (!rom) throw new LinkError("rom_missing");
      const romBytes = await rom.arrayBuffer();
      await this.linkd(`/players/${seat.slot}/rom`, { method: "PUT", body: romBytes });
      const sram = (await this.ctx.storage.get<Uint8Array>(`sram:${seat.slot}`)) ?? new Uint8Array(0);
      await this.linkd(`/players/${seat.slot}/save`, { method: "PUT", body: sram });
      const state = (await this.ctx.storage.get<Uint8Array>(`snapshot:${seat.slot}`)) ?? new Uint8Array(0);
      const unpacked = await unpackState(state);
      await this.linkd(`/players/${seat.slot}/state`, { method: "PUT", body: unpacked });
      console.log(
        JSON.stringify({
          message: "link seat loaded",
          room: this.logId(),
          slot: seat.slot,
          romBytes: romBytes.byteLength,
          sramBytes: sram.length,
          snapshot: unpacked.length > 0,
          snapshotBytes: state.length,
          unpackedSnapshotBytes: unpacked.length,
        }),
      );
    }
    await this.linkd("/start", { method: "POST" });
    console.log(JSON.stringify({ message: "link started", room: this.logId(), ms: Date.now() - startedAt }));
  }

  /** linkd takes a moment to boot; its /status answers once it listens. */
  private async waitForLinkd(): Promise<void> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const response = await this.port().fetch("http://linkd/status");
        if (response.ok) return;
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline) throw new LinkError("container_timeout");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  private async openScreen(playerId: string, request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "websocket_required" }, 426);
    const seat = (await this.seats()).find((s) => s.playerId === playerId);
    if (!seat) return json({ error: "not_plugged_in" }, 403);
    if ((await this.status()).state !== "linked") return json({ error: "not_linked" }, 409);
    console.log(JSON.stringify({ message: "screen connected", slot: seat.slot, clientColo: request.headers.get("X-Client-Colo") }));
    try {
      return await this.port().fetch(new Request(`http://linkd/ws?player=${seat.slot}`, request));
    } catch (err) {
      console.error(JSON.stringify({ message: "screen connect failed", error: String(err) }));
      await this.fail("link_lost");
      return json({ error: "not_linked" }, 409);
    }
  }

  private async unplug(playerId: string): Promise<Response> {
    if (!(await this.seats()).some((seat) => seat.playerId === playerId)) return json({ error: "not_plugged_in" }, 403);
    const { state } = await this.status();
    if (state === "starting" || state === "ending") return json({ error: "busy" }, 409);
    if (state !== "linked") {
      // Waiting, or a link that already failed: nothing to save, just clear it.
      await this.stopContainer();
      await this.reset();
      return json({ ended: true });
    }
    await this.endLink();
    const response = await this.takeSave(playerId);
    // If linkd couldn't hand the saves back, the players keep the saves they
    // plugged in with (the app still has them).
    return response.status === 200 ? response : json({ ended: true, saveLost: true });
  }

  /**
   * Pulling the cable ends it for both: stop linkd, keep each save for its
   * owner until they pick it up, stop the container and clear the room,
   * whatever fails along the way.
   */
  private async endLink(): Promise<void> {
    await this.ctx.storage.put({ state: "ending", since: Date.now() });
    try {
      await this.linkd("/stop", { method: "POST" });
      for (const seat of await this.seats()) {
        const response = await this.linkd(`/players/${seat.slot}/save`);
        const result: Result = { romHash: seat.romHash, sram: new Uint8Array(await response.arrayBuffer()) };
        // Without a snapshot the player still gets the save; the game powers on from it.
        try {
          const state = new Uint8Array(await (await this.linkd(`/players/${seat.slot}/state`)).arrayBuffer());
          if (state.length) result.state = await pack(state, new CompressionStream("deflate"));
        } catch (err) {
          console.error(JSON.stringify({ message: "link snapshot lost", slot: seat.slot, error: String(err) }));
        }
        await this.ctx.storage.put(`result:${seat.playerId}`, result);
      }
    } catch (err) {
      console.error(JSON.stringify({ message: "link end failed, saves lost", error: String(err) }));
    }
    await this.relayLinkdLog();
    await this.stopContainer();
    await this.reset();
  }

  /** Every minute while waiting or linked: end what nobody uses any more. */
  override async alarm(): Promise<void> {
    const { state } = await this.status();
    if (state === "waiting") {
      const since = (await this.ctx.storage.get<number>("since")) ?? 0;
      if (Date.now() - since >= this.waitMs) await this.reset();
      else await this.ctx.storage.setAlarm(since + this.waitMs);
      return;
    }
    if (state === "starting" || state === "ending") {
      await this.ctx.storage.setAlarm(Date.now() + this.checkEveryMs);
      return;
    }
    if (state !== "linked") return;

    let watching = 1;
    try {
      const status = await (await this.linkd("/status")).json<{ viewers: number[] }>();
      watching = status.viewers.reduce((a, b) => a + b, 0);
    } catch (err) {
      console.error(JSON.stringify({ message: "link check failed", error: String(err) }));
    }
    await this.relayLinkdLog();
    if (watching > 0) {
      await this.ctx.storage.delete("idleSince");
    } else {
      const idleSince = (await this.ctx.storage.get<number>("idleSince")) ?? Date.now();
      if (Date.now() - idleSince >= this.idleMs) {
        await this.endLink();
        return;
      }
      await this.ctx.storage.put("idleSince", idleSince);
    }
    await this.ctx.storage.setAlarm(Date.now() + this.checkEveryMs);
  }

  private async takeSave(playerId: string): Promise<Response> {
    const key = `result:${playerId}`;
    const result = await this.ctx.storage.get<Result>(key);
    if (!result) return json({ error: "not_found" }, 404);
    await this.ctx.storage.delete(key);
    return json({
      sram: bytesToBase64(result.sram),
      ...(result.state ? { state: bytesToBase64(result.state) } : {}),
      romHash: result.romHash,
    });
  }

  private async state(): Promise<RoomState> {
    return (await this.ctx.storage.get<RoomState>("state")) ?? "empty";
  }

  private async seats(): Promise<Seat[]> {
    return (await this.ctx.storage.get<Seat[]>("seats")) ?? [];
  }

  /** Marks the link failed and stops the container; the next plug or unplug clears it. */
  private async fail(error: string): Promise<void> {
    await this.ctx.storage.put({ state: "failed", error });
    await this.stopContainer();
  }

  /** Clears the session (not the saves waiting to be picked up). */
  private async reset(): Promise<void> {
    await this.ctx.storage.delete(["state", "seats", "error", "since", "idleSince", "sram:1", "sram:2", "snapshot:1", "snapshot:2"]);
    await this.ctx.storage.deleteAlarm();
  }

  private async stopContainer(): Promise<void> {
    const container = this.ctx.container;
    try {
      if (container?.running) await container.destroy();
    } catch (err) {
      console.error(JSON.stringify({ message: "container stop failed", error: String(err) }));
    }
  }

  /**
   * linkd's log lines since the last call, into Workers Logs one by one
   * (the container's own output doesn't reach them). Called after the start,
   * on each check while linked and before the container stops; lines in
   * between wait in linkd (it keeps the last 512).
   */
  private async relayLinkdLog(): Promise<void> {
    if (!this.ctx.container?.running) return;
    try {
      const response = await this.port().fetch("http://linkd/log");
      if (!response.ok) return;
      const room = this.logId();
      for (const line of (await response.text()).split("\n")) {
        if (line) console.log(JSON.stringify({ message: "linkd", room, line }));
      }
    } catch (err) {
      console.error(JSON.stringify({ message: "linkd log relay failed", error: String(err) }));
    }
  }

  /** A short id for this room in the logs, without the players' ids in its name. */
  private logId(): string {
    return this.ctx.id.toString().slice(0, 8);
  }

  private port(): Fetcher {
    return this.ctx.container!.getTcpPort(LINKD_PORT);
  }

  private async linkd(path: string, init?: RequestInit): Promise<Response> {
    const response = await this.port().fetch(`http://linkd${path}`, init);
    if (!response.ok) throw new LinkError(`linkd_${response.status}`);
    return response;
  }
}

class LinkError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * A snapshot as plugging in sent it, unpacked for linkd; empty (the game
 * powers on) if there's none or it doesn't unpack.
 */
async function unpackState(packed: Uint8Array): Promise<Uint8Array> {
  if (!packed.length) return packed;
  try {
    return await pack(packed, new DecompressionStream("deflate"), MAX_UNPACKED_STATE_BYTES);
  } catch (err) {
    console.error(JSON.stringify({ message: "snapshot didn't unpack, powering on", error: String(err) }));
    return new Uint8Array(0);
  }
}

/** Runs bytes through a (de)compression stream, refusing more than `limit` bytes out. */
async function pack(bytes: Uint8Array, through: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough<Uint8Array>(through);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > limit) throw new Error("too_large");
    chunks.push(chunk);
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
