# 第 5 轮缺口审计 —— TopBar 右排对齐 / 四模式切换延迟 / 浏览器面板收起卡顿

> 审计日期: 2026-04-18（晚间，在 `1ee2b82` 落地之后）
> 基线提交: `1ee2b82 fix(ui): route panel click-toggle through resize signal, sync TopBar padding + restore chat composer flex`
> 前置审计:
> - `docs/performance/2026-04-17-ui-animation-jank-audit.md`（第 1 轮）
> - `docs/performance/2026-04-18-ui-animation-jank-gap-audit.md`（第 2 轮）
> - `docs/performance/2026-04-18-ui-animation-round3-audit.md`（第 3 轮）
> - `docs/performance/2026-04-18-ui-animation-round4-regression-audit.md`（第 4 轮）
>
> 本轮触发: 第 4 轮修复落地后，用户仍在观察到三类问题：
> 1. TopBar 最右排的 `U / 主题 / 收起` 三个按钮与下方 ChatHeader 的 `折叠 / 历史 / 新建` 三个按钮**没有在纵向上一一对齐**（见用户截图中红色箭头，肉眼水平偏差接近一个 ChatPanel 宽度）。
> 2. **四模块切换仍有可见延迟**——即便是不涉及 BrowserView 的 document↔rss↔calendar 纯 DOM 切换也要吃满仪式时间线。
> 3. **浏览器模式下左右面板收起/展开动画明显掉帧**，带有"分段感"，与 document 等纯 DOM 模式下同一按钮的观感明显不同。
>
> 输出: **只做根因定位与缺口清点，不写 PR / 代码修改**。后续修复计划基于本文档另行生成。

---

## 0. TL;DR（5 条先读）

1. **对齐断裂来自"两套坐标系"**：`TopBar` 的右内边距读 `--workbench-right-gutter = chatShellWidth` 再叠加 `WORKBENCH_TOPBAR_PADDING_RIGHT = 14px`；`ChatHeader` 只用硬编码 `padding: '0 14px'`——两者引用系不同，一个以**视口**为基准、一个以**ChatPanel**为基准，差值正好是一个 `chatShellWidth`。这解释了用户看到的大偏移。修对齐不是简单调数字，而是先给"chat 列右缘与 chat 头右缘对齐"立一个共享 token。
2. **模式切换的 220ms 是仪式本身、不是动画**：`MODE_SWITCH_TIMELINE = 120 enter + 100 hold + 100 leave = 320ms`（`useRitualOverlay.ts:47-51`），无论当前是不是 browser 参与、无论是否需要 BrowserView hide/show，四种切换都走同一条 320ms 管线。document↔rss↔calendar 纯 DOM 切换本来可以接近 0 成本，现在强吃仪式。
3. **浏览器面板收起的"分段感"是三路 IPC 叠加**：单次 click-toggle 同时触发 (a) `useBrowserViewBounds` 的 ResizeObserver 每帧 `sendBounds`、(b) `useEffect(chatPanelVisible, chatPanelWidth, ...)` 又独立触发一次 forceExact 同步、(c) `useBrowserResizeFreeze.handleResizeStart` 在 T=0 立即发 `captureWindowSnapshot` IPC，收尾时 `handleResizeEnd` 还要再发 `fitActiveTabToBounds` + **三次** `recaptureFreezeFrame`（0/80/160ms）。浏览器模式原生层本身无论如何都要每帧 `setBounds`，这些额外的同步+快照 IPC 占据了主进程档期，给渲染线程留下不到一帧的窗口，因此出现"3 帧跳一次"的观感。
4. **冻结帧对 click-toggle 是纯成本**：冻结帧的设计目标是遮盖 BrowserView 拖拽/模式切换时的撕裂；但 click-toggle 下 BrowserView 仍然可见并在 `sendBounds` 跟随，**冻结帧没有任何遮盖价值**——反而每次都要重新发快照 IPC、主进程 GPU readback、并把 PNG 编码成 `data:` URL 挂到 DOM 上。
5. **第 4 轮没能彻底解决对齐的原因是"只修了 TopBar 侧"**：`c536ac6` 引入 `--workbench-right-gutter` 后 TopBar padding 跟上，但 `ChatHeader`、`StatusBar`、`FileManager` 头、`ModeSlider` 等都没有进入这个共享变量体系。对齐问题本质是"缺少贯穿全局的右缘 / 左缘对齐 token"，不是某个组件的 padding 数值错误。

---

## 1. 问题 A —— TopBar 右排按钮与 ChatHeader 右排按钮未对齐

### A1. 现象

用户截图显示：
- **上排**（TopBar 右侧）：`U（色块）`、`主题切换`、`PanelLeftClose`
- **下排**（ChatPanel 顶部 ChatHeader 右侧）：`PanelRightClose`、`History`、`+`

两排都是 3 个 24×24 按钮，**应该**在同一条纵向线上对齐（设计直觉：一个 "right-column right-edge" 贯穿 TopBar 与 ChatHeader）。实际呈现：上排远远偏左，几乎粘在 ChatPanel 的**左**缘，下排则靠近 ChatPanel 的**右**缘——肉眼偏差 ≈ `chatShellWidth - 14px ≈ 336px`（用户截图中的 ChatPanel 大致 350 宽）。

