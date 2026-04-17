# Ready Agent Runtime Realignment — Codex 实施审核

> 审核日期: 2026-04-17
> 审核对象: `codex/document-widget-pipeline-cache` 分支对 `docs/superpowers/plans/2026-04-17-ready-agent-runtime-realignment-roadmap.md` 七阶段计划的落地情况
> 关联文档: `2026-04-17-ready-agent-runtime-realignment-info-card-gap-trace.md`（已有信息卡修改链路专项追踪）

## 1. 结论速览

codex 已经把 roadmap 里**可用一把 regex 断言卡住的壳层**都做完了:
`TurnEngine` 已接管单轮真相, `DomainAdapter` 合同已声明且 Browser / Document 已接入, `ToolRuntime / ExecutionLoopOrchestrator / ToolDefinition / ToolResultShape` 文件都已创建, 7 个 contract test 都在断言这些"搬迁线"还在.

但有**三个结构性落地漏洞**让"七阶段完成"只是形式完成:

1. **`DirectChatEngine` 缩壳只做了一半**. Phase 3 要求它成为 "provider-facing host shell", 但当前 2871 行里依然挂着 ~1600 行文档 pipeline / insight / widget draft / cache glue. Contract test 只断言了 provider 私有方法的迁出, 放过了 document 业务代码 (参见第 3.1 节).
2. **`ToolRuntime` 的 Phase 2 第一波已经收口, 但清理仍保留双层兜底**. 批量工具执行主路径、超时、重试、失败清理和 hooks 接线已经回到 `ToolRuntime`, `tool-executor` 不再自己包超时; 但 `ClaudeSdkOrchestrator.drainRunCleanup(runId)` 仍保留 run 结束兜底, 工具结果如何进入 transcript / projection 也仍由 `TurnEngine` 消费 (参见第 3.2 节).
3. **Skill / RSS / Calendar / Feishu 的 adapter 仍然没真正接住各自状态**. RSS / Calendar / Feishu 三个文件基本还是 32 行空壳; Skill 工具虽然已经能产出结构化 projection patch, 但 `SkillDomainAdapter` 本身仍然没有 `dispatch / applyResult / buildProjectionPatch` 状态归属, 前后端还保留文本兜底 (参见第 3.4 节).

最尖锐的后果已经暴露出来了: "已有信息卡修改" 链路是三层同时失效叠加出来的 (classifier → pipeline → consumer), 任何一层修好都能让它闭环, 但没有一层修过. 这条线索还牵出了一组相似的"壳迁好了但内部没连通"的结构性缺口, 详见第 4 节.

---

## 2. 七阶段对照表

