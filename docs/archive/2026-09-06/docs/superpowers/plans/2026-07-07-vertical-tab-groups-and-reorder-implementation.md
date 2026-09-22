---
status: draft v2 — 已过两轮对抗性审查（2026-07-07）：round1 9 项确诊全吸收；round2 聚焦复审判 docA/docB ready、5 项 P2 nit 已修。待白终审后 enforce/开工
revision_history:
  - v2.1 (2026-07-07): round2 聚焦复审（5 agent）判两文档 ready，仅余 5 项 P2 措辞/一致性 nit，已全修：gate 名统一 `check-tabs-merge-preserves-groups`；D-SNAPSHOT 去掉"显示 rank==扁平 rank(by construction)"改为"toRank 按落点相邻 tab id 在扁平快照取下标"（overlay 视觉 hoist 纯 cosmetic）；§12.0 补三处 renderer-local setTabs（`:95/:155/:177`）exempt 标注 + drift gate 收窄到 backend→renderer；Q-CMD→D-CMD 名称统一；§12 P1→P1a/P1b 标签一致化。
  - v2 (2026-07-07): 吸收对抗性审查组 9 项确诊。P0：backend→renderer 有三条 setTabs（syncTabsFromBackend / restoreExistingTabs:118 / rebuildRuntimeFromPersistedTabs:75），只改一条会在分屏切换重挂载时抹组 → §6 改"三路径共用归并 helper" + §12.0 写路径审计 + §13 三路径 gate。P1：overlay buildSnapshot:89 发全局 hoist 显示序致 toRank 空间错位 + 跨组 split 破坏显示连续性 → §9.0 D-SNAPSHOT 发扁平序；文档 store 裸 set() 无 choke 致关最后成员留孤儿 → §5.2 per-mutation normalize。纠正：pair-hoist 破坏的是 I-DISPLAY 非 I1（getActiveTabPairOrder 是纯投影），原红测作废（§7.1）。补：折叠组含 active/split 自相矛盾 → D-COLLAPSE 自动展开（§7.3）；delete-group 全标签场景落 0 标签 + new-tab-in-group 无编排 → §11.1；R-PAIR 升为硬交付 D-SNAPSHOT、三处 hoist 现场；两处 file:line 锚点订正。
  - v1 (2026-07-07): 初稿。
owner: 白
author: Claude (Opus 4.8)
executor: 待定（分阶段逐单）
reviewer: 对抗性审查组（多 subagent，20 agent / 9 确诊）+ 白（终审）
enforce: false
note: >
  为浏览器竖向标签条与文档竖向标签条引入 Edge 式「标签组 + 自定义排序」。
  拖拽一个标签放到另一个标签上 → 文件夹式落入视觉 → 松手建组；拖到标签间隙 → 分隔线排序。
  最小组功能：改名 / 改色 / 解散组（不关标签）/ 删除组（关标签）/ 拖出离组。
  前置基座：Phase 0 = 2026-07-07-vertical-tab-open-in-new-tab-fix-implementation.md（先合入）。
