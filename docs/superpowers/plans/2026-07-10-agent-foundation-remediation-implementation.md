---
title: 主 Agent / 派生 Agent 根基修复实施计划
date: 2026-07-10
kind: implementation
enforce: false
status: draft v2 — 两轮反方复审已收口，待逐单实施
owner: 白
author: Codex
requires:
  - docs/superpowers/audits/2026-07-10-agent-foundation-audit.md
unblocks:
  - docs/superpowers/plans/2026-07-09-boost-dynamic-workflow-roadmap.md
  - docs/superpowers/plans/2026-07-09-boost-dynamic-workflow-implementation.md
related:
  - docs/superpowers/plans/2026-06-12-agent-evolution-phase3-implementation.md
  - docs/superpowers/plans/2026-06-13-agent-evolution-phase4-implementation.md
  - docs/superpowers/plans/2026-06-22-agent-identity-unification-and-settings-merge-implementation.md
---

# 主 Agent / 派生 Agent 根基修复实施计划

## 0. 完成标准

本计划不是“给 Dynamic Workflow 加一个 profile helper”，而是先把 Agent 系统自己的事实闭环修好。全部完成必须满足：

1. 会话有明确的 active Agent；新 task 从它初始化 owner，continuation 只读目标 task owner，不再读取 scope 最近 task owner。
2. 一个 run 的人格、RULES、knowledge、对外 Agent 身份来自同一个冻结 profile。
3. `scope.agent`、conversation `activeAgentId`、task `ownerAgentId`、`executionBinding`、`SubAgent.lifecycleId` 五种身份语义互不借用。
4. same-session handoff 经用户采纳后原子改变当前 task owner 和会话 active Agent，并由新 profile 在 fresh run 接管；内部 consult/未来 workflow participant 两者都不改。
5. active Agent 的 conversation/handoff/auto-route/collaboration readiness 可由代码解释并展示。
6. disabled/missing/merged owner 有确定性处理；merged redirect 不改写历史 owner。
7. 专项任务学习按实际 execution Agent 归属，仍只产 staged proposal；旧历史不自动补学习。
8. run_meta 持久化每次 run 的冻结 execution binding；task projection 只保留最新执行快照，不冒充历史真值。
9. active Agent/owner/backfill/profile 迁移通过真实 SQLite 验证，现有会话、任务和 Agent 资产无丢失，不伪造无法还原的历史 owner。
10. `verify:agent-foundation`、`verify:evolution-p3`、`verify:evolution-p4`、`verify:stability`、`typecheck` 全绿。
11. 真机验证主 Agent、直接专项会话、same-task handoff、disabled/merged 四条路径。

在上述条件没有完成前，Dynamic Delivery 只能继续写 dark 合同，不得接 live 自动协作。

## 1. 目标合同

### 1.1 `ConversationAgentState`

```ts
interface ConversationAgentState {
  sessionAgentId: string
  activeAgentId: string
  handoffGeneration: number
}
```

- `sessionAgentId` 来自 `scope.agent`，作为稳定 session key/来源身份，不被 same-session handoff 改写。
- `activeAgentId` 是当前会话责任 Agent，新 task 从它初始化 owner。
- `handoffGeneration` 用于阻止旧 run 在接管后迟到覆盖新 Agent 的可见状态。

### 1.2 `TaskAgentBinding`

新增共享类型，主进程是权威生产者：

```ts
type TaskExecutorKind = 'registered_agent' | 'ephemeral'

interface TaskExecutionBinding {
  schemaVersion: 1
  runId: string
  ownerAgentIdAtStart: string
  runOrigin: RunExecutionOrigin
  kind: TaskExecutorKind
  requestedAgentId?: string | null
  effectiveAgentId?: string | null
  ephemeralRole?: string | null
  executionMaterialHash: string
  ownerAssignmentSource: 'conversation_active' | 'continuation' | 'handoff' | 'parent_task'
  executionSelectionSource: 'task_owner' | 'workflow_participant' | 'ephemeral_role'
  resolutionKind: 'direct' | 'merged_redirect' | 'main_fallback'
}
```

`ownerAgentId` 改为新用户 task 必填事实；历史 wire 仍容忍 null。`executionBinding` 允许 registered/ephemeral，为 Dynamic Delivery 留同一字段，不再另加 `executionAgentId` / `boostAgentId` 平行真值。

binding 的权威层级：

1. `run_meta.execution_binding_json`：某一 run 的冻结真值，写入后不改。
2. `task_projections.execution_binding_json`：任务最近一次 run 的查看快照，其 `runId` 必须对应最新 binding，可被后续 run 替换。
3. renderer 只消费 wire，不从 `scope.agent` / owner 反推执行身份。

