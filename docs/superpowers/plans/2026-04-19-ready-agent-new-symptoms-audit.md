---
date: 2026-04-19
status: draft
scope: ready-agent / document-widget pipeline
maintainer: Claude (Opus 4.7) · 用户 user@example.com
superseded-by: TBD
---

# Ready Agent · 新症状审核（审核先行，暂不改码）

## 0. 背景与两个复现症状

在上一轮 continuous widget modification timeout（round2）收口之后，用户在真实使用中捕获到两个新症状：

- 症状 A（"提交后立刻返回一大串内容，看起来不是 agent 回答，像是未定义的提示词"）
  - 表象：用户刚提交新的 widget 优化请求，消息流中立刻出现一段长文本，文本结构是"当前文档共有 N 个 widget（X）"+编号列表+```json [...]``` 代码块。这段文本不是对用户问题的回答，更像工具返回原文。
- 症状 B（"修改'指引'时返回：未找到可更新的 widget"）
  - 表象：针对一个已带 `component_spec` 的 widget（例如"指引"卡片）提交修改请求，渲染层直接返回字符串 `未找到可更新的 widget：<target>`。

本轮要求：先用真实证据（`file_path:line_number` 级别）定位问题层级，列清楚缺口，再产出改进规划。本文只含审核与分层，**不落代码**。

---

## 1. 证据地图（关键文件与行号）

| 角色 | 文件 | 关键行 | 备注 |
|---|---|---|---|
| 文档任务管线调度 | `src/main/modules/agent-control/document-task-pipeline-executor.ts` | 199–228, 1031, 1046–1057, 1092–1101, 2113–2114 | 决定何时走 pipeline、如何把 `targetWidgetId` / `componentSpecPatch` 传到渲染侧 |
| 意图分类 | `src/main/modules/agent-control/document-task-types.ts` | 32–35, 42–65 | `LIST_WIDGET_PATTERNS` 与 `classifyStructuredDocumentIntent` |
| Pipeline list 分支 | `src/main/modules/agent-control/document-task-pipeline.ts` | 466–497 | `document_list_widgets` 直接把 `listSummary` 回填为 `finalText` |
| 工具 Loop 兜底 | `src/main/modules/agent-control/document-tool-loop-orchestrator.ts` | 92–135 | `handleNoToolCall` 在特定条件下把 `lastDocumentInspectionResult` 作为 `finalText` 提交 |
| Inspection 启发 | `src/main/modules/claude-bridge/document-tool-flow.ts` | 61–101 | `shouldPreferDocumentInspectionResult`、`inspectionResult` 从 tool 原文回灌 |
| Turn 层回写 | `src/main/modules/agent-control/turn-engine.ts` | 855 及附近 | `transcript.emitOutput(domainDispatchResult.finalText, 'text')` |
| Renderer list_widgets 格式 | `src/renderer/modules/agent/documentActions.ts` | 1159–1177 | 输出 `N 个 widget` + bullet + ```json``` 块 |
| Renderer update_widget 匹配 | `src/renderer/modules/agent/documentActions.ts` | 1180–1246 | `shouldApplyPatch` 分支采用**纯标题匹配**，不调用 `resolveWidgetRecord` |
| Renderer 统一 widget 解析 | `src/renderer/modules/agent/documentActions.ts` | 485–539 | `resolveWidgetRecord`：数字序号 → `record.id` → 标题归一 → 模糊 |
| Pipeline 执行器目标下发 | `src/main/modules/agent-control/document-task-pipeline-executor.ts` | 1031, 1046 | `target = draft.targetWidgetId \|\| draft.targetWidgetTitle \|\| ''` |
| Widget 指纹/ID 工具 | `src/shared/document-widget-parse.ts` | `ensureDocumentWidgetId`, `DocumentWidgetRecord.id` | 新增的稳定 id（显式 id 优先，回退 FNV hash + seed） |

---

