---
title: BrowserView 呈现时机收口——修复文档链接进浏览器错位 & 切标签闪烁抖动
date: 2026-06-01
status: approved-ready-for-construction  # R2 双方无异议通过（2026-06-01）
owner: 白
executor: Codex（调度 subagents 施工），Claude 复审
enforce: false
related:
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-05-23-Y0-5-surface-16-release-visual-browserview-theme-implementation.md
  - CLAUDE.md §2（BrowserView 原生覆盖层硬约束）
  - .claude/architectural-principles.md（红线 6：跨边界状态必须显式建模）
references_internal:
  - src/renderer/pages/WorkbenchMode.tsx（handleWorkbenchModeChange / ritual / isMotionSettled 门控）
  - src/renderer/modules/overlay/useRitualOverlay.ts（withRitual）
  - src/renderer/styles/ritual-overlay.css（workbench-mode-scene 进入动画）
  - src/main/modules/browser-engine/tab-shell-service.ts（switchTab 主进程已正确贴图）
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# BrowserView 呈现时机收口

> 本文是给 **Codex 调度 subagents 施工** 用的详细计划。Claude 已完成独立审查（带 file:line 实证）。
> 阅读顺序：先读 §1 前因后果建立心智 → §2 已核实事实（file:line）→ §3 目标设计 → §4 工作包（每个 = 一个 subagent 任务）→ §5 顺序与依赖 → §6 验收 → §7 测试影响与回归论证 → §8 风险与回滚。
>
> **审查轮次**：
> - **R1（2026-06-01）**：Codex 计划审查完成。§2 五条事实抽查**全 ✅**（NotePreview/WidgetRenderer 直连、FileTree/GlobalSearch 一行直连、isMotionSettled 唯二写点 + ritual translate3d 进入动画、主进程 switchTab 已贴好、纯切标签 hide→fit→show + 180ms 二次 fit）。决策 A/B/C/D 方向获认可。结论「需补全」，提出 5 条缺口（WP3 的 fit 标记清除点、split 不 hide-all 规格；WP4 的 split/导航后重 fit/helper fallback 断言）。Claude 已逐条用真实代码核实并补全，见各处 **【R1 补全】** 标记、§3.1.1/§3.2.1 决策定稿、WP3/WP4 增补。
> - **R2（2026-06-01）— ✅ 通过**：Codex 定向复核 5 条补全，全部判 ✅已闭合（fit 清除点统一在 `onTabUpdate` 三 case、split 不 hide-all 规格、WP4 三条新断言），并抽查确认 `useBrowserRuntimeEffects.onTabUpdate` 是同标签 URL 变化的唯一回流点。**结论：通过可施工。双方无异议，进入施工阶段（由用户交 Codex 开发，Claude 复审结果）。**
>
> **本计划只解决两个观察到的缺陷，不顺手重构无关代码**（CLAUDE.md §0 手术式改动）。任何"看起来可以一起优化"的点若不在 §3 设计内，一律不做。

---

## 0. 一句话

原生 `BrowserView` 是 OS 级覆盖层（不受 DOM z-index 控制），它"何时贴上来 / 何时重贴"没有唯一收口：① 文档/Widget/文件树/全局搜索四个入口**绕过统一模式切换**直接改 store，导致原生层在 DOM 横向进入动画途中按"动画坐标"贴图、且之后无人重测 → **持续错位**；② browser 模式内**纯切标签**时，渲染层在主进程已正确切图后又多跑一遍"隐藏全部 → 二次缩放适配 → 再显示"+ 180ms 延迟二次适配 → **先闪一下、再轻微偏移抖动**。本计划用"统一入口 + 切标签不打断显示"两步收口，并把锁死旧实现的结构测试改成行为断言。

---

## 1. 前因后果（背景，务必先读）

### 1.1 BrowserView 呈现模型
- 浏览器网页内容由主进程的原生 `BrowserView`（OS 覆盖层）承载，渲染层只持有一个占位 DOM（`contentRef`），通过 `getBoundingClientRect()` 测量这个占位的屏幕坐标，再把坐标作为 `set-bounds` / `show` intent 发给主进程，主进程把原生层贴到该坐标（`useBrowserViewBounds.ts` → `tab-shell-service.applyIntent`）。
- **关键物理事实**：`getBoundingClientRect()` 的返回值**包含 CSS transform**。所以只要占位 DOM 此刻正被 transform 横移，测出来的坐标就是"动画途中"的偏移坐标，原生层就会贴歪。

