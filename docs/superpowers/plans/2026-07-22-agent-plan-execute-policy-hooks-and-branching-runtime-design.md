---
title: Agent 长程 Plan-and-Execute、策略与分支运行时架构计划
date: 2026-07-22
kind: architecture-plan
status: approved-direction-blocked-by-browser-sequential-closure
enforce: false
owner: 白
author: Codex
refined_by:
  - docs/superpowers/specs/2026-07-24-ready-agent-browser-target-architecture.md
  - docs/superpowers/plans/2026-07-24-agent-runtime-rearchitecture-implementation.md
implementation_exclusion:
  - 本计划不得与 2026-07-24 Agent 计划分别建表或独立进入生产；07-22 ExecutionPlan ledgers 是唯一调度底座，07-24 只补 Task/Turn/Item 与 Browser/恢复合同
  - 唯一切换顺序为 A0–A5 → Browser B0/spike/B1–B5 → Agent A6+Browser B6 联合切换 → A7+B7
implementation_workspace: /Users/user/实验田/ready-cowork-agent-renew (branch codex/agent-renew)
implementation_gate: pending_browser_sequential_closure（用户已于 2026-07-22 确认方向与范围）
blocked_by:
  - docs/superpowers/plans/2026-07-22-browser-agent-sequential-long-task-and-tab-ownership-closure-implementation.md
requires:
  - docs/superpowers/audits/2026-07-22-browser-agent-long-task-root-cause-and-evidence.md
  - docs/architecture/current-runtime-contracts.md §5
  - docs/architecture/codebase-map.md
  - .claude/architectural-principles.md
related:
  - docs/superpowers/plans/2026-07-09-boost-dynamic-workflow-roadmap.md
  - docs/superpowers/plans/2026-07-09-boost-dynamic-workflow-implementation.md
  - docs/superpowers/plans/2026-06-11-agent-evolution-phase1-implementation.md
  - docs/superpowers/plans/2026-06-12-agent-evolution-phase3-implementation.md
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-06-13-agent-evolution-phase4-implementation.md
review:
  reviewer: Claude
  date: 2026-07-22
  verdict: direction-adopted-with-scope-adjudication
  adjudication: docs/superpowers/plans/2026-07-22-agent-long-task-remediation-roadmap.md
  scope_delta: 吸收 Browser 顺序收口计划 §1.5 四张 interaction 持久表（归入 P3）；§1.5.1 账本本就与本文 §2.2 同源，P1 为唯一建表地
  boost_note: 两份 boost 文档已在其自身 §0 取消（无代码落地）；本文 §12.4 与其无冲突，不需用户重裁
documentation_status: archived-in-place
archived_at: 2026-09-06
---

> 原位归档（2026-09-06）：固定历史证据仍引用此路径。保留此路径不代表全文仍是当前合同；其中的状态、源码位置和待办属于原记录。现行约束见 [当前运行时合同](../../architecture/current-runtime-contracts.md)，归档去向见 [文档清单](../../documentation-inventory.md)。

# Agent 长程 Plan-and-Execute、策略与分支运行时架构计划

## 0. 总结论

用户转述的方向成立，但 Ready 不应把它简化为“用 Plan-and-Execute 整体替换 ReAct”，也不应把 hooks/middleware 变成可以截断任意控制流的插件链。

目标架构是混合式：

```text
原始用户请求
  -> 一份持久、版本化的 ExecutionPlan
  -> 代码选出当前可执行节点
  -> 现有 SDK 模型-工具循环只执行这一个节点
  -> 节点证据检查 + clean checkpoint
  -> 下一节点 / 有界重新计划 / 分支 join
  -> 唯一 fresh CompletionVerifier
  -> finalizeRunOutcome()
```

也就是：**ReAct 降为节点内叶子执行器；Plan-and-Execute 成为长任务的代码控制面。**

本计划不采信外部文章中“成功率提升 20%”为 Ready 事实。必须先冻结 Ready 自身基线，再用成功率、假完成、重复动作、恢复率、时间和上下文成本证明收益。

用户已于 2026-07-22 确认本架构方向与范围（含 roadmap 裁决：请求/预算账本唯一建表地在 P1、interaction 持久表归 P3、P1 必含用户可见价值出口）。当前唯一实施阻塞是配对 Browser 收口计划 A1–A12；其全部通过后将 frontmatter 同步改为 `approved-for-implementation / enforce: true`，方可进入生产实施。

## 0.1 开工硬门

任何生产实施前，必须同时满足：

1. 配对 Browser 顺序收口计划 A1–A12 全部通过。
2. 用户确认本计划的真值边界、分阶段顺序和并行范围。（已于 2026-07-22 满足，见 roadmap §5）
3. 当前 Dynamic Delivery 基线、Browser 基线和普通长任务基线有可重放报告。
4. 数据迁移、计划 CAS、节点 attempt、资源 claim、候选隔离和 finalizer 合同已写成失败测试。

该硬门允许继续完善文档和 fixture，不允许“先接一半调度器、后补持久真值”。

## 0.2 总完成标准

1. 每个被正式纳入计划运行时的长任务有唯一 canonical `ExecutionPlan`；TaskProjection、TurnFrame、提示文本和模型输出都不是调度真值。
2. 每个节点有稳定 identity、依赖、验收条件、预期产物、副作用等级、资源声明、预算和重试策略。
3. 每次节点重派/replan 创建新 attempt/revision/call scope，不原地改写旧事实；尚未产生语义输出或工具效果的 provider request transport retry 是唯一可在同 call scope 内进行的例外。
4. 提示词只做语义理解；依赖门、资源冲突、权限、重试、降级、预算和终态由代码执行。
5. 三层策略有固定优先级：安全硬规则 > 代码合同 > 用户声明偏好 > 运行时自适应。
6. hooks 只是具名观察者，不改任务真值、不授权、不决定重试、不拦截 finalizer。
7. 负责写入、确认和外部动作的 Owner 唯一；并行从只读、互相独立的节点开始。
8. 候选分支在 fresh verifier 接受前不进共享 session、消息 DB、产物真值或最终投影。
9. 唯一 CompletionVerifier 零工具、只读 sealed evidence；Browser 和 Dynamic Delivery 不串联两个最终 verifier。
10. 任意重启、取消、子分支失败或旧 attempt 迟到，不导致重复副作用、旧结果覆盖 winner 或父任务假完成。
11. 未进入 ExecutionPlan 的直接任务零 planner/worker/verifier 额外调用。
12. 受控长任务套件成功率 >=95%，假完成、重复未知写入、越权资源写入和双终稿均为 0；性能阈值见 §10。

## 1. 当前底座真实状态

| 能力 | 现状 | 处置 |
| --- | --- | --- |
| Agent SDK 模型-工具循环 | live；有滚动 checkpoint、compaction、错误分类和有界重试 | 保留，收缩成单节点执行器 |
| Browser work items / journal / evidence / checkpoint / verifier | live；域内真值较完整 | 保留为 Browser 节点的域内状态，不复制到通用 plan |
| Dynamic Delivery `DispatchPlan / WorkPackage` | live；只支持一层无依赖包 | 一次性迁移为 ExecutionPlan proposal/node，不建第二套并行计划 |
| Dynamic Delivery worker | live；`tools: []`、`maxTurns: 1` | 继续作为前置独立分析节点，不伪装成执行 Agent |
| `parallel-branch-orchestrator` | live；仅进程内 Map + Promise + 协作取消 | 只作为节点 runner primitive；分支真值、恢复和 join 移到持久 scheduler |
| Candidate session fork + verifier | live；可隔离候选文本 | 复用并扩展为分支候选隔离 |
| TaskProjection `dependsOn` / planner route | 类型或局部字段，无生产依赖调度 | 不当底座；由 canonical plan 派生，无用空壳删除 |
| TurnFrame | live；只管当前 turn 内迭代 | 保持 turn-local，不升级成持久 plan |
| SystemReminderRegistry | live；只组装提示文本 | 仅向模型转述已生效决策，不做权威 |
| HookRegistry | 实现/测试存在，生产 SDK 未接入 | 收缩成 observer 并接入，或删除；不作策略中心 |
| Error classifier / recovery router | live；策略分散 | 复用分类器，统一由 typed recovery policy 产生决策 |
| Task adjudicator / proof collector / finalizer | live | 保留机械验收和唯一终态入口 |
| DomainAdapter 完整调度接口 | 多数为旧形态；当前主要贡献 prompt/domain facts | 不把新 scheduler 挂到假想接口；保留真实使用，删漂移空壳 |

