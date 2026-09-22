---
title: Ready Durable Agent Runtime 重构实施计划
date: 2026-07-24
kind: implementation
status: approved-for-implementation
enforce: false
owner: 白
author: Codex
approval:
  date: 2026-07-24
  instruction: 收干净当前工作区后，在独立 agent-renew worktree 推进重构
implementation_branch: codex/agent-renew
implementation_worktree: /Users/user/实验田/ready-cowork-agent-renew
review:
  reviewer: adversarial_doc_review
  date: 2026-07-24
  rounds: 4
  verdict: pass
requires:
  - docs/superpowers/specs/2026-07-24-ready-agent-browser-target-architecture.md
  - docs/superpowers/plans/2026-07-22-agent-plan-execute-policy-hooks-and-branching-runtime-design.md
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-07-23-provider-checkpoint-session-integrity-remediation-implementation.md
  - docs/superpowers/testing-conventions.md
paired_plan:
  - docs/superpowers/plans/2026-07-24-browser-unattended-research-implementation.md
joint_cutover_with:
  - docs/superpowers/plans/2026-07-24-browser-unattended-research-implementation.md B6
adjudicates:
  - 复用 2026-07-22 ExecutionPlan 及其 attempt/call/budget/candidate/recovery ledgers；禁止新建通用 WorkItem、ToolCall 或候选双轨
  - A6 不得单独合并，必须与 Browser B6 同一 gate、同一提交边界完成
scope: Task/Turn/Item 生命周期、IntentFrame、资源充分性、07-22 ExecutionPlan 接入、Tool Broker、Artifact/Evidence、Context Builder、Supervisor 自动恢复、统一续作、联合生产切换
documentation_status: archived-in-place
archived_at: 2026-09-06
---

> 原位归档（2026-09-06）：固定历史证据仍引用此路径。保留此路径不代表全文仍是当前合同；其中的状态、源码位置和待办属于原记录。现行约束见 [当前运行时合同](../../architecture/current-runtime-contracts.md)，归档去向见 [文档清单](../../documentation-inventory.md)。

# Ready Durable Agent Runtime 重构实施计划

## 0. 文档定位

本文把目标架构拆成可实施、可回滚分支级、不可双轨上线的 Agent kernel 工作。Browser target、后台控制和真实小红书验收在配对计划中实施。

本文不是对 2026-07-22 Plan-and-Execute 方案的重写。07-22 已确认的 `ExecutionPlan/NodeAttempt/ExecutionCallScope/budget/candidate/recovery/finalizer` 是本计划唯一调度底座；本文只增加用户级 Task/Turn/Item 生命周期并把它接到该底座。两份方案禁止独立并行实施。

用户已于 2026-07-24 确认本方案进入实施。开发只允许在 `/Users/user/实验田/ready-cowork-agent-renew` 的 `codex/agent-renew` 分支推进；当前 `ready-cowork-newtab` 只负责收口、提交现有成果和创建 worktree，不在本轮开始运行时代码重构。

本文中当前 `package.json` 尚不存在的 `verify:*` 命令，都是对应阶段必须新增并接入 `package.json` 的 gate 名称，不是声称当前已经可运行。

## 1. 开工基线

研究证据快照与实施入口：

```text
research source branch=feature/skill-envelope-floors
research source HEAD=70ef036c0613
implementation branch=codex/agent-renew
implementation worktree=/Users/user/实验田/ready-cowork-agent-renew
implementation base=当前工作区完成 OAuth 与本方案独立提交后的 clean HEAD
```

开工前必须：

1. 读目标架构、两份 07-24 审计、`current-runtime-contracts.md` §5–§6、测试规约。
2. 保存 `git worktree list`、implementation base HEAD、branch 与 `git status --short` 为空的开工 receipt。
3. 确认 ChatGPT OAuth/provider slice 与本方案已经是两个独立提交；不得把它们重写、压进 A0 或 reset。
4. 运行：

