---
title: Dynamic Delivery v3 Agent 原生协作实施计划
date: 2026-07-10
kind: implementation
enforce: false
status: completed — 2026-07-11 全链验收及 Boost 60s 误停事故复审收口
owner: 白
original_author: Claude (Fable 5)
revision_author: Codex
requires:
  - docs/superpowers/plans/2026-07-10-agent-foundation-remediation-implementation.md（AF-0..AF-7 全绿）
pairs_with:
  - docs/superpowers/plans/2026-07-09-boost-dynamic-workflow-roadmap.md
related:
  - docs/superpowers/plans/2026-06-20-p5c-packet-trio-disabled-implementation.md
  - docs/superpowers/plans/2026-06-12-agent-evolution-phase3-implementation.md
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-06-13-agent-evolution-phase4-implementation.md
documentation_status: archived-in-place
archived_at: 2026-09-06
---

> 原位归档（2026-09-06）：固定历史证据仍引用此路径。保留此路径不代表全文仍是当前合同；其中的状态、源码位置和待办属于原记录。现行约束见 [当前运行时合同](../../architecture/current-runtime-contracts.md)，归档去向见 [文档清单](../../documentation-inventory.md)。

# Dynamic Delivery v3 Agent 原生协作实施计划

## 0. 原案处置

以下 v1/v2 路径全部取消：

- `quickjs-emscripten`、QuickJS sandbox、模型生成 JavaScript DSL；
- `run_boost_workflow` 模型工具与 `boost_orchestration` ToolDomain；
- 四套协作 pattern 各自维护 reviewer/revise 状态机；
- Boost 与 selected Skill 互斥；
- 独立 meter/独立终态/第二 workflow 表；
- worker 直接继承主回合工具面或 selected-skill floors；
- 首版 `background` worker、通用 detached 恢复、递归 specialist；
- 失败分支返回 `null`。

内部模块统一使用 `dynamic-delivery`；“深度协作”只是用户文案。

## 1. 总完成标准

Dynamic Delivery 完成必须同时满足：

1. `verify:agent-foundation` 先全绿且无 skip；本模块不复制 owner/profile/usage 补丁。
2. `standard` 和简单 `adaptive` 任务额外 planner/worker/verifier 调用为 0。
3. 代码只有 `single_path | verify_only | support_and_verify` 三个决策，不存在可执行 workflow 源码。
4. 工作包优先绑定 Foundation 认定 collaborationReady 的现有/派生 Agent；ephemeral 只补独立视角。
5. parent owner 不因协作者改变；每个 child 持有自己的 `TaskExecutionBinding`。
6. planner 只提 proposed criteria，worker 只提 evidence handle/observation；CriteriaItem、ProofRef、Check-in 只由 host/finalizer 写。
7. parent + children 在一个可等待的 SQLite transaction 边界创建，不依赖 fire-and-forget 刚好先落库。
8. 首版 model worker 零 tools；write/send/shell/BrowserView/权限/确认与 selected Skill action 全部只属 Owner。
9. pre-owner support → Owner 候选交付 → 单一 fresh verifier → Owner 最多 repair 一次的闭环真实存在。
10. rejected candidate 不进消息 DB、会话 snapshot、下一轮 recall 或重启恢复；repair 不重放已执行 action。
11. required package 未结算、语义 verifier 不可用或 packet adjudication 异常时 fail closed，不得保留 `done`。
12. planner/workers/verifier/repair/Owner 的 usage 全部进同一 parent accumulator；child 不另写一份可被总和的 run_meta usage。
13. packet compiler/dispatch/failure 从 dormant 到 live 只翻一次；安全、session fork、verifier、typed mode wire、正向 gate 与旧 disabled 文档同工单原子收口。
14. 六类任务每类至少两个真实 fixture，每类都达最低线，无新安全绕过或 false completion。
15. 默认 adaptive 只在 A/B 发布门通过后打开；在此之前 typed mode 默认 standard，只用显式 thorough/开发开关验证。

## 2. 严格开工顺序

### 2.1 Agent Foundation 是串行硬门

必须先获得：

- conversation active Agent / handoff generation；
- `resolveTaskOwner()` 和 closed `TaskCreationOrigin`；
- run_meta-authoritative `TaskExecutionBinding`；
- run-local `AgentExecutionProfile` snapshot / material hash / knowledge allowlist；
- conversation/handoff/route/collaboration readiness；
- additive `RunUsageAccumulator`；
- session Agent / active Agent / owner / execution Agent 的 wire 和 UI 语义。

```bash
npm run verify:agent-foundation
```

命令非 0 或有 skip，DD-0 立即停止；除继续审文档/准备静态 fixture 外，不实施 DD-1 以后代码。这与“先暗接一半 packet 再补根基”互斥。

### 2.2 当前 packet 边界

`packet-fields.ts` 和 projection 的 packetRole/parent/context ref/two-level validation 是 live schema；以下三件套仍被 `P5c/C22 unwired` 和 gate 禁止 production import：

- `quality/packet-compiler.ts`
- `quality/packet-dispatch.ts`
- `quality/packet-failure.ts`

DD-1..DD-5 在 Foundation 全绿后才可以 dormant 方式实施/测试，三文件 marker 不移除。DD-6 才是唯一 live flip。

### 2.3 dirty tree

