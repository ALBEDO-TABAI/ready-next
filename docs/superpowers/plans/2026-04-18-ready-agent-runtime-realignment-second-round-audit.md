# Ready Agent Runtime Realignment — Codex 第二轮整改后剩余缺口审核

> 审核日期: 2026-04-18
> 审核对象: codex 在 `2026-04-17-ready-agent-runtime-realignment-audit.md` 之后做的整改成果（commits `4af7ed1 / badf70d / 803b8b6 / 6acc292 / b585c24 / 4bf20fc / d9ae71e / c33a4ff / edaff4b / aa11baf` 等）
> 关联文档: `2026-04-17-ready-agent-runtime-realignment-audit.md`（第一轮审核）、`2026-04-17-ready-agent-runtime-realignment-info-card-gap-trace.md`
>
> 方法: 直接 Read 实际文件 + 跨文件 grep 验证两个调查 agent 的论断, 不轻信摘要. 所有结论附 `file:line` 锚点.

---

## 1. 总评

第一轮审核里被点名的"形式完成"问题, codex 已经把**最显眼的搬迁线**真的搬出去了:

- `direct-chat.ts` 从 **2871 行 → 1401 行**, 1600 行 document pipeline 已迁到新文件 `document-task-pipeline-executor.ts (1641 行)`, **第一轮 §3.1 的核心目标已达成**. 但行数仍超出原审核 ≤1200 的逃逸阀值约 200 行 (主要是 continuation/section parsing helpers 还留在壳里, 以及 `buildTurnEngineHost` 较大).
- `subtask-runtime.ts` 的 `runScopedTurn` 死码已删掉. `subtask-runtime-contract.test.ts:241` 现在断言 `'runScopedTurn' in runtime === false`. **§3.7 完成**.
- `run-projection.ts` 从 **246 行 → 119 行**, 老 regex `[计划] / [阶段] / Execution ID:` 全部消失, 现在只剩 `readProjectionTruthPatch` + 直接拷贝 patch 字段. **§3.5 主体完成**.
- `tool-definition.ts` 已添加 `supportsTextBridge / projectionHint / description / schema / resultShape` 五个字段. **§3.3 字段层完成**.
- 四个空壳 adapter (`skill / rss / calendar / feishu`) 都从 32 行扩到 130-140 行, 各自带上 `domainState` + `applyResult` 聚合. **§3.4 形式上完成**.
- 信息卡更新链路: classifier 已能返回 `'document_read_then_widget_update'`, pipeline 带 `operation: 'create' | 'update'`, executor 在 `update_existing` 时会调用 `document.updateWidget`. **§4 主链路已闭合**.

但**有 7 个真问题留下来**, 其中 **2 个是新引入的隐患**, **3 个是只做了一半的迁移**, **2 个是"形式上完成但语义错"**. 详见第 3 节.

最危险的两个:

1. **三个空壳 adapter (RSS/Calendar/Feishu) 把"工具批次执行成功"硬等同于"任务 done"** —— 多步任务从此会被提前标记完成. 而且这套行为已经被 `domain-adapter-contract.test.ts:546-552` 的契约测试**冻结**, 改回去要先改测试. (§3.1)
2. **Phase 6 的 `continuationIntent` IPC 改造没有合入当前分支** —— `399031e phase6: route continuation via structured intent` 只在 `codex/phase6-continuation-intent` 分支, 当前 `codex/document-widget-pipeline-cache` 分支的 `parseContinuationControlText` 仍是 regex 文本协议. (§3.2)

---

## 2. 七阶段第二轮对照表

