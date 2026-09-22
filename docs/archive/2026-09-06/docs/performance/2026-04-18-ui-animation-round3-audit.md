---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../documentation-inventory.md)。

# Ready Workbench — UI / Animation 第三轮缺口审计

> 生成时间: 2026-04-18（同日晚间）
> 作者: Claude Opus 4.7 — 仅做代码级审计，**未执行任何代码修改**
> 前置:
> - `docs/performance/2026-04-17-ui-animation-jank-audit.md`（第一轮）
> - `docs/performance/2026-04-18-ui-animation-jank-gap-audit.md`（第二轮，同日上午）
> 关联提交: `879d56b` / `cf38c52` / `5f30d68` / `05c3ffa` / `6bf99b9` / `fab915d` / `652f02d` / `3ed769b` / `5cdc159`
> 本轮触发: 用户反馈第二轮 P0–P3 落地之后仍存在三类问题
> 1. 四模块切换依然卡顿 + 滑块 thumb 联动卡顿；新加的"渐隐界面截图"动画位置处理不好，常残留延迟
> 2. 昼夜模式切换仍不理想 —— 用户希望用"全屏日出/日落 SVG + 应用全屏淡出再淡入"的仪式化动画
> 3. 设置页 UI 不够规范，排版有错乱/不优雅
>
> 输出: 缺口清单 + 证据引用 + 分级建议，**不含执行计划**（执行计划单独成文）。

---

## 0. TL;DR（5 条先读）

1. **冻结截图与实际 BrowserView 区域不同框**：用户看到的"渐隐截图"是一张 `<img>` 叠加层（`position: absolute; top: WORKBENCH_TAB_ROW_HEIGHT; left/right/bottom: 0`），**在切换瞬间仅捕获一次 bounds 就不再更新**，而同时外壳宽度正在 CSS 插值动画、WorkbenchModeOutlet 正在做 ±32% translate3d，导致截图的"贴合感"在 350 ms 窗口里频繁错位。配合 JS RAF 淡出动画 180 ms + `FREEZE_RELEASE_DELAY_MS 220 ms` + `MODE_FINISHING_SAFETY_MS 420 ms` 三个时长线，用户主观感受是"先停一下，再跳回正轨"。
2. **模式切换实际有两套独立动画在互相叠加**：`WorkbenchModeOutlet` 的 `preparing → animating → settled` 350 ms 场景平移 + `DraggableModeTabs` 的 200 ms 滑块 ease + 0.4 opacity 淡化 leaving 层 + BrowserView 原生 `hideAll()`。任何一条走偏，整体节奏就塌了。这也是"thumb 卡顿"的来源：滑块本身只是 CSS transform，但每一 RAF 帧都在跑 React setState → 4 个图标的 `getIconStyle` 重算 → 与场景动画抢 GPU。
3. **主题切换现状**：`data-theme-transitioning` 只挂了 9 类面板 selector（`index.css:417-440`），状态栏、图标栏、`DraggableModeTabs`、Modal、Settings 等不在白名单里 —— 主题切换 220 ms 内一半在渐变、另一半已经瞬切。没有"仪式化动画"的基础设施：没有全屏遮罩、没有 sun↔moon SVG、没有编排 hook，也没有处理 `BrowserView` 原生层（CSS 盖不住原生层，必须调 `hideAll()`）。
4. **系统主题自动切换已经改为 `animate: false`**（`useTheme.ts:129`），这是第二轮审计 G12 的余温结论；但第一轮里点名的问题即"用户主动切只有 220 ms 的 CSS 过渡、缺少仪式感"仍未被解决。新方案必须区分"用户主动"和"系统自动"两条路径。
5. **Settings 页 UI 至少有 17 处不一致**：圆角、内边距、排版（控件居右 vs 控件下方）、输入宽度、字号层级、分组描边、配色变量、固定像素宽度等全部存在 drift；部分段落使用内联 `style={{…}}` 而不是主题 token，夜间模式会漏色。

---

## 1. 问题域 A —— 模式切换与 thumb 卡顿

### A1. 冻结截图动画的位置与残留机制

**结构**: `src/renderer/pages/modes/BrowserMode.tsx:526-558` —— 冻结帧 `<div class="browser-resize-shell-freeze">` 绝对定位在 `workbench-canvas-shell` 内，`top: WORKBENCH_TAB_ROW_HEIGHT`，覆盖整个内容区；内部 `<img>` 使用 `objectFit: fill`。

**采集**: `src/renderer/modules/browser/useBrowserResizeFreeze.ts:85-101` —— `captureSnapshot()` 调 `window.electronAPI?.browser?.captureWindowSnapshot(bounds)`；bounds 来自 `surfaceRef.current.getBoundingClientRect()`，**只在捕获时读一次**，之后不会随动画更新。

**显示条件**: `src/renderer/pages/modes/BrowserMode.tsx:252-254`
- `visibleFreezeFrame = freezeFrame ?? cachedFreezeFrame`
- `shouldShowFreezeFrame = Boolean(visibleFreezeFrame?.src) && (layoutPhase !== 'idle' || !isBrowserSurfaceReady || Boolean(freezeFrame))`
- 即只要 `layoutPhase !== 'idle'` 或 host 尚未 ready，就一直显示。