### A2. 根因（算术推导）

两组按钮各自由**不同坐标系**决定可见 x 坐标：

| 组件 | 定位文件 | padding-right 表达式 | 数值（chat 展开 = 350）|
|------|----------|---------------------|-----------------------|
| TopBar 右按钮容器 | `src/renderer/components/layout/TopBar.tsx:40-98` line 48 | `calc(var(--workbench-right-gutter, 0px) + 14px)` | `calc(350 + 14) = 364px` |
| ChatHeader 右按钮容器 | `src/renderer/components/agent/ChatHeader.tsx:178-194` line 184 | `padding: '0 14px'`（硬编码） | 14px |

**其中 `--workbench-right-gutter` 由 `WorkbenchMode.tsx:272` 写入 `.workbench-mode-root`**：
```
style={{ ['--workbench-right-gutter']: `${chatShellWidth}px` }}
```
而 `chatShellWidth = chatPanelVisible ? chatPanelWidth : WORKBENCH_EDGE_RAIL_SIZE`（`WorkbenchMode.tsx:174`）。

两组按钮可见 x 坐标的视口差：
- TopBar 右按钮右缘：`viewportWidth - 14 - chatShellWidth`（因为 TopBar 在 workbench-root 这一层的可视宽度是整个视口，它的右边距把按钮组往左推了 `chatShellWidth + 14`）。
- ChatHeader 右按钮右缘：`viewportWidth - 14`（因为 ChatHeader 本身在 ChatPanel 这一层，ChatPanel 的右缘就是视口右缘，ChatHeader 内 `padding-right: 14px` 把按钮推到 `viewport - 14`）。

**差值 = `chatShellWidth`** —— 展开时 ≈350px，折叠时 ≈ `WORKBENCH_EDGE_RAIL_SIZE`（见 `chrome.ts` 常量）。

> ⚠ 结论：偏差不是一个 padding 几像素问题，是"TopBar 把自己视为 workbench-root 范围"而"ChatHeader 把自己视为 ChatPanel 范围"的结构决策所致。

### A3. 设计意图冲突（历史追溯）

从 commit 信息看：
- `c536ac6 restore … panel-gutter alignment`：**显式**要求 TopBar 右缘跟 ChatPanel 左缘对齐（"面板外的 TopBar 内容不要覆盖到面板上"）。
- `1ee2b82 sync TopBar padding`：继续强化这一意图，加了 180ms 过渡。

但用户这一轮的需求是**另一种对齐**——"TopBar 右按钮与 ChatHeader 右按钮纵向对齐"。这两个对齐**不可同时满足**：
- 若 TopBar 右按钮要对齐 ChatPanel 右缘（即 `padding-right = 14px`，不读 gutter），那 ChatPanel 的 `U/主题/收起` 会"坐"到 ChatPanel 内容上方空间，视觉上变成 ChatPanel 的一部分。
- 若要保留 `c536ac6` 的意图（TopBar 不越过 ChatPanel 左缘），则按钮必然坐在 ChatPanel 左边，与 ChatHeader 的右按钮天然错开 `chatShellWidth`。

**这意味着用户的期望推翻了当前的设计直觉**：需要先确认 TopBar 右按钮的新定位是"坐在 ChatPanel 头部的右侧区域"而不是"坐在 workbench TopBar 的最右侧"，再重做布局。

### A4. 其它关联的对齐缺口（证据见 `src/renderer/`）

| 组件 | 文件:行 | 当前表达 | 缺口 |
|------|---------|---------|------|
| `ModeSlider` 左内边距 | `components/layout/ModeSlider.tsx:8` | 硬编码 `paddingLeft: 19` | 不引用任何 token，和 `FileManager` 头左 padding（14）对不齐 |
| `FileManager` 头 | `components/layout/FilesPanel.tsx:332, 372` | `padding: '0 14px'` | 与 TopBar 左内边距 `WORKBENCH_TOPBAR_PADDING_LEFT = 60` 没有任何共享约束 |
| `StatusBar` 右缘 | `components/layout/StatusBar.tsx:18` | `paddingRight: WORKBENCH_EDGE_ICON_INSET (14.5)` | 和 TopBar 右 `14` 不同；**完全不读 `--workbench-right-gutter`**，动态 ChatPanel 折叠时会错位 |
| `CollapsedChatRail` | `components/agent/ChatPanel.tsx:1070-1111` line 1077 | `paddingRight: WORKBENCH_TOPBAR_PADDING_RIGHT (14)` | 折叠时和展开时走不同路径，语义割裂 |
| `TopBar` 的 U 按钮 | `components/layout/TopBar.tsx:66-80` | 手写 `h-6 w-6` + inline style | 不走 `IconButton` 组件；尺寸靠手撸等于 24 与 `IconButton` 的 `md:24` 对得上，但样式规则脱节 |

### A5. 本问题背后"设计底层缺口"

