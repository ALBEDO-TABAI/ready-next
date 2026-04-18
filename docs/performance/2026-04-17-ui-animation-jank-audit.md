# Ready Workbench — UI / Animation Jank 审计报告

> 生成时间: 2026-04-17
> 作者: Claude (Opus 4.7) — 仅做代码级审计，**未执行任何代码修改**
> 范围: 模式切换、面板展开/收起、窗口缩放、主题切换四类交互的卡顿/掉帧根因分析
> 输出: 结论清单 + 证据引用 + 分级优化建议。后续再拟定实际执行计划。

---

## 0.1 2026-04-18 已采用方案更新

这份文档最初只负责审计，不记录实施。`2026-04-18` 已按本报告里的 `P0` 方向完成第一轮基建改造，当前以代码真相为准，已采用方案如下：

- 面板开合不再让 `SidePanel` / `ChatPanel` 自己持续做 `width / min-width` 补间。改为工作台壳层先确定占位宽度，面板内容只做进出场位移动画；侧栏关闭后再回收占位，聊天栏收起后保留窄边栏占位。
- 面板拖拽不再把每次 `mousemove` 都直接打进状态。拖拽改成每帧最多提交一次宽度变化，减少高频重排和 BrowserView 跟随抖动。
- BrowserView bounds 现已区分 `transient` 与 `settled` 两类同步：
  - 过渡中和拖拽中允许按一帧合并；
  - 最终落点立即直达，不再把最后一次精确落位也拖慢。
- Browser 模式切入切出不再在第一帧强制抓图。改成优先复用标签级稳定静帧缓存；浏览器重新稳定可见后，再用短延时刷新缓存。
- `WorkbenchMode` 切走 browser 时会先隐藏原生层，再交给缓存静帧或轻遮罩接管，不再靠模式切换瞬间的同步抓图硬顶首帧。
- 主题切换已改成两段式：
  - 先给根节点加 `data-theme-transitioning="true"`；
  - 下一帧再切 `data-theme`；
  - 再下一帧同步原生主题；
  - 固定短时长后清掉过渡标记。
- 工作台主链路已开始清理泛化过渡：
  - `TopBar / IconRail / Browser header / Chat header / Chat panel` 的关键交互不再使用 `transition-all`；
  - `tiptap.css` 里 3 处 `transition: all` 已改成属性白名单。
- `P2` 第二轮细节收口已补上以下条目：
  - `MorphIconRailGroup` 不再依赖 `layout` / `layoutId` 迁移 thumb，改成单个 thumb 通过索引位移移动，并把“浮起/下陷/记忆态”的时长压缩到短节奏。
  - `SidePanel` 的瀑布切换层移除了手工 `translateZ(0)` 与 `backfaceVisibility: hidden`，避免在玻璃壳层里继续拆合成层。
  - 文档定位高亮不再通过 `box-shadow` 闪烁做强调，改成更短的底色 + `outline` 提示；高亮停留时间同步缩短。
  - `EventModal` / `NewEventMenu` 剩余的 `transition-all` 与 `transition: all` 已改成属性白名单。
  - `P2` 里关于 `WorkbenchModeOutlet` 冗余隐藏方式和 `tiptap.css` 的 `transition: all`，当前已通过代码与测试双重锁定，作为回归保护保留。
- `O13`（BrowserView overlay 额外 fade）在这轮复查后**主动跳过**：
  - 当前浏览器模式已经同时具备缓存静帧、冻结帧淡出和过渡遮罩接管；
  - 本轮未再追加新的遮罩淡出逻辑，避免对现有稳定链路做无收益扰动。

下面正文里的问题分析仍然保留审计时的根因判断，但“建议实施项”里凡是与上述条目重复的，以当前代码实现为最新状态。

---

## 0. 结论先读 (TL;DR)

当前掉帧并非由某一处单点性能问题引起，而是由 **"多个昂贵动画在同一时间窗口内并发触发"** 造成的系统性压力。最关键的几条：