## 2. 症状 A · 缺口分层与证据链

### 2.1 最直接的缺口（G-A1）：`list_widgets` 的工具原文被当成 agent 的最终回答

**证据链**：

1. 用户发请求 → executor 进入 pipeline 分支：
   - `document-task-pipeline-executor.ts:199-228`：只要 `structuredDocumentIntent ∈ {create, update, list_widgets, remove}` 就走 `runDocumentWidgetPipeline`。
2. 当 intent=`document_list_widgets`：
   - `document-task-pipeline.ts:466-497`：直接把 `listSummary` 设成 `finalText`。
3. 当不是 list_widgets，但 agent 先行调用了 `document_list_widgets` 作为 inspection：
   - `document-tool-flow.ts:96`：`inspectionResult = executedInspectionDocActionCount > 0 ? result : null`（tool 原文直接回灌）。
   - `document-tool-loop-orchestrator.ts:102-121`：如果后续 iteration `forceDocumentTool=true` 且 `shouldPreferDocumentInspectionResult(responseText, inspectionResult)=true`，第 1 次推一条 nudge，第 2 次直接 `return { finalText: state.lastDocumentInspectionResult, finish: true }`。
4. Finalize 出口：
   - `document-domain-adapter.ts` 在多处（237、266、334、368）把 pipeline/loop 的 `finalText` 原样抛出。
   - `turn-engine.ts:855`：`transcript.emitOutput(domainDispatchResult.finalText, 'text')` 把 finalText 直接作为文本 chunk 打入流式通道。
5. 渲染：
   - `runtimeDriver.ts` 的 onStream 对 `type === 'text'` 原样 `appendToMessage`。
   - 用户看到的就是 `documentActions.ts:1164-1177` 那段 "当前文档共有 N 个 widget…\n1. … id=… 可 patch …\n\n```json [{…}]\n```" 整体文本。

**为什么用户会误读为"未被定义的提示词"**：该文本混合了：
- 结构化 bullet 列表（含 `id=widget_xxx`、`· 可 patch` 等内部字段名）
- 紧跟的 ```json``` 围栏，里面是 widget summary JSON 数组
- 没有任何"回答当前请求"的语言层

对用户而言视觉上像 "系统从哪儿漏出来一段模板/提示词"，但实际是 `listSummary` 的工具输出直接被当作 agent 的 final answer。

### 2.2 触发条件（G-A2）：意图分类仅依赖正则，极易把"优化 widget"误判成 list

- `document-task-types.ts:32-35`
  ```
  const LIST_WIDGET_PATTERNS = [
    /(查看|列出|看看|看一下|有哪些|都有哪些).*(widget|卡片|信息卡)/i,
    /(widget|卡片|信息卡).*(列表|清单|列出|有哪些)/i,
  ]
  ```
- `classifyStructuredDocumentIntent()` 的优先级是 `REMOVE > LIST > UPDATE > CREATE`；LIST 检查先于 UPDATE。
- 现实语料里，用户输入中包含"看一下卡片" / "信息卡…有哪些…" / "看看这个 widget …"等模式时，会被划入 `document_list_widgets`。
- 但 `classifyStructuredDocumentIntent` 的输入来自 `extractPrimaryUserInstruction`（`execution-intent-resolver.ts:55, 82`），这一步会剥掉尾部上下文但不一定能完全隔离 widget attachment 中的关键词（须进一步验证，见 G-A5）。

这意味着：哪怕用户的**真实意图是更新**，只要句子中出现 LIST 的词，pipeline 就走向 `list_widgets` → 直接把 summary 作为 finalText。

### 2.3 结构性缺口（G-A3）：pipeline 与 orchestrator 对"工具原文"没有"可展示化"的格式层

