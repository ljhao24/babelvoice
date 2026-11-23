# BabelVoice Windows 配置指南

要求：Windows 10 或 Windows 11（64 位）。「只收听某个会议软件」需要 Windows 11 或 Windows 10 build 20348 以上。

## 1. 安装 VB-Cable 虚拟声卡

Windows 不允许应用之间直接传递音频，BabelVoice 借助免费的 [VB-Cable](https://vb-audio.com/Cable/) 把翻译后的语音送进会议软件。

1. 在首次引导第 1 步点「安装」，会打开 VB-Audio 官网；下载 `VBCABLE_Driver_Pack` 压缩包并**解压**。
2. 右键 `VBCABLE_Setup_x64.exe` →「以管理员身份运行」→ 点 **Install Driver**。
3. 安装完成后回到 BabelVoice，几秒内会自动检测到。个别电脑需要重启一次。

装好后系统里会多出两个设备：

| 设备 | 方向 | 用途 |
| --- | --- | --- |
| CABLE Input (VB-Audio Virtual Cable) | 输出 | BabelVoice 把译音播放到这里，**不要**设为系统默认输出 |
| CABLE Output (VB-Audio Virtual Cable) | 输入 | 会议软件把它选作**麦克风** |

## 2. 麦克风权限

打开「设置 → 隐私和安全性 → 麦克风」，确认「麦克风访问权限」和「允许桌面应用访问麦克风」都已打开。Windows 采集会议声音不需要额外授权。

## 3. 在会议里使用

1. 在 Zoom、腾讯会议、飞书、Teams 的音频设置里：**麦克风**选 `CABLE Output (VB-Audio Virtual Cable)`，扬声器照常选耳机或扬声器。
2. BabelVoice 的「设置 → 音频」里，麦克风选你真实的麦克风（不能选 CABLE Output，否则会形成回环）。
3. 「收听来源」：
   - **系统音频**：采集当前默认输出设备上的所有声音。会议软件的扬声器必须是系统默认输出设备。
   - **指定会议软件**：只采集该软件（含其子进程）的声音，不受其他应用干扰，也不要求它用默认输出设备。列表里只出现正在播放或播放过声音的应用。
4. 开始会议后按快捷键（默认 <kbd>Alt</kbd> + <kbd>Space</kbd>）开始/停止翻译你说的话。如果它和其他软件冲突，在设置里改成别的组合键。

## 排错

- **对方听不到译音**：会议软件的麦克风是否选了 CABLE Output；BabelVoice 的「设置 → 音频」诊断里 TTS 路由应显示 `virtual-output:CABLE Input…`。
- **收听没有字幕**：选「系统音频」时，确认会议声音从默认输出设备播放；或者改选「指定会议软件」。
- **提示「系统默认输出设备是虚拟声卡」**：在 Windows 声音设置里把默认输出改回耳机或扬声器。
- 日志位于 `%APPDATA%\babelvoice\logs`。
