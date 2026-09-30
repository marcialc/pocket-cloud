# link-server

The server side of GBA link play: `linkd` runs two GBAs joined by an emulated
link cable, using mGBA's own lockstep link (the code behind the mGBA desktop
app's "New multiplayer window"). It is meant to run in a Cloudflare Container,
one per link session. The plan is in `ideas/gba-multiplayer.md` (local notes,
not committed).

Stage: **working locally, not deployed.** `linkd` runs both GBAs and
streams each screen (and sound) to its player over a WebSocket, taking
button presses back. The `pocket-cloud-link` Worker (`worker/`) gives each
pair of friends a `LinkRoom` Durable Object that starts the container, loads
each player's ROM from their own cloud library plus the save they plugged in
with, passes the WebSockets through, and hands the saves back on unplug. The
pocket-cloud Worker's `/api/link/*` (`src/worker/link.ts`) checks sign-in
and friendship and forwards to it. In the app, GBA games signed in with an
email account get a **Link cable** button (`LinkPanel.tsx`, `GameScreen.tsx`):
plugging in pauses the local game and sends its save, `LinkEmulator.ts` shows
the streamed game and takes the controls, and unplugging (either player, or
the idle timeout) brings the save back into the local game and the cloud.

A link nobody watches ends after `IDLE_MS` (saves kept for pickup), a player
waiting alone is taken out after `WAIT_MS`, and a link that failed (linkd or
the container died, the start hung) is cleared by the next plug or unplug.

```
browser ──/api/link/:friendCode/*──▶ pocket-cloud Worker (sign-in, friends)
                                        │ service binding LINK
                                        ▼
                               pocket-cloud-link Worker
                                        │ one per pair of friends
                                        ▼
                               LinkRoom Durable Object ──▶ container: linkd
                                                           (two GBAs, one cable)
```

## Build and test locally

Needs `cmake`, `git`, `clang`, `llvm-objcopy`/`llvm-objdump` (macOS:
`brew install cmake llvm@22 libpng`) and zlib + libpng.

```sh
link-server/build.sh
```

This fetches mGBA at the commit pinned in `build.sh`, builds it as a static
library (GBA core only), builds `linkd`, and runs the link self-test. The
output goes to `link-server/.build/`.

## Docker

Cloudflare Containers run linux/amd64:

```sh
docker build --platform linux/amd64 -t pocket-cloud-link link-server
```

The image build runs the same self-test and fails if the link doesn't work.

## Playing both sides locally

```sh
link-server/.build/linkd/linkd --listen 8090 --web link-server/web \
  path/to/emerald.gba emerald.sav path/to/firered.gba firered.sav
```

Open http://localhost:8090/, click a screen to control it (arrows, Z = A,
X = B, Enter = Start, Backspace = Select, A = L, S = R). `?players=1` or
`?players=2` shows one player per tab. Ctrl-C writes both saves.

With Docker, mount the ROMs and a saves folder:

```sh
docker run --rm -p 8090:8080 -v /path/emerald.gba:/roms/1.gba:ro \
  -v /path/firered.gba:/roms/2.gba:ro -v "$PWD/saves:/saves" pocket-cloud-link \
  --listen 8080 --web /usr/share/linkd/web /roms/1.gba /saves/1.sav /roms/2.gba /saves/2.sav
```

## The link Worker locally

Needs Docker running. Run it on the app's local state so it sees ROMs
uploaded through the app, next to the app's dev server:

```sh
pnpm wrangler dev -c link-server/worker/wrangler.jsonc --port 8787 --inspector-port 9341 --persist-to .wrangler/state
pnpm dev --host 127.0.0.1
```

(The app's dev server already uses the default inspector port.) To be two
players in one browser, sign one account in on http://localhost:5173 and the
other on http://127.0.0.1:5173: cookies are kept per host. For shorter
timeouts while testing: `--var IDLE_MS:20000 --var CHECK_EVERY_MS:5000`.

The app reaches it over the dev registry through the `LINK` binding. Type
check it with `pnpm exec tsc -p link-server/worker/tsconfig.json` (the root
`pnpm run typecheck` doesn't cover it); after changing its wrangler.jsonc,
`pnpm wrangler types -c link-server/worker/wrangler.jsonc link-server/worker/worker-configuration.d.ts`.

## Running

```sh
linkd [--frames N] [--realtime] [--shots DIR] [--check-linktest] ROM1 SAVE1 ROM2 SAVE2
linkd --listen PORT [--web DIR] ROM1 SAVE1 ROM2 SAVE2
linkd --listen PORT [--web DIR] [--work DIR]      # session mode (the container)
```

The WebSocket protocol (hello, frames as a zlib-compressed XOR against the
previous frame, sound as 16 kHz mu-law, button presses, pings) and session
mode's HTTP control API are described at the top of `src/linkd.c`.

- Player 1 is the parent on the cable, player 2 the child. Each player has
  their own ROM and save; they don't have to be the same game.
- `--realtime` paces each GBA to its real speed (~59.73 fps) instead of
  running flat out.
- `--shots DIR` writes `player1.png` and `player2.png` at the end.
- `--check-linktest` checks the results of `test-rom/linktest.gba`.

## The test ROM

`test-rom/linktest.c` is a few lines of C, built into a 444-byte GBA ROM by
`test-rom/make-rom.sh` with the system clang (no GBA toolchain). In
multiplayer mode it sends a tagged word every frame and records what it
received, so the link can be tested without a commercial game or a save.

## License

mGBA is MPL-2.0. `linkd` links it unmodified; if we ever patch mGBA's files,
the patched files must be published.