- `document-task-pipeline.ts:491-496` 与 `document-tool-loop-orchestrator.ts:116-120` 都是直接 `finalText = <tool output>`，没有任何 "turn a tool dump into a user-facing sentence" 的转换。
- `documentActions.ts:1159-1177` 的 list 输出**面向日志/调试**（带 `id=…`、`可 patch` 等内部字段），不应该直接回用作用户回答文案。

把"可调试的工具快照"和"面向用户的消息"耦合在一起，是症状 A 的根本原因之一。

### 2.4 副作用链（G-A4）：`shouldPreferDocumentInspectionResult` 的启发式太宽

- `document-tool-flow.ts:61-75`：只要 `responseText` 为空 **或**命中 `/调用了\s*`?document_list_widgets`?/`、`/任务已完成/`、`/这是一个查询操作/`、`/如果用户需要我执行其他文档修改操作/` 之一，就认为应当把 inspection 原文作为结果。
- 在 forceDocumentTool 场景下，第一轮提示词模板里如果 agent 写了上述任一句（例如："已调用 document_list_widgets，这是一个查询操作"），第 2 轮仍然不动手就直接落到 `finalText = inspectionResult`。
- 相当于把 "agent 无法完成真实修改" 的失败路径，用"列表原文"来伪装成"答案"。

### 2.5 诊断窗口（G-A5）：意图分类输入污染需要进一步核实

- `execution-intent-resolver.ts:48-67` 的 `contextualUserInput` 是 `resolveToolPolicyInput(primaryInstruction || pureUserText, [lastDocumentContextInput, ...previousInputs])`，只做了上下文拼接后的打分取段。
- `extractPrimaryUserInstruction()` 在 `tool-policy-heuristics.ts:55-85` 用 `stripTrailingContexts` + chunk 打分 — 与 CLAUDE.md §6.9 对 live-info 的要求"输入只能是 primary instruction、不能拼 widget attachment"**相似但并非等价**，尚不能排除边缘场景下 widget attachment 的关键词（如 "卡片 · 列表" 之类）污染 `classifyStructuredDocumentIntent`。
- 这是一个待验证的次级缺口：若验证成立，应把 LIST 分类的输入同样收敛到 `request-envelope.primaryInstruction`。

---

## 3. 症状 B · 缺口分层与证据链

### 3.1 直接根因（G-B1）：`update_widget` 的 patch 分支只按标题匹配

- `documentActions.ts:1180-1213`：当 agent 只发 `componentSpecPatch`（不带 `widgetCode` / `componentSpec`）时，触发 `shouldApplyPatch`，随后**自行**做匹配：
  ```
  const matches = widgetRecords.filter((record) =>
    record.title === target || record.title.toLowerCase() === lowerTarget
  )
  const record = … matches[0]
  if (!record) return `未找到可更新的 widget：${target}`
  ```
- 对比同文件 `updateWidgetInDocument → resolveWidgetRecord`（`documentActions.ts:485-539`）支持的检索顺序：
  1. 数字序号
  2. `record.id === trimmed` ← **这才是"指引"场景稳定命中的关键**
  3. 标题归一（lowercase/trim）
  4. 标题模糊（包含关系）

Patch 分支**完全没有**走 id / 序号 / 模糊 这三条，等于说：**只要 pipeline 发的 `target` 是一个稳定的 `widget_xxx` id，就永远不会命中。**

### 3.2 上游对偶缺口（G-B2）：pipeline 执行器默认按 ID 下发

- `document-task-pipeline-executor.ts:1031, 1046`：
  ```
  const target = String(params.draft.targetWidgetId || params.draft.targetWidgetTitle || '').trim()
  ```
- `document-task-pipeline-executor.ts:2113-2114`：当 draft 没填 `targetWidgetId` 但 envelope 有 `widgetId`，会自动回填：
  ```
  if (!built.draft.targetWidgetId && envelopeWidgetTarget?.widgetId) {
    built.draft.targetWidgetId = envelopeWidgetTarget.widgetId
  }
  ```