## 2. 唯一真值与数据边界

## 2.1 真值分工

| 真值 | 唯一责任 |
| --- | --- |
| `ExecutionPlan` | 通用节点、依赖、分支组、节点预算、资源声明、验收条件与当前 revision |
| `NodeAttempt` | 某节点一次执行的 owner/generation/checkpoint/result/failure/usage |
| `ExecutionCallScope` | admission、direct、node、replan、verifier、selector 每次模型执行的持久 owner、输入、请求和恢复边界 |
| Parent budget ledger | 全部 call scope/provider request 共用的单调 token/request/time 预算 |
| Domain child（如 `browser_tasks`） | 域内实际动作、证据、检查点和恢复状态 |
| `TaskProjection` | UI/查询派生；不作 scheduler CAS 真值 |
| `TurnFrame` | 当前模型循环内一致读源；不跨 turn |
| Checkpoint | 节点续跑的身份锚点与最小 continuation state；只引用 canonical plan/facts/evidence/receipts/artifacts，不保存或重放完整 SDK final input |
| CompletionVerifier | 候选交付的语义验收 |
| `finalizeRunOutcome()` | Parent/run/投影/用户终稿的唯一终态入口 |

BrowserResearchState 只回答“需要哪些网页事实、目前覆盖多少”，不重复 ExecutionPlan 的顺序、依赖和分支组。ExecutionPlan 的 Browser 节点只持有 browserTaskId/checkpoint/evidence handle，不复制 Browser journal 和 work items。

输入真值由 canonical ledgers、结构化 facts、evidence、action receipts 和 artifact refs 共同组成。Provider transcript、完整 SDK history/final input 只允许作为可删除的诊断缓存；它们不能决定续作、计划、证据、预算或终态，也不能被直接重放成下一次 Provider 输入。

## 2.2 Canonical plan ledger

> **复核裁决（2026-07-22，roadmap 裁决 2/3）**：本节的 `execution_parent_budgets / execution_budget_entries / execution_call_scopes / execution_provider_requests` 与 Browser 顺序收口计划 §1.5.1 是同一套表；按 roadmap 裁决，唯一建表地在本计划 P1，Browser 计划不再前置实现。Browser 计划 §1.5 的 `interaction_lifecycles / interaction_suspension_epochs / interaction_outcome_deliveries / delivery_progress_clocks` 四张持久表及其全边界崩溃注入矩阵同样移交本计划，归入 P3（typed policy 与统一 recovery），其表结构以 Browser 计划 §1.5 原文为准。L0 期间等待时钟只做进程内显式状态机（同等可观察行为），不建表。

当前 `task_projections.delivery_state_json` 同时担任投影与 Dynamic Delivery 调度状态，不适合扩展为长程主真值。一次性迁移为同一 SQLite 内的 head + immutable revision + attempt ledger：

```sql
execution_admissions(
  parent_task_id PRIMARY KEY,
  receipt_id UNIQUE,
  request_anchor_digest,
  initial_task_type,
  host_requirement,
  initial_mode,
  typed_facts_json,
  proposal_digest,
  created_at
)

execution_plan_heads(
  plan_id PRIMARY KEY,
  parent_task_id UNIQUE,
  current_revision,
  scheduler_state,
  final_outcome_ref,
  created_at,
  updated_at
)

execution_plan_revisions(
  plan_id,
  revision,
  request_anchor_digest,
  effective_task_type,
  policy_snapshot_json,
  immutable_plan_json,
  source_receipt_json,
  created_at,
  PRIMARY KEY(plan_id, revision)
)

execution_node_attempts(
  attempt_id PRIMARY KEY,
  plan_id,
  node_id,
  plan_revision,
  attempt_number,
  generation,
  owner_binding_json,
  status,
  checkpoint_ref_json,
  result_ref_json,
  failure_json,
  usage_json,
  created_at,
  updated_at,
  UNIQUE(plan_id, node_id, plan_revision, attempt_number)
)

execution_call_scopes(
  call_scope_id PRIMARY KEY,
  parent_task_id,
  scope_kind,
  scope_key,
  attempt_number,
  generation,
  plan_id,
  plan_revision,
  node_id,
  node_attempt_id,
  owner_run_id,
  owner_binding_json,
  input_ref_json,
  input_digest,
  source_candidate_ref_json,
  clean_checkpoint_ref_json,
  status,
  usage_json,
  created_at,
  updated_at,
  UNIQUE(parent_task_id, scope_kind, scope_key, attempt_number)
)

execution_parent_budgets(
  parent_task_id PRIMARY KEY,
  revision,
  hard_limits_json,
  used_json,
  reserved_json,
  source_snapshot_ref,
  source_snapshot_digest,
  created_at,
  updated_at
)

execution_budget_entries(
  entry_id PRIMARY KEY,
  parent_task_id,
  call_scope_id,
  request_index,
  entry_kind,
  debit_json,
  idempotency_key UNIQUE,
  created_at
)

execution_provider_requests(
  call_scope_id,
  request_index,
  request_digest,
  state,
  first_accepted_delta_kind,
  budget_debit_ref,
  usage_json,
  prepared_at,
  sent_at,
  settled_at,
  PRIMARY KEY(call_scope_id, request_index)
)

execution_resource_claims(
  resource_key PRIMARY KEY,
  resource_kind,
  claim_id UNIQUE,
  generation,
  call_scope_id,
  plan_id,
  node_id,
  attempt_id,
  state,
  expires_at,
  updated_at
)

execution_resource_bindings(
  call_scope_id,
  resource_key,
  authority,
  authority_claim_ref_json,
  generation,
  created_at,
  PRIMARY KEY(call_scope_id, resource_key)
)

execution_control_receipts(
  receipt_id PRIMARY KEY,
  parent_task_id,
  call_scope_id,
  recovery_block_id,
  plan_id,
  plan_revision,
  node_id,
  attempt_id,
  generation,
  kind,
  idempotency_key UNIQUE,
  facts_digest,
  decision_json,
  created_at
)

execution_recovery_blocks(
  recovery_block_id PRIMARY KEY,
  parent_task_id UNIQUE,
  source_kind,
  reason_code,
  source_state_digest,
  state,
  resolution_receipt_id,
  created_at,
  resolved_at
)

execution_verifier_receipts(
  verifier_receipt_id PRIMARY KEY,
  parent_task_id,
  plan_id,
  plan_revision,
  call_scope_id,
  required_state_digest,
  sealed_input_digest,
  decision,
  gaps_ref_json,
  idempotency_key UNIQUE,
  created_at
)

execution_candidates(
  candidate_id PRIMARY KEY,
  parent_task_id,
  call_scope_id,
  candidate_kind,
  plan_id,
  plan_revision,
  group_id,
  branch_node_id,
  attempt_id,
  branch_id,
  state,
  sealed_result_ref_json,
  sealed_result_digest,
  created_at,
  updated_at,
  UNIQUE(call_scope_id)
)

execution_candidate_deltas(
  candidate_id,
  sequence,
  message_envelope_json,
  digest,
  PRIMARY KEY(candidate_id, sequence)
)

execution_candidate_acceptances(
  acceptance_receipt_id PRIMARY KEY,
  candidate_id UNIQUE,
  parent_task_id,
  call_scope_id UNIQUE,
  scope_generation,
  destination_kind,
  destination_key UNIQUE,
  destination_ref_json,
  candidate_digest,
  idempotency_key UNIQUE,
  created_at
)

execution_candidate_selections(
  plan_id,
  plan_revision,
  group_id,
  join_node_id,
  winner_candidate_id,
  verifier_digest,
  merge_state,
  merge_receipt_id UNIQUE,
  created_at,
  PRIMARY KEY(plan_id, plan_revision, group_id)
)
```

