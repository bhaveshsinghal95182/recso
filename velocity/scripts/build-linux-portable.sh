#!/usr/bin/env bash
# Build the Linux addon against an old glibc, for an AppImage that runs on
# other people's machines.
#
# A plain `pnpm build:engine:linux` links against the host's glibc. On a
# rolling distro that is whatever shipped last month, and the resulting
# `.node` refuses to load anywhere older ("GLIBC_2.44 not found"). Building
# inside Debian 12 (glibc 2.36) keeps the floor at or below 2.36, which covers
# Debian 12+, Ubuntu 22.04+ (2.35; today's build needs only 2.34), Fedora 36+
# and Mint 21+. Ubuntu 22.04 itself can't build it: its PipeWire 0.3.48
# headers are too old for the `libspa` crate. The release workflow builds in
# the same image.
#
# Needs Docker. Writes velocity/velocity.linux-x64-gnu.node, the same file
# build:engine:linux writes; index.js and index.d.ts are left alone.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
image=recso-velocity-build:bookworm

docker build -t "$image" - <<'EOF'
FROM debian:12
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl build-essential pkg-config clang libclang-dev \
      libpipewire-0.3-dev libspa-0.2-dev libopus-dev libgbm-dev \
    && rm -rf /var/lib/apt/lists/*
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable \
    && chmod -R a+w /opt/cargo /opt/rustup
EOF

# A target dir of its own (named for the image), so artifacts linked against
# another glibc are never mixed in. The registry is cached between runs.
mkdir -p "$here/target/portable-bookworm" "$here/target/portable-registry"
docker run --rm \
  -u "$(id -u):$(id -g)" \
  -v "$here:/src" \
  -v "$here/target/portable-registry:/opt/cargo/registry" \
  -e CARGO_TARGET_DIR=/src/target/portable-bookworm \
  -w /src \
  "$image" \
  cargo build --release --locked

cp "$here/target/portable-bookworm/release/libvelocity.so" "$here/velocity.linux-x64-gnu.node"

floor="$(objdump -T "$here/velocity.linux-x64-gnu.node" | grep -oE 'GLIBC_[0-9.]+' | sort -Vu | tail -1)"
echo "velocity.linux-x64-gnu.node needs at most $floor"
