#!/usr/bin/env bash
# Refresh the vendored RetroArch Emscripten cores (for Nostalgist) from the
# libretro buildbot stable 1.22.2 release, via Nostalgist's upstream mirror.
#
#   scripts/update-retroarch-cores.sh                 # every known core
#   scripts/update-retroarch-cores.sh gambatte        # just these
#
# buildbot.libretro.com only publishes the whole release as one ~750 MB
# RetroArch.7z, so we fetch the per-core zips from
# arianrhodsandlot/retroarch-emscripten-build, which extracts that archive
# unmodified (the same files Nostalgist loads from jsDelivr by default).
#
# Everything is downloaded into a temp dir and checked against the SHA-256
# list in public/vendor/retroarch/VENDOR.md; public/ is only touched once all
# files pass. To add a core: add it to the tables below and its hashes (and
# upstream commit) to VENDOR.md first.
set -euo pipefail

# v1.22.2 tag of the mirror, pinned by commit because tags can move.
MIRROR_COMMIT="d03a5b0d642ea638d4d8447960e9796a45fb074e"
MIRROR="https://raw.githubusercontent.com/arianrhodsandlot/retroarch-emscripten-build/$MIRROR_COMMIT/retroarch"
# Upstream commits the 1.22.2 buildbot built (version strings inside the .wasm; see VENDOR.md).
RETROARCH_COMMIT="a609b709eb9b5d9a7af89dbf40dd5c673280e636"
RETROARCH_LICENSE="https://raw.githubusercontent.com/libretro/RetroArch/$RETROARCH_COMMIT/COPYING"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/public/vendor/retroarch"
MANIFEST="$DEST/VENDOR.md"

known_cores=(mgba gambatte)
core_license() {
  case "$1" in
    mgba) echo "mgba-LICENSE https://raw.githubusercontent.com/libretro/mgba/c758314a639aa0066e7b65a8341448181b73c804/LICENSE" ;;
    gambatte) echo "gambatte-COPYING https://raw.githubusercontent.com/libretro/gambatte-libretro/6924c76ba03dadddc6e97fa3660f3d3bc08faa94/COPYING" ;;
    *) return 1 ;;
  esac
}

CORES=("$@")
[ ${#CORES[@]} -gt 0 ] || CORES=("${known_cores[@]}")
for core in "${CORES[@]}"; do
  if ! core_license "$core" >/dev/null; then
    echo "Unknown core '$core'. Known: ${known_cores[*]}. Add it to this script and VENDOR.md first." >&2
    exit 1
  fi
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/cores" "$TMP/licenses"

for core in "${CORES[@]}"; do
  curl -fsSL -o "$TMP/$core.zip" "$MIRROR/${core}_libretro.zip"
  unzip -oq "$TMP/$core.zip" "${core}_libretro.js" "${core}_libretro.wasm" -d "$TMP/cores"
  read -r name url < <(core_license "$core")
  curl -fsSL -o "$TMP/licenses/$name" "$url"
done
curl -fsSL -o "$TMP/licenses/RetroArch-COPYING" "$RETROARCH_LICENSE"

# Verify every core file against the hashes recorded in VENDOR.md.
failed=0
for core in "${CORES[@]}"; do
  for file in "${core}_libretro.js" "${core}_libretro.wasm"; do
    expected="$(awk -v f="$file" '$2 == f && length($1) == 64 { print $1 }' "$MANIFEST")"
    actual="$(shasum -a 256 "$TMP/cores/$file" | awk '{ print $1 }')"
    if [ -z "$expected" ]; then
      echo "No SHA-256 for $file in $MANIFEST (got $actual)." >&2
      failed=1
    elif [ "$expected" != "$actual" ]; then
      echo "SHA-256 mismatch for $file: expected $expected, got $actual." >&2
      failed=1
    fi
  done
done
if [ "$failed" -ne 0 ]; then
  echo "Nothing was changed in $DEST." >&2
  exit 1
fi

mkdir -p "$DEST/licenses"
mv -f "$TMP"/cores/* "$DEST/"
mv -f "$TMP"/licenses/* "$DEST/licenses/"
echo "RetroArch cores verified and updated (mirror $MIRROR_COMMIT): ${CORES[*]}"