```bash
npm run typecheck
npm run verify:native
npm run verify:stability
npm run verify:streaming
npm run verify:agent-continuation-clock
npm run verify:browser-target-claims
```

5. 跳过、环境失败和真实产品失败分开记录。
6. 生成一份不含消息正文、Cookie 和密钥的 Agent diagnostics bundle，后续每个阶段都用同一 schema。

### 1.1 Worktree 红线

- 不在 `/Users/user/实验田/ready-cowork-newtab` 实施 A0–A7/B0–B7。
- `codex/agent-renew` 只从完成收口后的 clean HEAD 创建，不从 stash、脏目录或临时补丁创建。
- 新 worktree 初始 `git status --short` 必须为空，HEAD 必须与创建时 source HEAD 一致。
- `.research/` 不随 worktree 复制；实现需要的脱敏证据由 A0 生成仓库内 fixture，不能把本机 App 副本变成构建依赖。
- 第一个实现提交只能是 A0 fixtures/diagnostics；不得提前接 production、重写 Browser 或修改当前权威文档。
- A0–A5、B0/spike/B1–B5、A6+B6、A7+B7 继续遵循本文 §12 的唯一顺序。

## 2. 总完成标准

只有以下全部成立，本文才能标 completed：

1. Task/Turn/Item 是用户任务生命周期唯一可写真值；07-22 ExecutionPlan ledgers 是唯一调度真值。
2. Renderer 不再直接推断/写入完成、等待或可续状态。
3. run、task、Browser child 和 checkpoint 不再各自决定 terminal。
4. 原始小红书 prompt 被识别为 `document input + time-bounded external research`。
5. 1,200 字 excerpt 明确标为 excerpt；Agent 在计划前读取剩余全文。
6. Browser floor 由 missing facts 推导，不要求用户写“打开浏览器”。
7. 100+ tool-call fixture 通过，工具次数不会自然结束 Task。
8. 502、连接断开、进程 kill、context rollover 都自动生成同 task 的 successor turn。
9. “继续”、任务卡、自动恢复和 app 重启共享同一 candidate resolver，但必须各自通过 receipt-based wake authorizer。
10. Tool result 原文进入 Artifact Store；Provider context 使用 typed facts/refs。
11. completion 事务引用已结算的 ExecutionPlan nodes、Browser domain evidence 和 artifacts，并原子写 Task、Turn、final outcome 与唯一 canonical message。
12. A6+B6 在同一联合切换提交中删除旧生产写路径；不存在长期 feature flag 双写。
13. 所有新增文件行数健康；净增后按根指引更新 large-file log。
14. 配对 Browser 计划的真实 Electron 验收通过后，才能宣称用户目标完成。

## 3. 先写的机器合同

### C1. 单一写入者

除 `AgentRuntimeSupervisor/finalizer` 外，任何生产模块写 Task/Turn terminal 都必须被静态 gate 拒绝。ExecutionPlan、Browser domain、target claim、action journal 和 artifact/evidence 仍由目标架构 §3.7 的具名 repository 唯一写入；Supervisor 不能复制这些表的 payload。

建议 gate：

```text
scripts/check-agent-kernel-single-writer.cjs
```

### C2. 连续事件

每次 Task item append 必须满足：

```text
expectedTaskRevision == current revision
new sequence == last sequence + 1
itemId unique
```

失败不允许 best-effort 补写 projection。Plan/domain/action 变化只追加带 revision/digest 的 reference item，不复制第二份真值。

### C3. 终态唯一

`task_settled` 只能出现一次，且同事务必须含：

- terminal Task；
- terminal active Turn；
- verifier receipt；
- exactly one canonical assistant item；
- expected artifact readback；
- no open required ExecutionPlan node；
- Browser domain mandatory coverage settled。

### C4. 续作同一身份

所有 candidate source 返回：

```text
taskId
checkpointId
browserTaskId?
expectedRevision
taskStatus
waitingReason
wakeEvidencePolicy={ mode: allOf|oneOf, kinds: [...] }
recoveryEpoch?
```

