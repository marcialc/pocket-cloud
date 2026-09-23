import { useCallback, useEffect, useState } from "react";
import {
  BOARDS,
  formatFriendCode,
  inviteLink,
  normalizeFriendCode,
  normalizeName,
  MAX_NAME_LENGTH,
  type FriendsResponse,
  type GameLeaderboards,
  type Leaderboard,
  type MyProfile,
} from "../../shared/social";
import { displayName } from "../emulator/rom";
import {
  addFriend,
  fetchFriends,
  fetchLeaderboards,
  fetchProfile,
  removeFriend,
  resetInvite,
  saveProfile,
  socialErrorMessage,
} from "../saves/socialApi";
import { formatPlayTime } from "./format";
import { Icon } from "./icons";
import { SidePanel } from "./SidePanel";

type Props = {
  /** In-game: this game's leaderboard comes first. */
  current?: { romHash: string } | undefined;
  onClose: () => void;
};

type Load<T> = { state: "loading" } | { state: "error" } | { state: "ready"; value: T };

/**
 * Friends and leaderboards. Games are never sent to friends: each of you
 * loads your own copy, and the same file lands you on the same board.
 */
export function FriendsPanel({ current, onClose }: Props) {
  const [profile, setProfile] = useState<Load<MyProfile | null>>({ state: "loading" });
  const [friends, setFriends] = useState<FriendsResponse | null>(null);
  const [games, setGames] = useState<Load<GameLeaderboards[]>>({ state: "loading" });
  const [announce, setAnnounce] = useState("");

  const loadProfile = useCallback(() => {
    setProfile({ state: "loading" });
    fetchProfile().then(
      (value) => setProfile({ state: "ready", value }),
      () => setProfile({ state: "error" }),
    );
  }, []);
  useEffect(loadProfile, [loadProfile]);

  const hasProfile = profile.state === "ready" && profile.value !== null;
  const refresh = useCallback(() => {
    fetchFriends().then(setFriends, () => setFriends(null));
    fetchLeaderboards().then(
      (value) => setGames({ state: "ready", value }),
      () => setGames({ state: "error" }),
    );
  }, []);
  useEffect(() => {
    if (hasProfile) refresh();
  }, [hasProfile, refresh]);

  return (
    <SidePanel id="friends-title" title="FRIENDS" onClose={onClose}>
      {profile.state === "loading" && <p className="px dim-ink blink">LOADING…</p>}
      {profile.state === "error" && (
        <p className="status-line">
          <span>Can’t reach the server right now.</span>
          <button type="button" className="link" onClick={loadProfile}>
            Try again
          </button>
        </p>
      )}
      {profile.state === "ready" && profile.value === null && (
        <div className="card stack">
          <h3 className="h-lg">Play with friends</h3>
          <p className="muted">
            Pick a name and you get an invite link to send to your friends. When you both play the same game file, you
            share a leaderboard.
          </p>
          <NameForm submitLabel="Get my invite link" onSaved={(value) => setProfile({ state: "ready", value })} />
        </div>
      )}
      {profile.state === "ready" && profile.value && (
        <>
          <MyCode profile={profile.value} onRenamed={(value) => setProfile({ state: "ready", value })} onAnnounce={setAnnounce} />
          <AddFriend
            onAdded={(message) => {
              setAnnounce(message);
              refresh();
            }}
          />
          {friends && (
            <FriendLists
              friends={friends}
              onChanged={(message) => {
                setAnnounce(message);
                refresh();
              }}
            />
          )}
          <Leaderboards games={games} currentHash={current?.romHash} onRetry={refresh} />
        </>
      )}
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </SidePanel>
  );
}