1. **缺一个"右缘对齐 token"**：当前只有 `--workbench-right-gutter` 一个 CSS 变量，职责是"TopBar 右 padding 跟 ChatPanel 宽度联动"，但它不代表"右按钮组应该坐在哪"。
2. **缺一个"竖向栅格 token"**：TopBar 的三颗按钮、ChatHeader 的三颗按钮、FileManager 头的图标、StatusBar 的图标，**理论上应共享同一竖向中心线**；当前完全靠手写 padding 各自对齐到不同基准。
3. **`<IconButton>` 没有强制：**TopBar 里 U 按钮绕过 IconButton 手写了 `h-6 w-6 rounded-xl`，一旦 IconButton 未来调整 `md:24` 会失联。
4. **回归测试缺口**：`src/__tests__/topbar-padding-right-transition-contract.test.ts` 只校验 TopBar 自己的 padding 过渡，没有任何测试校验"TopBar 按钮右缘 ≈ ChatHeader 按钮右缘"的几何关系。

---

## 2. 问题 B —— 四模式切换仍有可见延迟

### B1. 管线总图（从点击到"切换视觉完成"）

#### B1.a browser → document（当前）

| T (ms) | 事件 | 证据 |
|--------|------|------|
| 0 | 用户点 `DraggableModeTabs` document 图标 / ⌘2 | `WorkbenchMode.tsx:handleWorkbenchModeChange` |
| 0 | `setIsMotionSettled(false)`，开启 ritual | `WorkbenchMode.tsx:194, 196` |
| 0-120 | `ritual.entering`：遮罩 opacity 0→1 + `beginBrowserMask()` → `hideAll()` | `useRitualOverlay.ts:209` |
| 120 | `phase='holding'`，RAF 后进入 workFn | `useRitualOverlay.ts:215-216` |
| 120 | workFn 里：`setBrowserLayoutMotionPhase('leaving')`, `setWorkbenchMode('document')`, `signalReady()` | `WorkbenchMode.tsx:199-204` |
| 120 | `WorkbenchModeOutlet.useLayoutEffect(mode)` 触发，四个 `ModeScene` 更新 visualState | `WorkbenchModeOutlet.tsx:151-172` |
| 120 | CSS keyframe 动画启动：browser 场景向左滑 280ms，document 场景从右滑入 280ms | `ritual-overlay.css:116-150` |
| 120-220 | `ritual.holding` 保持 100ms（即 workFn 已完成也要等满） | `useRitualOverlay.ts:226-230` |
| 220 | `phase='leaving'`，overlay opacity 1→0 | `useRitualOverlay.ts:247` |
| 220-320 | `ritual.leaving` 100ms，同时 `endBrowserMask()` → `showActive()` | `useRitualOverlay.ts:248` |
| 320 | cleanup，`previous=null`，browser 场景 display:none | `WorkbenchModeOutlet.tsx:165-167` |
| 400 | CSS 280ms 动画彻底完成 | `ritual-overlay.css` |

**用户感知延迟：最早在 T=120 才看到目标模式 DOM 挂起并开始动画**——前 120ms 是"遮罩在变暗、什么都没发生"。

#### B1.b document → rss（当前）

与上表完全相同。没有 BrowserView 参与（`comingFromBrowser = false, enteringBrowser = false`, `WorkbenchMode.tsx:197-198`），但仍然吃满 `MODE_SWITCH_TIMELINE` 的 320ms 仪式 + 280ms 场景动画。

### B2. 缺口详表

| # | 缺口 | 文件:行 | 类别 | 备注 |
|---|------|---------|------|------|
| B-1 | 非 browser 切换仍跑完整 ritual | `modules/overlay/useRitualOverlay.ts:47-51`, `pages/WorkbenchMode.tsx:196` | 架构 | 仪式最初是为"遮盖 BrowserView hide/show 撕裂"存在的；对 document↔rss↔calendar 无遮盖意义；P0 |
| B-2 | ritual 在 panelResizing 时被**完全**吞掉 | `modules/overlay/useRitualOverlay.ts:127-135` | 鲁棒性 | 拖拽面板同时按 ⌘2 → mode 切了但没遮罩，BrowserView 直接裸奔。见 round4 G2 |
| B-3 | `nextFrame()` 双 RAF 的多吃 16ms | `modules/overlay/useRitualOverlay.ts:96-102, 216` | 性能 | 只有一层 `requestAnimationFrame`（已从第 3 轮双 RAF 改单），但 entering→holding 仍要等一帧 |
| B-4 | 四个 ModeScene **始终** mount | `components/layout/WorkbenchModeOutlet.tsx:181-194` | 内存/启动 | `display:none` 但 effect 仍订阅 store（如 BrowserMode 的 `useBrowserViewBounds` 订阅 ResizeObserver），切回来无加速，切走无释放 |
| B-5 | Thumb 与场景动画 GPU 抢档 | `components/layout/DraggableModeTabs.tsx`, `styles/workbench-sliders.css:207-233` | 观感 | 第 3 轮已把 setState-per-RAF 改为 CSS 变量写入；但 thumb 的 `box-shadow`（多层 rgba+inset）+ `background`（双线性渐变）transition 仍在 180ms 窗口与场景合成抢 GPU |
| B-6 | `DraggableModeTabs` 的 icon opacity/color 每帧随 `--dmt-icon-proximity` 变 | `styles/workbench-sliders.css:270-296` | 观感 | 4 个按钮 style 随位置插值；在 200ms 内是连续 recalc |
| B-7 | BrowserView 6 步序列 | `pages/modes/BrowserMode.tsx:318-353` | 性能 | 进入 browser 模式时仍有 hideAll + sendBoundsImmediate + fitActiveTabToBounds + sendBoundsImmediate + syncBrowserVisibility + 2×RAF captureStableFrame，无并行/去重 |
| B-8 | `captureStableFrame` 180ms 尾随 | `pages/modes/BrowserMode.tsx:270-307` + `modules/browser/useBrowserResizeFreeze.ts:114-124` | 性能 | 每次落到 browser，主进程都要额外跑一次 PNG 采样 IPC，无必要（上一帧的 cachedFreezeFrame 已可复用） |
| B-9 | CSS 场景位移 `28%` 硬编码，不自适应 | `styles/ritual-overlay.css:133-150` | 视觉 | 宽屏 = 太远，窄屏 = 太近；应以像素或视口百分比带上限 |
| B-10 | 没有"快路径"阈值 | 全链 | 架构 | 即使同一模式（⌘1→⌘1）也会走一轮 withRitual（虽然大部分 setWorkbenchMode 是 no-op，但仪式仍然跑完）。需要前置 guard |