| 阶段 | 第一轮状态 | 第二轮状态 | 评分 |
|---|---|---|---|
| 0 — Contract baseline | ⚠️ 部分 (假红 / 字符串 grep) | ⚠️ 改进了一半: `domain-adapter-contract.test.ts` 已经是真行为测试; 但 `document-task-pipeline-host-contract.test.ts` / `document-insight-cache-host-contract.test.ts` 仍是字符串 grep, 而且把"实例化方式 + 字段名"也写死, 重命名一次就红 | ⚠️ 部分 |
| 1 — Tool definition & registry | ⚠️ 缺 `supportsTextBridge / projectionHint / description / schema / resultShape (可用)` | ⚠️ 字段已加, 但 `PROJECTION_PATCH_TOOL_DOMAINS` 只装了 `['skill']`; document mutating 工具仍是 `'text'`, 没拿到 `emitsProjectionPatch` 标记 | ⚠️ 部分 |
| 2 — Tool runtime extraction | ✅ 基本完成 (cleanup 双层) | ✅ 维持. cleanup 仍是双层 (`drainRunCleanup` 兜底), 但这是已知边界 | ✅ 基本完成 |
| 3 — DirectChat 缩壳 | ⚠️ 1600 行没搬 | ✅ 已搬到 executor; 但壳仍是 1401 行, 超过 ≤1200 逃逸阀值; 且 contract test 没锁住 `runDocumentTaskPlan / executeDocumentTaskPlanJob` 等"非 shortcut"名字, 防回退能力不足 | ✅ 主体完成 |
| 4 — Domain adapter 合同 | ⚠️ 半完成, 三空壳 + skill 没归口 | ⚠️ 形式齐了, **但 RSS/Calendar/Feishu 的状态机错了** (单批工具 == done, 见 §3.1); skill 已正确; 四个 adapter 的 `dispatch()` 全部是空 `{ domainState: params.domainState }` | ⚠️ 形式完成但语义错 |
| 5 — Projection 翻译层 | ⚠️ regex 兜底未清 | ✅ main 端清干净了 (`run-projection.ts` 119 行, 无 regex); **但 renderer `scopeRunState.ts:643-648` 仍在用 `parseStructuredToolPayload` 自己解析 toolEvent.text, 与 main 双写真相** | ⚠️ 双写真相未消解 |
| 6 — Continuation state | ⚠️ 仍是字符串协议 | ❌ **当前分支零进展**. 修复在分支 `codex/phase6-continuation-intent` (commit `399031e`) 上, 没合并. `continuation-state.ts:144-205` 仍是 `^Task ID: / ^Execution ID: / ^Step ID: / ^继续前上下文：/ ^我的回复：` 五条 regex | ❌ 当前分支无进展 |
| 7 — Subtask / worker runtime | ❌ 死码 + 硬编码空串 | ✅ 死码已删, contract test 已断言 | ✅ 完成 |

---

## 3. 仍未闭合 / 改坏 / 新引入的隐患 (按风险排序)

### 3.1 [改坏 · 高] RSS/Calendar/Feishu adapter 把"一次工具批次"硬等同"任务 done"

**位置**:
- `src/main/modules/agent-control/rss-domain-adapter.ts:95-106`
- `src/main/modules/agent-control/calendar-domain-adapter.ts:88-99`
- `src/main/modules/agent-control/feishu-domain-adapter.ts:90-101`

**症状**: 三个 adapter 的 `applyResult` 在 `phase === 'tool_batch'` 时, 只要至少一个 domain 工具被执行, 就直接 return:

```typescript
return {
  domainState: nextState,
  projection: {
    phase: 'done',                 // ← 永远 done
    summary: nextState.taskSummary || 'RSS 任务已执行',
    waitingFor: 'none',
    resumableActions: ['cancel'],
    blockedReason: null,
  },
}
```

**为什么是真问题**: 一个"读 5 条 RSS → 摘要 → 写飞书"的多步任务, 第一次 `rss_fetch_updates` 返回后 adapter 立即把任务标 `done`, 后续步骤无论成功失败都不会推进 projection. UI 会显示"已完成", 但实际任务还在跑.

**为什么很难回退**: `domain-adapter-contract.test.ts:546-552` 已经把这个行为冻结成契约:

```typescript
assert.equal((patch?.steps as Array<{ id: string; status: string }>)[0]?.status, 'done')
```

任何修复都要同时改 3 个 adapter + 这条契约测试. 时间越久, 跨链路依赖越多, 改起来越难.

**根因**: codex 把"adapter 要能输出 projection patch"当成"adapter 要在每次工具批次后都 finalize". 真正的设计应该是: 工具批次结果 → 累积到 `domainState.steps` → **由更高层 (TurnEngine 或 RunCoordinator) 决定何时 finalize**.

**修复方向**:
1. `applyResult(phase: 'tool_batch')` 不再返回 `projection.phase === 'done'`, 改为 `'running'` 或不返回 projection (只更新 domainState).
2. 在 `phase === 'no_tool_call'` (LLM 主动收尾) 或 `phase === 'budget_limit'` (达到预算) 时才 finalize.
3. 同步改 `domain-adapter-contract.test.ts:471-554`: 多步场景下 `steps[0].status === 'done'` 但 `currentStepId === toolName` 且 projection 仍可继续.

---

### 3.2 [仍未闭合 · 高] Phase 6 continuationIntent IPC 整改没合入当前分支