| 阶段 | Roadmap 目标 | Codex 实际状态 | 评分 |
|---|---|---|---|
| 0 — Contract baseline | 冻结 "哪些职责必须迁出" 的契约测试 | 7 份 contract test 就位, 但全部是 **结构 grep**, 不是行为断言; 放过了 3.1 / 3.2 两类壳内残留 | ⚠️ 部分 |
| 1 — Tool definition & registry | 8 工具域 + 每项 `kind / concurrency / timeout / resultShape` | 8 域 + `system_host` + `design_reserved` 全部注册; `resultShape` 恒为 `'text'`, `supportsTextBridge / projectionHint / description / schema` 缺失 | ⚠️ 部分 |
| 2 — Tool runtime extraction | `ToolRuntime` 独立, 承担并发 / 中断 / 超时 / 清理 | `ToolRuntime.executeBatch` 已接入生产主路径, `ExecutionLoopOrchestrator` 已透传 `context + hooks`, `timeoutProfile / retry / cleanup` 已连通; **外层 run cleanup drain 仍保留兜底, tool result 展示仍由 `TurnEngine` 消费** | ✅ 基本完成 |
| 3 — DirectChat 缩壳 | DirectChatEngine 缩为 provider-facing host shell, TurnState 接管 route / budget / toolPool / transcript / interaction / continuation / domainState | `TurnEngine / TurnState / TurnTranscript` 建立, `sendMessage` 已 `return this.turnEngine.execute(…)`; **但 direct-chat.ts 还有 2871 行, ~1600 行文档 pipeline glue 没搬** | ⚠️ 部分 |
| 4 — Domain adapter 合同 | `shouldHandle / prepare / dispatch / applyResult / buildProjectionPatch` 统一; Skill/RSS/Calendar/Feishu 按同一模式补齐 | 合同已声明; Browser (395 行) / Document (317 行) 接入; **RSS/Calendar/Feishu 三个 adapter 仍是 32 行空壳, Skill 工具已有结构化 patch 但 adapter 自身仍未接住状态** | ⚠️ 半完成 |
| 5 — Projection 作为展示真相镜子 | 展示 ← 任务数据 ← projection patch, main/projection 只翻译 | `TaskProjectionSync` 合并 `projectionTruth patch` 优先于 summary, 方向对; **`RunProjection.deriveTaskSummaryPatch` 仍有 ~90 行 regex 解析文本事件, 是 browser/skill 的旧兜底, 没清理** | ⚠️ 部分 |
| 6 — Continuation state | 任务语义化续跑, 不是字符串粘贴 | `ContinuationState / parseContinuationControlText / buildContinuationStateFromProjection` 就位; **但 `parseContinuationControlText` 仍然是"从用户文本里 regex 抓 Task ID/Execution ID/Step ID"——只是把字符串粘贴关进了一个函数里** | ⚠️ 部分 |
| 7 — Subtask / worker runtime | Worker session 隔离 + projection 上抛 | `SubtaskRuntime.runInlineWorker` 有完整闭环; **`runScopedTurn` 分支返回 `finalText: ''` (硬编码空串), 且全代码库无调用方——疑似未完成或死码** | ❌ |

---

## 3. 分阶段详细审核

### 3.1 Phase 3 — DirectChat 缩壳没做完 (高危)

**现状**: `src/main/modules/claude-bridge/direct-chat.ts` 仍然是 **2871 行**, 其中 1132–2765 行 (~1600 行) 是文档 pipeline 专属代码:

- `maybeRunDocumentTaskPlanShortcut` (1132–1198)
- `maybeRunDocumentWidgetPipelineShortcut` (1199–1400)
- `buildFallbackDocumentWidgetDraft / normalizePipelineWidgetDraft / buildDocumentWidgetDraftCacheKey` (1763–1875)
- `buildDocumentPipelineInsight / buildDocumentPipelineWidgetDraft` (1877–2017)
- `verifyDocumentTaskPlanWrite / buildDocumentTaskPlan(Failure|Success)Text` (2018–2088)
- `executeDocumentTaskPlanJob / runDocumentTaskPlan` (2089–2620) — 约 530 行
- `loadDocumentPipelineSnapshot / normalizeActiveDocumentSnapshot` (2621–2809)
- `buildDocumentInsightCacheKey / getCachedDocumentInsight / storeCachedDocumentInsight` 以及 widget draft 同类 6 个 (2639–2764)

**roadmap 原文**: "`DirectChatEngine` 缩为 provider-facing host shell, 只保留 provider 适配、IO 钩子、session/scope 转发."

文档 task plan 执行、insight/widget 缓存、draft 归一化, 没有一项是 provider 适配 / IO / session 转发. 这批代码按合同应该落在 `DocumentDomainAdapter` 或一个新的 `DocumentTaskPipelineOrchestrator` 里.

**为什么 contract test 没拦住**: `agent-runtime-host-contract.test.ts:215-228` 的 `doesNotMatch` 只列了 provider 层私有方法名 (`callAnthropicWithTools / parseSectionRewritePlan / buildSectionRewriteDraft` 等); 对 `maybeRunDocumentTaskPlanShortcut / runDocumentTaskPlan / executeDocumentTaskPlanJob / buildDocumentPipelineInsight / buildFallbackDocumentWidgetDraft / getCachedDocumentInsight / storeCachedDocumentWidgetDraft / loadDocumentPipelineSnapshot` 这批名字没有任何断言, 所以它们留在壳里测试不会红.

**影响**:

