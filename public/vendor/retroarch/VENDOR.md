# Vendored: RetroArch Emscripten cores (for Nostalgist)

- Upstream: libretro buildbot stable 1.22.2,
  https://buildbot.libretro.com/stable/1.22.2/emscripten/RetroArch.7z
- Fetched from: https://github.com/arianrhodsandlot/retroarch-emscripten-build
  at commit d03a5b0d642ea638d4d8447960e9796a45fb074e (its `v1.22.2` tag). That
  repo re-packs the buildbot archive per core without modification. These are
  the same files Nostalgist loads from jsDelivr by default.
- Files: `<core>_libretro.js` + `<core>_libretro.wasm`. Nostalgist asks for
  them through `resolveCoreJs` / `resolveCoreWasm`. Each `.wasm` is the whole
  RetroArch frontend statically linked with one libretro core.
- Unmodified. Refresh with `scripts/update-retroarch-cores.sh`, which checks
  the files against the SHA-256 list below and changes nothing on a mismatch.
- Shipped: `mgba` only. `gambatte` was removed because nothing uses it yet
  (Game Boy and Game Boy Color run on binjgb). Its commit and hashes stay below
  so `scripts/update-retroarch-cores.sh gambatte` can re-add it; settle the
  open question under GPL obligations first.

## Exact upstream source (Corresponding Source)

The commits come from the version strings compiled into the binaries
(`strings <core>_libretro.wasm`: RetroArch's "Git Version" value, and each
core's `library_version`), resolved to full hashes on GitHub.

| Component | License | Version string in .wasm | Source commit |
| --- | --- | --- | --- |
| RetroArch (frontend, in every .wasm) | GPL-3.0 (`licenses/RetroArch-COPYING`) | `1.22.2`, git `a609b70` | [libretro/RetroArch@a609b709eb9b5d9a7af89dbf40dd5c673280e636](https://github.com/libretro/RetroArch/tree/a609b709eb9b5d9a7af89dbf40dd5c673280e636) ("Bump to version 1.22.2", 2025-11-17; 23 commits before the `v1.22.2` tag) |
| mgba (GBA, also GB/GBC) | MPL-2.0 (`licenses/mgba-LICENSE`) | `0.11-dev c758314` | [libretro/mgba@c758314a639aa0066e7b65a8341448181b73c804](https://github.com/libretro/mgba/tree/c758314a639aa0066e7b65a8341448181b73c804) |
| gambatte (GB/GBC, not shipped) | GPL-2.0 (`licenses/gambatte-COPYING` once re-added) | `v0.5.0 6924c76` | [libretro/gambatte-libretro@6924c76ba03dadddc6e97fa3660f3d3bc08faa94](https://github.com/libretro/gambatte-libretro/tree/6924c76ba03dadddc6e97fa3660f3d3bc08faa94) |

The license texts in `licenses/` are fetched from those same commits.

## GPL obligations

When we serve these files: keep the license texts next to the binaries, and
point to the Corresponding Source. `public/licenses.html` (linked from the
start screen footer and the Account panel) does this for the shipped cores;
update it when a core is added or changed. If we ever patch or rebuild a core, we must
publish our modified source too. MPL-2.0 (mGBA) only requires its own files'
source to stay available.

**Open question (not resolved):** gambatte's own source headers say "under
the terms of the GNU General Public License version 2 as published by the
Free Software Foundation", with no "or (at your option) any later version"
(e.g. `libgambatte/src/gambatte.cpp` at the commit above, © 2007 Sindre
Aamås). As written that reads as GPL-2.0-only, and the gambatte `.wasm` links
it into GPL-3.0 RetroArch. GPLv2-only and GPLv3 are generally considered
incompatible when combined in one binary. The libretro buildbot distributes
this combination, but that doesn't settle it for us. Get it checked before
shipping gambatte; mGBA (MPL-2.0, GPL-compatible) doesn't have this issue.

## SHA-256

Shipped:

```
08bfc90519bce409a72f206a28b78f02bda913ff7af22c2f36fb6b35734e5456  mgba_libretro.js
3a80ac96ae8e82628ed483e8bb528669b03e7186a2cf90abf89a6d66c3aba6bb  mgba_libretro.wasm
```

Not shipped (for `scripts/update-retroarch-cores.sh gambatte`):

```
57d26f3e54a06b059557d33c8ad701693566c3906716298be85d70a6dc308933  gambatte_libretro.js
607a5978d906f844f10654e50feb3a41ff2ce154f296ed0a98df3ce9d7710809  gambatte_libretro.wasm
```