随后必须由独立 wake authorizer 校验匹配 receipt set，原子铸造幂等 WakeAuthorizationReceipt；resolver 自身不能创建 Turn。授权成功后只有 turnId/attempt 改变。

### C5. 资源完整性

每个 resource 必须带：

```text
complete | excerpt | unknown
byte/char range
content digest
source identity
```

模型不能把 excerpt 当全文。

### C6. Context 不是真值

删除 provider session/history 不得删除：

- objective；
- acceptance；
- plan；
- ExecutionPlan node/attempt state；
- Browser domain work state；
- evidence；
- action receipts；
- checkpoint；
- expected outputs。

### C7. transient failure 自动接力

有 clean checkpoint 且没有 `effect_unknown` 的 transient failure：

```text
running → recovering → running
```

测试中不得需要用户消息。

## 4. A0：固定当前失败，建立无敏感诊断包

### 目标

在任何重构前把这次任务的启动、续作和 119-tool 证据固定成行为测试与脱敏 fixture。

### 实施

1. 增加原 prompt fixture：

```text
tests/fixtures/agent-kernel/xhs-low-follower-research/
  request.json
  resource-manifest.json
  document.md
  acceptance.json
```

2. Fixture 保留文档结构，但不含用户 Cookie、账号或真实私密数据。
3. 增加当前失败测试：

- 原 prompt 当前行为错误地 `primaryDomain=document`；
- live-info 被文档 hint 抑制；
- current document 只有 excerpt；
- Browser 未进入 floor；
- suspension checkpoint 存在但自然语言 candidate 为空；
- child 18/18 + paused + result null；
- IPC success 与 Task 非 terminal 同时出现。

4. 增加 diagnostics exporter：

```text
run_meta
task/turn projection
browser task
checkpoint metadata
event/metric slice
provider diagnostics
runtime/build/DB identity
source HEAD + dirty-file manifest
source-symbol map
read-only SQL text + result digest
metric aggregation command/version + result digest
input document path/sha256/byte-char-line counts
```

5. exporter 默认移除：

- user/assistant message text；
- tool arguments 原文；
- URL query；
- Cookie/token；
-文件正文；
- Provider credentials。

6. 先用 gap audit §14 的命令生成本机 119-tool 脱敏 manifest；fixture 必须保存：

- `runId/taskId/browserTaskId/checkpointIds`；
- 106/119、compaction 汇总和 Provider 502 分类；
- `sourceHead=70ef036c0613ef949560e0f0229c1c674ff1373e`；
- 目标文档 `sha256=b42a594a97ed650bb5aeef3c19005a4afbec52f51daf2d85659883e17220e6fa`；
- 每个原始来源文件的 basename、size、mtime 与 SHA-256；
- 脱敏 JSON 自身 SHA-256。

原始日志/数据库不进入仓库，fixture 只含聚合数值、身份、digest 和复核命令。

### 验证

```bash
npm run verify:agent-kernel-baseline
```

初始预期为红；测试必须能区分“当前已知失败”和测试自身损坏。

### 出口

- 能在异机运行 exporter 并得到同 schema 包；
- 78 次异机 run 可在后续拿到 bundle 后独立定性；
- 当前行为被 fixture 锁定。

## 5. A1：Task/Turn/Item Lifecycle 与 Projection

### 目标

建立用户任务生命周期 store，并把它接到 07-22 已批准的 ExecutionPlan ledgers；不接生产 sendScoped。

### 建议模块

```text
src/main/modules/agent-kernel/
  contracts.ts
  task-item-store.ts
  task-repository.ts
  projection-builder.ts
  supervisor.ts
  terminal-transaction.ts
  startup-reconciler.ts
```

文件名可以按现有目录惯例调整，但职责不能重新塞回 `runtime.ts` 或 `orchestrator.ts`。

### 数据迁移

只新增用户生命周期所需的三张表：

- `agent_tasks_v2`
- `agent_turns_v2`
- `agent_task_items`

明确不新增：