- Phase 3 的 "Done When" 未满足: 壳没真正变薄 (目标应在 1000 行以下).
- Phase 4 的 "Document 接入 DomainAdapter" 只是接口意义上的接入 —— 真正的 pipeline 方法还挂在壳上, adapter 只是借 `host.maybeRunDocumentTaskPlan / host.maybeRunDocumentWidgetPipeline` 回拨到 direct-chat, 等于 "给壳套了一个 adapter 名义".
- 业务 bug 容易贴在这 1600 行里 (见 §4 的 info card 链路: `insertWidget` dep 也在这里, 没处理 `update_existing`).

**整改建议** (按优先级):

1. 新增 `src/main/modules/agent-control/document-task-pipeline-orchestrator.ts`, 把 `executeDocumentTaskPlanJob / runDocumentTaskPlan / buildDocumentPipelineInsight / buildDocumentPipelineWidgetDraft / verifyDocumentTaskPlanWrite / buildDocumentTaskPlan(Failure|Success)Text / buildFallbackDocumentWidgetDraft / loadDocumentPipelineSnapshot / normalizeActiveDocumentSnapshot` 整体迁过去 (~1200 行).
2. 把 `buildDocumentInsightCacheKey / get|storeCachedDocumentInsight / get|storeCachedDocumentWidgetDraft / buildDocumentWidgetDraftCacheKey` 迁到 `document-insight-cache.ts` 同目录, 统一 cache 层.
3. 在 `DocumentDomainAdapter.dispatch` 里直接调 `documentTaskPipelineOrchestrator.runPlan / runWidgetPipeline`, 去掉 `host.maybeRunDocumentTaskPlan / host.maybeRunDocumentWidgetPipeline` 这对 shortcut 回钩.
4. 在 contract test 加一批 `doesNotMatch` 锁死: `maybeRunDocumentTaskPlanShortcut / runDocumentTaskPlan / executeDocumentTaskPlanJob / buildDocumentPipelineInsight / buildFallbackDocumentWidgetDraft / loadDocumentPipelineSnapshot` 都不允许出现在 direct-chat.ts 内.
5. 断言 `direct-chat.ts` 行数 ≤ 1200 (逃逸阀值), 防止将来再往壳上贴肥肉.

---

### 3.2 Phase 2 — 第一波已收口, 但仍有边界残留 (中)

`docs/superpowers/plans/2026-04-17-ready-agent-runtime-realignment-roadmap.md` Phase 2 要求:

> Tool runtime 独立: 把工具执行 (并发 / 取消 / 超时 / 清理) 从 `DirectChatEngine` / `ExecutionLoopOrchestrator` 抽到一个明确单元.

结合 `src/main/modules/agent-control/tool-runtime.ts`、`execution-loop-orchestrator.ts`、`turn-engine.ts` 当前实现, Phase 2 这一波的真实状态是:

| 承诺 | 实际 | 说明 |
|---|---|---|
| 并发 | ✅ `groupParallelSafeToolCalls` + `Promise.allSettled` chunk | 完整 |
| 取消 | ✅ `throwIfAborted` + `onBatchInterrupted` | 完整 |
| **超时** | ✅ **`ToolRuntime` 已读取 `timeoutProfile`** | 超时现在由 runtime 统一处理, `tool-executor` 不再自己包 `withToolExecutionTimeout(...)` |
| **清理** | ✅ **runtime 优先, orchestrator 兜底** | `ToolRuntime` 会跟踪当前 batch 注册的 cleanup, 在 abort / tool failure 时先行 drain; `ClaudeSdkOrchestrator.drainRunCleanup(runId)` 仍保留 run 结束兜底 |
| 错误恢复 | ✅ 第一波收口 | `rate_limit / transient` 已有退避重试; `context_overflow` 改为结构化失败; `timeout_tool / host_unavailable / auth` 继续转结构化结果 |
| Hooks | ✅ 生产路径已连通 | `ExecutionLoopOrchestrator.executeToolCalls` 已透传 `context + hooks`; `TurnEngine` 现已通过 `onToolStart / onToolRecovered / onBatchInterrupted` 接住 runtime 生命周期信号 |

**本轮收口后的剩余边界**:

1. cleanup owner 现在是 **runtime first / orchestrator fallback**, 不是单一 owner. 这已经满足"失败时先清理"的第一波目标, 但严格来说还不是最纯的边界.
2. `context_overflow` 虽然已经不再硬抛, 但目前只是转成结构化失败, **没有 tool-level context compression primitive**. 这项按计划留到后续阶段.
3. `onToolResult` 这一轮仍然没有直接接管 transcript / projection 真相; 工具结果如何进入正文和任务卡, 仍由 `TurnEngine.consumeExecutedToolBatch(...)` 消费. 这是刻意留在 Phase 5 再处理的边界, 不是本轮遗漏.

**本轮已补齐的验证点**:

1. contract test 已增加对 `timeoutProfile / context / hooks / cleanup` 的断言, 不再只盯旧写法.
2. `tool-runtime-results / tool-runtime-interrupt / execution-loop-parallel-tools` 已补上最薄行为测试, 覆盖默认 batch 路径、超时、重试、cleanup 和 hooks.

---

### 3.3 Phase 1 — ToolDefinition 字段缺失 (中)

`src/main/modules/agent-control/tool-definition.ts`:

```typescript
export interface ToolDefinition {
  name: string
  groupId: CapabilityGroupId
  domain: ToolDomain
  kind: ToolKind
  concurrency: ToolConcurrency
  interruptBehavior: ToolInterruptBehavior
  timeoutProfile: ToolTimeoutProfile
  resultShape: ToolResultShape
}
```

设计文档 (`docs/superpowers/specs/2026-04-17-ready-agent-runtime-realignment-design.md`) 与 roadmap Phase 1 "Done When" 列出的字段是:

> `{ name, domain, kind, concurrency, interruptBehavior, timeout, supportsTextBridge, projectionHint, description, schema, resultShape }`

差异:

| 字段 | 现状 | 说明 |
|---|---|---|
| `supportsTextBridge` | ❌ 缺失 | 文本桥接适配是否允许该工具; 没有这个字段, text bridge 只能靠白名单字符串匹配 |
| `projectionHint` | ❌ 缺失 | 工具结果对 projection 的贡献提示 (例如 "这是一个 mutating 动作, 需要 bump stepBudget"); 目前散在 `document-tool-loop-orchestrator` 和 `task-projection-sync` 里 |
| `description / schema` | ❌ 缺失 | Tool description 和参数 schema 目前仍然由 `browser-tools-definitions / document-tools / skill-tools` 三份独立文件各自维护 anthropic 与 openai 两份规格 —— tool definition 没有合并 schema 的单一来源 |
| `resultShape` | ⚠️ 硬编码 `'text'` | `tool-registry.ts:246` 写死, 所有工具都是 `'text'`; `'json' / 'projection_patch'` 虽然类型联合里有, 但从来不会被选中. Phase 1 的 "`resultShape` 决定 projection 如何消费" 没落地 |

**整改建议**:

1. 为文档类 mutating 工具 (`document.insertWidget / document.updateWidget / document.removeWidget / document.saveTab`) 设置 `resultShape: 'projection_patch'`, `projectionHint: { bumpsStepBudget: true, mutating: true }`, 然后在 `TaskProjectionSync` / `RunProjection` 里基于 `projectionHint` 决定是否推进 step.
2. 为 browser 所有工具默认 `supportsTextBridge: false`, skill/memory/session 设 `true`, 让 text-bridge 走定义表, 不再靠散落白名单.
3. 把 `description / schema` 合进 tool definition 时, 先把 anthropic/openai 两份 schema 统一成内部中性 schema, 再在 `tool-gateway` 外化成对应格式, 去除双份维护.

---

### 3.4 Phase 4 — Skill / RSS / Calendar / Feishu 的 adapter 仍未形成统一状态归属 (高危)

`rss-domain-adapter.ts / calendar-domain-adapter.ts / feishu-domain-adapter.ts` 三个文件各 **32 行**, 基本都是同一份模板:

```typescript
export class XxxDomainAdapter implements DomainAdapter {
  readonly id = 'xxx'
  shouldHandle(params): boolean { return params.route.executor === 'xxx' }
  prepare(params) { return { allowedToolNames: filterByPrefix(...), sessionMessages: [{role:'user', content: INSTRUCTION}], domainState: null } }
  dispatch() { return { domainState: null } }
  applyResult() { return { domainState: null } }
  buildProjectionPatch() { return null }
}
```