pairs_with:
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-07-07-vertical-tab-open-in-new-tab-fix-implementation.md（Phase 0 前置）
related:
  - CLAUDE.md §2（BrowserView 原生覆盖层硬约束；白屏防护；输入框液态玻璃验收面）
  - CLAUDE.md §4（DomainAdapter 只调度不写产品分支）
  - docs/superpowers/testing-conventions.md（行为测试优先）
  - src/renderer/components/layout/file-tree/*（拖拽两意图 + drag-session 复用范式）
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# 竖向标签栏：标签组 + 自定义排序 实施计划

## 0. 速览与已锁决策

**已锁决策（白确认，2026-07-07）：**
1. **先修后做**：Phase 0 修复「在新标签页打开」不进条（独立合入、独立验收），再做本特性。
2. **浏览器组 UI 落在展开 hover 浮层**（248px overlay 窗口），非 52px 图标条本身、非新增常驻侧栏。
3. **打开链接后台化**（Phase 0 交付）；本特性 Phase 4 复用其推送补 opener→组继承。

**核心设计（第一性原理）：**
- 数据模型 = **扁平有序 `tabs[]` + 每标签 `groupId` + 组元数据 `tabGroups[]`**，不变量：**同组标签在扁平序中连续**（Edge 语义）。不引入嵌套树（现架构 renderer↔main reconcile、`getTabs/setTabs/reorderTabs`、split-pair 排序全是扁平序，树会与之全面冲突）。
- **组是 renderer-only**（主进程完全不知情；分组不影响 BrowserView 生命周期）。推论：浏览器 `syncTabsFromBackend` 必须从「盲替换」改为「按 id 归并」，否则每次后端 reconcile 抹掉分组。
- **单一纯函数模型** `tab-group-model.ts` 被两个 store 共用（满足"浏览器+文档"双落点）。

---

## 1. 目标与非目标

**目标**
- 浏览器条 + 文档条均支持：拖标签到标签上建组、拖到间隙排序、拖出离组。
- 组操作最小集：改名、改色、解散（保留标签）、删除（关闭标签）、组内新建标签。
- 组有名字 + 颜色 + 折叠态；折叠/展开在浮层可视管理；折叠态在图标条可辨识归属。
- 排序与分组跨会话持久化。

**非目标（本期不做）**
- 组跨窗口/跨工作区迁移（reference 图 3 里的"移动到新视窗/移至新工作区"不做）。
- 浏览器组 ↔ 文档组互通（两 store 独立，各自的组互不相关）。
- 常驻可 pin 展开侧栏（Edge 真实模型）——本期仍 52px 条 + hover 浮层。
- 组语义下沉到主进程 / 参与 agent 采集 lane。

---

## 2. 现状地图（逐处 file:line 已核）

### 2.1 两个 store（均 renderer 侧，扁平有序）
- 浏览器 `src/renderer/stores/useBrowserTabs.ts`：Zustand + 手写 localStorage（key `ready-browser-tabs-v1`，`:46`）。`tabs: BrowserTab[]`（`:21`）、`reorderTabs(fromIndex,toIndex)`（`:213-227`）。`sanitizeSnapshot`（`:66-87`）为读写唯一 normalize 口。`addTab`（`:174-185`）**无 id 去重**。
- 文档 `src/renderer/stores/useDocTabs.ts`：Zustand `persist` 中间件（key `ready-doc-tabs-v2`，version 2，`:54/:415-466`）。`tabs: DocTab[]`（`:25`，`:24` 为 `interface DocTabsState {`）、`reorderTabs`（`:383-388`）、`partialize`（`:419-432`）、`migrate`（`:446-465`）、`onRehydrateStorage`（`:433-445`）。

### 2.2 浏览器条 = 52px 图标条（主渲染进程） + 248px 浮层（独立子窗口）
- 主渲染 `src/renderer/components/browser/VerticalTabRail.tsx`（52px）：**已有拖拽排序**（`handleDragStart:237` / `onDragOver:319` setDragOverIndex / `onDrop:320` → `handleReorderDrop:255` → `onReorder(fromIndex,toIndex)`）。展示 `getActiveTabPairOrder` 派生序（`:78-81`，`sourceIndex` 为原始序下标）。它还**驱动浮层**：hover 打开、`buildSnapshot:83` 组装只读快照、`showVerticalRailOverlay`。命令回流处理 switch/close/new-tab/**reorder(已在协议)**/toggle-bookmark/reference（`:166-215`）。
- 浮层 `src/renderer/pages/VerticalRailOverlayWindow.tsx`：**独立子 BrowserWindow 的独立渲染进程**（`src/main/modules/browser-engine/vertical-rail-overlay-window.ts`，宽 248，浮于原生 BrowserView 之上）。它**只**消费 `VerticalRailOverlaySnapshot`（只读）+ `send(command)`（`:20-22`），**不 import `useBrowserTabs`**（独立 JS 堆、独立 store 实例）。**当前无拖拽**。
- 协议 `src/shared/browser-vertical-rail-overlay.ts`：`VerticalRailOverlayTab`（`:5-18`）、`VerticalRailOverlaySnapshot`（`:29-33`）、`VerticalRailOverlayCommand`（`:35-43`，已含 `reorder{fromIndex,toIndex}`）。

### 2.3 文档条 = 52px 图标条 + 同窗口 DOM 浮层（关键差异）
- `src/renderer/components/document/DocumentVerticalTabRail.tsx`：浮层是 **`createPortal` 到 `document.body`**（`:239-330`，同窗口，非独立子窗口——文档模式无原生 BrowserView 遮挡）。**图标条与浮层均已接拖拽回调**（`onTabDragStart/Over/Drop/End`，`:171-175`、`:278-282`）。
- rail 消费 **投影 `DocumentVerticalTabItem[]`**（`:25-34`，id/label/pathLabel/title/dotColor/active/secondaryActive/dirty），非裸 `DocTab`。投影在 `DocumentMode.tsx:906-919` 就地 map；拖拽经 `handleDragStart`（`:771-790`）+ `handleDragOver/Drop/End`（`:792-808`）+ `dragIndexRef` + `reorderTabs`（`:801`）。

### 2.4 浏览器 renderer↔main 同步契约
- `syncTabsFromBackend`（`useBrowserTabActions.ts:42-68`）：`getTabs()` → 构造 hydratedTabs → **`setTabs(hydratedTabs)` 盲替换**（丢弃任何后端 payload 之外的 renderer-only 字段、并强加后端序）。调用点：new/close/switch/navigate（`:127/159/178/184/223`）。
- 反向：`handleReorder`（`:353-366`）先 `browser:reorderTabs(orderedTabIds)` 写主进程，成功后本地 `reorderTabs`。故当前主/渲染序一致。
- payload 形状 `buildTabPayload`（`tab-meta-service.ts:43-60`）→ `BrowserTabMetaPayload`（`:17-32`，**无 groupId、无 openerTabId**）。

### 2.5 split-pair 显示重排（与分组会打架，须决议）
- `getActiveTabPairOrder`（`src/renderer/modules/workbench/active-tab-pair-order.ts:6-32`）：把 secondary(split) 标签在**显示序**里提到 active 之后，`sourceIndex` 保持原始下标。两 rail 均以它派生显示。→ 一旦有组，跨组把 split 提到 active 旁会破坏连续性不变量，§7 给决议。

---

## 3. 数据模型

### 3.1 共享类型（新文件 `src/shared/tab-groups.ts`）
```ts
// 闭集颜色，映射既有 CSS 变量（--color-blue 等，reference 图 3 约 9 色）
export type TabGroupColor =
  | 'blue' | 'cyan' | 'green' | 'yellow' | 'orange'
  | 'red' | 'pink' | 'purple' | 'gray'

export interface TabGroup {
  id: string            // 'grp-<n>'，renderer 生成
  name: string          // 可空串 → UI 显示占位；持久化保留原值
  color: TabGroupColor
  collapsed: boolean
}
```

