---
title: Electron 42 / Chromium 148 升级与 HTML-in-Canvas 支持
date: 2026-06-01
status: validation-complete
owner: 白
executor: Codex
enforce: true
related:
  - AGENTS.md
  - docs/superpowers/testing/2026-05-13-ready-agent-sdk-rebuild-checklist.md
  - docs/superpowers/plans/2026-06-01-browserview-presentation-unification-implementation.md
external_references:
  - https://releases.electronjs.org/
  - https://www.electronjs.org/docs/latest/breaking-changes
  - https://developer.chrome.com/blog/html-in-canvas-origin-trial
  - https://github.com/WICG/html-in-canvas
---

# Electron 42 / Chromium 148 升级与 HTML-in-Canvas 支持

## 0. 完成标准

本目标只有在以下条件都成立时才算完成：

1. Ready 在独立分支上升级到 Electron 42+，运行时 Chromium 为 148，native SQLite ABI 真实通过。
2. Ready 启动时为应用内 WebContents / WebContentsView 提供 HTML-in-Canvas 的 Chromium 实验能力，并有真实 Electron 运行时探针证明当前版本下的可用 API。
3. BrowserView / WebContentsView、文档、RSS、日程、Settings、Agent、Skill、文件、Widget 等主路径没有功能损失。
4. 架构保持最小改动：不引入旧路径兼容分支，不靠文档约束替代运行时探针，不把实验能力伪装成稳定 API。
5. 通过自动测试、native 检查、构建/打包检查、以及产品面模拟人类使用验收。
6. 验收产物、日志、探针输出分批保存，后续可以复查缺口。

## 1. 当前事实

### 1.1 Ready 运行时与构建

- 当前主线基线为 Electron 34，lockfile 中实际安装为 `electron@34.5.8`。
- Electron 34.5.8 对应 Chromium 132、Node 20.19、ABI 132；当前 `npm run native:check` 已证明 `better-sqlite3` 在该 ABI 下可加载。
- 当前包脚本把 native gate 放在 `build` / `verify` 前：`rebuild:native` -> `native:check` -> `typecheck` -> `electron-vite build`。
- `electron-builder.yml` 已配置 `electronDownload.mirror`，但 Electron 42 起 `electron` npm 包改为首次运行时懒下载二进制，升级后必须额外验证下载和缓存路径。
- 当前 Browser host 默认使用 `WebContentsView`，可回退 `BrowserView`；每个 host 显式设置 `nodeIntegration:false`、`contextIsolation:true`、`webSecurity:true`、持久 partition。
- 主窗口显式 `sandbox:false`、`contextIsolation:true`、`nodeIntegration:false`。

### 1.2 浏览器模块现状

- 进入 browser 模式时，原生层必须等待 DOM 动画结束后再显示；这是 Ready 的硬约束。
- 本分支已有 `Fix BrowserView presentation stability` 提交，收口了文档/Widget/本地 HTML 打开浏览器路径，并避免纯切标签时隐藏再显示原生 host。
- 升级前基线已过：
  - `open-webpage-in-browser.test.ts`
  - `browser-sync-visible-host-three-step-contract.test.ts`
  - `browser-mode-startup-resync-contract.test.ts`
  - `browser-tab-switch-visibility-contract.test.ts`
  - `browser-tab-split.test.ts`
  - `npm run native:check`
  - `npm run typecheck`

### 1.3 HTML-in-Canvas 当前外部事实

- WICG/html-in-canvas 不是一个可安装库，而是 Chromium/Blink 实验 Web API。
- Chrome 官方文档说明其 Origin Trial 覆盖 Chrome 148-150；本地测试可用 Chrome Canary 149+ 和 `chrome://flags/#canvas-draw-element`。
- Chromium flag 对应 Finch feature name 为 `CanvasDrawElement`。
- Blink runtime feature 名称为 `CanvasDrawElement`，状态仍是 `test`。
- API 设计要求 canvas 使用 `layoutsubtree`，并在 `paint` 事件里调用 `drawElementImage()`；跨源内容、系统偏好、拼写标记、visited link 等敏感信息不会被绘制。
- 这意味着 Ready 的支持方式应该是“提供能力 + 探针 + 降级说明”，不是把所有 canvas 渲染链立即重写到该 API。

## 2. Electron 34 -> 42 差异预期

