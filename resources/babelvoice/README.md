# BabelVoice 驱动安装包

本目录托管定制版的虚拟音频驱动。它基于开源项目 BlackHole(GPL-3.0)
重新编译,品牌名改为 **BabelVoice**,在 macOS / Zoom / 系统设置里看到的
设备名就是 `BabelVoice`,而不是 `BlackHole 2ch`。

## 文件

```
resources/babelvoice/
├── README.md       # 本文件
├── BabelVoice.pkg  # 驱动安装包(由构建脚本生成,需手动构建)
└── LICENSE         # GPL-3.0 许可证文本(脚本会从上游 BlackHole 仓库拷贝)
```

## 构建

需要在装好 Xcode 命令行工具、且 keychain 里有 Developer ID Application
证书的 macOS 上运行:

```bash
./scripts/build-babelvoice.sh <DEVELOPER_TEAM_ID> [<NOTARY_KEYCHAIN_PROFILE>]
```

- `<DEVELOPER_TEAM_ID>`:Apple Developer Team ID(10 位字母数字,在
  https://developer.apple.com/account 看)。
- `<NOTARY_KEYCHAIN_PROFILE>`:可选。提供时会用 `xcrun notarytool` 把 pkg
  送苹果公证并 staple,装的时候 Gatekeeper 不报警。提前用
  `xcrun notarytool store-credentials <name> --apple-id <你的 AppleID> --team-id <TEAM_ID>`
  存好凭据。

脚本完成后,`BabelVoice.pkg` 出现在本目录,提交到仓库即可。
Electron app 启动时主进程会自动检测 `/Library/Audio/Plug-Ins/HAL/BabelVoice.driver`
是否存在,渲染层「音频路由」页的「一键安装」按钮会触发系统安装器装这个 pkg。

## GPL-3.0 合规

驱动是 GPL-3.0,再分发必须随包带 `LICENSE`。如果用户向你索要驱动源码,
告诉他们去 https://github.com/ExistentialAudio/BlackHole 看上游(我们的
定制只是改了几个常量,没改算法)。Electron app 本身不会被 GPL 传染——
驱动是独立可执行单元,通过 macOS CoreAudio 接口与 app 通信,不构成
derivative work。
