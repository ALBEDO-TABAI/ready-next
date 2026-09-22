---
title: 浏览器性能与动态负载现状审计
date: 2026-07-17
status: reviewed
enforce: false
owner: 白
original_author: Claude (Fable 5)
reviewed_by: Codex
scope: BrowserView/WebContentsView 生命周期、bounds/show-hide 管线、分栏双开、Renderer 渲染与事件、后台负载源、相邻交互模块
note: >
  本文只陈述现状与证据（file:line 精确到行），按严重度分级，不含实施细节。
  配套实施计划见 2026-07-17-browser-performance-dynamic-load-implementation.md。
  所有结论区分「已证实（代码证据）」与「推测（需真机量测确认）」；推测项显式标注。
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# 浏览器性能与动态负载现状审计

## Codex 复审结论（实施权威修正）

Claude 的热点排序大体成立，但下列结论不能按原文直接转成实现：

1. 一个 `WebContentsView` 不等于一个永远独占的 OS renderer 进程。Chromium 会按站点隔离、进程复用和崩溃恢复动态分配。指标必须以 `app.getAppMetrics()` 的真实 pid 为单位，并把同 pid 对应的 tabId 集合一起报告；不得把共享进程的 CPU 或内存重复记到每个标签。
2. RSSHub 在 boot 时确实无条件启动一个 Node worker；该 worker只有命中需要浏览器自动化的路由时才可能再拉起 Chromium。正确收益是“空闲时不常驻 RSSHub worker，也不提前检查/安装 Chromium”，不能宣称必然少一整棵 Chromium 进程树。
3. `backgroundThrottling:false`、eager restore、hide-all 对 detached view 的反向 attach、全量 tab 快照同步写和冗余 tabUpdate 是确证问题，列为第一实施主线。
4. 固定 30 分钟销毁任意后台页面会丢 WebSocket、未提交表单和页面内存态，不能作为默认策略。运行期回收只允许作用于可完整恢复、长期未交互且无音频、下载、Agent、采集、权限弹窗或编辑风险的冷标签；优先在真实内存压力或 live-view 预算超限时触发，并保存 Chromium navigation history/pageState。启动时未激活标签直接以 dormant metadata 恢复，不存在状态损失。
5. `getAppMetrics()` 是诊断和回收裁决的进程级证据，不是每标签精确计量器；诊断默认按需，资源裁决只在标签生命周期事件或存在可回收冷标签时做低频检查，不新增常驻高频采样。
6. 浮层问题不能靠维护一份容易漂移的组件名单解决。DOM 浮层必须通过统一的可见矩形登记入口与 Browser 原生 surface 做相交判断；只在真实相交时遮蔽原生 surface，并等待匹配 ack。
7. `syncMode` 在 Main 侧确为哑参数。Renderer 已按动画帧合并 bounds，删除该跨进程字段比再叠一层延迟器更简单且更可测。

原文其余“确证”项保留为历史审计证据；实施细节和已裁决阈值以配套 implementation 文档的 Codex 修订版为准。Stage 1 工具面重组后行号已漂移，复核时以本文列出的符号和当前调用链为准，不把旧行号当机器合同。

### 1.1 实施后勘误（2026-07-17）

- 本文以下章节描述的是施工前快照。P0–P5 已完成后，`backgroundThrottling:false`、全量 eager restore、detached host 反向 attach、普通 bounds ack、逐事件快照写入、RSSHub boot eager start、同步高频日志和 CDP/observer 关闭残留均已不再成立；收口数字以 implementation 附录 A 和结构化真机报告为准。
- 原审计把 `BrowserHostView` 写成 `BrowserView | WebContentsView`。真实圆角复现发现旧 `BrowserView` 不能满足与 `WebContentsView.setBorderRadius()` 相同的视觉合同，却仍可被旧配置重新启用；正式运行现已删除旧 selector 与旧 host 分支，只保留 `WebContentsView`。下文所有 “BrowserView” 表述均按“施工前的原生浏览器层”理解，不再代表当前 Electron 类。
- 四组最终截图位于 `outputs/agent-audit/live/browser-corners/`，覆盖单浏览器、浏览器双开、browser+document 与 browser+rss；当前诊断读回 `hostDriver=webContentsView`。

## 0. 审查范围、方法与命名陷阱

### 0.1 范围

- 主进程 `src/main/modules/browser-engine/`（93 文件）：标签页生命周期、host 布局、intent 管线、采集/agent 通道。
- Renderer：`src/renderer/pages/modes/`、`src/renderer/modules/browser/`、`src/renderer/modules/workbench/`（分栏）、`src/renderer/stores/`。
- 相邻模块：RSS 引擎、定时任务、液态玻璃投影、窗口材质。
- 目标场景：多标签页（10–30 个）、浏览器双开、browser+document / browser+rss 工作台分栏、agent 后台任务与前台浏览并行。

### 0.2 证据等级

- **[确证]**：直接代码证据，file:line 可复核。
- **[推测]**：从代码结构推断的运行时行为，需真机量测（Instruments / `app.getAppMetrics()`）确认数量级后才能作为优化收益依据。