### 1.3 `TaskCreationOrigin`

```ts
type TaskCreationOrigin =
  | 'user_root'
  | 'workflow_child'
  | 'system_background'
  | 'legacy'

type RunExecutionOrigin =
  | 'initial'
  | 'continuation'
  | 'handoff_takeover'
  | 'workflow_participant'
```

repository 不能靠“owner 是否为 null”猜 task 来源。除 `system_background | legacy` 外的新 task 都必须有 owner；每个 create/sync 入口都必须传不可变 task origin。continuation/handoff 是同 task 的新 run，只写 `run_meta.execution_binding_json.runOrigin`，不改 task origin。

### 1.4 `AgentExecutionProfile`

```ts
interface AgentExecutionProfile {
  requestedAgentId: string
  effectiveAgentId: string
  personaRef: string
  name: string
  charter: string
  personality: string
  rules: string
  knowledgeIndex: string
  allowedKnowledgeRefs: string[]
  knowledgeWriteOwnerAgentId: string
  knowledgeWriteNamespace: `agents/${string}/knowledge`
  executionMaterialHash: string
  readinessRevision: string
  redirectChain: Array<{ from: string; to: string; reason: 'merged' }>
  readiness: {
    conversationReady: boolean
    handoffReady: boolean
    autoRoutable: boolean
    collaborationReady: boolean
    reasons: string[]
  }
}
```

readiness 是 assets + lifecycle 的派生事实，不新增第二个 registry status：

- `conversationReady`：active registry + 可加载 personality/fallback。
- `handoffReady`：conversationReady + 非 main + 有明确 charter + RULES。
- `autoRoutable`：handoffReady + active routing card。
- `collaborationReady`：handoffReady + 可机械验证的 FOUNDATION pack + scoped knowledge 读取边界可建立。

persona-only Agent 可以由用户直接选择，但不会被自动路由或自动协作。内置专项 Agent 应四项全 true。

### 1.5 Profile 解析规则

1. active requested Agent：直接加载。
2. merged requested Agent：有限追踪 merge chain，必须终止于 active target；检测环/断链，保留完整 redirectChain，历史 owner 不变。新 merge 确认时压平 inbound 指针，不制造 A→merged B→C 的新链。
3. disabled/missing/非法 requested Agent：降级到 `butler` 的 global profile；不得回退读取另一个专项 Agent。
4. 人格、RULES、knowledge 从 effective Agent 一次性解析；不允许 prompt assembly 分别再查。
5. `personaRef` 若指向另一个合法人格，保留现有引用语义；引用 id 和人格内容同时进 `executionMaterialHash`。
6. 每次 run 开始时冻结 profile 到 run-local TurnState；本轮 prompt/tool 只读该 snapshot，不再从可被后续 run 改写的 `session.systemPrompt` 取人格。
7. `executionMaterialHash` 只覆盖真正进 prompt/授权的人格、RULES、active knowledge 内容与 allowlist；`readinessRevision` 另行覆盖 routing、FOUNDATION、lifecycle。
8. FOUNDATION 不进入每轮 prompt。builtin 以 preset + 非空 asset 校验；派生 Agent 以 confirmed blueprint、`SPECIALIST_FOUNDATION_PACK_VERSION` 与文件哈希校验；不用 LLM 语义判断作 readiness 硬真值。

### 1.6 Owner 解析规则

```text
new conversation             -> activeAgentId = resolveValidActiveAgent(scope.agent)
existing task / continuation -> task.ownerAgentId
new task                     -> conversation.activeAgentId
same-session accepted handoff-> atomically update task owner + conversation activeAgentId
accepted handoff continuation-> fresh run with target profile and incremented handoffGeneration
```

新建时：active 直用；merged 解析到最终 active target；missing/disabled/非法 id 降级为 `butler` 并记断开原因。复用已有会话时不得用 `scope.agent` 重置已转办的 active Agent；若已存 active id 后来失效，在新 task 写入前原子修复到 merge target/主 Agent 并给 UI 诊断。

主 Agent也写显式 `butler`，不再用 null 表示“默认大概是主 Agent”。若未来需要“只转当前任务”，必须增加独立用户选项，不能偷偷改变现有“当前会话继续”的持续语义。

## 2. 数据迁移

### Migration 066：conversation active Agent + task execution identity

实施前先检查 `migrations.ts` 当前最大编号；若 066 已被占，按 sequential gate 使用下一个空号，文档同步改号。

