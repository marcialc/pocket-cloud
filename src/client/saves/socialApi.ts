import type {
  AcceptInviteResponse,
  AddFriendResponse,
  BoardId,
  FriendsResponse,
  GameLeaderboards,
  GamesResponse,
  InviteResponse,
  MyProfile,
  Profile,
  ProfileResponse,
} from "../../shared/social";

/** The server refused a friends/leaderboard request, with its error code ("network" if it couldn't be reached). */
export class SocialError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Friends and leaderboards need the email session cookie, which the browser sends on its own. */
async function call(path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`/api/social${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init.headers },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new SocialError("network");
  }
  if (!res.ok) {
    const body: { error?: string } = await res.json().catch(() => ({}));
    throw new SocialError(body.error ?? `http_${res.status}`);
  }
  return res;
}

/** This account's profile, or null until it has picked a name. */
export async function fetchProfile(): Promise<MyProfile | null> {
  return ((await (await call("/profile")).json()) as ProfileResponse).profile;
}

export async function saveProfile(name: string): Promise<MyProfile> {
  const res = await call("/profile", { method: "PUT", body: JSON.stringify({ name }) });
  return ((await res.json()) as ProfileResponse).profile!;
}

/** A new invite link; the old one stops working. */
export async function resetInvite(): Promise<MyProfile> {
  return ((await (await call("/profile/invite", { method: "POST" })).json()) as ProfileResponse).profile!;
}

/** Who sent this invite link, or null if it doesn't work (any more). Works signed out. */
export async function fetchInvite(token: string): Promise<Profile | null> {
  try {
    return ((await (await call(`/invites/${encodeURIComponent(token)}`)).json()) as InviteResponse).inviter;
  } catch (err) {
    if (err instanceof SocialError && err.code === "not_found") return null;
    throw err;
  }
}

/** Adds the invite's sender as a friend, straight away. */
export async function acceptInvite(token: string): Promise<Profile> {
  const res = await call(`/invites/${encodeURIComponent(token)}`, { method: "POST" });
  return ((await res.json()) as AcceptInviteResponse).friend;
}

export async function fetchFriends(): Promise<FriendsResponse> {
  return (await call("/friends")).json();
}

export async function addFriend(code: string): Promise<AddFriendResponse> {
  return (await call("/friends", { method: "POST", body: JSON.stringify({ code }) })).json();
}

export async function removeFriend(code: string): Promise<void> {
  await call(`/friends/${encodeURIComponent(code)}`, { method: "DELETE" });
}

/** Leaderboards for every game you or a friend has played, or just `romHash`. */
export async function fetchLeaderboards(romHash?: string): Promise<GameLeaderboards[]> {
  return ((await (await call(romHash ? `/games/${romHash}` : "/games")).json()) as GamesResponse).games;
}

export async function reportScore(romHash: string, board: BoardId, value: number, title: string, keepalive = false): Promise<void> {
  await call(`/scores/${romHash}`, {
    method: "PUT",
    body: JSON.stringify({ board, value, title }),
    ...(keepalive ? { keepalive: true } : {}),
  });
}

export function socialErrorMessage(err: unknown): string {
  switch (err instanceof SocialError ? err.code : "unknown") {
    case "invalid_name":
      return "Pick a name of 1 to 20 characters.";
    case "invalid_code":
      return "Friend codes look like ABCD-EFGH.";
    case "not_found":
      return "Nobody has that friend code. Check it and try again.";
    case "self":
      return "That’s your own code.";
    case "profile_required":
      return "Pick a name first.";
    case "already_friends":
      return "You’re already friends.";
    case "too_many":
      return "You’ve reached the limit of friends or pending requests.";
    case "network":
      return "Can’t reach the server. Check your connection.";
    default:
      return "Something went wrong. Try again.";
  }
}
