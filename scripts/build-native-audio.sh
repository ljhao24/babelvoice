#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

case "$(uname -s)" in
  Darwin) ;;
  MINGW*|MSYS*|CYGWIN*)
    # Windows (Git Bash): WASAPI addon via MSVC. N-API is ABI-stable, so Node
    # headers work for Electron (node-gyp's delay-load hook binds to the host
    # exe). NODE_GYP_DISTURL lets a mirror serve the headers.
    if [[ -n "${NODE_GYP_DISTURL:-}" ]]; then
      ./node_modules/.bin/node-gyp rebuild --disturl="$NODE_GYP_DISTURL"
    else
      ./node_modules/.bin/node-gyp rebuild
    fi
    OUT_DIR="resources/native/win32-x64"
    mkdir -p "$OUT_DIR"
    cp "build/Release/babelvoice_native.node" "$OUT_DIR/babelvoice_native.node"
    echo "Native bridge: copied to $OUT_DIR/babelvoice_native.node"
    exit 0
    ;;
  *)
    echo "Native audio bridge: skipping unsupported host"
    exit 0
    ;;
esac

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
