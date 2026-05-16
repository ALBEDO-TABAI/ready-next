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

### 3.1 `web_clip_url` / `/clip-current` 入口
- 产物写到 `<outputsRoot>/obsidian-web-clip/<preset.path or output_subdir>/<safe-title>.md`，受 `resolveReadableWithinRoot` 沙箱约束。
- 写入后自动调用 `present_file`，用户在前台能看到附件卡片。
- 笔记包含 `frontmatter` 与正文；`url / title / site / author / published / created / tags` 等字段由 preset properties 渲染。
- 图片在 markdown 里保留为 **remote http(s) URL**——Obsidian 打开时通过网络加载。

### 3.2 `browser:clipDraggedTab`（拖标签到文件管理）入口
拖拽完成后 pipeline 写入沙盒，**紧接着** `materializeToVault` 把笔记**移动**到用户拖入的文件夹：
1. 解析沙盒 .md 里所有 `![](http...)` 引用，并行下载到 `<target>/<noteBaseName>.assets/<8hex>.<ext>`，单图 ≤12MB、超时 20s、按内容 hash 去重。
2. 把 markdown 里的 remote URL 改写为相对路径 `<noteBaseName>.assets/<...>`，**且 URL-encode** 每段（空格 → `%20`、`()'!*` → 百分号编码）。这是预览器兼容性必须步骤——CommonMark 严格解析器在 inline URL 里遇到空格会**截断**链接，导致占位符 ⬜。
3. 写最终 `<target>/<noteBaseName>.md`，`unlink` 沙盒副本（**move 语义，沙盒无残留**）。
4. 失败时（target dir 不存在 / 权限不足 / 等）沙盒文件保留，事件携带 `copyError`；用户看到的还是占位剪藏行 → "剪藏失败"。

**关键**：拖入路径下的 `<noteBaseName>` 经过 `sanitizeFileNameSegment`：所有空格 / `<>:"/\\|?*` / U+0000–U+001F / U+007F 控制字符 → `-`，连续 dash 折叠，首尾 dash 去除。这一步**必须真正生效**——见 §7.1。

## 4. 失败与降级

`web_clip_url` 抛 `ToolDomainError` 时，按下列 `errorKind` 给出可执行建议：

- `clip_fetch_failed` (recoverable) → 重试一次；二次失败提示用户该 URL 抓不到，建议手动 `/clip-current`
- `clip_parse_failed` → 页面无主体内容；建议 `/clip-current`
- `clip_preset_render_failed { reason: 'requires_interpreter' }` → 见 §2 的对话脚本
- `clip_login_required` → "该页面需要登录，请在 BrowserView 内登录后用 `/clip-current`"
- `clip_write_blocked` / `path_outside_outputs` → 内部沙箱错误，向用户报告但不重试
- `clip_active_tab_unstable` → 仅 host-IPC 路径会出现；提示用户保持页面静止后重试

## 5. 抽取链路与 picker（readability ↔ Jina）

两条抽取通道并行跑、最后 `pickRicherMarkdown` 选胜者：

- **Readability（本地，无 JS）**：raw HTTP fetch → `promoteLazyImages` 提升 lazy-load 属性 → `<template>.content` unseal（HTML5 inert 容器） → Readability article → reconciliation 把 DOM 全部图 vs article 图比对，丢失 ≥3 张时以 `<figure>` 形式追加回 article 末尾。
- **Jina r.jina.ai（远端，JS-rendered）**：headless 浏览器渲染。**陷阱**：某些 CMS（典型 RebelMouse）的客户端 JS 把 gallery 图转成 `blob:http://localhost/<hash>` object URL，Jina 把这些 blob 引用直接转录进 markdown——**完全不可下载**。

Picker 规则（已经经历真实案例迭代）：
1. 比较**前**：两路 markdown 各跑一遍 `sanitizeUnfetchableImageRefs`，把 `blob:/data:/javascript:/file:/chrome:` 全部 strip（带真 alt 的转 `_alt_` italic，否则整段删）。这样 blob 不会被算成"图片数"。
2. **readability 抽到 ≥5 张真 http(s) 图时强制胜出**——除非 Jina 真图数 ≥ readability × 2。理由：readability 干净的正文 + 全套图 远好于 Jina 带整页 nav menu 的 dump。
3. 标准信号：图数差 ≥2 取多者；否则
4. 长度 tiebreaker **仅在双方真图都为 0 时生效**，阈值 `jina.length > readability.length × 2`。

防御层 3（即使 picker 选了 Jina）：`materializeToVault` 入口再跑一次 `stripUnfetchableImageRefs`，**保证最终 .md 里没有任何 broken refs**。

