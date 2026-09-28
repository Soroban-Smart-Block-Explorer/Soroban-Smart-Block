#!/bin/sh
# Issue #796 — clone <repo> at <commit>, build the contract WASM with the
# pinned toolchain and print its sha256. RUST_VERSION (optional) selects a
# different rustup toolchain.
set -eu

REPO="$1"
COMMIT="$2"

git clone --quiet --filter=blob:none "$REPO" src
cd src
git checkout --quiet --detach "$COMMIT"

if [ -n "${RUST_VERSION:-}" ]; then
  rustup toolchain install "$RUST_VERSION" --profile minimal --target wasm32-unknown-unknown
  rustup override set "$RUST_VERSION"
fi

rustc --version
stellar --version
SOURCE_DATE_EPOCH=0 stellar contract build

WASM=$(find target/wasm32-unknown-unknown/release -maxdepth 1 -name '*.wasm' | sort | head -n 1)
[ -n "$WASM" ] || { echo "no wasm produced" >&2; exit 1; }
echo "WASM_SHA256=$(sha256sum "$WASM" | cut -d' ' -f1)"
