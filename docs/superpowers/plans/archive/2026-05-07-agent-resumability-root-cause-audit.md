---
title: Agent 模块「任务卡残留 + 无法继续上一任务」根因审查
date: 2026-05-07
status: audit
enforce: false
authors:
  - Claude Code (Opus 4.7, 1M)
  - Codex (rescue subagent)
review:
  type: peer-audit-loop
  rounds: 2
  outcome: converged
---

# Agent 模块根因审查 · 2026-05-07

> 本文档是一份**只读审查报告**，不是实施计划。两位审查者（Claude Code 与 Codex）经过两轮 file:line 级对等核验后收敛于本文。后续若推进修复，对应实施计划应另起 `*-implementation.md`。

## 0. 症状

重启 Electron 后观察到：

1. **缺口 1：任务卡残留**——上一会话的 humanizer-zh 任务卡仍显示在 UI，状态为 `blocked`，可继续动作为 `["continue","retry","cancel"]`。
2. **缺口 2：继续不了**——点"继续"后 0 次工具调用就直接 `checkpoint_budget`，预算其实从未真正消耗。

DB 端的事实：
- 最新 `task_projections` row：`status='blocked'`、`resumableActions=['continue','retry','cancel']`、`continuationRef={taskRunId, skillId, action}` 三字段且 outputDir/runStatePath/childRunId/detachedTaskId 全空。
- 最新 `skill_task_runs` row：`runKind='primitive'`、`action='skill_write_artifact'`、`toolName='skill_lifecycle'`、`status='blocked'`、`skillId='humanizer-zh'`。
- skill 配置：humanizer-zh 是 `runtime: reference + execution: advisory`，本质是方法论而非可后台续跑的长任务。

## 1. 完整因果链（双方在源码级别核对过）

### 1.1 缺口 1：「卡片残留」是怎么写进 DB 的

| 步 | 行为 | 证据 |
|---|---|---|
| 1 | 用户上一轮某时刻调用了 primitive `skill_write_artifact`。Stage 4 W3 之后此 primitive 的 `skillId` 由 `runtimeContext.authorization` 决定，而 humanizer-zh 通过 `SkillTurnIdentity → buildAuthorizationFromIdentity` 被授权 → primitive 写入归到 `skillId='humanizer-zh'`。 | `skill-tool-authorization.ts:169-178`、`skills-tools.ts:406-419` |
| 2 | `recordPrimitiveOutcome` 调 `recordSkillTaskEvent`，入 `findTaskRunForEvent`（按 `sessionId+skillId+!childRun` 找 active），若无则 `repository.create` 一条 row：`runKind:'primitive'`、`action:'skill_write_artifact'`、`status:'running'`。 | `skills-tools.ts:957-1000`、`skill-task-tracker.ts:451-467, 374-405`、`skill-task-run-repository.ts:265-308` |
| 3 | primitive 立刻结束，`updateRowSync` 标 `done`/`failed`。**此时 DB 里这条 row 对外就是"humanizer-zh 的活跃任务"，因为 active 表只按 sessionId+skillId 索引，不区分 runKind/action**。 | `skill-task-tracker.ts:451-467` |
| 4 | 之后 orchestrator/supervisor 触发某次 lifecycle event（典型是 `state='budget_paused' or 'recoverable_paused'`），`recordSkillParentTaskLifecycleEvent` → `findTaskRunForLifecycleEvent` 仍按 `sessionId+skillId` 匹配，**复用了第 3 步的 primitive row**。 | `skill-task-tracker.ts:470-493, 484-486` |
| 5 | `updateRowSync` 覆盖 row：`toolName:'skill_lifecycle'`、`status: lifecycleRunStatus(state)`（注意 `budget_paused/recoverable_paused/blocked` 都被映射成 row.status='blocked'，:251-254）、`action: event.action ‖ current.action`（lifecycle event 通常 action 为空，所以保留旧 `'skill_write_artifact'`）。`runKind` 不被覆盖，仍是 `'primitive'`。 | `skill-task-tracker.ts:659-690, 251-254` |
| 6 | row 现在自相矛盾：`runKind:'primitive' + toolName:'skill_lifecycle' + action:'skill_write_artifact' + status:'blocked'`。schema 没有任何 CHECK/UNIQUE 阻止这种组合存在。 | `migrations.ts:1443-1485`，CHECK 缺失 |
| 7 | 同步路径里 `task-projection-sync.ts:354-355` 有 stale fallback：`if (previous?.resumableActions?.length>0) return previous.resumableActions`——一旦更早某轮（lifecycle state='budget_paused'）写过 `['continue','retry','cancel']`（`skill-task-lifecycle.ts:153-160`），后续即使 row.status 已被映射成 'blocked'（其本应触发 `['continue','cancel']`，见 lifecycle.ts:168 + tracker:272），3 动作组合仍被复制到新 projection。 | `skill-task-lifecycle.ts:147,158,168,178`、`task-projection-sync.ts:353-355`、`skill-task-tracker.ts:271-274` |
| 8 | `task_projections` 持久化到 SQLite。 | `task-projection-repository.ts:151-162, 230-240` |
| 9 | 重启 → renderer cold-start 第 4 段直接从 projection 合成 TaskCardRun，`resumableActions: projection.resumableActions ?? []`，无 canResume 真值校验。 | `ChatPanel.tsx:2437-2489`、`taskCardViewModel.ts:410-417` |
| 10 | Reconciler 0~30 分钟内不会标 `stale_paused`（`STALE_WITHOUT_HANDLE_MS = 30 * 60_000`），且修正写入用 `{silent:true}` 断 fetch 循环——renderer 不会被推送，必须等下一次外部 fetch。 | `task-projection-reconciler.ts:12, 764-785`、`task-projection-repository.ts:139-140` |