- 即 upstream **刚刚做完的改造**（本轮 diff）正是为了"以 id 为主键做精准定位"；现在 downstream 的 patch 分支把这个契约打破了。

这是 pipeline 契约（"下发 widgetId"）与 renderer 合约（"只识别 title"）的错位，典型的"端到端契约断层"。

### 3.3 与 ensureDocumentWidgetId 的交互（G-B3）

- `src/shared/document-widget-parse.ts` 的 `ensureDocumentWidgetId` 现在会：
  - 显式 fence 里如果写了 `id: xxx`，就用 `xxx`；
  - 否则回退到 `widget_${hashFNV(title+widgetCode+seed)}`，其中 seed 在 `collectDocumentWidgets` 中是段落起点。
- 因此即使 agent 在 envelope 里拿到了 `widgetId=widget_abc`，在 renderer 端解析同一个文档得到的 `record.id` 也确实会等于 `widget_abc`——契约上完全能闭合。
- 问题不在 id 不稳，而在 **patch 分支根本不查 id**。

### 3.4 用户错觉（G-B4）："指引"这一标题让用户以为应该是标题命中

- 用户主观上是在"指引"卡上发起修改，但 envelope 把显式 id 透传给 pipeline，pipeline 又把 id 作为 `target` 下发（G-B2）。
- 渲染侧的错误文案：`未找到可更新的 widget：${target}` 直接把内部 id（`widget_xxxxxx`）回显给用户，进一步强化"为什么找不到指引？这一串是什么？"的困惑。

这并不是新 bug，但文案回显**暴露内部 id**，加大了误解代价。

---

## 4. 命中后果的影响面评估

| 缺口 | 受影响操作 | 严重性 | 说明 |
|---|---|---|---|
| G-A1 + G-A2 | 任何触发 `document_list_widgets` 路由的短语 | 高 | 立刻把工具原文当作答案 |
| G-A3 | 所有 pipeline / loop 的 `finalText` 出口 | 中 | 缺少 "tool→user" 的格式层 |
| G-A4 | `forceDocumentTool` 场景 + agent 未继续修改 | 中 | 将失败路径伪装成完成 |
| G-A5 | widget attachment 污染分类的边缘场景 | 低 | 需验证；若成立，会间接放大 G-A2 |
| G-B1 | 所有带 `componentSpecPatch` 的 widget 更新 | 高 | 每次都挡死 |
| G-B2 | pipeline→renderer 契约错位 | 高 | 结构性，容易再次复发 |
| G-B3 | ensureDocumentWidgetId 链路 | 低 | 当前实现正确，但需要回归测试固化 |
| G-B4 | 错误文案暴露内部 id | 低 | 用户体验层 |

---

## 5. 与 CLAUDE.md 既有约束的对照

- §6.8 文档多资源任务原则：要求 widget 以结构化资源形式被引用。本轮 envelope 已经携带 `widgetId`，但 renderer patch 分支没有消费，违背"文档卡片类执行状态必须按计划步骤展示"的下沉要求。
- §6.9 实时外部信息查询原则：明确"live-info 语义判断的输入只能是 primary instruction，不能拼 widget attachment"。`classifyStructuredDocumentIntent` 目前走的是 `extractPrimaryUserInstruction`，大方向合规；但 G-A5 需要一条轻量验证来确认没有旁路污染。
- §6.10 Agent 工具策略裁决与超时：`run-capability-controller.resolveRunCapabilities` 是策略裁决唯一点，`assertNoToolResolutionViolation` 只作 telemetry。本轮症状 A 的 `lastDocumentInspectionResult → finalText` 兜底**没有经过 telemetry**，属于盲区，需要补一次 `logAgentMetric('tool_resolution_violation_post_arbitration', …)` 或等价埋点，否则未来再发生"pipeline 回灌 tool 原文"时无从审计。

---

## 6. 改进规划骨架（仅规划，先不改码）

> 顺序按风险从高到低；每一步都需要 **单元/契约测试** 先落地，再修实现。