### 3.2 store 扩展
- `BrowserTab` / `DocTab` 各加 `groupId?: string | null`。
- 两 store state 各加 `tabGroups: TabGroup[]`。
- **不变量 I1（连续性）**：`∀g, {t | t.groupId===g.id}` 在 `tabs[]` 中连续。
- **不变量 I2（组序）**：组的视觉次序 = 其最早成员在 `tabs[]` 中的位置（组序为派生，不单独存另一份序，避免双源）。
- **不变量 I3（无孤儿）**：`tabGroups` 中每个组至少 1 个成员；`groupId` 必指向存在的组。I1–I3 由 §4 `normalizeGroupState` 强制——**但"每次变更末尾"只在该 store 存在单一写 choke 点时成立**：浏览器 store 全走 `sanitizeSnapshot`（天然 choke），文档 store 各 mutator 走裸 `set()`（**无 choke，须专门补**，见 §5.2 P1），否则如"关组内最后一张标签"会留孤儿组直到重载。

---

## 4. 共享纯模型 `src/shared/tab-group-model.ts`

纯函数（无 React/electron 依赖），以 **id 序 + groupId 映射 + 组列表** 为最小载荷，两 store 各自适配自己的 `Tab[]`：

```ts
export interface GroupModelState {
  order: string[]                          // 扁平 tab id 序（= tabs[] 的 id 投影）
  groupOf: Record<string, string | null>   // tabId -> groupId
  groups: TabGroup[]
}

// 全部纯：入 current，出 next（已 normalize）
export function createGroupFromDrop(s, draggedId, targetId, meta?): GroupModelState   // 组{target, dragged}，落在 target 位置
export function addToGroup(s, tabId, groupId): GroupModelState
export function removeFromGroup(s, tabId): GroupModelState                            // 清 groupId + 移到该组 run 外相邻位
export function reorderTab(s, movedId, toRank, intoGroupId: string|null): GroupModelState // 排序 + 按落点定归属
export function renameGroup(s, groupId, name): GroupModelState
export function recolorGroup(s, groupId, color): GroupModelState
export function setGroupCollapsed(s, groupId, collapsed): GroupModelState
export function disbandGroup(s, groupId): GroupModelState                             // 清成员 groupId + 删组；标签留
export function segmentIntoRuns(s): Array<
  | { kind: 'group'; group: TabGroup; tabIds: string[] }
  | { kind: 'tab'; tabId: string }
>                                                                                    // 渲染模型（含折叠态）
export function normalizeGroupState(s): GroupModelState                              // 内部：强制 I1/I2/I3
```

说明：
- **delete（关标签）不进纯模型**（它要删标签，越过 id 层）：由 store 层删 `tabs[]` 成员（浏览器还需逐个 `browser:closeTab`）+ 调 `disbandGroup`/直接丢组。
- `reorderTab` 的 `intoGroupId` 由 rail/overlay 依落点几何算出（拖到组头/两条同组行之间 → 该组 id；拖到无组间隙 → null），模型据此设/清成员并 normalize。
- `normalizeGroupState`：按 `groupOf` 聚合各组成员，按"组内成员当前相对序"在"该组最早成员位置"处重铺连续；丢空组；清指向不存在组的 groupId。**每个变更函数末尾必调**。

单测（Phase 1）：对每个 op 做 property test，断言输出恒满足 I1–I3；关键场景快照（建组/离组/跨组排序/解散/折叠渲染）。

---

## 5. 持久化与迁移

### 5.1 浏览器 `useBrowserTabs`（手写 localStorage）
- `BrowserTabsSnapshot` 加 `tabGroups: TabGroup[]`；`BrowserTab` 加 `groupId`。
- `sanitizeBrowserTab`（`:48-64`）补 `groupId` 透传；`sanitizeSnapshot`（`:66-87`）末尾调 `normalizeGroupState`（清孤儿组、修非法 groupId、强制连续）。
- **迁移**：加法式，**保留 key `ready-browser-tabs-v1`**——旧快照无 `tabGroups` → 默认 `[]`、无 `groupId` → undefined，`sanitizeSnapshot` 自然降级为"无组"。（备选：bump `-v2` 显式版本；本计划取加法式，向后兼容，旧版本 app 读新数据仅忽略 `tabGroups`。审查项 Q-P1。）

### 5.2 文档 `useDocTabs`（zustand persist）
- 加 `tabGroups` + `DocTab.groupId`。
- `version: 2 → 3`，`STORAGE_KEY` 保持 `ready-doc-tabs-v2`（persist 以 version 迁移，不必换 key）；`migrate`（`:446-465`）补 v2→v3：`tabGroups=[]`、tabs 加 `groupId:undefined`。
- `partialize`（`:419-432`）纳入 `tabGroups` 与 `tab.groupId`。
- `ensureTabsState`（`:157-170`）/ `onRehydrateStorage`（`:433-445`）末尾调 `normalizeGroupState`（rehydrate/migrate 时）。

**P1（审查确诊）——运行期 mutator 无 choke 点，必须补**：文档 store 各 mutator（`closeTab:298-328`、`reorderTabs:383-388`、`openTab:193-211`、`setActiveTab:330-332` 等）均走**裸 `set()`**，无 `sanitizeSnapshot` 等价物。只把 normalize 挂在 rehydrate 上，会漏掉运行期的"关组内最后一张标签 → 留孤儿组（违反 I3）直到重载"。
- **修法**：给文档 store 一个**每次变更的 normalize choke**——把至少 `closeTab`、`reorderTabs`（及任何改 `tabs`/`groupId` 的 mutator）经一个 `commit(next)` 尾部 `normalizeGroupState` 再 `set`；或所有组/标签变更走一个共享 reducer，尾部 normalize（镜像浏览器 store 的 sanitizeSnapshot 尾）。
- `closeTab` **必须**进 §12 **P1b** 工单清单（原漏列）。
- 行为红测：关"多成员组"的最后一张成员 → 无需重载即无孤儿组；关中间成员 → 组仍连续。