### 2.1 版本事实

- Electron 42.3.0 是当前稳定 42 线，Chromium 148.0.7778.180，Node 24.15.0。
- Electron 42.0.0 首发为 Chromium 148.0.7778.96、Node 24.15.0、V8 14.8。
- Ready 目标应锁到 `electron@42.3.0`，避免 `^42` 后续小版本漂移让探针结果不可复查。

### 2.2 高风险差异

1. Native ABI 从 132 升到 146。
   - 影响：`better-sqlite3` 必须重新编译；host Node 下跳过不能算通过。
   - 验证：`npm run verify:native` 必须在 Electron 42 下打印 ABI 146 并成功查询 SQLite。
2. Electron 42 懒下载二进制。
   - 影响：`npm install` 不一定立刻下载 Electron；首次 `electron` 命令可能触发网络下载。
   - 验证：`node -p "require('electron')"` 与 `npm run native:check` 均能启动 Electron。
3. Electron 36 起 `app.commandLine` 会 lower-case switch 和参数。
   - 影响：`--enable-features=CanvasDrawElement` 这类大小写敏感 feature 名可能不能只靠 `app.commandLine.appendSwitch()` 假设成功。
   - 验证：升级后用真实 Electron probe 比较 `appendSwitch('enable-features','CanvasDrawElement')`、`appendSwitch('enable-blink-features','CanvasDrawElement')`、以及必要时的 launch argument 路径。
4. macOS Notification 改用 `UNNotification`。
   - 影响：未签名包的 OS 通知可能触发 `failed`，日程提醒不能只依赖系统通知。
   - Ready 现状：`reminder-notifier` 已先推 renderer capsule，再尝试 OS notification；仍需产品验收日程提醒胶囊和点击进入日程。
5. PDF 不再创建单独 WebContents。
   - 影响：如果 Ready 依赖 PDF 独立 guest WebContents 会出问题。
   - 当前搜索未发现这类依赖；仍需浏览器打开 PDF / 文档 PDF 预览 smoke。
6. WebContentsView / view.setBounds 相关修复和新增动画能力。
   - 影响：可能改善 Ready 原生层切换稳定性，也可能改变 bounds 重复事件节奏。
   - 验证：BrowserView/WebContentsView 切模式、切标签、split、窗口 resize、document/widget/RSS handoff。

### 2.3 中低风险差异

- Offscreen rendering 默认 deviceScaleFactor 改为 1.0；Ready 当前搜索到的 background capture 用隐藏窗口而非 `offscreen:true`，直接风险低，但截图/背景捕获仍要 smoke。
- Renderer 直接访问 `clipboard` 被弃用；当前未发现主路径直接用 Electron renderer clipboard。
- `Session.clearStorageData(options).quotas` 删除；当前未发现 quotas 使用。
- `--host-rules` 弃用；当前未发现使用。
- `desktopCapturer` 系统音频权限要求；当前未发现使用。
- `plugin-crashed`、`webFrame.routingId`、`findFrameByRoutingId`、`NativeImage.getBitmap()` 未发现使用。
- Linux Wayland / GTK 默认变化属于跨平台风险，本轮 Mac 验收不能覆盖，需标记给 Windows/Linux 后续验证。

## 3. 升级策略

### 3.1 依赖升级

最小必要升级：

- `electron`: `42.3.0`
- `@types/node`: `24.12.4`
- `better-sqlite3`: `12.10.0`

配套升级：

- `electron-builder`: `26.8.1`
  - 理由：引入 `@electron/rebuild@^4`，更贴近 Electron 42 / Node 24 native rebuild。
- `electron-vite`: 先评估保留 3.1 是否可用；若 Electron 42 / Node 24 下 build 或 dev 出现工具链问题，再升到 5.0.0。
  - 5.0.0 支持 Vite 6/7，但引入 esbuild 0.25 与 SWC peer，风险高于 builder。
  - 本目标优先保证 runtime 升级，不为了“看起来更新”扩散工具链改动。

### 3.2 HTML-in-Canvas 支持方式

第一阶段只做运行时支持和探针，不改现有产品 UI 渲染路径：