### 1.2 统一模式切换流程（正确路径）
进入/离开 browser 模式应走 `WorkbenchMode.tsx` 的 `handleWorkbenchModeChange`：
- 它对 `with-browser` 策略会 `setIsMotionSettled(false)` 并进入 `withRitual('mode-switch')`：先放仪式遮罩盖住动画，离开 browser 时先发 `hide-all` 并等 ack，再翻 `workbenchMode`，动画结束后才 `setIsMotionSettled(true)`。
- `BrowserMode` 把 `isMotionSettled` 当作 `isVisibleAllowed` 的门控（`BrowserMode.tsx:221`）：**动画未结束就禁止原生层显示**。动画结束、`isMotionSettled` 翻 true 后，才在最终落位坐标上把原生层 present。
- 触发统一流程的对外接口是 `requestWorkbenchModeChange(mode)`（`modules/workbench/mode-transition.ts`），它派发 `READY_WORKBENCH_MODE_CHANGE_EVENT`，由 `WorkbenchMode` 的监听器接进 `handleWorkbenchModeChange`。
- **RSS 预览已经用对了**：`PreviewBrowser.tsx:128` 用 `requestWorkbenchModeChange('browser')`，所以从 RSS 进浏览器不错位。键盘快捷键切模式也走这个事件。

### 1.3 两个缺陷的来源
- **现象 1（错位）**：文档预览、Widget、文件树、全局搜索这四个入口**没有用** `requestWorkbenchModeChange`，而是直接 `setWorkbenchMode('browser')` 改 store。直接改 store 只会触发 `WorkbenchModeOutlet` 的横向进入动画（CSS），却**完全不碰** `isMotionSettled`（它只在 `handleWorkbenchModeChange` 内被置 false）。于是 `BrowserMode` 一进来就是 `isMotionSettled=true`，原生层被允许立刻 present，在动画途中按 transform 坐标贴图。
- **现象 2（闪烁+抖动）**：browser 模式内点标签切换时，主进程 `switchTab` 已经把新标签贴到当前坐标并隐藏其余（见 §2.5）。但渲染层在 `activeTabId` 变化时又跑了一段"隐藏全部 → `fitActiveTabToBounds`（量内容宽度并 `setZoomFactor` 缩放适配）→ 等 2 帧再显示"，把主进程刚做对的事先撤销再重做（闪烁）；紧接着 180ms 后又 `fitActiveTabToBounds` + 显示一遍（二次缩放 → 偏移抖动）。

### 1.4 为什么这是"同一类"问题而非两个孤立 bug
两者都源于**原生层"何时贴/重贴"缺少唯一收口**：现象 1 是"进入态"绕过了动画门控；现象 2 是"稳定态切标签"对 `activeTabId` 变化过度反应、与主进程职责重叠。修复策略对应两条：把进入入口收口到统一流程；把切标签的呈现交给主进程、渲染层不再打断。

---

## 2. 已核实事实（全部带 file:line，施工 subagent 须先复核再改）

### 2.1 四个绕过统一流程的入口（现象 1 根因）
全部是"直接改 store 切 browser"，应改为 `requestWorkbenchModeChange('browser')`：

1. `src/renderer/components/document/NotePreview.tsx:485` — `openHref` 内，`createTab`+`addTab`+`setActiveTabId`+`setUrlInput` 之后 `useMode.getState().setWorkbenchMode('browser')`。
2. `src/renderer/components/document/WidgetRenderer.tsx:96` — `openHref` 内，同样形状（与 NotePreview 这段几乎逐字重复）。
3. `src/renderer/components/layout/FileTree.tsx:1458` — `openLocalHtmlFileInBrowser(...).then(opened => { if (opened) setWorkbenchMode('browser') })`。
4. `src/renderer/components/layout/GlobalSearchPanel.tsx:645` — 同 FileTree 形状。

注：FileTree:1474 / GlobalSearchPanel:651 还有切到 `document`/`calendar` 的 `setWorkbenchMode`，**不在本次范围**（非 browser 目标走 `dom-only` 策略，无 ritual、无 `isMotionSettled`，直接改 store 与统一流程等价，改了反而徒增风险）。GlobalSearchPanel:612/635/638 同理保持不动。

