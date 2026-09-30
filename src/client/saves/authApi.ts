import type { AccountResponse, AuthErrorResponse } from "../../shared/auth";
import { getPlayerKey } from "./identity";

/** The last account the server confirmed, so a signed-in player stays signed in while offline. */
const ACCOUNT_KEY = "pocket-cloud.account";

function rememberAccount(email: string | null): void {
  if (email) localStorage.setItem(ACCOUNT_KEY, email);
  else localStorage.removeItem(ACCOUNT_KEY);
}

/** A sign-in request the server refused, with its error code. */
export class AuthError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfter?: number,
  ) {
    super(code);
  }
}

async function post(path: string, body: unknown, withKey = false): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`/api/auth${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Only /verify needs it: the server adopts this browser's anonymous saves on first sign-in.
        ...(withKey ? { Authorization: `Bearer ${getPlayerKey()}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new AuthError("network");
  }
  if (!res.ok) {
    const err: Partial<AuthErrorResponse> = await res.json().catch(() => ({}));
    throw new AuthError(err.error ?? `http_${res.status}`, err.retryAfter);
  }
  return res;
}

export async function requestSignInCode(email: string): Promise<void> {
  await post("/request", { email });
}

/** Redeems the code; the server sets the session cookie. Returns the signed-in email. */
export async function verifySignInCode(email: string, code: string): Promise<string> {
  const res = await post("/verify", { email, code }, true);
  const account = ((await res.json()) as AccountResponse).email;
  rememberAccount(account);
  return account;
}

/**
 * The signed-in email, or null when signed out. When the server can't be reached (offline, or
 * down), the account it last confirmed: the player hasn't signed out, and their saves still sync
 * once it's back.
 */
export async function fetchAccount(): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch("/api/auth/me", { signal: AbortSignal.timeout(5_000) });
  } catch {
    return localStorage.getItem(ACCOUNT_KEY);
  }
  if (res.status >= 500) return localStorage.getItem(ACCOUNT_KEY);
  const email = res.ok ? ((await res.json()) as AccountResponse).email : null;
  rememberAccount(email);
  return email;
}

export async function signOut(everywhere: boolean): Promise<void> {
  await post("/logout", { everywhere });
  rememberAccount(null);
}

export function authErrorMessage(err: unknown): string {
  const code = err instanceof AuthError ? err.code : "unknown";
  switch (code) {
    case "invalid_email":
      return "That doesn’t look like an email address.";
    case "invalid_code":
      return "That code isn’t right. Check the email and try again.";
    case "code_expired":
      return "That code has expired. Send a new one.";
    case "too_many_attempts":
      return "Too many wrong tries. Send a new code.";
    case "rate_limited": {
      const wait = err instanceof AuthError && err.retryAfter ? ` in ${formatWait(err.retryAfter)}` : " later";
      return `Too many codes requested. Try again${wait}.`;
    }
    case "email_failed":
      return "We couldn’t send the email. Try again in a minute.";
    case "network":
      return "Can’t reach the server. Check your connection.";
    default:
      return "Something went wrong. Try again.";
  }
}

function formatWait(seconds: number): string {
  return seconds < 90 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`;
}
