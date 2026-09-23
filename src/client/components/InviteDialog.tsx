import { useEffect, useState } from "react";
import { MAX_NAME_LENGTH, normalizeName, type Profile } from "../../shared/social";
import { acceptInvite, fetchInvite, fetchProfile, saveProfile, SocialError, socialErrorMessage } from "../saves/socialApi";
import { Icon } from "./icons";
import { Modal } from "./Modal";
import { SignInForm } from "./SignInForm";

type Props = {
  token: string;
  /** Signed-in email; undefined while checking, null when signed out. */
  account: string | null | undefined;
  onSignedIn: (email: string) => Promise<void>;
  /** Finished or dismissed; `openFriends` when they asked to see the leaderboards. */
  onDone: (openFriends: boolean) => void;
};

type Step =
  | { name: "loading" }
  | { name: "invalid" }
  | { name: "offline" }
  | { name: "ready"; inviter: Profile; needsName: boolean | null }
  | { name: "own"; inviter: Profile }
  | { name: "friends"; inviter: Profile };

/** Someone opened a friend's invite link: sign in if needed, then one tap and you're friends. */
export function InviteDialog({ token, account, onSignedIn, onDone }: Props) {
  const [step, setStep] = useState<Step>({ name: "loading" });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchInvite(token).then(
      (inviter) => live && setStep(inviter ? { name: "ready", inviter, needsName: null } : { name: "invalid" }),
      () => live && setStep({ name: "offline" }),
    );
    return () => {
      live = false;
    };
  }, [token]);

  // Once signed in: does this account still need a name friends see?
  const inviter = step.name === "ready" ? step.inviter : null;
  useEffect(() => {
    if (!account || !inviter) return;
    let live = true;
    fetchProfile().then(
      (profile) => live && setStep({ name: "ready", inviter, needsName: profile === null }),
      () => live && setStep({ name: "offline" }),
    );
    return () => {
      live = false;
    };
  }, [account, inviter]);

  const add = async (who: Profile, needsName: boolean) => {
    const normalized = needsName ? normalizeName(name) : null;
    if (needsName && !normalized) return setError(`Pick a name of 1 to ${MAX_NAME_LENGTH} characters.`);
    setBusy(true);
    setError(null);
    try {
      if (normalized) await saveProfile(normalized);
      await acceptInvite(token);
      setStep({ name: "friends", inviter: who });
    } catch (err) {
      if (err instanceof SocialError && err.code === "self") setStep({ name: "own", inviter: who });
      else if (err instanceof SocialError && err.code === "not_found") setStep({ name: "invalid" });
      else setError(socialErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => onDone(false);

  return (
    <Modal labelledBy="invite-title" onClose={busy ? undefined : dismiss} className="invite">
      {step.name === "loading" && (
        <p id="invite-title" className="px dim-ink blink">
          OPENING INVITE…
        </p>
      )}

      {(step.name === "invalid" || step.name === "offline") && (
        <>
          <h2 id="invite-title">{step.name === "invalid" ? "This invite doesn’t work any more" : "Can’t open the invite"}</h2>
          <p className="muted">
            {step.name === "invalid"
              ? "Your friend may have made a new link. Ask them to send it again."
              : "Can’t reach the server. Check your connection and open the link again."}
          </p>
          <div className="dialog-foot">
            <button type="button" className="btn primary" autoFocus onClick={dismiss}>
              OK
            </button>
          </div>
        </>
      )}

      {step.name === "own" && (
        <>
          <h2 id="invite-title">That’s your own invite link</h2>
          <p className="muted">Send it to a friend. When they open it, you’re friends.</p>
          <div className="dialog-foot">
            <button type="button" className="btn primary" autoFocus onClick={dismiss}>
              OK
            </button>
          </div>
        </>
      )}

      {step.name === "friends" && (
        <>
          <h2 id="invite-title">
            <Icon name="check" size={22} /> You and {step.inviter.name} are friends
          </h2>
          <p className="muted">
            Play the same game as {step.inviter.name} and you’ll see each other on its leaderboard. You won’t need a code
            or link again.
          </p>
          <div className="dialog-foot">
            <button type="button" className="btn" onClick={dismiss}>
              Done
            </button>
            <button type="button" className="btn primary" autoFocus onClick={() => onDone(true)}>
              See leaderboards
            </button>
          </div>
        </>
      )}

      {step.name === "ready" && (
        <>
          <span className="eyebrow px">
            <Icon name="friends" size={16} /> FRIEND INVITE
          </span>
          <h2 id="invite-title">{step.inviter.name} wants to be friends</h2>
          {account === null && (
            <>
              <p className="muted">
                Sign in to add {step.inviter.name}. Then when you play the same game, you share a leaderboard.
              </p>
              <SignInForm onSignedIn={onSignedIn} />
            </>
          )}
          {account && step.needsName === null && <p className="px dim-ink blink">CHECKING…</p>}
          {account && step.needsName !== null && (
            <form
              className="sign-in"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                void add(step.inviter, step.needsName!);
              }}
            >
              {step.needsName && (
                <>
                  <label htmlFor="invite-name" className="field-label">
                    Your name, so {step.inviter.name} knows it’s you
                  </label>
                  <input
                    id="invite-name"
                    className="field"
                    value={name}
                    maxLength={MAX_NAME_LENGTH}
                    autoComplete="nickname"
                    autoFocus
                    onChange={(e) => {
                      setName(e.target.value);
                      setError(null);
                    }}
                    aria-invalid={error ? true : undefined}
                  />
                </>
              )}
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <div className="dialog-foot">
                <button type="button" className="btn" onClick={dismiss} disabled={busy}>
                  Not now
                </button>
                <button type="submit" className="btn primary" disabled={busy} autoFocus={!step.needsName}>
                  {busy ? "Adding…" : `Add ${step.inviter.name}`}
                </button>
              </div>
            </form>
          )}
          {account === null && (
            <button type="button" className="link self-start" onClick={dismiss}>
              Not now
            </button>
          )}
        </>
      )}
    </Modal>
  );
}
