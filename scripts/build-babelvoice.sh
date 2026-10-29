#!/usr/bin/env bash
#
# Build a custom-branded BlackHole driver shipped as "BabelVoice".
#
# Run from repo root:
#   ./scripts/build-babelvoice.sh <DEVELOPER_TEAM_ID> [<NOTARY_KEYCHAIN_PROFILE>]
#
# - DEVELOPER_TEAM_ID:  Apple Developer Team ID (e.g. ABCDE12345). Required.
# - NOTARY_KEYCHAIN_PROFILE:  Optional. If supplied, the produced .pkg is
#   submitted to Apple's notary service via `xcrun notarytool` and stapled
#   on success. Set up beforehand with:
#     xcrun notarytool store-credentials <profile_name> \
#       --apple-id <your-apple-id> --team-id <DEVELOPER_TEAM_ID>
#
# Output: resources/babelvoice/BabelVoice.pkg
#
# Requires: Xcode command-line tools, git, awk.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <DEVELOPER_TEAM_ID> [<NOTARY_KEYCHAIN_PROFILE>]" >&2
  exit 1
fi

TEAM_ID="$1"
NOTARY_PROFILE="${2:-}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$REPO_ROOT/resources/babelvoice"
WORK_DIR="$(mktemp -d -t babelvoice-build)"
trap 'rm -rf "$WORK_DIR"' EXIT

DRIVER_NAME="BabelVoice"
DEVICE_NAME="BabelVoice"           # exactly what shows in Zoom / system audio settings
MANUFACTURER_NAME="ljhao"
BUNDLE_ID="com.ljhao.BabelVoice"
CHANNELS=2

echo "==> Cloning BlackHole source"
git clone --depth 1 https://github.com/ExistentialAudio/BlackHole.git "$WORK_DIR/BlackHole"
cd "$WORK_DIR/BlackHole"

echo "==> Building $DRIVER_NAME (channels=$CHANNELS, bundle=$BUNDLE_ID)"
# Skip signing during build — upstream project pins team ID "Q5C99V536K" which
# we don't have. We'll codesign the produced .driver bundle manually below
# with our Developer ID Application cert.
xcodebuild \
  -project BlackHole.xcodeproj \
  -configuration Release \
  -target BlackHole \
  CONFIGURATION_BUILD_DIR=build \
  PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
  CODE_SIGN_IDENTITY="" \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGNING_ALLOWED=NO \
  DEVELOPMENT_TEAM="" \
  GCC_PREPROCESSOR_DEFINITIONS='$GCC_PREPROCESSOR_DEFINITIONS
    kNumber_Of_Channels='"$CHANNELS"'
    kPlugIn_BundleID=\"'"$BUNDLE_ID"'\"
    kDriver_Name=\"'"$DRIVER_NAME"'\"
    kDevice_Name=\"'"$DEVICE_NAME"'\"
    kManufacturer_Name=\"'"$MANUFACTURER_NAME"'\"' \
  > /dev/null

# Replace the placeholder UUID in Info.plist so this driver doesn't collide
# with the upstream BlackHole's CFBundleIdentifier registry on the same Mac.
NEW_UUID="$(uuidgen)"
PLIST="build/BlackHole.driver/Contents/Info.plist"
awk '{sub(/e395c745-4eea-4d94-bb92-46224221047c/,"'"$NEW_UUID"'")}1' "$PLIST" > "$PLIST.tmp"
mv "$PLIST.tmp" "$PLIST"

# Rename the .driver bundle to BabelVoice.driver
DRIVER_BUNDLE="$DRIVER_NAME.driver"
mkdir -p Installer/root
mv build/BlackHole.driver "Installer/root/$DRIVER_BUNDLE"
rm -rf build

echo "==> Code-signing driver bundle with Developer ID team $TEAM_ID"
codesign \
  --force \
  --deep \
  --options runtime \
  --sign "$TEAM_ID" \
  "Installer/root/$DRIVER_BUNDLE"

echo "==> Creating component package"
# Upstream postinstall hardcodes `BlackHole*ch.driver` in the chown glob;
# rewrite it to our driver name or installation will fail with exit 112.
cat > Installer/Scripts/postinstall <<POST
#!/bin/sh
chown -R root:wheel /Library/Audio/Plug-Ins/HAL/$DRIVER_BUNDLE
POST
chmod 755 Installer/Scripts/preinstall Installer/Scripts/postinstall
pkgbuild \
  --sign "$TEAM_ID" \
  --root Installer/root \
  --scripts Installer/Scripts \
  --install-location /Library/Audio/Plug-Ins/HAL \
  "Installer/$DRIVER_NAME.component.pkg"

