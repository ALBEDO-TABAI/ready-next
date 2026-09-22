---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../documentation-inventory.md)。

# Round 4 — 面板收放后的 UI 退步与缺口审计

> 基线：`c536ac6 fix(ui): restore mode-switch slide, icon-swap, panel-gutter alignment + trim browser sync`
> 审计日期：2026-04-18
> 审计范围：`TopBar` / `WorkbenchMode` / `ChatPanel` / `BrowserMode` / `useBrowserViewBounds` / `useRitualOverlay` / `workbench-sliders.css` / `index.css` 的面板收放路径

本轮优化把"模式切换滑动、图标交换、面板间隙对齐"三个回归修好了，但引入了新的 P0 回归与若干潜在缺口。本文档只做根因说明与缺口清点，**不涉及代码改动**；修复计划会落到后续的 Plan 文档里。

---

## 1. 现场回放（用户反馈）

1. 点击左侧 FileManager 或右侧 ChatPanel 的展开/收起按钮时：
   - **浏览器界面与标题栏错位**：原生 `BrowserView` 的 bounds 与外层假 chrome 在 180ms 动画期间错开，产生可见的拉伸/裂缝（见 screenshot 1 / 2）。
   - **右上角三颗按钮位置被推移**：收起 ChatPanel 时，"U / 主题切换 / 面板收起" 三个按钮会瞬移到最终位置，而面板本身仍在 180ms 内缓动，视觉上与面板左缘脱节（见 screenshot 3）。
2. **Agent Chat 输入框位置明显偏上**，与最初版本差距较大。
3. 面板收起/展开过程中，native BrowserView 偶尔会在动画结束后仍停留在中间尺寸，直到下一次任意尺寸变化才纠正。

---

## 2. 三个 P0 回归的根因

### Bug 1 — BrowserView 与假 chrome 在 180ms 动画期间错位

**现象**：点击面板收放按钮后，原生浏览内容（native overlay）与周围 DOM（标签栏、地址栏、圆角卡壳）出现纵向/横向的撕裂。

**涉及路径**：
- `src/renderer/styles/index.css:2498-2503`
- `src/renderer/pages/WorkbenchMode.tsx:164, 262`
- `src/renderer/modules/browser/useBrowserViewBounds.ts:245-264`
- `src/renderer/pages/modes/BrowserMode.tsx:309-332`
- `src/renderer/modules/browser/useRafResizeDrag.ts:72-85`
- `src/renderer/modules/workbench/useRafResizeDrag.ts`（仅拖拽时触发 `PANEL_RESIZE_STATE_EVENT`）

**机理**：
1. `[data-liquid-shell='side-panel'], [data-liquid-shell='chat-panel']` 上有 `transition: width 180ms cubic-bezier(...)`（`index.css:2498-2503`）。点击收放按钮时 `chatShellWidth` / `sidebarShellWidth` 状态瞬变，面板 DOM 的 `width` / `minWidth` 通过 CSS 过渡在 180ms 内缓动。
2. `useBrowserViewBounds.ts:245-264` 里，`chatPanelWidth` / `chatPanelVisible` / `effectiveSidePanelWidth` / `sidebarVisible` 只会在**状态翻转的那一帧**触发一次 `sendBounds({ forceExact: true })`；该 sync 通过 `requestAnimationFrame` 调度，在第 1 帧测量到的 `getBoundingClientRect()` 仍属于过渡起始附近的中间态。
3. 测量结束后 `scheduleBoundsSync` 会注册一个 **64ms trailing settle**（`useBrowserViewBounds.ts:146-149`），但这距离 CSS 过渡完成（180ms）还差近 120ms，settle 同样落在中间态，**没有尾帧再补一次**。
4. `PANEL_RESIZE_STATE_EVENT` 只在 `useRafResizeDrag` 真正拖拽时派发（`useRafResizeDrag.ts:72, 85`）。**点击按钮收放不是拖拽**，所以不会进入 `useBrowserViewBounds.ts:278-280` 的 `scheduleBoundsSync('settled', { force: true })` 分支，结果是 180ms 内 native BrowserView 只 setBounds 一到两次，剩下的时间停在中间几何。
5. `BrowserMode.tsx:337-341` 的"layoutPhase === 'idle' 就再同步一次"也不会兜底：收放面板不会拨动 `browserLayoutPhase`，它只在模式切换里才改。
6. 结果：DOM 假 chrome 在 180ms 内丝滑变宽，native BrowserView 要么停在旧尺寸、要么跳到中间尺寸并卡住，两者错位 → 用户肉眼看到"拉伸 / 错位"。