**淡出**: `src/renderer/pages/modes/BrowserMode.tsx:371-434` 用 JS RAF 做 ease-out-quart 的 `opacity + blur + scale` 动画，时长 `FREEZE_FRAME_CONFIG.fadeDurationMs`（= 180 ms）。淡出完成后 DOM 节点仍在树内（由 `shouldRenderFreezeFrame` 控制，line 443），直到 `freezeFrameStyle.opacity > 0` 变为 false 才卸载。

**时长叠加**:
| 动画 | 时长 | 定义 |
|------|------|------|
| 模式场景 translate/opacity | 350 ms / 320 ms | `WorkbenchModeOutlet.tsx:32` |
| finishing 安全兜底 | 420 ms | `WorkbenchModeOutlet.tsx:36` |
| 冻结帧淡出 | 180 ms | `FREEZE_FRAME_CONFIG.fadeDurationMs` |
| 冻结帧释放定时器 | 220 ms | `useBrowserResizeFreeze.ts:5` `FREEZE_RELEASE_DELAY_MS` |
| 面板宽度过渡 | 180 ms | `WORKBENCH_PANEL_MOTION_DURATION_MS` |
| 主模式切换整体 | `MODE_TRANSITION_DURATION_MS` 350 ms | `src/renderer/pages/WorkbenchMode.tsx:205-209` |

**用户观感路径（browser → document）**:
1. 用户点 document 图标（T=0）。
2. `handleWorkbenchModeChange` → `setBrowserLayoutMotionPhase('leaving')` + `setIsMotionSettled(false)` + `setWorkbenchMode('document')` (T=0, `WorkbenchMode.tsx:172-210`)。
3. `WorkbenchModeOutlet` `useEffect(mode)` → `stage='preparing'` (T≈1f, `WorkbenchModeOutlet.tsx:219-229`)。
4. RAF → `stage='animating'` (T≈2f, `WorkbenchModeOutlet.tsx:239-248`)，4 个 `ModeScene` 的 `transition: transform 0.35s` 同时启动，leaving 场景 translate3d → ±32%，opacity → 0.4。
5. 与此同时冻结截图仍在渲染（因为 `layoutPhase !== 'idle'`），位置是**动画开始之前的 bounds**；但 `ModeScene` 内部已在 translateX 位移 —— 截图"贴"在 shell 上一起移动，但它的原始 bounds 并不对应当前 translate 之后的位置。
6. T=350 ms → `setIsMotionSettled(true) + setBrowserLayoutMotionPhase('idle')` (`WorkbenchMode.tsx:205-209`)。
7. `shouldShowFreezeFrame` 翻为 false → JS RAF 淡出 180 ms（T=350 → 530 ms）。
8. 期间 `shouldRenderFreezeFrame` 仍为 true（`line 443`），DOM 节点带 `willChange: 'opacity, filter, transform'` 继续合成层（`line 542`）。
9. 直至 opacity 到 0 且 `shouldShowFreezeFrame` 为 false，节点才移除。

**关键缺口**:
- **残留帧主因**：冻结截图的坐标是切换前的；WorkbenchModeOutlet 动画走 translate3d；如果切换的目标模式又把 canvas-shell 宽度做插值（`5f30d68` 引入的面板宽度 CSS 过渡），**截图尺寸与实际内容最终位置不一致**。动画中截图相对于父 shell 被一起平移，但 shell 宽度 180 ms 改了，截图 `objectFit: fill` 会拉伸，视觉上像是"先放大 / 压扁一下再归位"。
- 若用户快速连切 ⌘1→⌘2→⌘1，`freezeFrameStyle` 的状态会因 `prevShouldShowRef` 与 `shouldShowFreezeFrame` 组合而进入"刚开始淡出 → 被再次触发显示 → 从当前 opacity 回到 1"的尖脉冲（`BrowserMode.tsx:386-434`）；对用户观感就是"闪一下"。

### A2. 非 browser 模式之间切换没有冻结截图做平滑

`DraggableModeTabs.tsx:209-218` 的 `handleIconHover` 仅在 `mode === 'browser' && activeMode !== 'browser'`（鼠标悬停到浏览器图标、且当前不是浏览器）时才延迟 160 ms 派发 `BROWSER_CAPTURE_FREEZE_EVENT`。

**影响**: document ↔ rss、document ↔ calendar、rss ↔ calendar 这些切换**没有任何冻结帧遮罩**；只有 `WorkbenchModeOutlet` 的 translate3d + opacity 0.4 淡化 leaving 场景。而这些模式都挂在 `content-visibility` 之外（`WorkbenchModeOutlet.tsx:167` `display: isVisible ? 'block' : 'none'`）—— 真正的模式内容（文档编辑器、RSS 列表、日历）直接参与 350 ms 的 translate3d 动画，组件内部若有 backdrop-filter（文档路径条、RSS 顶部 surface、Calendar header）就会在动画期间持续重建 offscreen 缓冲，这是主观"卡一下"的来源。

### A3. Leaving 场景停留在 0.4 opacity 的不合理

`WorkbenchModeOutlet.tsx:35` `MODE_LEAVING_FADE_OPACITY = 0.4` —— leaving 场景动画期间 opacity 维持 0.4，而不是淡到 0。结合 `pointerEvents: 'none'`（`line 168`），虽然不会被交互，但它**仍在参与合成层**；同时它的子树里如果有 backdrop-filter（document-editor-surface、document-path-bar、document-preview-surface），还要以 0.4 透明度重新 raster 一遍。

