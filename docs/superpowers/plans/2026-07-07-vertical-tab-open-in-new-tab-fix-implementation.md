---
status: approved（对抗性审查组判 Phase 0 可实施，2026-07-07）；enforce:false 待白点头开工
revision_history:
  - v1 (2026-07-07): 初稿 + 审查订正。审查判 APPROVED：根因链逐处复验（emitBackgroundTabOpened 的 `if(!background)return`、host createTab 仅 url 签名、options-丢弃 wrapper 均已核）；§3.2 三点修复正确自洽。§2.3 措辞精确化（见正文）。
owner: 白
author: Claude (Opus 4.8)
executor: 待定
reviewer: 对抗性审查组（多 subagent）+ 白（终审）
enforce: false
note: >
  竖向标签栏「右键 → 在新标签页打开链接/图片」几乎稳定不在标签条出现新标签页，
  但能看到内容视图跳转，只有切换到别的标签或新建空白标签后该标签才补出现。
  本文档定位根因（已 100% 静态确诊）并给出最小手术式修复。
  本修复是 groups/reorder 特性（2026-07-07-vertical-tab-groups-and-reorder-implementation.md）
  的前置基座：opener→group 继承依赖本修复恢复的 browser:tabOpened 推送与后续 openerTabId。
pairs_with:
  - docs/superpowers/plans/2026-07-07-vertical-tab-groups-and-reorder-implementation.md（特性主计划；本修复为其 Phase 0 前置）
related:
  - CLAUDE.md §2（BrowserView 原生覆盖层硬约束、会话 scope 隔离）
---

# 竖向标签栏「在新标签页打开」不进标签条 — 根因与修复

## 0. 结论速览

- **症状**：在网页内右键链接/图片 → 「在新标签页打开链接/图片」，内容视图会跳到新页面（"界面在跳转"），但左侧竖向标签条**几乎稳定不出现**该新标签；只有点击别的标签或新建空白标签后，新标签才补出现。
- **根因（100% 静态确诊）**：右键菜单走的是**前台** `createTab`，而前台 `createTab` 的唯一 renderer 通知 `emitBackgroundTabOpened` 对前台**提前 return 不发事件**；渲染进程标签条只有两条获知途径（`onTabOpened` 推送、`syncTabsFromBackend` 拉取），两者本路径都不触发，直到下一次 switch/new-tab 拉取才补上。
- **修复（最小手术式，跨 2 文件）**：右键菜单两处以 `{ background: true }` 调 `createTab`，并**放宽 context-menu host 的 `createTab` 形参**（当前窄化为仅 `url`，见 §2.7），复用**既有正确**的后台推送路径（`emitBackgroundTabOpened` → `browser:tabOpened { activate:false }` → renderer `onTabOpened` 列出但不抢占）。既补出标签条条目，又消除"界面在跳转"（后台打开不切前台，符合 Chrome/Edge 语义）。
- **明确不采用**：让 `createTab` 无条件 emit。原因见 §4——renderer 自建标签路径会收到回声，而 `useBrowserTabs.addTab` 无去重，会产生重复标签条目。

---

## 1. 症状与复现

1. 浏览器模式下打开任意网页，页面上存在超链接。
2. 右键该链接 → 选「在新标签页打开链接」。
3. 观察：内容区 BrowserView 切到新页面；左侧 52px 竖向标签条**未新增**对应图标；地址栏/激活态仍停留在原标签。
4. 点击任意其它标签，或点「+」新建空白标签 → 新页面对应的标签**这时才出现**在标签条中。

图片链接走「在新标签页打开图片」同样复现。

---

## 2. 根因证据链（逐跳静态确认）

### 2.1 右键菜单调用前台 createTab

`src/main/modules/browser-engine/context-menu-service.ts`
- `:114-121` 「在新标签页打开链接」→ `click: () => { void this.host.createTab(linkUrl).catch(...) }`
- `:167-173` 「在新标签页打开图片」→ `click: () => { void this.host.createTab(imageUrl).catch(...) }`

两处均 `createTab(url)` **不传 options**，即 `background` 为 undefined → 前台创建。

### 2.2 前台 createTab 会呈现视图，但对前台不发 renderer 事件

`src/main/modules/browser-engine/tab-lifecycle-service.ts` `createTab`（`:271-390`）：
- `:281` `const background = options?.background === true`（本路径为 false）。
- `:380-383` 前台分支：`setActiveTabId(tabId)` + `finalizeSwap(true)` → `showHost`（`:362-364`）——**这是"界面在跳转"的来源：主进程把新 BrowserView 设为激活并呈现**。
- `:388` 唯一的 renderer 通知：`this.emitBackgroundTabOpened(tab, background)`。
- `emitBackgroundTabOpened`（`:400-406`）：**`if (!background) return`（`:401`）** → 前台直接返回，**不发 `browser:tabOpened`**。

