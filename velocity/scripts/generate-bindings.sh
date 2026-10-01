#!/usr/bin/env bash
# Regenerate index.js and index.d.ts from Linux or macOS, exactly as the
# Windows build writes them.
#
# Both files are committed, and the release workflow fails when a Windows build
# would change them. The Linux build (`build:linux`) leaves them alone, so run
# this after changing an export instead of editing them by hand.
#
# napi runs this script in place of cargo: it turns `cargo build` for Windows
# into the type-check from check-windows.sh, which runs the napi macros (and so
# writes the type definitions) without needing MSVC to link.
#
#   rustup target add x86_64-pc-windows-msvc   # once
#   velocity/scripts/generate-bindings.sh
set -euo pipefail
T=x86_64-pc-windows-msvc

if [ -n "${VELOCITY_BINDINGS_AS_CARGO:-}" ]; then
  args=()
  for arg in "$@"; do
    [ "$arg" = build ] && arg=check
    args+=("$arg")
  done
  status=0
  cargo "${args[@]}" \
    --config "target.$T.jpeg.rustc-link-lib=[]" \
    --config "target.$T.ring_core_0_17_14_.rustc-link-lib=[]" || status=$?
  # napi copies the built library next; a check has none, so leave a stand-in.
  mkdir -p "target/wincheck/$T/release"
  touch "target/wincheck/$T/release/velocity.dll"
  exit "$status"
fi

cd "$(dirname "$0")/.."
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
VELOCITY_BINDINGS_AS_CARGO=1 CARGO="$PWD/scripts/generate-bindings.sh" \
  npx napi build --platform --release --target "$T" \
  --target-dir target/wincheck --output-dir "$out"
cp "$out/index.js" "$out/index.d.ts" .
git diff --stat -- index.js index.d.ts
