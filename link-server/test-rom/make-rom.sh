#!/usr/bin/env bash
# Builds linktest.gba from linktest.c with clang and llvm-objcopy.
# Usage: test-rom/make-rom.sh [out.gba]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$here/linktest.gba}"
llvm="${LLVM_BIN:-/opt/homebrew/opt/llvm@22/bin}"
objcopy="$(command -v llvm-objcopy || echo "$llvm/llvm-objcopy")"
objdump="$(command -v llvm-objdump || echo "$llvm/llvm-objdump")"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

clang --target=armv4t-none-eabi -mcpu=arm7tdmi -marm -O2 \
	-ffreestanding -fno-builtin -nostdlib -fno-pic \
	-fno-unwind-tables -fno-asynchronous-unwind-tables \
	-c "$here/linktest.c" -o "$tmp/linktest.o"

# No relocations in .text, so the object's .text is the ROM as-is.
if "$objdump" -r -j .text "$tmp/linktest.o" | grep -q R_ARM; then
	echo "linktest.o has relocations; the raw copy would be wrong" >&2
	exit 1
fi
"$objcopy" -O binary -j .text "$tmp/linktest.o" "$out"
echo "wrote $out ($(wc -c < "$out" | tr -d ' ') bytes)"