### 1.2 缺口 2：「继续不了」的执行链

| 步 | 行为 | 证据 |
|---|---|---|
| 1 | 用户点继续按钮（按钮可见性受 `interactionState==='suspended'` + `resumableActions.includes('continue')` 驱动）。 | `ChatPanel.tsx:1134-1168` |
| 2 | `handleResumeTask` 透传 `taskContinuation`，不校验。 | `ChatPanel.tsx:3113-3121, 2948-2976` |
| 3 | main 端 `runtime.resumeRun → buildContinuationIntent` 仅校验 `if (!taskId) return null`，其余字段全 fallthrough。 | `runtime.ts:2232-2275` |
| 4 | `turn-engine.ts:1690-1702 shouldBindSkillContextForTurn` 把 `isSkillResumeTurnDetected‖isSkillRestartTurnDetected‖hasExplicitSkill‖…` 都纳入。 | `turn-engine.ts:1690-1702` |
| 5 | `:1726-1734` 调 `resolveActiveSkillContext`，按 supervisor/projection/taskRun 内部优先级返回**第 1.1 步那条混合 row 派生出的 context**。 | `turn-engine.ts:1723-1734`、`active-skill-context.ts:398-427` |
| 6 | `:1751-1761` 又独立调 `inspectLatestSkillTaskForHost` → 同一份 supervisor snapshot：`status='blocked'`、resumePayload 仅含空壳字段。 | `turn-engine.ts:1751-1761`、`skill-task-supervisor.ts:417-661` |
| 7 | `resolveTurnFrame` 被灌入 (activeContext + supervisorSnapshot + userIntent)。 | `turn-engine.ts:1778-1804` |
| 8 | `chooseContext` 在没有 explicitSkillId 时**直接走 supervisor 分支**返回（不检查 userIntent）。 | `turn-frame-resolver.ts:116-145` |
| 9 | `inferLiveness`：`status==='blocked'` → liveness='blocked'（如果是 budget_paused/recoverable_paused → 'recoverable_paused'，但 row 已被映射成 'blocked'，所以这里走 'blocked' 分支）。 | `turn-frame-resolver.ts:148-167` |
| 10 | `loadSkillRunContract` 最低门槛：`!skillId && !outputDir && !taskRunId && !detachedTaskId` 才返 null；混合 row 携带 skillId+taskRunId→**返回幽灵 contract**（artifactRoots: []、actionInput: null、status: 'blocked'）。 | `run-contracts.ts:1408-1427, 1624-1635` |
| 11 | Frame 现在带幽灵 contract + blocked liveness 进 steering。**blocked 本身可 force**（`turn-frame-steering.ts:375-423`），但当 typed tool 缺失或 input 缺失时降级为 checkpoint。幽灵 contract 没有 actionInput，steering 找不到合法的 typed tool 入口。 | `turn-frame-steering.ts:249-273, 375-423, 507-531` |
| 12 | 降级 → mid-loop checkpoint → `budgetLimitedBeforeCompletion = true` → 收口阶段直接 `terminalReason='checkpoint_budget'`。用户看到"什么都没发生"。 | `turn-engine.ts:3460-3471, 4443-4508` |

