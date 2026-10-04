import { useCallback, useEffect, useRef, useState } from "react";
import type { LinkAvailability, LinkFriend } from "../../shared/link";
import { formatFriendCode, type Profile } from "../../shared/social";
import { fetchLinkFriends, linkErrorMessage } from "../saves/linkApi";
import { SidePanel } from "./SidePanel";

type Props = {
  /** The game open now: only its own save from a past link can be picked up here. */
  romHash: string;
  /** `ask`: ask the friend to plug in too (not when they're already waiting for you). */
  onPlug: (friend: Profile, ask: boolean) => void;
  onClose: () => void;
};

/**
 * Pick a friend to plug the link cable in with (GBA trading and battling).
 * Only friends online in a game that links with this one can be picked, plus
 * any friend whose link left you a save for this game to pick up.
 */
export function LinkPanel({ romHash, onPlug, onClose }: Props) {
  const [rows, setRows] = useState<LinkFriend[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Bumped when the panel closes or the game changes, so an answer still on its way is dropped.
  const generation = useRef(0);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    // A request can take longer than the 5s between polls: one at a time, so an older answer never wins.
    if (inFlight.current) return;
    inFlight.current = true;
    const mine = generation.current;
    try {
      const friends = sortRows(await fetchLinkFriends(romHash));
      if (mine !== generation.current) return;
      setRows(friends);
      setError(null);
    } catch (err) {
      if (mine === generation.current) setError(linkErrorMessage(err));
    } finally {
      if (mine === generation.current) inFlight.current = false;
    }
  }, [romHash]);

  useEffect(() => {
    void load();
    // Friends plugging in show up without reopening the panel.
    const refresh = setInterval(() => void load(), 5000);
    return () => {
      clearInterval(refresh);
      generation.current++;
      inFlight.current = false;
    };
  }, [load]);

  return (
    <SidePanel id="link-title" title="LINK CABLE" onClose={onClose}>
      <div className="card stack-sm">
        <h3 className="h-lg">Trade and battle with a friend</h3>
        <p className="fine">
          Like two GBAs on a cable: you both play your own game. Go to the link room in your game (in Pokémon, the
          Pokémon Center’s upstairs), then ask a friend to link: their game pauses and asks them to accept. While linked, both games run on the link server
          and carry on from where you were; unplug and your game carries on here from where the link left it, with your
          save. A game that asks you to connect the cable and turn the power on (like Four Swords): press Reset once
          linked.
        </p>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}{" "}
          <button type="button" className="link" onClick={() => void load()}>
            Try again
          </button>
        </p>
      )}
      {!rows && !error && <p className="px dim-ink blink">LOADING…</p>}

      {rows && (
        <section className="stack-sm" aria-labelledby="link-friends-h">
          <h3 id="link-friends-h" className="px h-section">
            FRIENDS
          </h3>
          {rows.length === 0 && <p className="card fine">No friends yet. Add one in Friends and leaderboard first.</p>}
          {rows.length > 0 && !rows.some((row) => canPlug(row, romHash)) && (
            <p className="card fine">None of your friends can link with this game right now.</p>
          )}
          <ul className="save-list">
            {rows.map((row) => {
              const { friend, link } = row;
              const waiting = waitingForYou(row);
              return (
                <li key={friend.friendCode} className="card save-row">
                  <div className="save-row-main">
                    <span className="save-row-text">
                      <strong>{friend.name}</strong>
                      <small>{describe(row, romHash) ?? formatFriendCode(friend.friendCode)}</small>
                    </span>
                    <button
                      type="button"
                      className={`btn small${waiting ? " primary" : ""}`}
                      disabled={!canPlug(row, romHash)}
                      onClick={() => onPlug(friend, !waiting)}
                    >
                      {waiting ? "Accept" : link.saveWaiting === romHash ? "Plug in" : "Ask to link"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </SidePanel>
  );
}

/** Plugged in with you and waiting, while you aren't yet. */
function waitingForYou({ availability, link }: LinkFriend): boolean {
  return availability === "can_link" && link.friendPluggedIn && link.slot === undefined;
}

/**
 * Whether the button works: a friend who can link with this game, or a save
 * from your last link with them, in this game, to pick up (whatever they're
 * doing now). Not while your save from them is waiting in another game: it
 * has to be picked up there first.
 */
function canPlug({ availability, link }: LinkFriend, romHash: string): boolean {
  if (link.saveWaiting) return link.saveWaiting === romHash;
  return availability === "can_link";
}

const ORDER: Record<LinkAvailability, number> = { can_link: 1, other_game: 2, lobby: 3, offline: 4 };

/** Friends waiting for you first, then who can link, then everyone else by what they're doing (the server's name order within each). */
function sortRows(rows: LinkFriend[]): LinkFriend[] {
  const rank = (row: LinkFriend) => (waitingForYou(row) ? 0 : ORDER[row.availability]);
  return [...rows].sort((a, b) => rank(a) - rank(b));
}

function describe(row: LinkFriend, romHash: string): string | null {
  const { availability, playing, link } = row;
  if (link.saveWaiting && link.saveWaiting !== romHash) {
    return "Your save from your last link is waiting. Open the game you played then to pick it up.";
  }
  if (link.saveWaiting) return "Your save from your last link is ready. Plug in to pick it up and link again.";
  if (link.state === "linked") return "Linked with you";
  if (availability === "other_game") return playing ? `Playing ${playing}` : "Playing another game";
  if (availability === "lobby") return "In lobby";
  if (availability === "offline") return "Offline";
  if (waitingForYou(row)) return "Wants to link with you";
  if (link.state === "failed") return "Your last link didn’t work. Plugging in starts over.";
  return null;
}