### A4. 滑块 thumb "卡"感的来源

`DraggableModeTabs.tsx:49-110` 每次外部 mode 变化会跑 `startClickAnimation`（200 ms ease-out cubic，`slider-motion.ts:17-20`）或 `startSpringAnimation`（弹簧）。两者都在 RAF 里 **`setPosition(next)` —— 触发 React re-render**，每帧都会重新计算 4 个图标的 `getIconStyle(index)`（`DraggableModeTabs.tsx:227-237`）；`getIconStyle` 依赖 `position` 导致每帧 4 个 `<button>` 的 `style={{ opacity, color }}` 都在变动。

**问题**:
- **与模式场景动画抢 GPU**：模式切换的 200 ms 正好落在 WorkbenchModeOutlet 的前 200 ms 里，GPU 同时跑 4 个 ModeScene translate3d + 1 个 thumb 平移 + 4 个按钮 opacity 插值。
- **thumb CSS 一次 transition 5 个属性**（`workbench-sliders.css:87-92`）：`opacity 140ms` + `border-color 120ms` + `box-shadow 140ms` + `background 140ms`。其中 `box-shadow` 和 `background` 插值都非常昂贵（box-shadow 有 3 层 rgba，包含 `inset` 多段，background 是两层 linear-gradient）。每次点击进入 `is-pressing` / `is-resting` 都会触发一次这 4 个属性的动画。
- **React setState 每帧触发**：`setPosition(next)` 虽然数值 primitive，但 React 仍会走一次 reconciliation，4 个 icon button + 1 个 thumb 的 style 对象都会被重新求值。

### A5. 面板宽度过渡与模式切换时长错配

`WORKBENCH_PANEL_MOTION_DURATION_MS = 180`（来自 `5f30d68`）≠ `MODE_TRANSITION_DURATION_MS = 350`（`WorkbenchMode.tsx:205-209`）。若用户先触发模式切换（350 ms）又在中途按 ⌘\ 切 sidebar（180 ms），两个动画的收尾时间错开 170 ms，在这 170 ms 里 `isMotionSettled` 尚未翻 true，BrowserView 的 `syncBrowserVisibility` 被延迟。

### A6. `captureStableFrame` 追尾刷帧 180 ms 定时器

`BrowserMode.tsx:298-310` —— 每次 `layoutPhase === 'idle' && isBrowserHostFullyVisible && !activeTab?.loading` 就 `setTimeout(captureStableFrame, 180)`。切换浏览器模式后这条必然触发，在 layoutPhase 刚 idle 的下一帧做一次原生 `captureWindowSnapshot` IPC —— 对用户观感影响不大，但是**浏览器模式切回后 180 ms 都在做一张 PNG 采样**，期间主进程 CPU 有短暂尖峰。

### A7. BrowserView 进入路径仍有 6 步串行

`BrowserMode.tsx:318-346` `syncVisibleHost()` 步骤:
1. `hideAll`
2. `sendBoundsImmediate({ forceExact })`
3. `fitActiveTabToBounds(activeTabId)`
4. `sendBoundsImmediate({ forceExact })`
5. `syncBrowserVisibility({ forceExact })`
6. 2×RAF 后 `captureStableFrame`（带 48 ms fallback 定时器）

加上 `line 357-361` 的 trailing `syncBrowserVisibility`（layoutPhase 翻 idle 时），每次进入 browser 模式至少 6 次 IPC。上一轮 `05c3ffa` 已经把 hide/show 决策收口到 `useBrowserViewBounds`，但 BrowserMode 里仍有第 1 步 `hideAll`、第 4 步 `sendBoundsImmediate`、第 5 步 `syncBrowserVisibility` —— 与 Bounds Hook 的自动 settled 有一部分重复。

---

## 2. 问题域 B —— 主题切换体验与仪式感缺失

### B1. 当前机制总览

- **入口 UI**: `src/renderer/components/layout/TopBar.tsx:78-83` —— `IconButton` 日/月图标调用 `toggleTheme()`。
- **状态机**: `src/renderer/stores/useTheme.ts:145-154` —— `toggleTheme` 循环 `light → dark → system → light`。
- **应用函数**: `useTheme.ts:70-109` `applyColorTheme(resolved, option, { animate })`:
  1. `clearThemeTransitionWork`（取消上一次 token）
  2. `root.setAttribute('data-theme-transitioning', 'true')`（line 88）
  3. RAF1: `root.setAttribute('data-theme', resolved)`（line 93）
  4. RAF2: 同步 Electron `nativeTheme`（line 95-100）
  5. `setTimeout(…, THEME_TRANSITION_DURATION_MS = 220)` 移除 `data-theme-transitioning`
- **系统主题监听**: `useTheme.ts:125-132` —— 当用户设置为 `system` 时自动同步，**走 `{ animate: false }`**（line 129），不会触发仪式动画。这比第二轮审计 G12 担忧的要好。
- **CSS 白名单**: `src/renderer/styles/index.css:417-440` 只覆盖 9 类 selector（body / ready-app-bg / workbench-mode-root / workbench-canvas-shell / workbench-panel-frame / glass-surface-panel / glass-surface-floating / browser-header-surface / document-editor-surface / document-preview-surface / document-path-bar），`backdrop-filter` 已由 `879d56b` 移除。
- **持续时长**:
  - 绝大多数白名单面板：220 ms ease
  - `.ready-app-bg` 的 opacity：**260 ms**（`index.css:470` 之前的条目）—— 比其他面板多 40 ms 尾巴
  - 单独按钮 `IconButton` / `settings-list-item` 等：160 ms / 200 ms，不在白名单里