### 1.3 「重新开始」也救不回来——结构层泄漏

`turn-engine.ts:1521-1528 explicitFreshSkillStart` 要求**一句话里同时给出 URL**（`hasUrlSourceSignal`），所以纯文字"重新开始"不会触发它。链路：

- `:1451 isSkillRestartTurnDetected = true`、`:1452 isSkillResumeTurnDetected = false` ✓
- `skill-turn-identity.ts:207-229` 给出 `mode:'skill', relation:'new', source:'skill_history'` ✓
- `:1690-1702 shouldBindSkillContextForTurn` 仍 true（因为 `isSkillRestartTurnDetected`）→ 加载旧 supervisor
- `skill-turn-identity.ts:696-700`（apply 阶段，**关键泄漏**）：
  ```
  if (activeSkillContext && isSameSkillRunForResume(...)) {
    rememberActiveSkillContext(sessionId, activeSkillContext)
  }
  ```
  这条**不分 `relation==='new'` 还是 `'resume'`**，restart 也照样把旧 active context 重新写回。`relation` 只影响 `skillContextInjectionText` 的措辞（`skill-turn-identity.ts:682-689`），不影响 frame 构建。
- `turn-engine.ts:1736-1739`：`if (!explicitFreshSkillStart) rememberActiveSkillContext(...)`——同一份旧 context 被记第二次。
- `turn-frame-resolver.ts:192-199 inferMode`：`mode='skill_start'` ✓
- 但 `:148-167 inferLiveness` 用同一份旧 supervisor → liveness 仍是 `'blocked'`/`'recoverable_paused'`

**结论**：identity 的 `relation:'new'` 与 frame 没有强绑定。frame 由 `chooseContext + inferLiveness + loadSkillRunContract` 独立构建，identity 给出的 reason/relation 字段不会影响这条结构链。authorization 也只读 `identity.source`、不读 `identity.relation`（`turn-engine.ts:1824-1827`、`skill-tool-authorization.ts:147-178`）。

## 2. 根因——三层并存，缺一不可

| 层 | 描述 | 仅修这一层会留下什么尾巴 |
|---|---|---|
| **入口层 P0a**：reference/advisory primitive 进 lifecycle 没有 fence | `recordSkillTaskEvent + rememberSkillRun`（`skills-tools.ts:957-1000`）不读 manifest 的 `runtime`/`execution.mode`；最近的 fence `isOrphanedChildLoopLauncher`（`skill-task-supervisor.ts:361-369`）只挡 `runKind:'typed_action'+child-loop`，对 primitive 失效。 | 非 reference skill 的 primitive 仍会被 lifecycle event 复用并改写到自相矛盾的 row |
| **数据模型层 P0b**：同一 `skill_task_runs` row 被 primitive 和 lifecycle 两个 writer 反复改写 | `findTaskRunForEvent / findTaskRunForLifecycleEvent`（`skill-task-tracker.ts:451-493`）按 `sessionId+skillId` 复用；`updateRowSync`（:659-690）保留旧 `runKind/action`、覆盖 `toolName/status`。schema 无 CHECK 阻止这种自相矛盾组合。Projection key `skill:${session}:${skill}`（:203）也共享，加剧问题。 | 即使 P0a 在，非 reference skill 的 primitive 行仍会被 lifecycle 改写状态污染下游判定 |
| **合同层 P0c**：5 个 writer/reader 各自定义"可继续"，互不约束 | 见下表 | UI 仍可能在重启后展示 stale 卡片，main 仍可能透传空壳 continuation intent |

### 2.1 五层「可继续」定义（核心证据表）

| 层 | file:line | 接受什么作为可继续 |
|---|---|---|
| Lifecycle | `skill-task-lifecycle.ts:65-74` | `taskId‖taskRunId‖detachedTaskId‖runStatePath‖outputDir‖skillId` 任一 |
| Supervisor | `skill-task-supervisor.ts:371-379` | `resumePayload‖runStatePath‖outputDir‖detachedTaskId‖taskRunId` 任一 |
| Reconciler ⬅ 唯一严格的 | `task-projection-reconciler.ts:537-539` | `outputDir‖runStatePath` 严格 |
| ContinuationIntent | `runtime.ts:2245` | 仅校验 `taskId` 在 |
| Renderer | `ChatPanel.tsx:1134-1168` + `taskCardViewModel.ts:410-417` | `resumableActions.includes('continue')` + `interactionState==='suspended'` |