新增：

- `chat_conversations.active_agent_id TEXT`
- `chat_conversations.handoff_generation INTEGER NOT NULL DEFAULT 0`
- `task_projections.task_origin TEXT`
- `task_projections.execution_binding_json TEXT`
- `run_meta.execution_binding_json TEXT`

回填会话 active Agent：优先承接当前实现中“最近且仍 active 的非空 task owner”；否则对会话自身 `agent` 做同一 valid/merged/fallback 解析。指向已删除/已停用 Agent 的最近 owner 不能污染新会话状态，但历史 task owner 保留。

只回填无歧义 scope 的历史 owner：

```sql
UPDATE task_projections
SET owner_agent_id = (
  SELECT chat_conversations.agent
  FROM chat_conversations
  WHERE chat_conversations.id = task_projections.scope_id
)
WHERE owner_agent_id IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM task_projections AS handed_off
    WHERE handed_off.scope_id = task_projections.scope_id
      AND handed_off.owner_agent_id IS NOT NULL
  )
  AND EXISTS (
    SELECT 1 FROM chat_conversations
    WHERE chat_conversations.id = task_projections.scope_id
  );
```

约束：

- 已有非空 owner 永不覆盖，即使 Agent 已删除。
- 只要某 scope 曾出现过非空 owner，该 scope 其他历史 null owner 全部保留；无可靠事件日志时不猜每条任务的接管时点。
- 找不到 conversation 的系统/后台 task 可继续 null，读取时由 legacy fallback 处理；新用户 task 不得再写 null。
- 不回填 `execution_binding_json`，避免伪造历史实际 profile。
- 历史 `task_origin` 回填为 `legacy`；新写必须使用 closed origin。
- 不因回填触发 learning proposal、routing、reflection 或 emergence。

迁移测试必须用真实 better-sqlite3：构造 main scope、specialist scope、有效 handoff owner、孤儿 handoff owner、conversation agent=disabled/missing/merged、缺失 conversation，并证明：active Agent valid/redirect/fallback 正确；旧会话再 upsert 不重置已持久化 active Agent；正常 conversation 回填后 activeAgentId 非空；迁移重跑幂等；只回填无歧义 task。

## 3. 工单顺序

## AF-0：合同与红测试（dark）

**目标**：先把身份矩阵钉死，零生产行为变化。

**改动**：

- 新增 `src/shared/agent-execution-profile.ts`：共享 wire 类型和 closed unions。
- 新增 `src/main/modules/agent-control/agents/agent-execution-profile.ts`：先放 pure resolver interface/fake asset reader。
- 新增 `src/__tests__/agent-execution-profile-contract.test.ts`。
- 新增 `src/__tests__/task-agent-binding-contract.test.ts`。

**红测试矩阵**：

- scope=butler、active=butler/new task → owner=butler。
- scope=analyst、active=analyst/new task → owner=analyst。
- scope=butler、active=copywriter/new task → owner=copywriter，保留当前会话接管语义。
- continuation task owner=copywriter → owner=copywriter，不看 scope 最近 owner。
- continuation/handoff takeover 保留原 taskOrigin，新 run binding 分别写 `runOrigin=continuation|handoff_takeover` 和冻结 ownerAgentIdAtStart。
- handoff task A 后创建 task B → B 从 conversation active Agent 初始化，不扫描 A。
- 旧 run generation 在 handoff takeover 后迟到 → 不得覆盖新 run。
- registered execution binding 与 owner 可不同；participant 不改 owner。
- ephemeral binding 不能携 registered agent id。
- invalid/disabled requested Agent 不得读取 scope 中另一个专项 Agent。
- merged redirect 有限追链到 active target；循环/缺目标拒绝，新 merge 压平 inbound 指针。

**验证**：

```bash
npx tsx --test src/__tests__/agent-execution-profile-contract.test.ts src/__tests__/task-agent-binding-contract.test.ts
npm run typecheck
```

## AF-1：owner 真值与迁移

**目标**：修复专项会话 owner 为空，并用明确会话 active Agent 替换 scope 最近 task owner 推测。

**改动**：