只有 scheduler repository 可以插入 revision、切 head 和写 attempt。新 revision 先 append，随后以 `planId + expected currentRevision` CAS 切 head；两步在同一事务中完成。旧 `immutable_plan_json` 永不更新，因此任意 attempt 的 `planRevision` 都能回读当时计划。

`scheduler_state` 只允许 `active / waiting / verifying`。scheduler 不能写 completed/failed/cancelled；`final_outcome_ref` 只能由 `finalizeRunOutcome()` 在 Parent 终态事务中写入，或由该结果确定性派生，不能成为第二终态权威。

`execution_call_scopes` 覆盖所有模型调用，不只覆盖 DAG 节点：`scope_kind` 固定为 `admission / direct / node / replan / verifier / selector`。`node` scope 必须绑定精确 NodeAttempt；其余类型可以没有 plan/node，但必须绑定 Parent、稳定 scopeKey、attemptNumber、generation、输入 digest 和 owner binding。direct 因此拥有 durable direct attempt，却不伪造 ExecutionPlan 或 synthetic node；verifier/selector/replan 也各有独立 attempt 和 checkpoint/retry 边界。scope 状态只允许 `prepared / running / checkpointed / settled / interrupted / cancelled`，旧 generation 迟到写入为 0。

每个 Parent 在首次网络请求前先创建 `execution_parent_budgets`。`execution_budget_entries` 是 append-only debit/reservation 账本，`execution_parent_budgets` 只是同一事务更新的当前汇总；used 只能单调增加，reserved 只能由明确 request settlement/recovery 转为实际或释放。admission、direct、node、replan、verifier、selector 共用该硬顶，不能各自重置预算。

`execution_resource_claims` 是文件、文档等通用资源的当前所有权真值：resource key 由 host 的 typed resolver 生成；acquire/release/expire 必须带 expected generation CAS；同 key 同时只允许一个 held owner；scope settle/cancel/startup recovery 必须释放或 fence。Browser target 不在这里复制一把锁：它继续以先行计划的 `browser_target_claims` 为唯一权威，`execution_resource_bindings` 只保存该 claim 的只读 handle。`ResourceClaimUnitOfWork` 用同一 SQLite 事务取得全部通用 claim、CAS Browser domain claim、写 call-scope binding，并把 direct/node scope 变成 running；任一资源失败则全部不成立。这样 direct 工具也不能绕过资源与策略账本。

资源 claim 的每次冲突、抢占、释放、过期和启动回收都写控制流 receipt。TTL 只回收进程失联 owner；unknown-effect 操作是否可重放仍由 effect receipt 决定，不能因为 claim 过期就重放。

`execution_control_receipts` 是 policy 控制流变化、resource transition 和 AgentProtocolMessage 的持久去重账本；先以 idempotencyKey 插入 receipt，再在同一 Unit of Work 内改 head/scope/attempt/claim。可执行控制流 receipt 必须绑定 Parent + callScope，plan/node 字段按 scope kind 可空，因此 admission/direct 也不能绕过控制流账本。唯一例外是不可执行的 migration recovery block：它绑定 Parent + `recoveryBlockId`，callScope 为空；schema CHECK 强制 `callScopeId / recoveryBlockId` 恰有一个，任何带 recoveryBlockId 的记录都不能创建 Provider request、resource claim 或 scheduler ready item。重复消息只回读原 receipt，不重放状态转换。普通工具 allow/result 仍使用现有 authorization/action journal，不复制进该表。

`execution_provider_requests` 是 call-scope 内 request-level 边界的唯一账本。每次发网络前，先在同一预算事务中创建新 `request_index` + `prepared` row 和单调 budget debit，再在真实网络调用前标记 `sent`。provider delta 进入 host 后，必须先原子把首个 text/reasoning/tool-call delta 记为 `delta_accepted` + kind，成功后才能转发给该 scope 的 sealed candidate；持久失败则零转发。部分 tool-call delta 也算接受，不等工具 dispatch。已标记 `sent` 却因崩溃无法确定回应边界的 row 启动时写 `unknown_after_crash`，旧 call scope 结算 interrupted，不在同 scope 重发；node/replan/verifier 等上层再从各自 clean checkpoint 创建新 scope attempt。

每个 request 的请求数、wall time 和 token debit 都进 Parent 单调预算；能读回 provider usage 时记实际值，崩溃/未知时至少按已签发的 wire input 与 max-output reservation 记账，不因重启退回 used。首次 admission 请求也必须先完成 scope + budget prepared commit，任何“不在 plan 里所以不记账”的调用都由 gate 直接拒绝。

Provider delta 永不直接进入 shared session/UI。admission 先写隔离 candidate；admission 事务提交后，direct 模式在同一事务创建 durable direct scope，并以一次 acceptance receipt 接管该 candidate（纯终稿可直接进入 finalizer，工具调用则由 direct scope 再做授权/资源准入）；planned 模式只消费 `propose_execution_plan` 控制消息，不放出前置产品动作。node/direct/verifier/selector 的输出同样先落各自 sealed candidate，再由具名 acceptance/merge/finalizer 事务公开。这样 admission commit 前崩溃不会留下半条用户消息或已派发工具。

现有 `CandidateSessionFork` 是内存 delta，不能支撑重启与 SQL fault。candidate 存储从 P1 起就是 call-scope 通用真值：`parentTaskId + callScopeId + candidateKind` 必填，plan/node/group/branch 只在对应 scope 存在时填写。`candidateKind` 固定为 `admission / direct / node / replan / verifier / selector / branch`；每个 call scope 只有一个 candidate session，状态机固定为 `collecting -> sealed -> accepted | tombstoned`。每条 message envelope 先写 delta，seal 时冻结 digest；accept 必须在同一事务 CAS `candidate=sealed + digest + current scope generation/status`，插入带唯一 destinationKey 的 acceptance receipt，并改 candidate=accepted。重复 seal/accept、第二个 candidate、旧 generation 和相同 destination 的另一 candidate 全部零写入。admission/direct 因此能在没有 plan 的情况下崩溃恢复，且 candidate 接受前 shared session/UI/tool dispatch 为 0。

P1 先交付当期实际使用的 `admission / direct / node / replan / verifier` delta/seal/accept；P4 只统一跨域 evidence 与 verifier input/bundle，不首次补 verifier candidate；P6 再启用 selector/branch candidate 与 selection/merge。branch winner 必须 CAS 写 selection，且 selection 和 Parent merge 在同一事务成功后候选 delta 才能进入共享 session；loser/rollback/重启恢复都从这些表裁决。不得在 P1–P3 为任一 live scope 暂留内存 candidate fallback。

TaskProjection 由同一事务中的投影写入器派生，失败进 retry ledger，不反向改 plan。

`DeliveryStateV1` 没有持久保存完整 WorkPackage 的 deliverable、expectedOutputs 和 proposedCriteria，不能无损编造 plan。migration 必须分类：已终态行只保留历史投影；open 且同时拥有唯一 request anchor、clean checkpoint 和可信 Parent budget 的行，先在同一事务创建/幂等复用 `scopeKind=replan` 的 durable call scope，再写绑定该 scope 的 `migration_replan_required` control receipt，不写没有 head 的 planned admission。故障重放用相同 idempotencyKey 回读同一 scope/receipt；recovery coordinator 才以已有 package identity/context refs 做一次有界 fresh proposal，proposal 通过后在同一事务创建 initial planned admission + revision + head。

缺 request、clean checkpoint 或可信 budget 任一项时，禁止伪造 `checkpointed replan scope`。迁移只创建 Parent-unique `execution_recovery_blocks(state=open, reasonCode, sourceStateDigest)` 和绑定它的不可执行 control receipt；Provider/request/resource/scheduler rows 必须为 0。Renderer 由该 block 显示 recovery blocked 并等待用户决定。用户以后选择重启任务时，从新 admission/budget/request anchor 建立新 scope，并在同一事务 resolve block；不能把旧 block 原地升级成可执行 scope。