### B3. 第 3/4 轮已落实的优化（不要在计划里重复）

- ✅ **Thumb 位置 → CSS 变量**（`DraggableModeTabs.tsx:40-44` 之类的 `writeThumbPos`），不再 setState 每帧。
- ✅ **MODE_SCENE 用 CSS @keyframes** 不是 JS 缓动（`ritual-overlay.css:116-150`）。
- ✅ **共享 ritual overlay**（`2424cbd`）作为 mode / theme 统一入口。
- ✅ **BrowserView 决策收口到 useBrowserViewBounds**（`05c3ffa`）。
- ✅ **trailing resync 改由 layoutPhase 驱动**（`6bf99b9`），180ms 固定定时器退役。

### B4. 本问题背后"设计底层缺口"

1. **仪式 vs 动画混淆**：`ritual` 有两重职责——(a) 遮挡 native BrowserView 的 hide/show 撕裂、(b) 给 DOM 模式切换加视觉节奏。这两重在 `document↔rss` 根本不存在，却被强行收费。
2. **缺"切换路由表"**：需要一张 `(from, to)` → `transition strategy` 的映射，至少区分三类：
   - `browser ↔ non-browser`：需要遮罩 + hide/show + bounds 同步
   - `non-browser ↔ non-browser`：只要 DOM 场景动画，不需要 ritual 遮罩、不需要 BrowserView 触达
   - `same → same`（等价切换）：直接短路
3. **共享常量位置不对称**：`MODE_SWITCH_TIMELINE` 写在 `useRitualOverlay.ts` 里，业务侧的 `MODE_TRANSITION_DURATION_MS` 写在 `WorkbenchMode.tsx`，`MODE_SCENE_TRANSITION` 写在 CSS keyframe，三处需要对齐，目前靠记忆。

---

## 3. 问题 C —— 浏览器模式下左右面板收起动画掉帧

### C1. 现象与定位

在 **browser 模式** 下，点击左侧 FileManager 或右侧 ChatPanel 的 toggle 按钮，180ms 的宽度过渡肉眼**分段**——不是连续插值，而是像 3~4 帧跳一次，带"咔嗒咔嗒"的分段感。切换到 document 模式下同样点击同样的按钮，观感**顺滑很多**。

因此问题**不在**：
- `width` 的 CSS transition 本身（GPU 插值没坏）
- `body.resizing *{transition:none}`（click-toggle 不会设置 body.resizing，已确认）
- `TopBar` 的 `padding-right` 过渡（1ee2b82 新增，但 document 模式下同样存在而无卡顿）

问题**在**："点击收放发生时，BrowserView 所在的原生层 + 冻结帧快照层 + Bounds 同步链"会在 180ms 内进行高频 IPC，把主进程档期吃满；而 180ms CSS 过渡在 60fps 下只有 10~11 帧预算，每一帧主进程 stall 3~5ms 就够让渲染线程丢帧。

### C2. 单次 click-toggle 实际触发的三路同步 + 两路快照 IPC

**路径 ①（PANEL_RESIZE_STATE_EVENT 主路径）**
- `useTogglePanelWithResize.ts:71-90`：调 toggle() 前 dispatch `{resizing: true}`；transitionend（或 260ms safety）后 dispatch `{resizing: false}`。
- `useBrowserViewBounds.ts:266-287` 里 `handlePanelResizeState`：
  - `resizing: true` → `panelResizingRef = true` + 立即 `scheduleBoundsSync('transient', { force: true })`
  - `resizing: false` → `panelResizingRef = false` + `scheduleBoundsSync('settled', { force: true })`

**路径 ②（useEffect 依赖于 chatPanelVisible/chatPanelWidth）**
- `useBrowserViewBounds.ts:245-264`：这个 effect 依赖列表包含 `chatPanelVisible, chatPanelWidth, effectiveSidePanelWidth, sidebarVisible, …`，每当这些 prop 改动就跑 `sendBounds({ forceExact: true })`。
- 点击 toggle 的瞬间，`chatPanelVisible` 翻转——**这条 effect 独立地又发了一次 bounds 同步**，与路径 ① 冗余。