### 0.3 命名陷阱（先读，否则会被误导）

1. `browser-power-policy.ts` **与省电/功耗无关**：它是 agent 高权限工具（eval/CDP/network trace）的授权 grant 系统（`browser-power-policy.ts:57` `browserPowerModeEnabled`、`:245` `resolveBrowserPowerAuthorization`）。仓库里**不存在**任何电源/功耗管理模块。
2. `src/main/modules/memory-management/` **与 RAM 无关**：整个目录只有用户画像 + agent 人格 CRUD（`memory-management/ipc-handler.ts:15-17,23,85`）。仓库里**不存在**任何进程内存采样、内存压力响应或标签页驱逐逻辑。
3. "background tab"（`tab-lifecycle-service.ts:283,390`）仅指创建时不激活呈现，页面照常全速加载，**不是降载**。

## 1. 架构现状地图

### 1.1 对象模型

- 每个标签页 = 一个 `BrowserHostView`（`BrowserView | WebContentsView`，`host-types.ts`）。默认 `webContentsView`。每个标签有独立 `webContents`，但 OS renderer 进程可能因站点隔离或复用而一对一或多对一，必须以运行时 pid 量测。
- 创建链：`tab-lifecycle-service.ts:314` → `ipc-handler.ts:588` → `host-layout-service.ts:26`。
- webPreferences 全量（`host-layout-service.ts:27-36` + `html-in-canvas-feature.ts:11-18`）：`nodeIntegration:false`、`contextIsolation:true`、`partition`（默认共享 `persist:browser`）、`spellcheck:true`、`webSecurity:true`、**`backgroundThrottling:false`**、`autoplayPolicy:'user-gesture-required'`、`enableBlinkFeatures:'CanvasDrawElement'`。**无 preload**（每标签页 preload 成本为 0）、无 `v8CacheOptions`、无 cache 容量配置。
- 主窗口：macOS 透明 + `vibrancy:'under-window'` + `visualEffectState:'active'`（`index.ts:465-477`）——非激活态也保持 vibrancy 合成。

### 1.2 呈现模型（native overlay）

- `showHost` = attach（`addChildView`）+ 置顶 + setBounds（`host-layout-service.ts:67-76`）。
- `hideHost` = **先 attach 再挪屏外** `{-100000,-100000,1,1}`（`host-layout-service.ts:78-82`）——隐藏的 view 仍挂在窗口合成树上。
- `detachHost` = 从窗口摘除，但 webContents 继续存活运行（`host-layout-service.ts:51-65`）。
- 切标签页 = 新页 show + 旧页 detach（`tab-shell-service.ts:196-236`），旧页**不 hide、不降载、不销毁**。

### 1.3 intent 管线（Renderer → Main）

- Renderer 不直接操作原生视图；5 种 `BrowserViewIntent`（`src/shared/browser-view-intent.ts:29-34`）走单通道 `browser:intent`（`ipc-shell.ts:182-191`），Main 侧单一决策点 `applyIntent`（`tab-shell-service.ts:305-371`）。
- Renderer 侧已有的节制：1-rAF 合帧闸门（`useBrowserViewBounds.ts:241`）、bounds 签名去重（`:169`）、窗口 resize 1-rAF 合并（`windowResize.ts:14-17`）、show 前连续 4 帧稳定检测（`useBrowserViewBounds.ts:339-357`）。
- Main 侧已有的节制：setBounds 值去重（`host-layout-service.ts:128-131`）、hide/show 单调 intentId 门禁（`visibility-command-state.ts:21-31`）。

### 1.4 分栏模型（两套独立体系，可叠加）

- **层 A 工作台级 mode-pair**：`useMode.splitMode`（单个副 mode，`useMode.ts:8-11`），任意两个**不同** mode 并排；同 mode 组合被 4 处约束拦死（`useMode.ts:27`、`mode-tabs-layout.ts:17`、`mode-transition.ts:41`、`mode-split.ts:14`）。`splitMode` 与 `workbenchSplitRatio` **不持久化**（`useMode.ts` 无 persist），每次启动重置。
- **层 B 浏览器内部双开**：`useBrowserTabs.splitTabId` + `browserSplitRatio`（持久化，`useBrowserTabs.ts:218-219`）；Main 侧单 `activeTabId` + 单 `splitTabId` + 两份 bounds（`ipc-handler.ts:158-162`）→ **全局最多 2 个 BrowserView 同时可见**。副位可被 agent tab 顶替（`BrowserMode.tsx:219-221`）。
- **层 C 文档内部双开**：`useDocTabs.splitTabId` + `documentSplitRatio`（持久化，`useDocTabs.ts:721`），与层 B 同构独立。
- 层 A/B/C 正交叠乘：如 browser(双开 2 view) + document(双开) 同屏 = 2 个原生 view + 2 个编辑器 DOM，各自 ratio/持久化/resize 逻辑分散在不同 store。
- **浏览器"双实例工作区"（两个独立 tab 集合的 browser pane）不可达**：`useBrowserTabs` 全局单例 + Main `BrowserController` 单例是硬前提。

