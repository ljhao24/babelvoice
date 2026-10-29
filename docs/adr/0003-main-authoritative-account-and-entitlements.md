# ADR-0003: 主进程持有账号与付费 authoritative 状态

## Status

Accepted — 2026-05-04

Superseded — 2026-10-29：账号、Pro 订阅、付费与偏好云同步已整体移除，应用改为
开箱即用、只需用户填入自己的引擎 API Key。本文仅作历史记录保留；完整实现见分支
`backup/with-account-billing`。

## Context

PRD「账号体系与 Pro 订阅」一次性引入四条新的主进程链路:

- **AccountService** —— Apple Sign In、Supabase session 持久化。
- **EntitlementsService** —— license 校验、3 台设备上限、14 天宽限。
- **PreferencesSyncService** —— 登录且 Pro 时跨设备同步偏好。
- **DeepLinkRouter** —— `babelvoice://` 自定义协议回跳。

这些链路都需要 long-lived secrets (Supabase session、refresh token、LemonSqueezy
license_key)、操作系统级资源 (custom protocol、`safeStorage`)、和 authoritative
状态(`isPro` 必须只有一处真值,否则 paywall 与同步会基于过期视图做决定)。

如果让 renderer 直接用 Supabase JS client、或者把 `isPro` 拷贝到 renderer store
并在那里 gate 双向并发,就会重复 ADR-0001 在 SessionStatus 上踩过的坑——多份
authoritative 视图,renderer 自己造转换。

## Decision

**主进程是账号与付费状态的唯一 authoritative 持有者。Renderer 是 thin client。**

具体边界:

1. **Supabase JS client 仅在主进程初始化。** Auth session、access token、
   refresh token 永远不出主进程;renderer 通过 IPC 拿到的只有「我是谁、我是不是
   Pro、我有几台设备」这种已脱敏的视图。

2. **`isPro` 的真值只有一处。** `EntitlementsService.getCurrent()` 返回的
   `Entitlements` 对象;renderer 只持有一份 cached mirror,通过
   `Entitlements.Changed` broadcast 更新,**永远不自己推算**。

3. **Pro 边界的 gate 落在 `SessionRegistry`。** 启动第二个 DirectionSession 时
   做一次 `assertCanStart(direction)` 检查。理由:

   - DirectionSession 是 lifecycle 单元(ADR-0001),并发限制天然属于其上层;
   - TranslationClient 是 provider-agnostic seam(ADR-0002),不应感知账号;
   - 任何其他 gate 位置(renderer-side、IPC-handler-inline)都会让 entitlement
     与 session lifecycle 脱钩,留下绕过缝隙。

4. **Paywall feature flag 读取也落在 main 的 `assertCanStart` 之前。**
   `BABELVOICE_ENFORCE_PAYWALL` 环境变量优先于持久化设置;flag = false 时
   `assertCanStart` 直接放行。这样出 bug 时不发版即可关 Pro 限制。

5. **错误跨 IPC 的传播协议:** main 的 paywall gate 抛 `PaywallRequiredError`
   (类内部定义,带 `reason`);ipc 边界处把它转换为 `Error`,`message =
   "PAYWALL_REQUIRED:<reason>"`。Renderer 用 shared 的 `parsePaywallError()`
   helper 识别(Electron 跨 IPC 仅可靠传递 message,自定义字段会丢——所以只
   能用 message 编码)。

## Consequences

- renderer 永远拿不到 Supabase token,即使 renderer 被 XSS 也不会泄露付费凭据。
- 单点 gate 让任何「绕过 paywall」的尝试都收敛到 `SessionRegistry` 一处审查。
- TranslationClient 实现继续保持纯 provider-agnostic seam (ADR-0002 仍成立)——
  没有任何 provider 代码需要知道 isPro。
- Paywall feature flag 可在 prod 出 bug 时通过 env var 紧急关闭,不依赖热修。
- 后续如果引入 macOS 原生 Apple Sign In sheet 或 In-App Purchase,只需替换
  `AccountService` / `EntitlementsService` 实现,IPC 契约和 gate 位置不变。

## Trade-offs considered

- **Renderer 直接用 Supabase JS client(被否决):** 实现快,但 token 泄露
  面积太大,且偏好同步、license 校验逻辑会同时存在于主进程与 renderer 两处。
- **Gate 落在 ipc-handlers 而不是 SessionRegistry(被否决):** 看起来位置
  类似,但 ipc-handlers 是「IPC 形状的薄适配」,业务规则散落在适配层会让
  非-IPC 入口(未来如内部脚本启动 session)绕过 gate。`SessionRegistry`
  是所有 session 启动的唯一通道,gate 在那里更不容易留缝。

## Update — gate 的调用方(SessionOrchestrator)

`ipc-handlers.ts` 已拆分。`SessionRegistry.assertCanStart` 现在由
`SessionOrchestrator.start()`(`src/main/sessions/session-orchestrator.ts`)
调用;IPC 的 `TranslationStart` 只校验参数后转发给它,会议结束、空闲超时、
退出这些非 IPC 入口也走同一个 orchestrator。orchestrator 不持有会话状态,
`SessionRegistry` 仍是「哪些 session 在运行」的唯一来源,gate 也仍只有这一处。

错误传播协议不变:`PaywallRequiredError` 原样抛到 IPC 边界,renderer 用
`parsePaywallError()` 识别;start 被拒时 orchestrator 负责把 renderer 乐观
显示的 `connecting` 收回(paywall → `idle`,其他原因 → `failed`)。

Checkout(Creem 链接、YunGouOS Edge Function)搬到了
`src/main/account/billing-service.ts`,行为不变。偏好同步的拉取路径改走
`PreferencesService.applyCloud`,与本地编辑共用引擎锁和热键校验(见
ADR-0002 的 Update)。