### B2. 白名单之外"瞬切"的面板（会撕裂观感）

以下组件不在 `html[data-theme-transitioning='true']` 白名单里，主题切换时颜色会**瞬切**，与白名单里的 220 ms 过渡不同步：

| 组件 | 文件 | 原因 |
|------|------|------|
| StatusBar | `src/renderer/components/layout/StatusBar.tsx` | `data-liquid-shell="statusbar"`，无 transition 规则 |
| IconRail | `src/renderer/components/layout/IconRail.tsx:26` | 无 transition |
| MorphIconRailGroup 按钮 | `src/renderer/components/motion/MorphIconRailGroup.tsx` | 单个按钮 200 ms，与 220 ms 不同步 |
| `DraggableModeTabs` 壳 | `src/renderer/styles/workbench-sliders.css:185-200` | 无 transition |
| `DraggableModeTabs` thumb | `workbench-sliders.css:212-236` | `will-change: transform` 无颜色过渡 |
| `icon-rail-slider` 壳 | `workbench-sliders.css:8-21` | 无 transition |
| Modal 背景 | `src/renderer/components/ui/Modal.tsx` | 无主题感知 transition |
| Settings 内部 glass 表面 | `src/renderer/pages/Settings.tsx`（多处内联 style） | 用 inline style，未挂 class |
| LiquidGlass 组件 | `src/renderer/components/ui/LiquidGlassScene.tsx` 及派生 | React 重算，非 CSS 变量，不响应 transition |

`liquid-glass-react` 内部是 SVG filter 管道，**完全不响应 CSS transition**；主题切换瞬间，所有液玻元素直接刷新，与 220 ms 背景过渡错位。

### B3. "仪式化全屏动画"所需基础设施（当前全部缺失）

用户提出的设计：*白天 → 黑夜：先全屏内容消失（淡出），画面中心出现小 SVG（日出转日落），应用内全屏由亮渐暗，再 UI 各组件渐显。*

**目前缺失**:
1. **全屏遮罩容器**：没有一个 `fixed inset-0 z-[9999]` 的根节点能覆盖整个 Electron 窗口（除 BrowserView 原生层外）。
2. **日↔月 SVG 资源**：仓库里只有 lucide-react 的 15×15 Sun/Moon 小图标。没有可放大到视口中央、支持形变/旋转的矢量。
3. **编排 hook**：没有 `useThemeTransitionOverlay()` 或类似，能把"淡出 UI → 显示 SVG → 切换 `data-theme` → 淡入 UI"串成一个可取消的时间线。
4. **BrowserView 盲区处理**：`BrowserView` 是 Electron 原生层，CSS 无论 z-index 多高都盖不住；要做全屏遮罩必须先 `window.electronAPI.browser.hideAll()`；动画结束后再 `showActive()` + bounds 重同步。目前 `useBrowserViewBounds.ts` 的 hide/show 是为模式切换与 resize 设计的，没有"主题切换期间临时遮挡"的 API。
5. **可取消性**：动画期间如果用户再次点击 toggle，应该能优雅跳到最终状态。现在 `applyColorTheme` 靠 `themeTransitionToken` 做 abort，但只覆盖 CSS 变量切换，不覆盖遮罩动画。
6. **Reduced-motion 降级**：如果系统 `prefers-reduced-motion: reduce`，应该跳过全屏动画，直接切。当前 `applyColorTheme` 没有这条分支。

### B4. 主题切换时 CSS 变量时长错配（微闪烁）

| Selector / 属性 | 持续时间 | 主题切换窗口 | 影响 |
|-----------------|----------|-------------|------|
| 白名单主面板 | 220 ms | 基准 | 正常 |
| `.ready-app-bg` opacity | 260 ms | +40 ms | 背景比面板晚结束 40 ms |
| `IconButton` transitions | 160 ms | -60 ms | 比面板早 60 ms 完成 |
| `icon-rail-slider__button` | 300 / 320 ms | +80 / +100 ms | 比面板晚 80+ ms |
| `.draggable-mode-tabs__icon` | 80 ms | -140 ms | 图标几乎是瞬切 |
| `.draggable-mode-tabs__thumb-glow` | 150 ms | -70 ms | Glow 过渡比面板早 |

这些散落的过渡时长让整个 220 ms 窗口内总有"某一层在变"，观感不连续。

### B5. `data-theme-transitioning` 目前的副作用面

除了颜色，`data-theme-transitioning='true'` 还会触发面板的 `transition: background-color 220ms ease, color 220ms ease, border-color 220ms ease, box-shadow 220ms ease`（`index.css:417-440`）。其中 `box-shadow` 对液玻面板最贵（shadow 有多层 + blur），每帧重绘一次。

如果将来做全屏遮罩动画，遮罩期间 CSS 变量其实可以在遮罩下瞬切，无需再给面板挂 220 ms transition —— 也就是说**全屏动画方案可以让 `data-theme-transitioning` 的 CSS transition 需求大幅下降**。