---

## 6. 所有 backend→renderer `setTabs` 路径改按 id 归并保组（本特性硬前提，含 P0）

> **审查确诊 P0**：`syncTabsFromBackend` 不是唯一的后端→渲染盲替换。浏览器 store 共有**三条** live `setTabs` 路径，只改一条会在"分屏切换/激活重挂载/重启"时抹掉分组。契约必须是**"每一条后端→渲染 setTabs 都保组"**，而非只改 `syncTabsFromBackend`。

### 6.0 三条 live 路径（已逐处核）
1. `syncTabsFromBackend`（`useBrowserTabActions.ts:47-63`）：`getTabs()`→字段枚举 hydratedTabs（**无 groupId**）→ `setTabs`。switch/new/close/navigate 触发。
2. `restoreExistingTabs`（`useBrowserRuntimeEffects.ts:101-118`）：**同款字段枚举盲替换**（`:101-115` 无 groupId → `:118 setTabs(hydratedTabs)`）。由 `ensureBrowserRuntime`（`:129`）在**挂载（`:294`）与模式激活（`:325`）**驱动。**触发面最广**：`WorkbenchMode.tsx:605-622` 分屏分支以 `mountedModes=[singleMode]` 重挂载 BrowserMode，而主进程 BrowserView 仍活 → `getTabs()` 非空 → `:118` 对已填充 store 盲替换 → groupId 全灭；再经 §5.1 的 I3 normalize 丢掉现已孤儿的 tabGroups → **整组丢失**。
3. `rebuildRuntimeFromPersistedTabs`（`useBrowserRuntimeEffects.ts:46-86`）：以 `{ ...tab }` 展开重建（`:49/:60-65`）→ `:75 setTabs(recoveredTabs)`。**它靠 `...tab` 展开"顺带"保住 groupId**，且主进程每次启动重生 tab id（`tabCounter=0`，`ipc-handler.ts:150`）→ **重启后分组存活完全依赖这条 `...tab` 重映射**。它是**一等的保组现场**，一旦被人重构成 `restoreExistingTabs` 那样的字段枚举，分组即在重启后消失。

### 6.1 权威划分契约（C-SYNC）
主进程权威于**成员集**（哪些标签存在）与**元数据**（title/url/favicon/loading/owner/activity）；渲染进程权威于**扁平序**与**分组**（order + groupId + tabGroups）。

### 6.2 统一 id 归并（三条路径共用一个 helper）
提取 `mergeBackendTabsPreservingGroups(local, backend)` 纯函数，三处（`useBrowserTabActions.ts:63`、`useBrowserRuntimeEffects.ts:118`、`:75`）全部改走它：
1. 取 `backend`（getTabs 或 recovered）、`local = useBrowserTabs.getState()`。
2. 对 `local` 中仍在 backend 的标签：**保留 local 位置与 groupId**，仅覆盖元数据。
3. backend 有而 local 无：追加末尾（Phase 4 改按 opener 插入），`groupId=null`。
4. local 有而 backend 无：删除；其 groupId 经 `normalizeGroupState` 清空组。
5. `setTabs(merged)` + `setActiveTabId(backend active)` + 末尾 `normalizeGroupState`。
   - `rebuildRuntimeFromPersistedTabs` 特例：backend 是"用**新 id** 重建的持久标签"，需按 `previousActiveTabId`/顺序把旧 groupId 映射到新 id（保留其现有 old→new 关联逻辑 `:56-70`，再喂归并）。

### 6.3 序一致性（C-ORDER）
渲染侧任何扁平序变更（排序 op 或 组连续性重铺）都经 `browser:reorderTabs(flatIds)` 写回主进程，使 `getTabs()` 序恒等于渲染扁平序 → 归并第 2 步"保留 local 序"与主进程序永不背离。组元数据（groupId/tabGroups）**不**过 IPC，主进程无感。（审查项 R-ORDER：确认 `ipc-handler.ts:2321 reorderTabs(tabIds)` 容忍全量重排且无副作用。）

### 6.4 gate 加强
`check-tabs-merge-preserves-groups`（§13 同名）必须断言**三条 backend→renderer 路径全部**保组（不能只测 `useBrowserTabActions.ts:63`），并加"新增 backend→renderer setTabs 现场必须走归并 helper"的 drift 断言（防第四条路径无声出现）。见 §13。

---

## 7. 渲染分段 + split-pair 决议 + 折叠态

- 分段以 **`tabs[]` 原始序** 经 `segmentIntoRuns` 产出 run 列表（组 run | 单标签）。渲染：组 run → 组头（色点+名+计数+折叠 caret）+ 缩进成员（左侧组色条）；折叠组 → 仅组头（成员计数）；单标签 → 如今样式。

### 7.1 显示连续性不变量 I-DISPLAY（≠ I1，审查纠正）
> **审查纠正（原 §7/§14 的 I1 措辞是错的）**：`getActiveTabPairOrder`（`active-tab-pair-order.ts:11-31`）是**纯投影**——构造新 `ordered` 数组、只读 `tabs`、从不写回 `tabs[]`；rail 的拖放喂的是 canonical `sourceIndex`（`VerticalTabRail.tsx:317/320`），故 pair-hoist **不可能破坏 I1**（I1 是 `tabs[]` 的属性）。真正会被破坏的是**显示序连续性**：把 secondary 提到 active 旁，会把一个外组标签**视觉插进另一组的渲染 run**。
> 定义 **I-DISPLAY**：pair-hoist 后的投影序里，每个组的成员仍构成一段连续 run。**红测断言 I-DISPLAY（对 `segmentIntoRuns`+hoist 的输出），不是 I1。** 原 §14 "破坏 I1"、原红测"跨组 split 不破坏 I1"作废。

