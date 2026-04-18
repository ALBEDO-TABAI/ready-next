# Ready Workbench — UI / Animation 第三轮修复执行计划

> 生成时间: 2026-04-18（晚间）
> 作者: Claude Opus 4.7
> 关联审计: `docs/performance/2026-04-18-ui-animation-round3-audit.md`
> **状态：草案 · 待用户确认后方可开始实施**

---

## 0. 阅读顺序

- 先读 `docs/performance/2026-04-18-ui-animation-round3-audit.md`（同目录审计）以了解每个编号 A*/B*/C*/D* 对应的现象与根因
- 本文档按 **PR 级拆分** 组织，每个 PR 都给出：范围 → 动机 → 方案要点 → 具体文件改动 → 接受标准 → 风险 / 回滚

---

## 1. 整体策略

三类问题需要**共用同一块基础设施**：一个"全屏仪式化遮罩层 (`RitualOverlay`)"。

- **模式切换**：遮罩在切换发生的瞬间淡入 → `BrowserView.hideAll()` → WorkbenchModeOutlet 静默换装 → 遮罩淡出。不再依赖不稳定的"内容级截图 + translate3d"。
- **主题切换**：遮罩淡入到纯色（当前主题背景） → 中心展示 sun↔moon 动画（≈ 600 ms） → 切换 `data-theme` 并让所有 CSS 变量瞬切 → 遮罩淡出（≈ 300 ms）。`backdrop-filter` / `box-shadow` 全程在遮罩下完成，用户看不到重建成本。
- **Settings 规范化**：独立 PR，与仪式化无关，但收口了整页的 primitive，让"主题过渡"白名单可以收敛。

按 **P0 → P1 → P2** 三级落地，每个 PR 都可单独回滚。

---

## 2. P0-1 · 共享仪式化遮罩层基础设施（约 450 lines）

### 范围

新增：
- `src/renderer/components/overlay/RitualOverlay.tsx`（全屏遮罩 React 根节点）
- `src/renderer/modules/overlay/useRitualOverlay.ts`（编排 hook，暴露 `start(stageName) / settle() / abort()`）
- `src/renderer/modules/overlay/ritual-overlay-channel.ts`（主进程 BrowserView hide/show 编排桥）
- `src/shared/overlay-events.ts`（事件常量）

修改：
- `src/renderer/App.tsx` 挂一个全局 `<RitualOverlay />` 在路由层之上
- `src/main/modules/browser-view/browser-view-host.ts` 新增 `overlay.beginMask(reason)` / `overlay.endMask(reason)` IPC（封装 `hideAll` + 延迟 `showActive` + forceExact bounds）
- `src/preload/index.ts` 暴露 `window.electronAPI.overlay`

### 动机

- **A1 / A2**：模式切换期间需要一个"与 BrowserView 无关"的盖子，能同时盖住原生层与 DOM 层。
- **B1 / B3**：主题仪式动画需要一个全屏空间；BrowserView 也必须被盖住。
- **复用**：将来"应用级进度"、"大版本升级"、"大型预加载"都可以复用这层 overlay。

### 方案要点

1. `RitualOverlay` 状态机：`idle → mask-enter → holding → mask-leave → idle`，对应 CSS class `is-enter / is-hold / is-leave / is-idle`。
2. 对外 API：
   - `startRitual(stageName, { masterDurationMs, pointerBlock: boolean, ariaLabel?: string })` → 返回 `RitualHandle { settle(): Promise<void>, abort(): Promise<void>, phase$: ReadableSignal }`。
   - `withRitual(stageName, async () => { …业务代码… })` → 自动 settle。
3. 只允许同一时间存在 **一个 active ritual**；后来的 `startRitual` 触发 `abort` 前一个（`themeTransitionToken` 同款 token 化）。
4. 与 BrowserView 编排：`startRitual` 在 mask-enter 完成的那帧（RAF 里 opacity=1 结束后）才 `overlay.beginMask()`；mask-leave 之前调 `overlay.endMask()` 并等待一帧，确保原生层与 DOM 层对齐。
5. `prefers-reduced-motion: reduce` 下直接跳到 holding（无淡入淡出），只做 50 ms 纯色 flash 作为节奏标记。
6. 默认样式：`background: var(--app-chrome-bg); transition: opacity 180ms cubic-bezier(0.32, 0, 0.67, 0)`，支持替换。

