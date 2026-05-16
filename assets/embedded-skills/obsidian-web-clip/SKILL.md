---
name: obsidian-web-clip
description: 网页 → Obsidian-compatible Markdown 笔记的方法论 + preset 库；指导何时用 web_clip_url（公共 URL）与 /clip-current（用户主动 clip 当前标签页）。
when-to-use: 用户说"帮我把这篇文章存下来 / 剪藏 / 收藏到 Obsidian / 保存到笔记库 / 做成 Markdown 笔记"，或者提供了一个 URL 希望按 Obsidian Web Clipper 形态落盘
---

# Obsidian Web Clip

## 1. 工具路由

本 skill 不直接执行 clipping，而是指导你选用正确的入口：

| 场景 | 入口 | 谁触发 |
|---|---|---|
| 用户给出一个公共 http(s) URL，想保存它 | `web_clip_url`（model-facing） | 你直接调用 |
| 用户说"clip 当前正在看的页面 / 这一页 / 当前页" | `/clip-current` 斜杠命令 或 BrowserView 工具栏按钮 | **必须由用户触发**——你只能告诉用户怎么用，**不能代调用** |
| 用户给的是登录态站点（小红书 / ChatGPT / B 站登录后） | `/clip-current`（用户先在 BrowserView 内登录并打开页面） | 同上 |
| 用户把浏览器标签拖到文件管理，弹出菜单里选 "网页剪藏" | `browser:clipDraggedTab` host-IPC（fire-and-forget） | **必须由用户触发**——后台执行，不占用 agent 会话 |

**重要**：`browser:clipCurrentTab` 是 host-IPC-only，**没有模型可见的工具名**。如果用户希望 clip 当前正在浏览的页面，请告知用户："请使用斜杠命令 `/clip-current` 或点 BrowserView 上方的 clip 按钮，我无法代你操作当前标签页。" 这是隐私边界（页面可能含登录态、表单、密码），不是技术限制可以绕开。

## 2. Preset 选择

Preset 决定 frontmatter 字段 + 正文 noteContentFormat + 笔记保存路径。`web_clip_url` 默认 `preset=auto`，按 URL host 自动选择；显式传 `preset=<name>` 强制使用。

**P1 默认启用的 deterministic preset**（不包含 LLM 占位，直接渲染）：
- `article-clipper` — 默认 fallback，通用文章
- `b站-clipper` — B 站视频页（iframe 嵌入 + meta-driven）

**P1 暂时禁用、必须等 Phase 2 LLM interpreter 上线后才能用**（自动选择时跳过；显式指定时返 `clip_preset_render_failed { reason: 'requires_interpreter' }`）：
- `youtube-clipper` — tags 字段是 LLM 占位
- `小红书-clipper` — noteContentFormat 整段是 LLM 指令
- `chatgpt-clipper` / `gemini-clipper` / `perplexity-clipper` — tags 字段是 LLM 占位
- `behance-clipper` — tags 字段是 LLM 占位
- `中文网页-clipper` — title / author / tags 三个字段都是 LLM 占位

如用户要求其中之一，直说："这个 preset 依赖 LLM 后处理，目前还在 Phase 2 没上线。我可以用 `article-clipper` 做基本抓取，或者你愿意 `force_render_with_placeholders=true` 让我把 `{{...}}` 原样落到笔记里作为占位 TODO 吗？"

## 3. 输出约定

- 所有产物写到 `<outputsRoot>/obsidian-web-clip/<preset.path or output_subdir>/<safe-title>.md`，受 `resolveReadableWithinRoot` 沙箱约束。
- 写入后自动调用 `present_file`，用户在前台能看到附件卡片。
- 笔记包含 `frontmatter` 与正文；`url / title / site / author / published / created / tags` 等字段由 preset properties 渲染。

## 4. 失败与降级

`web_clip_url` 抛 `ToolDomainError` 时，按下列 `errorKind` 给出可执行建议：

- `clip_fetch_failed` (recoverable) → 重试一次；二次失败提示用户该 URL 抓不到，建议手动 `/clip-current`
- `clip_parse_failed` → 页面无主体内容；建议 `/clip-current`
- `clip_preset_render_failed { reason: 'requires_interpreter' }` → 见 §2 的对话脚本
- `clip_login_required` → "该页面需要登录，请在 BrowserView 内登录后用 `/clip-current`"
- `clip_write_blocked` / `path_outside_outputs` → 内部沙箱错误，向用户报告但不重试
- `clip_active_tab_unstable` → 仅 host-IPC 路径会出现；提示用户保持页面静止后重试

## 5. 不在 P1 范围内

- LLM 占位真解释器（P2）
- defuddle + linkedom 抽取器替换（P2，需先有 fixture 快照）
- ~50 个 filter 完整库（P2，目前只支持 `split / first / last / replace / date`）
- 视频站 transcript 接入 video-copy-analyzer（P2）
- dedupe / merge mode（P2）
- 渲染端 "Export to Vault" 同意 UI（P2）

若用户主动问起其中一项，直说："这是 Phase 2 计划。"