**修复方向**（只列方向，后续 plan 定具体落点）：
- **方向 A（首选）**：面板收放也发 `PANEL_RESIZE_STATE_EVENT`。不通过 `ResizeHandle`，而是在 `toggleChatPanel` / `toggleSidebar` 的 setState 前后分别 dispatch `{ resizing: true }` 与延迟 180ms 的 `{ resizing: false }`，复用现有 resizing ref 与 settled sync 路径。
- **方向 B**：`scheduleBoundsSync` 在 click-toggle 路径上注册一次 180–220ms 的 trailing settle，覆盖 CSS 过渡尾帧；或者监听面板根 DOM 的 `transitionend` 事件做兜底。
- **方向 C（补充）**：`ResizeObserver` 已经绑在 `contentRef` 上（`useBrowserViewBounds.ts:233-234`），但它只在尺寸真正变化时才触发。可以验证它在 180ms CSS 过渡期间是否被节流成单次；如果是，考虑去节流或用 `getBoundingClientRect` 的多帧采样替代。

### Bug 2 — TopBar 右上角三颗按钮被瞬移

**涉及路径**：
- `src/renderer/components/layout/TopBar.tsx:40-98`
- `src/renderer/pages/WorkbenchMode.tsx:262`
- `src/renderer/styles/index.css:2498-2503`

**机理**：
1. `TopBar.tsx:48` 的 `paddingRight: calc(var(--workbench-right-gutter, 0px) + ${WORKBENCH_TOPBAR_PADDING_RIGHT}px)` 绑定了 `--workbench-right-gutter` CSS 变量。
2. 该变量由 `WorkbenchMode.tsx:262` 上的 `style={{ '--workbench-right-gutter': '${chatShellWidth}px' }}` 直接写入；`chatShellWidth` 是派生自 `chatPanelVisible ? chatPanelWidth : WORKBENCH_EDGE_RAIL_SIZE`（`WorkbenchMode.tsx:164`）。
3. 用户点击收放按钮时，`chatShellWidth` 从 ~350 → ~40（或反向），**CSS 变量一帧内跳变**，`TopBar` 的 `paddingRight` **没有附加 transition**，也就是一帧内瞬移到最终值。
4. 与此同时，ChatPanel 本身通过 `index.css:2498-2503` 的 `transition: width 180ms` 缓动其宽度 → 结果是 `TopBar` 右缘（内容）已经对齐"最终的 ChatPanel 左缘"，但 ChatPanel 的真实左缘还在原处，视觉上三颗按钮像"提前跳到新位置"，面板动画完成后再对齐。
5. `TopBar` 内的右侧三颗按钮容器本身是 `flex-shrink-0`，但它由 `justify-between` + `paddingRight` 共同决定可见 x 坐标，所以根源不是按钮组布局，而是 `paddingRight` 没有参与 180ms 过渡。
6. 另外当 `chatPanelVisible` 从 true → false 时，第三颗按钮（`PanelLeftClose`）直接卸载（`TopBar.tsx:90-97`），`flex` 容器尺寸一帧内变短；这个卸载也**没有过渡**，叠加上面那一跳，三颗按钮同时被推移一次后再被推移一次。

**修复方向**：
- **方向 A（首选）**：给 `TopBar` 的 `paddingRight` 加一条与面板同步的过渡（`transition: padding-right 180ms cubic-bezier(0.22, 1, 0.36, 1)`），或者用 `calc(var(...))` 经由中间变量 + `@property` 注册以获得 interpolatable padding。
- **方向 B**：把 `--workbench-right-gutter` 的更新也放进 resizing 信号里——面板收放开始时先把变量写入，过渡内用 CSS transition 驱动；避免在 ResizeHandle 拖拽期间出现双重过渡叠加（拖拽期本来要 `body.resizing` 关过渡）。
- **方向 C**：第三颗按钮的 mount/unmount 改为 `opacity + pointer-events` 切换，宽度在 180ms 内平滑归零；或直接保留 DOM 仅切可见度。

### Bug 3 — ChatPanel 输入框相对位置偏高

