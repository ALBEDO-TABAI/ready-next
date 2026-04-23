# Ready Workbench — UI / Animation Jank 第二轮缺口审计

> 生成时间: 2026-04-18
> 作者: Claude (Opus 4.7) — 仅做代码级审计，**未执行任何代码修改**
> 前置: `docs/performance/2026-04-17-ui-animation-jank-audit.md`（第一轮审计 + Codex 实施记录）
> 本轮目的: 在 Codex 完成 `P0 → P1 → P2 → P3` 四轮改动后，重新按同一套流程审一遍，找出
> 1. **被“改坏”的地方**（回退原因/新引入的副作用/观感比上一版差）
> 2. **仍然存在的缺口**（原本 P0/P1/P2/P3 没真正解决的根因）
> 3. **新发现的次生问题**（这几轮重构引入的新嫌疑点）
> 输出: 结论清单 + 证据引用 + 分级缺口建议，不涉及实施计划。

---

## 0. 结论先读 (TL;DR)

上一轮把“内容瀑布 + width 补间 + 双图层并存 + 冻结帧抢首帧”统一清理掉，主线观感确实更稳，但**把 `width` 补间一次性全砍掉**以后，左右面板的外壳宽度出现了新的“瞬时跳变”：
- **外壳宽度跳变 vs 内容动画不同步**：SidePanel / ChatPanel 的 `width` 现在永远不过渡，只让内容层做 180ms 的 `transform + opacity`。收起时，内容淡出的 180ms 里外壳仍占满宽度；动画一结束，外壳宽度瞬间变 0（或变回 rail）。主内容区最后一帧会“被甩出来” —— 比原来的 width 300ms 同步过渡更突兀。
- **主题切换被设计成真·动画**：`html[data-theme-transitioning='true']` 给 `.glass-surface-panel / .workbench-panel-frame / ...` 全都挂上了 `transition: backdrop-filter 220ms`。这会触发 **CSS filter 函数级别的 blur 半径插值**，每帧重新生成一次 offscreen 模糊缓冲区 —— 在 42 处 `backdrop-filter` + `liquid-glass-react` 并存的场景下，很可能比旧的瞬时切换更慢。
- **WorkbenchModeOutlet 的新两段式状态机**（`preparing → animating → settled`）只让“进入方”从 22% 滑入，“离开方”保持原位只做 opacity 0.82，**丢掉了双向滑动感**，且 `display: block | none` 切换与 `transform` 过渡在同一帧触发时会有单帧闪烁。
- **BrowserView 显隐节奏**新增了两路冗余：WorkbenchMode 切换时会 `hideAll()`，BrowserMode `useEffect(isMotionSettled)` 又再 `hideAll()` 一次；新加的 `startupHostResyncTimerRef`（180ms）还会在进入 browser 时追发一次 `fitActiveTabToBounds + syncBrowserVisibility`，**实际上每次进入浏览器都有至少两次 bounds 重抛**。
- **图标栏 thumb** 新的 `is-pressing / is-resting / is-elevated` 三态联动 `THUMB_REOPEN_DELAY_MS = 140 / THUMB_REST_SETTLE_MS = 120` 加上 5 个属性同时 `transition` 140ms/120ms/120ms/140ms/120ms，每次关开侧栏都会额外引一轮定时器；虽然 spring 已经拆掉，但这一层定时器链仍然存在。
- **旧的 `*EnterOverlay` 组件**（Browser/Calendar/Document/RSS 四个）已经从页面里摘掉，但**源文件仍然在仓库里**，是纯死码。
- 次生：原审计里点名的 P2 清单里，**Settings / Memory / Personality / Profile / RSSModal 里仍然大量存在 `transition-all`**（约 30 处），这些面板在主题切换或窗口缩放时是顺带被连累的对象，还没进入清理范围。
- 另一个 P2/P3 边界问题：`RSS PreviewBrowser` 自己维护了一整套 `scheduleBoundsSync / finalSyncTimeout / panelResizingRef`，和 `useBrowserViewBounds` 的实现**平行**存在，两套逻辑在 resize / 模式切换时都会开 RAF，是重复工作。

下面按原审计的四大场景顺序逐项列出“改坏”和“未修完”。

---

## 0.1 先承认修好的部分（避免复审时翻旧账）

以下条目经复查确实修到位了，后续不用再动：