### P-1 · 关闭症状 B（渲染侧 patch 分支的匹配缺口）· ✅ 已落地（2026-04-19）
- 在 `documentActions.ts:1206-1213` 用 `resolveWidgetRecord(widgetRecords, target, occurrence)` 替换 inline 的 `matches = filter(record.title===target…)`。
- 错误文案改成 `未找到可更新的 widget（target=${displayTarget}）`，并在 target 是内部 id 时展示"(id)"前缀；如可能，附上"文档中共有 N 个 widget"以帮助用户理解。
- 测试：
  1. 给文档插入两个同标题 widget，target=id 能命中正确那一个；
  2. target=title 命中；
  3. target=index 命中；
  4. target=不存在时回退到 `当前文档中没有匹配的 widget` 并不暴露裸 id。
- 影响面：只动 `update_widget` 的 patch 分支；不改 `updateWidgetInDocument`。

**落地记录**
- 实现：`src/renderer/modules/agent/documentActions.ts:1206-1246` 替换为 `resolveWidgetRecord` + id 正则（`^widget_[a-z0-9]+$`）识别的文案升级；`updateWidgetInDocument` 调用改为传 `record.id` + `undefined` occurrence，避免二次解析漂移。
- 测试：`src/__tests__/document-update-widget-patch.test.ts` 新增 4 条 `describe('update_widget patch 分支目标解析')` 子测试 —— id 命中、数字序号命中、标题回归命中、id-like target 与 title 两种未找到文案。全部通过。
- 计划原文：`~/.claude/plans/eager-yawning-brook.md`（approved）。
- 命令：`npm run typecheck` 全绿；`npm run test` 在我的改动上失败数 16，与 HEAD 基线 32 相比没有新增失败项，所有残留失败均为触及 `DirectChatEngine.ts` / `turn-engine.ts` / `pipeline-executor.ts` 的 source-code 合约测试，与本次改动无关。

### P-2 · 关闭症状 A 的主通路（pipeline list 分支不把 summary 当答案）· ✅ 已落地（2026-04-19）
- `document-task-pipeline.ts:491-496`：把 `finalText: listSummary` 替换为"面向用户的短句摘要 + 可折叠列表"。建议：
  - 顶层一句话：`已查到 N 个 widget，示例标题：A / B / C。如需编辑，请指出具体标题或序号。`
  - 附带列表使用更克制的展示（不内嵌 ```json```）。
- `documentActions.ts:1159-1177` 的输出保持"工具原文"形态，但**只作为 tool result**，不再被 pipeline 当做 finalText。
- 测试：
  - pipeline 以 list_widgets 完结时，返回的 finalText 不再包含 ```json``` 围栏；
  - list_widgets tool 本身的输出保持调试友好，回归测试仍能通过。

**落地记录**
- 实现：
  - 新增共享 helper `buildListWidgetsUserFacingText` 与 `ListWidgetsUserFacingInput` 在 `src/shared/document-widget-parse.ts` 末尾；按 `0 / 1–3 / ≥4` 三分支生成中文短句，**禁止**输出 ```json``` 围栏 / `id=widget_` / `· 可 patch` 等内部字段，缺 tabTitle 时降级为 `当前文档`。
  - `src/main/modules/agent-control/document-task-pipeline.ts`：新增 `DocumentListWidgetsResult { summaries, tabTitle }`；`DocumentTaskPipelineDeps.listWidgets` 返回类型由 `Promise<string>` 改为 `Promise<DocumentListWidgetsResult>`；`document_list_widgets` 分支用 `buildListWidgetsUserFacingText` 构造 finalText（缺 tabTitle 时回退到 `snapshot.title`）。
  - `src/main/modules/agent-control/document-task-pipeline-executor.ts:2135-2148` 的 `listWidgets` 适配器：保留 `requestModuleToolAction('document.listWidgets', …)` 调用以维持 tool capsule / `ready-tools.log` 可见性，但**忽略** payload，改用 `collectDocumentWidgets(snapshot.content) + summarizeWidgetRecord` 直接产出结构化 summary，同时回填 `tabTitle = snapshot.title`。
  - 渲染侧 `documentActions.ts:1159-1177`、locate/verify 处的 `tool('document.listWidgets', …)` 调用与 IPC payload 形状均**未改动**，downstream `summary.includes(target)` / `/当前文档共有 \d+ 个 widget/` 合约不受影响。