**路径 ③（ResizeObserver）**
- `useBrowserViewBounds.ts:223-243` 在 `contentRef` 上挂 ResizeObserver，每次 `contentRef` 的实际尺寸变化触发 `handleBoundsShift` → `sendBounds({ forceExact: panelResizingRef.current })`。
- 因为 CSS width 过渡在每一帧插值都会重新 layout contentRef，这个 observer 在 180ms 内会被触发 ~10 次。
- 虽然 `scheduleBoundsSync` 用 `frameSyncRafRef` 做了 rAF 合并（每帧最多 1 次 IPC），但这条 rAF 就是"每帧发一次"，180ms 内仍有 ~10 次 IPC。

**快照路径 ①（`useBrowserResizeFreeze.handleResizeStart`）**
- `useBrowserResizeFreeze.ts:126-134`：`{resizing: true}` 一来就调 `recaptureFreezeFrame` → `captureSnapshot` → `window.electronAPI.browser.captureWindowSnapshot(bounds)`。
- 这是一次**主进程 GPU readback + PNG 编码**的 IPC，成本通常 5-20ms，**发生在 T=0**。

**快照路径 ②（`useBrowserResizeFreeze.handleResizeEnd`）**
- `useBrowserResizeFreeze.ts:136-172`：`{resizing: false}` 到来：
  - 立即 `fitActiveTabToBounds` IPC
  - 双 RAF 后 `recaptureFreezeFrame`（第 1 次）
  - `setTimeout(recaptureFreezeFrame + fitActiveTabToBounds, 80)`（第 2 次）
  - `setTimeout(recaptureFreezeFrame + fitActiveTabToBounds, 160)`（第 3 次）
- 即**一次点击收尾总共再发 5 次 IPC**（1 fit + 1 recapture + 80ms 后 1 fit + 1 recapture + 160ms 后 1 fit + 1 recapture……实际是 1 fit-now + 1 recap-now + 2×(fit+recap) = 6 calls）。

**合计一次 click-toggle 的 IPC 数量估算**：
- 开始：1 captureSnapshot + 1 scheduleBoundsSync（rAF→IPC）= 2
- 180ms 内：~10 次 ResizeObserver-驱动的 sendBounds IPC
- 结束：1 scheduleBoundsSync + 1 fit + 1 recap + 2×(fit+recap) = 6
- **共 ~18 次跨进程 IPC**，密度 ~60/s，远超主进程 BrowserView.setBounds 的合理节流阈值（~16ms = 62Hz 上限）。

### C3. 主进程侧 bounds 合并策略观察

- `src/main/modules/browser-engine/**` 里的 `scheduleHostBounds / setHostBoundsNow`（第 4 轮 round3 审计给出路径 `host-layout-service.ts`）：`syncMode === 'transient'` 会走 16ms `setTimeout` 合并，但在**高频+高 delta** 下，每次合并都会在 16ms 后调一次原生 `view.setBounds()`；原生 `setBounds` 触发 Electron 内部 synchronous layout，本身不是瓶颈但会阻塞 IPC 通道。
- 这些合并在理想情况下应把 ~10 次 IPC 压缩成 ~11 次 setBounds（每 16ms 一次），但快照 IPC **不经过**该合并路径（`captureWindowSnapshot` 是独立 handler），于是快照 IPC 会"插队"，在主进程 GPU 忙时把队列堵住。

### C4. 为什么在 document / rss / calendar 模式下按同一个按钮不卡？

- `useBrowserViewBounds` 内的 effect 和 observer 都有 `if (!isActive) return` 分支（`useBrowserViewBounds.ts:246, 119`），`isActive` 绑定 `shouldPrepareBrowserHost`，仅在 browser 模式为 true。因此非 browser 模式下 `ResizeObserver` 不调 sendBounds，effect 也不跑。
- `useBrowserResizeFreeze.handleResizeStart` 内部有 `if (!isActive) return`（`useBrowserResizeFreeze.ts:104`），不会发 captureSnapshot。
- 所以非 browser 模式下 click-toggle 只剩纯 CSS 180ms 过渡 + TopBar 的 padding-right 180ms 过渡 + `PANEL_RESIZE_STATE_EVENT` 的 event listener（没有监听者做重活），主进程无事可做，动画丝滑。

### C5. 次级放大源（排序不代表严重度）