### 2.2 统一流程与门控
- `handleWorkbenchModeChange`：`src/renderer/pages/WorkbenchMode.tsx:364-430`（`with-browser` 分支 `setIsMotionSettled(false)` → `withRitual` → 翻 mode → finally `setIsMotionSettled(true)`）。
- `isMotionSettled` 仅在此函数内被写（`:385` 置 false、`:428` 置 true）。直接改 store **不经过这里**。
- `requestWorkbenchModeChange` / 事件名：`src/renderer/modules/workbench/mode-transition.ts`（`READY_WORKBENCH_MODE_CHANGE_EVENT`）；监听接入 `WorkbenchMode.tsx:445-456`。
- `BrowserMode` 消费门控：`isVisibleAllowed: isMotionSettled`（`src/renderer/pages/modes/BrowserMode.tsx:221`）；`shouldRevealBrowserHost = isActive && isMotionSettled`（`:208`）。

### 2.3 进入动画确实是横向 transform
- `WorkbenchModeOutlet` 在 `mode` prop 变化时把新场景标 `data-mode-visual-state='entering'`（`src/renderer/components/layout/WorkbenchModeOutlet.tsx:153-174`）。
- 对应 CSS：`src/renderer/styles/ritual-overlay.css:254-289`，`workbench-mode-scene-enter-from-right` 关键帧为 `transform: translate3d(28%,0,0) → translate3d(0,0,0)`，280ms。
- 该动画**只由 `workbenchMode` 变化触发，与 ritual / `isMotionSettled` 无关**——所以两条路径都会播这个滑入，区别只在原生层是否被门控住。

### 2.4 错位为何"持续不自愈"（比"贴在动画位置"更深一层）
直接改 store 路径下，`isMotionSettled` 始终 true、`layoutPhase` 始终 `'idle'`，因此所有补偿性重测都落在动画**进行中**、错过动画结束那一刻：
- bounds 测量入口 `useBrowserViewBounds.ts:100-115`（`getBoundingClientRect`，含 transform）。
- 进入即 present 的三步 `BrowserMode.tsx:791-819`（首帧就在动画中 hide→fit→show）。
- 180ms 二次重同步 `BrowserMode.tsx:821-855`（180ms 时 280ms 动画仍在跑）。
- "trailing settle" `BrowserMode.tsx:860-864`：依赖 `layoutPhase` 翻 `'idle'` 才触发，但此路径 `layoutPhase` 从未改变 → 只在挂载（动画中）跑过一次。
- `ResizeObserver`（`useBrowserViewBounds.ts:385`）**不会因 transform 触发**（盒尺寸未变）。
- 结论：动画结束后无任何重测，错位保留，直到窗口 resize / 焦点变化（`scheduleHostRecovery`，`useBrowserViewBounds.ts:357-367`）才偶然纠正。

### 2.5 主进程 switchTab 已经把新标签正确贴好（现象 2 关键）
`src/main/modules/browser-engine/tab-shell-service.ts:187-211` `switchTab`：`setActiveTabId` → `showHost(nextTab.view, getViewBounds())` → `applyBounds(nextTab.view)` → `detachNonTargetHosts(new Set([tabId]))`。即新标签已显示在当前坐标、其余已分离。渲染层无需再隐藏重显。

### 2.6 渲染层多余的"隐藏→适配→显示"与 180ms 二次适配（现象 2 根因）
- `BrowserMode.tsx:791-819` 的 `syncVisibleHost`：守卫 `tabCountChangedWhileHostAlreadyPresent`（`:797`）**只在标签数量变化时**提前 return；**纯切标签（数量不变）不命中**，于是执行 `syncBrowserVisibility('hidden')`（`:807` 发 `hide-all` = 闪）→ `fitActiveTabToBounds(activeTabId)`（`:809`）→ `syncBrowserVisibility('visible', { forceBoundsSync: true })`（`:814`，内部等 2 个 RAF 再 show）。
- `BrowserMode.tsx:821-855` 的 `postActivationHostResyncTimer`：依赖含 `activeTabId`，纯切标签也会重排，180ms 后再 `fitActiveTabToBounds` + `syncBrowserVisibility('visible', { forceExact, forceBoundsSync })`（二次缩放 = 偏移抖动）。