- `MorphIconRailGroup` 去掉 `layoutId` / spring 动画，thumb 改成 y 偏移。参见 `src/renderer/components/motion/MorphIconRailGroup.tsx:105-121`。
- `SidePanel` / `ChatPanel` 不再使用 `willChange: 'transform', backfaceVisibility: 'hidden', translateZ(0)` 三件套强制升层。当前只在动画期间挂 `willChange: 'transform, opacity'`，静态态 `auto`。
- `WorkbenchModeOutlet` 非激活 mode 改成 `display: none`（不是 `visibility: hidden` + `contentVisibility: hidden` 叠加），paint tree 彻底跳过。参见 `WorkbenchModeOutlet.tsx:149`。
- 共享 `subscribeWorkbenchWindowResize` hub 已经落到 `useBrowserViewBounds / PreviewBrowser / FilesPanel / ChatHeader`，window resize 不再多路独立节流。
- `ResizeHandle`（主工作台版）改成 per-frame 合并 mousemove，不再每次 `mousemove` 都 setState。参见 `src/renderer/pages/WorkbenchMode.tsx:48-57`。
- `useBrowserViewBounds` 拆出 `transient / settled` 两档同步，且 `panelResizingRef` 期间只发 `transient`、松手后发一次 `settled`，不再逐帧 IPC 打包 420ms。
- `useTheme.applyColorTheme` 拆成 `transition 标记 → RAF 切 data-theme → 再 RAF 同步原生主题 → 220ms 后清标记` 的四段式（行为已是“两阶段”，细节见 `useTheme.ts:87-109`）。
- `tiptap.css` 三处 `transition: all 0.15s` 已改为 `transition: background-color, border-color, color 0.15s`。
- `ready-doc-reveal-highlight` 已改成“底色淡入 + `outline` 提示”，`@keyframes ready-doc-reveal-flash` 从 1.6s 压到 1s，也不再动 `box-shadow`。

这些不再出现在下面的缺口列表里。

---

## 1. 被“改坏”的地方（回退比上一版差的观感）

### R1. SidePanel / ChatPanel 外壳宽度瞬时跳变（最关键）

**现象**: 开侧栏 → 左侧一块全宽的空壳瞬间占位，再过一帧内容才从右侧 18px 处滑进来；关侧栏 → 内容先淡出消失，最后一帧外壳从全宽跳到 0。主内容 / BrowserView 区域在同一帧硬跳。

**证据**
- `src/renderer/components/layout/SidePanel.tsx:161-172`：外壳只用 `style={{ width: panelWidth, minWidth: panelWidth }}`，**没有任何 `transition`**。
- `src/renderer/components/agent/ChatPanel.tsx:3232-3239`：同样 `width: shellWidth, minWidth: shellWidth`，无 transition。
- `src/renderer/pages/WorkbenchMode.tsx:282-285`：`sidebarShellWidth = shouldRenderSidebarShell ? sidePanelWidths.shared : 0` 与 `chatShellWidth = chatPanelState === 'collapsed' ? WORKBENCH_EDGE_RAIL_SIZE : chatPanelWidth`，都是离散值。
- `src/renderer/pages/WorkbenchMode.tsx:142-194`：`sidebarShellTimerRef` / `chatPanelStateTimerRef` 用 `setTimeout(..., WORKBENCH_PANEL_MOTION_DURATION_MS)` 等 180ms，内部 `AnimatePresence` 的 `exit` 同样 180ms —— 这意味着“外壳跳变”和“内容动画结束”在**同一帧**对齐，反而最放大视觉冲击。

**根因分析**

原审计建议过 O1 的方案 A（改 grid-template-columns 动画）或方案 C（保留 width 过渡，做动画终点预测）。Codex 走了**第四条路**：“彻底砍掉 width 动画，让内容自己做 transform+opacity”。这条路只有在“面板宽度变化对邻居 0 影响”时才成立。但 workbench 外层是 flex + BrowserView 叠加，邻居对宽度变化极敏感；一旦砍掉 width 过渡，邻居只能在最后一帧跟着跳。

**影响面**
- Sidebar 展/收：视觉上像“页面跳了一下”。
- Chat panel 展/收：相同问题，且 chat panel 是 rail 尺寸不是 0，跳变幅度略小但更频繁。
- 模式切换时如果同时触发了 sidebar / chat panel 动画，会叠加成双倍跳变。

### R2. 主题切换用 `transition: backdrop-filter 220ms` 反而放大卡顿

**现象**: 切暗/亮时，面板的 blur/saturate 会肉眼可见地“平滑过渡”222ms，期间每帧都能感到 GPU 卡顿；暗色下尤其明显。原审计里的 P0 (O2) 建议只对 `background-color / color / border-color` 做 220ms 过渡，这里**把 `backdrop-filter` 也一起动画了**。