即：前台 `createTab` 呈现了视图，但没有向渲染进程发送任何"新标签"事件。

### 2.3 运行期标签条只有两条获知途径，本路径都不触发

`useBrowserTabs`（`src/renderer/stores/useBrowserTabs.ts`）是 renderer 侧 Zustand + localStorage 存储（`:105-228`），标签条即以其 `tabs` 渲染。**运行期（启动 hydration 之后的稳定态）**它被填充的途径只有两条：

1. **推送**：`onTabOpened` 监听（`src/renderer/modules/browser/useBrowserRuntimeEffects.ts:253-287`），由 preload `browser:tabOpened`（`src/preload/index.ts:540-543`）桥接。→ 本路径无人 emit，**不触发**。
2. **拉取**：`syncTabsFromBackend`（`src/renderer/modules/browser/useBrowserTabActions.ts:42-68`，`getTabs()` → `setTabs`）。其调用点仅在：
   - `handleNewTab` 新建标签后（`:127`）
   - `handleCloseTab` 关标签后（`:159`、`:178`）
   - `handleTabClick` **切换标签后**（`:184`）
   - `handleNavigate` 无目标标签新建分支后（`:223`）

（**精确性说明（审查订正）**：另有**启动/激活期** hydration 现场 `restoreExistingTabs`/`rebuildRuntimeFromPersistedTabs`（`useBrowserRuntimeEffects.ts:118/75`）也会 `setTabs` 填充 store，故"只有两条"限定在**运行期稳定态**。它们**不在一次右键"打开链接"的时序里触发**，不影响本根因；但它们对 groups 特性是关键的保组现场，见特性主计划 §6 P0。）

因此右键新建的标签**只在下一次 switch/new-tab/close/navigate 触发 `syncTabsFromBackend` 时补出现**——与症状"点击别的标签或新建空白标签才出现"逐字吻合。

### 2.4 对照：window.open / target=_blank 路径为何不坏

`ipc-handler.ts` `openPopupInTab`（`:652-689`）在 `createTab` 之后**显式**补发 `this.sendToRenderer('browser:tabOpened', this.tabMetaService.buildTabPayload(tab))`（`:683`）。这条路径因此能立即进标签条。右键菜单路径缺的正是这一步——**这是一处非对称遗漏**，不是 renderer 响应式 bug。

### 2.5 已排除的替代解释（守住"100%"）

- **后台轮询补账**：`src/renderer/modules/browser/useAgentBrowserSupervision.ts:160-163` 有 `setInterval(refresh, POLL_MS)`，但 `refresh` → `syncAgentTabFromRuntime`（`:90-114`）**只同步单个 agent 标签**（`next.agentTabId` gated，`:144-145`），不 reconcile 用户标签。故不存在"过一会自动出现"，与"几乎稳定不出现"一致。
- **其它 addTab 来源**：`rss/open-rss-item-in-browser.ts:36`、`browser/openWebpageInBrowser.ts:24`、`browser/localHtmlFileOpen.ts:83`、`useBrowserRuntimeEffects.ts:172` 均为 renderer 自发功能路径，与右键菜单无关。
- **响应式/重渲染丢失**：不成立。事件根本未发出（§2.2），并非发出后未重渲染。

### 2.6 附带可见征状（进一步佐证同一根因）

推送缺失期间，renderer `activeTabId` 未变（仍指旧标签），而主进程已把新标签设为激活并呈现视图 → **地址栏/激活高亮停留旧标签、内容区显示新页面**的状态分裂。此分裂与"标签条缺条目"同源，修复后一并消解。

### 2.7 context-menu host 的 createTab 当前窄化为仅 url（已确认）

修复不是"传个 options"这么简单——host 层把 options 吃掉了，必须先放宽：
- `context-menu-service.ts:21-24` `interface BrowserContextMenuHost { ... createTab(url: string): Promise<{ success; tabId?; error? }> }` — **签名只有 url，无 options**。
- `ipc-handler.ts:221-224` 构造 `contextMenuService` 时 host 字面量 `createTab: (url) => this.createTab(url)` — **窄化包装，丢弃 options**。
- 对照 `ipc-handler.ts:1854-1864` 的 `this.createTab(url, options?)` 本体是支持 options 的；被吃掉的是 host 边界这一跳。

（`ipc-handler.ts:285`、`:390` 另有两处 `createTab: (url) => this.createTab(url)`，属**其它 host 字面量**（非 contextMenuService），本修复不涉及，不要顺手动。）