- `src/main/modules/migrations.ts`：Migration 066。
- conversation scope/repository/wire：新增 `activeAgentId` / `handoffGeneration`。
- `src/shared/ipc-contracts/task-projection.ts`、run contracts：新增 `executionBinding` wire 字段。
- `task-projection-repository.ts`：读写/JSON 校验；按 `TaskCreationOrigin` 执行 owner 非空守卫。
- 穷举并改造所有 live create/sync 入口，包括 `task-projection-sync.ts`；没有 origin 的入口编译/运行时响亮失败。
- 新增 `task-projection/task-agent-binding.ts`：`resolveTaskOwner()` 纯函数 + repository adapter。
- `run-coordinator.ts`：taskId 生成后先解析当前 task owner；new task 使用 conversation active Agent；started event 同步携 owner/generation。
- `runtime.ts`：移除 live `getLatestOwnerAgentForScope` 注入；continuation 传明确 target task id/owner。
- 旧 repository helper 若无其他 live caller 则删除；若测试/迁移仍需，改名并标 legacy-read-only，不可再进 run path。

**行为**：

- new task owner 取 conversation active Agent 并写 projection；新会话 active Agent 先经 valid/merged/fallback 解析。
- taskId 解析顺序固定为：显式 request taskId → 已归一化 continuation target taskId → 新 UUID；continuation target 必须属于当前 scope。
- continuation 取指定 task owner；target owner=`butler` 时 preroute effect 为 none，不建议“转给 Ready 自己”。
- background/system task 暂无 conversation 时走 legacy null，不冒充用户 owner。
- 只有显式 task origin=`system_background | legacy` 可 owner=null；`user_root | workflow_child` 必须非空。continuation/handoff takeover 不创建新 task，它们的 run binding 必须冻结非空 `ownerAgentIdAtStart`。
- 迁移修 active Agent 和无歧义 owner，不产生 execution binding 或学习副作用。

**测试**：

- 新增 `migration-task-agent-binding.test.ts`（必须 `verify:native`）。
- `run-coordinator-task-owner.test.ts`：新任务/续跑/显式会话接管/旧 latest-owner 推测回归。
- `task-projection-origin-writers.test.ts`：枚举所有 production create/sync 路径，证明 origin/owner 组合合法。
- `per-agent-injection.test.ts` 更新为 task-specific owner，不再用 scope latest fixture。

**验证**：

```bash
npx tsx --test src/__tests__/migration-task-agent-binding.test.ts src/__tests__/run-coordinator-task-owner.test.ts src/__tests__/task-projection-origin-writers.test.ts src/__tests__/per-agent-injection.test.ts
npm run verify:native
npm run typecheck
```

## AF-2：单一 `AgentExecutionProfileResolver`

**目标**：人格、RULES、knowledge、生命周期、readiness 从一处解析。

**改动**：

- 完成 `agent-execution-profile.ts`：注入 registry/personality/store/file reader，不自己拿全局 singleton。
- `belief-card-store.ts` 只增加 resolver 需要的 scoped active inventory 读取；不开放任意路径。
- `runtime.ts` 持有一个 resolver 实例，注入 prompt assembly、Studio、后续 worker runtime。
- 分开计算 `executionMaterialHash` 与 `readinessRevision`，两者都不含绝对用户目录。
- 身份相关的 `memory_read_card` / `memory_write_card` 不再仅按 `context.scope.agent` 判定；dispatch 层分开消费冻结 profile 的 read allowlist 与 staged-write namespace。

**readiness 细则**：

- 缺 personality 时可用 registry fallback 形成 conversationReady，但记录 `personality_fallback`。
- 缺 RULES：handoff/collaboration false。
- 缺 FOUNDATION：collaboration false，但不妨碍用户直接会话。
- 无 active routing：autoRoutable false。
- staged knowledge 不进 index/hash 的 active inventory，也不可读。
- “关闭 Agent 知识”只关闭 knowledge cards，不关闭 RULES；RULES 与 knowledge toggle 分支不再共用。
- 非主 Agent 的 global knowledge index 排除 routing 控制卡；routing 只在主 Agent 预路由通道可见。
- `allowedKnowledgeRefs` 在 tool dispatch 层强制，只表达可读的已有 active 卡；合法路径不等于本 run 已授权读取。
- `knowledgeWriteOwnerAgentId/knowledgeWriteNamespace` 只允许在 effective Agent 的命名空间创建 staged proposal/card，不要求新路径事先存在 read allowlist，也不能直接写 active。
- persona-only Agent 必须可在 Studio 看见“可聊天，不可自动协作”及缺项。

**测试**：

- builtin 三 Agent readiness 全 true。
- persona-only 仅 conversationReady。
- blueprint Agent routing staged 时 autoRoutable false。
- disabled/missing/merged 矩阵。
- sibling/staged knowledge 不泄漏。
- knowledge toggle 关闭后 RULES 仍在；专项 Agent 不看 global routing 控制卡。
- `memory_read_card` 不能绕过 profile allowlist 读 sibling/staged card；identity-sensitive write 只能进冻结 staged-write namespace，不与 read refs 混用。
- 同一 snapshot hash 稳定；资产变化只影响下一次 resolve。

