/**
 * A stand-in for the pocket-cloud-link Worker in tests (wired up as the LINK
 * service binding in vitest.config.ts; it runs in Node, not workerd). Keeps
 * rooms in memory and "links" at once, with no container: enough to test
 * the /api/link routes. The real API is in link-server/worker/index.ts.
 */
type Seat = { playerId: string; romHash: string; slot: 1 | 2; state?: string };
type Room = { seats: Seat[]; results: Map<string, { romHash: string; sram: string; state?: string }> };

const rooms = new Map<string, Room>();

export async function fakeLink(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const match = /^\/rooms\/([^/]+)(?:\/([a-z]+))?$/.exec(url.pathname);
  const playerId = request.headers.get("X-Player-Id");
  if (!match || !playerId) return Response.json({ error: "not_found" }, { status: 404 });
  const name = decodeURIComponent(match[1]!);
  const room: Room = rooms.get(name) ?? { seats: [], results: new Map() };
  rooms.set(name, room);
  const status = () => ({
    state: room.seats.length === 2 ? "linked" : room.seats.length ? "waiting" : "empty",
    players: room.seats.map(({ playerId, slot }) => ({ playerId, slot })),
    savesWaiting: [...room.results].map(([playerId, { romHash }]) => ({ playerId, romHash })),
  });

  switch (`${request.method} ${match[2] ?? ""}`) {
    case "GET ":
      return Response.json(status());
    case "POST plug": {
      const { romHash, state } = (await request.json()) as { romHash: string; state?: string };
      if (room.results.has(playerId)) return Response.json({ error: "collect_save_first" }, { status: 409 });
      let seat = room.seats.find((s) => s.playerId === playerId);
      if (!seat) {
        if (room.seats.length === 2) return Response.json({ error: "room_full" }, { status: 409 });
        seat = { playerId, romHash, slot: room.seats.some((s) => s.slot === 1) ? 2 : 1, ...(state ? { state } : {}) };
        room.seats.push(seat);
      }
      return Response.json({ slot: seat.slot, ...status() });
    }
    case "GET ws":
      return Response.json({ error: "not_linked" }, { status: 409 });
    case "POST unplug": {
      if (!room.seats.some((s) => s.playerId === playerId)) return Response.json({ error: "not_plugged_in" }, { status: 403 });
      if (room.seats.length < 2) {
        room.seats = [];
        return Response.json({ ended: true });
      }
      // The game "carried on" from the snapshot it was plugged in with, and was left there.
      for (const seat of room.seats) {
        const state = seat.state ? { state: seat.state } : {};
        room.results.set(seat.playerId, { romHash: seat.romHash, sram: btoa(`save of player ${seat.slot}`), ...state });
      }
      room.seats = [];
      return takeSave(room, playerId);
    }
    case "GET save":
      return takeSave(room, playerId);
    default:
      return Response.json({ error: "not_found" }, { status: 404 });
  }
}

function takeSave(room: Room, playerId: string): Response {
  const result = room.results.get(playerId);
  if (!result) return Response.json({ error: "not_found" }, { status: 404 });
  room.results.delete(playerId);
  return Response.json(result);
}