---

## 3. 修复方案（最小手术式）

### 3.1 决策：后台打开（用户已确认，2026-07-07）

「在新标签页打开链接/图片」应**后台打开**（对齐 Chrome/Edge：新建标签进条，但**不切走当前页面**）。此决策使修复恰好收敛到既有正确的后台路径。

### 3.2 改动点（3 处，跨 2 文件）

1. **放宽 host 接口** — `src/main/modules/browser-engine/context-menu-service.ts:24`
   `createTab(url: string): Promise<...>` → `createTab(url: string, options?: { background?: boolean }): Promise<...>`
2. **放宽 host wiring** — `src/main/modules/browser-engine/ipc-handler.ts:224`（仅 contextMenuService 那处）
   `createTab: (url) => this.createTab(url)` → `createTab: (url, options) => this.createTab(url, options)`
3. **调用处传后台** — `context-menu-service.ts:117` 与 `:169`
   `this.host.createTab(linkUrl)` → `this.host.createTab(linkUrl, { background: true })`（图片同）

三处均为透传/形参拓宽，无新增控制流；`this.createTab`（`ipc-handler.ts:1854`）→ `tabLifecycleService.createTab`（`:1859`）本就原样透传 options 到后台分支。

### 3.3 为什么这样就对

`createTab(url, { background: true })` 走 `tab-lifecycle-service.ts` 后台分支：
- **不** `setActiveTabId`、**不** `finalizeSwap`/present → 无"界面跳转"（页面在后台加载）。
- `emitBackgroundTabOpened(tab, true)`（`:400-405`）→ 发 `browser:tabOpened { ...buildTabPayload(tab), activate:false }`。
- renderer `onTabOpened`（`useBrowserRuntimeEffects.ts:253-287`）：`addTab`（或已存在则 `updateTab`）→ **`if (tab.activate === false) return`（`:278`）** 跳过激活/地址栏改写。

净效果：新标签**立即进标签条**、当前页面**不被抢占**、地址栏/激活态**不分裂**。三条症状全消，且全部复用既验证过的机制，无新增控制流。

### 3.4 options 到达后台分支的完整链路

`context-menu-service` 调用 → `BrowserContextMenuHost.createTab`（放宽后带 options，§3.2-1）→ ipc-handler host wiring（放宽后透传，§3.2-2）→ `ipc-handler.ts:1854` `this.createTab(url, options)` → `:1859` `this.tabLifecycleService.createTab(url, options)` → `tab-lifecycle-service.ts:281` `background = options?.background === true`（此时为 true）→ 后台分支 + `emitBackgroundTabOpened(tab, true)`。链路无断点。

---

## 4. 明确不采用的替代（防"看似更彻底"的坑）

**不**把 `createTab` 改为无条件 emit（`emitBackgroundTabOpened` 去掉 `if (!background) return`、或在 `createTab` 末尾统一 emit）。理由：
- renderer 自建标签路径（`handleNewTab` 等）在 `createTab` IPC 返回后本地 `addTab`（`useBrowserTabActions.ts:123`）。若 `createTab` 也 emit，`onTabOpened` 会先行 `addTab` 一次，`handleNewTab` 再 `addTab` 一次。
- `useBrowserTabs.addTab`（`useBrowserTabs.ts:174-185`）为 `tabs: [...state.tabs, tab]`，**无按 id 去重**，`sanitizeSnapshot` 也不去重 → **重复标签条目**。
- 结论：emit 必须限定在**主进程自发**创建的用户标签路径。`openPopupInTab` 已 emit（前台），右键菜单改走后台路径后由 `emitBackgroundTabOpened` emit（activate:false）。两条主发路径各自恰好 emit 一次，renderer 自发路径不受回声污染。

> 备选（本次不做，仅备案）：若日后需要收敛"主进程自发创建用户标签"为单一漏斗，可提取 `createUserTabFromMain(url, { background, openerTabId })` 供 `openPopupInTab` 与右键菜单共用。当前 2 行改动已闭环，遵循简单优先，不引入该抽象。

---

## 5. 作用域边界（改什么 / 不改什么）

- **改**：右键菜单两处 `createTab` 传参。
- **不改**：`createTab` 本体、`emitBackgroundTabOpened` 语义、renderer store、`onTabOpened`、`syncTabsFromBackend`、overlay 协议、任何 groups/reorder 相关代码。
- **不改**：`openPopupInTab`（window.open / target=_blank / 中键）当前为**前台** emit。相关一致性备选见下。
- **一致性备选（需白定夺，默认不做）**：中键/`target=_blank` 经 `openPopupInTab` 仍前台打开。若要"所有新标签打开一律后台"，需将 `openPopupInTab` 非 agent 分支改 `background:true` 并移除其 `:683` 手动 emit（改由后台路径 emit）。本次仅修复被报告的右键菜单路径，`openPopupInTab` 维持现状，避免扩大行为变更面。