### 文件改动清单（新增/修改）

- + `src/renderer/components/overlay/RitualOverlay.tsx`（~120 行）
- + `src/renderer/modules/overlay/useRitualOverlay.ts`（~150 行）
- + `src/renderer/modules/overlay/ritual-overlay-channel.ts`（~60 行）
- + `src/shared/overlay-events.ts`（~20 行）
- + `src/renderer/styles/ritual-overlay.css`（~50 行）
- ~ `src/renderer/App.tsx`（挂 Provider + Overlay）
- ~ `src/main/modules/browser-view/browser-view-host.ts`（+`beginMask / endMask`）
- ~ `src/main/ipc/channels.ts` / `src/preload/index.ts`（暴露 overlay IPC）

### 接受标准

- 契约测试 `ritual-overlay-lifecycle-contract.test.ts`：手动驱动 `startRitual` 时 DOM 出现 `<div data-ritual-overlay>` 且 ARIA `role="status" aria-busy="true"`；settle 后 DOM 移除。
- `prefers-reduced-motion` 下 `holding` 阶段直接跳过淡入。
- 启动 dev 手测：在 DevTools Console 里 `window.__ready.overlay.ritual('debug').settle()` 能完整跑通。

### 风险 / 回滚

- 风险：Electron 主进程 BrowserView hide/show 与 DOM overlay 时序错位会在第一帧闪一下原生层。通过"先派 endMask IPC + 等 rAF + 再淡出遮罩"两步走控制。
- 回滚：单独回滚这个 PR 即可。下游两个 P0 PR (P0-2 / P0-3) 依赖此 PR。

---

## 3. P0-2 · 模式切换接入仪式化遮罩（约 300 lines）

### 范围

修改：
- `src/renderer/pages/WorkbenchMode.tsx` —— `handleWorkbenchModeChange` 改为走 `withRitual('workbench-mode-switch', …)`
- `src/renderer/components/layout/WorkbenchModeOutlet.tsx` —— 去掉"双向平移 + leaving 0.4 opacity"的视觉，改为 crossfade；`display: none` 在 ritual holding 阶段切换，不再担心 transitionend race
- `src/renderer/pages/modes/BrowserMode.tsx` —— 彻底删除 `shouldShowFreezeFrame` 相关 DOM / JS RAF 淡出动画，删除 `browser-resize-shell-freeze` 节点（保留 `browser-transition-mask` 皮肤骨架）
- `src/renderer/modules/browser/useBrowserResizeFreeze.ts` —— 只保留 resize 期间的截图能力，不再用于模式切换
- `src/renderer/components/layout/DraggableModeTabs.tsx` —— 删除 `handleIconHover` 派发 freeze event（因为遮罩接管了）；thumb `position` 改用 CSS 变量 `--dmt-thumb-pos`：RAF 仅 `container.style.setProperty('--dmt-thumb-pos', next)`，React state 只在整点 snap 时更新；icons 的 `getIconStyle` 改成 `color-mix(in srgb, var(--color-blue) calc(var(--dmt-proximity, 0) * 100%), var(--text-gray))`
- `src/renderer/styles/workbench-sliders.css` —— thumb 的 5 属性 transition 收紧为 2 属性（opacity + transform），且点击 press 态改用 `:active` 伪类而非 React state；`--dmt-thumb-pos` 变量化

### 动机

- **A1 / A2**：统一用遮罩接管切换，所有模式一视同仁，不再依赖仅 browser 才有的冻结截图。
- **A3**：crossfade 替代单向滑动，leaving 场景 opacity 0→0 完整淡完，不再停在 0.4。
- **A4**：thumb 与图标不再每帧 setState，只有"意图位置"变时才触发 re-render。

### 方案要点