## 2. P0 发现：资源占用的结构性根因

### P0-1 全量禁用 backgroundThrottling —— 后台标签页永远全速运行 [确证]

- 每个标签页创建时 `backgroundThrottling: false`（`host-layout-service.ts:34`），且运行期**从不**调 `setBackgroundThrottling` 调整（全仓 grep 零命中）。
- 后果：被 detach 的后台标签页（不可见、无合成输出）里的定时器、rAF 回调、动画、广告脚本全部以前台频率运行。10 个标签页 = 10 个全速 renderer 进程。这是多标签页 CPU/电耗的最大单点。
- 对比基线：Chromium 默认对不可见页面做 timer throttling（1Hz）+ intensive wake up throttling；Ready 主动关掉了这层保护，且没有任何补偿机制。
- 波及面：采集探针窗口同样 `backgroundThrottling:false` 且 `paintWhenInitiallyHidden:true`（`ipc-handler.ts:2215-2230`，1440×1080 隐藏窗口全速绘制，仅 `setAudioMuted(true)`）。

### P0-2 无任何标签页休眠/丢弃/内存压力机制 —— N 个标签页 = N 个常驻进程 [确证]

- 全仓无 discard/suspend/hibernate/内存采样（`getProcessMemoryInfo`/`getSystemMemoryInfo`/`memoryPressure` 零命中）、无标签页数量上限（`MAX_TAB`/`tabLimit` 零命中）、无音频感知（标签页从不 `setAudioMuted`/读 `audible`）、无帧率限制。
- 标签页关闭是唯一的资源回收路径（`tab-shell-service.ts:166-194`：detach + `webContents.close()` + Map 删除）。
- 后果：会话越久、标签页越多，内存单调上涨；无低内存自保，macOS 内存压力下只能靠 OS 压缩/换页，表现为整机卡顿。

### P0-3 启动恢复全量 eager 加载 —— 恢复风暴 [确证]

- BrowserMode 首挂载（workbench 默认 mode 即 browser）触发 hydration（`useBrowserRuntimeEffects.ts:135-155,308`）；冷启动走 `rebuildRuntimeFromPersistedTabs`（`:48-93`）：对**每个**持久化标签页顺序 `createTab(tab.url)`，每个 createTab 立即 `loadURL` 真实地址（`tab-lifecycle-service.ts:395`）。
- 后果：N 个持久化标签页 = 启动期 N 个 renderer 进程并发 spawn + N 个页面并发网络加载，与应用自身首屏渲染抢 CPU/IO。历史上已因此触发过 Chromium 崩溃（`tab-lifecycle-service.ts:322-329` 注释记录的 2026-07-04 startup crash，当时的修复是去掉 primer 导航，**并发本身仍在**）。
- 无懒恢复概念：非激活标签页没有"占位 + 首次激活才 loadURL"的路径。

### P0-4 hideAllHosts 把全部标签页 attach 到合成树 [确证]

- `hideAllHosts` 遍历**所有**标签页调 `hideHost`（`tab-shell-service.ts:278-286`），而 `hideHost` 对未 attach 的 view 先 `attachHost` 再挪屏外（`host-layout-service.ts:78-82`）。
- 后果：任何 `hide-all`（开设置页、图谱、定时任务面板、mode 切换、聊天弹层遮罩）都会把 N 个原本 detach 的标签页 view 全部挂回窗口合成树（屏外 1×1）；`showActiveHost` 再把非目标 detach（`tab-shell-service.ts:373-397`）。每次遮罩开合都是 O(N) 的 attach/detach 往返。
- [推测] 屏外 1×1 attach 的每 view 合成器开销为小常数，但 attach/detach 本身走原生 view 树操作，N 大时可感知；需真机量测。

### P0-5 每条 tab 事件触发"全量重建 + 全量持久化 + 全树重渲染"三连 [确证]

- 一次普通导航 Main 发约 **8 条 IPC**（did-start / navigate+meta / title+meta ×k / favicon→meta ×k / did-stop+meta，`tab-lifecycle-service.ts:435-532`、`tab-meta-service.ts:70`）：专用事件与全量 `meta` 载荷**成对双发**，Main 侧无任何合并/节流（`ipc-handler.ts:606-609` 直连 `webContents.send`）。
- Renderer 每条事件走 `updateTab`（`useBrowserTabs.ts:325-330`），**无相等短路**，每次：`tabs.map` 整表重建 → `sanitizeSnapshot` 对全部 tab/group 重新归一（`:135-165`）→ `persistBrowserTabsSnapshot` **整份快照写 localStorage**（`:201-203,222`）。
- BrowserMode 对 `useBrowserTabs()` **无 selector 全量订阅**（`BrowserMode.tsx:159-165`）→ 每条事件全量重渲染 BrowserMode，并级联**全部未 memo** 的浏览器组件（`TabRail.tsx:61`、`VerticalTabRail.tsx:74`、`BrowserTopBar.tsx:56`、`BrowserShellLayout.tsx:20` 等，全仓仅 `WorkbenchModeOutlet.tsx:91` 的 ModeScene 用 memo）。
- 净效果：**一次导航 ≈ 8× 全 store 提交 + 8× localStorage 整份写 + 8× 浏览器子树全量重渲染**（含整条竖栏所有图标重画）；标题/favicon 多次刷新线性放大。多标签页同时加载（恢复风暴、RSS 连点）时该路径与 P0-3 相乘。
- 同一根因的表亲：这与 2026-07-15 文档打开延迟计划确诊的 `ready-doc-tabs-v2` 大快照同步重写是**同一模式**（每事件整份 localStorage 序列化），该计划只修了文档侧，浏览器侧快照 `ready-browser-tabs-v1` 未修。

