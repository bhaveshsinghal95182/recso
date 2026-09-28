#!/usr/bin/env bash
# Type-check the Windows build from Linux or macOS.
#
# Catches a change to shared code that breaks the Windows backends, without a
# Windows machine. It only type-checks: ring and mozjpeg have C build scripts
# that need MSVC headers, and nothing is linked, so their build scripts are
# overridden with empty link lists through the `links` keys they declare.
#
#   rustup target add x86_64-pc-windows-msvc   # once
#   velocity/scripts/check-windows.sh
set -euo pipefail
cd "$(dirname "$0")/.."
T=x86_64-pc-windows-msvc
exec cargo check --lib --tests --target "$T" --target-dir target/wincheck \
  --config "target.$T.jpeg.rustc-link-lib=[]" \
  --config "target.$T.ring_core_0_17_14_.rustc-link-lib=[]" "$@"