1. 用户点 ⌘2 → `handleWorkbenchModeChange('document')` → `withRitual('workbench-mode-switch', { masterDurationMs: 260 })` → 遮罩淡入 120 ms → holding (60 ms 内 `setWorkbenchMode + BrowserView hideAll`) → 淡出 80 ms。
2. WorkbenchModeOutlet 在遮罩 `holding` 期间做"瞬时换装"（`display: none` 切到新模式，无 translate3d）。transitions 全部关掉。
3. Thumb 动画继续由 `DraggableModeTabs` 的 RAF 负责，但不再驱动 React re-render。
4. Browser 模式的 `captureStableFrame` 仍留做 resize 用，但不再订阅 `BROWSER_CAPTURE_FREEZE_EVENT`；事件保留但 deprecated。

### 文件改动清单

- ~ `src/renderer/pages/WorkbenchMode.tsx`（`handleWorkbenchModeChange` 约 40 行重写）
- ~ `src/renderer/components/layout/WorkbenchModeOutlet.tsx`（去掉 transform + opacity 动画，约 -80 / +40 行）
- ~ `src/renderer/pages/modes/BrowserMode.tsx`（删除 freeze frame JSX + 动画逻辑，约 -160 / +10 行）
- ~ `src/renderer/modules/browser/useBrowserResizeFreeze.ts`（只保留 resize 相关，约 -40 / +0 行）
- ~ `src/renderer/components/layout/DraggableModeTabs.tsx`（thumb 改 CSS 变量，约 -20 / +30 行）
- ~ `src/renderer/styles/workbench-sliders.css`（约 -20 / +20 行）

### 接受标准

- 契约测试 `workbench-mode-switch-ritual-contract.test.ts`：切换时遮罩事件顺序 = `mask-enter → beginMask(browser) → setWorkbenchMode → endMask(browser) → mask-leave`。
- 契约测试 `draggable-mode-tabs-state-contract.test.ts`：点击切换时 React render 次数 ≤ 2 次（开始 + snap 结束）；拖拽期间 render 次数 ≤ 4 次（mousedown / step / snap / mouseup）。
- 人工手测：
  - 连续快速 ⌘1 → ⌘2 → ⌘1 在 300 ms 内无闪烁
  - document ↔ rss ↔ calendar 切换节奏一致
  - Thumb 跟手流畅，4 图标不再出现 setState 抽搐
- DevTools Performance：单次模式切换 long task 数 ≤ 1（当前 ≈ 3–4）。

### 风险 / 回滚

- 风险：BrowserView 在遮罩 endMask 瞬间 show 出来时，bounds 可能未同步完毕，出现 1–2 帧空白。对策：endMask 内部做 `await hide → await bounds → await show` 三步串行。
- 风险：去掉 freeze frame 后，Browser 模式切换感觉"硬"（无模糊缓冲）。对策：遮罩在 holding 阶段用 `backdrop-filter: blur(12px)` 做观感过渡。
- 回滚：单独回滚；P0-1 遮罩基础设施不受影响。

---

## 4. P0-3 · 主题切换接入仪式化遮罩（约 250 lines）

### 范围

新增：
- `src/renderer/components/overlay/ThemeRitualChoreography.tsx`（sun↔moon SVG + 场景曲线）
- `src/renderer/assets/theme-ritual/` 目录：`sun.svg` / `moon.svg` 两个可 morph 的 SVG（或合并为一个 path + CSS animation）

修改：
- `src/renderer/stores/useTheme.ts` —— `applyColorTheme` 的 `animate: true` 路径走 `withRitual('theme-transition', …)`；动画完成后一次性移除 `data-theme-transitioning`
- `src/renderer/styles/index.css` —— `data-theme-transitioning` 的 CSS transition 白名单**全部移除**（遮罩覆盖期间用户看不到瞬切）；只保留一条 safety `body { transition: background-color 140ms ease }` 作为遮罩未挂载时的兜底
- `src/renderer/components/layout/TopBar.tsx` —— 切换按钮 aria-label 更新，遮罩期间 disabled

### 动机

- **B1**：赋予用户请求的"仪式化全屏动画"。
- **B2 / B4 / B5**：白名单缩小到 0，所有颜色在遮罩下瞬切，观感一致，`backdrop-filter` / `box-shadow` 不再被过渡连累。

### 方案要点