**验证**：

```bash
npx tsx --test src/__tests__/agent-execution-profile.test.ts src/__tests__/agent-routing-injection.test.ts src/__tests__/agent-scope-card-coverage.test.ts src/__tests__/agent-knowledge-toggle-boundary.test.ts src/__tests__/agent-memory-tool-allowlist.test.ts
npm run verify:agent-identity
npm run typecheck
```

## AF-3a：主回合身份事实统一

**目标**：一个 run 只使用一个 effective profile，同时保留同一 conversation session。

**改动**：

- `prompt-assembly.ts`：删除各自解析 soul/owner rules/knowledge 的分叉，改收冻结 profile；main-only roster 判定改用 `effectiveAgentId === butler`。
- `RunCoordinator` 的 prepared payload 增 `executionBinding/executionMaterialHash`。
- `ExecutionHostRequest` / `AgentSdkExecutionOptions` 显式携 `sessionAgentId` 与完整 `executionBinding`；若 wire 暴露 `executionAgentId`，它只能是 `binding.effectiveAgentId` 的派生展示值。
- Agent SDK session key 继续使用 scope/session，保证会话连续；provider profile/tool audit 使用 effective execution Agent。
- 现有 `ScopeRunEventPayload.agent` 和 `run_meta.agent_id` 先保留 session/routing key 语义，禁止直接替换为 execution Agent 导致事件丢失；wire/event 新增 `executionBinding`，`executionAgentId` 仅作其派生展示值。
- run 开始时将冻结 `executionBinding` 写入 `run_meta`；task projection 持久化最新 binding 快照；renderer 不自行从 scope/legacy `agent` 猜。
- TurnState 持有该 run 的冻结 profile/system prompt/material hash；model loop、input assembly 和 tool context 不从可变 `session.systemPrompt` 重读。
- `ToolContext` 新增不可变 execution binding/profile allowlist，穷举 memory、reflection、artifact attribution 等身份敏感工具，禁止它们继续只看 `scope.agent`。
- session recall 继续按 conversation lineage 工作，不因 profile 切换丢历史。

**关键行为**：

- 主 scope 普通任务：butler persona/rules/knowledge。
- analyst scope：analyst persona/rules/knowledge，owner=analyst。
- butler scope task handoff 至 copywriter：旧 profile run 在 takeover 边界收口，原话/refs 不变地转入 fresh copywriter run；session 历史不丢，copywriter persona/rules/knowledge/输出身份一致。
- 该 scope 再建新 task：从明确的 conversation active Agent=copywriter 初始化，不依赖旧 task 排序；用户显式切回 Ready 后才恢复 butler。
- invalid/disabled owner：butler global profile + 可见诊断，不读取 scope 的其他专项资产。

**测试**：

- `agent-profile-prompt-coherence.test.ts`：人格/RULES/knowledge 三者同 id。
- `handoff-profile-switch.test.ts`：旧 run 不冒充新 Agent、fresh takeover、后续新 task 从 active Agent 初始化。
- `run-meta-execution-agent.test.ts`：run_meta 与 projection binding 一致。
- `run-event-routing-identity.test.ts`：session `agent` 仍能匹配活跃 run，execution Agent 作为独立字段展示；二者不互相冒充。
- `run-binding-history.test.ts`：同 task 多 run/中途 handoff 后，run_meta 各自保留冻结 binding，projection 只指最新一次。
- `task-run-origin-separation.test.ts`：taskOrigin 不因 continuation/handoff 改写，每次 runOrigin/ownerAgentIdAtStart 各自冻结。
- `run-local-profile-snapshot.test.ts`：后续 run 改写 session 资料不影响已开始 run；identity-sensitive tools 按 execution binding 而非 scope 归属。
- 更新 `verbatim-relay.test.ts`：身份切换不改用户原话。

**验证**：

```bash
npx tsx --test src/__tests__/agent-profile-prompt-coherence.test.ts src/__tests__/handoff-profile-switch.test.ts src/__tests__/run-meta-execution-agent.test.ts src/__tests__/run-event-routing-identity.test.ts src/__tests__/run-binding-history.test.ts src/__tests__/task-run-origin-separation.test.ts src/__tests__/run-local-profile-snapshot.test.ts src/__tests__/verbatim-relay.test.ts
npm run verify:stability
npm run typecheck
```

## AF-3b：run usage 单一累计权威