- `agent_work_items`：复用 `ExecutionPlan/NodeAttempt`，Browser 细项留在 BrowserResearchState；
- `agent_tool_calls`：复用现有 authorization/action journal；
- 新 candidate/attempt/budget/recovery 表：复用 07-22 `execution_*` ledgers；
- `agent_artifacts/agent_evidence`：复用统一 ArtifactStore 与 domain evidence index；
- `agent_checkpoints_v2`：复用 call-scope/domain checkpoint store。

`v2` 只是迁移期表名，不是生产双轨 API 名。切换完成后文档和代码统一称 Task/Turn/Item。

### 表权威注册

实现前先把目标架构 §3.7 的注册表编码成测试 fixture。每张表必须声明：

```text
classification
soleWriter
rebuildable
rebuildSources
transactionOwner
conflictAuthority
```

测试枚举所有新旧表；缺声明直接失败。Task item 只能保存 canonical ref/revision/digest，禁止嵌入 plan revision、Browser journal、tool result、evidence payload 或 checkpoint input。

### 实施顺序

1. 先 migration + repository native tests。
2. Task item append 与 revision CAS。
3. 接入 07-22 ExecutionPlan ledger 的 read references。
4. projection 从 Task items + ExecutionPlan + Browser domain + action/evidence stores 全量重建。
5. terminal transaction。
6. startup reconciler。
7. corrupt/gap/duplicate item 或 dangling canonical ref fail closed。

### 失败注入

在每个边界 kill：

- Task item append 前；
- Task item append 后 projection 前；
- projection 后 canonical message 前；
- canonical message 后 commit 前；
- commit 后 UI publish 前。

重启后必须得到同一 terminal 或同一 running/recovering 状态，不得重复 canonical message。

### 验证

```bash
npm run verify:agent-kernel-store
npm run verify:native
```

### 出口

离线 fixture 可以完整跑：

```text
queued → running → tool items → completed
```

删除 projection 后可从所有 canonical stores 重建相同 digest；删除任一 canonical store 必须 fail closed，不能从 projection 反推。

## 6. A2：IntentFrame 与 Resource Sufficiency

### 目标

把 regex domain classifier 从能力裁决权威降为提示。

### 实施

1. 定义 `IntentFrame` schema。
2. 同一 Agent Turn 的首个结构化 item 输出 objective、resources、acceptance、missing facts、capability floor、planRequired；不新增独立分类模型调用，允许与直接答案或首个计划动作同一边界返回。
3. Resource Sufficiency Verifier 检查：

- `current/time_bounded` 外部事实是否有 live source；
- 文档是否 complete；
- acceptance 是否都有数据来源；
- required capability 是否可用。

4. 原 prompt 必须输出：

```text
resources=[document: excerpt/complete]
missingFacts=[publishedAt, likes, followerCount]
requiredCapabilities=[browser]
planRequired=true
```

5. 删除 `LOCAL_DOMAIN_HINTS` 对 live-info 的绝对否决。
6. 删除 `excludedDomains` 对合法能力 group 的关闭权。
7. 正则只可：

- 提醒模型可能的 domain；
- 为模型失效提供保守 floor；
- 不能压掉模型声明的 capability。

8. 修正文档资源：

- 普通 current document 带 excerpt metadata；
- 若全文小于安全读取上限，直接注入 complete；
- 超限则必须提供 `read_resource` continuation，而不是静默截断。

### 行为测试

- 文档 + 实时外部数据；
- 文档更新 Widget，不需要 Browser；
- 纯本地文档总结；
- 当前新闻 + 输出到文档；
- 小红书实时筛选；
- 附件 excerpt；
- 多文档 + Browser；
- 用户明确禁止联网。

### 验证

```bash
npm run verify:agent-intent-frame
npm run verify:document-resource-contract
```

### 出口

原 prompt 无需修改即可进入 Browser floor；Widget 更新等反例不被误路由。

## 7. A3：接入 07-22 ExecutionPlan 与 Completion Spec

### 目标

长任务进度脱离聊天文本和 Browser child 自报数字，并且不建立第二份 plan/work ledger。