| # | 放大源 | 文件:行 |
|---|--------|---------|
| C-a | `useBrowserResizeFreeze.handleResizeStart` 在 click-toggle 下其实**没遮盖价值**：CSS 180ms 过渡是 GPU 插值，BrowserView 也在同步跟随，并不存在 drag 时那种"撕裂"可见窗口 | `useBrowserResizeFreeze.ts:126-134` |
| C-b | `handleResizeEnd` 的 0/80/160ms **三连 recapture** 属于"拖拽 settle"场景的保守设计，click-toggle 下完全不需要 | `useBrowserResizeFreeze.ts:149-162` |
| C-c | `useBrowserViewBounds` 的 effect（路径 ②）与 ResizeObserver（路径 ③）在 click-toggle 下**重复**做同一件事，前者 forceExact，后者每帧 | `useBrowserViewBounds.ts:245-264` vs `223-243` |
| C-d | `scheduleBoundsSync` 只按 rAF 合并，不按"经过了多少毫秒"合并；高频场景每帧都有 IPC | `useBrowserViewBounds.ts:131-152` |
| C-e | 主进程 `scheduleHostBounds` 的 16ms setTimeout 合并与 renderer 的 rAF 合并错位，叠加后吞吐达不到期望去重 | `host-layout-service.ts:122-135`（第 3 轮报告引用） |
| C-f | `workbench-canvas-shell` 带 `overflow: hidden` + `border-radius`，GPU 合成层每帧都要重算裁剪掩膜（在 BrowserView 下影响有限，但对 DOM 子树还是代价） | `styles/index.css` 搜 `workbench-canvas-shell` |
| C-g | `ChatPanel` 内部仍存在 backdrop-filter 的子面板？需要核对；第 2 轮 `879d56b` 把 theme 白名单里 backdrop-filter 去了，但 ChatPanel 自身的面板层还是液玻；点击 toggle → 宽度变 → blur 区也变 → GPU 重采样 | `components/agent/ChatPanel.tsx:3250-3290` + `styles/index.css` liquid 系列 |

### C6. 本问题背后"设计底层缺口"

1. **冻结帧的"用途白名单"不清晰**：冻结帧是拖拽 + 模式切换的遮盖工具；它被**串接**到 PANEL_RESIZE_STATE_EVENT 上意味着任何发出这个事件的路径（无论是否需要遮盖）都会吃 PNG 采样。需要把"dispatch resize state"与"需要冻结帧"解耦：click-toggle 路径**不需要**冻结帧，仅需要触发 bounds 同步。
2. **三路同步缺少唯一入口**：bounds 同步目前有 3 条独立触发路径（event / effect / observer），缺乏单一事实源。一个干净架构应该是：`所有 bounds 变化信号 → 单一 scheduler → IPC`，三条路径要么合一要么显式去重。
3. **主进程 bounds 合并周期 16ms 与 CSS transition 180ms 时间轴未校准**：理想情况下 180ms transition 在主进程应只看到 2 次 bounds 更新（开始 + 结束），其余插值交给 GPU。当前是"每帧都报"。
4. **IPC 总线没有优先级**：`captureWindowSnapshot`（重 IPC）与 `updateBounds`（高频 IPC）共用一条链路，重 IPC 会卡住轻 IPC。

---

## 4. 三个问题的"共同根"

从"界面各层级如何共享状态"的角度，三个问题都可归结为三条公共缺口：

**R1. 坐标 token 散落**（命中问题 A，部分命中 C）
- 右缘对齐 = `TopBar.paddingRight` 自己算；ChatHeader、StatusBar、FileManager 头自己算；没有共享 `--chat-column-right-edge` / `--workbench-right-edge` 语义变量。
- `WORKBENCH_TOPBAR_PADDING_RIGHT`、`WORKBENCH_EDGE_ICON_INSET`、`WORKBENCH_HEADER_EDGE_X` 三个 14/14.5/14 虽然数值接近，但语义不统一、没有"对齐"合约。

**R2. 时间轴 token 散落**（命中问题 B）
- 有 `MODE_TRANSITION_DURATION_MS`（WorkbenchMode）、`MODE_SWITCH_TIMELINE`（useRitualOverlay）、`MODE_SCENE_TRANSITION_MS`（ritual-overlay.css）、`WORKBENCH_PANEL_MOTION_DURATION_MS`（panel width 180ms）、`THEME_TRANSITION_DURATION_MS` ……散布四层。
- 没有一张"谁驱动谁、谁等谁结束"的明确依赖图。

**R3. IPC 节奏 token 散落**（命中问题 C）
- renderer rAF 合并（每帧 1 次）、主进程 setTimeout 16ms 合并、`FREEZE_RELEASE_DELAY_MS = 220`、`64ms` trailing settle、`80/160ms` recapture……互不引用，互不知道对方。
- 需要一个 **"bounds 同步规格"**：在 180ms 窗口内最多 N 次 IPC、快照 IPC 与 bounds IPC 的优先级、panel-toggle 场景是否豁免冻结帧。

---

## 5. 缺口 → 修复方向矩阵（只列方向，不含 PR 拆分）

