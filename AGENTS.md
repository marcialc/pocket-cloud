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
- GBA link play goes through the `LINK` service binding to the separate
  `pocket-cloud-link` Worker (`link-server/`, runs containers). That Worker
  must be deployed before a pocket-cloud deploy that has the binding, or the
  deploy fails. `pnpm test` uses an in-memory stand-in
  (`src/worker/testing/fakeLink.ts`), so it doesn't need Docker.
- The cloud ROM library needs the `pocket-cloud-roms` R2 bucket
  (`pnpm wrangler r2 bucket create pocket-cloud-roms`, once); deploys fail
  while it doesn't exist. Local dev and tests simulate it.