只有 reconciler 是对的；它的修正又因为 `silent:true`（`task-projection-reconciler.ts:785`）和 30 分钟阈值（:12, :764）不会推到 renderer。

## 3. 进一步的结构性观察

### 3.1 数据模型缺陷的 4 个具体面（Codex 第二轮补充）

1. **Projection key 过粗**：`getOrCreateProjection` 用 `skill:${sessionId}:${skillId}`（`skill-task-tracker.ts:193-223`）。同 session+skill 的所有 primitive 与 typed_action 共用一条 projection，互相覆盖。
2. **Active row 复用**：`findTaskRunForEvent`（:451-467）和 `findTaskRunForLifecycleEvent`（:470-493）都按 `sessionId+skillId+!childRun` 复用 active row，没有 `runKind/action` 区分。
3. **skillId 冒充 taskId**：`rememberSkillRun` 写 `taskId: params.skillId`（`skills-tools.ts:992-994`）；`session-continuity.ts:378-394` 把 `resumePayload.taskId/task_id` 当 identity token——**skill 名字在身份匹配里冒充任务句柄**。
4. **空壳 resumePayload 在 supervisor 评分里加 30 分**：`scoreLatestSnapshot`（`skill-task-supervisor.ts:381-396`）调 `snapshotHasDurableHandle`，后者把任意非 null `resumePayload` 都算 durable（:371-379）；空壳 row 因此更容易胜出为 latest snapshot。

### 3.2 已退役但仍未物理删除的代码

| 件 | file:line | 状态 |
|---|---|---|
| `hasActiveSkillExecution()` 永远返 false 的 shim | `skill-context-orchestrator.ts:262-267` | §6.7 已退役，注释说"will be removed in PR1 main body" |
| `skill.workflow.json` 解析（compiler 默认探测） | `skill-compiler.ts:423-428` | runtime 已退役 workflow-start（`runtime-manager.ts:784-788`），仅 compiler 默认探测残留，dead-but-harmless |
| `resolveActiveSkillContextLive: resolveActiveSkillContext` 命名 | `turn-engine.ts:1625-1627` | 命名让人误以为 host-injectable，实际是普通 resolver |
| `(host as unknown as {...}).resolveRecentSkillTaskRun` 类型穿越 | `turn-engine.ts:1604-1606` | host 接口未补齐此方法的 type cast |
| Phase 7 双词汇表（internal `background_running` ↔ public `running+liveness='background'`） | `skill-task-supervisor.ts:317-344, 75-104` | 双 mapper + 大开关 normalizeSkillStatus 收口；可考虑并 union |

### 3.3 测试覆盖盲区

`task-operation-intent.test.ts:14, 25` 与 `skill-turn-identity.test.ts:160-185` 覆盖了 restart 意图的识别与 identity 输出；`task-projection-reconciler.test.ts:170-182` 覆盖了 30 分钟后 stale_paused 的修正。**但下面 4 条精确合同没有任何测试**：

1. `restart 意图 + 旧 supervisor 仍在 → frame.liveness 不应继承 stale 状态`
2. `reference/advisory skill 的 primitive blocked 调用 → 不应写 SkillTaskRun / continuity`
3. `重启后 projection 缺 outputDir 且缺 runStatePath → renderer 不应展示可继续`
4. `buildContinuationIntent 拒绝构造空壳 intent`

`turn-engine-route.test.ts:2652-2755` 用 humanizer-zh 做 fixture 但只锁定"被识别为 skill_start / 不进 resume"这条意图侧合同，反而**间接固定了"lifecycle 写入是当前期望"**——未来收紧合同时要小心一并改这些 fixture 的方向，避免它们继续证明错误行为。

## 4. 修复优先序（仅指路，不是计划本体）

> P0a/P0b/P0c **互不覆盖**，缺任一条都会留尾巴；按下面顺序合并是最小相容路径。

### P0a — 入口侧 fence（reference/advisory skill 不再写 lifecycle/continuity）

