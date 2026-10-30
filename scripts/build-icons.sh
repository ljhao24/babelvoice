#!/usr/bin/env bash
# Regenerates every raster icon from the SVG sources in resources/icons:
#   icon.svg          → icon.png, icon.icns (64 px and up), windows/, icon.ico
#   icon-small.svg    → the 16 and 32 px sizes, where the full art turns to mush
#   trayTemplate.svg  → trayTemplate.png + @2x (macOS menu-bar template image)
# Needs Google Chrome (renders the SVGs) and ImageMagick (resizes, writes .ico).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ICONS="$ROOT/resources/icons"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# render <svg> <png> <css size> [device scale]
render() {
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --default-background-color=00000000 --force-device-scale-factor="${4:-1}" \
    --window-size="$3,$3" --screenshot="$2" "file://$1" >/dev/null 2>&1
}
# resize <src> <dst> <px>
resize() { magick "$1" -filter Lanczos -resize "$3x$3" "$2"; }

render "$ICONS/icon.svg" "$TMP/full.png" 1024
render "$ICONS/icon-small.svg" "$TMP/small.png" 1024
cp "$TMP/full.png" "$ICONS/icon.png"

SET="$ICONS/icon.iconset"
mkdir -p "$SET"
for size in 16 32; do
  resize "$TMP/small.png" "$SET/icon_${size}x${size}.png" "$size"
done
resize "$TMP/small.png" "$SET/icon_16x16@2x.png" 32
resize "$TMP/full.png" "$SET/icon_32x32@2x.png" 64
for size in 128 256 512; do
  resize "$TMP/full.png" "$SET/icon_${size}x${size}.png" "$size"
  resize "$TMP/full.png" "$SET/icon_${size}x${size}@2x.png" $((size * 2))
done
iconutil -c icns "$SET" -o "$ICONS/icon.icns"

mkdir -p "$ICONS/windows"
for size in 16 32; do resize "$TMP/small.png" "$ICONS/windows/icon_$size.png" "$size"; done
for size in 48 64 128 256; do resize "$TMP/full.png" "$ICONS/windows/icon_$size.png" "$size"; done
magick "$ICONS"/windows/icon_{16,32,48,64,128,256}.png "$ICONS/icon.ico"

render "$ICONS/trayTemplate.svg" "$ICONS/trayTemplate.png" 18 1
render "$ICONS/trayTemplate.svg" "$ICONS/trayTemplate@2x.png" 18 2

echo "Icons written to $ICONS"