**位置**:
- `src/main/modules/agent-control/continuation-state.ts:144-205` (当前分支仍是 regex)
- 改造提交 `399031e phase6: route continuation via structured intent` 只在 `codex/phase6-continuation-intent`

**症状**:
```typescript
const taskIdMatch = trimmed.match(/^Task ID:\s*(.+)$/i)        // L157
const executionIdMatch = trimmed.match(/^Execution ID:\s*(.+)$/i)  // L163
const stepIdMatch = trimmed.match(/^Step ID:\s*(.+)$/i)          // L169
const blockedReasonMatch = trimmed.match(/^继续前上下文[:：]\s*(.+)$/) // L175
const responseTextMatch = trimmed.match(/^我的回复[:：]\s*(.+)$/)    // L181
```

`grep continuationIntent src/` 在当前分支只有 1 个 hit (`browser-task-planner.ts:490`, 是个 boolean flag, 与续跑协议无关).

**影响**: 第一轮 §3.6 列的所有问题在当前分支原样存在. UI 改文案 ("Step ID:" → "步骤 ID：") 或 i18n 切换会立刻断链.

**修复方向**:
- 把 `codex/phase6-continuation-intent` 分支合并进 `codex/document-widget-pipeline-cache`, 或在当前分支重做.
- 合入后 `parseContinuationControlText` 应只作为兜底, 主路径走结构化 IPC payload.

---

### 3.3 [改坏 · 中] 四个 phase4 adapter 的 `dispatch()` 全部是占位空实现

**位置**:
- `skill-domain-adapter.ts:83-85`
- `rss-domain-adapter.ts:68-70`
- `calendar-domain-adapter.ts:61-63`
- `feishu-domain-adapter.ts:63-65`

```typescript
dispatch(params: Parameters<DomainAdapter['dispatch']>[0]): ReturnType<DomainAdapter['dispatch']> {
  return { domainState: params.domainState }
}
```

**为什么是隐患**: 第一轮 §3.4 要求"统一 `prepare/dispatch/applyResult/buildProjectionPatch` 状态归属". 现在 dispatch 成了形式占位:
- 编译过、契约通过 (`domain-adapter-contract.test.ts:73` 只断言 `typeof adapter.dispatch === 'function'`)
- 但任何执行前的 domain-local 初始化都没地方落 (例如 skill 执行前清 `currentStepId`, RSS 执行前确认 source 是否还在); 未来想做"执行前预检查"会被迫开新方法.

**对比**: `BrowserDomainAdapter.dispatch` (browser-domain-adapter.ts) 和 `DocumentDomainAdapter.dispatch` (document-domain-adapter.ts:150-166) 都有真实派发逻辑, 包括截获 widget pipeline. 三个 channel adapter 的 dispatch 应该至少:
- 把"本轮没真的有 domain 工具被允许调用"识别成早返回 (避免 LLM 在没工具的情况下走 free loop).
- 在 dispatch 阶段就计入"准备时刻"到 domainState, 后面 applyResult 才能算 step 时长.

---

### 3.4 [仍未闭合 · 中] document mutating 工具的 `resultShape` / `projectionHint` 没真正用上

**位置**:
- `src/main/modules/agent-control/tool-registry.ts:148`
- `src/main/modules/agent-control/tool-registry.ts:362-374`
- `src/main/modules/agent-control/tool-registry.ts:377-382`

**症状**:
```typescript
const PROJECTION_PATCH_TOOL_DOMAINS = new Set<ToolDomain>(['skill'])  // L148

function resolveToolProjectionHint(toolName, domain, kind) {
  const hint: ToolProjectionHint = {}
  if (kind === 'write') hint.mutating = true
  if (PROJECTION_PATCH_TOOL_DOMAINS.has(domain) && toolName.startsWith('skill_')) {
    hint.emitsProjectionPatch = true   // ← 只有 skill_ 工具能拿到
  }
  return Object.keys(hint).length > 0 ? hint : null
}

function resolveToolResultShape(toolName, domain) {
  if (PROJECTION_PATCH_TOOL_DOMAINS.has(domain) && toolName.startsWith('skill_')) {
    return 'projection_patch'
  }
  return 'text'   // ← document_insert_widget / document_update_widget 都被打成 text
}
```