| 编号 | 问题 | 方向 | 优先 |
|------|------|------|------|
| **A-1** | TopBar/ChatHeader 坐标系不一致 | 先与用户对齐"TopBar 右按钮应坐在哪"：方案 P1（右按钮 = ChatHeader 替身，TopBar 右按钮区完全删除，所有操作入口收到 ChatHeader），方案 P2（TopBar 右按钮移到 ChatPanel 上方、即设 `paddingRight: 14px` 不再读 gutter，接受按钮"坐在"面板上），方案 P3（引入共享 `--chat-right-edge` token，ChatHeader 的 padding-right 也读这个 token，从而两排按钮右缘相同）。 **P1 最彻底**——从用户截图看它也是最匹配需求（主题切换、用户头像、面板收起都属"当前聊天栏"范畴） | P0 |
| **A-2** | 全局右缘 token 缺失 | 引入 `--workbench-right-edge` CSS 变量 + 共用常量，覆盖 TopBar / ChatHeader / StatusBar / CollapsedChatRail；删掉 `WORKBENCH_EDGE_ICON_INSET 14.5 vs 14` 的 0.5px 漂移 | P1 |
| **A-3** | 全局左缘 token 缺失 | 引入 `--workbench-left-edge`；`ModeSlider.paddingLeft: 19` 与 `FileManager` 头 `14` 统一 | P1 |
| **A-4** | TopBar U 按钮绕过 IconButton | U 按钮归位到 `IconButton` 组件；如果需要字母内容，给 IconButton 加 `label?: string` prop | P2 |
| **A-5** | 无对齐回归测试 | 新增 `topbar-chatheader-right-align-contract.test.ts`：构造虚拟 DOM，校验两组右按钮的右缘 x 坐标差 ≤ 1px | P1 |
| **B-1** | 非 browser 切换吃满 ritual | 新增"切换路由表"：`(from, to) → strategy`。non-browser ↔ non-browser 改走纯 DOM 场景动画（仍用 280ms @keyframes），不经过 `withRitual` 的 overlay；`browser ↔ non-browser` 保留 ritual 但把 enter 从 120ms 收到 60ms（BrowserView hide 只需要一帧） | P0 |
| **B-2** | same→same 无短路 | `handleWorkbenchModeChange` 首行加 `if (next === current) return` | P0 |
| **B-3** | Thumb 与场景抢 GPU | 把 thumb 的 `box-shadow` 和 `background` transition 收窄到 `opacity` 单属性，或在场景动画期间用 `.workbench-mode-switching` class 暂停 thumb 的非位置过渡 | P1 |
| **B-4** | ModeScene 总 mount | 引入 `mode-lazy`：仅 keep-alive 最近 2 个模式的完整树，其它用 placeholder；BrowserMode 的 hook effects 在 `!isActive` 时早退 | P2 |
| **B-5** | `captureStableFrame` 尾随 180ms | 只在"最近 N 秒没有 snapshot"时跑；或改成 IntersectionObserver 触发 | P2 |
| **B-6** | ritual 在 panelResizing 时被吞 | 改为"排队"：panelResizing 结束后再执行 ritual；或者 panelResizing 时走 `runReduceMotionFlash` 路径 | P2 |
| **C-1** | 冻结帧误触发 | `useBrowserResizeFreeze.handleResizeState` 区分 "drag" 与 "click-toggle" 两种 resize（或者直接读 `event.detail.reason` 新字段）；click-toggle 路径完全不 capture snapshot、不跑 3 次 recapture | P0 |
| **C-2** | bounds 同步三路冗余 | 保留 `PANEL_RESIZE_STATE_EVENT` 作为唯一入口；删除 `useEffect(chatPanelVisible, …)` 里的 `sendBounds({ forceExact: true })`（它完全被 event 路径覆盖）；ResizeObserver 在 `panelResizingRef === true` 时退化为 no-op（因为 event 路径已经处理） | P0 |
| **C-3** | rAF 合并不够 | `scheduleBoundsSync` 改为"leading + trailing" 节流：resize 开始一次、结束一次，过程中由 CSS 插值 + native 跟随（native 允许小幅滞后） | P1 |
| **C-4** | 主进程 setBounds 合并与 renderer 不协同 | 主进程把 `syncMode: 'transient'` 改成"最低间隔 32ms 一次"，或接收 renderer 提供的 `intent: 'start' / 'animating' / 'end'` 标签 | P1 |
| **C-5** | 快照 IPC 与 bounds IPC 同道 | 给 `captureWindowSnapshot` 打 `low-priority` 标签，或在 `panelResizing` 内禁用 | P2 |
| **C-6** | ChatPanel backdrop-filter 依然活跃 | 核查液玻面板是否仍在每帧重采样；如是，在 `.resizing, .mode-switching` class 下改为单帧 cached | P2 |
| **R1** | 坐标 token 散落 | 建立 `src/renderer/modules/workbench/chrome-layout.ts`：统一导出 `EDGE_RIGHT`, `EDGE_LEFT`, `HEADER_GUTTER` 等语义变量，并注入对应 CSS 变量 | P1 |
| **R2** | 时间轴 token 散落 | 建立 `src/renderer/modules/workbench/motion-timeline.ts`：统一导出 `PANEL_WIDTH_MS=180`, `MODE_SCENE_MS=280`, `RITUAL_ENTER_MS=120` 等；CSS 通过 `:root { --panel-width-ms: 180ms }` 读取 | P1 |
| **R3** | IPC 节奏 token 散落 | 建立 `src/shared/browser-sync-contract.ts`：定义 bounds 同步合约（开始/过程/结束三态、节流约束） | P2 |

---

## 6. 度量建议（下一步修复前后对比）

