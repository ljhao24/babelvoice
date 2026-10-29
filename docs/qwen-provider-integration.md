# 需求文档：接入通义千问 qwen3-livetranslate-flash-realtime

## 背景与动机

当前应用仅支持字节跳动 Doubao Seed-LiveInterpret 2.0 作为实时翻译后端。本次迭代新增阿里通义千问 `qwen3-livetranslate-flash-realtime` 作为可选 provider，三个动机并列存在（无单一 must-have）：

1. **图像输入**（Qwen 独有）—— 不是刚需，但在会议场景能让翻译模型"看到" PPT/共享屏幕辅助理解；
2. **多 provider 容灾** —— 网络/服务侧故障时用户可手动切换 provider 重启会话；
3. **质量对比** —— 不同语言对、不同场景下两家模型质量可能有差异，希望支持实测对比。

> **商业层面提醒**：当前凭证硬编码在源码中（开发者承担 API 费用），新增 Qwen 后所有用户的调用费用从一家变成两家，"对比测试"动机会鼓励用户来回切换，**实际账单会上升**。建议合并前估算一次。

---

## 范围

### v1 范围（本次迭代）
- 模型切换 + 音频翻译能力对等
- 测试环境暴露 engine 选择器、生产环境固定单一 engine
- per-engine 参数配置（音色等）

### v1 不做（明确推迟）
- **图像输入**（`input_image_buffer.append`）—— 推迟到 v2，v1 流程跑通后再做
- 自动故障转移（auto failover）
- per-direction 不同 engine（speak/listen 分开选）
- 远程开关默认 engine

---

## 架构决策

### D1. Provider 选择粒度：应用级单一 engine

- 一个全局 `engineId`，speak 和 listen 共用同一个 engine
- **会话进行中（speak/listen 任一活跃）禁止切换 engine**，UI 控件 disabled + tooltip 提示
- 切换由 main 端单例统一执行，避免渲染层多个调用点各自判定

### D2. 数据模型：嵌套 `engineConfigs`

`UserPreferences` 改造：

```ts
interface UserPreferences {
  // ...省略与本次无关的字段
  engineId: EngineId;                    // 'doubao' | 'qwen' | 'mock'
  mySpokenLanguage: SupportedLanguage;   // 保持现状 8 种交集
  meetingLanguage: SupportedLanguage;    // 同上
  engineConfigs: {
    doubao: { speakerVoice: SpeakerVoice; /* 未来：denoise/speechRate/corpus */ };
    qwen:   { voice: QwenVoice };
  };
  // 删除：speakerVoice (顶层)
}
```

- **凭证不进 `UserPreferences`**：沿用 `doubao-credentials.ts` 的硬编码模式，新建 `qwen-credentials.ts` 存 DashScope API Key。
- **语言枚举不扩展**：Qwen 支持的额外语种实际用不到，保持 `SupportedLanguage` 现状（8 种），Qwen 客户端就用这个子集。这里做交集**不冲突**"充分利用各自能力"原则——多余语种对当前用户场景无价值。
- **配置迁移**：旧版 `prefs.speakerVoice` 在 `config-store.ts` 加载时一次性迁移到 `engineConfigs.doubao.speakerVoice`，旧字段删除，**不留 backwards-compat shim**。

### D3. dev / prod gate

| 子项 | 决定 |
|---|---|
| 开关机制 | Vite 构建期常量 `import.meta.env.DEV`；prod 包通过 dead code elimination 移除 engine 选择器 UI |
| 默认 engine 来源 | 源码常量 `PRODUCTION_ENGINE: EngineId = 'doubao'`，写在 `src/shared/engine-types.ts` |
| `prefs.engineId` 在 prod 包的处理 | **生产构建直接忽略此字段**：`getActiveEngineId()` 在 prod 返回常量、dev 返回 `prefs.engineId ?? PRODUCTION_ENGINE`。不做磁盘改写。 |
| Qwen 代码是否出现在 prod 二进制 | **接受**——不做条件构建排除模块。普通用户访问不到，反编译可见也接受。 |

### D4. IPC 与抽象层：main 端 Orchestrator + renderer 真实后端合并

