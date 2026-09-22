/**
 * Email sign-in: shared wire types and input normalisation. The browser uses
 * these for early validation; the Worker applies them again before trusting
 * anything.
 */

/** Uppercase letters and digits without look-alikes (0/O, 1/I/L): 31 symbols. */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 8;
export const MAX_EMAIL_LENGTH = 254;

export type RequestCodeRequest = { email: string };
export type VerifyCodeRequest = { email: string; code: string };
export type AccountResponse = { email: string };
export type LogoutRequest = { everywhere?: boolean };
export type AuthErrorResponse = { error: string; retryAfter?: number };

// Deliberately simple: one @, no spaces, a dot in the domain. Real validation
// is whether the code arrives.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trimmed, lowercased email, or null if it can't be one. */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const email = input.trim().toLowerCase();
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

/** Accepts "k7qm-4xrp", "K7QM 4XRP", etc. Returns the 8 canonical characters, or null. */
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 32) return null;
  const code = input.replace(/[\s-]/g, "").toUpperCase();
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}

/** "K7QM4XRP" → "K7QM-4XRP" for display. */
export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