### 2.7 fitActiveTabToBounds 是"量宽 + setZoomFactor 缩放"
`src/main/modules/browser-engine/ipc-handler.ts:1360+`：在页面里 `executeJavaScript` 量 `viewportWidth/contentWidth`，过宽则 `view.webContents.setZoomFactor(zoomFactor)`（0.72~1）。两次调用相隔 180ms、期间页面可能仍在 reflow，量得 `contentWidth` 不同 → 两次 zoom 不同 → 内容先偏一点再抖一下才稳。
- zoom 是 **per-webContents 持久**的：同一标签一旦适配过，再切回来无需重算（除非该标签内发生了导航/reload）。
- 渲染层 `fitActiveTabToBounds` 的合法调用还有 `src/renderer/modules/browser/useBrowserResizeFreeze.ts`（窗口/面板 resize 时），**那条是对的，不动**。

### 2.8 锁死旧实现的结构测试（修复前必须知道）
以下为 source-grep 结构测试（CLAUDE.md §6：不能用 source-grep 冒充行为验证），把当前实现冻成"合同"，改行为必须同步改：
- `src/__tests__/browser-sync-visible-host-three-step-contract.test.ts` — 锁 hide→fit→show 三步（**现象 2 修复直接冲突**）。
- `src/__tests__/browser-mode-startup-resync-contract.test.ts` — 锁 trailing-settle 与 180ms 二次重同步那段。
- `src/__tests__/browser-tab-count-resync-guard-contract.test.ts` — 锁 `tabCountChangedWhileHostAlreadyPresent` 守卫。

---

## 3. 目标设计

### 3.1 现象 1：把"打开网页并切到浏览器"收口到唯一入口
新建一个渲染层 helper，作为"在浏览器里打开 URL 并切过去"的**唯一**入口，四个调用点全部改用它：

```
// src/renderer/modules/browser/openWebpageInBrowser.ts （新文件）
export async function openWebpageInBrowser(href: string, opts?: { localPath?: string | null }): Promise<boolean>
```

职责（把现在散落在 NotePreview/WidgetRenderer 的重复逻辑收一处）：
1. 若 `opts.localPath` 是本地 HTML → 复用 `openLocalHtmlFileInBrowser`（它内部已做 createTab/switch/setActiveTabId）。
2. 否则 `browser.createTab(href)` → 命中则 `addTab`（去重）+ `invalidate()` + `setActiveTabId` + `setUrlInput`；失败回退 `window.open`。
3. **仅在成功打开了浏览器内标签的分支**才 `requestWorkbenchModeChange('browser')`（不再 `setWorkbenchMode`）。**【R1 补全】**：`window.open` 外部回退分支**绝不**触发模式切换——否则会切到 browser 模式却没有对应标签（空壳进入）。与现状一致：现 NotePreview/WidgetRenderer 的 `setWorkbenchMode('browser')` 本就只在 `if (result?.success && result.tabId)` 块内、`window.open` 回退在该块之外提前 return，本 helper 必须保持这一语义。
4. 返回是否成功打开（供调用点决定是否还需别的副作用）。

调用点改造：
- NotePreview `openHref`（`:462-491`）：`localPath` 分支保持 `document.openPath`；网页分支改为 `await openWebpageInBrowser(href)`。
- WidgetRenderer `openHref`（`:78-102`）：整体改为 `await openWebpageInBrowser(href)`。
- FileTree `:1456-1461`、GlobalSearchPanel `:642-648`：把 `openLocalHtmlFileInBrowser(path,name).then(opened => { if (opened) setWorkbenchMode('browser') })` 改为 `openWebpageInBrowser(toFileUrl?/path, { localPath: item.path }).then(...)` —— 或更小改动：仅把 `if (opened) setWorkbenchMode('browser')` 替换为 `if (opened) requestWorkbenchModeChange('browser')`（见 §3.1.1 决策点）。

