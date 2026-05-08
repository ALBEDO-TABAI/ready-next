---
stage: Q (Stage 11)
date: 2026-05-07
enforce: false
status: approved (v3 — Codex round 3 returned ready-to-implement 2026-05-07)
predecessor_audit: 2026-05-07-agent-resumability-root-cause-audit.md
predecessor_stage: 2026-05-07-P-stage-10-transitional-bridge-retirement-implementation.md
revision_history:
  - v1 (2026-05-07): initial roadmap draft based on root-cause audit
  - v2 (2026-05-07): incorporated Codex review round 1 — 9 corrections (Q.3 split into code+schema, canResume derive-at-list, Q.5 three-class intent, recordPrimitiveOutcome skillKind injection, migration is forward-fix not reverse, task_projections cleanup, feature flag snapshot pattern, verify:native per land, humanizer fixture rename-not-edit)
  - v3 (2026-05-07): incorporated Codex review round 2 — 3 narrow boundary corrections (Q.3b backfill fallback when action empty/lifecycle/non-primitive-shaped, Q.5 exhaustiveness invariant, Q.3a flag lifecycle bound by Q.3b CHECK)
---

# Stage Q (Stage 11) — Skill Resumability 三层 Fence 路线图

> 本文档是**路线图**（roadmap）：定义阶段划分、依赖、合同框架与 CI 门口子。**不**展开行号级实施细节——那是后续 `*-implementation.md` 的工作。

## 0. 来源
本路线图基于审查报告 `2026-05-07-agent-resumability-root-cause-audit.md` 的 P0a/P0b/P0c/P1/P2/P3 修复优先序与合同建议。审查由 Claude Code + Codex 经 3 轮对等循环收敛。本路线图 v2 在 v1 基础上吸收 Codex 第 1 轮路线图校对的 9 处技术修正。

## 1. 目标

在不破坏 §0.5 六条战略原则的前提下，让以下两个症状从根本上消失：
- **缺口 1**：上一会话的 skill 任务卡在 Electron 重启后仍显示"可继续/重试/取消"，但实际不可恢复。
- **缺口 2**：用户点"继续"后 0 次工具调用就直接 `checkpoint_budget`，预算从未真正消耗。

## 2. 阶段划分（v2）