1. **`SidePanel` 与 `ChatPanel` 都在动 `width / min-width`**——这是布局动画，每一帧都强制 reflow，会带着 `IconRail`、`WorkbenchModeOutlet`、`BrowserView bounds` 一起抖。
2. **`WorkbenchModeOutlet` 所有模式常驻 + 水平 translateX 滑动**——切换瞬间 4 个重量级子树同时参与合成，且 `WorkbenchMode` 还并发触发 `BrowserView.hideAll()`/`showActive()` 原生层抖动。
3. **主题切换瞬时失效**——`data-theme` 改写后 30+ 个 `backdrop-filter` 图层、液态玻璃 `liquid-glass-react`（基于 SVG `feDisplacementMap`）全部重新合成，且 CSS 变量无过渡过桥。
4. **全站 30 个文件使用 `transition-all`/`transition-colors`**——主题切换时这些元素同时发起 color/background/border 过渡，叠加 backdrop-filter 重算，GPU & 主线程同时压满。
5. **`useBrowserViewBounds` 在拖动/滚动时每帧 RAF**，IPC 同步 `updateBounds`，且多个资源监听者叠加未节流。

---

## 1. 模式切换 (browser / document / rss / calendar)

### 1.1 证据

**`src/renderer/components/layout/WorkbenchModeOutlet.tsx:68-111`** — 所有模式常驻、横向 flex、在整个容器上做 `transform: translateX(-N * 100%)`：

```tsx
<div
  className="flex h-full w-full"
  style={{
    transform: `translateX(-${activeIndex * 100}%)`,
    transition: isMotionSettled ? 'none' : 'transform 0.35s cubic-bezier(0.24, 1, 0.36, 1)',
    willChange: isMotionSettled ? 'auto' : 'transform',
  }}
>
  {ALL_WORKBENCH_MODES.map((modeKey, index) => {
    // 相邻模式: 正常渲染；其它: contentVisibility: hidden + visibility: hidden
  })}
</div>
```

**`src/renderer/pages/WorkbenchMode.tsx:190-224`** — 切换时设置 `isMotionSettled=false`，350ms 后恢复：

```tsx
if (!isRedirectingDuringMotion && transitionTargetModeRef.current === 'browser' && nextMode !== 'browser') {
  window.dispatchEvent(new CustomEvent('ready:browser-capture-freeze'))
}
if (!isRedirectingDuringMotion) setIsMotionSettled(false)
setWorkbenchMode(nextMode)
transitionTimerRef.current = window.setTimeout(() => setIsMotionSettled(true), 350)
```

**`src/renderer/modules/browser/useBrowserViewBounds.ts:123-153`** — `syncBrowserVisibility` 在动画期间强制 `browser.hideAll()`：

```ts
if (!isVisibleAllowedRef.current) {
  window.electronAPI?.browser?.hideAll()
  return
}
// ...
await window.electronAPI?.browser?.showActive()
```

### 1.2 根因

| # | 问题 | 为什么卡 |
|---|------|----------|
| M1 | 4 个模式面板常驻 DOM（含 tiptap 编辑器、schedule-x 日历、rss 预览），slide 动画期间浏览器需把所有子树合并到一个合成层 | `translateX` 理论是 GPU，但子树中存在 `backdrop-filter`、`filter: blur()`、`liquid-glass-react`（SVG filter）—— 这些会**拆分合成层**或**打破 GPU 加速**，回退到主线程合成 |
| M2 | `visibility: hidden` + `contentVisibility: hidden` **同时** 设置——冗余，但 `visibility: hidden` 仍会保留 paint tree 参与 style 计算 | 多余的 style 计算成本；更推荐 `display: none` 或纯 `content-visibility: hidden` + `contain-intrinsic-size` |
| M3 | 切换触发链：① 状态写入 → ② React re-render Outlet → ③ CSS transform 启动 → ④ BrowserView IPC `hideAll` → ⑤ 350ms 后 `showActive + updateBounds` | **IPC 往返 + 原生层显隐** 与 **DOM transform 动画** 并发，二者时序无同步信号，原生层常在 DOM 动画中间位置"闪现" |
| M4 | `ready:browser-capture-freeze` 在切换时即时触发离屏截图（同步 IPC 或高开销） | 切换动画首帧就要先同步做一次 webContents capture —— 直接卡第一帧 |

### 1.3 次生问题