#### 3.1.1 决策点（R1 已定稿）
- **A. helper 化 vs 仅换一行 —— 【R1 确认】Codex 认可**：helper 覆盖 NotePreview+WidgetRenderer（消重 + 收口）；FileTree/GlobalSearchPanel 走的是 `openLocalHtmlFileInBrowser`、形状不同，**只把那一行** `setWorkbenchMode('browser')` → `requestWorkbenchModeChange('browser')`（不强塞进 helper，避免过度抽象）。
- **B. 同步性 —— 【R1 确认】可接受，但须加验收**：原 `setWorkbenchMode` 同步、`requestWorkbenchModeChange` 是派发事件（下一 tick 由 `WorkbenchMode` 处理）。四个调用点在该行之后**没有**依赖"模式已同步变为 browser"的代码（已核实）。**施工硬性要求**：WP1/WP2 每个调用点都要逐行复核"该切换调用之后无同步依赖"，并在 WP 交付说明里写明复核结论；同时遵守 §3.1 点 3 的 fallback 规则（失败不切模式）。

### 3.2 现象 2：切标签不打断原生层显示
区分两种触发，杜绝"纯切标签"时的 hide 闪烁与二次 zoom：

- **首次 present / 恢复**（host 第一次被 reveal，或从隐藏态恢复）：保留干净的"贴合 + 显示"（可保留 fit + 单次 show，但不需要 `forceBoundsSync` 的双 RAF 间隙制造空窗）。
- **稳定态纯切标签**（host 已 present，`activeTabId`/`splitTab.id` 变、`tabs.length` 不变）：
  1. **不发 `hide-all`**（这是闪烁源；主进程 `switchTab` 已贴好新图）。
  2. **不重复 `fitActiveTabToBounds`**：若目标标签此前已适配过则跳过（zoom 已持久）；仅在该标签尚未适配过（首次可见）才 fit。
  3. 仅做一次**非打断**的 bounds 对账：`sendBoundsImmediate({ forceExact: true })`（`set-bounds` intent，主进程仅移动不隐藏），保证渲染层测得的坐标与主进程一致（防面板宽度自上次 present 后漂移）。
  4. `postActivationHostResyncTimer`（`:821-855`）**不再因纯切标签重跑**：将其触发与 `activeTabId` 解耦，仅服务于"首次 present / 动画落定后"的一次对账（保留它对进入态的价值，去掉它对切标签的副作用）。

#### 3.2.0 fit 标记的生命周期（【R1 补全】必须写死，否则决策 C 变可见回归）
"已适配标记"用**模块级单例**实现，与 `browserTabActivationSequencer` 同款（模块顶层，跨 hook 共享，红线 6 显式建模）：新建 `src/renderer/modules/browser/browserTabFitRegistry.ts`，导出 `markFitted(tabId)` / `isFitted(tabId)` / `clearFitted(tabId)` / `clearAll()`。

- **写入（mark）**：WP3 的切标签/首次 present 分支在对某标签执行 `fitActiveTabToBounds` 成功后 `markFitted(tabId)`；split 的 primary 与 secondary **都要** mark（见 §3.2.1 D）。
- **清除（clear）—— 唯一权威清除点**：标签内容变化时清除该标签标记，使其下次可见时重新 fit。**所有内容变化最终都经主进程 → renderer 的 `onTabUpdate` 事件回流**（`useBrowserRuntimeEffects.ts:184-237`），因此在该处统一挂钩：
  - `event.type === 'navigate'`（`:191-202`，URL 变化：地址栏导航、页面内链接、重定向、`handleNavigate`、本地 HTML 重开）→ `clearFitted(event.tabId)`。
  - `event.type === 'loading'` 且 `loading === true`（`:203-205`，覆盖 reload / 同 URL 重载 / `handleRefresh`/`handleRetry`）→ `clearFitted(event.tabId)`（belt-and-suspenders；reload 不一定发 `navigate`）。
  - `event.type === 'closed'`（`:222`）→ `clearFitted(event.tabId)`（卫生清理，避免 id 复用残留）。
  - **理由**：`handleNavigate`/`handleRefresh`/`handleRetry`/页面内点链接/重定向**全部**落到主进程 navigate/reload，再经 `onTabUpdate` 回流，所以**只需挂 `onTabUpdate` 一处**即可覆盖 Codex R1 列举的"导航、刷新、重试、同标签 URL 变化"四类，无需在 `useBrowserTabActions` 各入口重复埋点（避免散点）。