| Stage | 范围 | 优先级映射 | 风险 | 可独立 merge |
|---|---|---|---|---|
| **Q.1 Helper 单源**（先合同） | 引入两形态 helper：(a) 纯函数 `canResumeShape(handle)` 仅做形状判定 / (b) main-side `canResumeWithFs(handle)` 复合 fs 实物存在校验。**UI 永远不 import helper**，只读 main 算好的字段 | P0c-prelude | 低（纯添加） | ✅ |
| **Q.2 入口 Fence**（堵新增） | reference/advisory skill 的 primitive 不再写 SkillTaskRun / session continuity 任意状态（不仅 blocked）。`recordPrimitiveOutcome` 签名增 `skillKind: { isReferenceOrAdvisory: boolean }`，由 `executeSkillTool` 在 `resolvePrimitiveSkillId` 后 `listSkillsSafely()` 取 `SkillState.executionMode` + action runtime 注入 | P0a | 中 | ✅ |
| **Q.3a 数据模型 invariant（代码侧）** | `findTaskRunForEvent` / `findTaskRunForLifecycleEvent` 的 active 匹配增加 `runKind/action` 区分；`getOrCreateProjection` 的 key 包含 runKind 维度；`active-skill-context.ts` taskId 解析同步更新；`rememberSkillRun` 不再写 `taskId: skillId`；`snapshotHasDurableHandle` / `hasDurableResumeHandle` 改为按真 durable handle 判定 | P0b（代码层） | 中 | ⚠️依赖 Q.2 |
| **Q.3b SQLite 重建 + 存量清洗** | migration 033：CREATE-INSERT-DROP-RENAME 模式给 `skill_task_runs` 加 `CHECK (NOT (run_kind='primitive' AND tool_name='skill_lifecycle'))`；存量违反 row 的 `tool_name` 还原为 `action` 字段值（lifecycle overwrite 时 action 字段已保留原 primitive 名）+ `status='cancelled'` + `failure_kind='stage_q_invariant_cleanup'`。**同时清洗 `task_projections`**：违反 row（status='blocked' 且 continuationRef 缺 outputDir 与 runStatePath）置 `resumableActions=['none']` + `degradation_reason='stage_q_invariant_cleanup'` | P0b（数据层） | 高（schema rebuild + backfill） | ⚠️依赖 Q.3a |
| **Q.4 合同贯穿 5 层** | 5 个 writer/reader 全部消费 Q.1 helper；`listTaskProjections()` 返回值**派生**附加 `canResume:boolean`（**不**新增 DB 列）；renderer 仅读此字段；`buildContinuationIntent` 拒绝构造空壳 intent 并 emit `agent:error{errorKind:'not_resumable',recoverable:false}` | P0c | 中 | ⚠️依赖 Q.1 + Q.3a |
| **Q.5 重启意图三分类** | 用户意图分 `fresh / resume / restart_from_existing` 三类。`fresh` 与 `restart_from_existing` 不允许把 stale supervisor 的 liveness 借给 frame；`restart_from_existing` 允许读显式 handle 作为输入；`resume` 走原路径 | P1 | 中 | ⚠️依赖 Q.4 |
| **Q.6 反馈环路**（Stage O 兼容） | **不**给 reconciler push 添 `reason='reconcile'`（Stage O 合同要求 silent）；改为 `runtime.listTaskProjections()` 的入口在返回前显式调 `reconcileTaskProjections()` 一轮，再返回，让 cold-start fetch 直接看到修正后状态 | P2 | 低 | ✅ |
| **Q.7 历史代码退役** | `hasActiveSkillExecution` shim、`skill.workflow.json` 默认探测、`resolveActiveSkillContextLive` 命名、`(host as unknown as ...)` 类型穿越——4 件全删；`skill.workflow.json` 删除时同步更新 `skill-compiler.ts:417-443` 的 advisory/direct 推断测试 | P3 | 极低 | ✅ |

**总计 8 个子阶段（Q.3 一拆为二），1 个 Stage 编号。**

## 3. 阶段依赖图（v2）

```
Q.1 (helpers)
  ├─→ Q.4 (5 层 consume helper)
  │     └─→ Q.5 (restart 三分类用 canResume 做早退断言)
  └─→ Q.3a (代码侧 invariant 用 helper 判定)
            └─→ Q.3b (schema rebuild + 存量清洗)

Q.2 (entry fence) ─→ Q.3a → Q.3b （先堵新增、后清存量；schema CHECK 必须在代码 fence 落地之后才打开，否则现有写路径直接撞 CHECK 炸）

Q.6, Q.7 互不依赖于 Q.1-Q.5，可并行
```

**最小安全合并顺序**：Q.1 → Q.2 → Q.3a → Q.4 → Q.3b → Q.5 → Q.6 → Q.7

> **关键顺序注**：Q.3b（schema CHECK）**必须晚于** Q.3a（代码 fence），否则旧写路径会被 CHECK 直接拒写炸 main 进程。Codex 第 1 轮校对点 2 修正。

## 4. 每阶段的合同（CI 必须强制）

### Q.1 — `canResume` helper 双形态单源

| 合同 | 强制方式 |
|---|---|
| 仅一个文件导出 `canResumeShape(handle): boolean`（纯函数）和 `canResumeWithFs(handle, fs): boolean`（带 fs 注入） | 新 gate `check-can-resume-single-source.cjs`：grep 验证仅一个文件 export 这两个名字 |
| `canResumeShape` 严格按 `(childRunId) ∨ (detachedTaskId) ∨ (outputDir ∧ runStatePath 字符串非空)` 判定（不读 fs） | 单测 6 真值象限 |
| `canResumeWithFs` 在 `canResumeShape=true` 基础上额外校验 `fs.existsSync(outputDir) && fs.existsSync(runStatePath)`（仅当 outputDir+runStatePath 路径上必要） | 单测：mock fs，4 个边界 |
| renderer 不允许 import 这两个函数 | 新 gate `check-renderer-no-canresume-import.cjs` |

