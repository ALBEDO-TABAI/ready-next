 Ready — UI / Animation Round 3 修复计划（P0 详细版 + P1/P2 概要）

 ▎ 生成时间: 2026-04-18
 ▎ 审计依据: docs/performance/2026-04-18-ui-animation-round3-audit.md
 ▎ 三步走: P0 → P1 → P2（不再按 PR 拆）

 ---
 Context（为什么做）

 第二轮审计落地后（提交 879d56b / cf38c52 / 5f30d68 / 05c3ffa / 6bf99b9 / fab915d / 652f02d / 3ed769b /
 5cdc159）观感改善明显，但仍留下三类结构性问题：

 1. 模式切换仍卡：冻结截图 bounds 只捕一次、不跟随后续 translate3d + 宽度 CSS 插值；非 browser
 模式之间切换完全没有遮罩；leaving 场景停在 0.4 opacity 继续合成；DraggableModeTabs 每 RAF setPosition 触发 React
 重算 4 个图标样式，与场景动画抢 GPU。
 2. 昼夜切换缺仪式感：当前只有 220 ms CSS 过渡（data-theme-transitioning 白名单），状态栏/图标栏/tab
 等非白名单组件瞬切，整页撕裂；用户希望用"全屏淡出 → 中央 sun↔moon SVG → 全屏淡入"的仪式化动画替代。
 3. Settings 页排版 drift：17 处具体不一致（圆角、内边距、字号、布局范式、inline style vs token、嵌套滚动等）。

 P0 的本质是引入一层"仪式化遮罩"基础设施，让模式切换与主题切换共享一条可编排、可中断、可降级的全屏动画通道。这层设
 施建好后：冻结截图机制可整条删除；模式切换的 translate3d/opacity 动画可整条删除；主题切换的 CSS transition
 白名单可整条删除 —— 视觉在不透明遮罩之下完成切换，用户只看见仪式化的进出。P1/P2 是规范化与打磨。

 ---
 用户锁定的决策

 ┌─────┬────────────────────┬──────────────────────────────────────────────────────────────────────────────────┐
 │  #  │       决策点       │                                       选定                                       │
 ├─────┼────────────────────┼──────────────────────────────────────────────────────────────────────────────────┤
 │ 1   │ 模式切换遮罩总时长 │ 320 ms                                                                           │
 ├─────┼────────────────────┼──────────────────────────────────────────────────────────────────────────────────┤
 │ 2   │ 主题切换遮罩总时长 │ 800 ms                                                                           │
 ├─────┼────────────────────┼──────────────────────────────────────────────────────────────────────────────────┤
 │ 3   │ Sun↔Moon SVG 风格  │ 极简 · 匹配 lucide：2px stroke、outline-only、无 fill、使用 var(--color-blue)    │
 │     │                    │ 描边                                                                             │
 ├─────┼────────────────────┼──────────────────────────────────────────────────────────────────────────────────┤
 │ 4   │ reduce-motion 降级 │ 跳过仪式：无遮罩、无动画，直接切（瞬时）；附加一帧 80 ms 纯色 flash              │
 │     │                    │ 作为"发生了切换"的提示                                                           │
 ├─────┼────────────────────┼──────────────────────────────────────────────────────────────────────────────────┤
 │ 5   │ AI Settings 子面板 │ 接受强制水平 row（与标准 section 统一）                                          │
 ├─────┼────────────────────┼──────────────────────────────────────────────────────────────────────────────────┤
 │ 6   │ liquid-glass 密度  │ 保持当前（LiquidGlassScene.tsx:56-87 已于 2026-04-18 调低；再降 40%              │
 │     │                    │ 会跨过感知阈值，丢失"液态"辨识度）。从 P2 移除                                   │
 └─────┴────────────────────┴──────────────────────────────────────────────────────────────────────────────────┘

 ---
 P0 详细方案

 P0 有三条子工作流：(1) 共享仪式化遮罩基础设施 → (2) 模式切换接入 → (3)
 主题切换接入。三条必须同批落，不能单条先上（否则代码里残留半套机制更乱）。

 P0.1 共享仪式化遮罩基础设施

 新增文件

 - src/renderer/components/overlay/RitualOverlay.tsx（~140 行）—— 全屏遮罩根组件
 - src/renderer/components/overlay/ThemeRitualChoreography.tsx（~100 行）—— sun↔moon SVG 组件
 - src/renderer/modules/overlay/useRitualOverlay.ts（~180 行）—— zustand store + withRitual(stage, workFn) hook
 - src/renderer/modules/overlay/browserViewMask.ts（~30 行）—— 薄封装 beginBrowserMask() / endBrowserMask()
 - src/renderer/styles/ritual-overlay.css（~70 行）—— 遮罩 + SVG keyframes

 修改文件

 - src/renderer/App.tsx —— 在 ErrorBoundary 内、Routes 外挂一个全局 <RitualOverlay />

 关键发现：无需新增任何 IPC

 useBrowserViewBounds.ts:6 已定义 BROWSER_OVERLAY_LOCK_EVENT = 'ready:browser-overlay-lock'；line 61
 overlayLockCountRef；line 175 syncBrowserVisibility 已读 overlayLockCountRef === 0 决定是否 show
 BrowserView。我们只需派发该 DOM 事件，现有 hook 会自动调用 hideAll / showActive。原计划里的 overlay.beginMask /
 endMask IPC 可以整条砍掉。

 Store + hook 设计

 // useRitualOverlay.ts
 type RitualStage = 'mode-switch' | 'theme-transition'
 type RitualPhase = 'idle' | 'entering' | 'holding' | 'leaving'

 interface RitualSession {
   id: number
   stage: RitualStage
   phase: RitualPhase
   readyDeferred: PromiseResolvers    // signalReady() resolve
   doneDeferred: PromiseResolvers     // leaving→idle resolve
   startedAt: number
   reduceMotion: boolean
   timeline: TimelineConfig
   abortSignal: AbortController
 }

 async function withRitual<T>(
   stage: RitualStage,
   workFn: (args: { signalReady: () => void; abortSignal: AbortSignal }) => Promise<T> | T,
 ): Promise<T>

 语义：
 1. 调用者：withRitual('mode-switch', async ({ signalReady }) => { setWorkbenchMode(next); signalReady(); })
 2. Overlay entering（模式切换 120 ms / 主题切换 160 ms 淡入）
 3. transitionend 后 opacity === 1 时 phase→holding，workFn 被调用
 4. signalReady() 告知"DOM 换装已完成可以进入 leaving"，但 leaving 仍然等 max(signalReady,
 minimumHoldDuration)，保证 320 / 800 ms 节奏不变
 5. workFn 抛错 → 强制 leaving 并 reject
 6. signalReady idempotent（重复调用为 no-op）

 abort：新的 withRitual 调用前，session.id++、cancel 上一个 AbortController、force-resolve stale 的
 doneDeferred；overlay 从当前计算 opacity 连续过渡到新 session 的 entering，不跳帧。

 reduce-motion：matchMedia('(prefers-reduced-motion: reduce)').matches → overlay 不 paint；workFn
 同步跑完；附带一帧 80 ms 纯色 flash（通过独立 CSS class [data-ritual-reduce-flash]，与遮罩解耦）。

 BrowserView 掩遮编排

 // browserViewMask.ts
 export function beginBrowserMask() {
   window.dispatchEvent(new CustomEvent('ready:browser-overlay-lock', { detail: { locked: true } }))
 }
 export async function endBrowserMask() {
   window.dispatchEvent(new CustomEvent('ready:browser-overlay-lock', { detail: { locked: false } }))
   // 等两帧让 syncBrowserVisibility 跑完 forceExact bounds + showActive
   await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
 }

 RitualOverlay 在 entering → holding 时调 beginBrowserMask()；holding → leaving 起点调 endBrowserMask()（让
 BrowserView 在遮罩开始淡出前已经回归）。

 遮罩样式

 [data-ritual-overlay] {
   position: fixed; inset: 0; z-index: 9999;
   background: var(--workbench-liquid-chrome-bg, var(--bg-content));
   opacity: 0;
   pointer-events: none;
   transition: opacity var(--ritual-enter-duration, 120ms) cubic-bezier(0.32, 0, 0.67, 0);
 }
 [data-ritual-overlay][data-phase='entering'],
 [data-ritual-overlay][data-phase='holding'] {
   opacity: 1;
   pointer-events: auto;
 }
 [data-ritual-overlay][data-phase='leaving'] {
   opacity: 0;
   transition-duration: var(--ritual-leave-duration, 200ms);
   transition-timing-function: cubic-bezier(0.33, 1, 0.68, 1);
 }

 模式切换 --ritual-enter-duration: 120ms; --ritual-leave-duration: 100ms；中间 holding: 100 ms；总计 320 ms。
 主题切换 --ritual-enter-duration: 160ms; --ritual-leave-duration: 200ms；中间 holding: 440 ms（SVG 演出）；总计
 800 ms。

 ---
 P0.2 模式切换接入仪式化遮罩

 修改文件

 - src/renderer/pages/WorkbenchMode.tsx:172-225 —— handleWorkbenchModeChange 改走 withRitual
 - src/renderer/components/layout/WorkbenchModeOutlet.tsx —— 大幅精简：删除 MODE_SCENE_TRANSITION /
 MODE_LEAVING_OFFSET_PERCENT / MODE_ENTERING_OFFSET_PERCENT / MODE_LEAVING_FADE_OPACITY（行
 32–36）、resolveSceneTransform 恒返回 translate3d(0,0,0)、resolveSceneOpacity 恒返回 1 或 0、状态机塌缩为 {
 activeMode }、删除 leavingMode / stage / direction、prepareAnimationFrame / finishingSafetyTimer /
 handleLeavingTransformEnd 全删。净减 ~120 行
 - src/renderer/pages/modes/BrowserMode.tsx —— 删除冻结帧整条链路：行 371–443 的 JS RAF 淡出动画、行 526–559 的
 browser-resize-shell-freeze JSX、行 257–269 的 BROWSER_CAPTURE_FREEZE_EVENT 监听；保留 browser-transition-mask
 骨架（行 562–597）
 - src/renderer/modules/browser/useBrowserResizeFreeze.ts —— 只保留 resize 相关；删除 cachedFreezeFrame /
 captureStableFrame 对外暴露的模式切换路径；文件瘦身
 - src/renderer/components/layout/DraggableModeTabs.tsx —— thumb RAF 写 CSS 变量 --dmt-thumb-pos；删除
 handleIconHover / handleIconLeave / captureFreezeTimerRef / BROWSER_CAPTURE_FREEZE_EVENT 派发（行
 19、200–224、273–274）
 - src/renderer/styles/workbench-sliders.css —— thumb 5 属性 transition 收紧为 2 属性；draggable-mode-tabs__thumb
 使用 transform: translateX(calc(var(--dmt-thumb-pos, 0) * 100%))；draggable-mode-tabs__icon opacity/color 用 CSS
 变量派生；is-pressing 改 :active 伪类

 handleWorkbenchModeChange 重写

 const handleWorkbenchModeChange = useCallback(async (nextMode: WorkbenchModeType) => {
   if (nextMode === workbenchMode) return
   if (splitMode) { setWorkbenchMode(nextMode); return }

   await withRitual('mode-switch', ({ signalReady }) => {
     transitionTargetModeRef.current = nextMode
     setWorkbenchMode(nextMode)
     setBrowserLayoutMotionPhase(nextMode === 'browser' ? 'entering' : 'leaving')
     signalReady()
   })
   setBrowserLayoutMotionPhase('idle')
 }, [setWorkbenchMode, splitMode, workbenchMode])

 不再需要 isMotionSettled + transitionTimerRef + 350 ms MODE_TRANSITION_DURATION_MS 定时器——遮罩生命周期就是
 motion settled 的真值源。isMotionSettled 改为读 useRitualOverlayStore 的 phase === 'idle'，旧的 useState 删除。

 Thumb CSS 变量迁移

 React 保留：
 - isDragging（2 次/拖拽）
 - snapIndex（mouseup / 外部 activeMode prop 同步时）

 下沉到 CSS 变量：
 - position（0..3 float，拖拽/弹簧期间）

 const setThumbPos = (pos: number) => {
   const el = containerRef.current
   if (!el) return
   el.style.setProperty('--dmt-thumb-pos', String(pos))
 }
 // startClickAnimation / startSpringAnimation 的 animate() 内用 setThumbPos 替代 setPosition

 CSS:
 .draggable-mode-tabs__thumb {
   transform: translateX(calc(var(--dmt-thumb-pos, 0) * 100%));
   transition: opacity 140ms ease, transform 0ms; /* transform 由 JS RAF 驱动 */
 }
 .draggable-mode-tabs__icon {
   --dmt-distance: max(0, 1 - abs(var(--dmt-thumb-pos, 0) - var(--dmt-icon-index)) * 0.8);
   opacity: calc(0.4 + var(--dmt-distance) * 0.6);
   color: color-mix(in srgb,
     var(--color-blue) calc(max(0, (var(--dmt-distance) - 0.5) * 200%)),
     var(--text-muted)
   );
   transition: opacity 80ms ease, color 80ms ease;
 }

 每个 icon button mount 时 style={{ '--dmt-icon-index': index }}；每帧不再触发 React reconciliation。

 ---
 P0.3 主题切换接入仪式化遮罩

 修改文件

 - src/renderer/stores/useTheme.ts —— applyColorTheme 在 animate: true 路径走 withRitual('theme-transition',
 …)；themeTransitionToken 逻辑被 ritual abort 替代；system 主题变化走 animate: false 不进入 ritual（line 129
 保持）
 - src/renderer/styles/index.css —— 整块删除 html[data-theme-transitioning='true'] 的 transition 白名单（行
 417–440）；保留一条 safety body { transition: background-color 140ms ease } 兜底 ritual 未挂载的场景
 - src/renderer/components/layout/TopBar.tsx:78-83 —— 切换按钮 aria-label 更新；ritual 期间 disabled

 时间线（800 ms 总，不含 reduce-motion）

 T=0        withRitual('theme-transition') 调用
 T=0→160    遮罩 opacity 0→1，SVG `entering-{sun|moon}` 进入（淡入 + 小幅位移）
 T=160      transitionend → phase='holding' → workFn():
              document.documentElement.setAttribute('data-theme', resolved)   ← 所有 CSS 变量瞬切
              electronAPI.theme.set(option)
              signalReady()
 T=160→600  SVG 主演出（440 ms）：
              light→dark: sun 透明度 1→0 + translateY 0→-12 + rotate 0→-45deg
              light→dark: moon 透明度 0→1 + translateY +12→0 + rotate +45→0deg（延迟 160 ms）
              dark→light: 镜像
 T=600      endBrowserMask() → 派 locked:false
 T=600→800  遮罩 opacity 1→0（200 ms 淡出）；BrowserView 在 2 帧内回归并在新主题下重 raster

 关键不变量（契约测试 2 断言）：data-theme 属性变化发生在 getComputedStyle(overlay).opacity === '1' 的那一帧。

 Sun↔Moon SVG 设计（内联，单文件，双路径交叉淡出）

 // ThemeRitualChoreography.tsx
 <svg viewBox="0 0 48 48" width="96" height="96"
      stroke="var(--color-blue)" strokeWidth="2" fill="none">
   {/* Sun: 中心圆 + 8 条射线（参考 lucide Sun，放大到 48px） */}
   <g data-glyph="sun">
     <circle cx="24" cy="24" r="6" />
     <line x1="24" y1="4"  x2="24" y2="10" />
     <line x1="24" y1="38" x2="24" y2="44" />
     <line x1="4"  y1="24" x2="10" y2="24" />
     <line x1="38" y1="24" x2="44" y2="24" />
     <line x1="9.86"  y1="9.86"  x2="14.1" y2="14.1" />
     <line x1="33.9"  y1="33.9"  x2="38.1" y2="38.1" />
     <line x1="9.86"  y1="38.14" x2="14.1" y2="33.9" />
     <line x1="33.9"  y1="14.1"  x2="38.1" y2="9.86" />
   </g>
   {/* Moon: lucide 月牙路径（48px 中心） */}
   <g data-glyph="moon">
     <path d="M33 28a11 11 0 1 1-13-13 9 9 0 0 0 13 13Z" />
   </g>
 </svg>

 由 CSS @keyframes 驱动两个 glyph 的进出（data-direction='to-dark' / ='to-light'
 切换方向），prefers-reduced-motion: reduce 下整层不 paint。

 取消 data-theme-transitioning 白名单的影响面

 删除后，如果 ritual overlay 因为某种原因未挂载（例如 reduce-motion 模式），<html> 上的 data-theme 翻转会让所有
 CSS 变量瞬切 —— 这是期望行为（reduce-motion 用户就该得到瞬切）。body { transition: background-color 140ms ease }
 的 safety 只是给主背景一个极短的呼吸感，避免闪白。

 ---
 P0 验证（contract tests + 手测）

 契约测试（必须新增）

 1. src/renderer/__tests__/ritual-overlay-lifecycle-contract.test.ts
   - withRitual('mode-switch', async ({ signalReady }) => { signalReady() }) → DOM 按序出现
 [data-ritual-overlay][data-phase="entering"|"holding"|"leaving"] → 元素移除
   - mock matchMedia('(prefers-reduced-motion: reduce)') → overlay 永不出现，workFn 仍执行
 2. src/renderer/__tests__/theme-ritual-orchestration-contract.test.ts
   - MutationObserver 观察 <html>；触发 setTheme('dark')（from light）
   - 断言：data-theme 翻转时刻严格落在 overlay phase='holding' 区间
   - 断言：翻转那一帧 getComputedStyle(overlayEl).opacity === '1'
   - 断言：系统主题变化（animate: false 路径）不产生 overlay（覆盖 useTheme.ts:129）
   - 快速连点 toggle 3 次：最终 resolvedTheme 等于最后一次用户目标，中间 session 的 DOM 已清理
 3. src/renderer/__tests__/workbench-mode-switch-ritual-contract.test.ts
   - 触发 handleWorkbenchModeChange('document')（from browser）
   - 事件序列：overlay entering → ready:browser-overlay-lock{locked:true} → setWorkbenchMode → overlay holding →
 overlay leaving → ready:browser-overlay-lock{locked:false}
   - 断言：ritual 期间 WorkbenchModeOutlet 不存在任何 style.transform !== 'translate3d(0, 0, 0)' 的子元素
   - 断言：document.querySelector('.browser-resize-shell-freeze') 在切换前后皆为 null
 4. src/renderer/__tests__/draggable-mode-tabs-state-contract.test.ts
   - Mount DraggableModeTabs，spy render
   - 模拟拖拽 icon 0 → icon 2（mousedown → 30× mousemove → mouseup）
   - 断言：React render count ≤ 4（mount + isDragging=true + isDragging=false + prop sync）
   - 断言：containerRef.current.style.getPropertyValue('--dmt-thumb-pos') 写入次数 ≥ 30

 手测清单

 - 连续快速 ⌘1 → ⌘2 → ⌘1（300 ms 内）无闪烁、无残留截图
 - document ↔ rss ↔ calendar 切换节奏一致（无遮罩只有 opacity 的反例消失）
 - Thumb 在模式切换中跟手；4 图标 opacity/color 不再抽搐
 - 点主题 toggle：完整看到 sun↔moon 演出，浏览器内容在 800 ms 内无白闪
 - 快速连点 toggle：最终主题正确，中间不卡
 - 系统切暗色（macOS 自动）：不触发 ritual、直接同步
 - macOS 开启 reduce-motion：主题/模式切换瞬时无遮罩，有 80 ms 的 flash 提示
 - DevTools Performance 录一次主题切换：long task ≤ 1、backdrop-filter 重 raster 在遮罩之下用户看不到

 度量指标

 ┌────────────────────────────────────────────┬─────────────────────────────┬───────────────────────┐
 │                    指标                    │    当前基线（审计估算）     │        P0 目标        │
 ├────────────────────────────────────────────┼─────────────────────────────┼───────────────────────┤
 │ 单次模式切换 Long Task 数                  │ 3–4                         │ ≤ 1                   │
 ├────────────────────────────────────────────┼─────────────────────────────┼───────────────────────┤
 │ 模式切换主观顺畅度（盲测）                 │ ≈ 5/10                      │ ≥ 8/10                │
 ├────────────────────────────────────────────┼─────────────────────────────┼───────────────────────┤
 │ 主题切换端到端 wall time                   │ 220 ms（但含大量 CSS 重算） │ 800 ms（含 SVG 演出） │
 ├────────────────────────────────────────────┼─────────────────────────────┼───────────────────────┤
 │ 主题切换 Long Task 数                      │ 2–3                         │ 0                     │
 ├────────────────────────────────────────────┼─────────────────────────────┼───────────────────────┤
 │ DraggableModeTabs 单次点击 React render 数 │ 12+                         │ ≤ 4                   │
 └────────────────────────────────────────────┴─────────────────────────────┴───────────────────────┘

 ---
 P0 风险与对冲

 1. BrowserView 在 leaving 开始瞬间 re-show 出旧主题快照 1 帧
   - 对冲：endBrowserMask() 内 await 2×RAF；useBrowserViewBounds:sync 在 show 前已调 sendBoundsImmediate({
 forceExact: true })；contract test 3 覆盖。
 2. liquid-glass-react SVG filter 在 data-theme 翻转瞬间 re-raster
   - 对冲：翻转发生在 opacity=1 的 holding 阶段，用户看不到；且 2026-04-18 密度 trim 已让 re-raster 很快。
 3. 快速双击主题 toggle 期间 ritual 互相 abort 导致最终主题不对
   - 对冲：store 总是持有最新 {theme, resolvedTheme}；每次新 ritual 读 store 当前值为目标；contract test 2 用
 rapid-toggle fixture 覆盖。
 4. reduce-motion 用户失去切换反馈（320 ms 变 0 ms 后用户以为没响应）
   - 对冲：reduce-motion 路径仍跑一次 80 ms 单帧纯色 flash（独立 CSS
 class，不含位移/缩放），视觉上"发生了一点事"但不违反 reduce-motion 意图。
 5. DraggableModeTabs spring RAF 在用户再次点击时覆盖新目标
   - 对冲：每次 startSpringAnimation / startClickAnimation 前 bump animationIdRef；RAF callback 顶部对比
 id，超过则 bail。既有 cancelAnimation() 为主，id 守卫为辅。

 ---
 P1 概要（Settings 规范化 + 白名单收窄 + 常量对齐）

 本段不展开代码细节，仅列范围与产出。

 P1.1 Settings primitive 化

 - 新增 src/renderer/pages/settings/primitives/：SettingsSection / SettingsCard / SettingsRow（变体
 toggle/select/input/button）/ SettingsEmptyState / SettingsDangerButton
 - 新增 src/renderer/pages/settings/tokens.ts：radius / padding / gap / font 四类 token
 - 重构 Settings.tsx：12 section + 6 子面板（AI / Memory / Personality / UserProfile / Remote IM / RSS
 Storage）全部替换为 primitive（AI 面板接受强制水平 row）
 - 契约测试：禁止 Settings.tsx 出现 style={{ padding / borderRadius / gap / rounded-[ 等 inline 样式

 覆盖审计 C1–C17 全部 17 条。

 P1.2 主题白名单收窄 + 常量对齐 + resize 误伤

 - index.css:417-440 白名单在 P0.3 已整体移除（无 P1 残留工作）
 - WORKBENCH_PANEL_MOTION_DURATION_MS 与 MODE_TRANSITION_DURATION_MS（原 350，P0 后变 320）统一
 - body.resizing * → body.resizing [data-layout-motion='true']（行 1251-1253）
 - MODE_LEAVING_FADE_OPACITY 在 P0.2 已整条删除

 ---
 P2 概要（次生打磨）

 1. 删除 4 个 *EnterOverlay 死文件（BrowserEnterOverlay.tsx / CalendarEnterOverlay.tsx / DocumentEnterOverlay.tsx
 / RSSEnterOverlay.tsx）及相关 CSS
 2. DocumentMode.tsx:35-61 SplitResizeHandle 改 RAF 合并（复用主工作台 RAF 工具）
 3. PreviewBrowser.tsx:87-212 bounds 同步改为共享 useHostedPreviewBounds（已有 hook，此处只整合）
 4. MorphIconRailGroup.tsx 删除 THUMB_REOPEN_DELAY_MS / THUMB_REST_SETTLE_MS 定时器链；is-pressing 改 :active 伪类
 5. BrowserMode 的 syncVisibleHost 六步精简为三步（hide / bounds / show），bounds 完全交给 useBrowserViewBounds
 6. captureStableFrame 180 ms 追尾改为"进入浏览器后 2 s 内最多一次"

 ~~liquid-glass 密度下调~~（已从 P2 移除 —— 当前配置已是合理下限）

 ---
 关键修改文件（P0）

 新增
 - src/renderer/components/overlay/RitualOverlay.tsx
 - src/renderer/components/overlay/ThemeRitualChoreography.tsx
 - src/renderer/modules/overlay/useRitualOverlay.ts
 - src/renderer/modules/overlay/browserViewMask.ts
 - src/renderer/styles/ritual-overlay.css
 - src/renderer/__tests__/ritual-overlay-lifecycle-contract.test.ts
 - src/renderer/__tests__/theme-ritual-orchestration-contract.test.ts
 - src/renderer/__tests__/workbench-mode-switch-ritual-contract.test.ts
 - src/renderer/__tests__/draggable-mode-tabs-state-contract.test.ts

 修改
 - src/renderer/App.tsx（挂 <RitualOverlay />）
     - src/renderer/components/overlay/RitualOverlay.tsx
     - src/renderer/components/overlay/ThemeRitualChoreography.tsx                                           
     - src/renderer/modules/overlay/useRitualOverlay.ts                          
     - src/renderer/modules/overlay/browserViewMask.ts                            
     - src/renderer/styles/ritual-overlay.css                                    
     - src/renderer/__tests__/ritual-overlay-lifecycle-contract.test.ts                          
     - src/renderer/__tests__/theme-ritual-orchestration-contract.test.ts   
     - src/renderer/__tests__/workbench-mode-switch-ritual-contract.test.ts
     - src/renderer/__tests__/draggable-mode-tabs-state-contract.test.ts  

     修改        
     - src/renderer/App.tsx（挂 <RitualOverlay />）                                             
     - src/renderer/stores/useTheme.ts:70-109, 145-154
     - src/renderer/pages/WorkbenchMode.tsx:142-225（handleWorkbenchModeChange 重写、isMotionSettled 状态源变更）
     - src/renderer/components/layout/WorkbenchModeOutlet.tsx（状态机塌缩、~-120 行）
     - src/renderer/pages/modes/BrowserMode.tsx:240-600（冻结帧删除、JS RAF 淡出删除）
     - src/renderer/modules/browser/useBrowserResizeFreeze.ts（瘦身：仅 resize 用途）
     - src/renderer/components/layout/DraggableModeTabs.tsx（thumb CSS 变量化、handleIconHover 删除）
     - src/renderer/styles/workbench-sliders.css（thumb 5 属性 transition 收紧）      
     - src/renderer/styles/index.css:417-440（白名单整块删除）                                                    
     - src/renderer/components/layout/TopBar.tsx:78-83（按钮 aria + disabled）
                                                                                                   
     复用（无需修改）                        
     - src/renderer/modules/browser/useBrowserViewBounds.ts:6, 61, 175（BROWSER_OVERLAY_LOCK_EVENT +
     overlayLockCountRef + syncBrowserVisibility 已就绪）                                                    
     - src/main/modules/browser-view/*（现有 browser.hideAll / browser.showActive IPC 足够）

     ---
     执行顺序（P0 内部）              

     1. P0.1 基础设施（RitualOverlay + hook + store + App.tsx 挂载）落地 + 契约测试 1 通过
     2. P0.2 模式切换接入（WorkbenchMode / Outlet / BrowserMode freeze 删除 / DraggableModeTabs CSS 变量化）+
     契约测试 3、4 通过         
     3. P0.3 主题切换接入（useTheme / ThemeRitualChoreography / index.css 白名单删除）+ 契约测试 2 通过       
     4. 全量手测 8 条 + DevTools Performance 对比
                                
     P0 总代码量估计：新增 ~520 行（含测试）、删除 ~280 行（freeze / state machine / transition 白名单）。净 +240
     行但复杂度显著下降。                          
                                                                                                                   
     ---
     端到端验证（ExitPlanMode 后实施阶段）                                       

     1. npm run typecheck —— 必过
     2. npm run test —— 4 条新契约测试 + 既有测试必过
     3. npm run dev —— 手测上述 8 条                     
     4. DevTools Performance 录制 5 s 的「⌘1→⌘2→⌘3→⌘4→⌘1」+ 5 s 的「toggle 主题 3 次」两段，对比 before / after 的
     Long Task、Recalc Style、Composite Layers 次数
     5. npm run verify（提交前统一）
                                                                               
     P1 / P2 的验证清单在各自实施时再细化，此处不展开。 Ready — UI / Animation Round 3 修复计划（P0 详细版 + P1/P2 概要）

 ▎ 生成时间: 2026-04-18
 ▎ 审计依据: docs/performance/2026-04-18-ui-animation-round3-audit.md
 ▎ 三步走: P0 → P1 → P2（不再按 PR 拆）

 ---
 Context（为什么做）

 第二轮审计落地后（提交 879d56b / cf38c52 / 5f30d68 / 05c3ffa / 6bf99b9 / fab915d / 652f02d / 3ed769b /
 5cdc159）观感改善明显，但仍留下三类结构性问题：

 1. 模式切换仍卡：冻结截图 bounds 只捕一次、不跟随后续 translate3d + 宽度 CSS 插值；非 browser
 模式之间切换完全没有遮罩；leaving 场景停在 0.4 opacity 继续合成；DraggableModeTabs 每 RAF setPosition 触发 React
 重算 4 个图标样式，与场景动画抢 GPU。
 2. 昼夜切换缺仪式感：当前只有 220 ms CSS 过渡（data-theme-transitioning 白名单），状态栏/图标栏/tab
 等非白名单组件瞬切，整页撕裂；用户希望用"全屏淡出 → 中央 sun↔moon SVG → 全屏淡入"的仪式化动画替代。
 3. Settings 页排版 drift：17 处具体不一致（圆角、内边距、字号、布局范式、inline style vs token、嵌套滚动等）。

 P0 的本质是引入一层"仪式化遮罩"基础设施，让模式切换与主题切换共享一条可编排、可中断、可降级的全屏动画通道。这层设
 施建好后：冻结截图机制可整条删除；模式切换的 translate3d/opacity 动画可整条删除；主题切换的 CSS transition
 白名单可整条删除 —— 视觉在不透明遮罩之下完成切换，用户只看见仪式化的进出。P1/P2 是规范化与打磨。

 ---
 用户锁定的决策

 ┌─────┬────────────────────┬──────────────────────────────────────────────────────────────────────────────────┐
 │  #  │       决策点       │                                       选定                                       │
 ├─────┼────────────────────┼──────────────────────────────────────────────────────────────────────────────────┤
 │ 1   │ 模式切换遮罩总时长 │ 320 ms                                                                           │
 ├─────┼────────────────────┼──────────────────────────────────────────────────────────────────────────────────┤
 │ 2   │ 主题切换遮罩总时长 │ 800 ms                                                                           │
 ├─────┼────────────────────┼──────────────────────────────────────────────────────────────────────────────────┤
 │ 3   │ Sun↔Moon SVG 风格  │ 极简 · 匹配 lucide：2px stroke、outline-only、无 fill、使用 var(--color-blue)    │
 │     │                    │ 描边                                                                             │
 ├─────┼────────────────────┼──────────────────────────────────────────────────────────────────────────────────┤
 │ 4   │ reduce-motion 降级 │ 跳过仪式：无遮罩、无动画，直接切（瞬时）；附加一帧 80 ms 纯色 flash              │
 │     │                    │ 作为"发生了切换"的提示                                                           │
 ├─────┼────────────────────┼──────────────────────────────────────────────────────────────────────────────────┤
 │ 5   │ AI Settings 子面板 │ 接受强制水平 row（与标准 section 统一）                                          │
 ├─────┼────────────────────┼──────────────────────────────────────────────────────────────────────────────────┤
 │ 6   │ liquid-glass 密度  │ 保持当前（LiquidGlassScene.tsx:56-87 已于 2026-04-18 调低；再降 40%              │
 │     │                    │ 会跨过感知阈值，丢失"液态"辨识度）。从 P2 移除                                   │
 └─────┴────────────────────┴──────────────────────────────────────────────────────────────────────────────────┘

 ---
 P0 详细方案

 P0 有三条子工作流：(1) 共享仪式化遮罩基础设施 → (2) 模式切换接入 → (3)
 主题切换接入。三条必须同批落，不能单条先上（否则代码里残留半套机制更乱）。

 P0.1 共享仪式化遮罩基础设施

 新增文件

 - src/renderer/components/overlay/RitualOverlay.tsx（~140 行）—— 全屏遮罩根组件
 - src/renderer/components/overlay/ThemeRitualChoreography.tsx（~100 行）—— sun↔moon SVG 组件
 - src/renderer/modules/overlay/useRitualOverlay.ts（~180 行）—— zustand store + withRitual(stage, workFn) hook
 - src/renderer/modules/overlay/browserViewMask.ts（~30 行）—— 薄封装 beginBrowserMask() / endBrowserMask()
 - src/renderer/styles/ritual-overlay.css（~70 行）—— 遮罩 + SVG keyframes

 修改文件

 - src/renderer/App.tsx —— 在 ErrorBoundary 内、Routes 外挂一个全局 <RitualOverlay />

 关键发现：无需新增任何 IPC

 useBrowserViewBounds.ts:6 已定义 BROWSER_OVERLAY_LOCK_EVENT = 'ready:browser-overlay-lock'；line 61
 overlayLockCountRef；line 175 syncBrowserVisibility 已读 overlayLockCountRef === 0 决定是否 show
 BrowserView。我们只需派发该 DOM 事件，现有 hook 会自动调用 hideAll / showActive。原计划里的 overlay.beginMask /
 endMask IPC 可以整条砍掉。

 Store + hook 设计

 // useRitualOverlay.ts
 type RitualStage = 'mode-switch' | 'theme-transition'
 type RitualPhase = 'idle' | 'entering' | 'holding' | 'leaving'

 interface RitualSession {
   id: number
   stage: RitualStage
   phase: RitualPhase
   readyDeferred: PromiseResolvers    // signalReady() resolve
   doneDeferred: PromiseResolvers     // leaving→idle resolve
   startedAt: number
   reduceMotion: boolean
   timeline: TimelineConfig
   abortSignal: AbortController
 }

 async function withRitual<T>(
   stage: RitualStage,
   workFn: (args: { signalReady: () => void; abortSignal: AbortSignal }) => Promise<T> | T,
 ): Promise<T>

 语义：
 1. 调用者：withRitual('mode-switch', async ({ signalReady }) => { setWorkbenchMode(next); signalReady(); })
 2. Overlay entering（模式切换 120 ms / 主题切换 160 ms 淡入）
 3. transitionend 后 opacity === 1 时 phase→holding，workFn 被调用
 4. signalReady() 告知"DOM 换装已完成可以进入 leaving"，但 leaving 仍然等 max(signalReady,
 minimumHoldDuration)，保证 320 / 800 ms 节奏不变
 5. workFn 抛错 → 强制 leaving 并 reject
 6. signalReady idempotent（重复调用为 no-op）

 abort：新的 withRitual 调用前，session.id++、cancel 上一个 AbortController、force-resolve stale 的
 doneDeferred；overlay 从当前计算 opacity 连续过渡到新 session 的 entering，不跳帧。

 reduce-motion：matchMedia('(prefers-reduced-motion: reduce)').matches → overlay 不 paint；workFn
 同步跑完；附带一帧 80 ms 纯色 flash（通过独立 CSS class [data-ritual-reduce-flash]，与遮罩解耦）。

 BrowserView 掩遮编排

 // browserViewMask.ts
 export function beginBrowserMask() {
   window.dispatchEvent(new CustomEvent('ready:browser-overlay-lock', { detail: { locked: true } }))
 }
 export async function endBrowserMask() {
   window.dispatchEvent(new CustomEvent('ready:browser-overlay-lock', { detail: { locked: false } }))
   // 等两帧让 syncBrowserVisibility 跑完 forceExact bounds + showActive
   await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
 }

 RitualOverlay 在 entering → holding 时调 beginBrowserMask()；holding → leaving 起点调 endBrowserMask()（让
 BrowserView 在遮罩开始淡出前已经回归）。

 遮罩样式

 [data-ritual-overlay] {
   position: fixed; inset: 0; z-index: 9999;
   background: var(--workbench-liquid-chrome-bg, var(--bg-content));
   opacity: 0;
   pointer-events: none;
   transition: opacity var(--ritual-enter-duration, 120ms) cubic-bezier(0.32, 0, 0.67, 0);
 }
 [data-ritual-overlay][data-phase='entering'],
 [data-ritual-overlay][data-phase='holding'] {
   opacity: 1;
   pointer-events: auto;
 }
 [data-ritual-overlay][data-phase='leaving'] {
   opacity: 0;
   transition-duration: var(--ritual-leave-duration, 200ms);
   transition-timing-function: cubic-bezier(0.33, 1, 0.68, 1);
 }

 模式切换 --ritual-enter-duration: 120ms; --ritual-leave-duration: 100ms；中间 holding: 100 ms；总计 320 ms。
 主题切换 --ritual-enter-duration: 160ms; --ritual-leave-duration: 200ms；中间 holding: 440 ms（SVG 演出）；总计
 800 ms。

 ---
 P0.2 模式切换接入仪式化遮罩

 修改文件

 - src/renderer/pages/WorkbenchMode.tsx:172-225 —— handleWorkbenchModeChange 改走 withRitual
 - src/renderer/components/layout/WorkbenchModeOutlet.tsx —— 大幅精简：删除 MODE_SCENE_TRANSITION /
 MODE_LEAVING_OFFSET_PERCENT / MODE_ENTERING_OFFSET_PERCENT / MODE_LEAVING_FADE_OPACITY（行
 32–36）、resolveSceneTransform 恒返回 translate3d(0,0,0)、resolveSceneOpacity 恒返回 1 或 0、状态机塌缩为 {
 activeMode }、删除 leavingMode / stage / direction、prepareAnimationFrame / finishingSafetyTimer /
 handleLeavingTransformEnd 全删。净减 ~120 行
 - src/renderer/pages/modes/BrowserMode.tsx —— 删除冻结帧整条链路：行 371–443 的 JS RAF 淡出动画、行 526–559 的
 browser-resize-shell-freeze JSX、行 257–269 的 BROWSER_CAPTURE_FREEZE_EVENT 监听；保留 browser-transition-mask
 骨架（行 562–597）
 - src/renderer/modules/browser/useBrowserResizeFreeze.ts —— 只保留 resize 相关；删除 cachedFreezeFrame /
 captureStableFrame 对外暴露的模式切换路径；文件瘦身
 - src/renderer/components/layout/DraggableModeTabs.tsx —— thumb RAF 写 CSS 变量 --dmt-thumb-pos；删除
 handleIconHover / handleIconLeave / captureFreezeTimerRef / BROWSER_CAPTURE_FREEZE_EVENT 派发（行
 19、200–224、273–274）
 - src/renderer/styles/workbench-sliders.css —— thumb 5 属性 transition 收紧为 2 属性；draggable-mode-tabs__thumb
 使用 transform: translateX(calc(var(--dmt-thumb-pos, 0) * 100%))；draggable-mode-tabs__icon opacity/color 用 CSS
 变量派生；is-pressing 改 :active 伪类

 handleWorkbenchModeChange 重写

 const handleWorkbenchModeChange = useCallback(async (nextMode: WorkbenchModeType) => {
   if (nextMode === workbenchMode) return
   if (splitMode) { setWorkbenchMode(nextMode); return }

   await withRitual('mode-switch', ({ signalReady }) => {
     transitionTargetModeRef.current = nextMode
     setWorkbenchMode(nextMode)
     setBrowserLayoutMotionPhase(nextMode === 'browser' ? 'entering' : 'leaving')
     signalReady()
   })
   setBrowserLayoutMotionPhase('idle')
 }, [setWorkbenchMode, splitMode, workbenchMode])

 不再需要 isMotionSettled + transitionTimerRef + 350 ms MODE_TRANSITION_DURATION_MS 定时器——遮罩生命周期就是
 motion settled 的真值源。isMotionSettled 改为读 useRitualOverlayStore 的 phase === 'idle'，旧的 useState 删除。

 Thumb CSS 变量迁移

 React 保留：
 - isDragging（2 次/拖拽）
 - snapIndex（mouseup / 外部 activeMode prop 同步时）

 下沉到 CSS 变量：
 - position（0..3 float，拖拽/弹簧期间）

 const setThumbPos = (pos: number) => {
   const el = containerRef.current
   if (!el) return
   el.style.setProperty('--dmt-thumb-pos', String(pos))
 }
 // startClickAnimation / startSpringAnimation 的 animate() 内用 setThumbPos 替代 setPosition

 CSS:
 .draggable-mode-tabs__thumb {
   transform: translateX(calc(var(--dmt-thumb-pos, 0) * 100%));
   transition: opacity 140ms ease, transform 0ms; /* transform 由 JS RAF 驱动 */
 }
 .draggable-mode-tabs__icon {
   --dmt-distance: max(0, 1 - abs(var(--dmt-thumb-pos, 0) - var(--dmt-icon-index)) * 0.8);
   opacity: calc(0.4 + var(--dmt-distance) * 0.6);
   color: color-mix(in srgb,
     var(--color-blue) calc(max(0, (var(--dmt-distance) - 0.5) * 200%)),
     var(--text-muted)
   );
   transition: opacity 80ms ease, color 80ms ease;
 }

 每个 icon button mount 时 style={{ '--dmt-icon-index': index }}；每帧不再触发 React reconciliation。

 ---
 P0.3 主题切换接入仪式化遮罩

 修改文件

 - src/renderer/stores/useTheme.ts —— applyColorTheme 在 animate: true 路径走 withRitual('theme-transition',
 …)；themeTransitionToken 逻辑被 ritual abort 替代；system 主题变化走 animate: false 不进入 ritual（line 129
 保持）
 - src/renderer/styles/index.css —— 整块删除 html[data-theme-transitioning='true'] 的 transition 白名单（行
 417–440）；保留一条 safety body { transition: background-color 140ms ease } 兜底 ritual 未挂载的场景
 - src/renderer/components/layout/TopBar.tsx:78-83 —— 切换按钮 aria-label 更新；ritual 期间 disabled

 时间线（800 ms 总，不含 reduce-motion）

 T=0        withRitual('theme-transition') 调用
 T=0→160    遮罩 opacity 0→1，SVG `entering-{sun|moon}` 进入（淡入 + 小幅位移）
 T=160      transitionend → phase='holding' → workFn():
              document.documentElement.setAttribute('data-theme', resolved)   ← 所有 CSS 变量瞬切
              electronAPI.theme.set(option)
              signalReady()
 T=160→600  SVG 主演出（440 ms）：
              light→dark: sun 透明度 1→0 + translateY 0→-12 + rotate 0→-45deg
              light→dark: moon 透明度 0→1 + translateY +12→0 + rotate +45→0deg（延迟 160 ms）
              dark→light: 镜像
 T=600      endBrowserMask() → 派 locked:false
 T=600→800  遮罩 opacity 1→0（200 ms 淡出）；BrowserView 在 2 帧内回归并在新主题下重 raster

 关键不变量（契约测试 2 断言）：data-theme 属性变化发生在 getComputedStyle(overlay).opacity === '1' 的那一帧。

 Sun↔Moon SVG 设计（内联，单文件，双路径交叉淡出）

 // ThemeRitualChoreography.tsx
 <svg viewBox="0 0 48 48" width="96" height="96"
      stroke="var(--color-blue)" strokeWidth="2" fill="none">
   {/* Sun: 中心圆 + 8 条射线（参考 lucide Sun，放大到 48px） */}
   <g data-glyph="sun">
     <circle cx="24" cy="24" r="6" />
     <line x1="24" y1="4"  x2="24" y2="10" />
     <line x1="24" y1="38" x2="24" y2="44" />
     <line x1="4"  y1="24" x2="10" y2="24" />
     <line x1="38" y1="24" x2="44" y2="24" />
     <line x1="9.86"  y1="9.86"  x2="14.1" y2="14.1" />
     <line x1="33.9"  y1="33.9"  x2="38.1" y2="38.1" />
     <line x1="9.86"  y1="38.14" x2="14.1" y2="33.9" />
     <line x1="33.9"  y1="14.1"  x2="38.1" y2="9.86" />
   </g>
   {/* Moon: lucide 月牙路径（48px 中心） */}
   <g data-glyph="moon">
     <path d="M33 28a11 11 0 1 1-13-13 9 9 0 0 0 13 13Z" />
   </g>
 </svg>

 由 CSS @keyframes 驱动两个 glyph 的进出（data-direction='to-dark' / ='to-light'
 切换方向），prefers-reduced-motion: reduce 下整层不 paint。

 取消 data-theme-transitioning 白名单的影响面

 删除后，如果 ritual overlay 因为某种原因未挂载（例如 reduce-motion 模式），<html> 上的 data-theme 翻转会让所有
 CSS 变量瞬切 —— 这是期望行为（reduce-motion 用户就该得到瞬切）。body { transition: background-color 140ms ease }
 的 safety 只是给主背景一个极短的呼吸感，避免闪白。

 ---
 P0 验证（contract tests + 手测）

 契约测试（必须新增）

 1. src/renderer/__tests__/ritual-overlay-lifecycle-contract.test.ts
   - withRitual('mode-switch', async ({ signalReady }) => { signalReady() }) → DOM 按序出现
 [data-ritual-overlay][data-phase="entering"|"holding"|"leaving"] → 元素移除
   - mock matchMedia('(prefers-reduced-motion: reduce)') → overlay 永不出现，workFn 仍执行
 2. src/renderer/__tests__/theme-ritual-orchestration-contract.test.ts
   - MutationObserver 观察 <html>；触发 setTheme('dark')（from light）
   - 断言：data-theme 翻转时刻严格落在 overlay phase='holding' 区间
   - 断言：翻转那一帧 getComputedStyle(overlayEl).opacity === '1'
   - 断言：系统主题变化（animate: false 路径）不产生 overlay（覆盖 useTheme.ts:129）
   - 快速连点 toggle 3 次：最终 resolvedTheme 等于最后一次用户目标，中间 session 的 DOM 已清理
 3. src/renderer/__tests__/workbench-mode-switch-ritual-contract.test.ts
   - 触发 handleWorkbenchModeChange('document')（from browser）
   - 事件序列：overlay entering → ready:browser-overlay-lock{locked:true} → setWorkbenchMode → overlay holding →
 overlay leaving → ready:browser-overlay-lock{locked:false}
   - 断言：ritual 期间 WorkbenchModeOutlet 不存在任何 style.transform !== 'translate3d(0, 0, 0)' 的子元素
   - 断言：document.querySelector('.browser-resize-shell-freeze') 在切换前后皆为 null
 4. src/renderer/__tests__/draggable-mode-tabs-state-contract.test.ts
   - Mount DraggableModeTabs，spy render
   - 模拟拖拽 icon 0 → icon 2（mousedown → 30× mousemove → mouseup）
   - 断言：React render count ≤ 4（mount + isDragging=true + isDragging=false + prop sync）
   - 断言：containerRef.current.style.getPropertyValue('--dmt-thumb-pos') 写入次数 ≥ 30

 手测清单

 - 连续快速 ⌘1 → ⌘2 → ⌘1（300 ms 内）无闪烁、无残留截图
 - document ↔ rss ↔ calendar 切换节奏一致（无遮罩只有 opacity 的反例消失）
 - Thumb 在模式切换中跟手；4 图标 opacity/color 不再抽搐
 - 点主题 toggle：完整看到 sun↔moon 演出，浏览器内容在 800 ms 内无白闪
 - 快速连点 toggle：最终主题正确，中间不卡
 - 系统切暗色（macOS 自动）：不触发 ritual、直接同步
 - macOS 开启 reduce-motion：主题/模式切换瞬时无遮罩，有 80 ms 的 flash 提示
 - DevTools Performance 录一次主题切换：long task ≤ 1、backdrop-filter 重 raster 在遮罩之下用户看不到

 度量指标

 ┌────────────────────────────────────────────┬─────────────────────────────┬───────────────────────┐
 │                    指标                    │    当前基线（审计估算）     │        P0 目标        │
 ├────────────────────────────────────────────┼─────────────────────────────┼───────────────────────┤
 │ 单次模式切换 Long Task 数                  │ 3–4                         │ ≤ 1                   │
 ├────────────────────────────────────────────┼─────────────────────────────┼───────────────────────┤
 │ 模式切换主观顺畅度（盲测）                 │ ≈ 5/10                      │ ≥ 8/10                │
 ├────────────────────────────────────────────┼─────────────────────────────┼───────────────────────┤
 │ 主题切换端到端 wall time                   │ 220 ms（但含大量 CSS 重算） │ 800 ms（含 SVG 演出） │
 ├────────────────────────────────────────────┼─────────────────────────────┼───────────────────────┤
 │ 主题切换 Long Task 数                      │ 2–3                         │ 0                     │
 ├────────────────────────────────────────────┼─────────────────────────────┼───────────────────────┤
 │ DraggableModeTabs 单次点击 React render 数 │ 12+                         │ ≤ 4                   │
 └────────────────────────────────────────────┴─────────────────────────────┴───────────────────────┘

 ---
 P0 风险与对冲

 1. BrowserView 在 leaving 开始瞬间 re-show 出旧主题快照 1 帧
   - 对冲：endBrowserMask() 内 await 2×RAF；useBrowserViewBounds:sync 在 show 前已调 sendBoundsImmediate({
 forceExact: true })；contract test 3 覆盖。
 2. liquid-glass-react SVG filter 在 data-theme 翻转瞬间 re-raster
   - 对冲：翻转发生在 opacity=1 的 holding 阶段，用户看不到；且 2026-04-18 密度 trim 已让 re-raster 很快。
 3. 快速双击主题 toggle 期间 ritual 互相 abort 导致最终主题不对
   - 对冲：store 总是持有最新 {theme, resolvedTheme}；每次新 ritual 读 store 当前值为目标；contract test 2 用
 rapid-toggle fixture 覆盖。
 4. reduce-motion 用户失去切换反馈（320 ms 变 0 ms 后用户以为没响应）
   - 对冲：reduce-motion 路径仍跑一次 80 ms 单帧纯色 flash（独立 CSS
 class，不含位移/缩放），视觉上"发生了一点事"但不违反 reduce-motion 意图。
 5. DraggableModeTabs spring RAF 在用户再次点击时覆盖新目标
   - 对冲：每次 startSpringAnimation / startClickAnimation 前 bump animationIdRef；RAF callback 顶部对比
 id，超过则 bail。既有 cancelAnimation() 为主，id 守卫为辅。

 ---
 P1 概要（Settings 规范化 + 白名单收窄 + 常量对齐）

 本段不展开代码细节，仅列范围与产出。

 P1.1 Settings primitive 化

 - 新增 src/renderer/pages/settings/primitives/：SettingsSection / SettingsCard / SettingsRow（变体
 toggle/select/input/button）/ SettingsEmptyState / SettingsDangerButton
 - 新增 src/renderer/pages/settings/tokens.ts：radius / padding / gap / font 四类 token
 - 重构 Settings.tsx：12 section + 6 子面板（AI / Memory / Personality / UserProfile / Remote IM / RSS
 Storage）全部替换为 primitive（AI 面板接受强制水平 row）
 - 契约测试：禁止 Settings.tsx 出现 style={{ padding / borderRadius / gap / rounded-[ 等 inline 样式

 覆盖审计 C1–C17 全部 17 条。

 P1.2 主题白名单收窄 + 常量对齐 + resize 误伤

 - index.css:417-440 白名单在 P0.3 已整体移除（无 P1 残留工作）
 - WORKBENCH_PANEL_MOTION_DURATION_MS 与 MODE_TRANSITION_DURATION_MS（原 350，P0 后变 320）统一
 - body.resizing * → body.resizing [data-layout-motion='true']（行 1251-1253）
 - MODE_LEAVING_FADE_OPACITY 在 P0.2 已整条删除

 ---
 P2 概要（次生打磨）

 1. 删除 4 个 *EnterOverlay 死文件（BrowserEnterOverlay.tsx / CalendarEnterOverlay.tsx / DocumentEnterOverlay.tsx
 / RSSEnterOverlay.tsx）及相关 CSS
 2. DocumentMode.tsx:35-61 SplitResizeHandle 改 RAF 合并（复用主工作台 RAF 工具）
 3. PreviewBrowser.tsx:87-212 bounds 同步改为共享 useHostedPreviewBounds（已有 hook，此处只整合）
 4. MorphIconRailGroup.tsx 删除 THUMB_REOPEN_DELAY_MS / THUMB_REST_SETTLE_MS 定时器链；is-pressing 改 :active 伪类
 5. BrowserMode 的 syncVisibleHost 六步精简为三步（hide / bounds / show），bounds 完全交给 useBrowserViewBounds
 6. captureStableFrame 180 ms 追尾改为"进入浏览器后 2 s 内最多一次"

 ~~liquid-glass 密度下调~~（已从 P2 移除 —— 当前配置已是合理下限）

 ---
 关键修改文件（P0）

 新增
 - src/renderer/components/overlay/RitualOverlay.tsx
 - src/renderer/components/overlay/ThemeRitualChoreography.tsx
 - src/renderer/modules/overlay/useRitualOverlay.ts
 - src/renderer/modules/overlay/browserViewMask.ts
 - src/renderer/styles/ritual-overlay.css
 - src/renderer/__tests__/ritual-overlay-lifecycle-contract.test.ts
 - src/renderer/__tests__/theme-ritual-orchestration-contract.test.ts
 - src/renderer/__tests__/workbench-mode-switch-ritual-contract.test.ts
 - src/renderer/__tests__/draggable-mode-tabs-state-contract.test.ts

 修改
 - src/renderer/App.tsx（挂 <RitualOverlay />）
     - src/renderer/components/overlay/RitualOverlay.tsx
     - src/renderer/components/overlay/ThemeRitualChoreography.tsx                                           
     - src/renderer/modules/overlay/useRitualOverlay.ts                          
     - src/renderer/modules/overlay/browserViewMask.ts                            
     - src/renderer/styles/ritual-overlay.css                                    
     - src/renderer/__tests__/ritual-overlay-lifecycle-contract.test.ts                          
     - src/renderer/__tests__/theme-ritual-orchestration-contract.test.ts   
     - src/renderer/__tests__/workbench-mode-switch-ritual-contract.test.ts
     - src/renderer/__tests__/draggable-mode-tabs-state-contract.test.ts  

     修改        
     - src/renderer/App.tsx（挂 <RitualOverlay />）                                             
     - src/renderer/stores/useTheme.ts:70-109, 145-154
     - src/renderer/pages/WorkbenchMode.tsx:142-225（handleWorkbenchModeChange 重写、isMotionSettled 状态源变更）
     - src/renderer/components/layout/WorkbenchModeOutlet.tsx（状态机塌缩、~-120 行）
     - src/renderer/pages/modes/BrowserMode.tsx:240-600（冻结帧删除、JS RAF 淡出删除）
     - src/renderer/modules/browser/useBrowserResizeFreeze.ts（瘦身：仅 resize 用途）
     - src/renderer/components/layout/DraggableModeTabs.tsx（thumb CSS 变量化、handleIconHover 删除）
     - src/renderer/styles/workbench-sliders.css（thumb 5 属性 transition 收紧）      
     - src/renderer/styles/index.css:417-440（白名单整块删除）                                                    
     - src/renderer/components/layout/TopBar.tsx:78-83（按钮 aria + disabled）
                                                                                                   
     复用（无需修改）                        
     - src/renderer/modules/browser/useBrowserViewBounds.ts:6, 61, 175（BROWSER_OVERLAY_LOCK_EVENT +
     overlayLockCountRef + syncBrowserVisibility 已就绪）                                                    
     - src/main/modules/browser-view/*（现有 browser.hideAll / browser.showActive IPC 足够）

     ---
     执行顺序（P0 内部）              

     1. P0.1 基础设施（RitualOverlay + hook + store + App.tsx 挂载）落地 + 契约测试 1 通过
     2. P0.2 模式切换接入（WorkbenchMode / Outlet / BrowserMode freeze 删除 / DraggableModeTabs CSS 变量化）+
     契约测试 3、4 通过         
     3. P0.3 主题切换接入（useTheme / ThemeRitualChoreography / index.css 白名单删除）+ 契约测试 2 通过       
     4. 全量手测 8 条 + DevTools Performance 对比
                                
     P0 总代码量估计：新增 ~520 行（含测试）、删除 ~280 行（freeze / state machine / transition 白名单）。净 +240
     行但复杂度显著下降。                          
                                                                                                                   
     ---
     端到端验证（ExitPlanMode 后实施阶段）                                       

     1. npm run typecheck —— 必过
     2. npm run test —— 4 条新契约测试 + 既有测试必过
     3. npm run dev —— 手测上述 8 条                     
     4. DevTools Performance 录制 5 s 的「⌘1→⌘2→⌘3→⌘4→⌘1」+ 5 s 的「toggle 主题 3 次」两段，对比 before / after 的
     Long Task、Recalc Style、Composite Layers 次数
     5. npm run verify（提交前统一）
                                                                               
     P1 / P2 的验证清单在各自实施时再细化，此处不展开。