### 实施

1. `planRequired` 为真时，按 07-22 admission contract commit 唯一 `ExecutionPlan` revision/head。
2. 使用既有 `ExecutionNode/NodeAttempt/ExecutionCallScope`，不编译出第二套 typed WorkItems。
3. NodeAttempt 状态变化只接受带 evidence/receipt 的 ledger transaction。
4. Browser 关键词、候选和字段核验保留在 BrowserResearchState；ExecutionPlan Browser node 只保存 domain refs/watermarks。
5. progress 从 required ExecutionPlan nodes + Browser domain coverage 派生。
6. Completion Spec 包含：

- required ExecutionPlan node + Browser domain coverage；
- evidence schema；
- expected artifacts；
- semantic verifier prompt；
- code-verifiable predicates。

7. XHS fixture：

- 18 keyword items；
- candidate child items；
- publishedAt/likes/followers evidence；
- accepted/rejected reason；
- 10 output items。

7. 禁止：

- 模型直接写 total/completed；
- succeeded node 或 accepted domain item 无 evidence；
- rejected domain item 无 reason；
- 把“搜索过”当“核验通过”。

### 验证

```bash
npm run verify:agent-plan-ledger
npm run verify:agent-completion-contract
```

### 出口

进程被 kill 后，只读 ExecutionPlan + Browser domain ledgers 即可知道已完成、已淘汰和剩余项，不读聊天正文也能续作。

## 8. A4：Tool Broker、Artifact Store 与 Context Builder

### 目标

停止每轮携带完整工具面和大工具历史。

### 实施

1. 建立基础工具面。
2. capability 激活后按当前 work item 注入 action。
3. 每个 tool descriptor 声明 effect/approval/target/result contract。
4. Tool result 先规范化为：

```text
summary + facts + artifactRefs + receipts + nextStateHints
```

5. 原始 DOM、截图、网络记录和大 JSON 入 Artifact Store。
6. Context Builder 从 Task/ExecutionPlan/NodeAttempt/Browser domain/Evidence 构建 provider input。
7. Compaction 只压缩 recent narrative，不得重写 durable facts。
8. 记录每轮：

- tool schema count/tokens；
- task facts tokens；
- recent items tokens；
- artifact facts tokens；
- omitted reason。

### 对照 fixture

用 119-tool 指标形状构造 150-tool run：

- 38 个 Browser mutation/read；
- 大页面结果；
- screenshot；
- context rollover；
- 3 次 Provider transient failure。

断言：

- checkpoint 不保存 1.4 MB 完整 SDK input；
- Provider input 不随总 tool count 线性增长；
- 已接受 evidence 不因 compaction 消失；
- tool schema 只含当前 capability/action；
- raw artifact 可回读。

### 验证

```bash
npm run verify:agent-tool-broker
npm run verify:agent-context-builder
```

### 出口

150-tool fixture 完成；删除 Provider session 后仍能从 canonical ledgers 构造下一 Turn。

## 9. A5：Supervisor、Failure Taxonomy 与统一续作

### 目标

502、runtime crash、context rollover 和用户“继续”都回到同一 task。

### 实施

1. 建立 failure taxonomy。
2. Provider 有界重试耗尽后：

- commit clean checkpoint；
- Task → recovering；
- 扩展 07-22 `execution_recovery_blocks`，持久化 recovery schedule；
- supervisor 只在 `retryAt` 到期后安排 successor Turn；
- 不生成 `blocked_tool_error`；
- 不需要用户消息。

3. Recovery schedule 必须保存：

```text
parentTaskId
recoveryEpoch
sourceCallScopeId
consecutiveSuccessorAttempts
firstFailureAt
retryAt
retryAfterSource
lastErrorClass/httpStatus
policyVersion
wakeReceiptId
```