- 测试：
  - `src/__tests__/document-list-widgets-structured.test.ts` 新增 5 条 helper 子测试（0 / 1 / 3 / 6 个 widget + 缺 tabTitle 降级），全部通过。
  - `src/__tests__/document-task-pipeline.test.ts:420-498` 修订 `runs document_list_widgets …` 用例：mock `listWidgets` 改为返回结构化 `{summaries, tabTitle}`，断言 finalText 匹配 `已查到「需求文档.md」中的 2 个 widget` 等友好句式，并加 negative 断言 ` ```json` / `id=widget_` / `可 patch` 不再出现；phase 顺序契约保持 `loading_document → listing_widgets → completed`。
  - `src/__tests__/executor-routes-list-and-remove-intents.test.ts`、`src/__tests__/document-task-pipeline-host-contract.test.ts`、`src/__tests__/pipeline.phase-order-matches-task-type.test.ts` 等 list/remove 路由契约保持通过。
- 计划原文：`~/.claude/plans/users-user-documents-ready-cowork-linked-yao.md`（approved）。
- 命令：`npm run typecheck` 全绿；`npm run test` 失败数 16，与 P-1 落地后的基线一致，残留失败均是图标/RSS/calendar/ritual overlay/browser mode 等与 list_widgets 无关的源代码契约测试。

### P-3 · 收紧 orchestrator 的 inspection fallback（避免把失败伪装成答案）· ✅ 已落地（2026-04-19）
- `document-tool-loop-orchestrator.ts:116-120`：把 `finalText = lastDocumentInspectionResult` 改成两步：
  1. 第 1 步先 `finalText = buildUserFacingInspectionSummary(lastDocumentInspectionResult)`，即**先消毒**再展示；
  2. 同时 `logAgentMetric('tool_resolution_violation_post_arbitration', { reason: 'inspection_result_used_as_final_text' })`，让它始终可被审计。
- `document-tool-flow.ts:61-75`：收紧 `shouldPreferDocumentInspectionResult`：
  - 去掉 `/任务已完成/` 和 `/这是一个查询操作/` 这类过宽命中；
  - 保留空 responseText 命中，但同时要求 `toolTransport==='native'` 才启用，文本桥下走不同路径。
- 测试：
  - 第 1 次 fallback 走 nudge；
  - 第 2 次 fallback 走**消毒版** finalText，不含内部 id / JSON 块；
  - `forceDocInspectionResultNudges` 计数行为不回归。

**落地记录**
- 实现：
  - 新增共享 helper `parseListWidgetsToolOutput` 与 `buildUserFacingInspectionSummary` 在 `src/shared/document-widget-parse.ts`。前者**仅解析** ```json fence``` 为 `DocumentWidgetSummary[]`（拒非数组、拒缺 title、JSON 损坏回兜底），并用 `/当前文档(?:共有\s*\d+\s*个|没有)\s*widget（([^）]+)）/` 抽 tabTitle。后者空/null/undefined 走统一兜底句 `已查询当前文档的 widget 列表。请告诉我你想修改的 widget 标题或序号。`；`summaries.length > 0` 或识别出 `当前文档没有 widget` 时复用 P-2 的 `buildListWidgetsUserFacingText`；其他完全失败同样走兜底句。**保证**输出不含 `id=widget_` / ` ```json ` / `· 可 patch` / `· 仅整卡替换` / `· 带状态`。
  - `src/main/modules/claude-bridge/document-tool-flow.ts:61-75` `shouldPreferDocumentInspectionResult` 签名新增第三参数 `toolTransport?: 'native' | 'text'`。顶部短路 `if (toolTransport === 'text') return false`；删除 `/任务已完成/i` 与 `/这是一个查询操作/i` 两条过宽正则；保留 `/调用了\s*\`?document_list_widgets\`?/i` 与 `/如果用户需要我执行其他文档修改操作/i`。空 trimmed 仍然 `return true`（顶部已按 transport 关门）。
  - `src/main/modules/agent-control/document-tool-loop-orchestrator.ts` 新增可选依赖 `DocumentToolLoopOrchestratorDeps = { logMetric?: ... }`；构造函数签名改为 `constructor(deps: DocumentToolLoopOrchestratorDeps = {})`，**可选默认值**避免破坏 `src/main/modules/claude-bridge/direct-chat.ts:339` 的 `new DocumentToolLoopOrchestrator()`。`handleNoToolCall` 中调 `shouldPreferDocumentInspectionResult` 时透传 `params.toolTransport`；第 2 次 fallback 改为 `finalText = buildUserFacingInspectionSummary(params.state.lastDocumentInspectionResult)` + `this.logMetric('tool_resolution_violation_post_arbitration', { stage: 'document_tool_loop_orchestrator', reason: 'inspection_result_used_as_final_text', toolTransport, forceDocInspectionResultNudges, responseTextLen, responseTextSample })`。
  - `src/renderer/modules/agent/documentActions.ts:1159-1177` 顶端新增契约注释，提醒 ```json fence``` 被 `parseListWidgetsToolOutput` 消费；渲染侧输出形态**保持不变**，维持 P-2 约定。