- `WorkbenchModeOutlet` 每次父组件 re-render 都会重新 `useMemo` `activeIndex`（依赖 `mode`），再触发 4 个子组件的 props 重建 —— 如果子组件没有 `React.memo`，会级联 re-render。
- `MorphIconRailGroup.tsx` 里 `layoutId="icon-rail-main"` 的 framer-motion layout 动画，在模式切换瞬间也可能被触发 reflow（因为 `activeIcon` 映射自 `sidePanelVariant`）。

---

## 2. 面板展开 / 收起 (SidePanel + ChatPanel + 拖拽 Resize)

### 2.1 证据

**`src/renderer/components/layout/SidePanel.tsx:200-217`** — 面板**同时**动 `width` 与 `min-width`（布局动画）并在内部跑 framer-motion y 轴动画：

```tsx
<div
  style={{
    width: isVisible ? panelWidth : 0,
    minWidth: isVisible ? panelWidth : 0,
    transition: 'width 300ms ease-in-out, min-width 300ms ease-in-out',
  }}
>
  <AnimatePresence initial={false} mode="sync" custom={…}>
    {isVisible ? renderAnimatedPanel(...) : null}
  </AnimatePresence>
</div>
```

**`src/renderer/components/agent/ChatPanel.tsx:3280-3293`** — `ChatPanel` 完全一样的 pattern：

```tsx
style={{
  width: chatPanelVisible ? chatPanelWidth : WORKBENCH_EDGE_RAIL_SIZE,
  minWidth: chatPanelVisible ? chatPanelWidth : WORKBENCH_EDGE_RAIL_SIZE,
  transition: 'width 260ms cubic-bezier(0.22, 1, 0.36, 1), min-width 260ms cubic-bezier(0.22, 1, 0.36, 1)'
}}
```

**`src/renderer/pages/WorkbenchMode.tsx:27-64`** — 手动拖动 resize 时 mousemove 直接 `setWorkbenchSplitRatio` / `setSidePanelWidth`，没有 RAF 批处理，每次 mousemove 都会触发 zustand 更新 + React re-render。

### 2.2 根因

| # | 问题 | 为什么卡 |
|---|------|----------|
| P1 | 动 `width` / `min-width` = **Layout-triggering property** | 每一帧都走 Layout → Paint → Composite 的完整 pipeline；300ms × 60fps ≈ **18 帧 reflow** |
| P2 | reflow 扩散：SidePanel 宽度变 → 中间 Workbench flex-basis 变 → `contentRef.getBoundingClientRect()` 变 → `ResizeObserver` 触发 → IPC 更新 BrowserView bounds | 每一帧都跑一次上面的链路，放大 18 倍 |
| P3 | SidePanel 内部同时在跑 framer-motion 的 `y: 72%→0` / `y: 100%→0` 进场动画 | GPU transform 动画与 CPU layout 动画**交叉抢帧**，framer-motion 侧无法预测父元素的 width 变化，导致抖动 |
| P4 | `mode="sync"` 的 AnimatePresence：退出元素与进入元素**同时在场** | 进入的 `files` / `search` / `skills` 面板都挂着 `backdrop-filter`（`.glass-surface-panel` 等），瞬间双倍合成层 |
| P5 | `ResizeHandle` mousemove → `setSidePanelWidth(current + delta)` **无节流、无 RAF** | 16ms 内可能多次触发 setState；zustand → React → CSS 计算全部串行跑在主线程 |

### 2.3 次生

- `sidebarVisible` 变化时，`useBrowserViewBounds.ts:180-197` 的 effect（deps 包含 `effectiveSidePanelWidth / sidebarVisible / sidePanelVariant / chatPanelVisible / chatPanelWidth`）会**再度触发 `startBoundsTracking`**，继续每帧 IPC `updateBounds` 追踪 420ms。期间用户按住 drag 会造成 IPC 队列堆积。

---

## 3. 窗口缩放 (Electron 窗口尺寸改变)

### 3.1 证据

**5 个独立 `window.resize` 监听**（无全局节流 hub）：
- `src/renderer/modules/browser/useBrowserViewBounds.ts:170`
- `src/renderer/components/agent/ChatHeader.tsx:153`
- `src/renderer/components/layout/FilesPanel.tsx:190`
- `src/renderer/components/rss/PreviewBrowser.tsx:111`
- `src/renderer/components/document/widget-sanitizer.ts:193` (widget iframe 内)