---

## 6. 待审查项（对抗性审查须逐条证伪/证实）

- **R1（已确认，非开放项）**：host 接口**确实**窄化为仅 url（`context-menu-service.ts:24`）、wiring **确实**丢弃 options（`ipc-handler.ts:224`）。故 §3.2 已含放宽 host 接口 + wiring 两步。审查只需复核：放宽后 TypeScript 全绿、且未误动 `ipc-handler.ts:285/:390` 两处无关 host。
- **R2**：确认后台 `createTab` 对 `owner` 默认 `'manual'`（`tab-lifecycle-service.ts:291` / `:331`），不会把右键新标签误标为 agent 标签而触发监督接管（`openPopupInTab` 的 agent 分支才做接管，右键路径不经该分支）。
- **R3**：确认 `onTabOpened` 的 `activate===false` 分支（`useBrowserRuntimeEffects.ts:278`）在 `addTab` 之后 return，不会遗漏 `setBrowserRuntimeReady`/首帧 hydrate 导致标签条不刷新（`addTab` 触发 store 更新即会重渲染标签条；runtime-ready 仅影响首帧空态）。
- **R4**：确认新标签插入位置——`onTabOpened` 走 `addTab` 追加到 `tabs` 末尾（`useBrowserRuntimeEffects.ts:274`）。后台打开追加末尾在 Phase 0 可接受；"插到 opener 之后 / 继承 opener 分组"属特性 Phase 4，本文档不承诺。

---

## 7. 验证计划

### 7.1 真机行为验证（验收面）
1. `npm run dev`，浏览器模式打开含链接页面。
2. 右键链接 →「在新标签页打开链接」：**断言** 标签条立即新增图标；当前页面**不跳转**；地址栏/激活高亮保持原标签。
3. 图片链接走「在新标签页打开图片」同样断言。
4. 回归：`handleNewTab`（+）、`handleTabClick`（切换）、`handleCloseTab`（关闭）、window.open/中键（经 `openPopupInTab`）行为不变、无重复标签条目。

### 7.2 行为测试（自动化，最小替身）
新增聚焦测试，驱动真实入口断言可观察结果（遵循 `docs/superpowers/testing-conventions.md`，行为测试优先）：
- 构造 `BrowserTabLifecycleService` + 最小 host 替身（`sendToRenderer` 记录、`tabs` Map、`useMock`），调用 `createTab(url, { background:true })`，**断言**恰好发出一次 `browser:tabOpened` 且 `activate === false`、tab 未被 `setActiveTabId`。
- 反向断言 `createTab(url)`（前台）**不**发 `browser:tabOpened`（锁住 §2.2 事实，防未来回归）。
- renderer 侧：以 `onTabOpened({ activate:false })` 驱动 `useBrowserRuntimeEffects` 的处理器，断言 `useBrowsertabs` 新增该标签且 `activeTabId` 不变。

### 7.3 可选 gate（machine-verifiable，建议但非必须）
`scripts/check-context-menu-open-in-tab-background.cjs`：静态断言 `context-menu-service.ts` 两处 open-in-tab 调用带 `background: true`，防未来手滑回退到前台无声吞。若采纳则挂入 `verify:browser-lane` 一类既有 browser 验证链，并配 `scripts/__tests__/*.test.cjs`。

---

## 8. 风险登记

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| host 窄化吞掉 options | 已确认 host 接口/wiring 窄化为仅 url（§2.7）；若只改调用处会编译报错或被静默吞 | §3.2 已含放宽 host 接口 + wiring；typecheck 兜底 |
| 用户预期前台打开 | 少数用户可能期望点完即切到新页 | 已由白确认后台语义（对齐主流浏览器）；如需可加设置项（本次不做） |
| 中键/`_blank` 不一致 | `openPopupInTab` 仍前台，与右键后台不一致 | §5 一致性备选，待白定夺；默认保持现状并在文档标注 |
| 行为测试触碰 host 单例/全局 | 替身若破坏 lifecycle 单例 | 用局部最小替身，遵循测试规约对高风险 helper 的显式声明 |

---

## 9. 交付纪律

- 单独 commit，diff 极小（2 行语义 + 测试）。
- 提交前：`npm run typecheck` 绿；跑 §7.2 行为测试；真机过 §7.1。
- commit message 结尾附 Co-Authored-By（按仓库规范）。
- 本修复合入后，特性主计划以其为 Phase 0 基线开工。