Browser 先行计划 S3 已创建 call-scope/provider-request/Parent-budget 最小表，本计划只能原地迁移和扩展，不能新建平行账本。每个仍 open/resumable 的 Parent（包括 Browser continuation 与旧 Dynamic Delivery）都必须把切换前 canonical budget 的 hard limits、used、reserved、source snapshot ref/digest 以一条 append-only `carry_forward` entry 原子 seed 到 `execution_parent_budgets`；若 S3 已有行则 CAS 校验同一 source/数值并幂等复用。找不到唯一可信 snapshot 或 max/used/remaining 自相矛盾时 fail closed 为 migration blocked，不取较小 used、不退款。切换事务提交后旧 budget ledger production 读写为 0；升级、重复迁移和重启必须证明不重置、不双扣。

当前真实 DB 没有可演练的 `support_and_verify` open row，所以 migration 行为用合成旧库 fixture 覆盖，报告明确 real-row count=0。fresh、upgrade、重复执行、故障回滚、budget carry-forward 与 `PRAGMA quick_check` 全通过后切换；production 不再读 V1 作 scheduler/终态真值，不保留长期双读兼容分支。

## 3. ExecutionPlan 和节点合同

### 3.1 Admission 是一次 typed 决策

不新增关键词分类器，也不让 `research / short_task` 在多个层各自猜。每个新 Parent 先在本地事务创建 Parent budget 和 `scopeKind=admission` 的 call scope，冻结 request anchor/input digest；**该事务成功后**才允许第一轮 Owner 模型网络调用。在任何产品工具 dispatch、共享 session/UI 输出或终态前，host 从这次隔离的结构化 candidate 及已有 runtime facts 计算 `must_plan / may_plan / direct`：模型的 typed taskType/目标/产物 proposal、显式资源地板、已存在 durable child/continuation 和用户已确认的 plan preference；禁止扫描自然语言关键词。admission receipt 提交时同时冻结 initial task type。

模型可以在这一次调用中提出简单任务的直接终稿/工具调用 candidate，或返回 `propose_execution_plan` 结构化控制消息，因而简单任务没有额外 planner 调用，但 candidate 不能提前公开或执行。direct admission 事务同时创建 durable direct scope，并以 acceptance receipt 接管候选终稿/工具调用；后续工具准入、资源 claim、Provider 请求和最终化都绑定 direct scope。planned admission 只接受 plan control message，不允许把同一 pre-admission candidate 中的产品动作带入计划。`propose_execution_plan` 由 host 在工具注册表和 action dispatch 之前拦截，它不是产品工具、不执行外部动作，与“admission 先于任何 tool dispatch”不冲突。

host 验证 proposal 后先持久：

```ts
interface ExecutionAdmissionReceipt {
  receiptId: string
  parentTaskId: string
  requestAnchorDigest: string
  hostRequirement: 'must_plan' | 'may_plan' | 'direct'
  initialMode: 'direct' | 'planned'
  initialTaskType: TaskType
  decisionSource: 'owner_model'
  proposalDigest: string | null
  reasonCodes: string[]
  createdAt: string
}

interface PlanPromotionReceipt {
  receiptId: string
  parentTaskId: string
  sourceRunId: string
  cleanCheckpointId: string
  domainChildRefs: ResourceRef[]
  actionEvidenceWatermarks: WatermarkRef[]
  fromTaskType: TaskType
  effectiveTaskType: TaskType
  proposalDigest: string
  idempotencyKey: string
}
```

规则：

1. 语义上如何分解由模型决定；代码只根据 typed facts 设 plan floor，并验证 proposal 的 DAG、预算、资源、副作用、产物和数量上限。`must_plan` 时模型未 proposal，host 返回一次 typed `plan_required` 修复；仍拒绝则 checkpoint/block，不能退回长 ReAct。
2. direct 必须在一个事务内写 Parent-unique `execution_admissions`、durable direct scope 和 candidate acceptance receipt；initial planned 必须在同一事务内写 admission、首个 immutable revision 和 plan head，不允许出现 `initialMode=planned` 但无 head 的中间态。direct admission 不能塞进不存在的 plan、synthetic node 或 TaskProjection。
3. admission receipt 只冻结 `initialTaskType` 和 `initialMode`，永不更新；当前执行模式由事实派生：存在 `execution_plan_heads` 即为 planned，否则等于 `initialMode`。当前 task type 在 direct 时等于 initial，进入 plan 后只读当前 immutable revision 的 `effectiveTaskType`；它只能保持或提高已成立的预算/验收地板，存在 required node/child 时不得降级。projection/checkpoint/child 不能自行重判。
4. 当前 Dynamic Delivery preflight/planner 迁移为同一 proposal/receipt 路径或删除，不允许再并行产生第二份 decision。
5. direct 运行中若 host 观察到明确的持久 child/多目标资源合同，允许在 clean checkpoint 边界发出一次 typed `plan_promotion_required`，再由模型提交 proposal；代码不从自然语言推断。promotion 在同一事务内写 `PlanPromotionReceipt`、首个 immutable revision 和 plan head，不更新 admission；重放只回读原 receipt/head。首个 revision 的 `prePlanHistory` 必须引用 promotion 前 source run、clean checkpoint、domain children 和 action/evidence watermarks，后续节点输入与最终 verifier 都消费它；不为已发生动作倒造 NodeAttempt，也不让其变成 DAG 外孤儿事实。promotion 可在 receipt/revision 中提升 `effectiveTaskType`，initial 值仍保留作审计。
6. 重启从 admission ledger 恢复；同 Parent 重复 proposal 以 request digest + expected revision CAS，不能创建两个 plan。
7. 多目标长任务误判为 direct 时，现有 criteria/output/finalizer 门必须阻止假完成并请求一次 plan promotion；误把简单任务判 planned 时，基线门将额外调用和延迟计为回归。

测试至少覆盖 direct、planned 事务中断、一次 promotion、重复 proposal、pre-plan 已结算动作/证据全部被新 revision 消费、effective task type 升级、false-positive 成本和 false-negative 不假完成。

### 3.2 Plan 与节点结构

```ts
type BranchGroupMode =
  | 'readonly_fanout'
  | 'candidate_branch'

type BranchJoinPolicy =
  | 'all_required_succeeded'
  | 'one_verified_winner'

type SideEffectClass =
  | 'read_only'
  | 'idempotent_write'
  | 'unknown_effect_write'
  | 'exclusive_external_action'

interface ExecutionPlan {
  version: 1
  planId: string
  parentTaskId: string
  requestAnchor: { sourceMessageId: string; digest: string }
  revision: number
  effectiveTaskType: TaskType
  prePlanHistory: PrePlanHistoryAnchor | null
  nodes: ExecutionNode[]
  branchGroups: BranchGroup[]
  finalCriteria: CriterionRef[]
  expectedOutputs: ExpectedOutputRef[]
  policySnapshotId: string
  schedulerState: 'active' | 'waiting' | 'verifying'
}

interface BranchGroup {
  groupId: string
  mode: BranchGroupMode
  branchNodeIds: string[]
  joinNodeId: string
  joinPolicy: BranchJoinPolicy
  maxConcurrency: number
}

interface PrePlanHistoryAnchor {
  sourceRunId: string
  cleanCheckpointId: string
  domainChildRefs: ResourceRef[]
  actionEvidenceWatermarks: WatermarkRef[]
  sourceReceiptId: string
}

interface ExecutionNode {
  nodeId: string
  objective: string
  dependsOn: string[]
  criteria: CriterionRef[]
  expectedOutputs: ExpectedOutputRef[]
  sideEffectClass: SideEffectClass
  resourceClaims: ResourceClaimSpec[]
  executorClass: 'owner' | 'registered_worker' | 'ephemeral_worker' | 'domain_child'
  budget: NodeBudget
  retryPolicyId: string
  required: boolean
}
```

硬规则：