---

## 3. 问题域 C —— Settings 页规范化缺口

> 入口: `src/renderer/pages/Settings.tsx`（共 ~1900 行，含 12 个 section + 6 个自定义子面板）
> 模式: 左侧导航 + 右侧滚动内容（`Settings.tsx:1560-1633`）
> 样式 token: `src/renderer/pages/settings-theme.ts`（常量/工厂）
> 子页面: AI Settings / Memory / Personality / UserProfile / Remote IM / RSS Storage

### C1. 圆角与边框不统一

出现过的 border-radius：`rounded-md(12)`、`rounded-lg(18)`、`rounded-xl(20)`、`rounded-2xl(24)`、`rounded-[18px]`、`rounded-[24px]`、`rounded-full`。

- 同级按钮用 `rounded-lg` (`Settings.tsx:1245` 附近)
- 信息卡用 `rounded-2xl` (`Settings.tsx:226`)
- Stat card 用 `rounded-[18px]` (`Settings.tsx:1469`)
- AI 字段卡 `rounded-[24px]` 硬编码 (`Settings.tsx:1398`)
- 聊天 Chip `rounded-full` (`Settings.tsx:258`)

同一页面里"卡片级"圆角不一致。

### C2. 内边距数字到处飘

`Settings.tsx:229` AI 字段卡 `14px 16px`；`Settings.tsx:260` 能力 chip `6px 10px`；`Settings.tsx:282` 信息 chip `10px 12px`；`Settings.tsx:1399` RSS 信息卡 `20px 22px`；`Settings.tsx:1427/1432/1441` 加载/空/项 `18px 20px`；侧栏 wrapper `10px 8px`（`Settings.tsx:1568`），列表按钮 `14px 8px`（`settings-theme.ts:156`）—— 列表按钮垂直 14 ≠ 容器垂直 10，造成上下不对齐。

### C3. 字号层级错乱

`text-[22px] font-semibold` 页头（`Settings.tsx:1639`）、`text-[14px]` 设置行标题（`Settings.tsx:1813`）、`text-[13px]` AI 标题（`Settings.tsx:525`）、`text-[12px]` 子小节标题（`Settings.tsx:1692`，uppercase + semibold）、`text-[11px]` 小说明、`text-[10px]` 最小边缘标签。14 vs 13 vs 12 三档"正文"的使用没有语义分界，同一角色字号不一致。

### C4. 控件与标签排版不统一

标准 section（`Settings.tsx:1803-1928`）：`flex items-center justify-between` —— 左 label + 描述，右 control。AI section（`Settings.tsx:689` 附近用 `AISettingsFieldCard`）：**垂直堆叠**——label → description → control，风格不同。

用户一条"设置页"里同时混用两种布局范式，视觉跳跃。

### C5. 固定像素控件宽度

`Settings.tsx:1865` `Select width: 180`
`Settings.tsx:1886` input `width: 240`

没有 `w-full / flex-1` 兜底，窄视口会挤/溢出，夜间模式下视觉效果差。

### C6. 内联 style 和常量/工厂混用

- `AISettingsInfoChip` 用 inline `style={{…}}`（`Settings.tsx:1297-1312`），而 `AISettingsFieldCard` 用 class
- `MemoryListPanel` 外层 `style={{ display: 'flex', flexDirection: 'column', gap: 24 }}`（`Settings.tsx:1657-1670`），不使用 Tailwind
- 同页既 `tailwind gap-3` 又 `inline gap: 16` 共存

同角色样式从 inline → tailwind → settings-theme 常量三条路径都有，每次改主题或间距都要三处改。

### C7. 按钮样式不一致

- 标准设置按钮用 `getSettingControlWidth(setting)` 返回 short/medium/wide 三档 (`Settings.tsx:1920`)
- AI section 按钮直接 inline `padding: '7px 12px'`，无宽度约束
- 有些 danger 按钮依赖 `color: 'var(--color-red)'` 内联，没有统一 danger variant

### C8. 主色、次色、危险色变量不统一

部分位置用 `var(--bg-primary)`（`Settings.tsx:1322`）；部分用硬编码 rgba；部分用 `var(--text-muted, #666)` 里带 fallback `#666` —— fallback 在夜间模式下就是 hardcoded 灰色，无法随主题反转。

### C9. Grid 间距不一致

`gap-2`（`Settings.tsx:1295` Model tags）、`gap-3`（`Settings.tsx:1459` RSS stat）、`gap-4`、`gap-6`（主 AI 面板 `Settings.tsx:515`）—— 同一页面 4 种 gap 并存。

### C10. 字重层次没有语义

页头 / 子小节标题 / 设置行标题 全部 `font-semibold`，仅字号不同；区分度弱。`text-[22px]` 页头与 `text-[12px]` 小节标题同为 semibold，观感"首尾重中间轻"。

### C11. 嵌套滚动容器

`Settings.tsx:1564` sidebar 自身 `overflow-auto`；`Settings.tsx:1630` 内容区 `h-full overflow-auto`；子面板（Memory 列表等）也可能自带滚动。三层嵌套 overflow 在长设置列表下会出现"内层滚到顶/底，外层还能继续滚"的割裂。

