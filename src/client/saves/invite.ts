import { INVITE_TOKEN_PATTERN } from "../../shared/social";

/**
 * A friend's invite link (`/?invite=<token>`) the player opened. Kept until
 * they add the friend or dismiss it, so it survives signing in or a reload.
 */
const STORAGE_KEY = "pocket-cloud.invite";

/** Moves an invite in the address bar into storage (and out of the URL); returns the pending invite, if any. */
export function takeInvite(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("invite");
  if (fromUrl !== null) {
    url.searchParams.delete("invite");
    window.history.replaceState(window.history.state, "", url);
    if (INVITE_TOKEN_PATTERN.test(fromUrl)) {
      try {
        localStorage.setItem(STORAGE_KEY, fromUrl);
      } catch {
        return fromUrl;
      }
    }
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored && INVITE_TOKEN_PATTERN.test(stored) ? stored : null;
  } catch {
    return fromUrl && INVITE_TOKEN_PATTERN.test(fromUrl) ? fromUrl : null;
  }
}

export function clearInvite(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored.
  }
}
