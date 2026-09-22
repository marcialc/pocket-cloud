/**
 * MVP anonymous identity: a random "player key" kept in localStorage and sent
 * as a bearer token. It doubles as a recovery code the player can copy into
 * another browser. Replace this module when real authentication arrives.
 */

const STORAGE_KEY = "pocket-cloud.playerKey";
const KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidPlayerKey(key: string): boolean {
  return KEY_PATTERN.test(key.trim());
}

export function getPlayerKey(): string {
  let key = localStorage.getItem(STORAGE_KEY);
  if (!key || !KEY_PATTERN.test(key)) {
    key = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, key);
  }
  return key;
}

/** Adopts a player key copied from another browser. Returns false if it is malformed. */
export function setPlayerKey(key: string): boolean {
  const trimmed = key.trim().toLowerCase();
  if (!KEY_PATTERN.test(trimmed)) return false;
  localStorage.setItem(STORAGE_KEY, trimmed);
  return true;
}

/**
 * Replaces this browser's anonymous key with a fresh one. Called after email
 * sign-in: the old key's player now belongs to the account and the server
 * refuses the key, so it must not linger here.
 */
export function resetPlayerKey(): void {
  localStorage.setItem(STORAGE_KEY, crypto.randomUUID());
}