**涉及路径**：
- `src/renderer/components/agent/ChatPanel.tsx:998-1058`（`ChatPanelMotionLayer`，grid 布局）
- `src/renderer/components/agent/ChatPanel.tsx:3250-3265`（外壳，`width`/`minWidth` 吃 `shellWidth`）
- `src/renderer/pages/WorkbenchMode.tsx:289-291`（TopBar 在面板外层，ChatPanel 在下一行）
- `src/renderer/modules/workbench/chrome.ts`（`WORKBENCH_TOPBAR_HEIGHT`）

**机理**：
1. 全局 `TopBar` 渲染在 `WorkbenchMode.tsx:289`，属于 workbench 根 `flex-col` 的第 1 行；ChatPanel 被放在**下一行**的 `flex` 容器里（`WorkbenchMode.tsx:291-346`），所以 ChatPanel 的顶部 y 坐标 = `TOPBAR_HEIGHT`。
2. `ChatPanelMotionLayer` 内部（`ChatPanel.tsx:1013-1026`）又用 `grid-template-rows: ${WORKBENCH_TOPBAR_HEIGHT}px minmax(0, 1fr)` 在面板**内部再留一行 "`TOPBAR_HEIGHT` 的 header"** 来放 `ChatHeader`；结果 `ChatHeader` 的顶部是 `TOPBAR_HEIGHT`，其下是消息/输入区。
3. 这其实是设计有意的双段高度（全局 TopBar + 面板 ChatHeader），但因为 ChatPanel 的顶部没有向上**负偏移**覆盖到 TopBar 区域，消息区的实际顶 = `2 * TOPBAR_HEIGHT`，整条面板可用高度被压缩。
4. `ChatMessages` 的滚动容器是 `1fr` 弹性，`ChatInput` 在 `<ChatInput/>` 被放在 body 内（`ChatPanel.tsx:3214-3244`），输入框是 body 下缘的 flex item。只要面板高度压缩，message 列表紧缩后的自然滚动高度 + 输入框整体向上提起，造成"输入框位置明显偏高"。
5. 历史 commit `457e40f refactor: tighten workbench panel motion handoff` 把以前的两段 motion layer 合并，grid 结构延续了 `WORKBENCH_TOPBAR_HEIGHT` 这一行（见 `457e40f` 的 diff 4 — grid 原本就在，没有被替换，但旧版里 motion layer 占用空间的时机不同，展开期间有视觉缓冲）。新版 `AnimatePresence initial={false} mode='wait'` + 固定 grid 直接以最终尺寸渲染，没有任何过渡缓冲，导致"输入框位置"直接跳到最终偏高位。
6. 另外 `panelState === 'expanding'` 期间 `ChatPanelMotionLayer` 初始 `x` 偏移 `WORKBENCH_PANEL_MOTION_OFFSET_PX`，但这只是水平位移动画，输入框本身在纵向仍是最终位置。

**修复方向**：
- **方向 A（结构性）**：让 ChatPanel 的顶部 y 与全局 TopBar 对齐或向上偏移 `-TOPBAR_HEIGHT`，使 `ChatHeader` 直接替代顶部 TopBar 区在右侧的可见性；或删除面板内的 grid 头行，`ChatHeader` 改为浮动在面板顶端，消息/输入区占满。
- **方向 B（最小改动）**：把面板内 grid 的 header 行高度从 `WORKBENCH_TOPBAR_HEIGHT` 减到 `WORKBENCH_CHAT_HEADER_HEIGHT`（新常量，约 `TOPBAR_HEIGHT - 12`），把压缩掉的高度归还给输入区。需核对设计稿。
- **方向 C（视觉校准）**：先确认是否"输入框偏高"其实是消息区被压缩 → 输入框相对位置上移。如果是，直接优先处理面板高度可用空间；如果不是，则是 `ChatInput` 内部 padding 的微回归。
- **方向 D（过渡）**：在 `panelState === 'expanding'/'collapsing'` 期间把 body 的 `opacity` 缓动（保留结构）而不是 `x`，让输入框位置的跳变被淡出淡入遮盖，而不是一上来就以最终位置出现。

---

## 3. 其它未报告但已在代码里的缺口

### G1 — overlayLockCount 的 600ms 自愈 短于 theme-transition 时间线

`useBrowserViewBounds.ts:7` 常量 `OVERLAY_LOCK_SELF_HEAL_MS = 600`。
`useRitualOverlay.ts:53-57` 的 theme-transition 总时长 = 160 + 440 + 200 = **800ms**。
在 theme-transition 中途 self-heal 触发会把 BrowserView 提前显露出来，干扰主题过渡的遮罩。建议：自愈时间 ≥ 900ms，或改为绑定到 `session` 的 `leaving` 阶段结束事件。