1. Choreography 时间线（总时长 ≈ 800 ms）：
   - 0–160 ms：遮罩淡入 (opacity 0→1)，中心 SVG 开始出现 (opacity 0→1)
   - 160–320 ms：**在遮罩不透明到达 1 的瞬间一次性切 `data-theme`**（即：用户看不到 CSS 变量过渡中间态）
   - 160–600 ms：sun ↔ moon SVG 形变 + 旋转（sun 到 moon 是"上升→落下→弯月"的一段路径）
   - 600–800 ms：遮罩淡出 + SVG 中心淡出
2. 遮罩背景色使用 `--theme-ritual-bg-from` / `-to` 两个变量，淡入时从旧主题颜色开始，淡出时已经是新主题颜色（用户视觉连续）。
3. 用户在动画中再次点 toggle → `abort` 前一次，保留"最近一次目标主题"为最终 resolved。
4. `prefers-reduced-motion: reduce` → 总时长压缩到 160 ms，无 SVG，仅简单 fade。
5. BrowserView：`beginMask('theme')` → `hideAll` → 动画 → `endMask('theme')` → `showActive` + bounds。

### 文件改动清单

- + `src/renderer/components/overlay/ThemeRitualChoreography.tsx`（~120 行）
- + `src/renderer/assets/theme-ritual/sun-moon.svg`（或内联 path 于组件内）
- + `src/renderer/styles/theme-ritual.css`（~60 行）
- ~ `src/renderer/stores/useTheme.ts`（applyColorTheme 重构，约 +30 / -10 行）
- ~ `src/renderer/styles/index.css`（白名单删除，约 -24 行）
- ~ `src/renderer/components/layout/TopBar.tsx`（按钮 disabled & aria 更新，约 +5 行）

### 接受标准

- 契约测试 `theme-ritual-orchestration-contract.test.ts`：
  - 调用 toggle 后 DOM 立刻出现 `[data-ritual-overlay][data-stage="theme-transition"]`
  - `data-theme` 的翻转发生在遮罩 opacity === 1 的时刻（用 MutationObserver 采样）
  - `prefers-reduced-motion` = reduce 时 choreography 总时长 < 200 ms
  - 系统主题变化（`animate: false`）不触发 ritual
- 手测：
  - 浏览器打开大量内容时切换主题无 BrowserView 瞬闪
  - 白名单删除后，主题切换所有 CSS 变量瞬切时用户**看不到**（因为遮罩在上）
  - 快速双击 toggle 动画不断地取消重启，最终主题正确

### 风险 / 回滚

- 风险：SVG 形变实现复杂；若时间线与 CSS 配合不好会出现"图标闪一下"。对策：SVG 用一个 path + `d` 属性 CSS 变量动画（或 `@keyframes`），不用多 SVG 切换。
- 风险：用户反感仪式感过重。对策：加 `ready-theme-ritual-intensity` 选项（full / minimal），默认 `full`；minimal 仅 260 ms 纯色 fade。
- 回滚：单独回滚；遮罩基础设施保留。

---

## 5. P1-1 · Settings 页 Primitive 化 & 规范化（约 500 lines）

### 范围

新增：
- `src/renderer/pages/settings/primitives/SettingsSection.tsx`
- `src/renderer/pages/settings/primitives/SettingsCard.tsx`
- `src/renderer/pages/settings/primitives/SettingsRow.tsx`（含 `label / description / control / variant='toggle'|'select'|'input'|'button'`）
- `src/renderer/pages/settings/primitives/SettingsEmptyState.tsx`
- `src/renderer/pages/settings/primitives/SettingsDangerButton.tsx`
- `src/renderer/pages/settings/tokens.ts`（rim radius / padding / gap / typography 四套 token）

修改：
- `src/renderer/pages/Settings.tsx` 所有子段替换为 primitive 使用（涉及 AI / Memory / Personality / UserProfile / Remote IM / RSS Storage / Theme / Network 等 12 个 section）
- `src/renderer/pages/settings-theme.ts` 收敛到 `tokens.ts`
- 各子面板（`MemoryListPanel` / `PersonalityEditor` / `UserProfileEditor` / `AI Settings*`）外层替换 `div style={{…}}` 为 `SettingsSection`