1. request anchor 只由 ingress 签发，planner 不能伪造或缩减用户原话。
2. planner 只输出 `ExecutionPlanProposal`；host 检查节点数、DAG、产物、资源、副作用等级和预算后才铸造 canonical plan。
3. 节点目标是语义文本；代码只解释依赖、required、sideEffectClass、resource claim、budget、attempt 和验收结果。
4. 全计划只有一张 canonical DAG；顺序前缀、分支组与 Owner join 可在同一计划中并存，不把整个计划塞进互斥的“拓扑类型”。
5. branch group 只是 DAG 上的受限并发声明；branch 节点互相无依赖，全部只汇入唯一 join，不得重叠属于多个 group。join 不能同时是任何 group 的 branch/join，但可作为后续分支组的公共前置；整图仍必须无环。
6. 每个节点恰好一个主交付物；不创建没有产出的“协调节点”。join 必须产出合并报告或选择结果。
7. 子节点不再分解子节点。重新计划只能由 Parent scheduler 在 clean checkpoint 边界产生新 revision。
8. 已 succeeded 节点在新 revision 中只能被引用或显式 supersede，不能被偷偷改写。
9. 默认 `maxReplans=1`，代码硬顶 2；用户偏好不能提高硬顶。
10. `BranchGroup` 没有第二层 required：`readonly_fanout` 只读每个 branch node 的 `required`；`candidate_branch` 的 branch nodes 必须 `required=false`，由 join node 的 `required` 决定该候选结果是否影响 Parent。
11. `readonly_fanout/all_required_succeeded` 在所有 required branch succeeded 且 optional branches 已 settled 后使 join ready；required 失败阻塞。`candidate_branch/one_verified_winner` 在一个 sealed candidate 被 fresh selector 接受并 CAS 选中后使 join ready，其余 branch 取消/tombstone，不要求全部 succeeded。
12. branch node 不得成为 group join 之外的任何后继前置，join 也不得在 `dependsOn` 中再列自己的 branch nodes；分支到 join 的隐式边只由 `joinPolicy` 解释，防止旁路 join 或与普通 dependency 重复。
13. mode/policy 是固定配对：`readonly_fanout` 只能用 `all_required_succeeded`，`candidate_branch` 只能用 `one_verified_winner`；validator 将 branch 隐式边加入整图后再做无环、唯一 join 和旁路检查。

`sideEffectClass × executorClass` 准入是机器矩阵：

| sideEffectClass | 允许 executorClass |
| --- | --- |
| `read_only` | `owner / registered_worker / ephemeral_worker / domain_child` |
| `idempotent_write` | `owner` |
| `unknown_effect_write` | `owner` |
| `exclusive_external_action` | `owner` |

`domain_child` 首版只能产出只读结果。Browser mutation 节点的 executorClass 必须是 `owner`，Browser child 只作为该 Owner 节点的域内状态/证据 ref，不能借独立 ownerRunId 绕过 Owner 准入。P1–P4 validator 强制 `branchGroups=[]`；P5 只放行 `readonly_fanout/all_required_succeeded`，P6 才放行 `candidate_branch/one_verified_winner`。

## 4. 节点生命周期与检查点

```text
pending -> ready -> running
running -> waiting_external -> running(new generation)
running -> checkpointed -> running(new attempt/generation)
running -> succeeded
running -> failed
pending/ready/running/waiting/checkpointed -> cancelled
```

不变量：

1. 普通节点只有全部 `dependsOn` 节点 `succeeded` 才能进 ready；branch join 不复用该规则猜测，只按 §3.2 的具名 `joinPolicy` 进 ready。
2. 从 ready 到 running 必须在同一事务中创建 attempt 和取得所有必需资源 claim；不使用 fire-and-forget。
3. SDK 模型循环只读当前 node attempt 的 request bundle，不自行跳节点或改依赖。
4. checkpoint 只保存 plan/revision/node/attempt/generation、canonical fact/evidence/action-receipt/artifact 的 identity+revision+digest、未完成目标和最小 continuation state。完整 Provider transcript、SDK history/final input 不进入 canonical checkpoint。
5. 节点 retry/redispatch 从 checkpoint 创建新 NodeAttempt + call scope generation；旧 attempt/scope 不重开，迟到结果因 generation 不匹配失效。只有在任何语义输出或工具效果之前的 provider transport retry 可作为同 call scope 内的新 `providerRequestIndex`。
6. `unknown_effect_write` 在效果未知时不重放；必须先观察/对账，仍不可知就 block。
7. Parent 取消向全部 active attempts 传播，但分支仍必须以自己的 cancel receipt 结算，不依赖 Promise 自然消失。
8. 同 call scope 的 request retry 只在当前进程确定知道该 request 已以 transport 失败结算，且 `first_accepted_delta_kind IS NULL`、sealed candidate/shared session/Renderer 都未接受任何 delta、无完整或部分 tool call 被采纳、无 tool dispatch 时允许。任一条不满足就结算旧 scope，从 clean checkpoint 新建对应 kind 的 scope attempt；node scope 还必须新建 NodeAttempt。
9. 进程在 request `sent` 后崩溃时，无论外部服务是否已回应，都不续跑同 call scope；启动恢复将它结算 `interrupted/unknown_after_crash`，再从旧 clean checkpoint 创建新 scope。若前一 scope 已 dispatch unknown-effect，则先对账而非重发。
10. context compaction 是发请求前的确定性输入变换；source digest 来自 canonical refs，working digest 来自本次确定性 Context Builder 输出，不冒充 retry。诊断 transcript cache 可随时删除，禁止重放完整 SDK input。user steering 只在 clean checkpoint 生成新 revision/scope；部分 function-call 已算 delta accepted，不在同 scope 重发；verifier transport 只在零 delta 时可对同 sealed candidate 做 request-level retry，否则新建 verifier scope，绝不重跑 Browser/文档动作。

## 5. 一张 DAG、两类分支组与 Owner 准入规则

## 5.1 默认是顺序 DAG

- 开始时只允许一个 running 节点。
- 适合多步骤调研、文档处理、长技能和需要上一步产物的任务。
- 本形态先上线，证明持久计划、checkpoint 和续跑。

## 5.2 `readonly_fanout`：独立只读分支组

- 仅 `read_only` 节点可并行。
- 每分支独立 session、attempt、checkpoint、budget 和 evidence namespace。
- 分支只回传 WorkerReport + host-signed evidence handles，不写 Parent 状态。
- `joinPolicy=all_required_succeeded`；Parent scheduler 等待 required branches succeeded 和 optional branches settled，再让 Owner 综合。

## 5.3 `candidate_branch`：候选路径分支组

- 只用于多个语义方案/推理路径，首版不允许 Browser/文件/外部写入。
- 各分支在 CandidateSessionTransaction 中隔离。
- fresh selector/verifier 只读原请求、候选产物和 sealed evidence，输出 winner/gaps/reject。
- `joinPolicy=one_verified_winner`；winner 以 plan revision + branch attempt CAS 合并，随后取消/tombstone loser；迟到 loser 永久不可写共享 session。

## 5.4 Owner 准入规则：任何写入与外部动作

- 文档/文件写入、发送、shell、Browser page mutation、确认、支付、权限和可能已提交事务都由 Parent Owner 独占。
- worker 可审计计划和只读证据，不执行该动作。
- 这是节点级 admission/executor 规则，不是与顺序/分支互斥的全局拓扑；即使前面有 fan-out，所有写入也要 join 后回到唯一 Owner。

不支持模型任意生成嵌套 Agent 网络，不支持 worker 再 spawn worker。

## 6. decomposition、coordination、topology 和 protocol

### 6.1 Decomposition

planner proposal 的每个节点必须有：

- 稳定 nodeId；
- 一个 objective；
- 一个主 deliverable；
- dependencies；
- criteria/expected outputs；
- sideEffectClass；
- resource claims；
- executor class；
- budget/retry policy id。

代码拒绝：循环依赖、无产物协调节点、只靠文本声称的资源、无副作用分类的工具节点、超预算计划、嵌套 children。

### 6.2 Coordination

- Parent scheduler 是唯一节点调度者。
- Owner 是唯一共享产物/外部动作写入者。
- worker 只能向自己的 attempt 写 checkpoint/result，不直接修改 Parent/peer。
- scheduler 从 canonical plan + attempt ledger + resource claims 计算 ready set，不从模型消息猜。
- required 分支未结算，Parent 不进 verifying。

### 6.3 Agent protocol

只允许以下 typed messages：