当前工作树已有大量用户改动。实施时每单只 stage 工单列出的文件，共享大文件串行，不顺手清理。

## 3. 核心合同

### 3.1 预判事实与决策

```ts
type DeliveryMode = 'standard' | 'adaptive' | 'thorough'
type CollaborationDecision = 'single_path' | 'verify_only' | 'support_and_verify'

interface DeliveryPreflightFacts {
  mode: DeliveryMode
  taskType: TaskType
  intentDomains: string[]
  structuredTargetCount: number
  contextRefIds: string[]
  selectedSkillId: string | null
  risk: 'ordinary' | 'awaiting_confirmation' | 'exclusive_action' | 'resource_conflict'
  profiles: AgentProfileSummary[]
  hostCriteria: CriteriaItem[]
  budget: DeliveryBudgetSnapshot
  hasUnknownRequiredFact: boolean
}
```

生产点固定在 `executeAgentSdkPreparedTurn` 中：`canonicalTaskFacts` + `liveTaskBudgetRuntime` 已建立之后、`assembleAgentSdkTurnInput` 之前。`canonicalTaskFacts` 由 typed request envelope、intentClassification、structured targets 和继续状态统一解析；工具面只是能力事实，不能单独把“暴露了 research/skill 工具”当用户任务意图。信源冲突就标 unknown 并回 single。

决策是纯函数：

- `standard`、direct/status/continue/原子 transaction → `single_path`；
- 结构性事实为 unknown → `single_path`；
- 单一高要求语义交付但无独立分工 → `verify_only`；
- multi-step/research/media/跨域且至少 2 个独立目标 → `support_and_verify`；
- awaiting confirmation/exclusive action/resource conflict → 不启动前置并行。

### 3.2 DispatchPlan / WorkPackage

```ts
interface DispatchPlan {
  version: 1
  packages: WorkPackage[] // adaptive 1..2; thorough 1..3
}

interface WorkPackage {
  packageId: string
  title: string
  objective: string
  deliverable: string
  expectedOutputs: string[]
  proposedCriteria: string[]
  contextRefIds: string[]
  executorHint:
    | { kind: 'registered_agent'; agentId: string }
    | { kind: 'ephemeral'; role: 'researcher' | 'producer' | 'critic' }
  criticality: 'required' | 'optional'
}
```

- `contextRefIds` 持久化形态继续为 `string[]`，与现有 packet/projection 合同一致；运行时再解析 structured ref。
- planner 只生成 `proposedCriteria: string[]`；host 从 fixed templates + deliverable + expected outputs 生成最终 CriteriaItem，planner 不能选 kind/source/NA。
- host 不可修改地附加 `userRequestVerbatim`；objective 不冒充原话。
- 首版没有 lane/background/tool 字段。

### 3.3 DeliveryState / attempt identity

```ts
interface DeliveryStateV1 {
  version: 1
  stateRevision: number
  decision: CollaborationDecision
  parentGeneration: number
  packages: Array<{
    packageId: string
    attempt: 0 | 1
    childTaskId: string
    lifecycleId: string
    binding: TaskExecutionBinding
    criticality: 'required' | 'optional'
    status: 'planned' | 'running' | 'completed' | 'redispatching' | 'degraded' | 'blocked'
    adoptedByOwner: boolean | null
    evidenceHandleIds: string[]
  }>
  verifier: { status: 'not_required' | 'pending' | 'accepted' | 'repair' | 'blocked'; repaired: boolean }
  usage: RunUsageSnapshot
}
```

迟到校验键是 `parentGeneration + packageId + attempt`；不使用随机 worker session id 代替 logical attempt 身份。

### 3.4 WorkerReport / evidence

```ts
interface WorkerReport {
  version: 1
  packageId: string
  attempt: 0 | 1
  summaryLines: string[]       // 1..5
  deliverable: { inline?: string; resourceRefId?: string }
  criterionObservations: Array<{ criterionId: string; observation: string }>
  evidenceHandles: string[]
  unverifiedClaims: string[]
  openQuestions: string[]
  confidence: 'low' | 'medium' | 'high'
}

interface WorkerExecutionResult {
  report: WorkerReport
  usage: ReadyAgentSdkRunResult['usage']
  durationMs: number
}
```

worker 不输出 `ProofRef`、`satisfied`、`not_applicable`、usage 或 parent Check-in。Usage/duration 只从 host provider result 包装成 `WorkerExecutionResult`，模型 JSON 不得进硬预算/台账。Host 验证 evidence handle 所属 child/artifact 存在性后才铸 ProofRef；NA 只能由 host settlement 给具名理由。

`EvidenceHandle` 只由 host issuer 铸造，至少携 handleId、childTaskId、canonical resource/artifact id、kind、digest、产生时间和限长 preview locator；它的 provenance/handle id 持久化到 child proof/delivery state，worker 输出一个未签发字符串不会自动变成 evidence。

### 3.5 预算

```ts
interface DynamicDeliveryBudget {
  totalRunTokenLimit: 72_000 | 120_000
  ownerReservedTokens: 36_000 | 48_000
  maxWorkers: 2 | 3
  maxExtraCallsNormal: 6 | 7
  maxExtraCallsHard: 7 | 8
  maxRedispatches: 1
  wallClockMs: 120_000 | 240_000
  hardWallClockMs: 300_000
}
```