**证据**
- `src/renderer/styles/index.css:417-442`：
  ```css
  html[data-theme-transitioning='true'] body,
  html[data-theme-transitioning='true'] .glass-surface-panel,
  html[data-theme-transitioning='true'] .workbench-panel-frame, ... {
    transition:
      background-color 220ms ease,
      color 220ms ease,
      border-color 220ms ease,
      box-shadow 220ms ease,
      backdrop-filter 220ms ease,
      -webkit-backdrop-filter 220ms ease;
  }
  ```
- 仓库里 `backdrop-filter` 出现 56 次（`grep -c` 累计），`.glass-surface-panel` / `.glass-surface-floating` / `.browser-header-surface` 等几乎全部命中这条 transition。

**根因分析**

`backdrop-filter` 不是普通颜色属性，Chromium 会按插值后的 blur 半径每帧重建 offscreen 模糊缓冲区；两层嵌套 blur 时（`workbench-panel-frame` + `glass-surface-panel`）成本成倍增加。再叠加 `liquid-glass-react` 的 SVG filter 管道，主题切换期间主线程和 GPU 同时承压。从根因上看，blur 值的插值动画几乎没有视觉收益，但持续 220ms 全屏重算，反而是明显回退。

**影响面**
- 暗/亮切换瞬间 200–260ms 内 fps 下探。
- 开着浏览器或文档的 backdrop-filter 面板尤其明显。

### R3. WorkbenchModeOutlet “只入不出”的单向滑动感

**现象**: 模式切换时，原来的观感是“旧模式往一侧滑走 + 新模式从另一侧滑进来”。现在的观感是“旧模式只是轻微淡出（opacity 0.82），新模式从 22% 滑入”，**缺少双向 parallax 的节奏**，有用户反馈“像直接换了张图”而不是滑动。

**证据**
- `WorkbenchModeOutlet.tsx:80-101`：`resolveSceneTransform` 里 `leaving` 在 `preparing` 阶段 `translate3d(0, 0, 0)`、在 `animating` 阶段才给 ±16% 偏移；但 `resolveSceneOpacity` 给 `leaving + animating` 直接设 0.82。
- `WorkbenchModeOutlet.tsx:147-156`：`display: isVisible ? 'block' : 'none'`，`leaving` 走到 `settled` 那帧 `isVisible` 变 false，立刻 `display: none`，导致最后 16% 的位移根本没被看到。
- `MODE_SCENE_TRANSITION = 'transform 0.35s cubic-bezier(0.24, 1, 0.36, 1), opacity 0.22s ease-out'` — opacity 比 transform 更早结束 80ms。

**根因分析**

`display: none` 和 CSS transition 不能共存：一旦元素变成 `display: none`，transition 会被立刻终止。`leaving` 模式从 `animating`（还没到终点）→ `settled`（isVisible=false → display:none），因此位移动画永远跑不完，观感上只看到“淡 18%”这一段。

另外 `preparing → animating` 依赖一个额外的 RAF（`WorkbenchModeOutlet.tsx:218-234`），第一帧对两个 scene 都给 `transform: translate3d(0, 0, 0)`，在浏览器里先写一次 style；下一帧再改写一次 transform 进入过渡。这种“双写”配合 `display` 切换，会在第一帧出现极短暂的“新模式已经在位 + 老模式还没开始移动”的扁平画面。

**影响面**
- 切换动效缺乏惯性，用户会主观觉得“更卡”。
- 非 `browser` 模式彼此切换（比如 document ↔ calendar）尤其明显，因为没有 BrowserView 遮罩接管。

### R4. BrowserView `hideAll()` 双路冗余

**现象**: 每次离开 browser 模式会触发 `BrowserView.setBounds` + 窗口合成层抖动两次。

**证据**
- `src/renderer/pages/WorkbenchMode.tsx:303-305`：离开 browser 时 `void window.electronAPI?.browser.hideAll()`。
- `src/renderer/pages/modes/BrowserMode.tsx:299-305`：BrowserMode 自身 `useEffect(isMotionSettled)`，只要 `!isMotionSettled` 就再次 `void window.electronAPI?.browser?.hideAll?.()`。
- `src/renderer/pages/WorkbenchMode.tsx:348-353`：模式变化再触发一条 `if (!visibleModes.includes('browser')) browser.hideAll()`。

**根因分析**

P0 阶段添加了 BrowserMode 内部的兜底 hideAll（防止冻结帧拍到错位画面），但没有把 WorkbenchMode 那条也撤掉；现在三路都活着。IPC 本身便宜，但主进程 `BrowserView.setBounds(0,0,0,0)` 在 macOS 上会触发一次原生窗口层 re-layout，叠加时延可见。

**影响面**
- 模式切出 browser 的首帧可能因为原生层被连续 hide 两次而更抖。