| 场景 | 触发 | 指标 | 工具 |
|------|------|------|------|
| 浏览器模式收起 ChatPanel | 点 `PanelLeftClose` | 主进程 IPC 数 / 180ms、renderer rAF drop 数、Long Task 时长 | DevTools Performance + `ready-browser.log` |
| 浏览器模式展开 ChatPanel | 再点一次 | 同上 | 同上 |
| document↔rss 切换 | ⌘2 → ⌘3 | 从点击到 `document` 场景首帧可见的 wall time、ritual 持续时长 | performance.mark |
| 同模式点击 | ⌘2 → ⌘2 | 应为 no-op，期望 ≤ 2ms | performance.mark |
| TopBar 与 ChatHeader 按钮对齐 | 启动 + chat 展开/折叠 | `buttonRightEdge(topbar) - buttonRightEdge(chatheader)` 绝对值 | 新增测试（见 A-5） |

## 7. 不建议本轮介入的

- `Settings` 页（已在第 3 轮列为 C1–C17）。
- `liquid-glass-react` 密度调参（D6）——先完成动画协同后再决定。
- `PreviewBrowser` 平行 bounds（D7）——浏览器面板路径打通后再看。

---

## 8. 后续动作建议（顺序）

1. **先与用户确认 A1 方向的三选**（P1 / P2 / P3）—— 因为 A1 涉及 UX 取舍，不宜技术侧独断。本文档写出来的目的就是让用户看到后拍板。
2. 确认 A1 后，再生成一个综合 Plan 文档，把 A/B/C 三类修复和 R1/R2/R3 token 化一并编排（建议文件名 `docs/superpowers/plans/2026-04-18-workbench-align-and-motion-plan.md`）。
3. Plan 里需要包含：
   - 共享 token 先行（R1/R2/R3 是 A/B/C 的地基）
   - 冻结帧 click-toggle 豁免（C-1/C-2）最早落地，可立即止血动画卡顿
   - 非 browser 切换的快路径（B-1/B-2）
   - TopBar 对齐方案（依赖 A1 选型）
   - 契约测试（A-5, 以及"non-browser 切换无 ritual overlay"、"click-toggle 无 captureWindowSnapshot IPC"两条契约）

---

## 附录 A：核心证据索引（file:line）

**对齐**
- `src/renderer/components/layout/TopBar.tsx:40-98`（右按钮集群、line 48 padding 表达式）
- `src/renderer/components/agent/ChatHeader.tsx:178-267`（line 184 硬编码 padding、line 238-266 右按钮 IconButton）
- `src/renderer/pages/WorkbenchMode.tsx:164, 174, 262-275`（`chatShellWidth` 派生、写入 `--workbench-right-gutter`）
- `src/renderer/modules/workbench/chrome.ts`（`WORKBENCH_TOPBAR_PADDING_RIGHT = 14`, `WORKBENCH_EDGE_ICON_INSET = 14.5`, `WORKBENCH_HEADER_EDGE_X = 14`）
- `src/renderer/components/layout/StatusBar.tsx:18`
- `src/renderer/components/layout/ModeSlider.tsx:8`
- `src/renderer/components/layout/FilesPanel.tsx:332, 372`
- `src/renderer/components/agent/ChatPanel.tsx:1070-1111`（CollapsedChatRail）、`3250-3290`（外壳）
- `src/renderer/styles/index.css:2498-2521`（panel / TopBar 过渡、`body.resizing` 覆盖、reduce-motion）

**模式切换**
- `src/renderer/pages/WorkbenchMode.tsx:166-220`（handleWorkbenchModeChange）
- `src/renderer/modules/overlay/useRitualOverlay.ts:47-51`（MODE_SWITCH_TIMELINE）、`:122-255`（withRitual 主循环）、`:127-135`（panelResizing 短路）
- `src/renderer/components/layout/WorkbenchModeOutlet.tsx:34-39, 151-194`
- `src/renderer/components/layout/DraggableModeTabs.tsx`（thumb 路径）
- `src/renderer/modules/workbench/slider-motion.ts`（CLICK/SPRING 时长）
- `src/renderer/styles/workbench-sliders.css:207-233, 270-296`
- `src/renderer/styles/ritual-overlay.css:1-31, 112-150`
- `src/renderer/pages/modes/BrowserMode.tsx:270-353`（syncVisibleHost / captureStableFrame）

**浏览器面板卡顿**
- `src/renderer/modules/workbench/useTogglePanelWithResize.ts:1-92`
- `src/renderer/modules/browser/useBrowserViewBounds.ts:42-292`（measure / sendBounds / scheduleBoundsSync / 三路 effect）
- `src/renderer/modules/browser/useBrowserResizeFreeze.ts:85-189`（captureSnapshot, handleResizeStart/End, event listener）
- `src/renderer/styles/index.css:1230-1240`（`body.resizing` 白名单）、`:2498-2521`（panel width 过渡）
- `src/main/modules/browser-engine/host-layout-service.ts`（scheduleHostBounds, setHostBoundsNow —— 主进程合并路径；引用自 round3 审计）
- `src/main/modules/browser-engine/ipc-shell.ts:152-157`（`browser:updateBounds` handle + on 双注册）

**共性基础设施**
- `src/renderer/modules/browser/resize-events.ts`（`PANEL_RESIZE_STATE_EVENT`）
- `src/renderer/modules/workbench/useRafResizeDrag.ts`（drag 路径的 PANEL_RESIZE_STATE_EVENT dispatch）
- `src/renderer/modules/overlay/useRitualOverlay.ts:64-68`（`panelResizingActive` 信号）