### Q.2 — Reference/advisory primitive 不进 lifecycle/continuity

| 合同 | 强制方式 |
|---|---|
| `recordPrimitiveOutcome` 签名增加必填 `skillKind: { isReferenceOrAdvisory: boolean }` | typecheck |
| `skillKind.isReferenceOrAdvisory === true` 时跳过 `recordSkillTaskEvent` 的 SQLite 持久化分支 + 跳过 `rememberSkillRun`，仅保留 in-memory projection（用于本轮 UI 可见性）+ metric/log | 行为测试 `reference-primitive-no-lifecycle.test.ts`：注入 reference manifest 调 `skill_write_artifact`，断言 `SkillTaskRunRepository.create` 调用 0 次 + `rememberSkillRun` 调用 0 次 |
| `skillKind.isReferenceOrAdvisory` 在 `executeSkillTool` 入口由 `listSkillsSafely()` 读 `SkillState.executionMode === 'advisory'` 或 action.runtime === 'reference'` 计算 | 单测 |
| 现有非 reference skill 的 primitive 行为不变（既有 `skill-primitive-continuity.test.ts` 全绿，**不许动 fixture**） | 现有测试 |
| Feature flag `READY_REFERENCE_PRIMITIVE_LIFECYCLE_FENCE`（默认 `'1'`）按 `turn-feature-flags.ts:11-18` 模式 snapshot 一次（不在 hot path 反复读 `process.env`） | 新单测 |

### Q.3a — 代码侧 invariant

| 合同 | 强制方式 |
|---|---|
| `findTaskRunForEvent` / `findTaskRunForLifecycleEvent` 的 active 匹配按 `(sessionId, skillId, runKind)` 而非 `(sessionId, skillId)`；当 event.runKind 与 active row.runKind 不匹配时不复用 | 行为测试：构造 primitive row + lifecycle event 同 sessionId+skillId 不同 runKind，断言 lifecycle 不复用 primitive row |
| `findTaskRunForLifecycleEvent` 不允许在没有 exact taskRunId/detachedTaskId 时跨 runKind fallback；保留 exact 路径，去掉 active fallback 跨 runKind 部分 | 同上测试 + 单测 |
| `getOrCreateProjection` 的 key 由 `skill:${session}:${skill}` 改为 `skill:${session}:${skill}:${runKind}`，且 `active-skill-context.ts:136-137` 的 taskId 解析正则同步更新 | 单测：同 sessionId+skillId 但不同 runKind 触发，断言 2 条 projection 且 taskId 解析回往返一致 |
| `rememberSkillRun` 中 primitive 路径不再设置 `resumePayload.taskId = skillId`；空 taskId 直接 fallback 不参与 `session-continuity.ts:378-394` 的身份匹配 | 单测 |
| `snapshotHasDurableHandle`（supervisor.ts:371-379）+ `hasDurableResumeHandle`（:592-599）改为复用 `canResumeShape`，不再把任意非 null `resumePayload` 算 durable | 新 gate `check-supervisor-uses-canresume.cjs`：grep 这两个函数体必须 import canResume，且不存在自定义"durable"判定 |
| `scoreLatestSnapshot` 的 +30 加分基于新的 `snapshotHasDurableHandle`，自动连带修正 | 间接验证 |

### Q.3b — SQLite schema 重建 + 存量清洗

| 合同 | 强制方式 |
|---|---|
| Migration 033 名 `033_skill_task_runs_invariant_check`，CREATE-INSERT-DROP-RENAME 模式 | migration code review |
| 新表 DDL 含 `CHECK (NOT (run_kind='primitive' AND tool_name='skill_lifecycle'))` | DDL 验证 + 行为测试：尝试插入违反 row 抛 SQLITE_CONSTRAINT |
| 存量违反 row 的迁移逻辑：**主路径** `tool_name = action`（因为 lifecycle overwrite 保留了原 action='skill_write_artifact'）；**fallback** 当 `action` 满足以下任一条件时，`tool_name='skill_unknown_primitive_cleanup'`：(i) `action IS NULL OR trim(action)=''`；(ii) `action='skill_lifecycle'`（说明 action 也已被覆盖）；(iii) `action NOT LIKE 'skill\_%' ESCAPE '\'`（不像 primitive 工具名形态）。所有违反 row 一律 `status='cancelled'` + `failure_kind='stage_q_invariant_cleanup'` | 单测：构造 4 类 fixture（正常 action、空 action、action='skill_lifecycle'、action 形态异常），跑 migration，断言后所有 row 满足 CHECK 且不被 listActiveBySession/findLatestRecoverable scan 到 |
| **同时清洗 `task_projections`**：`status='blocked' AND (continuation_ref->>'$.outputDir' IS NULL AND continuation_ref->>'$.runStatePath' IS NULL)` 的行 → `resumable_actions='[\"none\"]'` + `degradation_reason='stage_q_invariant_cleanup'`（已存在该列） | migration SQL + 单测 |
| Migration 是 **forward-fix** 而非 reverse migration（migration 框架仅有 `up`，见 `migrations.ts:20-23`）；rollback 路径 = 写一条新的 forward migration 移除 CHECK | 注释明示 |
| Schema 变更必须通过 `npm run verify:native`（每个 land，不只是最终验收）| land 流程要求 |
| Feature flag `READY_SKILL_TASK_RUN_INVARIANT_ENFORCED`（默认 `'1'`）控 active-row 匹配是否按 runKind 区分（紧急情况下退回旧匹配） | snapshot 模式同 Q.2 |