4. 同 Turn transport retry 只允许在零 accepted delta/零 tool effect 时执行，最多 6 次；优先遵守 `Retry-After`，否则 full-jitter exponential backoff。
5. 自动 successor 硬顶为 30 分钟内 3 个 Turn；耗尽进入 `waiting_service` 并保留 checkpoint，不得热循环或 terminal failed。
6. Startup reconciler 幂等恢复 due schedule；Provider health 探测不计入 Task attempt，也不能直接推进 Task。
7. wake 事务 CAS `task revision + status + recoveryEpoch`：

- cancel 胜过旧 timer；
- 手动重试先增加 recoveryEpoch；
- steering 排入下一个 successor input，不并发创建第二个 active Turn；
- 重放 wake receipt 只读回原结果。

8. Tool `effect_unknown` 进入 observation/reconciliation。
9. 续作拆成 `resolveContinuationCandidate` 与 `authorizeWake`：

- resolver 只定位 task/checkpoint/browserTask，并返回 status、waitingReason、`wakeEvidencePolicy={mode: allOf|oneOf,kinds}`、expectedRevision/recoveryEpoch；
- authorizer 接收 receiptSet，验证组合关系及每枚 receipt 的 task/checkpoint/revision/reason/target/generation/expiry；
- 只有完整组合通过并原子写入一枚幂等 WakeAuthorizationReceipt 后，才可创建唯一 successor Turn。

10. 自然语言 follow-up 不再读取瞬时 `canResume`，也不能自行铸造 approval/security/interaction receipt。
11. candidate discoverable 由：

```text
Task non-terminal/waiting/recovering
+ valid checkpoint
+ revision
```

派生。

12. wake authorization 矩阵：

| 状态 | wakeEvidencePolicy |
| --- | --- |
| recovering | `oneOf(scheduled-recovery, explicit-service-retry)` |
| waiting_user/required choice | `allOf(interaction-result)` |
| waiting_user/site security | `allOf(interaction-result, same-target observation)` |
| waiting_approval | `allOf(unexpired approval)` |
| paused | `allOf(explicit resume)` |
| waiting_service | `oneOf(provider-health, explicit-retry, provider-change)` |

13. typed button、natural language、auto retry、startup reconciler 都先走 candidate resolver，再带各自合法 receipt 走 authorizer。
14. 用户 steering 使用 expectedTurnId/expectedRevision。
15. non-critical ask 支持代码侧 auto-resolution；critical ask 进入 waiting_user。

### 故障矩阵

| 注入点 | 预期 |
| --- | --- |
| 第 1 次 Provider call 前 502 | 自动 successor |
| 第 78 次 tool result 后 502 | 同 task、已收据动作不重复 |
| Provider 持续 502 超过 3 successor/30 分钟 | waiting_service；无热循环 |
| `Retry-After` 跨 app restart | 到 retryAt 才幂等唤醒 |
| timer 与 cancel 竞态 | cancelled，旧 wake 零写入 |
| timer 与手动 retry/steering 竞态 | 单 active Turn，新 epoch 胜出 |
| tool call 发出前 kill | 安全重试 |
| external effect 后、receipt 前 kill | effect_unknown → 观察 |
| context rollover | 新 Turn，不等待用户 |
| Renderer reload | Task 不变 |
| app restart | startup recovery |
| waiting_user/安全验证未完成 + 用户说继续 | 只定位；零新 Turn |
| 安全验证只提交 interaction 或 observation 其中一枚 | 零新 Turn |
| 安全验证两枚均匹配并重复提交 | 只有一个 WakeAuthorizationReceipt/一个 successor |
| waiting_approval + 普通继续/错误或过期 receipt | 零新 Turn |
| paused + 明确 resume receipt | 命中同 checkpoint |
| waiting_service + 普通继续 | 只定位；零新 Turn |
| receipt task/target/generation/revision 不匹配 | 零写入 |
| 正确 interaction/observation/approval/health receipt | 同 checkpoint 创建一个 successor |
| stale expectedTurnId | 拒绝旧 steering |

### 验证

```bash
npm run verify:agent-supervisor
npm run verify:agent-recovery
npm run verify:agent-continuation
```