### 7.2 D-SPLIT 决策（run 内提升）
`getActiveTabPairOrder` 的 secondary 提升**只在 primary 与 secondary 同 run 时**生效（同组，或二者皆无组各自单 run→不跨界）；跨组时**不物理搬运** secondary 越界，secondary 留其组内原位 + split 高亮。实现：`segmentIntoRuns` 之后、run 内再做 pair-hoist，不跨 run。

**三处 hoist 现场都要改（审查纠正 R-PAIR 的"两 rail"计数）**：`VerticalTabRail.tsx:79`（52px DOM 列表）、`VerticalTabRail.tsx:89`（**overlay 快照喂给独立窗口**——最易漏，见 §9 P1）、`DocumentVerticalTabRail.tsx:131`（文档 DOM+portal 浮层）。

### 7.3 折叠组 × active/split（审查补：原缺失且自相矛盾）
> 折叠组 §7 只渲染组头、隐藏成员行；但 D-SPLIT 说跨组 secondary "留原位显高亮"——**组折叠时成员行不存在，二者冲突**。且 `setGroupCollapsed` 是纯翻转、不重选 active，组又不碰 BrowserView 生命周期，§6 归并从 backend 取 active 不与折叠调和 → 会出现"active 的 BrowserView 在显示，但其标签图标藏在折叠组头里"。
- **决策 D-COLLAPSE**：**激活折叠组内的标签时自动展开该组**（对齐 Chrome/Edge）。即 active（或 split）落入折叠组 → 该组 `collapsed=false`。由此 active/split 的成员行必然可见，D-SPLIT 的"留原位显高亮"可满足，矛盾消解。
- 折叠组头承载 active 指示（当其成员含 active 但用户手动折叠的瞬态）：组头显 active 边（次要，D-COLLAPSE 已保证展开，此为兜底视觉）。
- 拖放到折叠组头 = `addToGroup`（§8 已定）；不向折叠组的隐藏成员间插入（无可见落点）。

---

## 8. 拖拽两意图（复用 file-tree 范式）

复用 `src/renderer/components/layout/file-tree/*` 已验证的两意图 + drag-session 范式：
- **落点几何**：`dragover` 时按指针在目标行的纵向比例——中段 ~50% → **onto**（文件夹式：目标行高亮/微放大）→ 松手 `createGroupFromDrop`（目标无组）或 `addToGroup`（目标有组）；上/下 ~25% → **between**（插入分隔线）→ `reorderTab`。
- 拖到**组头** → `addToGroup`；把**组内标签**拖到无组插入点 → `removeFromGroup`。
- **drag-session**：浏览器复用既有 `beginBrowserTabDragSession`/`getActiveBrowserTabDragPayload`（`browserTabDragSession.ts`，解决 `dragover` 期 `dataTransfer.getData` 被锁）；文档新增对称 `beginDocTabDragSession`（同范式）。
- **命令改 id 化（决策 D-CMD）**：现 `reorder{fromIndex,toIndex}` 在有组时下标语义歧义 → **全切** `{ movedTabId, toRank, intoGroupId }`、删 index 变体（§16 D-CMD）。`toRank` 恒为**扁平序**空间——按落点相邻标签的 tab id 在扁平快照数组中取下标解析（§9.0 D-SNAPSHOT），不取视觉行号。

---

## 9. 浏览器浮层（独立子窗口）组 UI + 乐观拖拽

因浮层是**独立渲染进程 + 只读快照**，一切变更 main-renderer 侧落地。

### 9.0 快照必须发扁平序（审查确诊 P1 的根，硬前提）
> **现状陷阱**：`buildSnapshot`（`VerticalTabRail.tsx:89`）用 `getActiveTabPairOrder(t,aId,sId).map(({ tab }) => …)` 组装 overlay tabs——即**全局 pair-hoist 后的显示序**，且只解构 `{ tab }`、**丢掉 sourceIndex**。协议里 `VerticalRailOverlayTab`（`browser-vertical-rail-overlay.ts:5-18`）**无扁平下标字段**。后果两条：
> - (a) overlay 拖拽算出的 `toRank` 是**显示空间**，而 `tab-group-model.reorderTab` 的 `toRank` 吃**扁平 `tabs[]` 空间**（§4）→ 分屏激活时落位/归属全错（例：显示 `[B,C,A,D]` 把 D 拖到显示 rank1 → 落到扁平 index1 → `[A,D,B,C]` 而非意图 `[A,B,D,C]`）。
> - (b) 当 active∈组A、split∈组B，全局 hoist 在**发快照前**就把 B 的标签塞进 A 的 run → overlay 按 groupId 分段看到 A/B 不连续（破坏 I-DISPLAY）。
>
> **修法（决策 D-SNAPSHOT）**：`buildSnapshot` **停用全局 `getActiveTabPairOrder`**，改发**原始扁平序** + 每标签 `{ split: boolean, groupId }`。overlay 渲染端可为显示做 run 内 pair-hoist/分段（§7.2）——**但这是纯视觉的**：`toRank` **不取视觉行号**，而是取"**落点相邻标签的 tab id 在扁平快照数组中的下标**"来解析（快照即扁平序，`snapshot.tabs.findIndex(id)` 即扁平 rank）。故即便 run 内 hoist 让同组的 active+split 视觉错位，`toRank` 仍落在扁平语义上无歧义地喂 `reorderTab`；命令 `{ movedTabId, toRank, intoGroupId }`。配红测：分屏激活（active 与 split 同组）+ overlay 拖拽排序落到意图扁平位/组。