实现落点：① 新建 `browserTabFitRegistry.ts`；② 改写 `BrowserMode.tsx:791-855` 两个 effect 的分支逻辑，新增"host 是否已 present"ref + 用 registry 判 fit；③ 在 `useBrowserRuntimeEffects.ts` 的 `onTabUpdate` 三个 case 挂 `clearFitted`。具体见 §4-WP3。

#### 3.2.1 决策点（R1 已定稿）
- **C. 切标签时的 fit —— 【R1 确认】取舍合理，但条件必须写死**：本次只做"已适配标签切回不再 fit"，保留"首次可见才 fit"。**硬性前提（已落到 §3.2.0）**：首次显示、导航、刷新、重试、同标签 URL 变化后**必须** `clearFitted` 并在下次可见时重新 fit，否则会留下"新页面过宽不再适配"的可见回归。仍按 §3.2.0 只在 `onTabUpdate` 一处清除即覆盖全部入口。"fit 改由 load 事件驱动"的更彻底模型列为后续可选项，不在本计划施工。
- **D. split 模式 —— 【R1 补全】方向对，规格收硬**：
  1. 切**主标签**（`activeTabId` 变、`splitTab.id` 不变、host 已 present）：**不发 `hide-all`**；secondary 维持现状，由既有 `secondary-set-bounds` 路径（`useBrowserViewBounds.sendBoundsImmediate` 的 secondary 分支 / `applyIntent` 的 `secondary-set-bounds`）保持其 bounds，不得隐藏、不得抖动。
  2. `browserTabFitRegistry` **同时覆盖 primary 与 secondary**：secondary 首次进入 split present 时若未 fit 则 fit 一次并 `markFitted(splitTab.id)`；之后切主标签不再重 fit secondary。
  3. 纯切标签的 bounds 对账（§3.2 步 3）在 split 下需对 primary 与（存在时）secondary 各发一次 `set-bounds`/`secondary-set-bounds`，均为"仅移动不隐藏"。
  4. WP3 须显式说明 split 分支不复用"非 split 的 hide→show"，WP4 须有 split 断言（见 §4-WP4）。

### 3.3 不做的事（防 scope 膨胀）
- 不改 ritual 时长 / 动画曲线 / 遮罩外观。
- 不改主进程 `switchTab` / intent 协议。
- 不改 `useBrowserResizeFreeze` 的 resize 适配。
- 不动 document/calendar 等非 browser 目标的 `setWorkbenchMode`。
- 不引入新的 IPC（现有 `requestWorkbenchModeChange` / intent 足够）。

---

## 4. 工作包（每个 = 一个 subagent 任务）

> 每个 WP 自带：目标、改动文件、验收、测试影响。施工前先复核 §2 对应 file:line（行号可能因前序 WP 漂移，按符号/上下文定位）。

### WP1 — 新建统一入口 helper + 接入文档/Widget（现象 1 主体）
- **目标**：新建 `src/renderer/modules/browser/openWebpageInBrowser.ts`，把 NotePreview/WidgetRenderer 的"createTab→切 browser"逻辑收口为唯一函数，且切换走 `requestWorkbenchModeChange('browser')`。
- **改动**：
  1. 新文件 `openWebpageInBrowser.ts`（§3.1 职责 1-4）。
  2. `NotePreview.tsx:462-491`：网页分支改用 helper；保留 `localPath` 的 `document.openPath` 分支。
  3. `WidgetRenderer.tsx:78-102`：`openHref` 改用 helper。
- **验收**：从文档正文链接、Widget 内链接打开网页，原生层落位精确、无错位（手动回归 + WP4 行为测试）。
- **测试影响**：无结构测试锁这两处；新增 WP4 行为测试。

### WP2 — 文件树 / 全局搜索入口收口（现象 1 收尾）
- **目标**：FileTree:1458、GlobalSearchPanel:645 的 `setWorkbenchMode('browser')` → `requestWorkbenchModeChange('browser')`（按 §3.1.1 决策 A，默认最小改动；若 R1 决定 helper 化则改用 helper）。
- **改动**：上述两行 + 必要 import；**不动**同函数内 document/calendar 分支。
- **验收**：文件树打开本地 HTML、全局搜索命中本地 HTML → 进浏览器无错位。
- **测试影响**：无结构测试锁这两处。