function NameForm({ initial = "", submitLabel, onSaved, onCancel }: {
  initial?: string;
  submitLabel: string;
  onSaved: (profile: MyProfile) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="sign-in"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const normalized = normalizeName(name);
        if (!normalized) return setError(`Pick a name of 1 to ${MAX_NAME_LENGTH} characters.`);
        setBusy(true);
        saveProfile(normalized).then(onSaved, (err) => {
          setError(socialErrorMessage(err));
          setBusy(false);
        });
      }}
    >
      <label htmlFor="friend-name" className="field-label">
        Name your friends see
      </label>
      <input
        id="friend-name"
        className="field"
        value={name}
        maxLength={MAX_NAME_LENGTH}
        autoComplete="nickname"
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "friend-name-error" : undefined}
      />
      {error && (
        <p id="friend-name-error" className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row end">
        {onCancel && (
          <button type="button" className="btn small" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className={`btn primary${onCancel ? " small" : " wide"}`} type="submit" disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );
}

function MyCode({ profile, onRenamed, onAnnounce }: {
  profile: MyProfile;
  onRenamed: (profile: MyProfile) => void;
  onAnnounce: (message: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [copied, setCopied] = useState<"link" | "code" | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const link = inviteLink(location.origin, profile.inviteToken);
  const code = formatFriendCode(profile.friendCode);

  const copy = async (what: "link" | "code") => {
    try {
      await navigator.clipboard.writeText(what === "link" ? link : code);
    } catch {
      return setError("Couldn’t copy. Select it and copy it yourself.");
    }
    setCopied(what);
    onAnnounce(what === "link" ? "Invite link copied." : "Friend code copied.");
    setTimeout(() => setCopied(null), 1500);
  };

  const share = () =>
    navigator
      .share({ title: "Pocket Cloud", text: `${profile.name} invited you to be friends on Pocket Cloud`, url: link })
      .catch(() => {});

  const reset = () =>
    resetInvite().then(
      (p) => {
        setConfirmReset(false);
        onRenamed(p);
        onAnnounce("Made a new invite link. The old one no longer works.");
      },
      (err) => setError(socialErrorMessage(err)),
    );

  if (renaming) {
    return (
      <div className="card">
        <NameForm
          initial={profile.name}
          submitLabel="Save"
          onCancel={() => setRenaming(false)}
          onSaved={(p) => {
            setRenaming(false);
            onRenamed(p);
            onAnnounce(`Your name is now ${p.name}.`);
          }}
        />
      </div>
    );
  }
  return (
    <div className="card stack-sm">
      <div className="row">
        <strong className="grow">{profile.name}</strong>
        <button type="button" className="link" onClick={() => setRenaming(true)}>
          Change name
        </button>
      </div>
      <h3 className="h-lg">Invite a friend</h3>
      <p className="fine">
        Send this link however you like. When your friend opens it, you’re friends. No code to type, and nothing to
        share again after that.
      </p>
      <div className="row">
        {typeof navigator.share === "function" && (
          <button type="button" className="btn small primary" onClick={() => void share()}>
            <Icon name="upload" size={16} /> Share invite link
          </button>
        )}
        <button
          type="button"
          className={`btn small${typeof navigator.share === "function" ? "" : " primary"}`}
          onClick={() => void copy("link")}
        >
          <Icon name={copied === "link" ? "check" : "copy"} size={16} /> {copied === "link" ? "Copied" : "Copy link"}
        </button>
      </div>
      {confirmReset ? (
        <div className="confirm-inline enter" role="alertdialog" aria-labelledby="reset-invite-q">
          <p id="reset-invite-q">
            Make a new link? Anyone with the old one can no longer add you. Friends you already have stay.
          </p>
          <div className="row end">
            <button type="button" className="btn small" autoFocus onClick={() => setConfirmReset(false)}>
              Keep it
            </button>
            <button type="button" className="btn small primary" onClick={() => void reset()}>
              New link
            </button>
          </div>
        </div>
      ) : (
        <p className="fine">
          Or share your friend code <strong className="px friend-code-sm">{code}</strong>{" "}
          <button type="button" className="link" onClick={() => void copy("code")}>
            {copied === "code" ? "copied" : "copy"}
          </button>{" "}
          ·{" "}
          <button type="button" className="link" onClick={() => setConfirmReset(true)}>
            Link shared too widely? Make a new one
          </button>
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function AddFriend({ onAdded }: { onAdded: (message: string) => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  return (
    <section className="stack-sm" aria-labelledby="add-friend-h">
      <h3 id="add-friend-h" className="px h-section">
        ADD A FRIEND
      </h3>
      <form
        className="row add-friend"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const normalized = normalizeFriendCode(code);
          if (!normalized) return setMessage({ error: true, text: "Friend codes look like ABCD-EFGH." });
          setBusy(true);
          addFriend(normalized)
            .then(
              (res) => {
                const text =
                  res.status === "friends"
                    ? `You and ${res.friend.name} are friends now.`
                    : `Asked ${res.friend.name}. You’ll be friends once they add your code too.`;
                setMessage({ error: false, text });
                setCode("");
                onAdded(text);
              },
              (err) => setMessage({ error: true, text: socialErrorMessage(err) }),
            )
            .finally(() => setBusy(false));
        }}
      >
        <label htmlFor="friend-code-input" className="sr-only">
          Friend code
        </label>
        <input
          id="friend-code-input"
          className="field grow"
          value={code}
          placeholder="ABCD-EFGH"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={12}
          onChange={(e) => {
            setCode(e.target.value);
            setMessage(null);
          }}
          aria-invalid={message?.error ? true : undefined}
        />
        <button className="btn small primary" type="submit" disabled={busy}>
          {busy ? "Adding…" : "Add"}
        </button>
      </form>
      {message && (
        <p className={message.error ? "error" : "fine"} role={message.error ? "alert" : undefined}>
          {message.text}
        </p>
      )}
    </section>
  );
}

function FriendLists({ friends, onChanged }: { friends: FriendsResponse; onChanged: (message: string) => void }) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = (promise: Promise<unknown>, message: string) =>
    promise.then(
      () => {
        setConfirm(null);
        setError(null);
        onChanged(message);
      },
      (err) => setError(socialErrorMessage(err)),
    );

  const { incoming, outgoing } = friends;
  return (
    <>
      {incoming.length > 0 && (
        <section className="stack-sm" aria-labelledby="requests-h">
          <h3 id="requests-h" className="px h-section">
            WANTS TO BE FRIENDS
          </h3>
          <ul className="save-list">
            {incoming.map((p) => (
              <li key={p.friendCode} className="card save-row">
                <div className="save-row-main">
                  <span className="save-row-text">
                    <strong>{p.name}</strong>
                    <small>{formatFriendCode(p.friendCode)}</small>
                  </span>
                  <button type="button" className="btn small" onClick={() => void act(removeFriend(p.friendCode), `Declined ${p.name}.`)}>
                    Decline
                  </button>
                  <button
                    type="button"
                    className="btn small primary"
                    onClick={() => void act(addFriend(p.friendCode), `You and ${p.name} are friends now.`)}
                  >
                    Accept
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="stack-sm" aria-labelledby="friends-h">
        <h3 id="friends-h" className="px h-section">
          FRIENDS
        </h3>
        {friends.friends.length === 0 && outgoing.length === 0 && (
          <p className="card fine">No friends yet. Send your code to a friend, or add theirs above.</p>
        )}
        {(friends.friends.length > 0 || outgoing.length > 0) && (
          <ul className="save-list">
            {friends.friends.map((p) => (
              <li key={p.friendCode} className="card save-row">
                <div className="save-row-main">
                  <span className="save-row-text">
                    <strong>{p.name}</strong>
                    <small>{formatFriendCode(p.friendCode)}</small>
                  </span>
                  {confirm !== p.friendCode && (
                    <button
                      type="button"
                      className="ibtn small tip danger-ink"
                      data-tip="Remove friend"
                      aria-label={`Remove ${p.name} from friends`}
                      onClick={() => setConfirm(p.friendCode)}
                    >
                      <Icon name="trash" size={17} />
                    </button>
                  )}
                </div>
                {confirm === p.friendCode && (
                  <div className="confirm-inline enter" role="alertdialog" aria-labelledby={`unfriend-${p.friendCode}`}>
                    <p id={`unfriend-${p.friendCode}`}>
                      Remove <strong>{p.name}</strong>? You’ll stop seeing each other on leaderboards.
                    </p>
                    <div className="row end">
                      <button type="button" className="btn small" autoFocus onClick={() => setConfirm(null)}>
                        Keep
                      </button>
                      <button
                        type="button"
                        className="btn small primary"
                        onClick={() => void act(removeFriend(p.friendCode), `Removed ${p.name}.`)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
            {outgoing.map((p) => (
              <li key={p.friendCode} className="card save-row">
                <div className="save-row-main">
                  <span className="save-row-text">
                    <strong>{p.name}</strong>
                    <small>Waiting for them to add your code</small>
                  </span>
                  <button type="button" className="btn small" onClick={() => void act(removeFriend(p.friendCode), `Cancelled the request to ${p.name}.`)}>
                    Cancel
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
    </>
  );
}

function Leaderboards({ games, currentHash, onRetry }: {
  games: Load<GameLeaderboards[]>;
  currentHash: string | undefined;
  onRetry: () => void;
}) {
  const list = games.state === "ready" ? games.value : [];
  const current = list.find((g) => g.romHash === currentHash);
  const others = list.filter((g) => g.romHash !== currentHash);
  return (
    <section className="stack-sm" aria-labelledby="boards-h">
      <h3 id="boards-h" className="px h-section">
        LEADERBOARDS
      </h3>
      {games.state === "loading" && <p className="px dim-ink blink">LOADING…</p>}
      {games.state === "error" && (
        <p className="status-line">
          <span>Can’t load leaderboards right now.</span>
          <button type="button" className="link" onClick={onRetry}>
            Try again
          </button>
        </p>
      )}
      {games.state === "ready" && currentHash && !current && (
        <p className="card fine">This game isn’t on a leaderboard yet. It shows up after its first cloud save.</p>
      )}
      {games.state === "ready" && list.length === 0 && !currentHash && (
        <p className="card fine">
          Nothing here yet. Games show up after their first cloud save; you share a board with friends who load the same
          game file.
        </p>
      )}
      {current && <GameCard game={current} current />}
      {others.map((g) => (
        <GameCard key={g.romHash} game={g} />
      ))}
    </section>
  );
}

function GameCard({ game, current = false }: { game: GameLeaderboards; current?: boolean }) {
  return (
    <article className="card stack-sm board-card" aria-label={`${displayName(game)} leaderboard`}>
      <div className="row">
        <strong className="grow">{displayName(game)}</strong>
        <small className="fine">{current ? "Playing now" : game.players === 1 ? "Just one of you so far" : `${game.players} players`}</small>
      </div>
      {game.boards.map((b) => (
        <Board key={b.board} board={b} />
      ))}
    </article>
  );
}

function Board({ board }: { board: Leaderboard }) {
  const meta = BOARDS[board.board];
  return (
    <div className="board">
      <h4 className="fine">{meta.label}</h4>
      <ol className="board-list">
        {board.entries.map((e, i) => (
          <li key={e.friendCode} className={e.me ? "me" : undefined}>
            <span className="board-rank px" aria-hidden>
              {i + 1}
            </span>
            <span className="grow">
              {e.name}
              {e.me && <span className="sr-only"> (you)</span>}
            </span>
            <span className="board-value">{formatValue(meta.unit, e.value)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function formatValue(unit: "ms" | "count" | "points", value: number): string {
  if (unit === "ms") return formatPlayTime(value);
  if (unit === "count") return `${value}`;
  return value.toLocaleString();
}