**为什么是问题**: 第一轮 §3.3 明确要求"document 类 mutating 工具 (`document.insertWidget / updateWidget / removeWidget / saveTab`) 设置 `resultShape: 'projection_patch'`, `projectionHint: { bumpsStepBudget: true, mutating: true }`, 然后 `TaskProjectionSync / RunProjection` 基于 `projectionHint` 决定是否推进 step". 现在 codex 只对 skill 域做了这件事, document 域被遗漏 —— 字段加了, 但 document 的 step 推进仍没接到 projection 直连通路.

`document-domain-adapter.ts` 是通过 `documentToolLoopOrchestrator` 自己推断 step, 而不是消费工具的 `resultShape: 'projection_patch'`. 等于 Phase 1 的字段对 document 域是空字段.

**修复方向**:
1. `PROJECTION_PATCH_TOOL_DOMAINS` 增加 `'document'`.
2. `resolveToolResultShape` 改为按工具名白名单 (`document_insert_widget / document_update_widget / document_remove_widget / document_save_tab`), 而不是简单 `startsWith('skill_')`.
3. `resolveToolProjectionHint` 同步给上述 4 个工具 `emitsProjectionPatch: true`.

---

### 3.5 [改坏 · 中] direct-chat 仍持有"看似活实际死"的 session 缓存字段

**位置**:
- `src/main/modules/claude-bridge/direct-chat.ts:155-174` (定义)
- `src/main/modules/claude-bridge/direct-chat.ts:623-624` (初始化)
- `src/main/modules/agent-control/document-task-pipeline-executor.ts:1325, 1367, 1382, 1407` (executor 反过来读)

**症状**: direct-chat 在 `DirectChatSession` 上保留了:
```typescript
documentInsightCache: Array<{ key, insight, metrics?, createdAt }>
documentWidgetDraftCache: Array<{ key, draft, createdAt }>
```

这两个字段**确实有人读** —— `document-task-pipeline-executor.ts` 反过来从 session 上读写它们 (executor 接 session 引用, 把 session 当 per-conversation cache 用).

**为什么是问题**: 这是一个"反向依赖". 缩壳的目标是 direct-chat → executor 单向调用; 现在 executor 又回头读 direct-chat 创建的 session 字段. 两层耦合:
1. session 字段 schema 由 direct-chat 定义, 但语义由 executor 决定. 改一边必须改另一边.
2. 没有任何地方负责淘汰 session 缓存 —— `direct-chat.ts:623-624` 初始化为 `[]`, 后续只 append (executor:1367-1370), 直到 session 被销毁前都在涨.

**修复方向**: executor 应该独立持有 per-session cache (它已经有全局 LRU `documentInsightCache = new DocumentInsightCache()`, 再加一层 `Map<sessionId, ...>` 即可), 直接删 direct-chat session 上的两个字段.

**为什么 contract test 没拦住**: `document-insight-cache-host-contract.test.ts:17-22` 只检查 "`new DocumentInsightCache()` 不出现在 direct-chat", 不查 `documentInsightCache:` 数组字段是否存在. 仍是字符串 grep 的"看到形似就过".

---

### 3.6 [仍未闭合 · 中] renderer `scopeRunState.ts` 仍在双写"任务真相"

**位置**: `src/renderer/modules/agent/scopeRunState.ts:27-37, 643-648`

```typescript
function parseStructuredToolPayload(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
  } catch {}
  return null
}

// 643-648:
const structuredPayload =
  event.toolEvent?.kind === 'result' && event.toolEvent.text
    ? parseStructuredToolPayload(event.toolEvent.text)
    : event.latestText
      ? parseStructuredToolPayload(event.latestText)
      : null
```

后续 ~150 行 (L649-808) 从这个 payload 里抠 `module / intent / artifactRefs / memoryRefs / triggerHits / contextBudget / designPhase / styleSystem / ...`, **完全独立于** 主进程的 projection 通路.

**为什么是问题**: 第一轮 §3.10 已点出"前端仍然保留一套 browser/skill 文本兜底". 现在 main 端清干净了 (run-projection.ts 119 行, 无 regex), 但 renderer 仍在自己 parse 工具结果文本 (虽然用 JSON.parse 而非 regex, 协议不同, 但**真相来源仍然是双份**). 主进程的 `RunProjectionPatch` 走 IPC 到达 renderer 后, renderer 还会再 parse 一次 toolEvent.text, 两份解释发生分歧时谁赢未定义.

**修复方向**: renderer 直接消费 `taskProjection.steps / currentStepId / waitingFor / ...`, 不再自己 parse toolEvent 文本. `parseStructuredToolPayload` 这条线可以删, 或者降级成"老 main 进程的兜底分支".