1. 在 Electron 主进程启动早期启用 HTML-in-Canvas 所需 Chromium/Blink feature。
2. 新增一个真实 Electron 探针脚本，在隐藏窗口中检查：
   - `process.versions.electron`
   - `process.versions.chrome`
   - `process.versions.node`
   - `process.versions.modules`
   - `typeof CanvasRenderingContext2D.prototype.drawElementImage`
   - `typeof HTMLCanvasElement.prototype.requestPaint`
   - `'onpaint' in HTMLCanvasElement.prototype`
   - canvas `layoutsubtree` + `drawElementImage` 的最小调用是否成功或抛出何种错误
3. 探针输出 JSON 归档到 `docs/superpowers/audits/2026-06-01-electron42-html-in-canvas/`。
4. 如果 Electron 42 无法通过 `app.commandLine` 启用该 feature，则不得谎称支持；要改用可被 packaged app 稳定继承的启动参数路径，或明确把支持状态降级为“Chromium 148 已具备，但 Electron app 启动参数仍阻塞”。

## 4. 每轮下一步选择规则

1. 如果 native ABI 不过，下一步只修 native rebuild / Electron 下载 / builder 配置。
2. 如果 app 启动不过，下一步只修主进程启动、preload、打包入口。
3. 如果 HTML-in-Canvas 探针不过，下一步先判定是 Electron 版本不含 API、feature 未启用、还是 API 形态变化。
4. 如果浏览器原生层验收不过，下一步优先查 bounds / visibility / WebContentsView 行为，不先改 UI 外观。
5. 如果 Agent 产品面自动矩阵不过，下一步按失败域定位，不扩大到 Electron 无关重构。
6. 如果所有机器验证都过，再进入模拟人类产品面验收；产品面发现卡顿/困惑/功能损失时，回到对应域的最小修复。

## 5. 工作包

### WP1: 依赖升级与 lockfile

- 更新 package 依赖。
- 运行 install，处理 Electron 42 lazy binary download。
- 验证 `require('electron')` 指向 42.3.0。

验收：

- lockfile 中 Electron 为 42.3.0。
- `npm run native:check` 在 Electron 42 下可启动；若 ABI 未重建，进入 WP2。

### WP2: Native ABI 与构建链

- 运行 `npm run verify:native`。
- 必要时升级 builder/rebuild 或修正 mirror / cache。

验收：

- 输出 Electron 42 / Node 24 / ABI 146。
- `better-sqlite3` 查询成功。

### WP3: HTML-in-Canvas feature 与探针

- 在主进程启动早期启用 feature。
- 新增 `scripts/probe-html-in-canvas.cjs` 或等价脚本。
- 探针真实运行 Electron 42 并输出 JSON。

验收：

- 探针能证明当前 Electron 42/Chromium 148 下的 API 状态。
- 若 API 可用，最小 draw/probe 成功；若不可用，报告失败层级并继续寻找可控路径。

### WP4: 自动验证

最低自动验证：

- `npm run native:check`
- `npm run verify:native`
- `npm run typecheck`
- Browser presentation 焦点测试
- `src/__tests__/agent-sdk-product-acceptance.test.ts`
- `npm run build`

有余力或触及面扩大时：

- `npm run test`
- `npm run verify`
- `npm run build:dir`

### WP5: 产品面模拟人类验收

以新 userData 运行 Ready，保留截图/日志/探针证据，至少覆盖：

1. 启动、主界面、模式切换：document/browser/rss/calendar/settings。
2. 浏览器：新建标签、搜索/打开网页、切标签、split、resize、RSS/文档/Widget 打开到浏览器、下载/复制/导航基础行为。
3. HTML-in-Canvas：在 Ready 内 Browser host 打开本地 probe 页面，确认页面显示 API 状态；如支持，确认 canvas 中真实绘制结果。
4. 文档/Widget：打开文档，点链接进浏览器，Widget 渲染/更新不白屏。
5. RSS：打开源、进入预览、handoff 到 browser。
6. Calendar：打开日程，创建/更新一条测试事件；提醒 capsule 不因 OS notification 失败而缺失。
7. Agent：运行 agent-sdk product acceptance；在产品面用当前模型配置发起一个浏览器/文档/研究类简短任务，确认工具流和结果不困惑。
8. Settings：模型配置、主题、缓存/外部服务页能打开且不白屏。
9. 资源与体验：启动无异常弹窗；CPU/内存没有明显异常；关键交互无卡顿、闪烁、原生层错位。

## 6. 预期收益与预期代价

收益：