### P0-6 RSSHub worker 启动无条件 fork、无空闲停机 [确证]

- `rss-engine/rsshub-process.ts`：boot 无条件 fork RSSHub Node worker，并在启动前检查/准备 Puppeteer Chromium；异常退出会限次自动重启，worker 内有存活探测。Chromium 只在具体路由需要浏览器自动化时按需出现，不能把 Node worker 与 Chromium 树混为一谈。
- 后果：即使用户从未使用 RSSHub 路由，应用空闲态也常驻额外 Node worker，并可能在启动期承担 Chromium 探测/准备成本。正确优化是删掉 boot eager start，让 `ensureHealthy()` 在首个真实请求时启动，并在无活动后停机。
- 边界澄清：正常 stop 不触发重启（`:481-483` stopping 守卫）；问题不在重启逻辑本身，而在"无条件启动 + 无空闲停机"。

## 3. P1 发现：交互丝滑度的具体损耗点

### P1-1 悬浮原生窗口逐事件跟随主窗，无合帧 [确证]

- vertical-rail / lock / fastcard 三个既有 overlay 是 `parent: mainWindow` 的独立 BrowserWindow，位置靠 JS 在主窗 `move`/`resize` 事件回调里逐次 `getContentBounds` + `screen.getDisplayMatching` + `setBounds`（`vertical-rail-overlay-window.ts:102-118,165-187`、`browser-lock-overlay-window.ts:117-126,179-195`、`fastcard-overlay-window.ts:90-106,153-169`）。新增的 Agent 指针窗口属同一生命周期问题，实施时必须一并纳入共享跟随器。
- 后果：拖动主窗口时每个 OS move 事件同步做多份显示器匹配 + setBounds，无 rAF/节流；视觉上子窗滞后主窗（OS 先移主窗，JS 回调再追）。

### P1-2 拖拽分栏的 IPC 流量与无人消费的 ack 回程 [确证]

- 拖拽期 `startDragBoundsSync` 每帧发 primary + secondary 两条 intent（`useBrowserViewBounds.ts:204-223,178-193`）；Main 对**每条** intent 无条件回 ack（`ipc-shell.ts:184-190`）。
- 双开拖拽 1 秒 ≈ **240 条 IPC**（120 intent + 120 ack）；其中 ack 仅 mode-switch 的 waiter 临时消费（`modeSwitchAckWaiter.ts:81,85`），拖拽期 ~50% 流量是"发了没人接"的回程。
- Renderer/Main 双侧已有值去重兜底，实际条数按 bounds 实变帧数打折；快速拖拽下按上限算。

### P1-3 syncMode 是哑旋钮：Main 侧没有 transient 合帧 [确证]

- Renderer 精心区分 `transient`/`settled`（`useBrowserViewBounds.ts:166,218,258`）并一路透传，但 `BrowserHostLayoutService.applyBounds` 的 `_syncMode` 参数被丢弃（`host-layout-service.ts:84`），两种模式都立即 `view.setBounds`。
- 后果：拖拽期 Main 侧每条 intent 都真实 setBounds（每秒 ~120 次原生调用）；"transient 缓发、settled 落地"的设计意图未实现。

### P1-4 模式切换的人为时延地板 [确证]

- animated 路径（默认按钮/快捷键切换）：`MODE_SWITCH_TIMELINE` 固定 `enter 120ms` + `holding ≥100ms` + `leave 100ms`（`useRitualOverlay.ts:47-51,236,254-257,275`）≈ **320ms 地板**，其中 hide-all ack 等待 ≤100ms 与 DOM commit 都发生在 holding 段内。
- 文件打开已按 2026-07-15 document-open-latency 计划改走 `immediate`（仅保留 ack 正确性等待）；普通 mode 切换仍走完整仪式。
- 固定 setTimeout 兜底散布：`postActivationHostResync` 180ms（`BrowserMode.tsx:1082-1093`）、surfaceReady 48ms（`:985-988,1000-1003`）、面板开合 260ms 兜底（`useTogglePanelWithResize.ts:7,87-90`）、lock overlay 800ms（`browser-lock-overlay-window.ts:73-77`）。

### P1-5 窗口 resize 白边：DOM 领先原生层 ≥1 帧 + 1 次 IPC 往返 [确证机制，量级推测]