---

### 3.7 [仍未闭合 · 低] Pipeline phase 枚举没新增 `locating_target_widget / updating_widget`

**位置**:
- `src/main/modules/agent-control/document-task-pipeline.ts:4-11` (枚举)
- `src/main/modules/agent-control/document-task-pipeline-executor.ts:672-690` (writeDocumentWidget)

**症状**: 第一轮 §4 的最小修复方案要求新增 `locating_target_widget → updating_widget` 两个 phase, 让用户在 UI 上能看到"我正在找你的旧卡片". codex 实际做法:

- `DocumentWidgetPipelinePhase` 仍然是: `loading_document → building_insight → generating_widget_spec → writing_widget → saving_document`
- 在 `writing_widget` 这一个 phase 里, executor 调一次 `document_list_widgets` + 一次 `document_update_widget` (executor.ts:678-689)
- 用户 UI 看到的 phase summary 还是 `'正在写入信息卡'` 或 `'正在定位并更新现有信息卡'` (pipeline.ts:468) —— 文案区分了, 但 phase 没区分.

**为什么仍是问题**: phase 是 UI 阶段化卡片的真相来源. 现在 `update` 操作仍只占一个 phase 槽, 如果 list 很慢、update 很慢, 用户只看到一个长时间的 `writing_widget` 不知道卡在哪一步. 与原审核期望的"用户能区分 locating 和 updating"目标只差一个 enum 拆分.

**修复方向**: 拆 `writing_widget` 为 `locating_target_widget` (仅 update 模式) + `writing_widget` (insert) / `updating_widget` (update). pipeline.ts:466-479 对应的 `runPhase` 调用拆成两段.

---

### 3.8 [仍未闭合 · 低] EXISTING_WIDGET_NON_CREATE_PATTERNS 仍把 delete/inspect 显式排除

**位置**: `src/main/modules/agent-control/document-task-types.ts:30-45`

```typescript
const EXISTING_WIDGET_NON_CREATE_PATTERNS = [
  /(查看|列出|看看).*(widget|卡片)/i,
  /(删除|删掉|移除).*(widget|卡片)/i,
] as const

// L43-45:
if (EXISTING_WIDGET_NON_CREATE_PATTERNS.some((pattern) => pattern.test(text))) {
  return null   // ← 仍然排除
}
```

**症状**: codex 加了 `'document_read_then_widget_update'` 来覆盖"修改"语义, 但**"删除/查看"仍然返回 null 走通用 free tool loop**. 第一轮审核的最小修复明确写了:

> `classifyStructuredDocumentIntent` 新增返回值 `'document_list_then_widget_update' | 'document_remove_widget'`, 不再把 update/remove 类请求打成 `null`.

**修复方向**: 拆出 `'document_remove_widget'` / `'document_list_widgets'` 两个 intent, 在 pipeline 里加对应 phase, 在 executor 里走 `document.removeWidget` / `document.listWidgets`.

---

## 4. Contract test 强度分级

经过本轮直接 Read, contract test 强度有分化:

| 测试 | 类型 | 强度 |
|---|---|---|
| `domain-adapter-contract.test.ts` | **真行为** (实例化 + 喂入工具结果 + 断言 patch) | ✅ 较强 |
| `subtask-runtime-contract.test.ts:241` | **真行为** (`'runScopedTurn' in runtime === false`) | ✅ 强 |
| `document-task-pipeline-host-contract.test.ts` | 字符串 grep (`assert.match/doesNotMatch`) | ⚠️ 弱, 重命名即破 |
| `document-insight-cache-host-contract.test.ts` | 字符串 grep, 而且把"实例化方式 + key 字面量"也写死 | ⚠️ 弱 + 易碎 |
| `agent-runtime-host-contract.test.ts` | 字符串 grep, 但 `doesNotMatch` 列表已较全 | ⚠️ 中, 仍能被改写法绕过 |
| `tool-runtime-contract.test.ts` | 字符串 grep | ⚠️ 中 |

**新坑**: `domain-adapter-contract.test.ts:546-552` 把 §3.1 的 bug 行为也写成了契约 (单批 == done). 修 §3.1 必须同步改这条契约.

---

## 5. 第二轮整改建议顺序 (按收益 / 风险)