```ts
type AgentProtocolMessage =
  | NodeStart
  | ResourceClaimed
  | NodeHeartbeat
  | NodeCheckpointed
  | NodeResultSubmitted
  | NodeFailed
  | NodeCancelled
  | BranchJoinRequested
  | BranchJoinSettled
```

每条必须包含 `planId / planRevision / nodeId / attemptId / generation / idempotencyKey`。结果与 checkpoint 另外包含 digest/provenance；模型不能自报 usage、owner、generation 或验收通过。

协议消息不是内存通知：host 先把消息摘要按 idempotencyKey 写入 `execution_control_receipts`，再在同一事务应用 attempt/claim/head 转换。重启重放只回读原 receipt；payload digest 不同却复用 key 时 fail closed。消息正文和大产物放资源层，receipt 只持 ref/digest。

## 7. 三层策略和 typed decision points

## 7.1 基础硬规则

只由代码与合同承担：

- 权限和 capability floors；
- 高危确认；
- 资源单写者与 fencing；
- unknown effect 不重放；
- 预算硬顶；
- 候选隔离；
- verifier 零工具；
- finalizer 唯一入口。

任何用户或自适应策略都不能降低这一层。

## 7.2 用户自定义规则

不允许用户提供可执行 middleware 代码。只允许声明式 schema，例如：

- 偏好顺序或允许只读并行；
- 成本/时间/质量偏好；
- 只读瞬时错误重试 0..N（不超代码硬顶）；
- 是否允许语义候选分支；
- 失败时偏好暂停、明示降级或直接阻塞。

用户策略在 run 开始时冻结为 immutable `UserPolicySnapshot`，中途修改只能作为新 steering receipt 产生 plan revision。它不能：

- 开新权限/工具；
- 绕过确认；
- 重放 unknown-effect 动作；
- 让 verifier 执行工具；
- 提高全局预算硬顶。

## 7.3 运行时自适应

从已确定事实计算：

- 剩余节点/token/时间；
- 连续无进展；
- error kind/retry-after；
- resource conflict；
- checkpoint 新鲜度；
- verifier gaps；
- 分支完成率和候选证据质量。

只能选择代码允许的动作：`retry / wait / checkpoint / replan / degrade-visible / block / cancel-optional-branch`。不能扩大授权或更改 required 用户目标。

## 7.4 具名决策点

不建任意 middleware chain。只在以下边界调用 pure typed resolver：

1. `before_plan_compile`
2. `before_node_admission`
3. `before_tool_dispatch`
4. `after_tool_result`
5. `on_failure_classified`
6. `before_retry_or_degrade`
7. `before_replan_commit`
8. `before_candidate_merge`
9. `before_finalize`

resolver 可以在这些边界被调用，但不为普通 allow/observe 复制第二本账。工具授权仍由现有 authorization receipt 负责，页面动作/结果仍由 action journal 和 tool result 负责。只有改变控制流或所有权的结果才持久化 `PolicyDecisionReceipt`：`retry / wait / checkpoint / replan / degrade-visible / block / cancel-optional-branch / candidate-merge / final-reject`。

持久 receipt 结构为：

```ts
interface PolicyDecisionReceipt {
  decisionId: string
  parentTaskId: string
  callScopeId: string
  planId: string | null
  planRevision: number | null
  nodeId: string | null
  attemptId: string | null
  point: PolicyDecisionPoint
  invariantPolicyVersion: string
  userPolicySnapshotId: string | null
  adaptiveFactsDigest: string
  decision: string
  reasonCodes: string[]
  createdAt: string
}
```

`parentTaskId + callScopeId` 是所有 receipt 的必填身份；plan/node 字段只在该 scope 实际属于 DAG 时填写。admission/direct 的策略与恢复决定因此可持久审计，但不会为满足 schema 伪造计划。

SystemReminderRegistry 可以把已作决策告诉模型，但不影响决策。

## 8. hooks 和观察者的最小职责

现有 HookRegistry 只有注册、串行触发、超时与失败指标，生产 SDK 没有真实 caller。处置二选一：

1. 若有明确消费者，收缩为 `ExecutionObserverRegistry`，接收 typed lifecycle event，只写日志、指标、调试快照和可选用户通知。
2. 若无生产消费者，删除 HookRegistry 与空的 host 可选字段。

即使保留，也必须满足：

- observer 失败不中断节点；
- observer 超时后不能继续写 product state；
- observer 返回值不被 scheduler 解释；
- observer 不拥有 ToolContext/资源 claim/finalizer handle；
- 用户自定义的是 declarative policy，不是 observer code。

## 9. 失败、重试和降级统一矩阵

复用现有 error classifier/recovery router，不再让 provider、Browser、Skill、Dynamic Delivery 各有一套文本重试规则。

| 失败类 | 自动重试 | 要求 |
| --- | --- | --- |
| provider request transport / 429 / 可重试 5xx | 有界 | 仅在无语义输出、无工具调用/效果时，同 call scope 以新 `providerRequestIndex` 重发；先写 request-retry receipt，遵守 retry-after |
| node executor / worker 中断 | 有界重派 | 旧 attempt 先结算 interrupted；从 clean checkpoint 创建新 attempt + generation，不恢复同一次模型调用 |
| semantic 4xx / auth / unsupported capability | 否 | 明示 block/config，不伪装 stream fallback |
| context pressure | 一次有界 | 旧 attempt 结算；clean checkpoint 派生 compaction working view，以新 attempt 重派，不丢计划/证据 |
| target stale | 否原动作重放 | 重新解析 target；新 generation/new attempt |
| resource conflict / user owned | 否 | 持久 waiting/checkpoint，typed resume |
| page challenge | 否 | 持久人工挑战，回答后 fresh observe |
| unknown-effect write | 否 | 先对账；仍未知则 block |
| evidence gap | 只允许定向 repair | verifier 返回结构化 gap，不自己执行工具 |
| optional branch failure | 最多一次重派或明示降级 | 不影响已完成 required 证据 |
| required branch failure | 有界重派后 block | 父任务不得 done |
| budget exhausted | 否 | clean checkpoint，明示可继续或终止 |

每个 retry/degrade 必须先写 PolicyDecisionReceipt，再进入三种代码明定结果之一：同 call scope 的新 provider request、新 scope（node 时同时新 NodeAttempt）+ generation，或终态。不通过 prompt 临时决定；unknown-effect 永不因重试类型而自动重放。

重试 gate 必须对 `admission / direct / node / replan / verifier / selector` 六类 call scope，逐类在 `provider request prepared / sent / first text delta / first reasoning delta / partial tool-call delta / sealed-candidate accept / shared-session accept / Renderer accept / tool dispatch / request settle` 每个适用边界注入崩溃。只有严格的零-delta transport failure 留在同 scope；其余全部结算旧 scope 并按 §4 恢复，node scope 同时结算旧 NodeAttempt。所有类型的 request/token/time 预算读回单调，无重复工具、无部分消息混入 canonical session；admission commit 前 UI/session/tool dispatch 必须为 0。

## 10. verifier、合并和质量门

### 10.1 三层验收，一个最终 verifier

1. **机械节点门**：host 验证产物存在、hash/provenance、action receipt、required fields、资源 owner 和预算。
2. **节点语义复核（按需）**：fresh no-tools verifier 只读节点 objective/criteria/sealed evidence，返回 accept/gaps/block。
3. **最终 CompletionVerifier**：对原始 request anchor、全部 required nodes、最终产物回读和 candidate session delta 裁决。

从 P1 切换开始就必须存在 canonical `ExecutionCompletionGateView`：它只由当前 plan head、required node/attempt 状态、worker evidence adapter、产物回读和 `execution_verifier_receipts` 确定性派生。verifier receipt 接受时必须以 `expected head revision + requiredStateDigest + sealedInputDigest` 做 CAS；任一 required attempt/evidence/产物变化即使 plan revision 未变，也会改变 required-state digest，旧 accepted receipt 自动 stale。finalizer 在同一 DB snapshot 中重算并比对三者；`required_pending / verifier_pending / rejected / stale_revision / stale_required_state` 一律拒绝 `done`，只有全部匹配的 accepted receipt 才能放行。receipt 由独立 `scopeKind=verifier` 写入，重启可回读；旧 `DeliveryStateV1` 不再参与调度或终态判断。

