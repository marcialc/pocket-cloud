# Agent notes

## Deploys

This repo is connected to the `pocket-cloud` Cloudflare Worker through
Workers Builds: **every push to `main` triggers a build and deploys to
production.** Treat a push to `main` as a deploy.

- Don't push to `main` unless you've been asked to ship the change.
- Run `pnpm run typecheck` and `pnpm test` before pushing.
- No need to run `pnpm run deploy` after a push; the Git integration does it.
- Email sign-in needs the `SESSION_SECRET` Worker secret (32+ characters) in
  production; without it `/api/auth/*` answers 503. Local dev reads it from
  `.dev.vars` (copy `.dev.vars.example`), and codes print to the dev-server
  terminal instead of being emailed.