**目标**：同一 run 的多次 provider 调用按加法累计，不被最后一次覆盖，也不被 repository additive API 与 closeout 整值写双算。

**改动**：

- 新增纯函数 `addRunUsage()` / `RunUsageAccumulator`，作为运行中唯一累计真值。
- `agent-sdk-turn-model-loop.ts` 每次 provider 返回 usage 只加入 accumulator。
- `run-meta-repository` 的 additive API 和 closeout 整值 update 不能同时作为 usage writer；保留一条逐次持久化或一次 closeout 路径，另一条在代码/gate 中禁止。
- finalizer 只接收 accumulator 总值；retry 只在得到新 provider usage 时计一次。
- provider 不回 usage 时记录 `usageSource='estimated'|'missing'`；本根基阶段不伪造 token。

**测试**：

- 3 次 provider 调用的 run_meta 等于三次之和，不是第 3 次。
- stream/non-stream/retry/缺 usage 矩阵。
- additive repository 与 closeout 双 writer 结构 gate。

**验证**：

```bash
npx tsx --test src/__tests__/run-usage-accumulator.test.ts src/__tests__/run-meta-usage-single-writer.test.ts
npm run verify:streaming
npm run typecheck
```

## AF-4：路由、handoff 与生命周期统一消费 readiness

**目标**：切换、转办、协作的边界清楚；active 不再等于自动可用。

**改动**：

- `session-preroute-service.ts`：自动/建议 routing 只消费 `autoRoutable` profile；continue 仍状态优先。
- `prompt-assembly.ts` main roster：只列 handoffReady；标注哪些是 persona-only，不注入为可转办对象。
- `handoff-proposal.ts`：目标必须 handoffReady；当前 active Agent 非主 Agent 时，也允许经用户确认转回 `butler`。
- `continuation-state.ts` / shared continuation wire 新增 closed `handoff_takeover` variant，只携原话、canonical ref ids、taskId、target Agent 和 generation，不携自由 prompt。
- 采纳后先在同一 DB transaction 写 task owner + conversation active Agent + task-scoped generation，将 projection 收成 takeover checkpoint，并将原话/refs/taskId 写入现有 `continuation_ref_json` 的 typed `handoff_takeover` variant；任一写入失败全回滚。
- tool dispatch 返回 host-only `handoff_takeover` 控制信号；model loop 立即停止旧 profile，同批尚未执行工具不再发送。
- 旧 run 经 `finalizeRunOutcome()` 以 checkpoint/takeover 收口，host 再用 `runOrigin='handoff_takeover'` 自动启动同 task 的 fresh run；不再用工具文案让旧模型“当场扮演”新 Agent。
- 旧 run finalizer 仍必须关闭自己的 run_meta，但在 generation 已被 takeover 推进时以 `projectionWriteMode='none'` 收口，不再改当前可见 projection；fresh run 是新可见状态的唯一 writer。
- generation fence 键是 `taskId + priorRunId + handoffGeneration`，不是整个 scope；不得误杀同 scope 的 background/child task。
- transaction 已成功但 fresh run 启动前崩溃时，启动 reconciliation 从 typed continuation ref 自动启动一次 takeover；使用 generation/consumed 标记防重。
- `agent-registry-group.ts` / lifecycle：新写只接受 active/disabled/merged；retired 仅旧值读取兼容。
- merged runtime resolver：历史 owner 保留，execution profile redirect；UI 显示 from→to。
- `AGENTS.md` / `CLAUDE.md` 后续同步新的生命周期合同，删除 active→retired 单向旧说法。

**不做**：

- 不让 merged redirect 改写历史 task owner。
- 不让 persona-only Agent 被自动 handoff/route/collaborate。
- 不把 FOUNDATION 文本解析成工具权限。

**测试**：

- routing 卡命中但 Agent 不 ready → 主 Agent fallback + 原因。
- persona-only 可手动开会话但不可自动 route/handoff。
- same-session handoff 采纳后旧 run checkpoint，新 Agent fresh run 接管，原话/refs 逐字不变；重启后 active Agent 保留。
- specialist→butler 转回路径同样需要用户确认和 fresh takeover；主 Agent 不能给自己发转办建议。
- takeover transaction 任一写入失败全回滚；同批剩余 tool calls 不执行；旧 generation 迟到不覆盖。
- disabled 可恢复 active；merged 不可恢复；retired 新写拒绝。
- merged redirect、缺失目标、循环防护。

**验证**：