extra call 算式固定：`planner 0/1 + worker attempts 0..N(+global retry 0/1) + verifier 1 + repair cycle 0..2`。文本 repair 最多 1 次 provider call；定向产物 repair 最多 2 次（一次受限工具决策 + 一次最终文本）。全计划只有 1 个 redispatch 配额，且单包仍最多重试 1 次。调用前预留，调用后核销；优先保留 Owner/verifier/repair，再分配 optional worker。

## 4. 分阶段工单

## P0：Agent Foundation 前置

### DD-0 基线与 fixture 冻结

**改动**：不改 Dynamic runtime。

- 保存 `verify:agent-foundation` 输出和本机 DB 快照：Agent、owner、run binding、usage、criteria/proof/check-in、packet rows。
- 新增 12 个脱敏 fixture：研究、内容创作、视觉/视频方案、文档修改、显式 Skill、高风险动作各 2 个。
- 每个 fixture 定义 standard baseline、host criteria、expected outputs、允许工具、禁止副作用和最大预算。

```bash
npm run verify:agent-foundation
npm run verify:stability
```

## P1：预判、schema 与计划编译（dormant）

### DD-1 typed wire + preflight + bounded plan

**改动文件**：

- `src/main/modules/migrations.ts`：在实施时最新编号之后增 `task_projections.delivery_state_json TEXT`。
- `contracts/run-contracts.ts` 主进程 `TaskProjectionRecord`、`task-projection-repository.ts` row/map/create/update 与 JSON validator 全部加 `deliveryState`；未知 version/invalid JSON fail loud，不静默丢状态。
- `src/shared/ipc-contracts/task-projection.ts`、preload API 和 renderer declaration 加对应 read-only wire；renderer 无写入权。
- shared run/IPC/preload/renderer wire：`deliveryMode?: 'standard'|'adaptive'|'thorough'`，默认 standard。
- 新增 `runtime-core/dynamic-delivery/canonical-task-facts.ts`、`delivery-preflight.ts`、`collaboration-policy.ts`。
- 扩展 `quality/packet-fields.ts`：版本化 delivery state 验证，context refs 仍只存 string ids。
- 扩展 dormant `quality/packet-compiler.ts`：纯函数 + injected `boundedTextCall`，不 import runtime/provider singleton。
- 新增 `assets/prompts/dispatch/compile-delivery-plan.md`。
- 更新 `packet-compiler-gate.test.ts` 的旧符号/固定 criteria 断言，不留虚假 deprecated caller。
- 新增 `dynamic-delivery-task-facts.test.ts`、`dynamic-delivery-preflight.test.ts`、`dynamic-delivery-plan.test.ts`、`dynamic-delivery-wire.test.ts`。

**行为**：

- preflight 在最终 task type/budget 已有后生成，unknown 必回 single。
- 同一工具面、不同 typed intent/envelope 必须得到不同 canonical task facts；工具暴露不得反客为主。
- `single_path` / `verify_only` 不调 planner；只有 `support_and_verify` 调一次。
- 任何 decision 都形成 `DeliveryStateV1`；`verify_only` 持久化为 packages=[] + verifier=pending，不因没有 packet children 而绕过终态守卫。
- planner 使用 fresh no-tools MemorySession；strict JSON → 本地 fenced-JSON 去壳/安全标准化；不另调模型修格式。仍失败就回 `verify_only`/单链并记错。
- 校验工作包 1..2/3、单交付物、canonical refs、存在且 collaborationReady 的 Agent hint、closed ephemeral role。

**验证**：

```bash
npx tsx --test src/__tests__/packet-compiler-gate.test.ts src/__tests__/dynamic-delivery-task-facts.test.ts src/__tests__/dynamic-delivery-preflight.test.ts src/__tests__/dynamic-delivery-plan.test.ts src/__tests__/dynamic-delivery-wire.test.ts
npm run typecheck
```

## P2：Report、proof 与 fail-closed settlement（dormant）

### DD-2 host-owned criteria/proof/settlement

**改动文件**：

- 新增 `quality/worker-report.ts`、`quality/delivery-evidence-issuer.ts`、`quality/delivery-evidence-validator.ts`、`quality/delivery-settlement.ts`。
- 改造 dormant `quality/packet-failure.ts`：只产 redispatch/degrade/block settlement，不产 parent ProofRef/Check-in。
- `run-finalizer.ts`：增 delivery-aware fail-closed guard；任何 `deliveryState.decision !== single_path` 都必须 `verifier.status=accepted`（repair 后同时 `repaired=true`）；`support_and_verify` 还要求 required packages 全结算。pending/blocked、state 解析失败、adjudication 异常均不得 done。
- 改写 `packet-failure-upstream.test.ts` 中现有 pre-owner shadow Check-in 断言。
- 新增 `worker-report-contract.test.ts`、`dynamic-delivery-proof.test.ts`、`dynamic-delivery-parent-finalizer-guard.test.ts`。

**行为**：

- WorkerReport 最多 5 行摘要，必须有交付物或资源 ref。
- evidence handle 必须由 host issuer 从真实 child artifact/resource/tool receipt 签发、属于该 child、持久化 provenance 并可达；host 才能调用现有 proof collector 铸 ProofRef。
- failure 只有瞬态 redispatch ≤1 / degrade-with-reason / block 三路。
- 最终 parent Check-in 只在 Owner 候选交付完成后由 finalizer 生成。