### 9.1 协议扩展 `browser-vertical-rail-overlay.ts`
- `VerticalRailOverlaySnapshot` 加 `groups: TabGroup[]`；`VerticalRailOverlayTab` 加 `groupId?: string|null`（tabs 数组即**扁平序**，见 D-SNAPSHOT；无需再塞 sourceIndex，因为扁平序下 index 即 rank）。
- `VerticalRailOverlayCommand` 加：`reorder{movedTabId,toRank,intoGroupId}`、`create-group{draggedTabId,targetTabId}`、`add-to-group{tabId,groupId}`、`remove-from-group{tabId}`、`rename-group{groupId,name}`、`recolor-group{groupId,color}`、`set-group-collapsed{groupId,collapsed}`、`disband-group{groupId}`、`delete-group{groupId}`、`new-tab-in-group{groupId}`。
  - **旧 `reorder{fromIndex,toIndex}`（`:41`）连同其处理器（`VerticalTabRail.tsx:189-192`）一并切到 id 化变体**（D-CMD 定为全切、删 index 变体；同步改图标条 `onReorder`）。

### 9.2 浮层渲染
`VerticalRailOverlayWindow.tsx` 按 snapshot（扁平序）先 run 内 pair-hoist（§7.2）再按 groups+groupId 分段渲染组头/成员/折叠；组头点选/右键弹**组编辑弹层**（§11，渲染在本浮层子窗口内，文本输入在真实子窗口可用——见 R-OVERLAY-INPUT）。

### 9.3 乐观拖拽
拖拽期在浮层**本地 React state** 维护 order/组预览（分隔线/文件夹高亮），**松手才** `send(commit command)`；source of truth 仍是 main-renderer store，下一帧 snapshot 回灌校正。拖拽进行中置 `dragging` 标志**抑制 hover-close**（扩展 `VerticalTabRail` railHovered/overlayHovered 仲裁：dragging 时 `scheduleClose` 短路）。

### 9.4 命令落地
`VerticalTabRail` 命令 switch（`:166-215`）加各组命令分支 → 调 `useBrowserTabs` 方法 → `pushSnapshot`。
- **纯 id 层组命令**（reorder/create-group/add/remove/rename/recolor/collapse/disband）委托 `tab-group-model`。
- **异步改标签集的组命令另立 store 层编排，不经纯模型**（纯模型 electron-free 不能建/关标签）：`delete-group`→§11 删组编排；`new-tab-in-group`→§11 建标签编排。**纠正原"所有组命令委托 tab-group-model"的笼统说法。**

### 9.5 单一源声明（C-OVERLAY）
浮层无本地权威；乐观态仅拖拽预览，被下一 snapshot 覆盖。

---

## 10. 文档浮层（同窗口 DOM）组 UI

文档侧简单（同窗口、拖拽已接）：
- `DocumentVerticalTabItem` 加 `groupId?`; `DocumentVerticalTabRail` 加 `groups: TabGroup[]` prop；`DocumentMode.tsx:906-919` 投影补 `groupId`、传 `groups={tabGroups}`。
- rail 图标条 + portal 浮层均按 `segmentIntoRuns` 渲染组头/成员/折叠；两意图拖拽扩展现有 `onTabDragOver/Drop`（落点几何 + intoGroupId），组 op 直连 `useDocTabs`（同窗口，无 IPC）。
- 组编辑弹层以 portal 就近组头渲染。

---

## 11. 组编辑弹层 + 生命周期编排（对齐 reference 图 3，收敛到最小集）

触发：点组头 / 组头右键。内容：
- 名称输入（inline `renameGroup`）。
- 颜色 swatch 行（`recolorGroup`，闭集 `TabGroupColor` → `--color-*`）。
- 动作：**组内新建标签**（`new-tab-in-group`）、**取消群组**（`disbandGroup`，保留标签）、**关闭群组标签**（delete：关成员标签 + 删组）。
- **离组**经拖出（§8），不入菜单。
- **不做**：移动到新视窗 / 移至新工作区（reference 图 3 灰项，非目标）。

### 11.1 异步/改标签集编排（审查补：原缺失，且属 store 层非纯模型）
> 这两个动作会**建/关标签**，纯模型（electron-free）承担不了，必须 store 层显式编排。

**delete-group（关组标签）**——原子 store op：
1. 取组成员集 `M`、剩余集 `R = tabs \ M`。
2. **never-empty 不变量**：若 `R` 为空（删的是"全部标签所在的组"），**先建一张空白替补标签**再关 `M`（复用 `handleCloseTab` 的 last-tab 替补路径：`useBrowserTabActions.ts:138-162` 建 `DEFAULT_BROWSER_URL` 标签），**不得**裸循环 `browser:closeTab`——后端 `closeTab`（`tab-shell-service.ts:186-188`）无 last-tab 替补，裸循环会落到 0 标签 / active=null，破坏"浏览器永不空"。
3. active 落在 `M` 内时无需手工兜底：后端 `closeTab` 确定性重选 active（`:178-185`），归并（§6）从 backend 取 active。（审查已证伪"active 未定义"与"需 required 守卫"两条：required 标签当前即可关，`VerticalTabRail.tsx:362` 仅装饰锁。）
4. 删组（`disbandGroup`/直接丢组）+ `normalizeGroupState`。

