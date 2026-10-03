## What changed and why

<!-- What a player or developer will notice, and the problem it fixes. -->

## How to test

<!-- Steps a reviewer can follow to see it working, and what they should see. Say which browser and device, system (GB / GBC / GBA) and input (keyboard, gamepad or touch) you tested with, and whether you need to be signed in. Mention any new or changed tests. -->

1.
2.
3.

## Screenshots

<!-- Before and after for anything you can see. A short recording helps for controls and motion. Delete this section if nothing on screen changed. -->

## Checklist

- [ ] `pnpm run typecheck` and `pnpm test` pass
- [ ] Tried it in the browser, not only in tests
- [ ] Updated the matching `public/*.html` page if a feature it describes changed
- [ ] Deploys cleanly: any new secret, R2 bucket or `link-server` change is listed above, with what has to happen before the merge
- [ ] No ROMs or other game files committed

<!-- Merging to main deploys to production. -->
