# ADR-0004: UI 地基 —— Tailwind v4 + React 19 + shadcn（原生 Mac 方向）

## Status

Accepted — 2026-10-21

## Context

UI 要按「A · 原生 Mac」方向整体重做。旧界面的样式分散在三处：Tailwind 工具类
（很少）、`src/renderer/index.css` 里约 2500 行手写组件类、以及 tsx 里 300 多处
inline `style`。交互基础件（Modal、select、radiogroup）也是手写的。

重做要逐页进行，过渡期新旧页面会同时存在，所以地基必须做到：新组件能用，旧页面
外观不变。

## Decision

1. **Tailwind v4（`@tailwindcss/postcss`）+ React 19。** 旧的 `@layer components`
   保留为原生 cascade layer，**没有**采用官方升级工具把它们改成 `@utility` 的做法：
   那样会把旧样式挪进 utilities 层，按 Tailwind 的规则重新排序，可能改变谁覆盖谁。

2. **shadcn `base-nova` 风格，底层用 Base UI（`@base-ui/react`）。** 组件由
   `npx shadcn@latest add <name>` 生成到 `src/renderer/components/ui/`，生成后归我们所有，
   可以直接改。生成文件保留 shadcn 的代码格式，方便以后用 `add --diff` 对比上游。

3. **新 token 用 shadcn 的语义命名**（`--background`、`--primary`、`--muted-foreground`
   ……），外加业务色 `--speak`（你说）和 `--listen`（对方说）。浅色写在 `:root`，
   深色写在 `[data-theme='dark']`；`dark:` 变体同样跟随 `data-theme`
   （`useTheme` 负责写入），不使用 `.dark` 类。

4. **旧 token 改名避免冲突**：`--primary*` → `--brand*`，`--accent*` → `--accent-warm*`。
   其余旧 token（`--bg`、`--fg`、`--line` ……）不冲突，名字不变。

5. **新旧共存规则**：
   - 新代码只用新 token 和 `components/ui`，不再写 `index.css` 组件类、不写 inline 颜色。
   - 一个页面迁完后，删掉它在 `index.css` 里对应的段落，以及只为它保留的旧 token / 工具类。
   - 字幕浮窗（透明窗口、实时刷新）、音频路由页的线路图（`RouteFlow`）、Apple 登录按钮
     继续自定义，不套 shadcn 组件，但颜色改用新 token。
   - Base UI 的弹层（Dialog、Select，以后的 Popover / Menu）自己处理 Esc 和焦点，
     并渲染在 portal 里。它们的根组件通过 `useOverlayLayer` 接入：打开期间在 Esc 栈
     压一个「原生层」（`pushNativeEscapeLayer`：不拦截按键，让 Base UI 自己关，但
     下面的旧弹窗和「Esc 停止翻译」都不会响应），同时让旧 `<Modal>` 的焦点陷阱让位
     （`yieldFocus`），不把焦点从 portal 里抢回来。新增 Base UI 弹层组件时照做。
   - 所有弹层共用一个层级 `--z-overlay`（1300）：Base UI 弹层本来就 portal 到
     `<body>` 末尾，旧 `<Modal>` 也改成 portal 到那里，所以谁后打开谁在上面——旧弹窗
     里开新菜单、新对话框里开旧弹窗（设置里的快捷键录制、从设置弹出的付费墙）都成立。
   - shadcn 生成的组件写的是 `import { cn } from "cn"`，要改成 `@/lib/utils`。那里
     的 `cn` 登记了 macOS 字号 token；不改的话 `text-callout` 会被当成颜色，遇到
     `text-muted-foreground` 就被合并掉。
   - 成组的设置项用 `ListGroup` / `ListRow` / `ListItem`（基于 shadcn Field，Mac 分组
     列表样式），在 `components/grouped-list.tsx`；设置页和会议页都在用。
   - 主窗口每个页面顶部用 `PageToolbar`（`components/page-toolbar.tsx`）：返回按钮、标题和
     状态在左，操作在右，高度对齐隐藏式标题栏，可拖动窗口（按钮和输入框除外）。主窗口的
     页面都已迁完，旧的 `.content` 框架已删除。
   - 「一个下拉框选一项」用 `OptionSelect`（`components/option-select.tsx`）。值为 `''` 的选项
     （系统默认、全部系统声音）是正常选项，不按占位符变灰。
   - 搜索用 `SearchField`（`components/search-field.tsx`）：放大镜代替可见标签（`label` 给
     VoiceOver），有字时出现清除按钮，Esc 先清空、空了才落到「Esc 停止翻译」。每页至多
     一个搜索框开 `findShortcut`，⌘F 聚焦它。
   - 对话行（你 / 对方、原文在上译文在下）只有一个实现 `components/transcript-row.tsx`，
     会议页的实时对话和历史回看共用。
   - 需要用户处理、但不是错误的状态（缺权限、驱动未安装、选中的设备没连接）用 `caution`
     （macOS 橙色）；错误才用 `destructive`。
   - 字号用 macOS 文字样式 token（`text-body` 13px、`text-callout` 12px、
     `text-subheadline` 11px、`text-title3` 15px …），不用 `text-sm` / `text-base`。
     控件默认高 28px（`h-7`），小号 24px。`outline` 按钮即 Mac 的普通按钮，
     底色是 `--control`。
   - 组件效果和这些交互可以在 `npm run dev:web` 的 `/dev/ui-gallery.html` 里看。

6. **交互约定**（设置页重做时定下，之后的页面照此执行）：
   - 不用 `window.alert` / `window.confirm`。破坏性操作（清除密钥、撤销设备）用
     AlertDialog 确认，默认焦点在「取消」；错误在出错的位置用 Alert / FieldError 显示。
   - 改了就生效，和 macOS 一致；列表类编辑（词库）停手后自动保存，离开时也会保存。
     只有需要整体校验的一组输入（单价）才用显式「保存」，且只在有改动、校验通过时可点。
   - 做不了的操作提前禁用并说明原因（例如翻译进行中不能切换服务），而不是点了再报错；
     免费用户看到功能和升级入口，不在聚焦输入框时突然弹付费墙。
   - 没有接通逻辑的控件不放进界面。
   - 每个输入框都要有可见的标签，placeholder 只放示例格式。搜索框是唯一例外（见上）。
   - 列表行的次要操作（重命名、删除）收进行尾的「…」菜单（DropdownMenu），打开对话框的
     菜单项以「…」结尾。

## Consequences

- 旧页面外观不变：迁移前后逐元素对比 computed style，只剩不可见的差异（宽度为 0 的
  边框颜色、原生下拉选项的内边距），以及字幕设置里两个原生滑块的背景从白色变成透明。
- Tailwind v4 去掉了按钮默认的 `cursor: pointer`，没有显式设置 cursor 的按钮现在是
  默认箭头，这本身就是 Mac 原生的行为。
- shadcn 默认尺寸偏网页（按钮 32px、14px 字），组件生成后要按 A 方向的密度改：
  Button、Dialog、Select、Switch、Slider 已经改过，以后新加的组件同样处理。