**5 个 `ResizeObserver`**：`TabRail`、`DocumentTabRail`、`PreviewBrowser`、`widget-sanitizer`、`useBrowserViewBounds`。

**`useBrowserViewBounds.ts:78-108`** — `startBoundsTracking` 拖动期间 **每帧 RAF** 调用 `sendBoundsImmediate → updateBounds IPC`：

```ts
const tick = () => {
  void sendBoundsImmediate({ forceExact: true })
  if (isManualResizing || now - startedAt < durationMs) {
    boundsTrackingRafRef.current = requestAnimationFrame(tick)
  }
}
```

### 3.2 根因

| # | 问题 | 为什么卡 |
|---|------|----------|
| R1 | 5+ 独立 resize 监听器未共享节流 | window resize 一次 burst 可产生 10~30 次事件，每次都串行跑一轮 getBoundingClientRect + setState |
| R2 | 每帧同步 IPC `browser.updateBounds` | IPC 是异步，但 renderer 本身 60fps 发包依然有序列化成本，且主进程 `BrowserView.setBounds` 本身在 macOS 上有 native window 重排成本 |
| R3 | `ResizeObserver(handleBoundsShift)` + `window.addEventListener('resize')` **两者都注册** | 窗口缩放时两条路径都会触发 —— 冗余；ResizeObserver 已能覆盖 |
| R4 | 拖 resize-handle 时 body 上 `resizing` class 加上后，`useBrowserViewBounds` 进入每帧 IPC 模式 420ms；期间 renderer 自己也在每次 mousemove re-render zustand store → 组件树 | 原生层追踪 + DOM 重排 + zustand 广播，三线并发 |

---

## 4. 主题切换 (light ↔ dark)

### 4.1 证据

**`src/renderer/stores/useTheme.ts:40-46`** — 切换方式是改 HTML attribute，瞬时生效：

```ts
const applyColorTheme = (resolved, option) => {
  document.documentElement.setAttribute('data-theme', resolved)
  window.electronAPI.theme.set(option)  // 同步给 Electron nativeTheme
}
```

**`src/renderer/styles/index.css:145-248`** — dark mode 下 **50+ CSS 变量**一次性切换（`--bg-*`, `--text-*`, `--border-*`, `--shadow-*`, `--lg-material-*`, `--lg-blur-*` …）。

**`src/renderer/styles/index.css`** — **42 处 `backdrop-filter` 声明**（`.glass-surface-panel/card/floating`, `.lg-surface-*`, `.ready-floating-menu`, `.content-surface-*`, `.browser-header-surface`, `.workbench-tabs-surface`, `.document-path-bar`, `.rss-preview-surface` …），且都引用 `var(--lg-blur-*)` / `var(--surface-saturate)` —— 值变了就要重新合成模糊。

**`src/renderer/components/ui/LiquidGlassScene.tsx:42-101`** — `liquid-glass-react` 用在 button/card/panel 三个 tone，每个实例都有 `displacementScale: 76-100`、`aberrationIntensity: 1.8-2` —— 这是 **SVG `feDisplacementMap` + `feColorMatrix`** 过滤器，GPU 不加速、每帧需要重算。全屏 `LIQUID_PANEL_SHELL_STYLE` / `LIQUID_CONTENT_SHELL_STYLE` 也是 `backdrop-filter: blur(20px) saturate(140%)`。

**全站搜索**：
- `transition-all`: **30 个文件**（TopBar, IconRail, ChatInput, ChatHeader, ChatMessages, TaskPanel, FileTree, TabRail, DocumentTabRail, RSSFeed, PreviewBrowser, Settings, EventModal …）。
- `transition: all`: 3 处在 `tiptap.css:181, 375, 403`。
- `transition-colors`: 额外在 `WorkbenchMode.tsx`、`RSSMode.tsx` 等入口。

### 4.2 根因