P1 先用适配器把现有零工具 worker report 与现有 verifier 结果转换成上述 canonical evidence/receipt，保证删旧 scheduler 时没有功能真空。P4 再统一跨域 sealed evidence bundle、扩展既有候选结构的跨域合并和语义 verifier，不负责首次候选持久化，也不负责“第一次让 finalizer 看懂新计划”。direct 模式沿用现有 request/output/finalizer 机械门，但其模型调用、工具准入和策略回执全部绑定 durable direct scope；不得为了复用 planned completion view 伪造节点。

Browser 域自身的证据检查进 sealed bundle，不再串一个第二最终 verifier。verifier 运输失败只能按 §4/§9 的 request ledger 对同一 sealed candidate 有界处理：零 delta 可在同 verifier scope 重发，其余新建 verifier scope attempt；语义 gaps 必须先有新 plan/evidence revision 才能重验。

### 10.2 候选分支合并

- 分支只产生 sealed result refs，不往 Parent session 拼原始对话。
- selector 输出 `winnerAttemptId / acceptedEvidenceIds / rejectedReasons / unresolvedGaps`。
- scheduler 用 plan revision + winner attempt generation 做 CAS。
- CAS 成功后 Owner 才获得结构化候选摘要和 evidence handles。
- loser 与旧 winner 迟到结果只保留审计，共享状态写入为 0。

### 10.3 发布指标

基线在 P0 冻结，但以下硬阈不随基线放宽：

- controlled suite 总体成功率 >=95%；确定性 fault-injection 恢复 100%。
- 假完成、重复 unknown-effect 写入、越权资源写入、旧 attempt 覆盖、双终稿、required branch 未结算却 done：全部 0。
- admission 为 `direct` 的任务 planner/worker/verifier 额外调用 0；顺序长任务可以是 single-path，但仍受 ExecutionPlan 调度与最终复核。
- 长任务首次有效进展最多比基线多 1 次模型调用。
- 受控长任务累计输入 token P50/P95 <= 基线 115%，wall-clock P50/P95 <= 基线 110%；若旧基线本来因失败提前终止，同时报告“完成任务的单位成本”，不用失败运行短时间伪装性能回归。
- 每个候选最终只有 1 个 final verifier，且零工具。

## 11. 分阶段实施顺序

### 11.1 先把 package gate 接进 CI

P0 必须先在 `package.json` 建立并绑定以下真实行为入口；脚本不存在或只做 source grep 时，对应阶段不得通过：

| gate | 首次负责阶段 | 必须覆盖 |
| --- | --- | --- |
| `verify:execution-plan` | P0–P2 | immutable admission、direct→planned promotion transaction、head/revision CAS、DAG/分支组、attempt generation、每 scope 单一 candidate 的 delta/seal/accept CAS、recovery block、checkpoint/replan、旧结果迟到、重启恢复 |
| `verify:execution-call-scopes` | P0–P3 | admission/direct/node/replan/verifier/selector scope、首次联网前持久化、request 全边界崩溃、Parent 单调预算、direct resource/policy binding、零 pre-admission 泄漏 |
| `verify:execution-plan-native` | P0–P2 | fresh/upgrade/idempotent/rollback migration、resource claim 并发、`PRAGMA quick_check`，由 Electron runtime 加载 SQLite |
| `verify:execution-completion-gate` | P1–P4 | canonical gate view、worker evidence adapter、verifier receipt 的 head/required-state/input CAS、pending/stale 拒绝 done、accepted 放行、restart、production V1 终态读写为 0 |
| `verify:policy-runtime` | P3 | 三层优先级、硬规则不可降低、控制流 receipt、observer failure isolation |
| `verify:execution-verifier` | P4 | mechanical node gate、sealed evidence、唯一 final verifier、candidate rollback、finalizer 单入口 |
| `verify:branching-runtime` | P5–P6 | fan-out/join/cancel/restart、candidate isolation、winner CAS、loser 迟到零写入 |
| `verify:browser-sequential-regression` | P0–P6/最终切换 | 配对 Browser A1–A12 的 deterministic localhost/target-claim/takeover/deadline/continue/restart 受控版；报告 source manifest/commit/build 必须等于待放行二进制 |

每阶段至少执行自己的专项 gate、`npm run verify:browser-sequential-regression`、`npm run verify:native`、`npm run verify:stability`、`npm run verify:dynamic-delivery` 和 `npm run typecheck`；P4、P6 与最终切换另跑 `npm run test`、`npm run build`。SQLite 用例出现 host ABI skip 只算未覆盖。真实长任务报告必须记录 source manifest/build/commit、隔离 DB、计划/节点/attempt ids、fault injection、usage 和产物 hash；Browser regression 报告的 manifest/commit/build 不等于当前二进制时不得复用。

## P0：基线、schema 和失败合同

1. 冻结三类基线：普通长任务、Dynamic Delivery、Browser 长研究。
2. 固化 12 个结构变体（覆盖 4 种语言），每个 3 次；再加 10 个故障注入场景。
3. 先为 immutable admission、initial planned 原子创建、direct→planned promotion 历史锚点/事务/重放、head/revision CAS、DAG/分支组校验、attempt generation、六类 call scope、首次联网前 budget/scope commit、provider request ledger/各 delta 边界崩溃、每 scope 单一 durable candidate 的 delta/seal/accept CAS、direct resource/policy binding、resource claim 原子获取、checkpoint、policy receipt、candidate isolation 和 finalizer guard 写失败测试。
4. 写数据迁移演练，证明资料完整的 open DeliveryStateV1 先建 replan scope/receipt 再 fresh proposal；缺 request/checkpoint/budget 的三类只建不可执行 recovery block；Browser/旧 Parent budget carry-forward、旧 revision 可回读，fresh/upgrade/idempotent/rollback/quick_check 均成立。

Gate：新测试在旧实现下精确失败；基线报告有版本、模型、provider、数据集、成功率、重复动作、时间与 token；`verify:execution-plan`、`verify:execution-call-scopes` 与 `verify:execution-plan-native` 已进入 package/CI 且能捕获故意破坏。六类 scope 都证明 prepared/sent/delta/crash 恢复和预算单调；candidate 双写、重复 seal/accept、旧 generation、destination 冲突均零共享写入；缺 request/checkpoint/budget 的 block 重启后 Provider/resource/scheduler 为 0；budget 重置/退款或重复 carry-forward 均使 gate 失败。

## P1：Canonical ExecutionPlan + 顺序 scheduler

> **复核增补（2026-07-22）**：P1 出口除下述 gate 外，必须包含一条用户可见价值验收——至少一个真实长任务（建议直接复用 Browser 收口计划 A1 的 18 组小红书 fixture 场景）在 canonical plan 调度下端到端完整跑通并通过 `verify:browser-sequential-regression`；不允许 P1 只交付账本、迁移与单测。

1. 新增 canonical head/revision/attempt/resource repositories、`ResourceClaimUnitOfWork` 和 migration。
2. 将现有 `DispatchPlan / WorkPackage / DeliveryStateV1` 一次性迁移为 proposal/node/plan projection；旧 coordinator scheduler 在同一切换删除。现有 support-and-verify packages 编译成 `branchGroups=[]` 的顺序只读节点，由 canonical scheduler 一个一个调用现有零工具 worker。
3. 在删除 V1 前同次交付 canonical `ExecutionCompletionGateView`、worker evidence adapter、`execution_verifier_receipts` 和 finalizer blocker 输入；适配现有 verifier 产出 canonical receipt，production 调度/终态对 V1 的读写归零。不得把这一步推迟到 P4。
4. 实现 sequential DAG ready-set、immutable admission/initial planned 原子创建与原子 promotion、call scope、attempt start/settle/cancel。
5. 实现 call-scope 通用 candidate delta/seal/accept repository，覆盖 P1 live 的 admission/direct/顺序 node/replan/verifier；不等待 P4，也不使用内存 fallback。
6. 把现有 SDK 模型循环包装为 node executor，仍走原 Tool authorization/capability floors；finalizer 只消费 canonical completion gate。
7. TaskProjection 从 canonical plan 派生；删除无 caller 的 planner route/依赖空壳或改为派生类型。