### G2 — withRitual 在 panelResizingActive 时静默跳过 ritual

`useRitualOverlay.ts:127-135`：当 `panelResizingActive === true` 时，`withRitual` 直接执行 workFn 不进入 ritual overlay。
- **隐患 A**：用户拖拽面板时刚好按下主题切换键，主题切换会**裸奔**（没遮罩），闪屏风险。
- **隐患 B**：`setPanelResizingSignal` 只在拖拽 + 卸载时被调用；如果 ResizeHandle 拖拽过程中触发了某些导致 `WorkbenchMode` 瞬时 unmount-remount 的流程（HMR、外部路由），`panelResizingActive` 可能残留 `true`。
建议：主题/模式切换在 resizing 时排队，拖拽结束再跑 ritual；或者 `withRitual` 在 resizing 时走"简化 ritual"（只做必要的 BrowserView mask）。

### G3 — `--workbench-right-gutter` 只在 workbench-mode-root 上，未覆盖其它顶层入口

`WorkbenchMode.tsx:262` 在 `.workbench-mode-root` 内联写入 CSS 变量。全局 TopBar 在同一根下正常读到；但如果后续出现 Split 模式 / Floating mode 的其它渲染出口，它们没有这份内联变量，`TopBar.tsx:48` 会退到 fallback `0px`，padding 瞬变。
建议：把该变量通过 `<html>` 或 `body` 层统一写入，避免 scope 漂移。

### G4 — 面板内 grid header 行固定为 `WORKBENCH_TOPBAR_HEIGHT`

`ChatPanel.tsx:1016` 硬编码 `gridTemplateRows`。
- 设计上双 header（全局 TopBar + 面板 ChatHeader）视觉重复。
- 导致 Bug 3 里的高度压缩。
建议：把面板内 header 高度独立为 `WORKBENCH_CHAT_HEADER_HEIGHT`，或让 ChatHeader 通过绝对定位 / 负 margin 与全局 TopBar 水平贴合而不占面板纵向空间。

### G5 — ResizeObserver 在 CSS transition 期间节流/合并

`useBrowserViewBounds.ts:233-234` `new ResizeObserver(handleBoundsShift)`。
Chromium 的 ResizeObserver 在连续 rAF 过渡中会合并回调，可能每帧只给一次，但触发频率和 rAF 调度不是 1:1。结合 Bug 1，过渡中间态的 bounds 会被 setBounds 多次，但尾帧不一定有回调（如果最后一帧的 `contentBoxSize` 与前一帧相同，ObserverCallback 不会再触发）。
建议：除了 ResizeObserver，额外监听根 DOM 的 `transitionend`（`width` / `min-width` 属性）做兜底。

### G6 — `captureStableFrame` 的 2s token 与 layoutPhase 的依赖方向耦合脆弱

`BrowserMode.tsx:270-307`：`isActive` 翻转时下发 token，`layoutPhase === 'idle'` 时消费。
如果浏览器进入后 `layoutPhase` 从未回到 `'idle'`（例如 mode-switch ritual 被 abort），token 永远不会被消费，只能等 2s 超时自愈后不再捕获 → `setIsBrowserSurfaceReady(true)` 永远靠 fallback 48ms 定时器兜底。
建议：token 设计里加一个"在超时之前若未消费则强制尝试一次"的兜底分支。

### G7 — `body.resizing` 仅覆盖 liquid-shell，未覆盖 TopBar padding

`index.css:2505-2507` 在拖拽期间关掉面板的 width 过渡，但 TopBar 的 `paddingRight` 本就没过渡（见 Bug 2）。反而在**非拖拽的 click-toggle 流程**里，`paddingRight` 应该过渡却没过渡。
当前的 `body.resizing` 标志与这里的 padding 问题正交，但修复 Bug 2 时需要明确："拖拽时 padding 不过渡，click-toggle 时 padding 过渡" → 两种路径独立开关。

### G8 — `WorkbenchModeOutlet` 四个 mode 同时挂载，消耗额外 bounds 带宽