### 动机 / 覆盖

覆盖 C1–C17 全部：圆角 / 内边距 / 字号 / 排版 / 宽度 / 嵌套滚动 / 颜色变量 / 重复样式 / empty state / danger action / gap / sub-section divider / 外层对齐基线 / i18n 布局。

### 方案要点

1. Token 表：
   - radius: `lg (12), xl (16), 2xl (20)`
   - padding: `row (12/14), card (16/18), section (20)`
   - gap: `tight (8), normal (12), loose (20)`
   - font: `title(22/semibold), section(13/semibold/uppercase), label(14/medium), description(12/regular), small(11/regular)`
2. `SettingsRow` 强制"左 label + 描述、右 control"布局；不接受 vertical variant（AI 子面板需要重做或接受这一布局）。
3. `SettingsSection` 统一 padding + heading + divider。
4. Danger button 带确认弹窗 hook，不再允许 `window.confirm`。

### 文件改动清单

- + 6 个 primitive 组件
- + `tokens.ts`
- ~ `Settings.tsx` 大面积 refactor（约 30% 行替换）
- ~ `settings-theme.ts` 精简

### 接受标准

- 契约测试 `settings-primitive-coverage-contract.test.ts`：
  - `Settings.tsx` 内**禁止**出现 `style={{ padding`、`style={{ borderRadius`、`style={{ gap`、`rounded-[` 等模式
  - 每个 section 必须是 `<SettingsSection>` 直接子节点
- 视觉手测（重点）：
  - 12 个 section 之间间距一致
  - 夜间模式所有 card / row 颜色正确
  - 窄视口（≤ 720 px）不溢出
- 回归：`npm run typecheck && npm run test`

### 风险 / 回滚

- 风险：AI Settings section 原本是 vertical 堆叠，强制 horizontal 可能让某些控件（长按钮组）挤出。对策：允许 `SettingsRow` 带 `dense={true}`，但不允许完全 vertical。
- 回滚：逐 section 合并即可；新 primitive 文件不会被复用到其他页面。

---

## 6. P1-2 · 主题白名单收窄 & 面板宽度对齐（约 80 lines）

### 范围

修改：
- `src/renderer/styles/index.css`：彻底移除 `html[data-theme-transitioning='true']` 的整段 transition（遮罩兜底了）
- `src/renderer/pages/WorkbenchMode.tsx`：面板宽度过渡常量 `WORKBENCH_PANEL_MOTION_DURATION_MS` 与模式过渡对齐（如统一到 260 ms）
- `src/renderer/components/layout/WorkbenchModeOutlet.tsx`：将 `MODE_LEAVING_FADE_OPACITY` 降为 0，配合 `visibility: hidden` + transitionend 的替代方案
- `src/renderer/styles/index.css`：`body.resizing * { transition: none !important }` → `body.resizing [data-layout-motion='true'] { transition: none !important }`，收紧作用面

### 动机

- **B2 / B4 / B5**：主题仪式化上线后白名单可以全删，观感无负担。
- **A3**：leaving 场景 opacity 0 完整淡完。
- **A5**：面板与模式常量统一，多动画叠加时不会错位。
- **D4**：resize transition 抑制不再误伤 tooltip。

### 接受标准

- 契约测试 `theme-transition-selector-contract.test.ts`：`data-theme-transitioning` 下不应再匹配任何 CSS transition（遮罩期间视觉由遮罩 + 瞬切提供）
- 手测：拖 sidebar 边缘不再影响 tooltip 展开速度

### 风险 / 回滚

- 风险：主题仪式遮罩如果失败（如主题 ritual 被 reduce-motion 跳过），白名单删除后可能出现全屏瞬切。对策：保留一条 safety `body { transition: background-color 140ms ease }`。
- 回滚：恢复 index.css 白名单即可。

---

## 7. P2-1 · 次生打磨批次（约 200 lines）

### 范围