- 窗口 resize 时 DOM 容器同步重排，BrowserView bounds 走 DOM 测量 → rAF → IPC → Main setBounds 的异步链（`useBrowserViewBounds.ts:400-414`、`windowResize.ts:14-17`）。
- 面板拖拽有冻结帧机制补偿（`useBrowserResizeFreeze.ts`：拖拽开始 capturePage 截图盖住，结束后 fit + 双 rAF + 80/160ms 双次重截，`:126-172`），**窗口 resize 没有**任何补偿；`BrowserShellLayout.tsx:65-111` 的三块 corner-fill 只遮圆角。
- [推测] 快速拉伸窗口时原生层追不上 DOM，出现瞬时白边/错位；需真机确认可见程度。

### P1-6 browser+document 双开：文档浮层跨分栏线被原生层遮盖 [确证]

- 隐藏协调只有全有/全无的 `browser-overlay-lock`（`useBrowserViewBounds.ts:521-553`），唯一派发方 `browserViewMask.ts:3-33`，消费者仅 RitualOverlay / GraphWorkspace / ScheduledTasksWorkspace 三个全屏级 overlay。
- DocumentMode 及其编辑器不派发该锁：文档侧菜单/对话框/自动补全等浮层若越过分栏线，会被右侧（或左侧）原生 BrowserView 遮住。**架构里没有"半屏原生 + 半屏 DOM 浮层"的局部协调原语**（无 bounds 裁剪、无局部 hide）。
- 同类风险：任何第三方/新增 DOM 浮层（tooltip、下拉、右键菜单）只要可能与浏览器 pane 重叠，都依赖开发者记得手工 begin/endBrowserMask，无 CI 合同兜底。

### P1-7 overlay/设置页 hide 无 ack 门禁 [确证]

- mode 切换主路径是"先 await ack 再翻 DOM"（`WorkbenchMode.tsx:522-536,557-593,619-629`）；但 `beginBrowserMask`（`browserViewMask.ts:3-6`）与设置页（`Settings.tsx:266-270`）是 fire-and-forget，存在"DOM 已挂载但 hide 尚未在 Main 生效"的 1 帧窗口。
- 缓解：Main 侧 intentId 单调门禁防乱序（`visibility-command-state.ts:21-31`）；但不消除首帧竞态。

### P1-8 rail flyout 滚动逐事件推快照 [确证]

- `VerticalTabRail.tsx:485` `onScroll={() => pushSnapshot()}` 每个 scroll 事件走一次 IPC `showVerticalRailOverlay` → Main `applyBounds` + `webContents.send`，无节流。
- 放大器：推快照的 effect 依赖 `bookmarkedUrls`，而 BrowserMode 每次渲染都新建该数组（`BrowserMode.tsx:1194` `bookmarks.map(...)`）→ overlay 打开期间**每次 BrowserMode 渲染都触发一次快照 IPC**（`VerticalTabRail.tsx:345`）。

### P1-9 高频日志逐条同步落盘 [确证]

- 日志器 `utils/rotating-logger.ts:100-103`：`append` = 同步 `appendFileSync`；且**每次写前同步 `statSync` 查文件大小**（`:50-53,80-83`，异步路径同样夹一次 statSync）。无缓冲/批量。
- `ready-directchat.log`（每条消息，`claude-bridge/ipc-handler.ts:144`）与 `ready-tools.log`（每个工具事件，`tool-event-log.ts:27,37`）都走**同步** append；仅 `ready-browser.log` 是异步（`diagnostics-service.ts:57`）。metric 旁路同样同步（`rotating-logger.ts:36-48`）。
- 后果：Agent 高频出工具事件时，Main 主线程逐条阻塞式写盘 + stat，与 BrowserView 的 IPC/bounds 处理抢同一事件循环。

### P1-10 CDP debugger 永不 detach + 歧义缓存随 tab 泄漏 [确证]

- CDP domain 有引用计数 enable/disable（`cdp-session-service.ts:102-135`），但 **debugger 会话本身从不 `detach()`**（browser-engine 全目录无 `debugger.detach`）——一旦 agent 对某 tab 用过 CDP 工具，调试通道持续附着到 tab 生命周期结束（并与 DevTools 互斥）。
- `browserPageMapAmbiguityByTab`（`browser-observe-tools.ts:62`）按 tabKey 累积，tab 关闭无清理路径（仅测试 reset `:64-66`）。
- 关闭路径同样不清 `domainRefsByTab` 条目与 network observer（见 §4 关闭路径行）。

### P1-11 RSS 列表无虚拟化 + 整表替换 [确证]

- `RSSFeed.tsx:920` 全量 `filteredItems.map` 渲染复杂行组件（含 SVG 进度环 + 4 个操作按钮），**无虚拟化、无 per-row memo**；`filteredItems` 在 render 内联 `items.filter`（`:312-317`）未 memo，每次重渲染 O(n) 重算。
- 自动刷新完成 → `loadRSSData` → `setItems(整份快照)` 整表替换（`RSSMode.tsx:392-403,208-213`）→ 全列表重渲染。browser+rss 双开时该成本发生在浏览器同屏的另一半。
- 缓解面：RSSMode 的 store 订阅是字段级 selector（`RSSMode.tsx:104-111`，良好）；分析轮询上限 240 条（`:184-188`）只约束轮询不约束渲染。

