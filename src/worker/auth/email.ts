import { formatCode } from "../../shared/auth";
import { CODE_TTL_MS } from "../durable-objects/AuthDO";

const FROM = { email: "login@pocketcloud.app", name: "Pocket Cloud" };

/** Sends the sign-in code. The code is from a fixed alphabet, so it needs no escaping. */
export async function sendCodeEmail(env: Env, to: string, code: string): Promise<void> {
  const shown = formatCode(code);
  const minutes = CODE_TTL_MS / 60_000;
  await env.EMAIL.send({
    to,
    from: FROM,
    subject: `Your Pocket Cloud code: ${shown}`,
    text: [
      `Your Pocket Cloud sign-in code is: ${shown}`,
      "",
      `It expires in ${minutes} minutes and can only be used once.`,
      "If you didn't ask for this, you can ignore this email. Nobody can sign in without the code.",
    ].join("\n"),
    html: `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f2f7;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1d1a24">
  <div style="max-width:420px;margin:0 auto;background:#fff;border-radius:12px;padding:28px">
    <p style="margin:0 0 8px;font-size:14px;color:#6b6478">Pocket Cloud</p>
    <h1 style="margin:0 0 20px;font-size:20px">Your sign-in code</h1>
    <p style="margin:0 0 20px;font:700 28px/1 ui-monospace,Menlo,monospace;letter-spacing:4px">${shown}</p>
    <p style="margin:0 0 8px;font-size:14px">It expires in ${minutes} minutes and can only be used once.</p>
    <p style="margin:0;font-size:13px;color:#6b6478">If you didn't ask for this, you can ignore this email. Nobody can sign in without the code.</p>
  </div>
</body></html>`,
  });
}