**new-tab-in-group**——store op：
1. `createTab(DEFAULT_BROWSER_URL, { background: true })`（后台建，不抢前台；与 Phase 0 语义一致）。
2. 该新标签 `setGroupId(groupId)` + 移入该组 run 尾（`addToGroup`）。
3. 经 `browser:reorderTabs(flatIds)` 写回主进程扁平序（C-ORDER）。
4. `normalizeGroupState`。
5. 激活策略：**默认后台**（不切前台）；若产品要"新建即聚焦"再显式 `switchTab`（本期默认后台，避免与折叠/分屏交互复杂化）。

---

## 12. 分阶段

| 阶段 | 交付 | 验证 |
| --- | --- | --- |
| **P0（前置）** | 「在新标签页打开」后台修复（独立文档） | 见 Phase 0 文档 |
| **P1a 写路径审计（前置，见 §12.0）** | 枚举并证明两 store **每一条** `setTabs()`/`set()` 现场保组/normalize | 审计清单 + gate 覆盖三条浏览器 setTabs + 文档 closeTab |
| **P1b 模型+存储** | `tab-groups.ts` + `tab-group-model.ts`（纯+单测）；两 store 加 tabGroups/groupId/组方法/持久化迁移；**三条** backend→renderer setTabs 全走归并 helper（§6）；文档 store 补 per-mutation normalize choke（§5.2，含 `closeTab`）。**无 UI** | 模型 property 测（I1–I3）；三路径归并保组行为测；分屏切换重挂载不丢组；关最后成员不留孤儿；迁移往返测 |
| **P2 文档 UI** | 文档条/浮层组渲染+两意图拖拽+编辑弹层+折叠(D-COLLAPSE)+图标条归属条 | 真机文档模式建组/排序/离组/解散/删除；行为测 |
| **P3 浏览器 UI** | 浮层协议扩展（含 D-SNAPSHOT 扁平序）；浮层组渲染+乐观拖拽+commit；命令 id 化落地；52px 条归属条；编辑弹层；delete/new-tab-in-group 编排（§11.1） | 真机浏览器模式全流程；协议 drift gate；分屏激活+浮层拖拽落位正确；hover-close-during-drag 回归；删全标签组不落 0 标签 |
| **P4 opener 继承** | `buildTabPayload`/emit 加 `openerTabId`；新标签插到 opener 后 + 继承其组 | 依赖 P0 推送；行为测：组内链接后台开→进同组、紧邻 opener |

### 12.0 P1a 写路径审计（硬前置，审查 meta-pattern）
> **审查 meta-pattern**：P0 与"关标签留孤儿组"是同一类 bug——文档信任**单一 choke**，但每个真实 store 有**多条写路径**。开工 P1b 前**必须**审计并逐条证明：
> - 浏览器 **backend→renderer**（**须走归并 helper**，组丢失风险所在）：`useBrowserTabActions.ts:63`、`useBrowserRuntimeEffects.ts:118`、`:75` 三条 `setTabs`。
> - 浏览器 **renderer-local**（**免归并**但须记入 gate allowlist 防误报）：`useBrowserTabActions.ts:177 setTabs(remaining)`（`currentTabs.filter` 天然保 groupId）、`:155 setTabs([replacementTab])`（全新默认标签、无组）、`useBrowserRuntimeEffects.ts:95 setTabs([])`（空态拆卸、vacuous）。
> - 文档：`closeTab:298-328`、`reorderTabs:383-388`、`openTab`、`setActiveTab` 每条改 `tabs`/`groupId` 的裸 `set()` 都过 normalize。
> 审计结论转成 §13 的 drift gate（"新增 **backend→renderer** setTabs 现场必须走归并 helper；renderer-local 三处 `:95/:155/:177` 记 allowlist"），否则 gate 会 green 而 bug 照发。

每单 ≤约 300 行 diff、先红测→实现→聚焦验证→typecheck、单独 commit、不顺手重构（沿用仓库工单纪律）。

---

## 13. 可机器验证合同（gate）

> **审查警告**：原 gate 集**给假保证**——只测单一现场而真实缺陷在多现场涌现。以下已按审查加强，且**必须与修复同批交付**（否则 gate green 而 bug 照发）。

拟新增（`scripts/check-*.cjs` + `scripts/__tests__/*.test.cjs`，挂 `verify:tab-groups` 复合，仿 `verify:browser-lane`）：
- `check-tab-group-contiguity-invariant`：对 `tab-group-model` 全 op property 断言 I1–I3；**并**对**两 store 的 `closeTab`/`removeTab`（删 `tabs[]` 成员的路径）**断言不留孤儿组（原 gate 只测纯模型，漏 store 侧因移除成员而涌现的孤儿——本条补齐）。
- `check-tab-group-display-contiguity`：对 `segmentIntoRuns`+run 内 pair-hoist 的**投影输出**断言 I-DISPLAY（§7.1；**不是** I1；替换原"跨组 split 不破坏 I1"的作废红测）。
- `check-tabs-merge-preserves-groups`：断言**三条** backend→renderer setTabs 现场（`useBrowserTabActions.ts:63`、`useBrowserRuntimeEffects.ts:118`、`:75`）**全部**保组；并 drift 断言"新增 backend→renderer setTabs 现场必须走归并 helper"（renderer-local 三处 `:95/:155/:177` 入 allowlist；原只测一条 → 假 green）。
- `check-tab-group-model-single-source`：两 store 的 groupId/tabGroups **直接**变更必经 `tab-group-model`；补充："删 `tabs[]` 成员的 mutator 必须尾接 normalize"（原 gate 只抓直接 groupId 写，抓不到成员移除涌现的孤儿）。
- `check-overlay-command-group-parity`：每个 `VerticalRailOverlayCommand` 组变体在 main-renderer 命令 switch 有 handler（drift gate，仿既有 `check-*-single-source`）。
- `check-overlay-snapshot-flat-order`（可选结构 gate）：断言 `buildSnapshot`（`VerticalTabRail.tsx:89`）不再对喂 overlay 的 tabs 施加全局 `getActiveTabPairOrder`（守 D-SNAPSHOT，防回退到显示序快照）。