`SkillDomainAdapter` 也是同样的 prepare-only 空壳: 它只做 tool prefix 过滤和 instruction 注入, `dispatch / applyResult / buildProjectionPatch` 仍然全空.

对比 `browser-domain-adapter.ts` (395 行, 含 `prepareBrowserExecution / refineUploadDecision / runDeterministicExecution / resolveExecutionDispatch` 调用) 和 `document-domain-adapter.ts` (317 行, 接入 `DocumentToolLoopOrchestrator` 管状态机), 这几类 adapter 的共同问题是: **没有 adapter-local state, 没有 applyResult 状态累积, 也没有通过 adapter 自己完成 projection 归属**.

Roadmap Phase 4 原文:

> "Skill / RSS / Calendar / Feishu 再按同一模式补齐, 结束'主循环里写很多专属分支'的状态."

实际: 主循环里原本就没有这四类专属分支, 所以 "结束" 也就无事可做. 但 roadmap 的目标是把这四类**也**像 browser/document 一样**有状态可跟踪** —— 比如 skill 执行应该有 `executionId / currentStepId / blockerType` 的 adapter-local state, 而不是靠 `RunProjection.deriveTaskSummaryPatch` (run-projection.ts:199-243) 在 response text 里 regex 抓 `^Execution ID: / ^Skill: / ^Current step: / ^Blocker:` 回推步骤.

**需要修正的一点**: skill 路径并不是"完全没有结构化结果". `skills-tools.ts` 已经会通过 `createSkillExecutionOutput()` 产出 `projectionPatch`. 真正的问题是这份结构化结果没有通过 `SkillDomainAdapter` 统一收口, `run-projection.ts` 和 renderer `scopeRunState.ts` 仍然保留一套基于 `Execution ID: / Current step: / Blocker:` 的文本兜底.

**影响**:

- Skill 类任务虽然已有一部分结构化 patch, 但主进程和前端仍然都保留文本解析兜底; 结果是状态归属分裂, skill runtime 输出格式一旦漂移, projection 仍可能断层.
- RSS / Calendar / Feishu 类任务目前根本没有细颗粒步骤 —— adapter 返 null, projection 没 patch, 只能显示最后一条 assistant text.
- "终结主循环里写很多专属分支" 目标未达成 —— 只是把残余分支换成了 `run-projection.ts` 里的 regex 分支, 迁移而非消解.

**整改建议** (按 skill 为例, 其它三者同构):

1. `SkillDomainAdapter.applyResult`: 从 `params.toolBatch` 里识别 `skill_skill_run_next_step / skill_skill_wait_*` 这一类工具调用的 `ToolExecutionOutput.data`, 维护 `{ executionId, currentStepId, blockerType, completedSteps }` 的 `domainState`.
2. `SkillDomainAdapter.buildProjectionPatch`: 直接把 `domainState` 转成 `RunProjectionPatch { taskTitle: 技能执行 · ${skillId}, steps, currentStepId, waitingFor, taskContinuation }` —— **删除 `run-projection.ts:198-243` 的 skill regex 块**.
3. Feishu / RSS / Calendar 类似处理: 工具调用成功 → adapter 记下"已读取几条 feed / 已发送消息到哪个群 / 已写入哪个日程", 生成 step 粒度的 patch. 这一步不必 regex, 因为工具结果已经是结构化的 (`feishu_send_message` 返回 `{ msg_id, ... }`, 直接用).

---

### 3.5 Phase 5 — Projection 仍有 regex 兜底 (中)

`src/main/modules/agent-control/run-projection.ts:146-246` 的 `deriveTaskSummaryPatch`:

- 155-176: browser plan regex (`\[计划\] 目标：/ \[计划\] 顺序：`)
- 178-196: browser stage regex (`\[阶段\] 步骤 N/M name：detail`)
- 198-243: skill regex (`Execution ID: / Skill: / Current step: / Blocker:`)

