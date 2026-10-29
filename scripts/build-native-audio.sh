#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Native audio bridge: skipping non-macOS host"
  exit 0
fi

ARCH="$(uname -m)"
case "$ARCH" in
  arm64) OUT_ARCH="arm64" ;;
  x86_64) OUT_ARCH="x64" ;;
  *) OUT_ARCH="$ARCH" ;;
esac

./node_modules/.bin/node-gyp rebuild

OUT_DIR="resources/native/darwin-$OUT_ARCH"
mkdir -p "$OUT_DIR"

# Electron loads native modules with dlopen(). On recent macOS builds a
# linker-signed .node can still be killed at page validation time after copy,
# so explicitly ad-hoc sign the final artifact we load in dev/package builds.
codesign --force --sign - --timestamp=none "build/Release/babelvoice_native.node"
cp "build/Release/babelvoice_native.node" "$OUT_DIR/babelvoice_native.node"
xattr -d com.apple.quarantine "$OUT_DIR/babelvoice_native.node" 2>/dev/null || true
xattr -d com.apple.provenance "$OUT_DIR/babelvoice_native.node" 2>/dev/null || true
codesign --force --sign - --timestamp=none "$OUT_DIR/babelvoice_native.node"
codesign --verify --verbose=2 "$OUT_DIR/babelvoice_native.node"
echo "Native bridge: copied to $OUT_DIR/babelvoice_native.node"