1. 删除 `*EnterOverlay` 4 个死文件（`BrowserEnterOverlay.tsx` / `CalendarEnterOverlay.tsx` / `DocumentEnterOverlay.tsx` / `RSSEnterOverlay.tsx`）及相关 CSS。— D5
2. `DocumentMode.tsx` SplitResizeHandle 改为 RAF 合并。— D3
3. `LiquidGlassScene.tsx` 密度下调：displacementScale 100→64 / 92→54 / 76→38；aberrationIntensity 全部→0.4。— D6
4. `PreviewBrowser.tsx` bounds 同步改为共享 `useHostedPreviewBounds`（已有，仅整合）。— D7
5. `MorphIconRailGroup.tsx` 去掉 `THUMB_REOPEN_DELAY_MS / THUMB_REST_SETTLE_MS` 链，is-pressing 改 `:active` 伪类。— D2
6. BrowserMode 里的 `syncVisibleHost` 六步精简为三步（hide / bounds / show），bounds 同步完全交给 `useBrowserViewBounds`。— A7
7. `captureStableFrame` 180 ms 追尾改为"进入浏览器 2 秒内最多一次"。— A6

### 接受标准

- `npm run verify` 通过
- 手测 4 模式切换节奏不变；拖 document split 时 fps 稳定
- `git grep EnterOverlay` 无结果

### 风险 / 回滚

- 风险：liquid-glass 密度下调会改变液玻观感，可能被判定为"视觉回退"。对策：同步加一个 `ready-liquid-intensity` 调节器（high / medium / low），默认 medium（当前 high）。
- 回滚：逐条合并，每条独立。

---

## 8. 时间表建议（不含具体 ETA，仅顺序）

1. **P0-1 先行**（遮罩基础设施）。完成后 Demo 给用户看，确认仪式节奏预期。
2. **P0-2 / P0-3 并行**，但 P0-2 先合（风险面更小），P0-3 后合。
3. **P1-1 Settings primitives** 独立跑，耗时最长（~ 30% 代码改写）。
4. **P1-2 白名单收窄 + 常量对齐** 紧跟 P0-3。
5. **P2-1** 作为清洁收尾，最后合。

每个 PR 出具 before/after DevTools Performance 轨迹截图 + 契约测试。

---

## 9. 度量口径（所有 PR 共用）

| 指标 | 目标 | 当前基线（审计文档估计） |
|------|------|------------------------|
| 单次模式切换 long task 数 | ≤ 1 | 3–4 |
| 模式切换主观卡顿感（10 位用户盲测） | ≥ 8/10 顺畅 | ≈ 5/10 |
| 主题切换端到端 wall time | 800 ms ± 50 | 220 ms（但含大量 CSS 重算） |
| 主题切换 Long task 数 | 0 | 2–3 |
| Settings 页打开后 paint 次数（滚动 0px） | ≤ 3 | 5–8 |
| 契约测试新增数 | +6 | 0 |

---

## 10. 待用户确认事项

在开始编码前，请用户就下列决策点明确：

1. **遮罩仪式时长**：模式切换 260 ms（默认） vs 320 ms（更稳重） vs 200 ms（更利落）？
2. **主题仪式时长**：800 ms 日↔月完整演出 vs 500 ms 精简版？
3. **SVG 设计风格**：卡通、极简线条、拟物（真实日落色彩）？优先给具体参考（如 `https://…` 或截图）。
4. **降级策略**：`prefers-reduced-motion: reduce` 下是否完全无动画？默认是。
5. **Settings 垂直 vs 水平 row**：AI 子面板是否能接受强制水平排版？如要保留垂直，告诉我哪几项 must stay vertical。
6. **液玻密度**：接受默认 medium 档 vs 保持当前 high 档？
7. **PR 合并节奏**：一口气六个 PR（3–5 天内） vs 分两周？

---

## 11. 未竟事项 / 本计划未覆盖

- 不包含主窗口 resize 性能优化（未见用户反馈）
- 不包含 LiquidTest 实验页（与稳定性无关）
- 不包含 Agent / 文档执行相关链路（只做 UI 侧）
- 不触碰 BrowserView preload scripts 的打包节奏（与本轮无关）

---

> 在用户确认第 10 节事项后，逐 PR 按 P0-1 → P0-2 → P0-3 → P1-1 → P1-2 → P2-1 顺序实施。
