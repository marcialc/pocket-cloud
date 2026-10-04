/**
 * GBA link play: wire types shared by the browser client and the Worker
 * (/api/link, see src/worker/link.ts).
 */

import type { Profile } from "./social";

export type LinkState = "empty" | "waiting" | "starting" | "linked" | "ending" | "failed";

/** A pair of friends' link room, as one of them sees it. */
export type LinkStatus = {
  state: LinkState;
  /** Your place on the cable, once plugged in (1 or 2). */
  slot?: number;
  friendPluggedIn: boolean;
  /** The romHash of your save from a link that ended, still to be picked up. */
  saveWaiting: string | null;
  /** Why a link failed. */
  error?: string;
};

/**
 * Whether a friend can link with the game you have open:
 *
 *   can_link    online in a game that links with yours (see canLink)
 *   other_game  online in a game that doesn't
 *   lobby       online on the games page
 *   offline     not seen for PRESENCE_TIMEOUT_MS
 */
export type LinkAvailability = "can_link" | "other_game" | "lobby" | "offline";

/**
 * A friend in the Link panel. Their ROM hash and game code stay on the
 * server; `playing` is their game's name, for other_game only.
 */
export type LinkFriend = {
  friend: Profile;
  availability: LinkAvailability;
  playing?: string;
  link: LinkStatus;
};

export type LinkFriendsResponse = { friends: LinkFriend[] };

/** What the plug route answers: the room, plus the id of the link request it sent, if it asked (`ask`). */
export type PlugResponse = LinkStatus & { requestId?: string };

/** A link request nobody has answered is turned down after this long. */
export const LINK_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Why a link request was turned down without an answer:
 *
 *   offline      the friend went offline
 *   not_in_game  the friend isn't in a game that links with yours (left it, or the lobby)
 *   hidden       the friend's tab is in the background, so nobody is there to answer
 *   linked       the friend is on the cable with someone else
 */
export type LinkRequestUnavailable = "offline" | "not_in_game" | "hidden" | "linked";

/** A link request you sent, as your heartbeat sees it. It's removed once the friend accepts (the link starts). */
export type OutgoingLinkRequest = { id: string; to: Profile } & (
  | { state: "pending" | "declined" | "timed_out" | "cancelled" }
  | { state: "unavailable"; reason: LinkRequestUnavailable }
);

/** A friend asking you to link, in the game they named on their shelf. */
export type IncomingLinkRequest = { id: string; from: Profile; gameName: string };

/** A link request's id (made by the server). */
export const LINK_REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