**验证**：

```bash
npx tsx --test src/__tests__/worker-report-contract.test.ts src/__tests__/dynamic-delivery-proof.test.ts src/__tests__/packet-failure-upstream.test.ts src/__tests__/dynamic-delivery-parent-finalizer-guard.test.ts src/__tests__/proof-collection-five-sources.test.ts
node scripts/check-run-finalize-funnel.cjs
node scripts/check-checkin-funnel.cjs
node scripts/check-ledger-write-direction.cjs
npm run typecheck
```

## P3：Agent worker 和原子 packet tree（dormant）

### DD-3 `SpecialistModelSubAgent`

**改动文件**：

- 新增 `runtime-core/dynamic-delivery/specialist-model-subagent.ts`、`worker-resource-bundle.ts`、`worker-input.ts`。
- 新增 `specialist-model-subagent.test.ts`、`dynamic-delivery-worker-isolation.test.ts`。
- `ready/no-subagent-leak` 只给这一容器入口豁免，同步 `eslint-rules/index.mjs`、`eslint-rules/__tests__/a0-rules.test.mjs`、`docs/superpowers/operations/lint-exemption-ledger.md`。

**合同**：

- 只实现现有 `SubAgent` 接口，生命周期只走 `runSubAgent()`。
- 模型调用仅使用注入的底层 `host.runAgent`/provider seam；禁止调 `AgentSdkRuntime.sendMessage` 导致套用 parent lifecycle/finalizer。
- registered worker 从 Foundation resolver 取冻结 profile/material hash/allowlisted knowledge；ephemeral 使用代码定义短 profile，无长期身份。
- fresh MemorySession，不继承 parent history/recall/兄弟资产。
- `tools=[]`、maxTurns=1；不接 selected skill envelope，只接 host 已物化的 WorkerResourceBundle。
- 工作包、原话、refs、criteria 与 binding 经结构化输入；只做本地 JSON 去壳/校验，不另调模型修格式，无效就 failed。

**验证**：

```bash
npx tsx --test src/__tests__/specialist-model-subagent.test.ts src/__tests__/dynamic-delivery-worker-isolation.test.ts src/__tests__/sub-agent-runner.test.ts src/__tests__/verbatim-relay.test.ts
npm run lint:check
npm run typecheck
```

### DD-4 `DynamicDeliveryTaskStore` + scheduler + child close adapter

**改动文件**：

- 新增 `runtime-core/dynamic-delivery/dynamic-delivery-task-store.ts`、`packet-scheduler.ts`、`packet-child-close-adapter.ts`、`delivery-reconciliation.ts`。
- projection sync 新增 awaitable started barrier，不再认为 emit 后 parent row 已经存在。
- projection repository 新增窄口 `createDeliveryTreeAtomic()` / `reduceDeliveryState()`：DB transaction 内不发 change event，COMMIT 成功后才批量 emit，rollback 零 renderer 幽灵卡。
- `reduceDeliveryState()` 以 `taskId + parentGeneration + stateRevision` 做串行/CAS，并发 child close 不能各自 read-modify-write 整个 JSON 覆盖兄弟状态。
- 复用 `worker-session.ts` 和 `worker-projection.ts` 的纯 helper，不复用会直接 publish done/error 的 `SubtaskRuntime`。
- 复用 `parallel-branch-orchestrator.ts`，不再建 semaphore。
- 重写 dormant `quality/packet-dispatch.ts`：退役 `chat_turn | subagent | background_task` 和 `browser_collection | skill_long_task` 旧 trait 表，改为只消费 validated WorkPackage + TaskExecutionBinding 的 closed `model_subagent` dispatch。
- 改写 `packet-dispatch-channels.test.ts`：断言只有 registered/ephemeral no-tools model worker；browser/skill/background/unknown 全部结构性拒绝。
- 新增 `dynamic-delivery-task-store.test.ts`、`dynamic-delivery-scheduler.test.ts`、`dynamic-delivery-dispatch-boundary.test.ts`、`dynamic-delivery-reconciliation.test.ts`。

**行为**：

1. 等待 parent started projection barrier。
2. 一个 SQLite transaction 内写 parent `deliveryState`；`support_and_verify` 同时将 parent 设为 packet parent、创建全部 child，`verify_only` 不伪造空 child；中途任一失败全回滚。
3. adaptive worker ≤2，thorough ≤3，并发硬顶 3。`spawn()` 返 null 立即转 `delivery_scheduler_capacity_exceeded` settlement，不转 null 结果。
4. child id 与 attempt 按 `parentGeneration/packageId/attempt` 稳定生成；重派后旧 attempt 迟到丢弃。全 plan 最多 1 次 redispatch；没有 hard-call/token 预留时直接 degrade/block。
5. child 有唯一 taskId/lifecycleId；close 送入 `finalizeRunOutcome()` 的 projection-only adapter，`runMetaRepository=null`，不提前终结 parent run。
6. child usage 只累加到 parent accumulator；delivery state 可留 child diagnostic snapshot，但不另写可被全局求和的 run_meta。
7. close 的 blocked/failed/cancelled 映射为 closed settlement；不得空悬。
8. 重启后未完成 delivery 统一收成 checkpoint/degraded，保留已验 proof；首版不自动重跑 worker。
9. 只在 COMMIT 后发 parent/child change events；3 个 child 同时 close 经 reducer/CAS 全部保留，无 lost update。