- **新增 `src/main/translation/orchestrator.ts` 单例**：
  - 对外暴露 `start(direction, params) / sendAudio / finish / cancel / setEngineId`
  - 内部维护 `Map<Direction, DoubaoClient | QwenClient>`，按当前 `engineId` 实例化
  - 持有"切换锁"：`setEngineId` 时若 `activeSessions.size > 0` 抛 `engine_locked`
  - **D1 的会话锁在此处单点执行**
- **renderer 端真实后端合并**：
  - `doubao-engine.ts` 重命名为 `realtime-engine.ts`（IPC 包装类）
  - `factory.ts`：`'doubao' | 'qwen'` 都返回 `realtimeEngine`，`'mock'` 仍返回 `mockEngine`
  - 不再为每个 provider 在 renderer 维护一个 class——它们的 IPC 包装代码 99% 重复
- **IPC 通道复用**：`startTranslation` / `sendAudio` / `finishTranslation` / `cancelTranslation` 通道名不变，main 端按 engineId 路由。**不**新增 `qwen:*` 平行通道。
- `mockEngine` 完全不变，仍是 renderer 端纯本地 fake，绕过整个 orchestrator。

---

## 功能不对称处理（D5–D11）

| # | 不对称项 | 处理 |
|---|---|---|
| D5 | **输出音频采样率**：Doubao 可配置（当前 16kHz），Qwen 死锁 24kHz | `AudioPlayer` 把 `sampleRate` 从构造参数提到 `ensureContext(rate)` 参数，每次 speak 会话按当前 engine 输出率重建 `AudioContext`。**Doubao 也升到 24kHz** 统一掉，少一个分支。 |
| D6 | **Qwen 源语言字幕** 默认不返回 | **永远开启** `input_audio_transcription.model: 'qwen3-asr-flash-realtime'`，否则双行字幕 UI 在 Qwen 模式下会少一行。多花的 ASR 费用为 UX 一致性买单。**不**给用户开关。 |
| D7 | **Doubao 专属参数**（`denoise` / `speechRate` / `corpus` 热词） | UI 面板**整段藏在 `engineConfigs.doubao` 区**，Qwen 面板根本不渲染。`StartTranslationParams` 按 engine 收窄为判别联合：`{ engineId: 'doubao', doubaoParams } \| { engineId: 'qwen', qwenParams }`。**不做**"Qwen 模式下 denoise 字段被默默忽略"的隐式行为。 |
| D8 | **PTT 语音克隆**（Doubao `'clone'` voice）切到 Qwen 后丢失 | 在测试包的 engine 选择器旁加一行小字提示"切到 Qwen 后 PTT 输出语音不再保留你的音色"。生产包只有一个 engine 不存在切换问题。**不做**自动迁移、不做能力降级警告弹窗。文档化即可。 |
| D9 | **会话结束语义**：Qwen 没有"立即取消"事件 | Qwen 客户端的 `cancel()` 直接 `WebSocket.close()`（cancel 本意=丢弃剩余输出）；`finish()` 走 `session.finish` + 等 `session.finished` 再 close。语义上对得上 Doubao 的 cancel/finish 区分。**不**为完美计费让 cancel 变成"等服务器吐完已识别的"。 |
| D10 | **Qwen 文本事件分流**（`response.text.text` vs `response.audio_transcript.text` 取决于 modalities） | 适配器内部统一映射到 `translation-subtitle-delta/-final`。`mode: 's2t'` → `modalities: ['text']`、`mode: 's2s'` → `modalities: ['text','audio']`，在适配器里 switch 一下，上层不感知。 |
| D11 | **Qwen 没有 ms 时间戳** | 客户端用 `Date.now() - sessionStartedAt` 合成相对时间戳填进 `startMs/endMs`。**不**把这些字段改成 optional——会让所有下游消费者多一个 `?? 0`。 |

> **事件抽象的关键事实**：现有 `app-store.ts` 直接 `slice.partialSrc = event.text`（覆盖、非 append）。即 `TranslationEvent.delta.text` 已经是"当前完整 partial"语义。Qwen 的 `text + stash` 拼起来当完整 partial 发即可，**事件抽象的形状不需要动**。