### 出口

短暂 502/kill 的 150-tool fixture 无人工干预完成；持续服务不可用则在硬顶内稳定进入 waiting_service，且保留同一 Task/checkpoint。

## 10. A6：与 Browser B6 联合生产切换

### 目标

让新 kernel 和新 Browser adapter 一次成为唯一生产权威，不留“新 Agent + 旧 Browser”或“旧 Agent + 新 Browser”的半切换状态。

### 前置与提交边界

A6 只有在 A0–A5、Browser 后台指针可行性 spike、B0–B5 全绿后才能开始。A6 与 Browser B6：

- 使用同一 integration branch；
- 共享同一个 `verify:agent-browser-joint-cutover` gate；
- 在同一个不可拆提交/PR 中合并；
- 任一侧失败，整个切换回滚到尚未接生产的状态；
- 禁止先合并 A6、再等待 B6。

### 切换范围

必须同批迁移：

- `agent:sendScoped` admission；
- Agent SDK turn orchestration；
- task card projection；
- canonical assistant message；
- Renderer status；
- continuation；
- startup reconciliation；
- Browser adapter 的 parent Task 事件。
- Browser Runtime Service、target claim、domain evidence 和 Task projection 的联合引用。

### 旧路径处置

切换后删除或降为只读迁移：

- `run_meta` 的 terminal 写权；
- `task_projections` 的独立 terminal 写权；
- Renderer 依据 transient output 猜 done；
- raw `canResume`；
- `intent-classifier` 的 excluded-domain authority；
- Provider failure → Browser `blocked_tool_error`；
- 依赖完整 SDK input 的通用续作；
- 旧 stale projection finalizer；
- 重复的 startup recovery。

确需保留的旧表只能用于历史只读展示，不能接收新 Task。

### Migration

对旧未完成任务：

1. 有有效 Browser suspension checkpoint：迁为 waiting/recovering Task。
2. 有 run_state handle：迁为 recoverable Task。
3. 只有文字“可继续”但无 handle：迁为 failed/recovery_required。
4. completed 但无 canonical message：不得伪造完成；标 integrity_failed。
5. 写 migration receipt，保证幂等。

### Cutover gate

静态检查确认生产调用图只有：

```text
sendScoped
→ AgentRuntimeSupervisor/Main Unit of Work
→ Task/Turn/Item + 07-22 ExecutionPlan + Browser domain refs
```

没有旧 Agent/Browser terminal writer。联合 gate 还要拒绝 A6/B6 任一单侧 production binding。

### 验证

```bash
npm run typecheck
npm run verify:agent-kernel
npm run verify:native
npm run verify:stability
npm run verify:streaming
npm run verify:agent-continuation-clock
npm run verify:agent-browser-joint-cutover
npm run build
```

### 出口

新 Task 只出现在新 lifecycle/ExecutionPlan/Browser canonical stores；旧表无新增写入。A6+B6 已形成一个可启动、可续作、可收口的完整生产路径。

## 11. A7：真实 Electron Agent 验收

Browser 外部采集按配对计划执行；本阶段先验收 runtime：

1. 在隔离 profile 启动当前源码 build。
2. 提交原 prompt 与目标文档。
3. 观察 Task/Turn/Item、ExecutionPlan/NodeAttempt 和 Browser domain references 真实入库。
4. 注入一次 Provider 502。
5. 关闭并重开 Renderer。
6. kill Agent worker，由 supervisor 拉起。
7. 验证 taskId 不变、turnId 递增、ExecutionPlan node/Browser domain item 不回退。
8. 等待 Browser 配对计划完成最终外部验收。

报告必须包含：

- binary/source manifest；
- profile/DB identity；
- task/turn/item、plan/node/domain ids；
- failure injection receipts；
- projection readback；
- canonical terminal；
- integrity metrics。

缺字段非 0 退出。

## 12. 实施顺序与提交边界

唯一合法总顺序：

```text
A0–A5
→ Browser B0 + 后台指针可行性 spike
→ Browser B1–B5
→ A6+B6 同一个不可拆 production cutover
→ A7+B7
```