---

## 14. 风险登记

| 风险 | 级别 | 说明 | 缓解 |
| --- | --- | --- | --- |
| 归并抹组（多路径） | **P0** | 三条 backend→renderer setTabs 只改一条；`restoreExistingTabs:118` 在分屏切换/激活重挂载时盲替换抹 groupId，再经 I3 normalize 丢 tabGroups | §6 三路径共用归并 helper + §12.0 写路径审计 + §13 三路径 gate |
| 文档 store 无 choke | **P1** | 各 mutator 裸 `set()`；关组内最后成员留孤儿组直到重载 | §5.2 per-mutation normalize choke（含 `closeTab`）+ §13 gate |
| overlay 显示序≠扁平序 | **P1** | `buildSnapshot:89` 发全局 hoist 显示序、丢 sourceIndex → toRank 空间错位 + 跨组 split 破坏 I-DISPLAY | §9.0 D-SNAPSHOT：发扁平序 + split 标志，overlay 端 run 内 hoist；红测 |
| split×组显示连续性 | P2 | 跨组提升 secondary 破坏 **I-DISPLAY**（非 I1；原措辞已纠正，§7.1） | §7.2 pair-hoist 限 run 内 + `check-tab-group-display-contiguity` |
| 折叠组含 active/split | P2 | 折叠隐藏成员行 vs D-SPLIT"留原位显高亮"自相矛盾；active 图标藏进折叠头 | §7.3 D-COLLAPSE：激活即自动展开 |
| 删全标签组落 0 标签 | P2 | 裸循环 `browser:closeTab` 无 last-tab 替补 → 破坏"永不空" | §11.1 先建替补再关（复用 handleCloseTab 替补路径） |
| new-tab-in-group 无编排 | P2 | 纯模型建不了标签；§9 笼统"委托模型"对此为假 | §11.1 store 层编排 create→setGroupId→move→writeback；§9.4 carve-out |
| addTab 无去重 | P2 | Phase 4 opener 推送 + 本地 add 双加 | 复用 Phase 0 结论：emit 仅主进程自发路径；`onTabOpened` 已 existing→update；插入位改造补 id 去重断言 |
| 浮层 hover 自关打断拖拽 | P2 | 拖拽中指针离浮层触发 scheduleClose | §9.3 dragging 抑制关闭 |
| reorderTabs 主进程副作用 | P2 | 组连续性重铺写回全量序 | R-ORDER 审查 `ipc-handler.ts:2321` 语义 |
| 迁移降级丢组 | P2 | 旧版本 app 写回抹 tabGroups | 加法式可接受；文档标注；Q-P1 |
| BrowserView 硬约束 | P2 | 纯 DOM 覆盖层不能盖原生 BrowserView（CLAUDE.md §2） | 浏览器组 UI 全在既有浮层子窗口内，不新增 DOM-over-BrowserView；折叠条归属色**不得**在 BrowserView band 用 backdrop-filter（`VerticalTabRail.tsx:291-293` 教训） |

---

## 15. 测试计划（行为优先）

- **P1b**：`tab-group-model` property + 快照单测；两 store 组方法行为测（建组/离组/排序/解散/删除后 I1–I3）；浏览器三路径归并保组行为测；两 store 迁移往返测。
- **P2**：文档模式真机四流程 + 组件行为测（拖拽两意图产出正确 op、编辑弹层动作、折叠渲染）。
- **P3**：浏览器模式真机全流程；协议 parity gate；拖拽中不自关；乐观态被 snapshot 校正。
- **P4**：组内链接后台开→进同组紧邻 opener 行为测（依赖 P0）。
- 全程 `npm run typecheck` 绿；涉持久化跑 `npm run verify:native` 惯例项。

---

## 16. 决策与开放问题

### 已定（经对抗性审查落定，非开放）
- **D-CMD（原 Q-CMD）**：命令**全切 id 化**（`{movedTabId,toRank,intoGroupId}`），删 index 变体；同步改 `VerticalTabRail` 现有 reorder 命令处理（`:189-192`）与图标条 `onReorder`。
- **D-SNAPSHOT（原 R-PAIR，已升为硬交付）**：`buildSnapshot`（`VerticalTabRail.tsx:89`）发扁平序 + split 标志 + groupId，overlay 端 run 内 hoist；**三处** hoist 现场（`:79`/`:89`/`DocumentVerticalTabRail.tsx:131`）统一（§7.2/§9.0）。不再是开放项。
- **D-COLLAPSE**：激活折叠组内标签即自动展开（§7.3）。
- **D-SPLIT**：pair-hoist 限 run 内，断言 **I-DISPLAY**（§7.1/§7.2）。

### 仍开放（供白/施工时定）
- **Q-P1（持久化版本）**：浏览器 store 加法式保 v1 vs bump v2。倾向加法式。
- **Q-COLLAPSE（图标条归属可视）**：52px 条如何示组——组色左缘条跨该组图标 + 折叠组显单色计数 chip（倾向），须符合无 backdrop-filter 约束与 vibrancy 教训。
- **R-ORDER**：`ipc-handler.ts:2321 reorderTabs` 全量重排语义/副作用复核（施工期真机+读源确认）。
- **R-OVERLAY-INPUT**：组编辑弹层文本输入在独立子窗口的聚焦/输入法（IME）行为真机确认。