| # | 问题 | 为什么卡 |
|---|------|----------|
| T1 | CSS 变量值瞬时切换，无根层面 transition 桥接 | 看起来是"闪"一下；实际是 30+ `backdrop-filter` 元素、100+ 背景色元素在同一帧内全部失效并重算 |
| T2 | `transition-all` / `transition: all 0.15s` 在 30+ 文件中存在 | 主题切换瞬间，这些元素的 `background-color / color / border-color / box-shadow` 全部同时发起 150ms 过渡 —— GPU 尚可，但主线程 style 重算成本爆炸 |
| T3 | `liquid-glass-react` 在按钮/卡片/面板随处可见 | 每个实例都是一个独立 SVG filter 管道；主题切换会触发内部 reactive 重算 displacement/saturation，非 GPU 加速 |
| T4 | `liquid-glass` skin 下许多元素叠了**双层 backdrop-filter**（父 `.workbench-panel-frame` + 子 `.glass-surface-panel`） | blur 组合级联，每切一次主题就要重建两层 offscreen buffer |
| T5 | `html[data-theme='dark'][data-skin='liquid-glass']` 等多条件选择器存在 3+ 条（`index.css:308-312`, `1334-1340`, `2521-2530`） | 选择器级联下的 style 重算比单条件更慢 |

### 4.3 次生

- `useTheme.toggleTheme` 里还顺手同步调用 `window.electronAPI.theme.set(option)` —— IPC 是 `.catch()` 吃掉异常，但同一 tick 里触发了原生 `nativeTheme.themeSource` 变化，会让 BrowserView 再做一次 `prefers-color-scheme` 变更 → 内部重排。

---

## 5. 其他可观察到的性能嫌疑点

1. **`tiptap.css:181,375,403`** 使用 `transition: all 0.15s ease` —— `all` 是最糟的关键字，会动画 `filter`、`transform`、`opacity`、`color`、`background`、`box-shadow` 等一切可过渡属性。
2. **`tiptap.css:479` `ready-doc-reveal-flash` keyframe** 同时动 shadow 与 background，且持续 1.6s。
3. **`BrowserEnterOverlay` / `CalendarEnterOverlay` / `DocumentEnterOverlay` / `RSSEnterOverlay`** 四个 enter overlay 都用 `motion.div` + `AnimatePresence mode="wait"`，每次切模式都至少触发一次进/出。其中 `BrowserEnterOverlay` 还嵌了一个 `animate={{ rotate: 360 }} repeat: Infinity` 的无限旋转 `Loader2`，在底层。
4. **`MorphIconRailGroup.tsx:27-40`** 自定义的 spring transition `stiffness:60, damping:38, mass:3.2` + 1500ms `THUMB_LIFT_BEFORE_SLIDE_MS` + 750ms `THUMB_PRESS_SETTLE_MS` —— 叠加定时器链。
5. **`SidePanel.tsx:65-121`** 两个嵌套 `motion.div`（header + body）同时跑 y 轴动画，时长 0.32s + 0.4s，且各自加了 `willChange: 'transform', backfaceVisibility: 'hidden', transform: 'translateZ(0)'` 强制升 layer —— 在已有 backdrop-filter 的父容器里这会**进一步拆分合成层**。
6. **`WorkbenchModeOutlet`** 里 4 个 `<Suspense>` 包住 `lazy()` 组件常驻。虽然 `hasPreloadedWorkbenchModes` 保证 chunk 只拉一次，但子树常驻带来的 style 计算成本不会消失。
7. **`html[data-skin='liquid-glass'] .icon-rail-slider` 等**（`workbench-sliders.css:115-117`）叠了一层 `backdrop-filter`，而 `.icon-rail-slider__thumb` 也有复杂 layered gradient —— icon rail 本身就是一个重合成区。

---

## 6. 优化方案（按 ROI 降序，待讨论后再决定实施顺序）

> 下面每条都包含 **动作 / 命中的卡顿场景 / 预期收益 / 风险**。所有改动在确认执行计划前都暂不动手。

### 6.1 P0 —— 最高优先级（预计单项可带来显著提升）