### P1-12 工作台级分栏拖拽逐帧写 React state [确证]

- 工作台 mode-pair 分栏拖拽 `handleSplitResize` **每帧 `setWorkbenchSplitRatio()`**（`WorkbenchMode.tsx:277-284`）→ WorkbenchMode（`useMode()` 全量订阅，`:149`）逐帧重渲染；mode 主体被 ModeScene memo 挡住（`WorkbenchModeOutlet.tsx:91-125`），逐帧代价 = WorkbenchMode + outlet 包装层。
- 对照组（好模式）：BrowserMode 内部双开拖拽用 ref + 直接 DOM `flex-basis`，仅拖拽结束提交 store（`BrowserMode.tsx:508-527`）——拖拽期零 React 重渲染。侧栏/聊天栏同款（`WorkbenchMode.tsx:370-398`）。两套实现并存，工作台级是掉队的那套。

## 4. 标签页边际成本模型（每新增 1 个标签页）

| 类别 | 内容 | 证据 |
|---|---|---|
| 进程/对象 | 1 个 WebContentsView + 独立 webContents；OS renderer 进程按 Chromium 运行时策略分配；`backgroundThrottling:false` 永不降频 | `host-layout-service.ts` + 运行时 pid 量测 |
| session | 复用共享 `persist:browser`（不新增 session；命名 profile 才分区） | `tab-lifecycle-service.ts:314` |
| preload | 0（tab 无 preload） | `host-layout-service.ts:26-36` |
| 事件监听 | 11 个 webContents 生命周期监听 + popup/快捷键/右键菜单/window-open handler | `tab-lifecycle-service.ts:352-358,377-517`、`auth-popup-manager.ts:68,87`、`app-shortcut-service.ts:34`、`context-menu-service.ts:58` |
| 注入脚本 | 本地媒体拖拽桥（含页内 dragover/drop 捕获监听），**每次 dom-ready 重注** | `tab-lifecycle-service.ts:94-268,422` |
| 常驻定时器 | 0（browser-engine 无 setInterval，28 处 setTimeout 全为一次性） | 全目录 grep |
| observer/CDP | 0 常开（CDP/network observer/sniffer 均按需附着） | `cdp-session-service.ts:32`、`network-observer-service.ts:62` |
| 每次导航 IPC | did-start/navigate/title(×k)/favicon/did-stop ≈ 5–10 条 `browser:tabUpdate`/`tabMeta` 推送 + 2 次历史写库 | `tab-lifecycle-service.ts:419-517` |
| 关闭路径 | graceful `webContents.close()`；核心监听依赖析构释放，无集中解绑；CDP `domainRefsByTab` 条目与 network observer 在 close 路径不主动清 | `tab-shell-service.ts:166-194`、`cdp-session-service.ts:28,117-134` |

## 5. 双开场景的资源账（browser+browser / browser+document / browser+rss）

- **browser 双开**：2 个 BrowserView 同时 attach 且都全速（无副 pane 降载概念）；拖分栏 = 每帧 2 intent + 2 ack + 2 次原生 setBounds。
- **browser+document**：BrowserView 半屏 + 编辑器 DOM 半屏；两个 outlet 都 `isActive=true` 全量运行（`WorkbenchMode.tsx:887-908`、`WorkbenchModeOutlet.tsx:230`）；文档浮层跨线遮盖缺口（P1-6）。文档打开延迟专项已收口（2026-07-15 计划，enforce: true），本轮不重复。
- **browser+rss**：RSS 列表滚动是纯 DOM，不触发 browser bounds 重算（触发源封闭：contentRef ResizeObserver / 窗口 resize / 面板事件 / 面板宽度依赖，`useBrowserViewBounds.ts:412-449`）；配对态点击文章 = 新建浏览器标签页（`RSSMode.tsx:156-161,499-504`、`open-rss-item-in-browser.ts:22-52`）——**连续点 N 篇文章 = N 个新标签页全速加载**，叠加 P0-1/P0-2 后放大。
- 工作台级 `splitMode` 不持久化（`useMode.ts` 无 persist），浏览器/文档内部 split 持久化——重启后外层分栏丢、内层分栏在，体验不一致（低优）。

## 6. Renderer 渲染与事件管线明细

### 6.1 事件通道与落点

- Main→Renderer 仅两通道：`browser:tabUpdate` / `browser:tabOpened`（`src/preload/index.ts:565-574`，纯透传）。payload 类型：title / loading / navigate / error / **meta（全字段）** / closed（发射点见 `tab-lifecycle-service.ts:435-532`、`tab-meta-service.ts:70`、`tab-close-notifier.ts:22`）。无独立 favicon/audio/progress 通道——favicon 只随全量 meta 下发。
- 落点：`useBrowserRuntimeEffects.ts:197-259` 逐条 `store.updateTab`。数据语义按 id 增量，但工程实现是整表重建 + 全量持久化（见 P0-5）。

### 6.2 渲染隔离现状

