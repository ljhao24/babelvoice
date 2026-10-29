# BabelVoice

macOS 上的 AI 实时会议同传。

- **说话**：把你说的话实时翻译成对方的语言，通过 BabelVoice 虚拟音频设备送进会议软件，对方直接听到译音。
- **收听**：把会议里其他人说的话实时翻译成字幕，也可以播放译音给你听。

翻译引擎可选豆包同声传译、通义千问（Qwen）、Gemini、OpenAI，用你自己的 API Key，开箱即用，不需要注册账号。Key 用系统钥匙串加密保存在本机，会议记录也只存在本地。

## 下载安装

到 [Releases](https://github.com/ljhao24/babelvoice/releases) 下载最新的 `BabelVoice-<版本>-arm64.dmg`，拖进「应用程序」即可。安装包已经过 Apple 签名和公证。

要求：Apple 芯片的 Mac，macOS 14 或更新。

首次启动会引导你安装虚拟音频驱动、授权麦克风和屏幕录制、填写 API Key，详见 [`docs/SETUP-macOS.md`](docs/SETUP-macOS.md)。

## 从源码运行

```bash
npm install
npm run dev
```

需要 Xcode 命令行工具（编译原生音频模块）。其他常用命令：

```bash
npm run typecheck
npm test
npm run build:mac   # 打 DMG，签名与发布流程见 docs/RELEASE-macOS.md
```

## 目录结构

```
src/
  main/        # Electron 主进程：会话、翻译引擎客户端、音频路由、IPC
  preload/     # contextBridge
  renderer/    # React UI：控制面板 + 字幕悬浮窗
  core/        # 与平台/UI 无关的纯逻辑
  shared/      # 主进程与渲染进程共享的类型和文案
native/        # macOS 原生音频模块（麦克风、系统音频采集、播放）
protos/        # 豆包同声传译 protobuf 定义
docs/          # 配置指南、发布流程、架构决策（adr/）
```

## 许可证

[GPL-3.0](LICENSE)。随附的 BabelVoice 虚拟音频驱动基于 [BlackHole](https://github.com/ExistentialAudio/BlackHole)（GPL-3.0）。
