import { Brand, Icon, Ridges } from "./icons";
import { SignInForm } from "./SignInForm";

type Props = {
  onSignedIn: (email: string) => Promise<void>;
  onSkip: () => void;
};

/** First screen for players who aren't signed in: sign in, or play without an account. */
export function WelcomeScreen({ onSignedIn, onSkip }: Props) {
  return (
    <main className="page welcome">
      <header className="page-head">
        <Brand />
      </header>
      <section className="cart-card plastic" aria-labelledby="welcome-title">
        <div className="cart-grip">
          <Ridges />
          <Ridges />
        </div>
        <div className="paper-label">
          <Brand onDark={false} />
          <span className="label-stripes" aria-hidden />
          <p>Handheld classics in your browser</p>
        </div>
        <div className="cart-body">
          <div className="stack-sm">
            <h1 id="welcome-title">Sign in to keep your saves safe</h1>
            <p className="muted">
              Your saves back up to your account and follow you to any browser. We email you a one-time code; no
              password.
            </p>
          </div>
          <SignInForm onSignedIn={onSignedIn} />
          <div className="or" aria-hidden>
            <span>OR</span>
          </div>
          <div className="stack-sm">
            <button type="button" className="btn wide" onClick={onSkip}>
              Continue without signing in
            </button>
            <p className="fine center">Your saves will stay in this browser on this device only.</p>
          </div>
        </div>
        <p className="cart-foot">
          <Icon name="lock" size={16} /> ROM files stay on this device unless you choose to keep them in your account.
        </p>
      </section>
    </main>
  );
}
