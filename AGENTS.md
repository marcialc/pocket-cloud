# Agent notes

## Deploys

This repo is connected to the `pocket-cloud` Cloudflare Worker through
Workers Builds: **every push to `main` triggers a build and deploys to
production.** Treat a push to `main` as a deploy.

- Don't push to `main` unless you've been asked to ship the change.
- Run `pnpm run typecheck` and `pnpm test` before pushing.
- No need to run `pnpm run deploy` after a push; the Git integration does it.