### WP3 — 切标签不打断显示（现象 2 主体）
- **目标**：改写 `BrowserMode.tsx:791-855`，纯切标签不发 `hide-all`、不二次 fit、不 180ms 二次重同步；保留首次 present / 恢复 / resize 的正确性。
- **改动**：
  0. 新建 `src/renderer/modules/browser/browserTabFitRegistry.ts`（模块级单例，§3.2.0）：`markFitted/isFitted/clearFitted/clearAll`。
  1. BrowserMode 新增 `hostPresentedRef`（host 是否已成功 present；`shouldReveal`/`runtimeReady` 落 false 时复位）。fit 状态改用 registry，不在组件里放 Set。
  2. 改 `syncVisibleHost`（`:799-815`）：
     - host 未 present（首次）：保留 fit + show（去掉制造空窗的多余 hide，若可行），fit 成功后 `markFitted`。
     - host 已 present 且本次是纯 `activeTabId`/`splitTab.id` 变更：**跳过 `syncBrowserVisibility('hidden')`**；目标标签若 `!isFitted` 才 `fitActiveTabToBounds` 并 `markFitted`；最后 `sendBoundsImmediate({ forceExact: true })` 单次对账，不调用带 `forceBoundsSync` 的 visible 周期。
     - **split 分支（§3.2.1 D）**：切主标签时**不**对 secondary 发 hide；secondary 首次 present 未 fit 才 fit + `markFitted(splitTab.id)`；对 primary 与 secondary 各发一次"仅移动"bounds 对账（primary `set-bounds` / secondary `secondary-set-bounds`）。split 分支不得复用非 split 的 hide→show。
  3. 改 `postActivationHostResyncTimer`（`:821-855`）：依赖去掉 `activeTabId`（或加 `hostPresentedRef` 守卫），使其只服务"首次 present / 动画落定"的一次对账，纯切标签不重排。
  4. 在 `src/renderer/modules/browser/useBrowserRuntimeEffects.ts` 的 `onTabUpdate`（`:184-237`）挂 `clearFitted`：`'navigate'`（`:191`）、`'loading' && loading===true`（`:203`）、`'closed'`（`:222`）三个 case 各清除对应 `event.tabId`。**这是唯一清除点**（§3.2.0 理由：所有内容变化都经此回流），不在 `useBrowserTabActions` 各入口重复埋点。
- **验收**：在 ≥3 个标签间来回切换，无可见闪烁、无内容偏移/抖动；**已适配标签导航到新页面后再切回会重新 fit**（不留过宽）；首次进浏览器、窗口/面板 resize、**split 双开切主标签**（secondary 不闪不丢 bounds）均无回归。
- **测试影响**：与 §2.8 三个结构测试冲突 → 交 WP4 处理。

### WP4 — 测试：结构测试改行为断言 + 新增回归
- **目标**：把被现象 2 触碰的结构测试改成**行为测试**（CLAUDE.md §6：调用真实入口/最小替身、断言可观察结果），并为现象 1/2 各加一条行为回归。
- **改动**：
  1. `browser-sync-visible-host-three-step-contract.test.ts`：删除/重写为"纯切标签不产生 `hide-all` intent"的行为断言（用最小替身记录 intent 序列：切标签后 intent 流里**不应**出现 `hide-all`，应只有 `set-bounds`/`show`）。
  2. `browser-mode-startup-resync-contract.test.ts`：更新为新分支结构/行为；保留"首次 present 有一次落定对账"的断言。
  3. `browser-tab-count-resync-guard-contract.test.ts`：复核是否仍成立；不成立则同步更新。
  4. 新增现象 1 行为测试：调用 `openWebpageInBrowser`，断言成功分支触发 `requestWorkbenchModeChange`（监听 `READY_WORKBENCH_MODE_CHANGE_EVENT`）而非直接改 `useMode`。
  5. 新增现象 2 行为测试：模拟 host 已 present + 纯切标签，断言无 `hide-all` 且对同一已适配标签不重复 `fitActiveTabToBounds`。
  6. **【R1 补全】helper fallback 断言**：`createTab` 失败时 `openWebpageInBrowser` 走 `window.open` 回退，断言**不**派发 `READY_WORKBENCH_MODE_CHANGE_EVENT`、不改 `useMode`（防空壳进入 browser）。
  7. **【R1 补全】导航后重 fit 断言**：已 `markFitted` 的标签收到 `onTabUpdate` 的 `'navigate'`（或 `'loading' true`）事件后 `isFitted` 变 false；再切回该标签会重新 `fitActiveTabToBounds`。
  8. **【R1 补全】split 断言**：split 双开下切主标签，断言 intent 流**不含** `hide-all`，secondary 仍有 `secondary-set-bounds`/保持 bounds、不被隐藏。