### R5. 进入 browser 模式的“双步 bounds 同步” 造成位置微跳

**现象**: 从 document / rss / calendar 切回 browser，BrowserView 偶尔会出现“先落在旧位置，180ms 后跳到新位置”的情况。

**证据**
- `src/renderer/pages/modes/BrowserMode.tsx:328-381` (`syncVisibleHost`)：
  1. `await hideAll`
  2. `await sendBoundsImmediate({ forceExact: true })`
  3. `await fitActiveTabToBounds`
  4. `await sendBoundsImmediate({ forceExact: true })`
  5. `await syncBrowserVisibility({ forceExact: true })`
  6. 再 `requestAnimationFrame ×2` 后再 `setTimeout(180ms)` 做第二次 `fitActiveTabToBounds + sendBoundsImmediate + syncBrowserVisibility`。
- 第二轮 `startupHostResyncTimerRef` 的 180ms 跟 `WORKBENCH_PANEL_MOTION_DURATION_MS = 180` 高度耦合，但没有检查“侧栏/聊天栏是否还在动” —— 如果用户进入 browser 模式的同一刻触发了侧栏切换，180ms 后侧栏动画刚结束，bounds 又要再抛一次。

**根因分析**

P0 / P1 阶段为了覆盖“切回浏览器后页面没对齐”的场景，追加了 `startupHostResyncTimerRef` 兜底，但它没有和 `useBrowserViewBounds` 的 settled 触发链去重，结果每次进 browser 都是 2 次 settled + 若干次 transient。

**影响面**
- 快速连点切换 browser ↔ document 时，首帧位置跳一下。

### R6. Sidebar 开合“先扩展壳，下一帧才显示内容”

**现象**: 连续快速切 `⌘1/⌘2/⌘3` 或者点击图标时，会有一帧“侧栏已经腾出空间，但内容还没画出来”，再接着内容才淡入。

**证据**
- `src/renderer/pages/WorkbenchMode.tsx:142-166`：`if (sidebarVisible) { setShouldRenderSidebarShell(true); sidebarEnterFrameRef.current = requestAnimationFrame(...) { setIsSidebarContentVisible(true) } }`。
- `SidePanel.tsx:102` `isVisible = variant !== 'hidden' && contentVisible`，依赖 `contentVisible = isSidebarContentVisible`。

**根因分析**

RAF 延迟原本是为了让 AnimatePresence 在下一帧再安装 enter 动画（否则初始位就是终点，看不到位移）。但现在外壳宽度是瞬时跳变，“壳已扩 + 内容没画”的那一帧特别扎眼。如果把外壳宽度改成 grid 插值（见后面 G1），这个 RAF 才有意义。

**影响面**
- 切面板变体（files ↔ search ↔ skills）时感觉“先撑开，再画内容”。

### R7. `transition: backdrop-filter 220ms` 只覆盖部分面板，存在视觉撕裂

**现象**: 切换主题时，被挂过 transition 的面板（`workbench-panel-frame` / `glass-surface-panel` / `workbench-canvas-shell` / `browser-header-surface` / `document-editor-surface` / `document-path-bar` / `glass-surface-floating`）会慢慢过渡颜色 & blur；**未被挂过的 tab rail、icon rail、liquid-glass-react 按钮、状态栏、设置页**依旧是瞬时切换。两者 220ms 内不同步，用户会看到“页面一半在渐变、另一半已经换色”。

**证据**
- `index.css:424-442` 的 selector 白名单仅列了 9 类根面板。
- `workbench-sliders.css:115-117`、`index.css:1334-1398` 等 IconRail / TabStrip / Draggable mode 相关 surface 没有挂该 transition。
- `liquid-glass-react` 内部 SVG filter 本就不响应 CSS 变量 transition。

**根因分析**

P0 只覆盖到了“最显眼”的几个 surface。但液态玻璃主题的一致性靠的是所有 `.glass-surface-*` 变量同时过渡，现在少覆盖了 tab / icon / status / settings 面板，反而因“有过渡 + 无过渡并存”让用户更明显感到不一致。

**影响面**
- 主题切换 220ms 内观感撕裂。

### R8. IconRail thumb 多态定时器链仍在 / `transition` 覆盖 5 种属性

**现象**: 每次开/关侧栏，thumb 会短暂进入 `is-pressing`（120ms）再回到 `is-elevated / is-resting`；切面板变体时 thumb 先在 `previousActiveId` 位置保持 140ms 再跳到新位置。总计每次交互会排布 2–3 个定时器。