这段代码在 `ScopeRunSummary` 合成时比 `projectionTruth patch` 先执行, 虽然 `readProjectionTruthPatch` 的结果会覆盖它 (run-projection.ts:88-97), 但只要 adapter 没出 patch (Skill/RSS/Calendar/Feishu 都没出), regex 就会"默默上台".

Phase 5 原文: "main/projection 只是翻译层". 翻译层里跑 regex 就不是翻译, 是二次解释.

**整改建议**:

- 等 §3.4 的四个 adapter 真正吐 patch 之后, 直接删除 `deriveTaskSummaryPatch` 整段, 把 `recordEvent` 里的调用点改成 "有 patch 用 patch, 没 patch 用 previous" (不再兜底解析).

---

### 3.6 Phase 6 — Continuation 仍然是字符串协议 (中)

`src/main/modules/agent-control/continuation-state.ts:144-205` 的 `parseContinuationControlText` 从用户文本里 regex 抽 `Task ID: xxx / Execution ID: xxx / Step ID: xxx / 继续前上下文: xxx / 我的回复: xxx`.

这是 UI 层把结构化 continuation control 序列化成文本塞进 `content` 的老协议. Roadmap Phase 6 原文: "续跑 = 把 projection 读回来 + 用户做选择, 而不是'把上一轮文字再粘一遍'."

现状把"粘贴"关进了一个函数里 —— **技术上已经是结构化消费**, 但**输入形态还是粘贴**. 前端仍然在生成"Task ID: xxx\n..."文本丢给主进程. 一旦前端 i18n / 中英文切换, 这份 regex 会悄悄失配.

**整改建议**:

- 在 `preload / renderer` 层把 continuation control 走 **单独的 IPC payload (`continuationIntent: { taskId, executionId, stepId, responseText, blockedReason }`)**, 不再往 `content` 字符串里嵌.
- `direct-chat.sendMessage` 增加 `continuationIntent?` 参数, 优先用它; `parseContinuationControlText` 保留但仅作为"老客户端"兜底, 不再作为主路径.
- Contract test: 断言 renderer IPC payload shape 包含 `continuationIntent`; 断言 direct-chat 优先读 IPC 参数.

---

### 3.7 Phase 7 — SubtaskRuntime.runScopedTurn 是死码且有 bug (低 但必改)

`src/main/modules/agent-control/subtask-runtime.ts:170-190`:

```typescript
async runScopedTurn(request: SubtaskRunRequest): Promise<SubtaskRunResult> {
  if (!request.message) throw new Error('runScopedTurn requires a message payload')
  const identity = createWorkerSessionIdentity({...})
  const result = await this.deps.runScopedTurn({ ...request, identity })
  return {
    taskId: identity.taskId,
    status: result.success ? 'done' : 'error',
    finalText: '',                  // ← 硬编码空串, 永远不会有 finalText
    error: result.error,
    projectionTruth: null,          // ← 同样硬编码 null
  }
}
```

- `grep -n subtaskRuntime.runScopedTurn` 在全仓库 0 命中 —— 外部没人调用它.
- `runInlineWorker` 路径 (subtask-runtime.ts:30-168) 行为完整, 真在用.

**整改建议**: 二选一.

- (A) 删 `runScopedTurn` 整个方法 + 对应 deps (`deps.runScopedTurn` 也一起), 保持 SubtaskRuntime 只暴露 inline worker 一条路径.
- (B) 补完它: 让 `deps.runScopedTurn` 返回 `{ success, error, finalText, projectionTruth }`, 并在 `direct-chat.ts:2422` 的回调里填上真实字段.

当前状态 (死码 + 硬编码零值) 是最糟的, 容易误导未来接入.

---

### 3.8 `worker-session.ts` 只有 28 行 (信息)

这个文件只导出 `createWorkerSessionIdentity`. 其余 roadmap 里提到的 "worker session 生命周期管理" (启动 / 停止 / 状态机 / 资源绑定) 没有实现. 如果只需要 `id 生成器`, 建议把函数挪到 `subtask-runtime.ts`, 删掉这个几乎空的文件.

---

### 3.9 Contract test 覆盖强度偏弱 (中)