**O1. SidePanel / ChatPanel 从 `width` 动画切到 CSS Grid / `transform` 动画**
- 命中: 面板展开收起、模式切换时 BrowserView 抖动
- 方案 A（推荐）: 父容器用 `display: grid` + `grid-template-columns: [rail] auto [panel] 1fr [main] Xfr [chat] Yfr`，面板列宽度用 CSS 变量控制，过渡 `grid-template-columns: 300ms`（Chromium 128+ 支持 `interpolate-size` / `calc-size()` 进行 grid track 动画）。
- 方案 B: 保持 `width` 不变，内容用 `transform: translateX(-100%)` + 外层 `overflow: hidden` 模拟滑入；缺点是 flex sibling 不会自动让位。
- 方案 C（最简）: 至少去掉 `min-width` 的过渡，只保留 `width`；把 `transition-timing-function` 改为 `ease-out` 缩短 tail；考虑在 body 加 `ready-panels-animating` class，期间对 BrowserView `updateBounds` 做 **动画终点预测** —— 在动画开始时就把终点 bounds 推给 main，之后 suspended 追踪。
- 风险: 方案 A 需要一次结构级重构；方案 C 最小侵入但只是缓解。

**O2. 合并主题切换的视觉过渡层**
- 命中: 主题切换闪烁
- 方案: 在 `html` 上加 `transition: background-color 200ms, color 200ms, border-color 200ms`（只让根过渡），同时给 `.glass-surface-*` / `.lg-surface-*` 加 `transition: backdrop-filter 220ms ease, background 220ms ease`；移除所有 `transition: all` 和尽量少用 `transition-colors`。
- 更彻底: 在 `useTheme.applyColorTheme` 里做 **两阶段切换**：
  1. 给 `<html>` 加 `data-theme-transitioning="true"` → 全局启用 220ms 过渡类。
  2. `requestAnimationFrame` 内改 `data-theme` 属性。
  3. 220ms 后移除 transitioning 标记。
- 风险: 短时间内会存在"颜色在动画"的观感，需要设计确认；`backdrop-filter` 过渡成本仍然存在，但分散到多帧后不再卡顿。

**O3. 模式切换动画与 BrowserView 原生层的时序同步**
- 命中: browser 模式切出/切入时的"闪一下"
- 方案:
  - 切出 browser 前先**同步上屏一张截图占位**（已有 `ready:browser-capture-freeze` 事件，但是它在 hide 之前的一帧才触发），把截图 url set 到一个常驻的 `<img>` 层覆盖 BrowserView 区域；等动画结束再隐藏截图、恢复 BrowserView。
  - `setIsMotionSettled(false)` 的那一刻先**立刻** `browser.hideAll()`，不要等 React commit 完。
  - 在主进程端对 `BrowserView.setBounds` 加 `setWindowOpenHandler` 级别的合并（已有 `appliedBoundsByView` dedup，但可加 16ms throttle 当 renderer 报告 `resizing`）。
- 风险: 截图层可能与真实页面像素微差；需要设计接受"静帧 -> 动画 -> 实况"的过渡。

### 6.2 P1 —— 中优先级

**O4. `WorkbenchModeOutlet` 非激活模式用 `display: none` 或懒真卸载**
- 命中: 模式切换开销、GPU 合成层数量
- 方案: 非相邻模式用 `display: none`（完全不参与 render/paint），相邻模式保持 `visibility: hidden` 以便滑动动画衔接；进一步可采用 "只 mount 当前 + 提前加载下一个" 策略。
- 关键是去掉**冗余**的 `visibility: hidden` + `contentVisibility: hidden` 叠加。
- 风险: 模式内部 scroll 位置、输入法 caret 等状态需要托管到 zustand 持久化；tiptap editor 卸载重建有开销但一次性。

**O5. 全面替换 `transition-all` 为属性白名单**
- 命中: 主题切换 + hover 响应
- 方案: 30 个文件批量扫描，根据实际需要过渡的属性声明 `transition-colors transition-transform` 或 `style={{ transition: 'background 160ms ease, color 160ms ease' }}`。
- `tiptap.css` 的 3 处 `transition: all` 直接改白名单。
- 风险: 需要逐个审视，避免漏掉真正想过渡的属性。