### C12. Toggle/checkbox 类设置行重复声明样式

`Settings.tsx:709 / 1245 / 1257` 重复写 `flex items-center justify-between gap-3` + inline `style={SETTINGS_SUBTLE_CARD_STYLE}`，没有抽出 `ToggleRow` 组件 —— 修一次样式要扫 3 处。

### C13. 危险操作视觉与确认样式不统一

部分删除操作走项目 `ConfirmDialog`，部分是内联 `window.confirm`，部分是自定义小确认气泡。缺少"危险操作"标识统一 pattern。

### C14. 空/加载/错误状态样式分裂

RSS Storage section 的 `加载中 / 无数据 / items 列表`（`Settings.tsx:1427-1441`）用 `padding: 18px 20px`；Memory / Personality 的类似空态用的是子面板内部样式。三个子模块 empty state 文案字号、图标、留白都不同。

### C15. 可国际化性差

固定像素宽度（见 C5）+ 硬编码中文长度拟合，长的英文或重新排版会溢出。

### C16. 右侧内容区横向对齐基线不齐

`Settings.tsx:1639` 页头用 `max-w-xx` 左对齐；部分 section 用 `px-6`、部分 `px-4`；AI section 有自己的 `p-6`；左边留白深度从 16 → 24 px 不一。

### C17. Sub-section 分隔视觉

部分 section 之间靠 `border-t`，部分靠 margin，部分靠 Card 边框。没有统一"section-separator" token。

---

## 4. 问题域 D —— 次生/辅助问题

### D1. 冻结帧在快速连切时的脉冲

`BrowserMode.tsx:386-418`：`prevShouldShowRef.current && !shouldShowFreezeFrame` 才进淡出；如果在淡出中 `shouldShowFreezeFrame` 再次为 true（用户再次切回 browser），`prevShouldShowRef` 仍为 true，淡出不会触发，opacity 会直接跳回 1 —— 但可能上一次 RAF 的 `freezeFrameStyle.opacity` 已经插到 0.3，于是视觉上"刚淡下来又瞬时拉满"。

### D2. Thumb 的 `is-pressing` / `is-resting` 三态切换仍可叠加定时器

`workbench-sliders.css:99-127` 的 `is-pressing` 和 `is-resting` 两个 modifier 依赖 React state（见 `MorphIconRailGroup.tsx` 的 `THUMB_REOPEN_DELAY_MS 140` / `THUMB_REST_SETTLE_MS 120`）。点击 → 快速切换变体时，120 ms / 140 ms 的 setTimeout 会叠加一条新的定时器链。上一轮已经把大头清掉，但未完全清零。

### D3. 文档模式 split handle 仍缺 RAF 合并

`src/renderer/pages/modes/DocumentMode.tsx:35-61` `SplitResizeHandle` 在 mousemove 里直接 `onResizeRef.current(delta)`，对比 WorkbenchMode 主 handle 已做 RAF 合并。拖动 split 时两个编辑器 layout 各自重算。

### D4. `body.resizing *` 作用面过大

`src/renderer/styles/index.css:1251-1253` `body.resizing * { transition: none !important }` —— resize 期间**整棵树**所有 transition 都被禁用。上一轮已点名。

### D5. 死码 `*EnterOverlay`

4 个文件仍存在 `src/renderer/components/browser/BrowserEnterOverlay.tsx` / `calendar/CalendarEnterOverlay.tsx` / `document/DocumentEnterOverlay.tsx` / `rss/RSSEnterOverlay.tsx`，页面已经不再挂载。

### D6. `liquid-glass-react` 密度未降

`src/renderer/components/ui/LiquidGlassScene.tsx:52-83` 的 `primitiveByTone` 仍是 displacementScale 100/92/76，aberrationIntensity 1.8–2。SVG filter pipeline 在主题切换 / 模式切换期间成本仍高。

### D7. PreviewBrowser 自成一套 bounds 同步

`src/renderer/components/rss/PreviewBrowser.tsx:87-212` 与 `useBrowserViewBounds` 平行维护 bounds 同步；RSS 模式切换期间两套同时在跑。

---

## 5. 缺口 → 解法方向矩阵（不含执行计划）