- **验收**：`npm run test` 全绿；新测试在"还原旧实现"时会失败（真行为锁定，非 source-grep）。

---

## 5. 顺序与依赖
- WP1 → WP2 可并行（互不碰同文件；若 R1 选 helper 化，WP2 依赖 WP1 的 helper，则改为串行）。
- WP3 独立于 WP1/WP2（不同文件），可并行。
- WP4 依赖 WP1+WP3 落地后再写/改（断言新行为）。
- 建议批次：批次一 = WP1 ∥ WP3；批次二 = WP2；批次三 = WP4。

## 6. 验收（整体）
- `npm run typecheck` 无错误。
- `npm run test` 全绿（含 WP4 新/改测试）。
- 手动回归（CLAUDE.md §10 关键链路）：
  1. 文档正文链接 / Widget 链接 / 文件树本地 HTML / 全局搜索本地 HTML / RSS 预览 → 进浏览器**均无错位**（RSS 作为对照应继续正常）。
  2. browser 内多标签来回切换：无闪烁、无偏移抖动。
  3. 首次进浏览器、窗口 resize、面板拖拽、split 双开：无新回归。
  4. 键盘快捷键切模式：不受影响。
- 不涉及 SQLite/设置/本地持久化，`verify:native` 非必须（如 CI 链要求则照跑）。

## 7. 测试影响与回归论证
- 现象 2 的修复**必然**改动 §2.8 的结构测试——这些测试锁的是实现细节而非用户可观察行为，按 §6 测试规约应升级为行为断言；这是计划内的预期改动，不是"破坏测试"。
- 回归面（【R1 补全】每条已配对机制 + 断言）：
  - ① split 双开切主标签 → 机制 §3.2.1 D / WP3 split 分支；断言 WP4 点 8。
  - ② 首次 present 未 fit 导致过宽（决策 C）→ 机制 §3.2 步 2 "首次可见才 fit"；断言 WP4 点 5。
  - ③ 导航/刷新/重试/同标签 URL 变化后未重 fit → 机制 §3.2.0 唯一清除点（`onTabUpdate` 三 case `clearFitted`）；断言 WP4 点 7。
  - ④ helper 失败回退 `window.open` 误切 browser 模式（空壳进入）→ 机制 §3.1 点 3 "仅成功分支切换"；断言 WP4 点 6。

## 8. 风险与回滚
- **风险 1**：去掉切标签 hide 后，某些边界（标签 view 尚未 attach、刚 createTab 未就绪）可能短暂显示旧标签。缓解：纯切标签分支仅在 `hostPresentedRef && 目标 view 已存在` 时跳过 hide；否则回落首次 present 路径。
- **风险 2**：`requestWorkbenchModeChange` 异步化引入时序差。缓解：§3.1.1 决策 B 已核实四点无同步依赖；WP1/WP2 仍逐点复核。
- **回滚**：两组改动相互独立，可分别 revert（WP1+WP2 一组、WP3+WP4 一组）。
- **工作区现状**：除既有未跟踪的设置计划改动外，本计划开工前工作区针对浏览器相关文件干净。

---

## 附：给施工 subagent 的硬性约束
1. 先复核 §2 引用的 file:line 仍成立再改（行号会漂，按符号定位）。
2. 严守手术式改动：只碰本计划点名的文件与行；不顺手重排/重命名/改注释。
3. 跨边界状态（host present、标签已适配）必须显式 ref 建模，不得裸 fire-and-forget 靠重试（红线 6）。
4. 测试写行为断言，不得 source-grep 冒充、不得 skip 当通过（§6 规约）。
5. 每个 WP 完成附：改了哪些 file:line、为何这样选点、跑了哪些验证及结果。