**O6. 全局 resize 节流 hub**
- 命中: 窗口缩放
- 方案: 在 `src/renderer/modules/workbench/` 下新建 `useWindowResize`，内部共享一个 `window.addEventListener('resize', ...)` + 16ms RAF 合并，暴露 `subscribe(cb)` 给 FilesPanel / ChatHeader / PreviewBrowser / useBrowserViewBounds 使用。
- `useBrowserViewBounds` 的 resize observer 改为**只在容器自身尺寸变时**触发；窗口缩放走 hub。
- 风险: 低；一次重构覆盖 5 处监听。

**O7. BrowserView 拖动期间的 IPC 背压**
- 命中: 拖动 resize-handle 时
- 方案:
  - 把 `startBoundsTracking` 改为 "在 drag 结束时发一次 exact bounds + 在 drag 过程中每 32ms 最多一次"。
  - 主进程侧额外合并同 frame 的 `setBounds`。
  - 可选：drag 过程中用 `browserView.setBounds` 的同时给 renderer 一个带截图的 mask 层，减少视觉抖动。
- 风险: 低；需要调参。

### 6.3 P2 —— 较低优先级 / 细节打磨

> `2026-04-18` 补充说明：
> - `O8` 已实施；
> - `O10` / `O12` 已作为回归保护由代码与契约测试锁定；
> - `O11` 已实施；
> - `EventModal / NewEventMenu` 的剩余 `transition-all` 清理已实施；
> - `O13` 已复查并主动跳过；
> - `O9 / O14` 仍未纳入正式工作台实施范围。

**O8. framer-motion layout 动画使用范围审查**
- `MorphIconRailGroup` / `MorphTabStrip` 的 `layoutId` + spring 动画虽然视觉上好，但每次切模式都在跑。可把 thumb 改成纯 `translate3d` + transform，不走 layout reconciliation。
- `SidePanel` 内的两个嵌套 motion.div（`willChange: 'transform', backfaceVisibility: 'hidden', translateZ(0)`）在父有 `backdrop-filter` 时反而拆层增加合成负担——移除 `translateZ(0)`，让浏览器自决策。

**O9. 降低 `liquid-glass-react` 实例密度**
- 仅在关键区域（主内容卡片）保留 SVG filter 版；icon 按钮、列表项等改用纯 CSS `backdrop-filter`。
- 或把 `aberrationIntensity` 降到 0 / `displacementScale` 减半（视觉几乎无感但 SVG filter 开销明显下降）。

**O10. Tiptap widget `transition: all 0.15s ease` 全部改白名单**（`tiptap.css:181, 375, 403`）。

**O11. `ready-doc-reveal-flash` 动画改用 `filter: brightness()` 或 `outline`**（当前动 `box-shadow` 是 paint-heavy）。

**O12. 去掉 WorkbenchModeOutlet 里 `visibility: hidden` 与 `contentVisibility: 'hidden'` 的冗余**（二者选其一即可）。

**O13. BrowserView-overlay 的 CSS fade 过渡**
- 目前 `useBrowserViewBounds` 动画期间直接 `hideAll()`。可以改为渲染端先把"BrowserView 区域占位层"做 opacity fade，然后再 hide 原生层；用户观感上更像是"淡出"而非"瞬消"。

**O14. Settings/Theme 切换时禁用过渡的逃生口**
- 给 `<html>` 加 class `theme-transition-off`，主题切换时短暂禁用，避免大量元素同时过渡带来的首帧卡。虽然与 O2 思路相反，但可作为第一阶段快速修复（**无过渡切换**反而比**糟糕过渡**更稳）。

### 6.4 度量与验证建议（下轮执行前）

- 用 Chromium DevTools Performance 分别录制四种交互 5s 轨迹，量化：
  - 每秒帧数 (fps)
  - Paint / Composite Layers / Recalc Style 时间
  - Long Task 数量（>50ms）
- 重点监控 `main process` 侧 `BrowserView.setBounds` 的调用次数；在渲染端加一条 `console.debug` 计数，看 resize 一次触发多少次 IPC。
- 如果后续要做 A/B，建议用 `document.documentElement.dataset.perfExperiment = 'side-panel-grid'` 之类的开关逐项上线。

---

## 7. 一张"谁在同一时刻参与"的时间线

以"点击切到 document 模式"为例（约 350ms 窗口）：