| 编号 | 问题 | 根因 | 建议方向 | 优先级 |
|------|------|------|---------|--------|
| A1 | 冻结截图位置与动画终点不一致 | 只在切换前捕一次 bounds；shell 宽度 / translate 都变 | 要么让冻结帧仅在"原位"短暂显示（不参与 translate），要么用更强的帧同步：切换前捕图 → BrowserView hideAll → 冻结帧独立于 ModeScene 直接盖全屏 → 模式动画完成后淡出 → 再 showActive + bounds 同步 | P0 |
| A2 | 非 browser 模式之间切换无遮罩 | 只对 browser 做 freeze | 统一"模式切换覆盖层"机制，所有模式都接同一层（可用同一个 screen-shot 或只用颜色 curtain） | P0 |
| A3 | Leaving 场景停在 0.4 opacity 继续参与合成 | `MODE_LEAVING_FADE_OPACITY` | 要么 0→0 淡完整，要么加 `visibility: hidden` 触发 transitionend 后再 display:none | P1 |
| A4 | Thumb + 4 按钮 setState 每帧抢 GPU | RAF 内 setState + 每帧 4 个 style 重算 | 将 thumb 平移下沉到 CSS custom property `--thumb-pos`，RAF 只 `style.setProperty`，不做 React state。4 按钮 style 改为 CSS 变量派生 | P0 |
| A5 | 面板宽度 180 ms ≠ 模式 350 ms | 两个常量分离 | 对齐到统一常量；或在 `handleWorkbenchModeChange` 里只在 motion settled 之后 allow sidebar/chat panel 再动 | P1 |
| A6 | `captureStableFrame` 180 ms 尾随 IPC | 定时器固定 | 改为"仅当用户可能会再次切回 browser 时才抓图"，或第一次切进 browser 后 2 秒内才抓一次 | P2 |
| A7 | BrowserView 进入 6 步串行 | 历史累积 | 合并为"hide → bounds → show"三步；bounds 同步由 Hook 单点负责 | P2 |
| B1 | 主题切换无仪式感 | 只有 220 ms CSS 过渡 | 新增"theme transition orchestrator"：全屏遮罩 + sun↔moon SVG + BrowserView hide/show 编排；CSS 过渡简化 | P0 |
| B2 | 白名单之外组件瞬切 | 白名单只 9 类 | 把仪式化方案上线后，白名单可以收紧为"只保留必要 color 过渡"；或者扩充白名单覆盖 status/icon-rail/draggable-tabs/modal/settings | P1 |
| B3 | 全屏动画基础设施缺失 | 没有遮罩/SVG/hook | 新增 `<ThemeTransitionOverlay>` 全局根节点 + `useThemeTransitionChoreography` hook | P0 |
| B4 | CSS 变量时长错配 | 多个组件有自己的过渡 | 定义 `--theme-transition-duration` token，各处继承 | P1 |
| B5 | `data-theme-transitioning` 副作用面偏大 | box-shadow 过渡贵 | 在仪式动画遮罩期间瞬切变量，不再挂面板级过渡 | P1 |
| C1–C17 | Settings 页多处不一致 | 样式 token 未集中 | 集中 section/card/row/control 四类 primitive；改写 AI/Memory/RSS 子面板以复用；定义 ToggleRow / DangerButton / EmptyState 组件 | P1 |
| D1 | 冻结帧脉冲 | 状态机逻辑 | 用 `useReducer` 管理 freeze state，显隐切换有显式"正在淡出"中间态 | P2 |
| D2 | Thumb 三态定时器链 | setTimeout 叠加 | 把 is-pressing / is-resting 简化成"点击瞬间"的 CSS 伪类，不用 state | P2 |
| D3 | Split handle 无 RAF | 未合并 | 复用主 handle RAF 合并工具 | P2 |
| D4 | `body.resizing *` 面过大 | `*` selector | 收紧到 layout-related selector 白名单 | P2 |
| D5 | `*EnterOverlay` 死码 | 未清理 | 删除 4 文件 + 相关 CSS | P3 |
| D6 | liquid-glass 密度未降 | 未调参 | 按 tone 降 displacement / aberration；核心内容卡保留 | P2 |
| D7 | PreviewBrowser 平行 bounds | 历史设计 | 抽共享 hook | P2 |

---

## 6. 证据索引（file:line）