**验证**：

```bash
npx tsx --test src/__tests__/dynamic-delivery-task-store.test.ts src/__tests__/dynamic-delivery-scheduler.test.ts src/__tests__/dynamic-delivery-dispatch-boundary.test.ts src/__tests__/dynamic-delivery-reconciliation.test.ts src/__tests__/parallel-branch-orchestrator.test.ts src/__tests__/packet-dispatch-channels.test.ts src/__tests__/packet-failure-upstream.test.ts
node scripts/check-run-finalize-funnel.cjs
npm run verify:native
npm run typecheck
```

## P4：候选交付、verifier 与 session 隔离（dormant）

### DD-5 CandidateSessionFork + single verifier + one repair

**改动文件**：

- 新增 `runtime-core/dynamic-delivery/candidate-session-fork.ts`、`delivery-output-buffer.ts`、`verifier-resource-bundle.ts`、`delivery-verifier.ts`、`delivery-repair-policy.ts`、`delivery-repair.ts`。
- `agent-sdk-turn-model-loop.ts`、`agent-sdk-turn-completion.ts`：协作路径在 session transaction 的 working fork 中生成 candidate，接受前不 emit/不 commit scope snapshot。
- `agent-sdk-run-lifecycle.ts`、`agent-sdk-turn-execution.ts`、`agent-sdk-turn-guards.ts`、`agent-sdk-compactor.ts`：抢占、budget checkpoint、steering checkpoint、compaction 全部改消费 session transaction，不直接持久化未接受 `capturedSession`。
- 新增 `runtime-core/dynamic-delivery/seal-delivery-candidate.ts`：在 verifier 前先完成文档/产物守卫、必要保存与读回、最终 proof 收集，并重新合并 host templates + Owner 运行中 `declare_completion_criteria` 产生的 criteria，输出 immutable sealed candidate bundle。
- 新增 `dynamic-delivery-verifier.test.ts`、`dynamic-delivery-candidate-session.test.ts`、`dynamic-delivery-session-preemption.test.ts`、`dynamic-delivery-session-checkpoint.test.ts`、`dynamic-delivery-session-compaction.test.ts`、`dynamic-delivery-repair-idempotency.test.ts`。

**行为**：

- `CandidateSessionTransaction` 同时持有 immutable committed base 和 working fork，只暴露 `workingSession`、`buildSanitizedCheckpoint()`、`commitAccepted()`、`abortCandidate()`；run lifecycle 不再自行抓取 fork 全量 items。
- `single_path` 不创建 fork/verifier。
- `verify_only` 不 planner/不 worker，Owner candidate 后直接进 verifier。
- `support_and_verify` 把已验 WorkerReports 通过 system-owned input channel 注入 Owner，不拼 providerContent/systemPrompt。
- Owner loop 不直接进 finalizer；必须先 `seal candidate`（检查/保存/读回/收 proof/刷新 criteria），verifier 和 finalizer 都消费同一 sealed bundle，不继续使用 preflight criteria baseline。
- verifier 是 fresh no-tools SubAgent，输入只含原话、候选封口后 host criteria、candidate、open questions 与 host-materialized `VerifierResourceBundle`。bundle 从 canonical handles 读取限长内容摘录/action receipt、digest 和 provenance；不只给一串 ref 名字，也不暴露无关全文。输出 `accept | repair | block`。
- repair 继续同一 fork，只收结构化 gaps，最多 1 个 repair cycle。代码将缺口分为 `text_only | artifact_targeted | non_repairable_action`：
  - `text_only`：tools=[]，最多 1 次 provider call；
  - `artifact_targeted`：只对原任务已验证的同一 document/artifact target 开启代码标记 repair-safe 的读/定向写/保存工具，不扩权，最多 2 次 provider call；修后再 seal/readback；
  - `non_repairable_action`：send/shell/Power Browser/支付/权限/外部事务等直接 block，不重放。
- 任何 repair-safe 工具仍经 Owner 原授权面、resource guard、idempotency receipt 和 action confirmation；需新确认时重新询问，不继承旧授权。
- accept 时只 commit 接受后 transcript/snapshot；rejected candidate 从持久化 session 剥离。
- block 时保留 action receipt/checkpoint，不 commit 被拒结论文本。
- preemption 只承接 committed base + canonical tool/action receipts + delivery checkpoint，不承接 candidate/repair assistant turns；budget/steering checkpoint 也只存同一 sanitized snapshot。
- compaction 可在 working fork 内运行，但不得把压缩后拒稿写回 shared session；只有 accept commit 能推进 shared snapshot。
- verifier 不可用：语义任务 checkpoint/block；只有机械验收可降级 accept。

**测试必须证明**：

- candidate 未出现在 renderer event/message DB；
- repair 后只最终文本可见；
- 下一轮和 app restart 都看不到被拒 candidate；
- candidate 生成中被新请求抢占、budget/steering checkpoint 或 compaction 时，持久化/承接中同样零拒稿泄漏；
- document/save/action receipt 不重放，confirmation 不被 repair 继承为新授权；
- 文本 repair 零 tools；文档/产物缺口只修同一已验目标并重新 seal/readback；非可修外部 action 不重试。
- verifier 不可用的语义任务不 fail-open。
- Owner 在运行中新增 criteria 必须出现在 sealed bundle/verifier/finalizer 三处同一集合中。