```
t=0ms    用户点击 topbar tab
         ├─ useMode.setWorkbenchMode('document')        [zustand broadcast → renderer re-render]
         ├─ WorkbenchMode.setIsMotionSettled(false)     [触发 useBrowserViewBounds.syncBrowserVisibility]
         ├─ 'ready:browser-capture-freeze' dispatch     [BrowserMode 同步截图 IPC]
         └─ WorkbenchModeOutlet transform transition begin (350ms)

t=~16ms  useBrowserViewBounds.syncBrowserVisibility → browser.hideAll() IPC
         ├─ 同时: TopBar MorphTabStrip 的 liquid pill spring 动画 (stiffness:430)
         ├─ IconRail MorphIconRailGroup layoutId 动画 (stiffness:60)  ← 很长
         ├─ DocumentEnterOverlay AnimatePresence 进场 (0.28s)
         └─ 如果 sidePanelVariant 变化: SidePanel AnimatePresence sync

t=~16-200ms  WorkbenchModeOutlet translateX 在推进
         └─ BrowserView 已 hide，但 calendar-x 日历 & tiptap 还在相邻模式一起被合成

t=350ms  transitionTimer fires → setIsMotionSettled(true)
         ├─ useBrowserViewBounds.syncBrowserVisibility → browser.showActive() + updateBounds
         └─ IconRail spring 动画仍在收敛 (实际 >500ms)

t=350-900ms  liquid-glass-react 内部 mouse tracker 继续 per-frame 重算 displacement
```

上图说明为什么主观体感是 **"切一下有个瞬间不动，然后 bar 在抖"**：切换瞬间 GPU 被 SVG filter + backdrop-filter 占满，IPC 线程被 BrowserView hide/show 占满，主线程被 framer-motion layout spring + zustand broadcast 占满。

---

## 8. 附录 A — 证据索引（便于后续 PR 溯源）

| 文件 | 关键行 | 关注点 |
|------|--------|--------|
| `src/renderer/components/layout/SidePanel.tsx` | 211 | `width/min-width` 动画 |
| `src/renderer/components/layout/SidePanel.tsx` | 65-121 | 内嵌 motion.div 强制升 layer |
| `src/renderer/components/agent/ChatPanel.tsx` | 3291-3292 | `width/min-width` 动画 |
| `src/renderer/components/layout/WorkbenchModeOutlet.tsx` | 68-111 | 4 模式常驻 + translateX |
| `src/renderer/components/layout/WorkbenchModeOutlet.tsx` | 94-97 | `contentVisibility` + `visibility` 冗余 |
| `src/renderer/pages/WorkbenchMode.tsx` | 190-224 | 切换状态机 + capture-freeze |
| `src/renderer/modules/browser/useBrowserViewBounds.ts` | 78-108 | 每帧 RAF IPC updateBounds |
| `src/renderer/modules/browser/useBrowserViewBounds.ts` | 155-178 | 双通道 resize 监听 |
| `src/renderer/stores/useTheme.ts` | 40-46 | 无过渡的 theme 切换 |
| `src/renderer/styles/index.css` | 145-248 | 50+ CSS vars 瞬时切换 |
| `src/renderer/styles/index.css` | 1265-1398 | 大量 `backdrop-filter` 声明 |
| `src/renderer/components/ui/LiquidGlassScene.tsx` | 52-83 | `liquid-glass-react` SVG filter |
| `src/renderer/components/motion/MorphIconRailGroup.tsx` | 27-40 | spring 动画 + 长 timer |
| `src/renderer/styles/tiptap.css` | 181/375/403 | `transition: all 0.15s` |
| `src/renderer/styles/workbench-sliders.css` | 115-117, 284-311 | 多层 backdrop-filter |

## 9. 附录 B — 下一步建议（仅作方向）

1. 先做 **O1 + O2 + O3**（P0 全集）构成一个"流畅性基建" PR；
2. 同步做 **O6**（resize hub）作为第二个 PR，风险极低；
3. 最后再做 **O4 / O5 / O9** 这类需要广泛接触组件的改动；
4. 建议在 PR 中加入 before/after 的 DevTools Performance 轨迹截图，直接量化改善。

> **本报告仅为审计输出，未修改任何源代码。**
