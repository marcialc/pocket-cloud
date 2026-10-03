<p align="center">
  <img src="public/icons/icon-512.png" alt="Pocket Cloud" width="96">
</p>

<h1 align="center">Pocket Cloud</h1>

<p align="center">
  Play your Game Boy, Game Boy Color and Game Boy Advance games in the browser.<br>
  Your saves follow you to every device.
</p>

<p align="center">
  <a href="https://pocketcloud.app"><b>▶ Play at pocketcloud.app</b></a>
</p>

---

## Features

- 🎮 **GB, GBC and GBA** in any modern browser, with no install needed
- ☁️ **Cloud saves**: your progress syncs in the background and works offline
- 📚 **Game library**: pick a ROM once and it stays on the start screen
- 🔗 **Link play**: trade and battle with a friend over an emulated link cable (GBA, signed in)
- 📱 **Keyboard, gamepad or touch**, with keys you can remap
- 🔒 **Private by default**: your ROMs stay on your device unless you choose to keep them in your account

> Pocket Cloud ships no games. Use ROMs dumped from cartridges you own.

## Controls

| Game Boy | Key |
|---|---|
| D-pad | Arrow keys |
| A / B | **Z** / **X** |
| Start / Select | **Enter** / **Shift** |

You can change any key under **Controls**. In most games you confirm with **A**, not Start.

## Run it locally

Requires Node 20+ and pnpm (`corepack enable`).

```bash
pnpm install
cp .dev.vars.example .dev.vars   # sign-in codes print to the terminal
pnpm dev                         # http://localhost:5173
pnpm test
```

## How it works

A React app runs the emulator (binjgb for GB/GBC, mGBA for GBA) in WebAssembly.
A Cloudflare Worker stores saves in Durable Objects and optional ROM backups in R2.

```text
Browser (React + WASM emulator) ──► IndexedDB (local saves + library)
        │
        ▼  /api/*
Cloudflare Worker ──► Durable Objects (saves, accounts, friends)
                  ──► R2 (your ROMs, if you opt in)
                  ──► link-server (GBA link play)
```

## Docs

- [Link server](link-server/README.md): GBA link play

## Found a problem?

[Open an issue](https://github.com/marcialc/pocket-cloud/issues) and tell us what happened,
which browser and device you used, and which game you were playing (if any).

## License

MIT. Emulator cores and other vendored parts keep their own licenses, which are
listed at [pocketcloud.app/licenses](https://pocketcloud.app/licenses).

Game Boy is a trademark of Nintendo. This project is not affiliated with or endorsed by Nintendo.