**验证**：

```bash
npx tsx --test src/__tests__/dynamic-delivery-verifier.test.ts src/__tests__/dynamic-delivery-candidate-session.test.ts src/__tests__/dynamic-delivery-session-preemption.test.ts src/__tests__/dynamic-delivery-session-checkpoint.test.ts src/__tests__/dynamic-delivery-session-compaction.test.ts src/__tests__/dynamic-delivery-repair-idempotency.test.ts src/__tests__/ledger-consistency.test.ts src/__tests__/declare-completion-criteria.test.ts
npm run verify:stability
npm run typecheck
```

## P5：原子 live flip

### DD-6 `DynamicDeliveryPort` 双 seam 接线 + packet trio 翻面

**狭窄 host port**：

```ts
interface DynamicDeliveryPort {
  prepareOwnerInput(input: DeliveryPreflightInput): Promise<DeliveryPreparation>
  verifyOwnerCandidate(input: DeliveryCandidateInput): Promise<DeliveryVerification>
}
```

**实现与装配 owner**：

- 新增 `runtime-core/dynamic-delivery/dynamic-delivery-coordinator.ts`，实现上述 port，统一持有 profile resolver、task store、injected bounded `host.runAgent`、parent usage accumulator、AbortSignal 和 candidate-session factory。
- 新增 `runtime-core/dynamic-delivery/delivery-run-context.ts`：按 parent runId 保存 decision、generation、settlements、candidate fork、verifier 和 usage 引用，从 pre-owner 穿到 model loop/completion/post-owner，finalize/cancel 后清理。
- `agent-sdk-turn-context.ts` / `TurnOrchestratorHost` 只增 `dynamicDelivery: DynamicDeliveryPort`，不散落暴露上述五个依赖。
- `agent-sdk-runtime.ts` 作为 composition owner 构造 coordinator/port；若底层 provider seam 由 `runtime.ts` 提供，只在该 composition 边界注入，不让 coordinator 拿全局 singleton。
- main/runtime startup 在现有 projection/run reconciliation 窗口注册 `delivery-reconciliation.ts`，扫描非终态 delivery state 并收成 checkpoint/degraded；正向 live gate 断言该 startup caller 存在，不只有一个无人调用的模块。
- 新增 `dynamic-delivery-coordinator.test.ts`、`dynamic-delivery-run-context.test.ts`，证明两个 seam 消费同一 per-run context 且 cancel/close 无泄漏。

**pre-owner seam**：

- 在 `executeAgentSdkPreparedTurn` 内，最终 task type + live budget 已建立后、`assembleAgentSdkTurnInput` 前调 `prepareOwnerInput()`。
- 结果只通过 `agent-sdk-turn-input-assembly.ts` 的 system-owned reminder/input channel 注入；禁止直接拼 providerContent/systemPrompt。

**post-owner seam**：

- 将现有 completion 拆成 `seal candidate → verifyOwnerCandidate() → commit/finalizer`。文档检查/保存/读回、最终 proof 和 criteria 刷新先完成，根据 accept/repair/block 再进 commit/finalizer。

**本工单原子同步**：

- 移除 packet trio `P5c/C22 unwired` marker，建立真实 production caller。
- `check-unwired-capability-markers.cjs` + test 移除 deferred 白名单。
- `check-mandated-capability-is-live.cjs` + test 改为 live-required。
- 更新/退役 `2026-06-20-p5c-packet-trio-disabled-implementation.md` 及其 doc rule，不留“任务包仍未启用”假事实。
- 新增 `check-dynamic-delivery-live.cjs` + test，正向断言精确双 seam、coordinator/run context 装配、task-store transaction、startup reconciliation caller、worker no-tools、candidate fork、verifier、delivery finalizer guard、fired metric；负向断言 QuickJS/JS executor/第二 workflow 表/background lane 不存在。
- production metrics：`dynamic_delivery_decision`、`dynamic_delivery_fired`、`dynamic_delivery_finished`、`dynamic_delivery_fallback`。
- typed mode 已在 DD-1 穿过 main/preload/renderer/runtime；翻面时默认仍 standard，显式 thorough/测试开关才 fired。
- shared `DeliveryErrorKind` 及 drift gate 同步登记；这些是 runtime event errors，不伪装成 worker tool-result errors。

**验证**：

```bash
node scripts/check-unwired-capability-markers.cjs
node --test scripts/__tests__/check-unwired-capability-markers.test.cjs
node scripts/check-mandated-capability-is-live.cjs
node --test scripts/__tests__/check-mandated-capability-is-live.test.cjs
node scripts/check-dynamic-delivery-live.cjs
node --test scripts/__tests__/check-dynamic-delivery-live.test.cjs
node scripts/check-shared-enum-drift.cjs
node --test scripts/__tests__/check-shared-enum-drift.test.cjs
npx tsx --test src/__tests__/dynamic-delivery-live.test.ts src/__tests__/dynamic-delivery-coordinator.test.ts src/__tests__/dynamic-delivery-run-context.test.ts src/__tests__/dynamic-delivery-worker-isolation.test.ts src/__tests__/dynamic-delivery-candidate-session.test.ts
npm run verify:evolution-p3
npm run typecheck
```

## P6：产品、贡献归属与发布门

### DD-7 UI / 设置 / 任务卡