---

## 实施拆分（建议每段一个 PR，按序合并）

### PR 1 — 数据模型 + 配置迁移（小，无行为变化）
- `UserPreferences` 删 `speakerVoice`，加 `engineConfigs`
- `config-store.ts` 加一次性迁移：旧 `prefs.speakerVoice` → `engineConfigs.doubao.speakerVoice`
- 新文件 `src/shared/engine-types.ts`：`EngineId`、`PRODUCTION_ENGINE`、`ACTIVE_ENGINES`、`QwenVoice`
- 所有读 `prefs.speakerVoice` 的点改为读嵌套路径
- **验收**：现状走 Doubao 行为完全不变

### PR 2 — main 端 Orchestrator 骨架（中，纯重构）
- 新文件 `src/main/translation/orchestrator.ts`：`start/sendAudio/finish/cancel/setEngineId`，内部 `Map<Direction, Client>`
- 实现切换锁：`activeSessions.size > 0` 时 `setEngineId` 抛 `engine_locked`
- `ipc-handlers.ts` 改为转发到 orchestrator，不再直接 `new DoubaoClient`
- 此阶段 orchestrator 内部只识别 doubao
- **验收**：行为完全等同当前

### PR 3 — renderer engine 收敛（小）
- `doubao-engine.ts` 改名 `realtime-engine.ts`，去掉 'doubao' 字眼
- `factory.ts`：`'doubao' | 'qwen'` 都返回 `realtimeEngine`
- **验收**：Doubao 路径仍跑通

### PR 4 — Qwen 客户端 + 适配（大，核心）
- 新文件 `src/main/translation/qwen-credentials.ts`（硬编码 DashScope API Key）
- 新文件 `src/main/translation/qwen-client.ts`：JSON-over-WS
  - 生命周期：`session.update` → `session.created`/`session.updated` → `input_audio_buffer.append` → 收事件
  - 适配 D6 (ASR 默认开)、D9 (finish/cancel 语义)、D10 (modalities switch)、D11 (合成时间戳)
- orchestrator 加 `case 'qwen'` 分支
- `AudioPlayer` 改 `ensureContext(rate)`；speak 会话按当前 engine 拿 `outputSampleRate`；Doubao 同时升 24kHz (D5)
- `StartTranslationParams` 改判别联合 (D7)
- **验收**：Qwen 端到端跑通，双行字幕、PTT TTS 都正常

### PR 5 — UI gate + per-engine 设置面板（中）
- `SettingsSection` engine 选择器包 `{import.meta.env.DEV && ...}`
- 参数控件按 `engineConfigs[ACTIVE_ENGINE]` 渲染（dev 用 currentEngineId，prod 用常量）
- ControlSection 订阅 orchestrator 的 `activeSessions`，活跃时 engine 选择器 disabled + tooltip
- D8 voice clone 损失提示：engine 选择器旁小字
- **验收**：dev 包能切、prod 包看不到选择器、活跃会话中选择器 disabled

### PR 6 — 收尾
- `EventLog` / `app-store` 在 Qwen 路径下手动跑双行字幕回归
- 更新 `CLAUDE.md`：dev 模式切 engine 步骤 + 生产默认 engine 在哪改
- 估算"加 Qwen 后预期月度账单变化"，决定是否需要在 prod 加调用配额限制

---

## 风险与未决事项

- **账单上升**：见"背景与动机"段末尾。建议 PR 1 之前先估算一次。
- **图像输入 (v2)**：v1 不做，但 `TranslationSession` 接口设计时为未来 `sendImage?(jpg, meta?)` 留可选方法位即可，不引入对应 IPC。
- **Qwen 服务可用性**：DashScope realtime API 的 SLA / 限流策略未在文档贴出，PR 4 联调时实测 QPS 上限和并发上限。
- **`mockEngine` 与 orchestrator 的关系**：mockEngine 仍是 renderer 端独立路径，不进 orchestrator。如果未来要做"对照实验"——同一段音频同时跑 Doubao + Qwen 比对——需要重新设计，不在本次范围。