VERSION="$(cat VERSION)"

# Replace upstream BlackHole-branded welcome / conclusion screens.
cat > Installer/welcome.html <<'HTML'
<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head><body>
<h1>BabelVoice 虚拟音频驱动</h1>
<p>BabelVoice 是一个 macOS 虚拟音频回环驱动,让 Translator 把生成的英文 TTS
直接送进 Zoom / Teams 等会议软件,作为麦克风输入。</p>
<p><font color="red"><b>注意:某些 macOS 版本上,安装后需要注销重新登录或重启
才能让会议软件看到新的音频设备。</b></font></p>
<h2>说明</h2>
<ul>
  <li>本驱动基于开源项目 BlackHole(GPL-3.0)定制构建。</li>
  <li>与原版 BlackHole 互不冲突,可共存。</li>
  <li>不需要内核扩展,不修改系统安全设置。</li>
  <li>支持 Intel 与 Apple Silicon。</li>
</ul>
</body></html>
HTML

cat > Installer/conclusion.html <<'HTML'
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title></title></head><body>
<h1>BabelVoice 安装完成</h1>
<p>回到 Translator 应用,音频路由页应该自动检测到「已安装」。</p>
<h2>在会议软件里使用</h2>
<p>打开 Zoom / Teams / 飞书等会议软件,把麦克风输入设备改为
<b>BabelVoice</b>,客户就能听到 Translator 生成的英文语音了。</p>
<h2>看不到 BabelVoice 设备?</h2>
<ul>
  <li>退出会议软件再重新打开,刷新设备列表。</li>
  <li>仍然不行的话,注销当前 macOS 用户后重新登录,让 CoreAudio 重新加载驱动。</li>
</ul>
<h2>开源致谢</h2>
<p>本驱动基于 <a href="https://github.com/ExistentialAudio/BlackHole">BlackHole</a>
(GPL-3.0)定制构建。</p>
</body></html>
HTML

DIST_XML="Installer/distribution.xml"
cat > "$DIST_XML" <<XML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>$DEVICE_NAME Audio Driver $VERSION</title>
  <welcome file="welcome.html"/>
  <license file="../LICENSE"/>
  <conclusion file="conclusion.html"/>
  <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
  <pkg-ref id="$BUNDLE_ID"/>
  <options customize="never" require-scripts="false" hostArchitectures="x86_64,arm64"/>
  <volume-check>
    <allowed-os-versions><os-version min="10.10"/></allowed-os-versions>
  </volume-check>
  <choices-outline>
    <line choice="$BUNDLE_ID"/>
  </choices-outline>
  <choice id="$BUNDLE_ID" visible="true" title="$DEVICE_NAME" start_selected="true">
    <pkg-ref id="$BUNDLE_ID"/>
  </choice>
  <pkg-ref id="$BUNDLE_ID" version="$VERSION" onConclusion="RequireRestart">$DRIVER_NAME.component.pkg</pkg-ref>
</installer-gui-script>
XML

echo "==> Building distribution installer"
mkdir -p "$OUT_DIR"
PKG_OUT="$OUT_DIR/$DRIVER_NAME.pkg"
productbuild \
  --sign "$TEAM_ID" \
  --distribution "$DIST_XML" \
  --resources Installer \
  --package-path Installer \
  "$PKG_OUT"

# Always ship the upstream LICENSE alongside (GPL-3.0 redistribution).
cp LICENSE "$OUT_DIR/LICENSE"

if [[ -n "$NOTARY_PROFILE" ]]; then
  echo "==> Notarizing with profile '$NOTARY_PROFILE'"
  xcrun notarytool submit "$PKG_OUT" \
    --team-id "$TEAM_ID" \
    --keychain-profile "$NOTARY_PROFILE" \
    --wait
  echo "==> Stapling"
  xcrun stapler staple "$PKG_OUT"
fi

echo
echo "✅ Done."
echo "   Driver:     /Library/Audio/Plug-Ins/HAL/$DRIVER_BUNDLE (after install)"
echo "   Pkg:        $PKG_OUT"
echo "   Bundle ID:  $BUNDLE_ID"
echo "   Channels:   $CHANNELS"