### Q.4 — 合同贯穿 5 层（不动 DB schema）

| 合同 | 强制方式 |
|---|---|
| `skill-task-lifecycle.hasContinuationHandle` / `loadSkillRunContract` minimum-anchor / `task-projection-reconciler.hasDurableHandle` / `buildContinuationIntent` 4 处全部 import 并复用 `canResumeShape` 或 `canResumeWithFs`（按是否需要 fs 实物校验区分） | 新 gate `check-can-resume-callers.cjs` |
| `runtime.listTaskProjections()` 返回值**派生**附加 `canResume:boolean`（在内存中算，不写 DB），由 `canResumeWithFs(continuationRef, fs)` 计算 | 行为测试 |
| Renderer 仅读 `projection.canResume` 决定继续按钮可见性；fallback 是 `?? false`（断了即不可继续，防御性默认） | 新 gate `check-renderer-canresume-only.cjs`：grep renderer 不允许从 `taskRunId` / `resumableActions.includes('continue')` / `interactionState==='suspended'` 单独推断按钮可见性；必须 `canResume && resumableActions.includes('continue')` |
| `canResume` 加入 Stage O `check-task-card-projection-only.cjs` 的 blacklist 字段，跟 `resumableActions / taskContinuation` 同级 | 修改现有 gate（**注意**：这是修改 Stage O 的 gate，不破坏其语义而是扩展） |
| `runtime.resumeRun` 在调 `buildContinuationIntent` 后再用 `canResumeWithFs` 校验，false 则 emit `agent:error{errorKind:'not_resumable',recoverable:false}` 且不调 `sendScoped` | 行为测试 `continuation-intent-rejects-shell.test.ts` |

### Q.5 — 重启意图三分类