| 类别 | 文件 | 行 | 关注点 |
|------|------|----|--------|
| 模式场景 | `src/renderer/components/layout/WorkbenchModeOutlet.tsx` | 32–36 | `MODE_SCENE_TRANSITION / MODE_LEAVING_FADE_OPACITY / MODE_FINISHING_SAFETY_MS` |
| 模式场景 | `src/renderer/components/layout/WorkbenchModeOutlet.tsx` | 84–115 | transform / opacity 解析 |
| 模式场景 | `src/renderer/components/layout/WorkbenchModeOutlet.tsx` | 141–189 | `ModeScene` 节点 + onTransitionEnd |
| 模式场景 | `src/renderer/components/layout/WorkbenchModeOutlet.tsx` | 219–285 | 状态机两个 RAF + safety timer |
| 主切换 | `src/renderer/pages/WorkbenchMode.tsx` | 166–210 | `handleWorkbenchModeChange` + `MODE_TRANSITION_DURATION_MS 350` |
| 冻结帧 | `src/renderer/pages/modes/BrowserMode.tsx` | 240–254 | visibleFreezeFrame / shouldShowFreezeFrame |
| 冻结帧 | `src/renderer/pages/modes/BrowserMode.tsx` | 257–269 | `BROWSER_CAPTURE_FREEZE_EVENT` 监听 |
| 冻结帧 | `src/renderer/pages/modes/BrowserMode.tsx` | 291–310 | 追尾 `captureStableFrame` 180 ms |
| 冻结帧 | `src/renderer/pages/modes/BrowserMode.tsx` | 318–353 | `syncVisibleHost` 六步 |
| 冻结帧 | `src/renderer/pages/modes/BrowserMode.tsx` | 371–443 | JS RAF 淡出动画 + render 条件 |
| 冻结帧 | `src/renderer/pages/modes/BrowserMode.tsx` | 526–597 | 冻结帧 + 过渡遮罩 JSX |
| 冻结帧 | `src/renderer/modules/browser/useBrowserResizeFreeze.ts` | 5 / 85–101 / 126–172 | 常量 / capture / resize 端点 |
| Thumb | `src/renderer/components/layout/DraggableModeTabs.tsx` | 20 | `CAPTURE_FREEZE_HOVER_DELAY_MS = 160` |
| Thumb | `src/renderer/components/layout/DraggableModeTabs.tsx` | 49–110 | click / spring 动画 |
| Thumb | `src/renderer/components/layout/DraggableModeTabs.tsx` | 113–126 | external mode sync（启动 click 动画） |
| Thumb | `src/renderer/components/layout/DraggableModeTabs.tsx` | 209–218 | 悬停预捕获截图 |
| Thumb | `src/renderer/components/layout/DraggableModeTabs.tsx` | 227–280 | `getIconStyle` 每帧重算 |
| Thumb | `src/renderer/modules/workbench/slider-motion.ts` | 1–20 | 弹簧 / 200 ms 常量 |
| Thumb | `src/renderer/styles/workbench-sliders.css` | 56–92 | icon rail thumb 5 属性 transition |
| Thumb | `src/renderer/styles/workbench-sliders.css` | 99–127 | is-pressing / is-resting |
| 主题 | `src/renderer/stores/useTheme.ts` | 70–109 | `applyColorTheme` 两段 RAF |
| 主题 | `src/renderer/stores/useTheme.ts` | 125–132 | 系统变化走 `animate: false` |
| 主题 | `src/renderer/stores/useTheme.ts` | 145–154 | toggleTheme 循环 |
| 主题 | `src/renderer/styles/index.css` | 417–440 | 白名单 9 selector |
| 主题 | `src/renderer/styles/index.css` | 470 附近 | `.ready-app-bg` 260 ms 尾巴 |
| Settings | `src/renderer/pages/Settings.tsx` | 226 / 229 / 258 / 260 / 280 / 282 / 357 / 361 | 圆角 / 内边距多样 |
| Settings | `src/renderer/pages/Settings.tsx` | 515 / 1560 / 1572 / 1295 / 1459 | gap 不一 |
| Settings | `src/renderer/pages/Settings.tsx` | 525 / 689 / 1297–1312 / 1398 / 1403 / 1427–1441 / 1469 / 1639 / 1692 / 1803–1928 / 1865 / 1886 / 1920 | 字号/布局/宽度 drift |
| Settings | `src/renderer/pages/Settings.tsx` | 1564 / 1630 | 嵌套滚动 |
| Settings | `src/renderer/pages/Settings.tsx` | 709 / 1245 / 1257 | 重复 toggle 样式 |
| Settings | `src/renderer/pages/Settings.tsx` | 1657–1670 | Memory 面板内联 style |
| Settings 主题 | `src/renderer/pages/settings-theme.ts` | 整文件 | 常量定义 |
| 死码 | `src/renderer/components/browser/BrowserEnterOverlay.tsx` 等 4 个 | 全部 | 仍在仓库但无引用 |
| body.resizing | `src/renderer/styles/index.css` | 1251–1253 | `* { transition: none !important }` |
| split | `src/renderer/pages/modes/DocumentMode.tsx` | 35–61 | 无 RAF 合并 |
| liquid-glass | `src/renderer/components/ui/LiquidGlassScene.tsx` | 52–83 | 密度未降 |

---

## 7. 度量建议（下轮落地前后对比）

使用 DevTools Performance 在 macOS 上录 5 秒轨迹：

| 场景 | 触发 | 核心指标 |
|------|------|---------|
| 四模式切换 | ⌘1 → ⌘2 → ⌘3 → ⌘4 → ⌘1 | Long task 数、Recalc Style 次数、Composite Layers 次数、冻结帧渲染到卸载的 wall time |
| 快速连切 | 200 ms 内 ⌘1 → ⌘2 → ⌘1 | 状态机是否留有 leaving scene 残迹 |
| 主题切换 | 点 toggle 3 次 | 遮罩动画端到端 wall time、BrowserView hide/show 次数、主题 CSS 变量切换耗时 |
| 设置页打开 | 打开 Settings 再滚 | overflow 层数、paint 次数 |
| resize | 拖 sidebar handle 2 s | transition 抑制是否误伤 tooltip |

建议同时加 3 条契约测试：
1. `workbench-freeze-frame-bounds-contract.test.ts`：冻结帧的 rect 在动画过程中必须等于 modeScene shell 的 rect（或干脆脱离 shell 定位）。
2. `theme-transition-overlay-contract.test.ts`：主题切换时根 DOM 必须出现 `<div data-theme-overlay>` 且在 reduce-motion 下直接跳过。
3. `settings-primitive-coverage-contract.test.ts`：Settings.tsx 中的每一处卡片/行/按钮必须来自 `settings-primitives` 模块（禁止直接内联 style）。

---

## 8. 下一步（仅方向，不是 PR 拆分）

1. **P0 一组 PR**：模式切换仪式化（A1/A2/A4）+ 主题切换仪式化（B1/B3），共享"全屏遮罩"基础设施。
2. **P1 一组 PR**：Settings primitives + 白名单主题过渡收窄（C1–C17 + B2/B4/B5 + A3/A5）。
3. **P2 一组 PR**：次生打磨（A6/A7/D1–D7）。

> 本文件是审计输出。**执行计划请参见** `docs/archive/2026-09-06/docs/superpowers/plans/2026-04-18-ui-animation-round3-remediation-plan.md`（随后产生）。
