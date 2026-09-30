#!/usr/bin/env bash
# Builds linkd: fetches mGBA at a pinned commit, builds it as a static
# library, builds linkd against it, then runs the link self-test (two GBAs
# running test-rom/linktest.gba must see each other's data).
#
# Used both on a dev machine and by the Dockerfile.
# Usage: ./build.sh            (output in .build/, override with WORK_DIR)
set -euo pipefail

# libretro's mGBA at the commit the app's GBA core is built from
# (public/vendor/retroarch/VENDOR.md): snapshots move between the app and the
# link server, and an mGBA only loads snapshots from its own version or older.
MGBA_REPO=https://github.com/libretro/mgba.git
MGBA_COMMIT=c758314a639aa0066e7b65a8341448181b73c804

here="$(cd "$(dirname "$0")" && pwd)"
work="${WORK_DIR:-$here/.build}"
mgba="$work/mgba"
mkdir -p "$work"

if [ ! -d "$mgba/.git" ] || [ "$(git -C "$mgba" rev-parse HEAD)" != "$MGBA_COMMIT" ]; then
	rm -rf "$mgba"
	git init -q "$mgba"
	git -C "$mgba" fetch -q --depth 1 "$MGBA_REPO" "$MGBA_COMMIT"
	git -C "$mgba" checkout -q FETCH_HEAD
fi

# GBA core only, no frontends, no optional libraries beyond zlib and libpng.
cmake -S "$mgba" -B "$mgba/build" -DCMAKE_BUILD_TYPE=Release \
	-DBUILD_STATIC=ON -DBUILD_SHARED=OFF -DBUILD_QT=OFF -DBUILD_SDL=OFF \
	-DBUILD_GL=OFF -DBUILD_GLES2=OFF -DBUILD_GLES3=OFF -DUSE_EPOXY=OFF \
	-DM_CORE_GB=OFF -DUSE_FFMPEG=OFF -DUSE_MINIZIP=OFF -DUSE_LIBZIP=OFF \
	-DUSE_SQLITE3=OFF -DUSE_ELF=OFF -DUSE_LUA=OFF -DUSE_JSON_C=OFF \
	-DUSE_FREETYPE=OFF -DUSE_LZMA=OFF -DUSE_DISCORD_RPC=OFF \
	-DENABLE_SCRIPTING=OFF -DENABLE_DEBUGGERS=OFF -DENABLE_GDB_STUB=OFF \
	-DUSE_EDITLINE=OFF -DBUILD_LTO=OFF > /dev/null
cmake --build "$mgba/build" --parallel

cmake -S "$here" -B "$work/linkd" -DCMAKE_BUILD_TYPE=Release -DMGBA_DIR="$mgba" > /dev/null
cmake --build "$work/linkd"

"$here/test-rom/make-rom.sh" "$work/linktest.gba"
rm -f "$work/selftest-1.sav" "$work/selftest-2.sav"
"$work/linkd/linkd" --frames 300 --check-linktest \
	"$work/linktest.gba" "$work/selftest-1.sav" \
	"$work/linktest.gba" "$work/selftest-2.sav"

echo "built $work/linkd/linkd"
