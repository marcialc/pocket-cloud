# Vendored: binjgb

- Upstream: https://github.com/binji/binjgb
- Commit: c60e138da5a795ebb55e56b11b7e90024e41112c
- Files: `binjgb.js`, `binjgb.wasm` (built from source with `make wasm`,
  Emscripten 6.0.10), `LICENSE` (MIT, Copyright (c) 2016 Ben Smith).
- Patched with `scripts/binjgb-patches/*.patch`:
  - `0001-fix-hang-after-cgb-speed-switch.patch`: the core looped forever
    after a CGB speed switch with the timer running (froze the tab in
    Pokémon Crystal Clear on map transitions).
- Refresh with `scripts/update-binjgb.sh`, which reapplies the patches.
  Don't copy upstream's prebuilt `docs/binjgb.{js,wasm}`; they don't have them.

SHA-256:

```
d2e2a8712cdafb71186d0f18c94b66bf103677084cae8eb7f74c901cb3c838cd  binjgb.js
47366b8a296834f172b34933f191a4e551b9cfb6764e1f95861eaf09b7507480  binjgb.wasm
```
