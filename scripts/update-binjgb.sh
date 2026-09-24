#!/usr/bin/env bash
# Refresh the vendored binjgb WebAssembly build from upstream.
#
#   scripts/update-binjgb.sh    # rebuild from source (requires emsdk / emcmake)
#
# Always builds from source so the fixes in scripts/binjgb-patches/ are applied;
# upstream's prebuilt docs/binjgb.{js,wasm} don't have them.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REF="$ROOT/.reference/binjgb"
DEST="$ROOT/public/vendor/binjgb"
PATCHES="$ROOT/scripts/binjgb-patches"

if [ ! -d "$REF/.git" ]; then
  git clone https://github.com/binji/binjgb.git "$REF"
else
  # Drop previously applied patches before updating.
  git -C "$REF" checkout -- .
  git -C "$REF" pull --ff-only
fi

for patch in "$PATCHES"/*.patch; do
  git -C "$REF" apply "$patch"
  echo "applied $(basename "$patch")"
done

(cd "$REF" && make wasm)
SRC="$REF/out/Wasm"

mkdir -p "$DEST"
cp "$SRC/binjgb.js" "$SRC/binjgb.wasm" "$DEST/"
cp "$REF/LICENSE" "$DEST/LICENSE"
echo "binjgb updated to $(git -C "$REF" rev-parse HEAD) + patches"
(cd "$DEST" && shasum -a 256 binjgb.js binjgb.wasm)
echo "Update the commit, patches and hashes in $DEST/VENDOR.md."
