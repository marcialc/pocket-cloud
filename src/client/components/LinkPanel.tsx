import { useCallback, useEffect, useState } from "react";
import { formatFriendCode, type Profile } from "../../shared/social";
import { fetchLinkStatus, type LinkStatus } from "../saves/linkApi";
import { fetchFriends, socialErrorMessage } from "../saves/socialApi";
import { SidePanel } from "./SidePanel";

type Props = {
  /** The game open now: only its own save from a past link can be picked up here. */
  romHash: string;
  onPlug: (friend: Profile) => void;
  onClose: () => void;
};

type FriendRow = { friend: Profile; status: LinkStatus | null };

/** Pick a friend to plug the link cable in with (GBA trading and battling). */
export function LinkPanel({ romHash, onPlug, onClose }: Props) {
  const [rows, setRows] = useState<FriendRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { friends } = await fetchFriends();
      const statuses = await Promise.all(friends.map((f) => fetchLinkStatus(f.friendCode).catch(() => null)));
      setRows(friends.map((friend, i) => ({ friend, status: statuses[i] ?? null })));
    } catch (err) {
      setError(socialErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
    // Friends plugging in show up without reopening the panel.
    const refresh = setInterval(() => void load(), 5000);
    return () => clearInterval(refresh);
  }, [load]);

  return (
    <SidePanel id="link-title" title="LINK CABLE" onClose={onClose}>
      <div className="card stack-sm">
        <h3 className="h-lg">Trade and battle with a friend</h3>
        <p className="fine">
          Like two GBAs on a cable: you both play your own game and save. Go to the link room in your game (in Pokémon,
          the Pokémon Center’s upstairs), save, then plug in with the same friend. While linked, both games run on the
          link server; unplug and your save from the link comes back here.
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
          <ul className="save-list">
            {rows.map(({ friend, status }) => {
              const otherGameSave = status?.saveWaiting && status.saveWaiting !== romHash;
              return (
                <li key={friend.friendCode} className="card save-row">
                  <div className="save-row-main">
                    <span className="save-row-text">
                      <strong>{friend.name}</strong>
                      <small>{describe(status, romHash) ?? formatFriendCode(friend.friendCode)}</small>
                    </span>
                    <button
                      type="button"
                      className={`btn small${status?.friendPluggedIn ? " primary" : ""}`}
                      disabled={!!otherGameSave}
                      onClick={() => onPlug(friend)}
                    >
                      Plug in
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

function describe(status: LinkStatus | null, romHash: string): string | null {
  if (!status) return null;
  if (status.saveWaiting && status.saveWaiting !== romHash) {
    return "Your save from your last link is waiting. Open the game you played then to pick it up.";
  }
  if (status.saveWaiting) return "Your save from your last link is ready. Plug in to pick it up and link again.";
  if (status.state === "linked") return "Linked with you";
  if (status.friendPluggedIn) return "Plugged in, waiting for you";
  if (status.state === "failed") return "Your last link didn’t work. Plugging in starts over.";
  return null;
}