| 合同 | 强制方式 |
|---|---|
| 在 intent classification 层引入三类：`fresh / resume / restart_from_existing`。判定（机器化、互斥且穷尽）：<br>**fresh** = `userIntent==='start' && !explicitRunStateResource && !providedContinuationState && !canResumeShape(continuationRef)`（**注**：包含 `relation==='new'` 与 `relation!=='new'` 两种子情形——后者意味着 identity 给出了 resume relation 但实际无任何 handle，这种情况按 fresh 处理而不是真空回到旧 path）<br>**restart_from_existing** = `userIntent==='start' && (explicitRunStateResource ‖ providedContinuationState ‖ canResumeShape(continuationRef))`<br>**resume** = `userIntent !== 'start'`（覆盖 'continue' / 'repair_config' / 'inspect' / 'unknown' 等）<br><br>**穷尽性 invariant**：三类并集 = 所有进入 turn-engine 的请求；交集 = 空（`userIntent==='start'` 一定落入 fresh ‖ restart_from_existing；其他一定落入 resume）。新 gate `check-restart-intent-exhaustiveness.cjs` grep 验证三类判定都在同一 helper 中导出，且无第四个 user-intent-start 分支 | 单测 + 行为测试 + 新 gate |
| `fresh` 与 `restart_from_existing` 都不把 stale supervisor 的 liveness/runContract 借给 frame：`shouldBindForRestart` 仅加载 explicit handle，不调 `inspectLatestSkillTaskForHost`；`turn-frame-resolver.inferLiveness` 在这两类下强制 ignore supervisor | 行为测试 `restart-frame-no-stale-liveness.test.ts`：fixture（restart 意图 + 旧 blocked supervisor）→ 断言 `frame.liveness !== 'blocked'` 且 `!== 'recoverable_paused'` |
| `relation==='new'` 时不调 `rememberActiveSkillContext`（identity.apply 与 turn-engine 两处） | 单测 |

### Q.6 — 反馈环路（Stage O 兼容）

| 合同 | 强制方式 |
|---|---|
| **不**修改 reconciler 的 silent-write 语义（保留 Stage O §0.2 合同） | 不动 reconciler.ts |
| `runtime.listTaskProjections()` 入口在返回前显式调 `reconcileTaskProjections()` 一轮（已经存在的同步调用，本 stage 验证存在 + 加测试） | 行为测试 `cold-start-canresume-projection.test.ts`：投递 stale projection → cold-start fetch → 断言 renderer 看到 reconcile 后状态（`resumableActions==['none']` + `canResume===false`） |

### Q.7 — 历史代码退役

| 合同 | 强制方式 |
|---|---|
| `hasActiveSkillExecution()` shim 删除（`skill-context-orchestrator.ts:262-267`） | grep 不可见 |
| `skill.workflow.json` compiler 默认探测删除（`skill-compiler.ts:423-428`），同时更新 advisory/direct 推断测试（`skill-compiler.ts:417-443`） | grep + 单测 |
| `resolveActiveSkillContextLive` 命名改为直接传函数引用 | grep |
| `(host as unknown as {...}).resolveRecentSkillTaskRun` 类型穿越改为 host 接口正式声明 | typecheck |

## 5. CI verify 链增量

```
verify:q  = verify:p
          + check-can-resume-single-source.cjs        (Q.1)
          + check-renderer-no-canresume-import.cjs    (Q.1)
          + check-supervisor-uses-canresume.cjs       (Q.3a)
          + check-can-resume-callers.cjs              (Q.4)
          + check-renderer-canresume-only.cjs         (Q.4)
          + check-restart-intent-exhaustiveness.cjs   (Q.5，v3 新增)
          + 修改 check-task-card-projection-only.cjs  (Q.4，加 canResume blacklist)
          + test:q:gates       (新建)
          + test:q:focus       (新建)

verify     起步链切到 verify:q   (在最后一个 sub-stage 着陆时一次性切换)
verify:cloud 同上
```

> 顶层 `verify` 与 `verify:cloud` 在 Q.7 着陆前不切换，避免半途 verify chain 不一致。

## 6. 测试合同（CI 红线）

5 个新独立 test 文件（不修改既有 fixture）：

| 测试文件 | 覆盖 stage | 关键合同 |
|---|---|---|
| `can-resume-helper.test.ts` | Q.1 | 6 真值象限 + fs 边界 |
| `reference-primitive-no-lifecycle.test.ts` | Q.2 | reference manifest primitive 不写 SkillTaskRun / continuity |
| `restart-frame-no-stale-liveness.test.ts` | Q.5 | restart 意图 + 旧 blocked supervisor → frame.liveness !== 'blocked' |
| `cold-start-canresume-projection.test.ts` | Q.4 + Q.6 | 重启后无 outputDir/runStatePath 的 projection → renderer 看到 canResume===false |
| `continuation-intent-rejects-shell.test.ts` | Q.4 | `runtime.resumeRun` 收到空壳 intent 时拒绝并 emit not_resumable |