**证据**
- `MorphIconRailGroup.tsx:25-30`：`THUMB_REOPEN_DELAY_MS = 140; THUMB_REST_SETTLE_MS = 120;`。
- `MorphIconRailGroup.tsx:75-103`：`useEffect([activeId, expanded])` 里每次都先 clear 再安排 `setTimeout`。
- `workbench-sliders.css:86-93`：thumb 同时过渡 `transform / opacity / border-color / box-shadow / background`，五个属性一齐跑。

**根因分析**

P2 复查时把“spring + layoutId”拆掉已经缓解了大头，但这层 JS 定时器 + 5 属性 CSS transition 组合仍会在高频点击（⌘1/⌘2 快速切换）时堆积。比起“简单的 y 位移 + 单属性过渡”，当前仍有打磨空间。

**影响面**
- 按键连发切换变体时，thumb 视觉“粘滞”。

---

## 2. 仍然存在的根因缺口（原审计 P0–P3 清单里没真正解决的部分）

### G1. 面板宽度过渡机制缺位（对应 O1）

**状态**: 未实施。P0 只做了“去掉 width 动画”一半，没上“父容器 grid-template-columns 动画”或“动画终点预测 + mask”。

**证据**
- `src/renderer/pages/WorkbenchMode.tsx:436-491`：workbench shell 仍然是 flex，外壳宽度离散。
- `sidePanelShell / chatShell` 都以像素 `width / minWidth` 呈现，没有 grid-template-columns 承载宽度插值。

**建议方向**
- 把 workbench shell 改成 `grid-template-columns: [rail] auto [sidebar] var(--sidebar-width) [main] minmax(0,1fr) [chat] var(--chat-width)`，用 `@property --sidebar-width` + `transition: --sidebar-width 220ms` 做真 grid track 动画（Chromium 128+ 可用；Electron 34 对应 Chromium 126，需验证）。
- 备选：保留 width 过渡但把 `min-width` 抽成 `contain-intrinsic-size`，动画改成 `ease-out` + 动画结束后再 `scheduleBoundsSync({ syncMode: 'settled' })`。
- 备选 C：在外壳加一层 `position: absolute` 覆盖层放内容，外壳自身 width 过渡，bounds sync 依赖 ResizeObserver 节流 —— 当前 `useBrowserViewBounds` 已经支持 `transient/settled` 两档，只差“动画期间”的驱动。

### G2. 主题切换里 `backdrop-filter` 过渡应去掉（对应 O2 过度实现）

**状态**: 实施过头，产生 R2 回退。

**建议方向**
- 从 `index.css:435-442` 的 transition 白名单里移除 `backdrop-filter / -webkit-backdrop-filter`。只让颜色、阴影、边框过渡 220ms。
- 对于 `--lg-blur-*` / `--surface-saturate` 等 blur 相关变量，切主题时**瞬时切换**即可，视觉上几乎感知不到，但能避免两轮 offscreen 合成。
- 或者接受“blur 过渡”，但把 duration 砍到 120ms，并用 `theme-transition-off` 紧急开关（对应 O14）作为逃生口。

### G3. `WorkbenchModeOutlet` 滑动语义缺失（对应 R3 + 原 M1 / M3）

**状态**: 已实施新状态机，但结果是单向滑入。

**建议方向**
- 显式给 `leaving` 模式在 `animating` 阶段保持 `display: block`，直到 `transitionend`（或 350ms 定时器到期）再 `display: none`，确保 16% 位移能走完。
- 或者把 `leaving` 也改成 `transform: translate3d(-100%, 0, 0)`（就是原来的 4-panel 横向长条方案），不要 `display: none` 非当前模式 —— 但那样成本更高，应结合 `content-visibility: auto` 折中。
- 对齐 `WORKBENCH_PANEL_MOTION_DURATION_MS(180) ↔ MODE_TRANSITION_DURATION_MS(350)`：模式切换和面板切换时长不统一时，用户同时触发两者会看到 170ms 的“等模式收尾”。

### G4. BrowserView 显隐三路合一（对应 R4 / R5 + 原 M3）

**状态**: 部分实施，但新增的兜底 hideAll 没撤掉旧路，造成冗余。

**建议方向**
- 在 `useBrowserViewBounds.syncBrowserVisibility` 一个地方负责所有 hide/show 决策。WorkbenchMode 与 BrowserMode 都只负责写 `isVisibleAllowed / hostVisibleRef`，不直接调 `hideAll()`。
- `startupHostResyncTimerRef` 的 180ms 追发改为“监听 `layoutPhase === 'idle'` 且 `panelResizingRef === false` 后一次 settled”，不要固定时长。

### G5. 全站 `transition-all` 清理尚未覆盖（对应 O5）