| 序号 | 事项 | 关联章节 | 预估收益 | 风险 |
|---|---|---|---|---|
| 1 | 修 RSS/Calendar/Feishu adapter 的"单批 == done"假完成 | §3.1 | **立刻闭合 3 类多步任务的状态显示假象** | 中 — 需同步改 contract test |
| 2 | 把 phase6 `continuationIntent` IPC 改造合并进当前分支 | §3.2 | 摆脱 5 条字符串 regex, i18n 安全 | 中 — 跨分支合并冲突 |
| 3 | document mutating 工具 `resultShape='projection_patch'` + `emitsProjectionPatch=true` | §3.4 | 让 phase1 字段真正起作用, 后续 step-by-step UI 可直接消费工具结果 | 低 — 改 4 行白名单 + 1 个 Set |
| 4 | 删除 `direct-chat.ts:163-173` 的 session cache 字段, 让 executor 独立持有 | §3.5 | 切断反向耦合, 关闭 session 内存增长 | 中 — 需迁移 4 处 executor 读写点 |
| 5 | renderer 切换到消费 `taskProjection`, 删 `parseStructuredToolPayload` | §3.6 | 真正消除"双写真相", 主进程 projection 成为唯一来源 | 中 — 需回归全部 task 卡 UI |
| 6 | 四个 phase4 adapter 的 `dispatch()` 实化 | §3.3 | 给 domain-local 预检查留接口位 | 低 — 当前无业务依赖 |
| 7 | 拆 `writing_widget` phase + 补 `locating_target_widget / updating_widget` | §3.7 | UI 看得到信息卡定位 vs 更新 | 低 — 局部 |
| 8 | classifier 补 `document_remove_widget / document_list_widgets` intent + pipeline branch | §3.8 | 关闭最后一类信息卡操作的 free loop 兜底 | 中 — 需新 phase + tool 调用 |
| 9 | 加固 `document-task-pipeline-host-contract` / `document-insight-cache-host-contract` 测试 (改成结构化检测或行为测试) | §4 | 防止下次重命名假绿 | 低 |

---

## 6. 第二轮验收参考

完成 §3.1 后:
- 一个手工脚本: `RSSDomainAdapter.applyResult` 喂入 1 个 `rss_fetch_updates` + 1 个 `rss_select_item` 后, projection.phase 应该是 `'running'` 或不存在, 不能是 `'done'`.
- `domain-adapter-contract.test.ts:546-552` 应被改为多步场景断言.

完成 §3.2 后:
- `grep "Execution ID:" src/main` 在 main 端只有 fallback 路径有命中.
- preload 暴露 `continuationIntent` 类型, renderer 走结构化 payload.

完成 §3.4 后:
- `defaultToolRegistry.getToolDefinition('document_insert_widget')?.resultShape === 'projection_patch'`
- `defaultToolRegistry.getToolDefinition('document_update_widget')?.projectionHint?.emitsProjectionPatch === true`

完成 §3.5 后:
- `grep "documentInsightCache" src/main/modules/claude-bridge` 0 命中.
- `direct-chat.ts` 行数应 ≤ 1300.

完成 §3.6 后:
- `grep "parseStructuredToolPayload" src/renderer` 0 命中或仅注释.

---

## 7. 与第一轮审核的差异回顾

| 第一轮发现 | 第二轮验证 | 状态变化 |
|---|---|---|
| §3.1 direct-chat 1600 行未搬 | 已搬到 executor (1641 行), direct-chat 1401 行 | ✅ 主体闭合, 行数仍超 |
| §3.2 ToolRuntime 边界残留 | `drainRunCleanup / consumeExecutedToolBatch` 仍存在 | ⚠️ 维持 (已知边界) |
| §3.3 ToolDefinition 字段缺失 | 字段加齐, 但 document 工具没用上 | ⚠️ 部分 (从"全无"变"半用") |
| §3.4 四 adapter 空壳 | 形式齐了, 但 RSS/Calendar/Feishu 状态机错 | ⚠️ 改坏 (从"空"变"错") |
| §3.5 run-projection regex 兜底 | 完全清掉 | ✅ 闭合 |
| §3.6 continuation 字符串协议 | **当前分支零进展** (修复在另一分支) | ❌ 未合入 |
| §3.7 runScopedTurn 死码 | 已删, 契约断言 | ✅ 闭合 |
| §3.10 renderer 文本兜底 | regex 没了, 但 JSON 解析仍在双写真相 | ⚠️ 形式变了, 真相未归一 |
| §4 信息卡链路 | classifier + pipeline + consumer 都通 update 路径; 但 delete/inspect 仍未通 | ✅ 80% 闭合 |