**关于 humanizer fixture**：`turn-engine-route.test.ts:2652-2755` 选择 **(b) 重命名后并行**：
- 现有文件**重命名**为 `humanizer-zh-identity-authorization.test.ts`（保留它原本的合同：restart 被识别为 skill_start + 不调 child resume），**作为 identity / authorization 层的合同**继续运行
- 新增 `restart-frame-no-stale-liveness.test.ts` 锁 frame.liveness 这条新合同
- **禁止**通过微调旧 fixture 的 expected metrics 让它"假装覆盖新合同"

## 7. Migration / Rollback / Feature Flag

### 7.1 Migration 风险逐项

| Stage | 主要风险 | 回滚路径（forward-fix only） |
|---|---|---|
| Q.1 | 极低；纯新增 helper | revert PR |
| Q.2 | 中：可能影响合法的非 reference skill primitive 写 continuity | feature flag `READY_REFERENCE_PRIMITIVE_LIFECYCLE_FENCE` 关闭即退化 |
| Q.3a | 中：active 匹配按 runKind 区分；可能导致同时挂多条 active row | feature flag `READY_SKILL_TASK_RUN_INVARIANT_ENFORCED` 关闭退回旧匹配。**生命周期边界**：仅在 Q.3b CHECK 落地**之前**有效；Q.3b 落地后该 flag = `'0'` 会让旧的跨 runKind 匹配复活，再次撞 CHECK，因此 Q.3b PR 的同 commit 内必须做两件事之一：(a) 把 flag 默认改为 `'1'` 且文档明示"Q.3b 之后不再允许关闭"；或 (b) 先写一条 forward-fix migration 移除 CHECK，再降级该 flag。运行时若检测到 `flag==='0' && CHECK 已 enforced` 抛 hard fail，避免静默撞表 |
| Q.3b | 高：DB schema rebuild + backfill | (1) Migration backfill 是 `tool_name = action` 还原 + status='cancelled' + failure_kind 标记，可逆推理；(2) **forward-fix migration**：写新 migration 移除 CHECK 即可恢复旧 schema；(3) 万一线上数据回滚，旧版本读新表（含 CHECK）不受影响，因为新表与旧表 column 集相同 |
| Q.4 | 中：5 处改动 + 新派生字段 | renderer fallback `canResume ?? false` |
| Q.5 | 中：改 turn-engine 入口；可能误伤"用户用同一 skill 启新任务" | 行为测试覆盖 4 种 fixture（fresh / resume / restart_from_existing / explicit-mention），失败一个就回滚 |
| Q.6 | 低 | 改回不调 reconcile，cold-start 退化 |
| Q.7 | 极低 | revert |

### 7.2 Feature flag 模式

所有 Q 阶段 feature flag 必须按 `turn-feature-flags.ts:11-18` 模式 snapshot 一次（在 turn 入口或 boot 入口），**不允许**在 hot path 反复读 `process.env`。新增两个 flag：

- `READY_REFERENCE_PRIMITIVE_LIFECYCLE_FENCE` — 默认 `'1'`，控 Q.2 fence
- `READY_SKILL_TASK_RUN_INVARIANT_ENFORCED` — 默认 `'1'`，控 Q.3a active 匹配是否按 runKind 区分

### 7.3 Migration 与 verify:native

Q.3b 是 SQLite-backed 变更。本 stage 在每个 sub-stage land 前必须跑 `npm run verify:native`，不只是最终验收。Q.3b PR 本身也必须列出 native check 的 evidence。

## 8. Out-of-scope（明确不在本 stage）

- §6.21 Stage N 的 child-loop 边界（已稳定）
- §6.22 Stage O 的 task projection 单源（已稳定，本 stage 在其上扩 canResume 字段并扩 gate blacklist，不动其架构）
- §6.23 Stage P 的 authorization 三层分离（已稳定）
- Phase 7 双词汇表（`skill-task-supervisor.ts:623-632` 附近）— dead-but-harmless，留待后续 Stage R
- manifest `runtime` / `executionMode` union 统一（`skill-compiler.ts:438-444` + 类型层）— 横向清理，留待后续 Stage S
- Stage M `deriveSeedArtifactRoots` 在 stale context 残留路径时的边缘行为 — Q.5 解决了 stale context 来源就连带消除