**状态**: 只清理了工作台主链路。settings、memory、personality、profile、rss modal、任务面板、LiquidTest 里仍有约 **40 处** `transition-all` 尚存。

**证据**
- `src/renderer/pages/Settings.tsx` 约 30 处 `transition-all`
- `src/renderer/components/memory/*.tsx`、`ready/TaskPanel.tsx`、`rss/AddSourceModal.tsx`、`personality/PersonalityEditor.tsx`、`profile/UserProfileEditor.tsx`、`workbench/WorkbenchProjectTabs.tsx`、`ui/IconButton.tsx:25`
- `LiquidTest.tsx:125`（实验页）

**影响面**
- 主题切换时 Settings 打开，界面里所有按钮同时 150ms 过渡 `color + background + border + box-shadow + filter`，GPU 压力陡增。
- `IconButton` 是 top-level 公共按钮，几乎每个页面都用到，相当于全局放大器。

### G6. `PreviewBrowser` 自成一套 bounds 同步，与 `useBrowserViewBounds` 重复

**状态**: 未实施。原审计没直接点名，但本轮复查时它是与 R5 配套的隐患。

**证据**
- `src/renderer/components/rss/PreviewBrowser.tsx:87-212`：单独维护 `frameSyncRafRef / finalSyncTimeoutRef / pendingSyncOptionsRef / panelResizingRef` + `PANEL_RESIZE_STATE_EVENT` 监听。
- 依赖 `window.electronAPI?.browser?.updateBounds`（跟 browser 模式同一个 IPC），但没有共享 `transient/settled` 概念。

**建议方向**
- 抽一个 `useBrowserHostedViewBounds({ ipcNamespace, options })`，让 `BrowserMode` 和 `PreviewBrowser` 共用；或直接在 `PreviewBrowser` 引用 `subscribeWorkbenchWindowResize + scheduleBoundsSync` 的工具函数。

### G7. `liquid-glass-react` 密度未降（对应 O9）

**状态**: 未实施。`primitiveByTone` 里 button / card / panel 的 `displacementScale` 仍然是 100 / 92 / 76，`aberrationIntensity` 1.8–2。

**建议方向**
- 按 O9 建议：核心内容卡片保留；按钮 / 列表项降级为纯 CSS `backdrop-filter`。或把 `aberrationIntensity` 调到 0、`displacementScale` 减半 —— 视觉差异主观下几乎不可感。
- 加入一个全局“性能档位”开关（low/medium/high），运行时可切换。

### G8. `*EnterOverlay` 组件成为死码（次生）

**状态**: 页面里已经全部取消挂载（grep 确认），但 `components/browser/BrowserEnterOverlay.tsx / calendar/CalendarEnterOverlay.tsx / document/DocumentEnterOverlay.tsx / rss/RSSEnterOverlay.tsx` 四个源文件仍在仓库。

**建议方向**
- 下一轮清理时直接删除这四个文件。并检查是否还有相关 CSS（`browser-enter-*` 等）挂靠。

### G9. `ready:browser-capture-freeze` 触发点从模式切换挪到了 hover，可能引入 hover 抖动

**状态**: P0 实施后，dispatch 只在 `DraggableModeTabs.handleIconHover` 里（浏览器图标）触发。**每次鼠标进入浏览器 icon 都会同步拉一张截图**；若用户只是扫过图标（无意切换），也会触发 IPC 抓屏。

**证据**
- `src/renderer/components/layout/DraggableModeTabs.tsx:199-205`
- `src/renderer/pages/modes/BrowserMode.tsx:258-270`（接收端）

**建议方向**
- 把 dispatch 加一层去抖（150–200ms），或改为 “hover + 停留超过 120ms” 后才捕获。
- 或者把 dispatch 搬回 `handleWorkbenchModeChange` 里，在 `setIsMotionSettled(false)` 之前做一次（与原 P0 初衷一致）。

### G10. `body.resizing * { transition: none !important }` 作用面过大（次生）

**证据**
- `src/renderer/styles/index.css:1251-1253`

**影响面**
- 在手动拖 resize-handle 期间，**整棵树**的所有 transition 都被禁用。这对 BrowserView 跟随是好事，但会误伤到文档编辑器 / tab rail 里的 tooltip / hover 效果，有用户反馈“拖一下 panel 后按钮 hover 变短一截”。

**建议方向**
- 把 `*` 换成更精确的 `.workbench-panel-frame, .workbench-canvas-shell, .glass-surface-panel`，或加一个 `[data-motion='panel']` 标记，只禁用布局相关 transition。

### G11. 文档模式拆分 handle 未做 RAF 合并（次生）