**产品语义**：

- 设置页可选 standard/adaptive，本次发送可选 thorough；A/B 通过前代码默认 standard，通过后同工单切 adaptive。
- 输入框 thorough override 发送后立即复位，不做 per-conversation 粘性开关。
- parent task 卡显示 Owner、contributors、失败/降级/open questions；child 显示真实 Agent 或具名 ephemeral role。
- renderer 只消费 projection/delivery state，不猜完成或 owner。

**新增测试**：

- `dynamic-delivery-mode-ui.test.tsx`
- `dynamic-delivery-task-card.test.tsx`
- `dynamic-delivery-override-reset.test.tsx`

```bash
npx tsx --test src/__tests__/dynamic-delivery-mode-ui.test.tsx src/__tests__/dynamic-delivery-task-card.test.tsx src/__tests__/dynamic-delivery-override-reset.test.tsx
npm run test:ui-contracts
npm run typecheck
```

### DD-8 registered contribution receipt + staged learning

**不延伸到自动派生**：

- parent Owner 在最终 synthesis 中对每个 child 写 durable `adoptedByOwner` settlement，只能在 parent accepted 后生效。
- registered child 同时满足 adopted、proof 被使用、learning refs durable、stored binding 合法时，复用 Foundation 学习入口生成 staged proposal。
- rejected/degraded/unused/ephemeral/critic 默认零学习。
- ephemeral role demand → candidate-maintenance 仍后置；不为完成单轮质量闭环强开第二 gate flip。

**新增测试**：

- `dynamic-delivery-contribution-receipt.test.ts`
- `agent-task-learning-attribution.test.ts`

```bash
npx tsx --test src/__tests__/dynamic-delivery-contribution-receipt.test.ts src/__tests__/agent-task-learning-attribution.test.ts
npm run verify:evolution-p4
npm run typecheck
```

### DD-9 真机 A/B、回归链与默认 adaptive

**新增可执行 runner**：

- `scripts/run-dynamic-delivery-tests.cjs`：内部显式列出全部 focused tests，任一文件缺失就失败，不使用英文占位串。
- `package.json` 真实脚本：

```json
{
  "verify:dynamic-delivery": "npm run verify:agent-foundation && node scripts/run-dynamic-delivery-tests.cjs && node scripts/check-dynamic-delivery-live.cjs && node scripts/check-run-finalize-funnel.cjs && node scripts/check-checkin-funnel.cjs && node scripts/check-ledger-write-direction.cjs && node scripts/check-unwired-capability-markers.cjs && node scripts/check-mandated-capability-is-live.cjs && node scripts/check-shared-enum-drift.cjs && node --test scripts/__tests__/check-shared-enum-drift.test.cjs && npm run verify:native && npm run typecheck"
}
```

**六类真机**：

1. 研究：智识/独立视角检查 claim/evidence，真实联网工具仅 Owner 调用。
2. 内容创作：智识 + 文案前置，Owner candidate，fresh critic，one repair。
3. 视觉/视频方案：美术 + 文案只取相关 Agent，不全员拉齐。
4. 文档修改：worker no-tools，Owner 独占写入/保存，verifier 对读回 artifact/proof。
5. 显式 Skill：Owner selected skill floors/action 完整，worker 只审产物摘要。
6. 高风险动作：worker 只审计计划，Owner confirmation 仍触发，repair 不重放。

**每类发布门**：

- 每类至少 2 fixture，criteria acceptance/proof coverage 不低于 standard；
- 每类 false completion/无证声明/安全绕过均为 0；
- 超时、超预算、worker 失败、verifier 失败、app restart 全部有显式结果；
- 每类至少 1 个 adaptive/thorough 在同一用户轮内 accepted；
- 总体至少 3 类的“需要用户追加一轮才补齐”比例显著低于 standard；
- adaptive 全部在 72k/120s 内或明示降级，thorough 不越 120k/300s 硬顶；
- rejected candidate 在 next turn/restart 后为 0，orphan running delivery 为 0。

所有发布门通过后，同一工单将默认从 standard 切为 adaptive，并更新 AGENTS.md / CLAUDE.md / CHANGELOG。

```bash
npm run verify:dynamic-delivery
npm run verify:evolution-p3
npm run verify:evolution-p4
npm run verify:stability
```

## 5. 共享文件串行矩阵

| 文件/区域 | 独占工单 |
|---|---|
| `migrations.ts` / projection wire | DD-1，DD-4 只消费 schema |
| `quality/packet-compiler.ts` / `packet-fields.ts` | DD-1，DD-6 只移 marker/接 live |
| `quality/packet-failure.ts` / proof / finalizer guard | DD-2，DD-6 只移 marker |
| `parallel-branch-orchestrator.ts` | DD-4 优先只复用；红测证明需要才改 |
| projection sync / repository transaction | DD-4 |
| `agent-sdk-turn-execution.ts` / input assembly | DD-6 |
| model loop / completion / session snapshot | DD-5，DD-6 只接 port |
| main/preload/shared/renderer typed mode | DD-1；UI 在 DD-7 |
| root docs / package scripts | DD-9 |

## 6. 错误、指标与漂移 gate

shared `DeliveryErrorKind` 闭集：