- 测试：
  - 新增 `src/__tests__/document-inspection-user-facing-summary.test.ts`（12 条）：`parseListWidgetsToolOutput` 正常/fence 缺失/非数组/损坏 JSON/缺 title/空文档 header；`buildUserFacingInspectionSummary` 空/null/undefined/0 widget/1-3 widget/≥4 widget（示例句）/无 fence 兜底/无 header 仍可降级为 `当前文档`。
  - 扩展 `src/__tests__/document-tool-flow.test.ts`（新增 10 条 transport×正则矩阵）：空+native→true、空+text→false、`任务已完成。` 单独 + native→false（收紧）、`这是一个查询操作。` 单独 + native→false（收紧）、`调用了 document_list_widgets` + native→true、text 通道全关、`如果用户需要我执行其他文档修改操作` 保留、inspection 原文已在 responseText 中则 false。
  - 扩展 `src/__tests__/document-tool-loop-orchestrator.test.ts`（新增 2 条）：第 2 次 fallback 输出消毒短句（含 `「my-notes.md」` / `「指引」`，**不**含 `id=widget_`、` ```json `、`· 可 patch`），且注入的 `deps.logMetric` 恰被调 1 次、payload 含 `reason: 'inspection_result_used_as_final_text'`、`toolTransport: 'native'`、`forceDocInspectionResultNudges: 1`；`toolTransport: 'text'` + 空 responseText 时不触发 fallback（state/finish/finalText 均不变）。
  - 现有 `nudges when document inspection result should be surfaced` 用例（L:6-22）继续通过，responseText `我刚才调用了 document_list_widgets，任务已完成。` 仍命中 `/调用了\s*\`?document_list_widgets\`?/i`。
- 计划原文：`~/.claude/plans/users-user-documents-ready-cowork-stateless-cherny.md`（approved）。
- 命令：`npm run typecheck` 全绿；`npm run test` 失败数 16，与 P-2 落地后的基线完全一致，残留失败均是图标/RSS/calendar/ritual overlay/browser mode/document tool session context 等与 P-3 无关的源代码合约测试。单独跑 `document-inspection-user-facing-summary.test.ts`（12/12）、`document-tool-flow.test.ts`（14/14）、`document-tool-loop-orchestrator.test.ts`（7/7）全部通过。

