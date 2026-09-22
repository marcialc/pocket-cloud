# Pocket Cloud — Game Boy games in your browser

A Game Boy / Game Boy Color emulator that runs in the browser. Load ROMs
dumped from cartridges you own; battery saves persist locally and optionally
sync to Cloudflare Durable Objects.

- The emulator ([binjgb](https://github.com/binji/binjgb), WebAssembly) runs
  entirely in your browser.
- **The ROM never leaves your device.** It is read with the File API, hashed
  locally, and (optionally) kept in your browser's IndexedDB as a local game
  library, so a game only has to be picked once. Only battery-save data
  (SRAM, typically 8–32 KiB) is ever uploaded.
- No ROMs, and no game assets, are included in this repository or its deploys.

```text
Browser ── picks local .gb ─► binjgb (WASM) ─► <canvas> + Web Audio
   │                              │ SRAM writes
   │                              ▼
   │                        IndexedDB (per ROM hash)
   │                              │ debounced upload
   ▼                              ▼
Cloudflare Worker  /api/*  ─►  PlayerSaveDO (SQLite, one per player)
   └── static assets (React app, binjgb.js/.wasm)
```

## Quick start

```bash
pnpm install
pnpm dev        # http://localhost:5173 — Vite + Worker + Durable Object locally
pnpm test       # Vitest: client logic (Node + fake-indexeddb) and Worker/DO (workerd)
pnpm build      # typecheck + production build to dist/
pnpm run deploy # build + wrangler deploy (plain `pnpm deploy` is a pnpm built-in)
```

Requires Node 20+ and pnpm 9 (`corepack enable` picks the version from `packageManager`). `pnpm run deploy` needs `pnpm wrangler login` once.

Controls: arrows = D-pad, **Z** = A, **X** = B, **Enter** = Start,
**Shift** = Select. Remap any of them under **Controls** (toolbar, or
"Keyboard controls" on the start screen): click a button, press the key, Esc
cancels; bindings are stored per device and use physical key positions, so
they work on any layout. Touch devices get an on-screen gamepad. The toolbar
has pause/resume, sync now, reset (press twice), fullscreen, mute and volume.

Note that Start (Enter) is not a "confirm" button: in most games' menus and
dialogue you confirm with **A** (Z). Start usually only opens the menu and
advances the title screen, as on the real console. Rebind Start to another key
if Enter feels wrong to you.

## Project layout

```text
src/
  client/                     React app (browser)
    App.tsx                   pick ROM → plan save → play
    emulator/
      GameBoyEmulator.ts      emulator-agnostic interface
      keyBindings.ts          key binding model (defaults, remap, labels)
      BinjgbEmulator.ts       binjgb adapter (frame loop, audio, input, SRAM)
      binjgbModule.ts         loads the vendored Emscripten build
      rom.ts                  header parsing + SHA-256 fingerprint
      controls.ts             keyboard event handling
    saves/
      localSaves.ts           IndexedDB (saves + local ROM library)
      SaveSync.ts             SRAM → IndexedDB → debounced cloud upload
      sync.ts                 pure conflict / scheduling rules
      cloudApi.ts             /api client
      identity.ts             anonymous player key (MVP auth)
    components/               GameScreen, RomPicker, TouchControls, ControlsPanel, …
  shared/api.ts               wire types + base64/hash helpers
  worker/
    index.ts                  API router (only /api/* reaches the Worker)
    identity.ts               resolves the player from the request
    durable-objects/PlayerSaveDO.ts
public/vendor/binjgb/         vendored binjgb.js + binjgb.wasm + LICENSE
scripts/
  update-binjgb.sh            refresh (or rebuild) the vendored emulator
  smoke.mjs                   headless ROM smoke test (Node, no browser)
wrangler.jsonc                Worker, assets, DO binding, migrations
```

## Upstream integration

Two upstream repositories were used; neither is part of this repo's history.
`scripts/update-binjgb.sh` clones binjgb into `.reference/` (gitignored) when
you want to refresh it.

**binjgb (MIT) — vendored build artifact.** binjgb publishes a prebuilt
Emscripten build in its `docs/` folder (used by its own web demo). We vendor
exactly those two files, unmodified, plus its `LICENSE`, into
`public/vendor/binjgb/` (commit and hashes in `VENDOR.md` there). This was
chosen over a submodule or copying C sources because:

- nobody needs Emscripten to build or run the app;
- the JS glue is a classic script exposing a `Binjgb()` factory, so it is
  loaded with a `<script>` tag at runtime (`binjgbModule.ts`) and pointed at
  its `.wasm` via `locateFile` — no bundler tricks;
- upgrading is `scripts/update-binjgb.sh` (or `--build` to compile from
  source with emsdk).

We don't reuse binjgb's demo frontend (Vue, global DOM wiring). The adapter
re-implements the small part we need (frame loop and audio scheduling are
adapted from upstream's `docs/simple.js`) against binjgb's exported C API.

**pret/pokered — reference only.** Nothing from pokered is included. Its
public disassembly was used as documentation (memory map notes for the
future game-state features below).

## Emulator integration (binjgb)

| Concern | How |
|---|---|
| ROM in | `_malloc` a 32 KiB-aligned buffer on the WASM heap, copy bytes, `_emulator_new_simple(ptr, size, sampleRate, 4096, colorCurve)` |
| Video | `_get_frame_buffer_ptr` → 160×144 RGBA; copied into `ImageData` on `EVENT_NEW_FRAME`, drawn to a 160×144 canvas scaled with `image-rendering: pixelated` |
| Timing | `requestAnimationFrame`; each tick runs `_emulator_run_until_f64(ticks)` for the elapsed wall time (capped at 5 frames) at 4 194 304 Hz |
| Audio | on `EVENT_AUDIO_BUFFER_FULL`, 4096 u8 stereo frames → `AudioBuffer` scheduled ~100 ms ahead through a `GainNode` (volume/mute). The context unlocks on first user gesture |
| Input | `_set_joyp_{up,down,…}` via binjgb's default joypad callback |
| SRAM read | `_ext_ram_file_data_new` + `_emulator_write_ext_ram` → copy out |
| SRAM restore | same file-data buffer, copy in, `_emulator_read_ext_ram` (before `start()`) |
| SRAM dirty | `_emulator_was_ext_ram_updated` checked after each run; listeners notified at most once per second |
| Reset | capture SRAM, delete + recreate the core, restore SRAM (like a power cycle) |
| Memory | `_emulator_read_mem(addr)` exposed as `readMemory()` for future game-state extraction |

The rest of the app only sees `GameBoyEmulator`; a different core means a new
adapter class.

### Headless smoke test

```bash
pnpm smoke /path/to/your/game.gb --out smoke-out \
  --script "wait:300 start wait:200 start wait:100 a wait:100 start wait:100 shot:menu"
```

Boots the ROM with the vendored WASM in Node, plays scripted inputs, writes
PNG screenshots and reports frames, audio activity and SRAM changes
(`--sram in.sav` / `--save-sram out.sav` to load/export battery RAM).

### Local game library

ROMs are stored in the `roms` object store (`{ romHash, fileName, title, data,
addedAt, lastPlayedAt }`) when "Keep games in this browser" is on, and listed
newest-played-first on the start screen. Listing reads metadata only; the
bytes are fetched when a game is launched. Removing a game deletes the ROM
(optionally its local save too, never the cloud save). The start screen shows
how much storage the site uses and offers "Keep permanently", which calls
`navigator.storage.persist()` so the browser won't evict ROMs and saves under
disk pressure.

## SRAM persistence

1. The game writes cartridge RAM (usually when you save in-game).
2. `BinjgbEmulator` flags the write; `SaveSync` reads SRAM, SHA-256s it and
   ignores it if unchanged (RAM-enable toggles etc.).
3. A changed SRAM is stored in IndexedDB (`pocket-cloud` DB, `saves` store,
   keyed by ROM hash):

   ```ts
   type LocalGameSave = {
     gameId: string;        // cartridge header title
     romHash: string;       // SHA-256 of the ROM, computed locally
     sram: ArrayBuffer;
     sramHash: string;
     updatedAt: number;     // when this SRAM was produced
     playTime: number;      // ms emulated with this save
     cloud: { revision: number; sramHash: string } | null; // last reconciled cloud state
   };
   ```

4. If cloud sync is on, an upload is scheduled: 4 s after the last write,
   at most 20 s after the first unsynced one, one request in flight, and
   exponential backoff (5 s → 5 min) while offline. Hiding/closing the tab
   flushes immediately (`keepalive`). None of this blocks the frame loop.

**On launch** (after picking a ROM) the app reads the local save and asks
the cloud (3 s timeout; offline → play local) and applies `decideLaunch`:

| Local | Cloud | Result |
|---|---|---|
| none | none | fresh game |
| yes | none | play local, upload |
| none | yes | use cloud |
| same bytes | same bytes | play local |
| unchanged since last sync | moved | use cloud (fast-forward) |
| changed | not moved | play local, upload |
| changed | moved, cloud newer | **ask** |
| changed | moved, local newer | play local, force-upload |
| never synced with this player | differs | **ask** (no common ancestor) |

Uploads carry `baseRevision`; the Durable Object rejects writes based on a
stale revision with `409`, and the client either adopts (same bytes),
force-writes (local is newer and shares history) or asks the player.

## Durable Object: `PlayerSaveDO`

One SQLite-backed object per player, addressed with
`PLAYER_SAVE.getByName("player:" + sha256(playerKey))`. It never runs the
emulator; it is the player's durable memory card. Methods are called over
RPC from the Worker: `listSaves`, `getSave`, `putSave`, `deleteSave`.

```sql
CREATE TABLE game_saves (
  rom_hash    TEXT PRIMARY KEY,  -- SHA-256 of the ROM
  game_id     TEXT NOT NULL,     -- header title
  sram        BLOB NOT NULL,     -- battery RAM (≤ 128 KiB)
  sram_hash   TEXT NOT NULL,
  revision    INTEGER NOT NULL,  -- +1 per accepted write (optimistic concurrency)
  play_time   INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,  -- client time the SRAM was produced
  received_at INTEGER NOT NULL   -- server time of the write
);
-- plus _migrations(version, applied_at); schema changes are appended to MIGRATIONS
```

Wrangler: binding `PLAYER_SAVE`, migration `v1` with
`new_sqlite_classes: ["PlayerSaveDO"]`.

### HTTP API

| Method | Path | |
|---|---|---|
| GET | `/api/health` | no auth |
| GET | `/api/saves` | list save metadata |
| GET | `/api/saves/:romHash` | one save incl. base64 SRAM |
| PUT | `/api/saves/:romHash` | `{ gameId, sram, sramHash, updatedAt, playTime?, baseRevision, force? }` → 200 / 409 `{conflict}` |
| DELETE | `/api/saves/:romHash` | 204 |

All save routes need `Authorization: Bearer <player key>`. The Worker
validates sizes (≤ 128 KiB), hash formats and that `sramHash` matches the
bytes.

## Identity (MVP)

The browser generates a random UUID "player key" (localStorage) and sends it
as a bearer token. The Worker hashes it to pick the Durable Object, so the key
itself is never used as an identifier. The key is the only credential: the
**Saves** panel (click the cloud badge) shows/copies it and lets you paste it
into another browser to restore your saves. Swapping in real auth means
replacing `src/worker/identity.ts` (return an account id) and
`src/client/saves/identity.ts` (send a session instead of the key).

## Deployment

```bash
pnpm wrangler login    # once
pnpm run deploy        # builds and deploys Worker + assets + DO migration
```

`wrangler.jsonc` serves the built React app as static assets with SPA
fallback; only `/api/*` runs the Worker (`run_worker_first`). The first
deploy applies migration `v1`. For later schema changes, add SQL to
`MIGRATIONS` in `PlayerSaveDO.ts` (runs per object on first access); new DO
classes need a new migration tag in `wrangler.jsonc`.

Note: `compatibility_date` is 2026-08-15 because the workerd bundled with
`@cloudflare/vitest-pool-workers` does not support later dates yet; bump it
when that package updates.

## Manual end-to-end checklist

1. Open the site; landing page shows "Load your Game Boy ROM".
2. Choose a ROM with battery saves; the game plays with sound after the
   first key press or click.
3. Start a new game.
4. Save in-game. The badge shows "Saved · syncing soon", then "Saved".
5. Refresh the page.
6. Click the game in the library on the start screen (no file picking).
7. The game offers to continue from your save.
8. Open the Saves panel (cloud badge) → Show key. `curl -H "Authorization: Bearer <key>" https://<your-worker>/api/saves` lists the save.
9. Open the site in a clean browser/profile and load the ROM (fresh game).
10. Saves panel → paste the key → Use key → load the ROM → the game
    continues from the restored save.

Also check: adding a second ROM and switching between them from the library,
removing a game (and the "also delete save" option), remapping a key under
Controls (and that it survives a refresh),
pause/resume, reset (twice), mute/volume, fullscreen, touch
controls on a phone, and airplane mode (badge "Offline · will retry", saves
still persist locally and upload when back online).

## Future extension points

- **Game-state extraction:** `GameBoyEmulator.readMemory()` + a game's
  known memory addresses → a per-game state reader (name, position, money,
  inventory, …), polled after frames. Results can be sent to `PlayerSaveDO`
  as profile/achievement data.
- **Trading / battles:** a `LinkCableDO` or `BattleDO` per session, joined
  over WebSockets by two players. binjgb exposes no serial-port hook in its
  JS API yet, so link-cable emulation needs a small addition to its wrapper
  (serial byte in/out) — the natural next change to the vendored build.
- **Overworld presence:** per-map objects fed by the position reader.
- **Save states:** another table in `PlayerSaveDO` (binjgb already supports
  `_emulator_write_state` / `_emulator_read_state`); large blobs → R2.

## Known limitations

- Browser storage is not a backup: clearing site data removes the local
  library and local saves (cloud saves survive). Very large libraries can hit
  the origin's storage quota.
- Only one emulator instance per page (binjgb's JS wrapper keeps the active
  core in a C global).
- The player key is a bearer secret with no recovery if lost; anyone who has
  it can read/overwrite that player's saves. Fine for an MVP, not for
  production.
- No rate limiting on the API.
- Audio uses scheduled `AudioBufferSource`s (like upstream), not an
  AudioWorklet; very slow devices may crackle.
- Some games write SRAM over several frames; a capture can occasionally land
  mid-save and produce an extra intermediate revision. The final state is
  always captured and uploaded afterwards.
- Emulation pauses when the tab is hidden (browsers throttle
  `requestAnimationFrame`).

## Naming

The repository, npm package and Cloudflare Worker are all `pocket-cloud`.
The browser storage keys (`pocket-cloud` IndexedDB database,
`pocket-cloud.prefs`, `pocket-cloud.playerKey`) intentionally keep their
names: renaming them would orphan every local save, stored ROM and player key
already in someone's browser. Renaming the Worker would likewise strand the
Durable Object storage holding cloud saves, so treat that name as fixed now
that it is deployed.

## Licenses & attribution

- This project: MIT — `LICENSE`.
- binjgb © 2016 Ben Smith, MIT — `public/vendor/binjgb/LICENSE`.
- pret/pokered is used only as documentation/reference; none of its code or
  assets are included.
- Game Boy is a trademark of Nintendo. This project is not affiliated with or
  endorsed by Nintendo and ships no game content. Use ROMs dumped from
  cartridges you own.