- `delivery_preflight_unknown`
- `delivery_plan_invalid`
- `delivery_profile_unavailable`
- `delivery_parent_projection_unavailable`
- `delivery_packet_tree_transaction_failed`
- `delivery_scheduler_capacity_exceeded`
- `delivery_worker_failed`
- `delivery_worker_report_invalid`
- `delivery_evidence_invalid`
- `delivery_required_package_unsettled`
- `delivery_budget_exhausted`
- `delivery_wall_clock_exceeded`
- `delivery_verifier_unavailable`
- `delivery_repair_exhausted`
- `delivery_restart_checkpointed`

每个事件携 parent run/task、package/attempt/generation（若适用）、executor kind/id、duration、usage source；日志不带完整 prompt、人格/RULES/知识正文、私密路径或 rejected candidate。

`check-shared-enum-drift.cjs` 及脚本测试保证 event error union/映射/指标不漂移。Worker 无 tools，因此这些错误经 runtime event/settlement 传递，不塞进 tool-result-envelope。

## 7. 代码健康与 diff 纪律

- 每单先红测、再实现、再焦点验证、再 typecheck。
- 大文件只留 port/call site，核心逻辑放 `runtime-core/dynamic-delivery/` 叶子模块。
- 任一代码文件增行后检查总行数；超 1000 行按根目录合同更新 `large-file-health-log.md`。
- 不为 Dynamic Delivery 顺手重构 provider、skill、browser、document 或 task card 旁支。

## 8. 明确后置

- worker 真实只读工具与独立 WorkerAuthorization/WorkerFloors；
- background/detached worker 启动与通用 TaskEventBridge 终态路由；
- 进程重启后自动续跑 worker 的 recovery reducer；
- sessionful worker steer/race；
- 每 Agent 独立 model/provider/effort；
- ephemeral role demand 到 candidate-maintenance 的 live gate flip；
- 自动创建/启用/合并 Agent；
- 任意 DAG、循环语言、递归 specialist。

## 9. Closeout 交付

最终 closeout 必须附：

- Foundation AF-0..AF-7 前置证明；
- dormant 期间零 production import 证明；
- parent barrier + packet tree transaction 原子性证明；
- registered/ephemeral profile 隔离与 worker no-tools 证明；
- host-owned criteria/proof/Check-in 和 packet-aware fail-closed 证明；
- child close/attempt/late-result/usage 单计账证明；
- candidate fork、verifier、one repair、next-turn/restart 无拒稿泄漏证明；
- typed mode 端到端和 packet trio 原子 live flip 证明；
- selected Skill/Owner action/safety confirmation 不变证明；
- 12 个真机 A/B fixture 与默认 adaptive 发布门；
- scoped commits、大文件健康评估和明确残余边界。

缺任一项，状态保持 draft/incomplete；“多个模型返回了文字”不等于单轮交付质量提高。

### 2026-07-11 完成证据

- Agent Foundation 前置：`npm run verify:agent-foundation` 通过（含原生数据库验证）。
- Dynamic Delivery 全链：`npm run verify:dynamic-delivery` 通过；focused runner 62 项中 55 项通过、7 项仅因 host ABI 跳过，随后 Electron 原生 8/8 无跳过通过。
- 12 个发布 fixture：每条实际执行 standard + adaptive，共 24 次 live runtime seam 对照；默认已切换为 adaptive，设置页可回 standard，本次发送可临时 thorough。
- 原子性与隔离：真实 SQLite task tree rollback/commit/CAS、candidate accept/block/text repair/artifact repair、可信工具回执保留、拒稿不进入共享会话或恢复快照均有行为测试。
- 安全与归属：worker 唯一 model_subagent/no-tools 通道；Owner 独占工具和外部动作；registered contribution 仅在 adopted + durable proof used 后进入 staged learning。
- 退役与正向门禁：旧三通道/父 Check-in/Proof 路径退役；live/unwired/mandated/error-enum/finalizer/check-in gates 全绿。
- 全局回归：`npm run verify:evolution-p3`、`npm run verify:evolution-p4`、`npm run verify:stability`、`npm run build` 通过。
- 唯一阶段二对抗审查 agent 完成修复循环，最终无未解决 finding。

### 2026-07-11 Boost 60s 误停事故复审

- 实际失败请求的 main/renderer/metrics/SQLite 时间线一致证明：Owner 第一次模型请求仍在运行时，renderer 在 60,000ms 把活性探针错当成停止权限，主动中断了 provider；本次无 planner/worker/verifier/tool 超时。
- 60s renderer watchdog 改为纯活性查询；同 requestId 仍 active 时续期且不停止，真正无进展仍只由 main 守卫收口。
- Boost thorough 值经同步一次性锁存穿透到 sendScoped；thorough 只放宽收益门槛，不越过简单任务和高风险边界。
- adaptive 120s / thorough 240s 是滚动无进展窗口：成功文本增量或工具结果会重置窗口，只有持续无进展才以 `delivery_wall_clock_exceeded` 明示收口；长研究不再被固定总时长切断。
- parent 停止现在会中断所有已派生 worker，已经返回但尚未采纳的 child 结果也不会在停止后写回 parent。
- Dynamic Delivery context 移到最外层回合 finally 唯一关闭；Owner/provider 中途失败时候选草稿不发布、context 不残留。
- 事故回归已纳入 `verify:dynamic-delivery`；该链、Electron 原生 SQLite 用例、typed wire、取消传播、候选隔离与总墙钟用例全部通过。
