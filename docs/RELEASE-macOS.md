# macOS 打包发布

`npm run build:mac` 产出 `dist/BabelVoice-<version>-arm64.dmg`。要让别人下载后直接打开，app 必须用 Developer ID 签名，并通过苹果公证。缺任何一样，Gatekeeper 都会拦下。

平时发版走 GitHub Actions，推一个版本标签就自动签名、公证并发布 Release；本机打包用于调试签名问题或临时出包。

## 发布新版本（GitHub Actions）

```bash
npm version 0.2.0        # 改 package.json 的版本号，提交并打 v0.2.0 标签
git push --follow-tags
```

`.github/workflows/release.yml` 会在 macOS runner 上跑类型检查和测试，然后签名、公证、打 DMG，最后创建 GitHub Release 并上传 DMG，发布说明按提交记录自动生成。整个过程大约 10～20 分钟，进度在仓库的 Actions 页面看。

- 标签和 `package.json` 的版本号不一致时直接失败。
- 标签带 `-`（如 `v0.2.0-beta.1`）会发成预发布（pre-release）。
- 失败了修好后，删掉标签再重打：`git push --delete origin v0.2.0 && git tag -d v0.2.0`。只是偶发错误（比如 `hdiutil` 报错）的话，在 Actions 页面点 Re-run 即可。

### 一次性准备：仓库 Secrets

在本机终端执行（`gh secret set` 会提示你粘贴值，不会留在命令历史里）：

```bash
base64 -i <Developer ID Application 的 .p12 文件> | gh secret set MAC_CERT_P12_BASE64 -R ljhao24/babelvoice
gh secret set MAC_CERT_PASSWORD -R ljhao24/babelvoice              # .p12 的密码
gh secret set APPLE_ID -R ljhao24/babelvoice                       # Apple ID 邮箱
gh secret set APPLE_APP_SPECIFIC_PASSWORD -R ljhao24/babelvoice    # App 专用密码
```

团队 ID `L3BM5CRT8G` 直接写在 workflow 里。Secrets 只在推标签触发的发布任务里使用，别人提的 PR 读不到。

当前的 Developer ID 证书 **2027-02-01 到期**。换新证书后要重新设置 `MAC_CERT_P12_BASE64` 和 `MAC_CERT_PASSWORD`。

## 本机打包

### 一次性准备

1. **Developer ID Application 证书**（团队 `L3BM5CRT8G`）
   - Xcode → 设置 → Accounts → Manage Certificates → + → Developer ID Application，或在 developer.apple.com 的 Certificates 页面创建。只有 Account Holder 能创建，签发机构选 G2 Sub-CA。
   - 已有 .p12 备份的话，双击导入「登录」钥匙串即可。
   - 检查：`security find-identity -v -p codesigning` 的输出里要有 `Developer ID Application: … (L3BM5CRT8G)`。
2. **公证凭据**存进钥匙串。需要先在 account.apple.com → 登录与安全 → App 专用密码 生成一个密码：

   ```bash
   xcrun notarytool store-credentials babelvoice-notary --apple-id <你的 Apple ID> --team-id L3BM5CRT8G
   ```

   这和 `scripts/build-babelvoice.sh` 用的 `<NOTARY_KEYCHAIN_PROFILE>` 是同一种凭据，可以共用。

### 打包

```bash
APPLE_KEYCHAIN_PROFILE=babelvoice-notary npm run build:mac
```

日志里出现 `notarization successful` 才算成功，公证一般要几分钟。签名用的是哪张证书，日志只打 SHA-1，要用下面「发出去之前验证」里的命令确认。

- **没装 Developer ID 证书**：electron-builder 会退而用钥匙串里的其他证书（比如 Apple Development）签名，这样的包只能自己用。这时如果设了 `APPLE_KEYCHAIN_PROFILE`，苹果会拒绝公证，构建直接报错。
- **没设 `APPLE_KEYCHAIN_PROFILE`**：会签名，但跳过公证（日志 `skipped macOS notarization`），别人照样打不开。
- **只想在本机快速试包**：加 `CSC_IDENTITY_AUTO_DISCOVERY=false`，完全不签名。
- **`hdiutil resize` 报 exit code 35**：上次打 DMG 的临时镜像还挂着。用 `hdiutil info` 找到 `t-…/0.dmg` 对应的 `/dev/diskN`，执行 `diskutil eject /dev/diskN` 后重跑。

签名和公证的配置都在 `electron-builder.yml` 的 `mac:` 段。entitlements 在 `packaging/macos/entitlements.mac.plist`，加了新的系统能力（摄像头、Apple Events 等）要同步加进去，否则 hardened runtime 会拦。

### 发出去之前验证

```bash
codesign -dv --verbose=2 dist/mac-arm64/BabelVoice.app
xcrun stapler validate dist/mac-arm64/BabelVoice.app
syspolicy_check distribution dist/mac-arm64/BabelVoice.app
```

- `codesign` 的输出要有 `Authority=Developer ID Application: …`，`flags` 里要有 `runtime`。
- `stapler` 要输出 `The validate action worked!`。
- `syspolicy_check` 要输出 `App passed all pre-distribution checks`。

本机如果关了 Gatekeeper（`spctl --status` 显示 disabled），`spctl -a` 不做评估，一律 `accepted`。所以以上面三条为准。

## 限制

- 只出 Apple Silicon（arm64）包。要支持 Intel，得另外编一份 x64 的原生模块。
- 没有自动更新，发新版只能让用户重新下载安装。
- DMG 文件本身没签名。app 已签名并装订了公证票据，Gatekeeper 检查的是 app，不影响打开。