```bash
npx tsx --test src/__tests__/session-preroute.test.ts src/__tests__/agent-handoff-proposal.test.ts src/__tests__/handoff-takeover-boundary.test.ts src/__tests__/agent-lifecycle.test.ts src/__tests__/agent-execution-readiness.test.ts
npm run verify:evolution-p4
npm run typecheck
```

## AF-5：直接专项任务学习按 run binding 归属

**目标**：先修复直接专项会话的学习漏失；workflow contribution 的“被父任务采用”事实等 Dynamic Delivery 有持久化 settlement 后再接，本阶段不先造空字段。

**改动**：

- `specialist-task-evolution-proposals.ts`：从 accepted root task 对应的 `run_meta.execution_binding_json` 读取学习 Agent，不再只认 owner，也不拿当前资产重算 hash。
- 普通 root run 要求 stored binding effective Agent = `ownerAgentIdAtStart`、final Check-in accepted、learning refs 非空；不拿后续 handoff 后的当前 task owner 反改旧 run 归属。
- 仍要求 active specialist、final accept、learning refs 非空；仍只 upsert staged proposal。
- 不读取历史迁移前空 binding；不 retroactively 扫 623 条任务。

**测试**：

- analyst 直接会话 + accepted + learningRefs → staged analyst proposal。
- handoff 后 copywriter execution → staged copywriter proposal。
- ephemeral / rejected / degraded / 无 durable refs / 无 stored run binding → 全部 skip。
- stored binding 缺 schemaVersion/runId/ownerAgentIdAtStart/effectiveAgentId/material hash 任一必填字段 → fail loud，不写错 Agent；学习侧不用后来资产重算 hash。
- resolver 构造 binding 时负责 id/material 一致性；run_meta 写入后不可变，并用 gate 禁止其他 production binding producer。

**验证**：

```bash
npx tsx --test src/__tests__/specialist-task-evolution-proposals.test.ts src/__tests__/agent-task-learning-attribution.test.ts
npm run verify:evolution-p3
npm run verify:evolution-p4
npm run typecheck
```

## AF-6：Studio 与任务卡表达事实

**目标**：用户能区分“这是谁的会话、当前由谁接管、谁负责这个任务、这次由谁执行”，不靠猜。

**改动**：

- Agent Studio read model 增 readiness flags/reasons/readinessRevision 摘要。
- Agent 管理页显示“可聊天 / 可转办 / 可自动路由 / 可协作”，缺项给修复入口。
- 会话顶部/输入区同时显示 session Agent 与 active Agent，例如“Ready 会话 · 当前由文案负责”；不用单个头像把两层身份混成一个。
- Task card 显示 owner；当 execution binding 不同于 owner 时显示“由 X 协作执行”。
- same-task handoff 后后续消息/任务卡显示 effective Agent，conversation 不被偷偷复制。
- assistant message meta 持久化 `runId`、`executionAgentId`、`displayNameSnapshot`、`executionMaterialHash`；重启后不从 conversation agent 重猜旧消息作者。
- Studio 将“负责的任务”和未来“参与的任务”分开统计。

**测试**：

- persona-only readiness UI。
- owner/executor 同一时不重复显示。
- owner/executor 不同时两者语义正确。
- same-session handoff 后顶部显示“原会话 · 当前负责 Agent”；显式切回主 Agent 后更新。
- 重启后历史 assistant 消息依持久化 meta 显示原执行 Agent。
- deleted/merged Agent 使用历史显示名/fallback，不崩 UI。

**验证**：

```bash
npx tsx --test src/__tests__/agent-system-studio-render.test.tsx src/__tests__/task-card-action-render.test.tsx src/__tests__/agent-readiness-ui.test.tsx src/__tests__/assistant-message-execution-identity.test.tsx
npm run test:ui-contracts
npm run typecheck
```

## AF-7：正向 gate、回归链与真机验收

**目标**：避免以后又出现“两套解析源”和 owner 重新粘连。

**新增 gate**：

1. `check-agent-execution-profile-single-source.cjs`
   - prompt assembly、worker runtime 只能从 resolver 获取 per-Agent persona/rules/knowledge；
   - 禁止重新出现 `scope.agent` 读人格 + owner 读知识的双源组合；
   - run 内只读 TurnState 冻结 profile，run_meta binding 是跨重启审计真值；
   - 只有 resolver/binding factory 可构造 production binding，已写 run_meta binding 不得被 closeout 改写。
2. `check-task-owner-resolution-single-source.cjs`
   - live run path 禁止调用 `getLatestOwnerAgentForScope`；
   - new task owner 与 continuation owner 必须走 `resolveTaskOwner`；conversation active Agent 只能由 scope 创建/显式 handoff 更改；
   - 所有 projection create/sync 入口必须传 closed origin。