## 6. lazy-load CMS 适配（已知模式）

`promoteLazyImages` 覆盖 22 个 lazy-src 属性命名：

- 通用：`data-src` / `data-original` / `data-lazy-src` / `data-image-src` / `data-actualsrc` / `data-hi-res-src` / `data-cms-src` / `data-defer-src` / `data-img-src` / `data-image` / `data-actual-src` / `data-fallback-src` / `data-orig-src` / `data-large` / `data-medium` / `data-image-url`
- **RebelMouse**（PaperMag / Indy100 / OK! Mag / Daily Dot 等几十家媒体）：`data-runner-src`、`data-runner-srcset`
- Flickity / Glide / Splide carousels：`data-flickity-lazyload` / `data-flickity-lazyload-src` / `data-glide-src` / `data-splide-lazy`
- 中文 CMS / WeChat：`data-real-src`
- BBC / Guardian / NYT 内部 CMS：`data-source` / `data-full-src` / `data-zoom-src`

外加 `<picture><source srcset>` 提升、`srcset` 选最大尺寸、`<noscript>` 兜底、HTML5 `<template>` unseal（用 `template.content` 而非 `textContent`——这是 RebelMouse listicle-slideshow 的关键，13/24 张图都藏在 `<template>` 里）。

## 7. 已知陷阱 / 诊断脚本

### 7.1 用户报告"剪藏的 md 全是占位符号"
**最常见根因**：文件名 / `.assets` 目录名里有**空格**，markdown 严格解析器（CommonMark / 多数 preview 库）在 inline URL 第一个空格处截断链接。

诊断步骤：
1. 让用户告诉你保存的 .md 路径，看文件名是否含空格、中文字符之外的可见字符（`-` OK、空格 NOT OK）。
2. 让用户在编辑器里看 .md 的图片引用，是否 `![](Folder Name.assets/x.webp)` 直接含空格——含 = sanitize 失效。
3. 看 `sanitizeFileNameSegment` 测试是否 pass（`npm run typecheck` + clip 测试套件）。
4. **历史教训**：character class regex 曾被一个不可见的 U+0000–U+001F 控制字符 paste 静悄悄破坏，让空格替换不工作。规则现在用 explicit `\x00-\x1f\x7f` hex 范围 + 多阶段 replace 防御。

### 7.2 用户报告"图片数量比页面少很多"
诊断顺序：
1. 直接 `curl -sIL` 一个图片 URL，看 200 还是 4xx。RebelMouse 的 `?id=X&width=Y` query 形态某些站需要更多 transform 参数；带 `&height=&quality=&coordinates=` 完整参数才能 200。
2. 看 `data-runner-src`、`<template>` 解封是否生效——`grep -c data-runner-src raw.html` 与最终 .md 图数对比。
3. **picker 选了哪一路**？如果是 Jina markdown 含大量 `blob:http://localhost/...` → 应当被 sanitize strip + readability 胜出。运行用户 .md 跑 `grep -c "blob:"` 应为 0。

### 7.3 用户报告"剪藏后文件不在拖入的文件夹"
- §3.1 入口（`web_clip_url` / `/clip-current`）的产物永远在 `<outputsRoot>/obsidian-web-clip/`，**不在用户 vault**。建议改用拖拽入口。
- §3.2 入口（drag-to-FileTree）应通过 `materializeToVault` move 到 target dir。如果 .md 没出现，看主进程 log `[obsidian-web-clip] background failed` 行的 `copyError.kind`：`invalid_target`（target_dir 路径不存在/无权限）、`not_a_directory`（dropped on a file, not folder）、`sandbox_read_failed`（沙盒文件被并发删了）。

### 7.4 Jina r.jina.ai 限制
Jina 在以下场景失效或污染输出：
- RebelMouse / 类似 CMS：gallery images → `blob:http://localhost/<hash>`（不可访问）。
- 强反爬站（Cloudflare challenge / hCaptcha）：返回空 / 405 / 触发风控页。
- 长按需登录页：与 readability 一样拿不到内容。
- **不要**因为 Jina markdown "看起来很长"就选它——picker 会比真图数，长度只是 fallback。

## 8. 不在 P1 范围内

- LLM 占位真解释器（P2）
- defuddle + linkedom 抽取器替换（P2，需先有 fixture 快照）
- ~50 个 filter 完整库（P2，目前只支持 `split / first / last / replace / date`）
- 视频站 transcript 接入 video-copy-analyzer（P2）
- dedupe / merge mode（P2）
- 渲染端 "Export to Vault" 同意 UI（P2）

若用户主动问起其中一项，直说："这是 Phase 2 计划。"