## 9. 验收信号

整个 Stage Q 完成的判据：
1. 按 §1 的两个症状构造的 e2e fixture 全绿（5 个新测试文件）
2. `verify:q` 全绿
3. `npm run typecheck` 无错
4. `npm run verify:native` 通过（Q.3b 的强制项）
5. 用户在本机 dev 环境能复现"完整跑一次 humanizer-zh + 重启 + 卡片消失" 与"探索新任务正常运行"两条路径
6. CLAUDE.md §6 增 §6.24 章节固化 Stage Q 合同

## 10. 后续 stage 占位（仅供参考）

- Stage R（Stage 12）— Phase 7 双词汇表清理
- Stage S（Stage 13）— skill manifest runtime/executionMode union 统一

## 11. v3 修正日志（vs v2）

| 校对点 | 修正内容 |
|---|---|
| Q.3b backfill fallback（Codex round 2 校对点 2） | 加入 4 类 fixture 的 fallback 规则：`action` 空 / `action='skill_lifecycle'` / `action` 形态异常时 → `tool_name='skill_unknown_primitive_cleanup'`；测试覆盖 4 类 |
| Q.5 三分类穷尽性（Codex round 2 校对点 3） | `fresh` 定义放宽为不要求 `relation==='new'`，覆盖"identity 给 resume 但实际无 handle"的真空；`resume` 改为 `userIntent !== 'start'` 全覆盖；新 gate `check-restart-intent-exhaustiveness.cjs` |
| Q.3a flag 生命周期边界（Codex round 2 校对点 6） | 明示 `READY_SKILL_TASK_RUN_INVARIANT_ENFORCED` 仅在 Q.3b CHECK 落地之前可关闭；Q.3b 落地后关闭会撞 CHECK，运行时硬失败提示需先 forward-fix migration 移除 CHECK |

## 12. v2 修正日志（vs v1）

| 校对点 | 修正内容 |
|---|---|
| Q.1 helper 形态 | 拆为 `canResumeShape`（纯）+ `canResumeWithFs`（fs 注入）。renderer 不允许 import |
| Q.2 fence 入口 | `recordPrimitiveOutcome` 加 `skillKind` 参数；caller 在 `executeSkillTool` 计算；fence 不只挡 continuity，还挡 `recordSkillTaskEvent` SQLite 持久化 |
| Q.3 拆分 | Q.3a（代码侧 invariant）+ Q.3b（schema rebuild + 存量清洗），独立 land |
| Q.3b migration 模式 | CREATE-INSERT-DROP-RENAME；存量违反 row `tool_name` 还原为 `action`，不需要新增 column |
| Q.3b 同步清洗 task_projections | 用 `degradation_reason='stage_q_invariant_cleanup'`（已存在的列） |
| Q.4 canResume 持久化 vs 派生 | **派生**于 `runtime.listTaskProjections()` 返回前，不新增 DB 列 |
| Q.4 renderer 合同 | `canResume && resumableActions.includes('continue')` 双重门；扩 Stage O blacklist |
| Q.5 stale 机器化 | 三类 intent：fresh / resume / restart_from_existing，精确 boolean 表达式 |
| Q.6 实施方式 | 不动 reconciler silent；改在 `runtime.listTaskProjections()` 入口先 reconcile 后返回 |
| Migration 框架术语 | "forward-fix migration"，不用 "reverse migration"（框架无 down step） |
| Feature flag 模式 | snapshot 一次（同 `turn-feature-flags.ts:11-18`），不在 hot path 读 env |
| Verify:native | Q.3b 的强制项，每次 land 都跑，不只是最终验收 |
| 测试 fixture | humanizer 现有 fixture **重命名为 identity/authorization-only 测试** 并保留；新增 frame.liveness 测试在并行文件 |

— 完 —