- **主用 rail 是 VerticalTabRail**（`BrowserMode.tsx:1188`）；横向 TabRail 仅空态（`BrowserModeEmptyState.tsx:52`）。
- VerticalTabRail 有 6 个 useMemo（`VerticalTabRail.tsx:128-145`）但全部依赖 `tabs` 引用——每条 tab 事件全体失效重算；行渲染 `stripRows.map`（`:492`）无 per-tab memo 子组件。hover 走 CSS `group-hover` 不触发渲染（好）；拖拽的 `draggingTabId/dropTarget` state（`:100-101,389`）会整列重渲染。
- 横向 TabRail 用 `hoveredTabId` state（`TabRail.tsx:117,444-445`）→ hover 即整条重渲染。
- 订阅粒度分裂：BrowserMode 对 useWorkspace/useFastCard 已是字段级 selector（`BrowserMode.tsx:187-192,228-234`）、RSSMode 全字段级（`RSSMode.tsx:104-111`）、WorkbenchMode 对 useDocTabs 用 selector（`WorkbenchMode.tsx:150`）；但 `useBrowserTabs()`（`BrowserMode.tsx:159-165`）、`useWorkspace()+useMode()`（`WorkbenchMode.tsx:128-149`）、`useWorkspace()+useDocTabs()`（`DocumentMode.tsx:356,364`）仍是全量解构。

### 6.3 keep-alive 语义

- 四个 mode 一次性全挂载（`WorkbenchModeOutlet.tsx:47,224`），切走用 `visibility:hidden + pointerEvents:none`（`:105-112`）**隐藏不卸载**；ModeScene memo + 自定义比较器（`:78-125`）让隐藏 mode 在 props 稳定时跳过重渲染；仅当前 mode `isActive=true`（`:230`）。
- DocumentMode 文件选择有 isActive 门控（`documentSelectionOpen.ts:10`，2026-07-15 合同成立）；RSSMode 轮询有 `shouldPoll` 门控（`RSSMode.tsx:144`），后台自动刷新事件挂起暂存、恢复补处理（`:399-415`）。**门控是各 mode 自觉实现，无统一的"隐藏 mode 不做工"合同**。

### 6.4 一次导航的重渲染账单（汇总）

≈ 8×（全 store 提交 + localStorage 整份写 + BrowserMode 子树全量重渲染），见 P0-5。双开时 BrowserShellLayout ×2~3（`BrowserMode.tsx:1227,1300,1326`）。overlay 打开时叠加 8× 快照 IPC（P1-8）。

## 7. 后台常驻负载源

### 7.1 Agent 浏览器通道（与前台共享，无进程隔离）

- 两条 lane：`user-view`（复用用户当前 tab，不新建 view，`agent-browser-lane.ts:29-68`、`agent-runtime-adapter.ts:44-72`）与 `agent-view`（可 `host.createTab` 开真实可见 tab，`owner:'agent'`，`capability-service.ts:292,303`）。agent tab 与用户 tab **共享同一 session（`persist:browser`）与主进程**，隔离是租约级（单写者）不是资源级。
- 采集执行是**单 tab 串行**：note_collect 逐条 `planNextNote→collectNote→checkpoint`（`browser-collector-engine.ts:213-249`）；research 串行 for-loop 复用 tab、硬上限 20 页默认 6 页（`content-task-runner.ts:1832,1846-1855`）。**无并行页面风暴**（好）。跨 origin 写由 `origin-interaction-budget.ts:110-136` 串行化。
- 租约释放走 `finally`（`content-task-runner.ts:1713-1715,1155-1156`）；异常路径靠 60s TTL 惰性 reconcile（`browser-write-lease.ts:81,121-126`），无常驻回收定时器，泄漏面有界（2 个 surface key）。
- CDP/observer/sniffer 全部按需附着按需停（`cdp-session-service.ts:32-43,102-135`、`network-observer-service.ts:62-92`、`resource-sniffer.ts:662-664`）；残留风险见 P1-10。
- 快照服务按需 + dirty 缓存（AX 树非位图，`browser-snapshot-service.ts:260-275`）；预览是单例懒建 view（`preview-service.ts:72-145`）；竖栏悬浮层**不生成页面截图**（`browser-vertical-rail-overlay.ts:7-24` 仅 favicon+文字）。

### 7.2 RSS 引擎

- 自动刷新默认 15 分钟（`src/shared/rss-auto-refresh.ts:5`，可设 0 关闭），setTimeout 对齐调度非轮询（`auto-refresh-scheduler.ts:89-108`）；fetchAll 全部启用源、并发 5（`fetch-group.ts:401,496`；另一路径并发 4 `:897`）、单源 15s 超时 2 次重试（`scrapers/base.ts:34-36`）；`RSSUpdateLock` 保证单实例（`update-lock.ts:68-74`）。
- 抓取用主进程原生 `fetch()`（`scrapers/base.ts:54,93`），无隐藏 BrowserView。深度分析走 skill 子进程 + 任务期 2s 进度轮询（`item-analysis-manager.ts:848`，finally 清理）。
- **与前台零协调**：无"前台浏览中降并发/让路"机制；fetchAll 的解析/入库在主进程事件循环执行，与 BrowserView IPC 抢队列。
- RSSHub Node worker 无条件常驻；Chromium 只在需要浏览器自动化的具体路由中按需出现：见 P0-6。