- 在 `recordPrimitiveOutcome`（`skills-tools.ts:957-1000`）入口读 manifest，若 `runtime==='reference' || executionMode==='advisory'`：
  - 不写 SkillTaskRun（不调 `recordSkillTaskEvent` 的 DB 持久化分支，仍可走 in-memory projection 用于本轮可见性）
  - 不调 `rememberSkillRun`（不写 session-continuity）
  - 仅写 metric/log
- 给 `shouldRememberPrimitiveOutcomeForContinuity`（:807-821）加 `isReferenceSkill` 入参做 belt-and-braces

### P0b — 数据模型 invariant（同一 row 不可被两个 writer 改写到自相矛盾）

- `skill_task_runs` 加 CHECK：`runKind='primitive' AND toolName='skill_lifecycle'` 互斥；或 lifecycle event 必须 create 自己的 row（不允许复用 primitive row）
- `findTaskRunForEvent` / `findTaskRunForLifecycleEvent` 的 active 匹配增加 `runKind` / `action` 字段判别
- `getOrCreateProjection` 的 key 至少加上 `runKind` 维度（primitive vs typed_action vs lifecycle）
- `rememberSkillRun` 的 primitive 路径不再把 `taskId: skillId`——空 taskId 直接 fallback 不参与 continuity 身份匹配
- `scoreLatestSnapshot.snapshotHasDurableHandle` 的"resumePayload 任非 null 即算 durable"改为严格按 outputDir/runStatePath/childRunId/detachedTaskId 判定

### P0c — 合同统一 helper（同一个 canResume 真值贯穿 5 层）

- 引入 `canResume(handle): boolean` 严格定义为 `(childRunId) ∨ (detachedTaskId) ∨ (outputDir ∧ runStatePath 实物存在)`
- `skill-task-lifecycle.hasContinuationHandle`、`loadSkillRunContract` 最低 anchor 门、`buildContinuationIntent`、reconciler 的 `hasDurableHandle`、UI 的 canResume 判断——5 处全部复用同一 helper
- main → renderer 投影显式带 `canResume:boolean`，renderer 不再自行从 `resumableActions/taskRunId` 推断
- CI 红线：grep 不允许 5 处之外的"自定义可继续判定"

### P1 — 重启意图与结构层隔离

- `turn-engine.ts:1690-1702` 拆 `shouldBindForResume` / `shouldBindForRestart`，restart 路径不加载 supervisor snapshot 用作 frame liveness 源
- `skill-turn-identity.ts:696-700` 在 `relation==='new'` 时不再 `rememberActiveSkillContext`
- `turn-engine.ts:1736-1739` 同步加 relation 守门
- `turn-frame-resolver.ts:148-167` 在 `userIntent==='start'` 时强制 liveness 不来自 stale supervisor

### P2 — 反馈环路修正

- Reconciler `silent:true`（`task-projection-reconciler.ts:785`）改为 emit + renderer 端 100ms debounce 接住——保留断 fetch 循环的目的，但不留 30 分钟卡片残留窗口
- 或：renderer cold-start 第 4 段（`ChatPanel.tsx:2437-2489`）在消费 projection 前显式调 `reconcileTaskProjections({silent:false})` 一次

### P3 — 退役历史

- 删除 §3.2 表里 4 件已退役但未删的代码

### 测试合同（CI 红线）

补齐 §3.3 的 4 条精确合同测试。每条新写一个独立 spec，不要拼到现有大文件里覆盖旧 fixture。

## 5. 审查循环过程纪录（可省略阅读）

### 循环 1（Codex 主动审查 → Claude 独立审查 + 补充 15 点）

Codex 给出 9 大 finding（P0：lifecycle handle 太宽 + 后端持久化坏状态；P1×4；P2×3）。Claude 独立审查后补充 15 点，主要新增：
- F-1: reference primitive 进 lifecycle 没 fence（最深底）
- F-2/F-3/F-4: 三处 stale fallback 与 default ['continue','cancel']
- F-7: loadSkillRunContract 幽灵 contract
- F-9: 4 条精确合同测试盲区
- F-10/F-12/F-13/F-14: 历史代码冗余与命名误导
- F-15: 现有 humanizer fixture 反向锁定错误行为

### 循环 2（Codex 修正 + 补充 4 个 ➕ → Claude 核实并提出"数据模型层"统一描述）

