import { CODE_ALPHABET, CODE_LENGTH } from "../../shared/auth";

/** A fresh sign-in code from the CSPRNG, uniformly distributed over the alphabet. */
export function generateCode(): string {
  // Rejection sampling: 248 is the largest multiple of 31 below 256, so
  // `byte % 31` has no bias for bytes under it.
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let code = "";
  while (code.length < CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(CODE_LENGTH * 2))) {
      if (byte < limit && code.length < CODE_LENGTH) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    }
  }
  return code;
}

/** Random player id for an account that has no anonymous player to adopt. */
export function randomPlayerId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
}