Gate：`verify:execution-plan` / native、`verify:execution-call-scopes`、`verify:execution-completion-gate` 通过；单节点、3 节点顺序、dependency failure、资源冲突、取消、重启恢复和旧 attempt 迟到全通过；direct 任务零额外模型调用且有 durable direct scope/candidate，replan/verifier candidate 同样可崩溃恢复。required node 未完成、verifier pending/rejected、receipt revision/required-state/input stale 时调用 `finalize(done)` 必须拒绝，accepted 且三 digest 匹配时才放行；重启结果不变。open Browser Parent budget 在升级+重启后不重置、不退款、不双扣。P1–P4 对任何非空 `branchGroups` fail closed；迁移后 support-and-verify 顺序能力不丢失，旧 scheduler 与 V1 终态 production 读写均为 0。

## P2：节点 checkpoint 与有界 replan

1. 统一 clean checkpoint writer/reader：canonical checkpoint 只保存当前节点/attempt/generation、canonical plan/facts/evidence/action receipts/artifact refs 的 identity+revision+digest、未完成目标和最小 continuation state。Context Builder 从这些真值确定性生成 working bundle，并记录 source/working digest；完整 Provider transcript/SDK final input 降为可删除诊断缓存，既不作为输入真值，也禁止直接重放。
2. 在节点失败、用户 steering、verifier gap 与资源变化时允许 bounded replan。
3. 新 revision 追加 supersession/source receipts，不修改旧 revision。
4. 证明 compaction/restart 不改依赖、证据和产物覆盖。

Gate：`verify:execution-plan` / native 通过；节点后崩溃、replan 中崩溃、steering 与旧结果竞态均只恢复一条主路，旧 revision 可完整回读。

## P3：Typed policy 与统一 recovery

1. 建 invariant/user/adaptive 三层 policy snapshot 和 resolver。
2. 把 provider、Browser、Skill 与 Dynamic Delivery 的错误类型映射到统一 recovery action，删除重复文本重试分支。
3. 为 9 个具名决策点接 pure resolver；只有改变控制流/所有权的结果写 PolicyDecisionReceipt，普通 allow/observe 复用现有账本。
4. 将 SystemReminder 收缩为决策转述；HookRegistry 收缩成 observer 或删除。

Gate：`verify:policy-runtime` 通过；相同 facts+policy 逐字节产生同一决策；用户策略不能扩大权限/硬顶；普通 allow 不重复记账；observer 失败不改任务。

## P4：节点验收与唯一最终 verifier

1. 在 P1 已切换的 completion gate 上复用 proof collector/task adjudicator，统一机械节点门的 evidence schema。
2. 将 Browser sealed evidence、Dynamic Delivery worker evidence 和产物回读统一进 CompletionVerifier bundle，并升级 P1 adapter receipt；finalizer 输入身份不再改变。
3. 删除可能串联的重复 final verifier，语义 gaps 只产生有界 repair/replan。
4. 在 P1 通用 candidate ledger 上增加跨域 verifier/candidate seal 与 merge；DB commit 前消息/snapshot/UI 候选为 0，rollback 后仍为 0。

Gate：`verify:execution-verifier`、`verify:execution-completion-gate`、stability 与 native 通过；3 目标完成 2/3 不得 done；verifier 自造证据/调工具/改 plan 全拒绝；SQL fault 零候选泄漏；P1 的 finalizer blocker 行为不回退。

## P5：非 Browser 只读 fan-out/fan-in

1. 将现有 Dynamic Delivery 无工具 worker 作为第一种分支 executor。
2. 将 `parallel-branch-orchestrator` 降为运行 primitive，持久分支状态/join/cancel 由 scheduler 负责。
3. 只允许独立 `read_only` 节点并行，并发硬顶 3。
4. 每分支独立 session/checkpoint/budget/evidence，Parent 只读 WorkerReport。

Gate：开启 fan-out 前先在当前待发行 build 重跑 `verify:browser-sequential-regression`，source manifest/commit/build 不一致即失败；随后 `verify:branching-runtime` 与 dynamic-delivery 通过。分支失败不毒化其他分支；`all_required_succeeded` join 不丢失；取消传播；重启可恢复；worker 崩溃时旧 attempt 先结算 interrupted，只读节点从 checkpoint 新建 attempt 重派，不续跑旧模型调用；零 worker 工具/共享写入。

## P6：Candidate branch/select

1. 仅对语义候选与只读产物开放。
2. 实现 branch candidate isolation、fresh selector、winner CAS 和 loser tombstone。
3. 不开 Browser、文件写入、shell、发送和外部事务。
4. 在真实质量/时间/成本数据上与单路径 A/B，没有收益就不默认开启。

Gate：当前 build 重跑 `verify:browser-sequential-regression`、`verify:branching-runtime`、全库 test 与 build 通过；只合并一个 winner；loser 迟到零写入；selector/verifier 零工具；分支质量显著不低于单路径且满足 §10 成本门。最终切换再用同一待发行二进制重跑一次 Browser deterministic gate，不复用 P5 旧报告。

## P7：Browser 多标签页子 Agent 只做入场设计，不在本计划实施

P0–P6 和 Browser 顺序 A1–A12 全通过后，再新建独立实施计划。未来 P7 在开发入场与发布切换前都必须对自己的当前 build 重跑 `verify:browser-sequential-regression`；不同 commit/build 的历史报告无效。入场合同至少是：

1. 每个 branch 独占一个 `BrowserTargetClaim`，资源键绑定 physicalTargetToken + ownerRunId + plan/node/attempt generation。
2. 同 physical target 写入串行，不同 target 才允许并行。
3. 每分支有独立 browser task/journal/research/checkpoint/session，不共享可变状态。
4. `browser_search` 会填字和提交，属于页面 mutation，不能伪装为 `read_only`。未来独立计划最多先开放 2 个 `target_isolated_browser_research` 分支：只允许在各自 claim 的独立 target 内做搜索/翻页/读取，不得产生站点权限决定、下载、表单提交、发帖或其他外部业务写入。
5. 用户接管某 tab 只暂停对应分支，其他分支和用户前台 tab 不受影响。
6. Parent 停止向所有分支传播；分支崩溃可独立恢复；required branches 未 join 父任务不完成。
7. 分支只发布证据 handle/WorkerReport，Parent/fresh verifier 合并，不拼接原始对话。
8. 用户当前 tab、URL、滚动、前台视图和 BrowserView 呈现零变化。

该能力不属于 §5.2 的普通 `readonly_fanout`，也不推翻 §5.4 的 Owner 准入规则。独立计划必须新增受限 side-effect class、工具白名单、target claim 和故障注入合同后，才能有数据地放宽；在此之前，Browser mutation 仍只由唯一 Owner 执行。

## 12. 改动边界和不做事项

1. 不复活已删除的 `direct-chat.ts`、`turn-engine.ts` 或旧 browser runner。
2. 不在 orchestrator 比较具体 DomainAdapter/skill/site id。
3. 不用 prompt-only plan 代替 canonical ledger。
4. 不让模型写 JavaScript workflow/DSL，不引入 QuickJS。
5. 不建任意递归 Agent 拓扑。
6. 不给 worker 复制 Owner 的 tools/capability floors。
7. 不保留旧 DeliveryState scheduler 与新 ExecutionPlan scheduler 长期双轨。
8. 不把 hooks/reminders 当成权限、预算、重试或终态权威。
9. 不因外部文章的百分比声称放宽 Ready 自身验收门。

## 13. 最终顺序

```text
当前日志根因闭环
-> 单 Agent / 单 Owner Browser 完整稳定
-> Canonical ExecutionPlan + 顺序 DAG
-> 节点 checkpoint + 有界 replan
-> typed policy + 统一 recovery + observer-only hooks
-> 节点验收 + 唯一 final verifier
-> 非 Browser 只读 fan-out/fan-in
-> 语义 candidate branch/select
-> 数据证明收益
-> 另立 Browser 多标签页 target-isolated 调研子 Agent 实施计划
```

任何阶段 gate 失败，必须在当层修复和重跑，不得通过提前开启下一种拓扑来绕过。