**证据**
- `src/renderer/pages/modes/DocumentMode.tsx:35-61`：`SplitResizeHandle` 直接在 mousemove 里调 `onResizeRef.current(delta)`，没 RAF 合并。
- 对比主工作台 `WorkbenchMode.tsx:20-96` 的 ResizeHandle 已做 RAF。

**影响面**
- 文档模式拆分视图拖动时，两边编辑器各自重绘，主线程 fps 下探。

### G12. 主题初始化走 `{ animate: false }`，但首次 DOM 挂载期间的根节点 CSS 变量更新**没有保护 reflow**（次生）

**证据**
- `useTheme.ts:115-121`：`applyColorTheme(resolved, initial, { animate: false })` 在 store 初始化时执行，早于 React 挂载。
- 此时 `<html>` 还没任何 `workbench-panel-frame` 子孙，transition 自然不会触发。但后续如果系统主题变化触发 `handleSystemChange`，走的是 `animate=true` 路径，**用户不是主动切换**但面板会强行进入 220ms 过渡 —— 夜晚切换系统自动暗色模式时会在后台触发一次“慢动作”。

**建议方向**
- 给 `animate=true` 加一条“仅当显式用户触发才放慢”的区分；系统主题变化走 `animate: false`。

---

## 3. 测量与验证建议（下一轮执行前）

依然沿用上一轮的建议，加两条：

1. **DevTools Performance 录 5s 轨迹**，分别测：
   - 切换主题（lite / dark 来回一次）
   - 打开/关闭 sidebar（⌘1 来回 3 次）
   - 切换 browser → document（3 次）
   - 拖动 resize-handle（2 秒）
   - 系统 resize（拖窗口边缘 2 秒）
2. **关键监控**：
   - Long Task (>50ms) 数量
   - `Recalc Style` 和 `Layout` 平均时长
   - `Composite Layers` 次数（backdrop-filter 变化是主因）
   - 主进程 `BrowserView.setBounds` IPC 调用次数
3. **验证用契约测试**：
   - 新增：`workbench-panel-width-transition-contract.test.ts` —— 断言 sidebar / chat panel 开合期间 `getBoundingClientRect().width` 随时间是**连续插值**而非一次性跳变（可以通过模拟 `performance.now()` + `requestAnimationFrame` 采样）。
   - 新增：`theme-transition-backdrop-contract.test.ts` —— 断言主题切换时，根 DOM 的 transition 白名单**不包含** `backdrop-filter`（或只允许一条短时 transition）。
   - 新增：`workbench-mode-bidirectional-slide-contract.test.ts` —— 断言模式切换时 leaving 场景在 animating 阶段有非零 `translate3d` 位移。

---

## 4. 一张“改坏/缺口对照表”（便于下一轮规划用）

| 编号 | 名称 | 现象 | 根因简述 | 建议优先级 |
|------|------|------|----------|------------|
| R1 | 外壳宽度瞬跳 | 开合 sidebar/chat panel 时最后一帧硬跳 | `width` 过渡被整条砍掉，内容层补偿不足 | P0 |
| R2 | 主题 blur 动画过大 | 切主题 220ms 明显卡 | `transition: backdrop-filter` 触发 filter 插值 | P0 |
| R3 | 模式切换单向滑入 | 旧模式不滑走、只淡 18% | `display: none` 与 transition 冲突 | P0 |
| R4 | hideAll 双路冗余 | 切出 browser 连续 hide 两次 | WorkbenchMode + BrowserMode 都写 hideAll | P1 |
| R5 | 进入 browser 两段 bounds 同步 | 首帧旧位置，180ms 后跳新位置 | `startupHostResyncTimerRef` 与 settled 链重复 | P1 |
| R6 | Sidebar 开合多一帧延迟 | 壳已扩、内容未画 | RAF 拆成两步 + 外壳瞬跳互相放大 | P1 (绑 R1) |
| R7 | 主题过渡白名单偏窄 | 页面一半渐变、一半瞬切 | 白名单只挂了 9 个面板 selector | P1 |
| R8 | IconRail thumb 多定时器链 | 快速切变体时粘滞 | `THUMB_REOPEN_DELAY_MS`+5 属性 transition | P2 |
| G1 | 面板宽度过渡机制未做 | 同 R1 | `grid-template-columns` / `@property` 尚未引入 | P0 |
| G2 | `backdrop-filter` 过渡应去掉 | 同 R2 | 建议从白名单里摘掉 | P0 |
| G3 | 模式切换双向感缺失 | 同 R3 | 需要 display / transitionend 联动 | P0 |
| G4 | BrowserView 显隐三路合一 | 同 R4/R5 | 在 `useBrowserViewBounds` 收口 | P1 |
| G5 | `transition-all` 残留 ~40 处 | 主题切换时 Settings / Memory 大量过渡 | 批量替换为属性白名单 | P1 |
| G6 | PreviewBrowser 自成一套 bounds 同步 | 与 browser 模式重复 | 抽共享 hook / 共用事件 | P2 |
| G7 | `liquid-glass-react` 密度未降 | SVG filter GPU 成本仍在 | 按 tone 降 displacement/aberration | P2 |
| G8 | `*EnterOverlay` 死码 | 已无引用 | 直接删除 | P3 |
| G9 | capture-freeze 改到 hover | 扫过 icon 也触发 IPC 抓图 | 加防抖或挪回切换时机 | P2 |
| G10 | `body.resizing *` 作用面过大 | 拖 resize 后 tooltip 变短 | 限定 selector | P2 |
| G11 | 文档模式 split handle 未做 RAF | 拖动时 fps 下探 | 复用主 RAF handle | P2 |
| G12 | 系统主题变化也走动画 | 后台自动切暗色也 220ms 过渡 | `handleSystemChange` 走 `animate: false` | P3 |