`WorkbenchModeOutlet.tsx:181-194` `ALL_WORKBENCH_MODES.map(...)` 每次 render 都渲染四个 mode scene。BrowserMode 的 `useBrowserViewBounds` effect 在所有 mode 都挂着时都会跑，`isActive` 为 false 的分支理应走 `hideAll()`，但每次 width 依赖变化都会重新 schedule sync。
这是既有设计，但在本轮面板收放路径上会放大"每次 resize 都跑一次多余 sync"。属 P3 观察项，不紧急修。

### G9 — `MorphIconRailGroup` 依赖 `:has()` 选择器（`workbench-sliders.css:94`）

已知 `:has()` 在 Electron 34 (Chromium 130+) 稳定支持。风险不大，但若未来兼容旧内核需保留回退态。

### G10 — 主题切换期 `Moon` 图标停在面板按钮上会被 `disabled`，但视觉没有反馈

`TopBar.tsx:85` `disabled={isThemeRitualRunning}`。用户快速点击可能会按错，UI 没明显 disabled 态。属小缺口，可在 IconButton 内加 `cursor: not-allowed` + opacity。

### G11 — 拖拽 ResizeHandle 时 `paddingRight` 因为 body.resizing + CSS 变量被双重抑制

拖拽期 `body.resizing` 关了面板 width 过渡，但 `--workbench-right-gutter` 的值仍然每帧更新（`WorkbenchMode.tsx:262` 读 state）→ TopBar padding 每帧跟上。这与点击路径行为不一致（点击是瞬变，拖拽是跟随）。用户可能感到两种路径手感不同。建议把 click-toggle 路径行为统一到拖拽路径：padding 永远跟 state 走，仅在点击时人为插入一个 180ms 过渡窗口（见 Bug 2 方向 A）。

### G12 — `StatusBar` 与 `ChatPanel` 的 z-index / 定位关系未审

`WorkbenchMode.tsx:349` `<StatusBar />` 在 `ChatPanel` 所在 flex 行下方。本轮没有修改该行，但因为 ChatPanel 现在是 `flex-1 flex overflow-hidden` 行里的最后一个子，且内部 grid 固定，StatusBar 的纵向高度挤压会进一步改变 ChatPanel body 的可用高度（延伸自 Bug 3）。核对 StatusBar 有无变化。

---

## 4. 本轮审计结论

- **Bug 1 / Bug 2 本质同源**：面板 width 用了 180ms CSS transition，但 BrowserView bounds 同步与 TopBar `paddingRight` 都**没有对齐**这条时间轴——Bug 1 在 native 层错位，Bug 2 在 DOM 层错位。
- **Bug 3** 是 ChatPanel 内部 grid 的结构问题，和本轮 P0 修复间接相关（因为 motion layer 的重构使得固定 grid 的影响更明显），需要独立的结构方案解决。
- **G1 / G2 / G6** 是 ritual overlay 与 browser bounds 之间时序耦合的副作用，建议后续单独开一个"overlay ↔ browser lifecycle"的小规划处理。
- **G3 / G7 / G11** 集中在 CSS 变量传播与过渡时间轴的对齐，修 Bug 2 时一起处理。
- **G4 / G12** 属布局常量与面板内部结构，修 Bug 3 时一起处理。

---

## 5. 后续动作建议（仅做定位，不含落地细节）

1. 新开 Plan：`2026-04-18-workbench-panel-toggle-sync-plan.md`，聚焦三件事
   - "click-toggle 也走 resizing 信号" 的闭环（Bug 1 + G11）
   - TopBar `paddingRight` 与 `--workbench-right-gutter` 的共同过渡（Bug 2 + G3 + G7）
   - ChatPanel 内部 grid header 高度重新设计（Bug 3 + G4 + G12）
2. 小补丁单列：
   - `OVERLAY_LOCK_SELF_HEAL_MS` 调到 ≥ 900ms（G1）
   - `withRitual` 在 resizing 时的排队语义（G2）
   - IconButton 的 disabled 视觉反馈（G10）
3. 验收清单：
   - 点击左/右面板收放按钮，native BrowserView 与假 chrome 在 180ms 内**同步**到最终尺寸，无中间态停留。
   - 点击收放按钮期间，右上角三颗按钮位置**平滑过渡**到新位置，不瞬移。
   - ChatPanel 展开后输入框位置与旧版一致（需提供一版基准截图）。
   - 拖拽与点击两条路径在面板收放上的视觉行为一致（无"两种手感"）。
   - theme-transition 期间面板宽度/BrowserView 不被 self-heal 过早打穿。
