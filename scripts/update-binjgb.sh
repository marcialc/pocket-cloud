#!/usr/bin/env bash
# Refresh the vendored binjgb WebAssembly build from upstream.
#
#   scripts/update-binjgb.sh            # copy upstream's prebuilt docs/binjgb.{js,wasm}
#   scripts/update-binjgb.sh --build    # rebuild from source (requires emsdk / emcmake)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REF="$ROOT/.reference/binjgb"
DEST="$ROOT/public/vendor/binjgb"

if [ ! -d "$REF/.git" ]; then
  git clone https://github.com/binji/binjgb.git "$REF"
else
  git -C "$REF" pull --ff-only
fi

if [ "${1:-}" = "--build" ]; then
  (cd "$REF" && make wasm)
  SRC="$REF/out/Wasm"
  [ -f "$SRC/binjgb.js" ] || SRC="$REF/docs"
else
  SRC="$REF/docs"
fi

mkdir -p "$DEST"
cp "$SRC/binjgb.js" "$SRC/binjgb.wasm" "$DEST/"
cp "$REF/LICENSE" "$DEST/LICENSE"
echo "binjgb updated to $(git -C "$REF" rev-parse HEAD)"
(cd "$DEST" && shasum -a 256 binjgb.js binjgb.wasm)
echo "Update the commit and hashes in $DEST/VENDOR.md."