A0–A5 内部可以按 fixture、lifecycle store、IntentFrame、ExecutionPlan 接入、Tool Broker/context、supervisor/recovery 分为独立提交；B0–B5 同理。它们在联合切换前都不得接生产入口。A6+B6 必须是一个提交/PR 边界，不能拆分。A7+B7 只添加验收证据与权威文档更新。

每个提交只做一个职责；move-only 拆分与行为修改分开。

## 13. 与现有计划的关系

- 07-22 Plan-and-Execute 是已确认底座，不是被本计划整体取代。逐项裁决如下：

| 07-22 合同/表 | 本计划裁决 | 唯一实施阶段 |
| --- | --- | --- |
| `execution_admissions` | 复用；A2 的 IntentFrame/Resource Sufficiency 作为 typed admission facts，不另建 admission | A2 |
| `execution_plan_heads/revisions` | 原样复用，仍是唯一 canonical plan | A3 |
| `execution_node_attempts` | 原样复用；取代草案中的通用 WorkItem | A3 |
| `execution_call_scopes/provider_requests` | 原样复用；所有 provider 调用和 checkpoint/retry 绑定同一 scope | A4–A5 |
| `execution_parent_budgets/budget_entries` | 原样复用；重启和 successor 不重置 | A4–A5 |
| `execution_resource_claims/bindings` | 原样复用通用资源；Browser target 只保存 `browser_target_claims` handle | A4 + B3 |
| `execution_control_receipts` | 原样复用 policy/control 去重；不得复制工具 action journal | A3–A5 |
| `execution_recovery_blocks` 与 interaction ledgers | 扩展 durable `retryAt/recoveryEpoch/wakeReceipt`，不新建平行恢复真值 | A5 |
| `execution_candidates/deltas/acceptances/selections` | 原样复用 sealed output 与唯一 canonical message acceptance | A3 + finalizer |
| `execution_verifier_receipts` | 原样复用；Completion Verifier 不建第二份 receipt | A3 + finalizer |
| BrowserResearchState / `browser_tasks` | 保留为 Browser 域内动作、候选、证据与 checkpoint；不决定 Parent terminal | B1–B5 |
| `TaskProjection` | 仍然只读派生；改从 Task/Turn/Item + 上述 ledgers 联合重建 | A1 |
| `TurnFrame` | 保持 turn-local；不升级成 durable plan/task 真值 | A1/A4 |
| authorization/action journal | 原样复用普通工具 allow/result/effect；不新增 `agent_tool_calls` | A4/B4 |

- 07-22 与本文在 owner 明确批准合并实施前互斥：不得分别建立分支并各自建表。本文通过对抗审查只代表文档无自相矛盾，不自动取得生产开发授权。
- `../../archive/2026-09-06/docs/superpowers/plans/2026-07-23-provider-checkpoint-session-integrity-remediation-implementation.md` 中 P10–P15 仍是当前 live runtime 的近期收口，不因本文自动取消。
- 若新 kernel 尚未开工，先完成其已授权且必要的 canonical/checkpoint 修复，避免现有用户继续踩坑。
- 一旦 A6+B6 联合切换，新 kernel 的 terminal transaction 取代旧 run/projection/Browser child 收口；届时同步把 07-22 与本文标为 implemented-by-runtime。
- 07-22 Browser 顺序收口中已完成的 target claim、typed checkpoint 和 takeover 证据应迁入新 Browser adapter，不复活 surface 级旧 lease。

## 14. 停止条件

只有以下情况暂停并找 owner：

- 需要处置现有未提交 OAuth/provider 改动但归属不明；
- 需要迁移/删除无法恢复的真实用户任务；
- 需要新的外部费用、账号或平台授权；
- 目标架构与已确认产品语义发生冲突；
- 真实 XHS 验收遇到必须由用户完成的 QR/安全验证。

普通测试失败、重构困难或文件过大不是停下理由，应继续定位和修复。