3. `check-agent-learning-attribution.cjs`
   - specialist root-task learning 必须消费 run_meta stored binding；
   - ephemeral/历史空 binding/未定义 child contribution 不得写 specialist proposal。
4. `check-run-usage-single-writer.cjs`
   - model loop 不得覆盖式写最后一次 usage；
   - repository incremental writer 与 closeout total writer 只能有一条 live 路径。

**新增回归入口**：

```json
{
  "verify:agent-foundation": "identity/profile/owner/usage/learning focused tests + four gates + verify:native + typecheck"
}
```

**真机验收**：

1. Ready 会话：发普通任务，DB owner=butler，profile=butler。
2. 智识会话：完成带 learning ref 的任务，DB owner/execution=analyst，出现 staged proposal。
3. Ready 会话把当前 task handoff 给文案：旧 run 不冒充文案，fresh takeover 的人格/规则/知识/显示均为文案；同 scope 后续新 task 仍由文案负责，直到用户显式切回。
4. 停用一个 persona-only Agent：不可自动路由；手动恢复后仅 conversationReady。
5. 合并测试 Agent：旧 task owner 保留，execution redirect 到目标，UI 有说明。
6. 重启 Ready：owner/profile/binding 与任务卡一致，无 session 丢失。

**全量验证**：

```bash
npm run verify:agent-foundation
npm run verify:evolution-p3
npm run verify:evolution-p4
npm run verify:stability
npm run typecheck
```

## 4. 共享文件与串行窗口

以下文件只允许一个工单在改，避免 dirty tree 互相覆盖：

| 文件 | 独占工单 |
|---|---|
| `migrations.ts` | AF-1 |
| conversation scope/repository/wire | AF-1，AF-4 只调 handoff 写入 |
| `task-projection-repository.ts` / wire | AF-1 |
| `prompt-assembly.ts` | AF-3，AF-4 只在 AF-3 合并后追加小改 |
| `runtime.ts` / `run-coordinator.ts` | AF-1 → AF-3 串行 |
| `specialist-task-evolution-proposals.ts` | AF-5 |
| Agent Studio / TaskCard | AF-6 |
| `AGENTS.md` / `CLAUDE.md` | AF-7 同批同步 |

当前工作树已有大量与 skill/runtime closeout 相关的用户改动；真正开工前必须先隔离本计划文件集，不能在现有混合 dirty tree 上批量提交。

## 5. 代码健康约束

AF-3 会触碰超过 1000 行的 `prompt-assembly.ts`，AF-1/AF-3 也可能触碰大文件 runtime。每单收尾按根目录合同检查总行数并更新 `docs/code-health/large-file-health-log.md`；不借本计划顺手做无关拆分。若新增逻辑会继续显著抬高大文件，优先把 resolver/task binding 做成叶子模块，只在原文件保留调用点。

## 6. Gate flip 与 Dynamic Delivery 的交接条件

AF-7 全绿后，Dynamic Delivery 才可开始 live 实施。交接必须提供：

- `resolveTaskOwner()` 的正式 API；
- conversation active Agent / handoff generation 的正式 API；
- `AgentExecutionProfileResolver` 的正式 API；
- `TaskExecutionBinding` wire/repository；
- registered Agent 的 readiness 与 scoped knowledge allowlist；
- additive run usage 的当前合同；
- owner/executor UI 表达；
- SQLite 真机证明。

Dynamic Delivery 不得绕过这些 API 自己查 registry、拼 Agent 路径或复制 prompt assembly。

## 7. 明确后置

以下内容不属于本根基修复，留给 Dynamic Delivery：

- packet compiler/dispatch/failure live gate flip；
- 并行 model worker；
- reviewer / verifier / repair；
- workflow participant UI；
- workflow child `contributionAccepted` 持久化 receipt 与学习归属；
- ephemeral role demand → candidate-maintenance live 信号；
- Boost/adaptive/thorough 产品开关。

## 8. Closeout 要求

每个工单必须单独 commit、先红后绿、报告实际验证结果。最终 closeout 需同时附：

- 源码/合同差异；
- migration 前后 DB 行数与 owner 分布；
- 四条真机路径截图或日志；
- staged proposal 证据；
- 三个新 gate 输出；
- p3/p4/stability/native/typecheck 输出；
- 未解决项（若有）及为何不阻塞 Dynamic Delivery。

任何一项未跑或 skip，都不能把本计划标为完成。
