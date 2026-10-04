## What changed and why

<!-- What a player or developer will notice, and the problem it fixes. -->

## How to test

<!-- Test on the preview link, not locally: Workers Builds deploys every PR and comments its "Preview URL" below. Paste it here.
List only the flows a reviewer needs to try, each with what they should see. Say what setup is needed (signed in? two accounts? which system: GB / GBC / GBA? a ROM in the cloud library?) and which browser, device and input (keyboard, gamepad or touch) you tried. Mention any new or changed automated tests. -->

**Preview:** <!-- Preview URL from the Workers Builds comment -->

**Setup:** <!-- e.g. two signed-in accounts that are friends, each with the same GBA ROM in the cloud library -->

1.
2.
3.

## Screenshots

<!-- Before and after for anything you can see. A short recording helps for controls and motion. Delete this section if nothing on screen changed. -->

## Checklist

- [ ] `pnpm run typecheck` and `pnpm test` pass
- [ ] Tried the flows above on the preview link, not only in tests
- [ ] Updated the matching `public/*.html` page if a feature it describes changed
- [ ] Deploys cleanly: any new secret, R2 bucket or `link-server` change is listed above, with what has to happen before the merge
- [ ] No ROMs or other game files committed

<!-- Merging to main deploys to production. -->