### P-4 · 收紧意图分类，避免 update 被识成 list
- `document-task-types.ts:32-65`：
  - 将 `LIST_WIDGET_PATTERNS` 的优先级降到 UPDATE/CREATE 之后，**仅当没有任何编辑动词时**才判定 list；
  - 增加 `IS_EDIT_VERB` 集合（更新/修改/调整/优化/重做/替换/改成/改为/重写/改写等），edit 动词 > list 动词；
  - `REMOVE > UPDATE > CREATE > LIST`（当前是 REMOVE > LIST > UPDATE > CREATE）。
- 增加 `classifyStructuredDocumentIntent` 的输入验证：必须是 `extractPrimaryUserInstruction(primaryInstruction)`；加断言 "input 不得以 `### `/`- ` 等结构化块开头"。
- 测试：
  - "优化当前信息卡" → `document_read_then_widget_update`；
  - "看一下有哪些卡片" → `document_list_widgets`；
  - "修改这个 widget，把标题改成指引" → `document_read_then_widget_update`（含 "修改"）。

### P-5 · 端到端契约测试：widgetId 下发闭环
- 新增契约测试：从 "MarkdownEditor 提交 → envelope → pipeline → renderer update_widget patch 分支" 完整链路，验证：
  - envelope 中的 `widgetId` 能到达 `draft.targetWidgetId`；
  - renderer patch 分支按 id 命中；
  - 文档状态被正确更新。
- 测试文件候选：`src/__tests__/document-task-pipeline-host-contract.test.ts` 或新增 `document-widget-patch-target-resolution.test.ts`。

### P-6 · 文案与 telemetry 收尾
- `未找到可更新的 widget：${target}`：当 target 是内部 id（`^widget_[a-f0-9]+$`）时，隐藏 id 本体，展示标题提示："未找到与你选择的卡片对应的 widget，请重新选择或提供标题。"
- 新增 `logAgentMetric` 维度：`patch_target_resolution_failed`、`list_widgets_summary_as_final_text`，便于未来长期观察。

---

## 7. 验收与回归清单（给自己约束）

**必须跑通：**
- `npm run typecheck`
- `npm run test`（含新增的 P-1、P-2、P-3、P-4、P-5 测试）
- `npm run verify`

**人工冒烟（对应两个原始症状）：**
1. 插入一个带 component_spec 的 "指引" widget，发起文字级修改 → 期望看到"已更新 widget（字段级 patch）：指引…"，**不应**出现"未找到可更新的 widget"。
2. 连发两次优化请求 → 既不应再看到 `当前文档共有 N 个 widget … ```json [...] ``` ` 这一段原文被当作答案；也不应再出现 "看起来像未定义的提示词" 的观感。
3. 普通 "查看当前文档有哪些 widget" 依旧返回友好总结，不退化。

**文档同步：**
- 改完实现后，本文档从 `status: draft` 改成 `status: applied`，并在 §9/§12 同步索引（如需）。

---

## 8. 风险与权衡

- P-2 修改 pipeline 的 list finalText 可能影响已有的自动化测试与训练语料（如果有任何期望原样匹配 summary 的测试需要同步更新）。
- P-4 调整分类优先级存在**误判回退**风险：需要保留足够的单测覆盖，尤其是"看看 widget"这种既像 list 又像 read 的灰色区域。
- P-3 收紧 `shouldPreferDocumentInspectionResult` 可能导致某些原本走 fallback 的对话现在改走"继续 nudge"，需要在回归中检查是否引入新死循环。

---

## 9. 下一步

按顺序推进 P-1 → P-2 → P-3 → P-4 → P-5 → P-6；每一步都先补测试再改实现；每一步落地后更新本文件 §7 的勾选状态。