- Chromium 148 提供 HTML-in-Canvas 实验能力窗口。
- Node 24 / V8 14.8 带来新的 JS runtime 和 Electron 42 的稳定性修复。
- Electron 42 包含 WebContentsView、setBounds、网络服务、auto-update、DevTools、PDF、窗口恢复等多项修复，可能改善 Ready 浏览器层和桌面壳稳定性。

代价：

- Native ABI 必然重建。
- Electron 懒下载改变 CI/本地首次运行路径。
- HTML-in-Canvas 仍是实验能力，不适合无降级地承载核心功能。
- Electron 42 的 Notification 行为会让未签名包的 OS 通知更不可靠，Ready 必须依赖产品内提醒作为兜底。
- 跨平台 Wayland/GTK/Windows fullscreen 等变化，本轮 Mac 验收只能记录风险，不能宣称全平台完成。

## 7. 当前状态

- 分支：`codex/electron42-html-canvas`
- 主线恢复确认：2026-06-01 误切回 `main` 后，升级改动曾留在 `main` 工作区；已确认它们是未提交改动，不是主线提交污染。`main` 指针保持在 `05c2d5a1`，升级改动已重新挂回 `codex/electron42-html-canvas`。
- 当前升级运行时：Electron `42.3.0` / Chromium `148.0.7778.180` / Node `24.15.0` / ABI `146` / V8 `14.8.178.22-electron.0`。
- 已完成：分支创建、本地事实审查、浏览器展示焦点基线、native ABI 基线、typecheck 基线、Electron 42 升级、HTML-in-Canvas 运行时探针、`better-sqlite3` Electron 42 rebuild 补丁、构建链修复。
- 依赖边界：现有 React、Tiptap、Remotion、tldraw、Schedule-X 版本未随升级漂移；lockfile 变化集中在 Electron / electron-builder / Node 类型 / SQLite / Schedule-X 缺失直接依赖及其打包链传递依赖。
- 已保存探针证据：
  - `docs/superpowers/audits/2026-06-01-electron42-html-in-canvas/probe-no-flags.json`
  - `docs/superpowers/audits/2026-06-01-electron42-html-in-canvas/probe-enabled.json`
  - `docs/superpowers/audits/2026-06-01-electron42-html-in-canvas/product-human-acceptance.json`
  - `docs/superpowers/audits/2026-06-01-electron42-html-in-canvas/product-human-startup.png`
  - `docs/superpowers/audits/2026-06-01-electron42-html-in-canvas/product-human-html-in-canvas-probe-page.png`
- 已通过验证：
  - `npm run verify`
  - `npm run verify:native`
  - `npm run verify:html-in-canvas`
  - `npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/html-in-canvas-feature.test.ts`
  - `npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/rss-browser-acquisition.test.ts`
  - Browser presentation 焦点测试
  - `npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/agent-sdk-product-acceptance.test.ts`
  - `npm run typecheck`
  - `npm run test`
  - `npm run build:dir`
  - `node scripts/run-packaged-smoke.cjs --platform darwin --port 9348 --timeout 60000 --out docs/superpowers/audits/2026-06-01-electron42-html-in-canvas/packaged-smoke.json`
  - 独立 userData 产品面模拟人类验收
- 产品面验收覆盖：打包后 Ready 启动、browser/document/rss/calendar/settings 切换、浏览器内本地 HTML-in-Canvas 探针绘制。探针在可见 Browser host 中返回 `ok: true`，API 均为 `function`，采样像素为 `[20,120,90,255]`。
- 追加缺口修复：全量 verify 暴露 RSS 浏览器采集测试会走真实 Bilibili/Weibo 网络且可能留下 fetch 句柄。已为 Bilibili JSON 请求加 abort 超时、为重定向 URL 解析释放响应体，并把相关测试改为离线 mock；随后聚焦测试与 `npm run verify` 均通过。
- 当前残留风险：
  - HTML-in-Canvas 仍是 Chromium 实验能力，当前分支只提供能力与探针，不把它作为无降级核心渲染路径。
  - 本轮仅在 macOS arm64 打包应用中做产品验收；Windows/Linux 的窗口层、Wayland/GTK 差异仍需后续平台验收。
  - `electron-builder --dir` 期间出现过依赖收集告警，但未阻断打包；后续发布前可单独清理依赖声明噪音。