---

## 5. 下一步建议（仅作方向，不是执行计划）

> 真正的执行计划应该在本文档被用户审阅后，单独起一份 `docs/performance/2026-04-1x-ui-animation-jank-repair-plan.md`。

1. **P0 聚焦一个 PR**：只解决 R1 (G1) + R2 (G2) + R3 (G3)。原因：这三条是主观可感的“比上一版差”，其余的收益较小或风险较低。
2. **P1 另一个 PR**：BrowserView 显隐/进入同步收口（R4 + R5 + G4），附带 G5 `transition-all` 批量清理。
3. **P2/P3 的打磨项**（G6–G12）留作后续小改动批次处理。
4. **测量先行**：每个 PR 必须附 before/after 的 DevTools Performance 轨迹截图和 4–5 个契约测试。

---

## 6. 附录 — 证据索引

| 文件 | 行 | 关注点 |
|------|----|--------|
| `src/renderer/components/layout/SidePanel.tsx` | 161-172 | 外壳 width 无过渡 |
| `src/renderer/components/agent/ChatPanel.tsx` | 3232-3239 | 外壳 width 无过渡 |
| `src/renderer/pages/WorkbenchMode.tsx` | 142-194 | shell render / content visible 双状态 |
| `src/renderer/pages/WorkbenchMode.tsx` | 282-285 | `sidebarShellWidth / chatShellWidth` 离散 |
| `src/renderer/pages/WorkbenchMode.tsx` | 288-327 | handleWorkbenchModeChange 多路 hideAll |
| `src/renderer/components/layout/WorkbenchModeOutlet.tsx` | 80-170 | 单向滑入状态机 |
| `src/renderer/pages/modes/BrowserMode.tsx` | 299-381 | 双路 hideAll + startupHostResync |
| `src/renderer/modules/browser/useBrowserViewBounds.ts` | 102-260 | transient/settled 双档 |
| `src/renderer/stores/useTheme.ts` | 87-133 | 两阶段主题切换 + 系统变化也 animate |
| `src/renderer/styles/index.css` | 417-442 | theme transition 含 backdrop-filter |
| `src/renderer/styles/index.css` | 1251-1253 | `body.resizing * { transition: none !important }` |
| `src/renderer/components/motion/MorphIconRailGroup.tsx` | 25-103 | thumb 定时器链 |
| `src/renderer/styles/workbench-sliders.css` | 86-93 | thumb 五属性 transition |
| `src/renderer/components/rss/PreviewBrowser.tsx` | 87-212 | 平行 bounds 同步 |
| `src/renderer/components/layout/DraggableModeTabs.tsx` | 199-205 | hover 触发 capture-freeze |
| `src/renderer/pages/Settings.tsx` | 543/596/699-1845 | 30+ 处 transition-all |
| `src/renderer/components/ui/IconButton.tsx` | 25 | 全局按钮 transition-all |
| `src/renderer/components/ui/LiquidGlassScene.tsx` | 52-83 | liquid-glass-react 密度未降 |
| `src/renderer/pages/modes/DocumentMode.tsx` | 35-61 | SplitResizeHandle 无 RAF |
| `src/renderer/components/browser/BrowserEnterOverlay.tsx` 等 4 个 | 全部 | EnterOverlay 死码 |

---

> 本报告仅为审计输出。如需确认下一轮执行计划，请基于“改坏/缺口对照表”先圈定 P0 范围，再拟定 PR 级拆分。
