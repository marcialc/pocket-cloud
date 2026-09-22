import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { CODE_ALPHABET, CODE_LENGTH, normalizeEmail } from "../../shared/auth";
import { authErrorMessage, requestSignInCode, verifySignInCode } from "../saves/authApi";

type Props = {
  /** Called after the code is redeemed and the session cookie is set. */
  onSignedIn: (email: string) => Promise<void> | void;
};

const EMPTY = (): string[] => Array.from({ length: CODE_LENGTH }, () => "");

/** Keeps only characters that can appear in a code ("k7qm-4xrp" → "K7QM4XRP"). */
function codeChars(text: string): string[] {
  return [...text.toUpperCase()].filter((ch) => CODE_ALPHABET.includes(ch));
}

/** Email → one-time code sign-in, used by the welcome screen and the account panel. */
export function SignInForm({ onSignedIn }: Props) {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState<string[]>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const [announce, setAnnounce] = useState("");
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const emailInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn(resendIn - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const focusBox = (i: number) => {
    const el = boxes.current[Math.max(0, Math.min(CODE_LENGTH - 1, i))];
    el?.focus();
    el?.select();
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      const message = authErrorMessage(err);
      setError(message);
      setAnnounce(message);
      return false;
    } finally {
      setBusy(false);
    }
    return true;
  };

  const send = (to: string) =>
    run(async () => {
      await requestSignInCode(to);
      setSentTo(to);
      setCode(EMPTY());
      setResendIn(60);
      setAnnounce(`Code sent to ${to}. Enter the ${CODE_LENGTH}-character code.`);
      setTimeout(() => focusBox(0), 0);
    });

  const verify = async (chars: string[]) => {
    if (!sentTo) return;
    setAnnounce("Checking your code");
    const ok = await run(async () => onSignedIn(await verifySignInCode(sentTo, chars.join(""))));
    if (!ok) {
      setCode(EMPTY());
      setTimeout(() => focusBox(0), 0);
    }
  };

  /** Writes characters starting at box `start`, then moves focus / submits when full. */
  const fill = (start: number, chars: string[]) => {
    const next = [...code];
    let i = start;
    for (const ch of chars) {
      if (i >= CODE_LENGTH) break;
      next[i++] = ch;
    }
    setCode(next);
    setError(null);
    if (next.every(Boolean)) void verify(next);
    else focusBox(i);
  };

  const onBoxChange = (i: number, value: string) => {
    const chars = codeChars(value);
    if (chars.length === 0) {
      const next = [...code];
      next[i] = "";
      setCode(next);
      return;
    }
    // One-time-code autofill drops the whole code into the first box.
    fill(i, chars);
  };

  const onBoxKey = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !code[i] && i > 0) {
      e.preventDefault();
      const next = [...code];
      next[i - 1] = "";
      setCode(next);
      focusBox(i - 1);
    } else if (e.key === "ArrowLeft" && i > 0) {
      e.preventDefault();
      focusBox(i - 1);
    } else if (e.key === "ArrowRight" && i < CODE_LENGTH - 1) {
      e.preventDefault();
      focusBox(i + 1);
    }
  };

  const onPaste = (i: number, e: ClipboardEvent<HTMLInputElement>) => {
    const chars = codeChars(e.clipboardData.getData("text"));
    if (!chars.length) return;
    e.preventDefault();
    // A whole code pasted anywhere fills from the start.
    fill(chars.length >= CODE_LENGTH ? 0 : i, chars);
  };

  if (sentTo) {
    return (
      <div className="sign-in enter">
        <div className="sign-in-sent">
          <p id="code-label">
            Enter the {CODE_LENGTH}-character code we sent to <strong>{sentTo}</strong>. It expires in 10 minutes.
          </p>
          <button
            type="button"
            className="link"
            disabled={busy}
            onClick={() => {
              setSentTo(null);
              setError(null);
              setTimeout(() => emailInput.current?.focus(), 0);
            }}
          >
            Change
          </button>
        </div>
        <div className="code-boxes" role="group" aria-labelledby="code-label">
          {code.map((ch, i) => (
            <span key={i} className="code-cell">
              {i === CODE_LENGTH / 2 && <span className="code-dash" aria-hidden />}
              <input
                ref={(el) => {
                  boxes.current[i] = el;
                }}
                className="code-box"
                value={ch}
                onChange={(e) => onBoxChange(i, e.target.value)}
                onKeyDown={(e) => onBoxKey(i, e)}
                onPaste={(e) => onPaste(i, e)}
                onFocus={(e) => e.target.select()}
                disabled={busy}
                inputMode="text"
                autoCapitalize="characters"
                autoComplete={i === 0 ? "one-time-code" : "off"}
                autoCorrect="off"
                spellCheck={false}
                maxLength={CODE_LENGTH + 1}
                aria-label={`Character ${i + 1} of ${CODE_LENGTH}`}
                aria-invalid={error ? true : undefined}
              />
            </span>
          ))}
        </div>
        {busy && <p className="checking px blink">CHECKING…</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <p className="fine">
          Didn’t get it? Check spam, or{" "}
          <button type="button" className="link" disabled={busy || resendIn > 0} onClick={() => void send(sentTo)}>
            {resendIn > 0 ? `send a new code in ${resendIn}s` : "send a new code"}
          </button>
          .
        </p>
        <p className="sr-only" aria-live="polite">
          {announce}
        </p>
      </div>
    );
  }

  return (
    <form
      className="sign-in enter"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const normalized = normalizeEmail(email);
        if (!normalized) {
          setError("Enter an email like name@example.com.");
          return;
        }
        void send(normalized);
      }}
    >
      <label htmlFor="sign-in-email" className="field-label">
        Email address
      </label>
      <input
        id="sign-in-email"
        ref={emailInput}
        className="field"
        type="email"
        value={email}
        onChange={(e) => {
          setEmail(e.target.value);
          setError(null);
        }}
        placeholder="name@example.com"
        autoComplete="email"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "sign-in-error" : undefined}
      />
      {error && (
        <p id="sign-in-error" className="error" role="alert">
          {error}
        </p>
      )}
      <button className="btn primary wide" type="submit" disabled={busy}>
        {busy ? "Sending…" : "Send code"}
      </button>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </form>
  );
}