所有 contract test (`agent-runtime-host-contract / tool-runtime-contract / turn-engine-contract / agent-task-runtime-contract`) 都走 `readFileSync + assert.match(/regex/)`. 优点是轻, 缺点是**只断言文件里出现过某个字符串**, 不断言该字符串在运行时真被调用.

例如 `agent-runtime-host-contract.test.ts:93-97` 断言:

```typescript
assert.match(documentToolLoopOrchestrator, /createState\(/)
assert.match(documentToolLoopOrchestrator, /applyToolInspection\(/)
assert.match(documentToolLoopOrchestrator, /handleNoToolCall\(/)
```

但 `applyToolInspection` 方法在文件里写了不代表它被 `DocumentDomainAdapter.applyResult` 调用到了 —— 如果 adapter 没传入正确的 `documentToolInspections[]`, 这些断言全绿, 行为照样崩.

**整改建议**: 在 contract test 基础上加一层 **最薄的 fake-host integration test** (不要求真 LLM), 直接构造 `TurnEngineRequest` 跑 `TurnEngine.execute`, 断言 `ExecutionTurnResult.structuredTaskPayload / recoveryHistory / interactionState` 的 shape. 这样结构化检测不会因为重命名被 regex 漏掉.

### 3.10 本轮补充发现的缺口 (中)

这几项不改变前面结论, 但需要补进 Phase 0/1 文档, 否则第一波整改的目标会继续失真:

1. **Contract test 已经出现假红**. 例如 `agent-runtime-host-contract.test.ts` 里直接写死 `const response = await host.requestToolLoopResponse(`, 代码只要把 `const` 换成 `let` 再赋值, 行为没变, 测试就会红. 这说明现有 contract test 不是"冻结边界", 而是在冻结局部写法.
2. **并发字段口径曾经不一致**. 本轮核实时, `tool-definition.ts` 和 roadmap 已经在用 `concurrency`, 但 design / study / contract test 里还留着 `isConcurrencySafe` 的旧说法. 这类命名分叉如果不在 Phase 0 收口, 后面补字段时就会同时兼容两套语义, 反而把真相弄乱. 本轮第一波整改里已统一按 `concurrency` 记述.
3. **前端仍然保留一套 browser / skill 文本兜底**. `src/renderer/modules/agent/scopeRunState.ts` 里还在解析 `\[计划\]`, `\[阶段\]`, `Execution ID:` 这些文本行. 这意味着主进程就算收口成结构化 projection, renderer 也还在"自己再跑一遍旧协议".
4. **超时策略曾经挂在 `tool-executor`, 不是 `ToolRuntime`**. 这一点在 Phase 2 第一波整改里已经收口: `ToolRuntime` 现在会读取 `timeoutProfile`, `tool-executor.ts` 只保留域分发和结果归一.

---

## 4. "已有信息卡修改" 链路 — 详见同级专项文档

详细 trace 在 `2026-04-17-ready-agent-runtime-realignment-info-card-gap-trace.md`. 这里只摘结论:

三层同时失效:

1. **Classifier** (`document-task-types.ts:35-37`): `EXISTING_WIDGET_UPDATE_PATTERNS` 命中时返回 `null`, 把 "修改这个信息卡" 这类请求**显式挤出** `document_read_then_widget_create` pipeline.
2. **Pipeline 阶段机**: `DocumentWidgetPipelinePhase` 只有 `loading_document → building_insight → generating_widget_spec → writing_widget → saving_document` —— 没有 `locating_target_widget / updating_widget` 阶段. `DocumentWidgetDraft.insertionMode` 类型联合里有 `'update_existing'` 但 pipeline 里没 branch 消费它, `targetWidgetTitle` 字段解析了但没有下游读取.
3. **InsertWidget consumer** (`direct-chat.ts:1366-1376`): 无论 `draft.insertionMode` 是什么, 一律 `requestModuleToolAction('document.insertWidget', { position: draft.insertionMode === 'after_section' ? 'after_section' : 'append_end' })`; `update_existing` 在这里悄悄退化成 `append_end`; `document.updateWidget` 永远不会被 pipeline 触发.

这是一条"类型上允许、pipeline 不分支、consumer 不分流"的经典 half-completed chain. 相似结构的缺口还有:

- `DocumentReadPlan.taskType` 类型联合虽然只有 `'document_read_then_widget_create'` 一种, 但命名暗示本应 `'document_read_then_widget_update'` 和 `'document_widget_inspect'` 也在路上 —— 还没建.
- `tool-policy-heuristics.ts:175-181` 会把 `replace_existing / update_existing / additive_create` 三者都收敛成 `documentWidgetTaskKind`, 但 pipeline 消费的只有 `'create'` 语义, 其它 `'update' / 'remove' / 'inspect'` 都只在 free tool loop 里靠 LLM 自由决策.

**最小修复 (不改架构, 只闭合链路)**:

1. `classifyStructuredDocumentIntent` 新增返回值 `'document_list_then_widget_update' | 'document_remove_widget'`, 不再把 update/remove 类请求打成 `null`.
2. `DocumentTaskPipeline` 增加 `locating_target_widget → updating_widget` 分支: 先 `document_list_widgets` 拿目标 id, 再 `document_update_widget` 写入.
3. `direct-chat.ts:1366` 的 `insertWidget` dep 拆成 `upsertWidget`: `if (draft.insertionMode === 'update_existing') requestModuleToolAction('document.updateWidget', { target: draft.targetWidgetTitle, widgetCode, componentSpec, title })` else 原逻辑.
4. (Cleanup) 把这三步连同其它 document pipeline 代码一起按 §3.1 迁到 `DocumentTaskPipelineOrchestrator`.

---

## 5. 建议的推进顺序 (按收益 / 风险)

| 序号 | 事项 | 预估收益 | 风险 |
|---|---|---|---|
| 1 | §4 info card 链路最小修复 (classifier + pipeline branch + consumer upsert) | **立刻闭合一个已知断链**, 覆盖 `修改/删除/查看` 三类常见用户请求 | 低 — 纯局部 |
| 2 | §3.2 ToolRuntime 超时 + hooks 连通 | **解决 browser 类任务卡死无兜底** | 中 — 需回归 browser agent v7 的 90s 上传 / 提交 |
| 3 | §3.7 删除 `runScopedTurn` 死码 | 清理误导项, 减少未来接入踩坑 | 无 |
| 4 | §3.1 DirectChat → `DocumentTaskPipelineOrchestrator` 搬迁 | 兑现 Phase 3 "缩成 provider host shell" | 高 — 1600 行搬迁, 需 contract test 扩写 |
| 5 | §3.4 四个 domain adapter 补齐 dispatch/applyResult/patch | 兑现 Phase 4; 消除 `run-projection` regex 分支 | 中 — 需要 skill/rss/calendar/feishu 各跑一次回归 |
| 6 | §3.3 ToolDefinition 字段补齐 (`resultShape / projectionHint / supportsTextBridge / description / schema`) | 为后续"工具结果 → projection 直连"打底 | 中 — 触碰三份 tool schema 文件 |
| 7 | §3.5 清理 `RunProjection.deriveTaskSummaryPatch` regex | 把 projection 收紧为真·翻译层 | 低 — 依赖 #5 先完成 |
| 8 | §3.6 continuation control 改 IPC payload | 移除字符串粘贴协议 | 中 — 需要前端协同 |
| 9 | §3.9 contract test 加最薄 integration test | 以后重构不再因为"regex 还匹配"假装通过 | 中 — 需建 fake host |

---

## 6. 验收参考

- 当 §3.1 完成, `src/main/modules/claude-bridge/direct-chat.ts` 行数应 ≤ 1200.
- 当 §3.2 完成, `tool-runtime.ts` 内可以 grep 到 `timeoutProfile` 与 `AbortSignal.timeout`, 且 `ExecutionLoopOrchestrator.executeToolCalls` 的调用签名含 `hooks`.
- 当 §3.4 完成, `run-projection.ts` 里 `Execution ID:/Skill:/Current step:/Blocker:` 这四个 regex 可以删除且回归通过.
- 当 §4 最小修复完成, "把这个信息卡改成 XX 风格" 一句话 → pipeline 走 `locating_target_widget → updating_widget` → 前端看到信息卡内容实际更新 (而非 append 一张新卡).