Codex 修正 9 处过强表述（C-1/C-4/C-7/D-11/D-12/E-8/F-5/F-8/F-11/F-13/F-15），补充 4 个 ➕（projection key 过粗、active row 复用、skillId 冒充 taskId、空壳 resumePayload 加 durable 分）。

Claude 提出连接观察："**同一行 SQLite row 被 primitive + lifecycle 两个 writer 反复改写到自相矛盾**"作为比"5 层叠加"更精确的根因描述，并建议 P0a/P0b/P0c 三层独立。

### 循环 3（Codex 最终修正 → 收敛）

Codex 确认 data-model framing 成立，并最终修正一处状态字面：`budget_paused/recoverable_paused` lifecycle state 被 `lifecycleRunStatus`（`skill-task-tracker.ts:251-254`）映射成 row.status='blocked'，row 本身不存 budget_paused。`['continue','retry','cancel']` 的来源因此是更早某轮 budget_paused/recoverable_paused 的 lifecycle write 通过 `task-projection-sync.ts:354-355` stale fallback 保留下来。CHECK 缺失证据：`migrations.ts:1443-1485`。

✅ 双方对"问题层级 + 具体内容"无异议，进入文档化。

## 附录 A：本审查涉及的关键文件

- `src/main/modules/agent-control/skill-task-lifecycle.ts:65-74`（lifecycle handle 定义）
- `src/main/modules/agent-control/skill-task-supervisor.ts:361-379, 417-661`（supervisor 与 fence 定义）
- `src/main/modules/agent-control/skill-task-tracker.ts:185-700`（projection 与 row writer）
- `src/main/modules/agent-control/task-projection-reconciler.ts:537-790`（reconciler 与 silent write）
- `src/main/modules/agent-control/task-projection-sync.ts:353-555`（stale fallback）
- `src/main/modules/agent-control/run-projection.ts:65-79`（同型 stale fallback）
- `src/main/modules/agent-control/turn-engine.ts:1451-1804, 3460-3471, 4443-4508`（restart vs resume + checkpoint_budget 收口）
- `src/main/modules/agent-control/turn-frame-resolver.ts:31-288`（chooseContext / inferLiveness / loadContract 入口）
- `src/main/modules/agent-control/skill-turn-identity.ts:207-723`（identity 与 apply）
- `src/main/modules/agent-control/run-contracts.ts:1408-1635`（loadSkillRunContract 与幽灵 contract）
- `src/main/modules/agent-control/runtime.ts:2232-2275`（buildContinuationIntent 无防线）
- `src/main/modules/agent-control/active-skill-context.ts:398-427`（resolveActiveSkillContext 优先级）
- `src/main/modules/agent-control/session-continuity.ts:370-404`（resumePayload.taskId 充当身份 token）
- `src/main/modules/tools/skills-tools.ts:406-419, 807-1000, 1635-1923`（primitive 写入与无 fence）
- `src/main/modules/skills-runtime/skill-compiler.ts:423-428`（dead workflow probe）
- `src/main/modules/skills-runtime/runtime-manager.ts:784-788`（workflow-start 退役注释）
- `src/main/modules/repositories/skill-task-run-repository.ts:265-308`（无 fence 的 create）
- `src/main/modules/repositories/task-projection-repository.ts:120-240`（投影持久化 + silent emit）
- `src/main/modules/migrations.ts:1443-1485`（schema CHECK 缺失证据）
- `src/renderer/components/agent/ChatPanel.tsx:1134-1168, 2437-2489, 2948-3121`（UI 消费 + 继续按钮）
- `src/renderer/modules/agent/taskCardViewModel.ts:137-417`（hasTaskRunResumeIdentity / runtimeState）

## 附录 B：未在本审查范围内的相邻问题（仅备忘）

- Stage 4 W3 之后 `skill-tool-authorization.ts` 与 identity 的"defense-in-depth"双层过滤是否仍有真正的执行路径分歧——需要单独的 admission 路径审计
- Reference skill 的 SKILL.md 内联注入路径（`SkillContextOrchestrator.tryInlineReferenceSkillDoc`）与 read_skill 工具调用路径之间的优先级——本审查未涉及
- Stage M (M0a) `deriveSeedArtifactRoots` 在 stale context 残留路径时的影响范围——仅当 context 自身有 stale 路径时才泄漏，相对边缘

— 完 —
