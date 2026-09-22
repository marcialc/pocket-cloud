import { useEffect, useState } from "react";
import { normalizeCode, normalizeEmail } from "../../shared/auth";
import { authErrorMessage, fetchAccount, requestSignInCode, signOut, verifySignInCode } from "../saves/authApi";
import { getPlayerKey, isValidPlayerKey, resetPlayerKey, setPlayerKey } from "../saves/identity";
import { clearCloudSyncState } from "../saves/localSaves";

type Props = {
  cloudSync: boolean;
  onCloudSync: (enabled: boolean) => void;
  onDownloadSave: (() => void) | null;
  /** Persist and stop syncing the current game before the identity changes. */
  onBeforeRestore: () => Promise<void>;
  onClose: () => void;
};

export function CloudPanel({ cloudSync, onCloudSync, onDownloadSave, onBeforeRestore, onClose }: Props) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [restoreKey, setRestoreKey] = useState("");
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const key = getPlayerKey();
  // undefined = still checking, null = signed out.
  const [account, setAccount] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    fetchAccount().then((email) => live && setAccount(email));
    return () => {
      live = false;
    };
  }, []);

  /** Identity changed (signed in or out): drop sync state and re-run the launch flow. */
  const switchIdentity = async (change: () => Promise<void> | void) => {
    await onBeforeRestore();
    await change();
    await clearCloudSyncState();
    window.location.reload();
  };

  const copy = async () => {
    await navigator.clipboard.writeText(key);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const restore = async () => {
    if (restoreKey.trim().toLowerCase() === key) return setRestoreError("That is already this browser’s key.");
    if (!isValidPlayerKey(restoreKey)) return setRestoreError("That doesn’t look like a player key.");
    await onBeforeRestore();
    setPlayerKey(restoreKey);
    await clearCloudSyncState();
    // Re-run the launch flow so the restored cloud save is picked up.
    window.location.reload();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="dialog panel" role="dialog" aria-labelledby="cloud-title" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2 id="cloud-title">Saves</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <label className="toggle">
          <input type="checkbox" checked={cloudSync} onChange={(e) => onCloudSync(e.target.checked)} />
          <span>
            <strong>Cloud sync</strong>
            <small>In-game saves are backed up to the cloud a few seconds after you save. Only save data is uploaded — never the ROM.</small>
          </span>
        </label>

        <AccountSection
          account={account}
          onSignedIn={() => switchIdentity(resetPlayerKey)}
          onSignOut={(everywhere) => switchIdentity(() => signOut(everywhere))}
        />

        {account === null && (
          <>
            <section>
              <h3>Your player key</h3>
              <p className="fine">This key is your identity — anyone who has it can load your saves. Use it to continue on another browser.</p>
              <div className="key-row">
                <code>{revealed ? key : "••••••••-••••-••••-••••-" + key.slice(-6)}</code>
                <button className="btn small" onClick={() => setRevealed(!revealed)}>{revealed ? "Hide" : "Show"}</button>
                <button className="btn small" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
              </div>
            </section>

            <section>
              <h3>Restore from another device</h3>
              <div className="key-row">
                <input
                  value={restoreKey}
                  onChange={(e) => {
                    setRestoreKey(e.target.value);
                    setRestoreError(null);
                  }}
                  placeholder="Paste player key"
                  spellCheck={false}
                  autoComplete="off"
                />
                <button className="btn small" onClick={() => void restore()} disabled={!restoreKey.trim()}>Use key</button>
              </div>
              {restoreError && <p className="error">{restoreError}</p>}
              <p className="fine">The page reloads; pick the same ROM and the cloud save is offered.</p>
            </section>
          </>
        )}

        {onDownloadSave && (
          <section>
            <h3>Backup</h3>
            <button className="btn small" onClick={onDownloadSave}>Download .sav file</button>
          </section>
        )}
      </div>
    </div>
  );
}

function AccountSection({
  account,
  onSignedIn,
  onSignOut,
}: {
  account: string | null | undefined;
  onSignedIn: () => Promise<void>;
  onSignOut: (everywhere: boolean) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn(resendIn - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const send = (to: string) =>
    run(async () => {
      await requestSignInCode(to);
      setSentTo(to);
      setCode("");
      setResendIn(60);
    });

  if (account === undefined) {
    return (
      <section>
        <h3>Account</h3>
        <p className="fine">Checking…</p>
      </section>
    );
  }

  if (account) {
    return (
      <section>
        <h3>Account</h3>
        <p className="fine">
          Signed in as <strong>{account}</strong>. Your saves are backed up to this account; sign in with the same email on
          any browser to continue.
        </p>
        <div className="key-row">
          <button className="btn small" disabled={busy} onClick={() => void run(() => onSignOut(false))}>
            Sign out
          </button>
          <button className="link" disabled={busy} onClick={() => void run(() => onSignOut(true))}>
            Sign out on all devices
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>
    );
  }

  if (sentTo) {
    const ready = normalizeCode(code) !== null;
    return (
      <section>
        <h3>Check your email</h3>
        <p className="fine">
          We sent an 8-character code to <strong>{sentTo}</strong>. It expires in 10 minutes.
        </p>
        <form
          className="key-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) void run(async () => {
              await verifySignInCode(sentTo, code);
              await onSignedIn();
            });
          }}
        >
          <input
            className="code-input"
            value={code}
            onChange={(e) => {
              setCode(e.target.value.toUpperCase());
              setError(null);
            }}
            placeholder="XXXX-XXXX"
            maxLength={9}
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            autoFocus
            aria-label="Sign-in code"
          />
          <button className="btn small primary" type="submit" disabled={busy || !ready}>
            Sign in
          </button>
        </form>
        {error && <p className="error">{error}</p>}
        <p className="fine">
          <button className="link" disabled={busy || resendIn > 0} onClick={() => void send(sentTo)}>
            {resendIn > 0 ? `Resend in ${resendIn}s` : "Resend code"}
          </button>
          {" · "}
          <button className="link" disabled={busy} onClick={() => setSentTo(null)}>
            Use a different email
          </button>
        </p>
      </section>
    );
  }

  const valid = normalizeEmail(email) !== null;
  return (
    <section>
      <h3>Back up with email</h3>
      <p className="fine">
        Sign in so your saves survive clearing this browser and follow you to other devices. We email you a code; no
        password.
      </p>
      <form
        className="key-row"
        onSubmit={(e) => {
          e.preventDefault();
          const normalized = normalizeEmail(email);
          if (normalized) void send(normalized);
        }}
      >
        <input
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setError(null);
          }}
          placeholder="you@example.com"
          autoComplete="email"
          aria-label="Email"
        />
        <button className="btn small primary" type="submit" disabled={busy || !valid}>
          {busy ? "Sending…" : "Send code"}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