### 7.3 src/main 常驻定时器清单

| 模块 | 机制/间隔 | 空闲能否停 |
|---|---|---|
| RSS 自动刷新（`auto-refresh-scheduler.ts:107`） | setTimeout / 默认 15min | 档位 0 可停 |
| RSSHub 子进程（`rsshub-process.ts` + `src/main/index.ts:1131`；异常退出限次重启 `rsshub-process.ts:459-495`） | 常驻 Node worker + 内部 setInterval；Chromium 仅特定路由按需 | **否，boot 无条件** |
| RSS 分析进度（`item-analysis-manager.ts:848`） | setInterval 2s | 仅任务期 |
| 定时任务（`schedule-clock.ts:17-30`、`schedule-coordinator.ts:97-161`） | 单 setTimeout 指向最近到期 | **零空闲唤醒（好）** |
| 日历提醒（`reminder-scheduler.ts:159,131`） | setInterval 6h + per-提醒 setTimeout | 常驻 |
| skill 任务调度（`skill-job-scheduler.ts:216`） | setInterval 60s | 否 |
| skill 维护清扫 ×2（`maintenance-sweeps.ts:67,111`） | setInterval 60min | 否 |
| sidecar 心跳/轮询（`sidecar-manager.ts:309`、`sidecar-poll-service.ts:73`） | setInterval 10s / 3s | 随 sidecar 停 |
| 记忆维护（`memory-lifecycle.ts:47`） | setInterval 6h | 否 |
| 结晶轮次（`crystallize-gate.ts:158`） | setInterval 6h | 否 |
| 启动探针/闪屏（`boot-timing.ts:24`、`startup-splash-window.ts:167`） | 32ms（30s 自停）/ 动画期 | 是 |

- browser-engine 自身 0 常驻定时器（28 处 setTimeout 全一次性）。
- 空闲态的持续心跳主要是 skill 调度 60s 与 sidecar 10s/3s（后者按需）；其余为小时级。本次与用户无感目标直接相关的空闲大头是无条件 RSSHub Node worker（P0-6）与全速后台标签页（P0-1）；不将按需 Chromium 孙进程误算成 RSSHub 空闲必然开销。

### 7.4 日志落盘

见 P1-9：directchat/tools 逐条同步 `appendFileSync` + 每写一次 `statSync`；仅 browser 日志异步。

## 8. 相邻模块热点

### 8.1 LiquidBackdropProjection：聊天流式输出期间的整树深拷贝 [确证机制，频率推测]

- 对聊天源节点挂 subtree MutationObserver（attributes + characterData + childList + subtree，`LiquidBackdropProjection.tsx:197-203`），每次变更（1-rAF 合帧后）执行 `source.cloneNode(true)` 深拷贝整个聊天 DOM 并 `replaceChildren`（`:143-172`）。
- [推测] Agent 流式输出期间 mutation 连续到达 ≈ 每帧深拷贝一次会话 DOM；会话越长成本越高，与浏览器同屏（聊天面板 + browser mode）时叠加主线程压力。需真机量测克隆耗时随会话长度的曲线。

### 8.2 主窗口透明 vibrancy 常开 [确证配置，代价推测]

- `vibrancy:'under-window'` + `visualEffectState:'active'`（`index.ts:465-477`）：窗口非激活时也维持 vibrancy 合成。实色玻璃皮肤（2026-07-17 落地）下是否仍需要透明 vibrancy 通道，值得复核——透明窗口 + 多 BrowserView 是 macOS 合成器的已知高成本组合。

## 9. 缺失机制清单（相对成熟多标签浏览器）

| 机制 | Chromium/Edge/Arc 基线 | Ready 现状 |
|---|---|---|
| 后台 timer throttling | 默认 1Hz + intensive throttling | 主动禁用（P0-1） |
| 标签页休眠/丢弃 | memory saver / tab discard + 恢复 | 无（P0-2） |
| 懒恢复 | 恢复即占位、激活才加载 | 全量 eager（P0-3） |
| 内存压力响应 | 压力驱动 discard | 无 |
| 音频/表单豁免 | audible/表单脏页不休眠 | 无豁免概念（也无休眠） |
| 每标签页资源观测 | 任务管理器 | 无任何采样（`app.getAppMetrics` 未使用） |
| cache 容量 | 有上限 | 未配置 |

## 10. 已被先行计划覆盖、本轮不重复的项

- 文件打开时延链（localStorage 大快照、ritual 串行、keep-alive DocumentMode 越权响应）：`2026-07-15-document-open-latency-implementation.md`（enforce: true，已实施）。
- Agent 浏览器工具面重组与安全加固：`2026-07-17-browser-tool-surface-and-hardening-implementation.md`（revised-proposal）。本审计与其交叉点仅在"agent 后台任务与前台资源协调"（见 §7）。
