---
stage: Q (Stage 11)
date: 2026-05-07
enforce: true
status: approved (v4 — Codex round 4 returned ready-to-implement 2026-05-07)
predecessor: 2026-05-07-P-stage-10-transitional-bridge-retirement-implementation.md
roadmap: archive/2026-05-07-Q-skill-resumability-triple-fence-roadmap.md
audit: archive/2026-05-07-agent-resumability-root-cause-audit.md
revision_history:
  - v1 (2026-05-07): initial implementation draft based on roadmap v3
  - v2 (2026-05-07): incorporated Codex review round 1 — fixed migration column names, Q.2 caller coverage + flag threading, TaskPanel+getTaskProjection canResume surface, runKind key migration / supersede, full hasActiveSkillExecution retirement scope, verify:q runner partition (cjs gates vs tsx focus), exact hard-fail insertion point, action-specific reference check (mixed skills like lets-go-rss), stat-style fs probe, PR consolidation (8→6)
  - v3 (2026-05-07): incorporated Codex review round 2 — fixed file paths (claude-bridge/ipc-handler.ts, renderer/types/electron.d.ts, claude-bridge/direct-chat.ts), reframed Q.2 as "selected-skill primitive fence" (mixed-skill behavior acknowledged), corrected Q.3a test-fixture impact (lifecycle still merges into typed_action row, only primitive separates), aligned verify:q with Stage P pattern (.test.cjs gates / .test.ts focus via npx tsx@^4.19.2), DirectChat removal removed (no hasActiveSkillExecution field there), retirement scope corrected (3 prod files + 8 test files; 43 total refs not 44), PR-6 split into PR-6 (Q.5) + PR-7 (Q.7 + verify:q switch + §6.24)
  - v4 (2026-05-07): incorporated Codex review round 3 — 4 text-consistency corrections (purge "current action 上下文" wording in §3.2/C3/§6.24, explicitly state typed+lifecycle stays same-row in §3.3.2, remove C15 contradiction with §5, align §3.3.1/§3.6 with §7 PR split, status field updated)
---

# Stage Q (Stage 11) — Skill Resumability 三层 Fence · 实施计划

## 0. 背景

`2026-05-07-agent-resumability-root-cause-audit.md` 找到三层独立根因（入口 fence 缺失 / 数据模型 invariant 缺失 / 5 层"可继续"合同不一致）；`2026-05-07-Q-...-roadmap.md` v3 给出依赖图与合同框架。本文件 v2 落实到行号、签名、SQL、测试 scaffold、CI gate 脚本，并修正 v1 在迁移列名、caller 覆盖面、UI 表面、退役范围等方面的 7 项错误。

## 1. 已确认的现实（Codex round 1 实测核对）

### 1.1 入口侧（Q.2）

- `src/main/modules/tools/skills-tools.ts:933-1003` `recordPrimitiveOutcome` 当前签名只有 `skillId/skillName/toolName/...`，无 manifest 信息。
- `src/main/modules/tools/skills-tools.ts:1108` `executeSkillTool` 入口；`:1131-1133` `listSkillsSafely` 已存在；`:1147-1149` 是 primitive `skillId/skillName` 解析点。
- `recordPrimitiveOutcome` 共 18 个 caller（`rg "recordPrimitiveOutcome\("` 实测），全部在 `skills-tools.ts` 内：行 1151, 1178, 1193, 1349, 1385, 1401, 1561, 1604, 1619, 1636, 1660, 1674, 1690, 1737, 1751, 1767, 1791, 1805。
- primitive 的 `skillId` 由 `resolvePrimitiveSkillId`（`:406-419`）从 `runtimeContext.authorization` 计算。
- `shouldRememberPrimitiveOutcomeForContinuity`（`:807-821`）当前只挡 continuity，不挡 `recordSkillTaskEvent`。
- `SkillToolRuntimeContext` 类型在 `skills-tools.ts:77-105` 定义；当前**没有** `turnFeatureFlags` 字段。`tool-executor.ts:299-311` 在调 `executeSkillTool` 时也不传 turnFeatureFlags。Q.2 必须把 flag 通道加进 SkillToolRuntimeContext 并由 tool-executor 注入。
- `SkillDefinition` **没有顶层 `runtime` 字段**；action runtime 在 `skill-execution-types.ts:26-36`，execution mode 在 `:141-155`。
- **混合 skill 设计选择（v3 修正）**：`lets-go-rss` 的 manifest（`assets/embedded-skills/lets-go-rss/ready-skill.json:12-76`）有 reference `read_skill` action 和 python typed_action 并存。**`recordPrimitiveOutcome` 只在 primitive 路径触达**（`rg "recordPrimitiveOutcome\(" src/main/modules/tools/skills-tools.ts` 实测仅 18 个调用，全部在 primitive 分支内）；非 primitive 路径在 `skills-tools.ts:1826, :1892` 调的是 `recordSkillTaskEvent`。`SkillToolAuthorization` 给 selected skill 开**全量 primitives 列表**（`skill-tool-authorization.ts:175-179`），不携带"当前 action"信息——所以 `recordPrimitiveOutcome` 拿不到当前 action 上下文。**v3 决定**：Q.2 是 **"selected-skill primitive fence"**，按整个 skill 判定（`isAdvisorySkill || hasReferenceAction`）。混合 skill 在实践里安全：python typed_action 不走 primitive 路径；reference action 触达 primitive 时 fence 命中是合规的；lets-go-rss 的 python actions 通过 typed_action 路径写 SkillTaskRun 不受 fence 影响。
- humanizer-zh 是**用户级 custom skill**，不在仓内 `assets/embedded-skills/`；本计划不依赖具体仓内路径，只依赖 manifest 字段语义。

### 1.2 数据模型侧（Q.3a / Q.3b）

- `skill-task-tracker.ts:451-467 findTaskRunForEvent`、`:470-493 findTaskRunForLifecycleEvent` 按 `(sessionId, skillId, !childRun)` 复用 active row，**没有** `runKind/action` 区分。
- `findTaskRunForEvent` / `findTaskRunForLifecycleEvent` **现有 caller**（`rg "findTaskRunForEvent\(|findTaskRunForLifecycleEvent\("` 实测）：4 处。
- **现有测试依赖跨 runKind 行为**（v3 修正：分类更精确）：
  - `src/__tests__/skill-task-tracker.test.ts:434-467` 是 **typed_action 后接 primitive，最后同 row 两步**——Q.3a 把 primitive 拆出去后这步会断（primitive 创建独立 row，不再 append 到 typed parent）。**测试需修改**：拆为"primitive 落 runKind='primitive' 独立 row + typed parent 仍保留"
  - `:544-598` 是 **typed_action + lifecycle + primitive 三步同 row**——Q.3a 后：typed_action + lifecycle 仍可同 row（**lifecycle 进 typed parent row 不破坏 invariant**，因为 row.runKind 仍是 'typed_action'，CHECK 不撞）；只有 primitive 步骤独立成新 row。**测试需修改**：保留 typed+lifecycle 同 row 断言，拆出 primitive 在另一 row 的断言
  - 这两段测试是**当前行为锁**，Q.3a 实施时必须**精细修改**而非整体重写
- `skill-task-tracker.ts:659-690 recordSkillParentTaskLifecycleEvent` 内 `updateRowSync` 保留 `current.runKind`、覆盖 `toolName='skill_lifecycle'`、`status: lifecycleRunStatus(state)`、`action: event.action ‖ current.action`。
- `:193-223` `getOrCreateProjection` key = `skill:${sKey}:${skKey}`。
- `:982-994` `rememberSkillRun`（**实际位置**：`skills-tools.ts:982-994`，不是 tracker）primitive 路径 `resumePayload.taskId = params.skillId`。
- `session-continuity.ts:370-394` 把 `resumePayload.taskId / task_id` 当 identity token；`:523-556` `rememberSkillRun` 内自身允许无 taskId（按 resume priority）。**所以 Q.3a 改 `taskId: null` 时不能 skip 整个 record，否则失去 skill-history fallback；改为传 fallback 字符串而不是 null**。
- `task-projection-repository.ts:373-384` supersede 排除已存在的 `skill:<scope>:<skill>` rows——Q.3a 改 key 后会留下旧 row（key 不含 runKind）。**必须显式 migration 处理**。
- `skill-task-supervisor.ts:361-369 isOrphanedChildLoopLauncher` fence 只挡 `runKind:'typed_action'+child-loop`。
- `skill-task-supervisor.ts:371-379 snapshotHasDurableHandle`、`:592-599` 内联同形态判定 — 任意非 null `resumePayload` 算 durable。
- `migrations.ts:20-23` 框架仅有 `up`，无 `down`；migration runner 每个 migration 包在 transaction（`:1526-1541`）。
- `migrations.ts:1186-1221` migration 023 是 `task_projections` 当前 DDL；**实测列名**：`resumable_actions_json`（`:1208`）、`continuation_ref_json`（`:1209`）、`degradation_reason`（migration 024 `:1232`）。
- `migrations.ts:1440-1486` migration 031 是 `skill_task_runs` 当前 DDL，无 CHECK。
- `migrations.ts:1486-1499` 现有 migration 数组结尾在 032（`:1490`）。本 stage 新增 033。**migration 框架现有所有 schema 修改用 `ALTER TABLE`，无 CREATE-INSERT-DROP-RENAME 先例**——本 stage 是首例，PR 描述需明示。
- `active-skill-context.ts:136` taskId 解析正则 `/^skill:(?!detached:|run_state:|output:)[^:]+:(.+)$/`。
- `scripts/check-better-sqlite3-electron-abi.cjs:18-25` `verify:native` 实际**只验证 better-sqlite3 ABI 兼容**，开 `:memory:` SQLite。**不**对真实 `ready.db` 跑 migrations。所以 Q.3b 的 migration 测试不能依赖 `verify:native`，必须自己在 `:memory:` 跑 migrations 001-033 + 注入 fixture 行 + 断言。
- `skill-task-run-repository.ts:154-156, :592-595` 已假设 SQLite JSON1 可用。

### 1.3 合同侧（Q.4）

- 5 处可继续判定：
  - `skill-task-lifecycle.ts:65-74 hasContinuationHandle`
  - `run-contracts.ts:1408-1427 loadSkillRunContract` minimum-anchor
  - `task-projection-reconciler.ts:537-539 hasDurableHandle`（**唯一严格的**）
  - `runtime.ts:2232-2275 buildContinuationIntent`（仅校 taskId）
  - 渲染端 `ChatPanel.tsx:1134-1168` + `taskCardViewModel.ts:410-417` + **`TaskPanel.tsx:327-352`（continue 动作派生） + `:633-640`（按钮渲染）**——Codex 修正：v1 漏 TaskPanel
- `runtime.ts:619-635 listTaskProjections` 已经在返回前调 `reconcileTaskProjections`。
- `runtime.ts:637-640 getTaskProjection` 直接返回 store raw data，**不**调 reconcile，**不**派生 canResume。
- IPC handler **`src/main/modules/claude-bridge/ipc-handler.ts:534-550`**（v3 修正路径）同时暴露 `listTaskProjections` 与 `getTaskProjection`，Q.4 必须给后者也加 canResume 派生。
- Push event `agent:taskProjectionsChanged` payload 仅含 ids/scope（`run-contracts.ts:348-360`），不含 record——renderer 收到 push 后会 refetch list，所以 list 路径加派生足以覆盖；但 cold-start 第一次直读 `getTaskProjection` 仍漏。

### 1.4 重启意图侧（Q.5）

- `turn-engine.ts:1451-1452` restart/resume 判定。
- `:1521-1528 explicitFreshSkillStart` 要求 URL signal。
- `:1690-1702 shouldBindSkillContextForTurn` 把 restart 也纳入。
- `:1726-1734 resolveActiveSkillContext`、`:1751-1761 inspectLatestSkillTaskForHost` 加载 stale supervisor。
- `:1736-1739` 二次 `rememberActiveSkillContext`。
- `skill-turn-identity.ts:696-700 skill_history apply` 不分 relation 重记 active context。
- `turn-frame-resolver.ts:116-145 chooseContext`、`:148-167 inferLiveness`、`:192-199 inferMode`。
- `inferLiveness` 现有 caller（`rg "inferLiveness\("` 实测）：**2 处**——定义 `:148` + 单调用 `:265`。Q.5 改签名只需更新这一处。
- `TurnUserIntent` 类型在 `turn-frame.ts:22-28`，包含 `'cancel'` 值。**v1 漏定义**——Q.5 RestartIntentInputs 必须用 `TurnUserIntent` 完整 union 或显式处理 `'cancel'`。
- `humanizer-zh-route` testcase（`turn-engine-route.test.ts:2652-2755`）依赖文件顶层 utils：`:1-24` import、`:77-107` setup、`:233`、`:343` 等。**v1 漏依赖**——重命名时必须把这些共享 utils 也搬或在新文件里 re-import。

### 1.5 历史代码（Q.7）— v3 修正实测范围

- `hasActiveSkillExecution(` 实际 caller（`rg "hasActiveSkillExecution\("` 实测）：**3 行**——但只有 **1 个真正的生产 caller**：
  - 生产 caller：`turn-engine.ts:1457`（`skillContextOrchestrator.hasActiveSkillExecution(request.sessionId)`，结果赋给 `hasActiveSkill`）
  - shim 定义：`skill-context-orchestrator.ts:262`
  - 注释：`skill-context-orchestrator.ts:142`
- 更广的符号引用（`rg "hasActiveSkillExecution"`）：**43 处**（v2 称 44 错），分布于：
  - 3 个生产文件：`skill-context-orchestrator.ts`、`turn-engine.ts`、`skill-turn-identity-snapshot.ts`
  - 8 个测试文件：`skill-turn-identity.test.ts`、`turn-engine-force-tool-dispatch.test.ts`、`turn-engine-route.test.ts`、`turn-engine-projection.test.ts`、`agent-runtime-host-contract.test.ts`、`resume-fresh-contract-fields.test.ts`、`turn-engine-contract.test.ts`、`turn-frame-summary-log.test.ts`
- **类型穿越点 `(host as unknown as ...)` 涉及 `resolveRecentSkillTaskRun`**（**与 hasActiveSkillExecution 无关**，v2 错把两者并入 Q.7）：`turn-engine.ts:1604-1606` AND `:1635-1638`。`run-contracts.ts:766-791 TurnEngineHost` 类型增字段后这两处可改正式调用。
- **DirectChat 不需改动**（v3 修正 v2 的错误）：`src/main/modules/claude-bridge/direct-chat.ts:1121-1124` 当前提供的是 `resolveRecentSkillRun / resolveRecentSkillTaskRun`，**不**含 `hasActiveSkillExecution` 字段。Q.7 的 DirectChat 改动从 v2 移除。

### 1.6 verify:q 链相关（v3 实测格式）

- 现有 `verify:p`（`package.json:88`）= `verify:o + 4 cjs gates + test:p:gates + test:p:focus`。
- **`test:p:gates` 实际样式**（`package.json:86`）：`node --test scripts/__tests__/check-*.test.cjs`——cjs 文件位于 `scripts/__tests__/` 目录（不是 `src/__tests__/`）
- **`test:p:focus` 实际样式**（`package.json:87`）：`npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/*.test.ts`
- 所以 v3 Q 阶段对应：
  - cjs gate 测试 → `scripts/__tests__/*.test.cjs`，进 `test:q:gates`，runner `node --test`
  - TS 行为测试 → `src/__tests__/*.test.ts`，进 `test:q:focus`，runner `npx tsx@^4.19.2 --test --test-concurrency=1`
- `migration-033-invariant.test.ts` 是 TS（用 better-sqlite3 in-memory），所以归 `test:q:focus`
- `skill-task-tracker-runkind-invariant.test.ts` 同理归 `test:q:focus`
- 顶层 `npm run test`（`:41`）扫所有 `src/__tests__/*.test.ts`，会与 `test:q:focus` 重复——按 Stage P 同样接受双跑（`test:p:focus` 同模式）。

## 2. 合同（CI 必须强制）

| 编号 | 合同 | 强制方式 |
|---|---|---|
| C1 | 仅一个文件导出 `canResumeShape` 与 `canResumeWithFs` | 新 cjs gate `check-can-resume-single-source.cjs` |
| C2 | renderer 不 import canResume helper | 新 cjs gate `check-renderer-no-canresume-import.cjs` |
| C3 | **selected-skill primitive fence**：被 authorization 选中的 skill 若 `executionMode==='advisory'` 或包含任一 `runtime:'reference'` 的 action，该 skill 的所有 primitive 调用不写 SkillTaskRun / continuity；混合 skill 的 typed_action 路径不受影响（不走 primitive） | 行为测试 + typecheck（`recordPrimitiveOutcome` `skillKind` 必填） |
| C4 | active 行匹配按 runKind 区分；跨 runKind 不复用 | 行为测试（修改现有 `:434-467, :544-598` 期望） + 新单测 |
| C5 | `skill_task_runs.run_kind='primitive' AND tool_name='skill_lifecycle'` 不可同时存在 | DB CHECK constraint（migration 033） |
| C6 | 5 处可继续判定全部 import `canResumeShape`/`canResumeWithFs` | 新 cjs gate `check-can-resume-callers.cjs` |
| C7 | renderer 不允许从 `taskRunId` / 单读 `resumableActions.includes('continue')` / 单读 `interactionState==='suspended'` 推断按钮可见性；**ChatPanel + TaskPanel + taskCardViewModel** 均纳入 | 新 cjs gate `check-renderer-canresume-only.cjs` |
| C8 | restart 意图三分类 `fresh/resume/restart_from_existing` 互斥穷尽 | 新 cjs gate `check-restart-intent-exhaustiveness.cjs` |
| C9 | restart 三类 + frame.liveness 不继承 stale supervisor | 行为测试 |
| C10 | `runtime.listTaskProjections` 与 `runtime.getTaskProjection` **均**在返回前派生 canResume | 行为测试 + 新 cjs gate `check-task-projection-canresume-derived.cjs` |
| C11 | `npm run typecheck` 无错 | 现有链 |
| C12 | Migration 033 测试在 `:memory:` SQLite 跑通；**不**依赖 `verify:native`（仅验证 ABI） | 测试本体 |
| C13 | `verify:q` = `verify:p + 7 cjs gates + test:q:gates(cjs) + test:q:focus(tsx)` | package.json |
| C14 | 顶层 `verify` / `verify:cloud` 起步链切到 `verify:q` | package.json |
| ~~C15~~ | ~~`npm run test` 不再单独列举 `test:q:focus` 已涵盖文件，避免双跑~~ | **v4 删除**：与 §5 "按 Stage P 接受双跑" 矛盾；保留 §5 单一立场（双跑可接受） |

## 3. 实施步骤

> 严格按依赖图顺序：Q.1 → Q.2 → Q.3a → **Q.4+Q.6 合并** → Q.3b → Q.5 → Q.7。**v3：7 个 PR**（v1 8 → v2 6 → v3 7：Q.5 与 Q.7 拆开避免 PR-6 过大）。

---

### 3.1 PR-1（Step Q.1）— Helper 单源（C1, C2）

**新文件**：`src/main/modules/agent-control/resume-handle.ts`

```ts
import { statSync } from 'node:fs'

export interface ResumeHandle {
  childRunId?: string | null
  detachedTaskId?: string | null
  outputDir?: string | null
  runStatePath?: string | null
}

export function canResumeShape(handle: ResumeHandle | null | undefined): boolean {
  if (!handle) return false
  if (nonEmpty(handle.childRunId)) return true
  if (nonEmpty(handle.detachedTaskId)) return true
  return nonEmpty(handle.outputDir) && nonEmpty(handle.runStatePath)
}

export interface FsExistenceProbe {
  isFile(path: string): boolean
  isDirectory(path: string): boolean
}

export const defaultFsExistenceProbe: FsExistenceProbe = {
  isFile(path: string): boolean {
    try { return statSync(path).isFile() } catch { return false }
  },
  isDirectory(path: string): boolean {
    try { return statSync(path).isDirectory() } catch { return false }
  },
}

export function canResumeWithFs(
  handle: ResumeHandle | null | undefined,
  fs: FsExistenceProbe = defaultFsExistenceProbe,
): boolean {
  if (!canResumeShape(handle)) return false
  if (nonEmpty(handle!.childRunId) || nonEmpty(handle!.detachedTaskId)) return true
  return fs.isDirectory(handle!.outputDir!) && fs.isFile(handle!.runStatePath!)
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}
```

**新测试**：`src/__tests__/can-resume-helper.test.ts` — 6 真值象限 + 4 fs 边界（覆盖文件/目录类型混淆，参考 `run-state-resource-resolver.ts:76-85` / `run-state-selection.ts:48-52` 既有 stat 模式）。

**新 cjs gate**：`scripts/check-can-resume-single-source.cjs` — grep `export function canResumeShape\|export function canResumeWithFs` 必须仅命中一个 src/ 文件。

**新 cjs gate**：`scripts/check-renderer-no-canresume-import.cjs` — grep `from .*resume-handle` 在 src/renderer/ 下必须 0 命中。

**Land checklist**：typecheck + 新测试绿；2 个 gate standalone 跑通；不进 verify:q 链（最后 PR 切）。

---

### 3.2 PR-2（Step Q.2）— Selected-skill primitive fence（C3）

> **命名澄清（v4）**：本 step 实施的是 "selected-skill primitive fence"——按 authorization 选中的整 skill 判定是否阻断其 primitive 写入。`recordPrimitiveOutcome` 没有 action 上下文（authorization 不携带），所以判定按 skill 整体语义。混合 skill（如 lets-go-rss）的 typed_action 不走 primitive 路径，所以 fence 不会误伤。

#### 3.2.1 入口签名与调用面

**改动表**：

| 文件 | 行 | 改动 |
|---|---|---|
| `src/main/modules/tools/skills-tools.ts` | 933-946 | `recordPrimitiveOutcome` 签名增 `skillKind: { isReferenceOrAdvisory: boolean }` 必填字段 |
| 同上 | 957-1001 | 函数体首行加 `if (params.skillKind.isReferenceOrAdvisory && featureFlags.referencePrimitiveLifecycleFence) { logAgentMetric('reference_primitive_lifecycle_skipped', ...); return { stepId: params.stepId || 'reference-noop' } }`；`featureFlags` 通过新增的 `params.featureFlags` 入参传入 |
| 同上 | 933-946 | 增 `featureFlags: TurnFeatureFlags`（**必填**）参数 |
| `src/main/modules/tools/skills-tools.ts` | 1147-1149（**hoist 一次**） | 在 primitive `skillId/skillName` 解析后立即计算 `skillKind`：<br>```ts<br>const skillDef = listSkillsSafely().find(s => s.id === skillId)<br>const isAdvisorySkill = skillDef?.executionMode === 'advisory'<br>// 当前 primitive 在 reference action 上下文中：authorization.skillId 对应的 skillDef 任意 action.runtime==='reference' 即为 reference 上下文<br>// 注意混合 skill：非 reference action（如 lets-go-rss 的 python actions）由 typed_action 路径调用，不会走到 primitive 这里。所以 primitive 只可能从 reference / advisory 路径触达。<br>const hasReferenceAction = Boolean(skillDef?.actions?.some(a => a.runtime === 'reference'))<br>const skillKind = { isReferenceOrAdvisory: isAdvisorySkill || hasReferenceAction }<br>```<br>所有 18 个 caller 共享此 `skillKind` 与 `featureFlags`，不重复计算 |
| 同上 | 18 个 caller（行 1151, 1178, 1193, 1349, 1385, 1401, 1561, 1604, 1619, 1636, 1660, 1674, 1690, 1737, 1751, 1767, 1791, 1805） | 在调 `recordPrimitiveOutcome(...)` 时增传 `skillKind, featureFlags` |
| `src/main/modules/tools/skills-tools.ts` | 77-105（`SkillToolRuntimeContext` 类型） | 增 **必填** `turnFeatureFlags: TurnFeatureFlags` 字段 |
| `src/main/modules/agent-control/tool-executor.ts` | 299-311（调 `executeSkillTool` 处） | 注入 `turnFeatureFlags`：从 turn-engine 当前的 `__featureFlags` snapshot 透传 |
| `src/main/modules/agent-control/turn-engine.ts` | `__featureFlags` snapshot 创建处（参考现有 `turn-feature-flags.ts:11-18` 样板） | snapshot 新增字段 `referencePrimitiveLifecycleFence` |
| `src/main/modules/agent-control/turn-feature-flags.ts` | 类型定义 + snapshot 函数 | 增 `referencePrimitiveLifecycleFence: boolean`，default `process.env.READY_REFERENCE_PRIMITIVE_LIFECYCLE_FENCE !== '0'`；同时增 `skillTaskRunInvariantEnforced: boolean`（Q.3a 用，统一一次声明） |
| `src/main/modules/tools/skills-tools.ts` | 807-821 | `shouldRememberPrimitiveOutcomeForContinuity` 加 `isReferenceOrAdvisory` 入参；为 true 直接返 false（belt-and-braces） |

> **混合 skill 注**：用 `skillDef.actions.some(a => a.runtime === 'reference')` 判定 **会**把 lets-go-rss 这类混合 skill 标记为 fence 范围。但**因为 lets-go-rss 的 python actions 走 typed_action 路径不会触达 primitive**，所以即便整个 skill 标 isReferenceOrAdvisory，也不会误伤 python 动作。primitive 触达点只有 reference action 或 advisory skill 的辅助调用，对它们 fence 是合规的。

#### 3.2.2 测试

**新测试**：`src/__tests__/reference-primitive-no-lifecycle.test.ts`
- fixture 1: 注入 reference manifest（仅 read_skill action）+ 调 `executeSkillTool('skill_write_artifact', {...})` → 断言 `SkillTaskRunRepository.create` 调用 0 次 + `rememberSkillRun` 调用 0 次 + `reference_primitive_lifecycle_skipped` metric 1 次
- fixture 2: 注入 advisory executionMode skill + primitive → 同上
- fixture 3: 注入混合 skill（lets-go-rss-like：reference read_skill + python typed_action）+ 调 typed_action → 断言 typed_action 路径正常写 SkillTaskRun（**不**走 primitive fence）
- fixture 4: feature flag = '0' → 退化为旧行为（写 SkillTaskRun + emit `reference_primitive_lifecycle_fence_disabled` metric）

**回归保障**：现有 `src/__tests__/skill-primitive-continuity.test.ts` 必须全绿，**不许动 fixture**。

---

### 3.3 PR-3（Step Q.3a）— 代码侧 invariant（C4，部分 C5 前置）

#### 3.3.1 改动表

| 文件 | 行 | 改动 |
|---|---|---|
| `src/main/modules/agent-control/skill-task-tracker.ts` | 451-467 | `findTaskRunForEvent`：active 匹配 `find` 增加 `&& run.runKind === event.runKind`（受 `featureFlags.skillTaskRunInvariantEnforced` gate）；`findLatestRecoverable` 调用增加 runKind 过滤参数 |
| 同上 | 470-493 | `findTaskRunForLifecycleEvent`：保留 exact `taskRunId/detachedTaskId` 路径不变；active fallback 增加 `&& run.runKind === 'typed_action'` 过滤 |
| 同上 | 193-223 | `getOrCreateProjection`：key 改为 `skill:${sKey}:${skKey}:${event.runKind || 'primitive'}`；taskId 同步 |
| `src/main/modules/agent-control/active-skill-context.ts` | 136 | regex 改为 `/^skill:(?!detached:|run_state:|output:)[^:]+:([^:]+)(?::[^:]+)?$/`，capture group 1 是 skillId（吞掉可选 runKind 后缀） |
| `src/main/modules/tools/skills-tools.ts` | 982-994 | `rememberSkillRun` primitive 路径：`taskId: params.skillId` 改为：<br>```ts<br>const taskIdForContinuity = paths.outputDir<br>  ? \`primitive-output:${paths.outputDir}\`<br>  : paths.runStatePath<br>    ? \`primitive-run-state:${paths.runStatePath}\`<br>    : null<br>```<br>当 `taskIdForContinuity === null` 时**不 skip 整个 rememberSkillRun**（保留 skill-history fallback，参考 `session-continuity.ts:523-556`），改为传不带 taskId 的 record |
| `src/main/modules/agent-control/skill-task-supervisor.ts` | 371-379 | `snapshotHasDurableHandle` 改为 `return canResumeShape({detachedTaskId, outputDir, runStatePath})` |
| 同上 | 592-599 | `hasDurableResumeHandle` 同形重写 |
| `src/main/modules/agent-control/skill-task-tracker.ts` | runtime boot path（参考 `runtime.ts:220-238`） | **v4 拆分**：PR-3（Q.3a）只引入 `assertSkillTaskRunInvariantConsistency()` 函数体，不在 boot 调用（PR-3 时 CHECK 还未上，flag=0 也不会撞）；PR-5（Q.3b）migration 落地 CHECK 后才在 boot 调用此函数。函数体：查询 `SELECT sql FROM sqlite_master WHERE type='table' AND name='skill_task_runs'` 看是否含 `CHECK (NOT (run_kind = 'primitive' AND tool_name = 'skill_lifecycle'))` 字面量；与 `featureFlags.skillTaskRunInvariantEnforced` 比对：flag=false + CHECK 已 enforce → `throw new Error('READY_SKILL_TASK_RUN_INVARIANT_ENFORCED=0 is incompatible with migrated CHECK constraint; revert via forward-fix migration first')`。**boot 调用位置**：`runtime.ts:220-238` 之后、第一次 IPC 注册之前（**仅 PR-5 加调用点**） |

#### 3.3.2 现有测试期望调整

| 文件 | 期望调整 |
|---|---|
| `src/__tests__/skill-task-tracker.test.ts:434-467` | 修改：原期望"primitive monitor 事件 append 到同 session+skill 的 typed_action 父 row"。新期望："primitive monitor 事件创建独立 row（与 typed_action 父 row 同 sessionId+skillId 但 runKind='primitive'）"。**理由**：Q.3a 数据模型 invariant 要求按 runKind 分行 |
| `:544-598` | **v4 修正**：原期望"lifecycle event + primitive event 共存于同一 row"。新期望：**typed_action 与 lifecycle event 仍合并入同一 row（合规：runKind='typed_action' 不撞 CHECK），只 primitive event 拆出独立 row（runKind='primitive'）**。**理由**：lifecycle 复用 typed_action row 不破坏 invariant；只有 primitive 行被 lifecycle 改写才会撞 CHECK（即原 bug shape） |

#### 3.3.3 新测试

**新测试**：`src/__tests__/skill-task-tracker-runkind-invariant.test.ts`
- fixture 1：构造 primitive row + emit lifecycle event → 断言 lifecycle 创建新 row，不复用 primitive row
- fixture 2：构造 typed_action row + emit primitive event → 同上
- fixture 3：key 解析回往返：`getOrCreateProjection` 两个不同 runKind 触发 → 2 条 projection；`active-skill-context.ts:136` regex 解析新 taskId 回 skillId 一致
- fixture 4：feature flag `READY_SKILL_TASK_RUN_INVARIANT_ENFORCED='0'` → 退回旧匹配（且无 CHECK 时正常工作）

#### 3.3.4 新 gate

**新 cjs gate**：`scripts/check-supervisor-uses-canresume.cjs`
- grep `function snapshotHasDurableHandle\|function hasDurableResumeHandle` over `skill-task-supervisor.ts`
- 断言函数体 import + 调用 `canResumeShape`
- 断言函数体不含 `resumePayload` / `taskRunId` 单独作为 durable predicate 的形态

---

### 3.4 PR-4（Step Q.4 + Q.6 合并）— 合同贯穿 5 层 + cold-start reconcile（C6, C7, C10）

> Codex round 1 校对点 12 建议 Q.4+Q.6 合并：两者都触 `runtime.ts:619-635`，分开会形成空 PR-Q.6。

#### 3.4.1 改动表

| 文件 | 行 | 改动 |
|---|---|---|
| `src/main/modules/agent-control/skill-task-lifecycle.ts` | 65-74 | `hasContinuationHandle` 重写为 `return canResumeShape(continuation)` |
| `src/main/modules/agent-control/run-contracts.ts` | 1408-1427 | `loadSkillRunContract` minimum-anchor：去掉 `taskRunId / detachedTaskId 单独足够`；改为 `if (!canResumeShape(handle) && !skillId) return null`（skillId 仍可作锚定但不算可继续） |
| `src/main/modules/agent-control/run-contracts.ts` | 332-345（`TaskProjectionRecord` 接口） | 增可选字段 `canResume?: boolean`（Q.6 必备） |
| `src/main/modules/agent-control/task-projection-reconciler.ts` | 537-539 | `hasDurableHandle` 重写为 `return canResumeShape({outputDir: handles.outputDir, runStatePath: handles.runStatePath})` |
| `src/main/modules/agent-control/runtime.ts` | 2232-2275 | `buildContinuationIntent` 函数末尾在 return 前加 `if (!canResumeShape(intentLikeHandle)) return null` |
| `src/main/modules/agent-control/runtime.ts` | `runtime.resumeRun` 入口（**实测 caller**：`rg "this.resumeRun\(\|\.resumeRun\("` 后写入此处） | 拿到 null intent 时 emit `agent:error{errorKind:'not_resumable',recoverable:false}`；此处的"resumeRun call sites"在 v1 误标 `:1097/:1224/:1252`——那是 `buildContinuationIntent` 调用点。实际 `resumeRun` 入口在 IPC handler `ipc-handler.ts:` 注册位（PR 实施时实测后填行号） |
| `src/main/modules/agent-control/runtime.ts` | 619-635 | `listTaskProjections` 在 final return 前对每条 record 派生 `canResume = canResumeWithFs(continuationRef)`，附加到 record |
| `src/main/modules/agent-control/runtime.ts` | 637-640 | `getTaskProjection`：在返回前对单条 record 派生 `canResume`；可选地也调 `reconcileTaskProjections({records: [record], ...})` 一轮（行为对齐 list） |
| `src/main/modules/claude-bridge/ipc-handler.ts` | 534-550 | 不需要改：handler 透传 list/get 结果，新增字段自动透传（v3 修正路径） |
| `src/renderer/types/electron.d.ts` | 468-495（`TaskProjectionRecordData`） | 增可选 `canResume?: boolean`（v3 修正路径） |
| `src/renderer/components/agent/ChatPanel.tsx` | 1134-1168 | 继续按钮可见性：`(run.canResume === true) && run.resumableActions?.includes('continue')`；`canResume` 缺省 `?? false` |
| `src/renderer/components/agent/ChatPanel.tsx` | 2437-2489 | cold-start 第 4 段读 projection 时透传 `canResume` 到 TaskCardRun |
| `src/renderer/modules/agent/taskCardViewModel.ts` | 410-417 | `actionSet` 计算前看 `run.canResume === true`；false 时强制 `actionSet = []` |
| **`src/renderer/components/ready/TaskPanel.tsx`** | **327-352**（continue 动作派生） | 增 canResume 守门 |
| **`src/renderer/components/ready/TaskPanel.tsx`** | **633-640**（按钮渲染） | 增 canResume 守门 |
| `scripts/check-task-card-projection-only.cjs` | **51-70**（Stage O 现有 gate；blacklist 是 **Set**） | blacklist set add `'canResume'` |

#### 3.4.2 新 gate

**新 cjs gate**：`scripts/check-can-resume-callers.cjs`
- 5 个目标文件（lifecycle / run-contracts loadSkillRunContract / reconciler / runtime buildContinuationIntent / supervisor 两个函数）
- 各自必须 import `canResumeShape` 或 `canResumeWithFs` 至少一次
- 断言不存在 `outputDir.*\|\|.*runStatePath` 形态的自定义 boolean 表达式作为 durable handle 判定

**新 cjs gate**：`scripts/check-renderer-canresume-only.cjs`
- 范围：`ChatPanel.tsx` + `TaskPanel.tsx` + `taskCardViewModel.ts`
- 断言：任何 `resumableActions.includes(['"]continue['"])` 邻近必须有 `canResume === true` 或 `canResume &&` 守门
- 断言：不存在 `interactionState === ['"]suspended['"]` 单读决定按钮可见性的形态
- 断言：不存在 `taskRunId` 单读作为 resume 身份判定（Stage O `hasTaskRunResumeIdentity` 已覆盖；本 gate 是补强）
- gate 必须排除合法的 `cancel` / `inspect` 按钮（`run.resumableActions?.includes('cancel')` 单独不需 canResume）——通过仅检查 `'continue'` / `'retry'` 字面量

**新 cjs gate**：`scripts/check-task-projection-canresume-derived.cjs`
- grep `runtime.ts:619-635` 与 `:637-640` 必须各自 emit `canResume` 字段在返回前

#### 3.4.3 新测试

**新测试**：`src/__tests__/continuation-intent-rejects-shell.test.ts`
- fixture：投递 `runtime.resumeRun({scopeId, taskId, continuationIntent: {taskRunId: 'str-xxx'}})` 仅含 taskRunId
- 断言：emit `agent:error{errorKind:'not_resumable',recoverable:false}`
- 断言：`sendScoped` 调用次数 = 0

**新测试**：`src/__tests__/cold-start-canresume-projection.test.ts`
- fixture：DB 植入 stale projection（status='blocked', continuationRef 仅 taskRunId+skillId）
- 调 `runtime.listTaskProjections(scopeId)`：断言 reconcile 已运行 + canResume === false
- 调 `runtime.getTaskProjection(taskId)`：同上
- renderer fixture 基于 record 合成 TaskCardRun → 断言"继续"按钮不可见

---

### 3.5 PR-5（Step Q.3b）— SQLite schema 重建 + 存量清洗（C5, C12）

#### 3.5.1 Migration 033

**新增 migration**（在 `migrations.ts:1490-1499` 数组末尾追加）：

```ts
{
  name: '033_skill_task_runs_invariant_check',
  up: (db) => {
    // 1. 创建带 CHECK 的新表（完全复制 031 DDL + 表级 CHECK）
    db.exec(`
      CREATE TABLE skill_task_runs_q (
        id TEXT PRIMARY KEY,
        scope_id TEXT,
        session_id TEXT,
        agent TEXT,
        run_id TEXT,
        skill_id TEXT NOT NULL,
        skill_name TEXT,
        action TEXT NOT NULL,
        tool_name TEXT,
        run_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        interaction_state TEXT NOT NULL,
        goal_text TEXT,
        resource_refs_json TEXT,
        params_json TEXT,
        steps_json TEXT NOT NULL DEFAULT '[]',
        current_step_id TEXT,
        artifacts_json TEXT NOT NULL DEFAULT '[]',
        output_dir TEXT,
        run_state_path TEXT,
        scene_scores_path TEXT,
        delivery_report_path TEXT,
        failure_kind TEXT,
        failure_detail TEXT,
        job_id TEXT,
        detached_task_id TEXT,
        resume_payload_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        CHECK (NOT (run_kind = 'primitive' AND tool_name = 'skill_lifecycle'))
      );
    `)

    // 2. 拷贝并清洗存量违反 row
    db.exec(`
      INSERT INTO skill_task_runs_q
      SELECT
        id, scope_id, session_id, agent, run_id, skill_id, skill_name, action,
        CASE
          WHEN run_kind = 'primitive' AND tool_name = 'skill_lifecycle' THEN
            CASE
              WHEN action IS NULL OR trim(action) = '' THEN 'skill_unknown_primitive_cleanup'
              WHEN action = 'skill_lifecycle' THEN 'skill_unknown_primitive_cleanup'
              WHEN action NOT LIKE 'skill\\_%' ESCAPE '\\' THEN 'skill_unknown_primitive_cleanup'
              ELSE action
            END
          ELSE tool_name
        END AS tool_name,
        run_kind,
        CASE
          WHEN run_kind = 'primitive' AND tool_name = 'skill_lifecycle' THEN 'cancelled'
          ELSE status
        END AS status,
        interaction_state, goal_text, resource_refs_json, params_json, steps_json,
        current_step_id, artifacts_json, output_dir, run_state_path, scene_scores_path,
        delivery_report_path,
        CASE
          WHEN run_kind = 'primitive' AND tool_name = 'skill_lifecycle' THEN 'stage_q_invariant_cleanup'
          ELSE failure_kind
        END AS failure_kind,
        failure_detail, job_id, detached_task_id, resume_payload_json,
        created_at, started_at, updated_at, finished_at
      FROM skill_task_runs;
    `)

    // 3. 清洗 task_projections（实测列名 resumable_actions_json / continuation_ref_json / degradation_reason）
    db.exec(`
      UPDATE task_projections
      SET
        resumable_actions_json = '["none"]',
        degradation_reason = 'stage_q_invariant_cleanup',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE
        status = 'blocked'
        AND (
          continuation_ref_json IS NULL
          OR (
            json_extract(continuation_ref_json, '$.outputDir') IS NULL
            AND json_extract(continuation_ref_json, '$.runStatePath') IS NULL
            AND json_extract(continuation_ref_json, '$.childRunId') IS NULL
            AND json_extract(continuation_ref_json, '$.detachedTaskId') IS NULL
          )
        )
        AND (degradation_reason IS NULL OR degradation_reason != 'stage_q_invariant_cleanup');
    `)

    // 4. 清洗 task_projections 的 stale skill:<scope>:<skill> rows（无 runKind 后缀，supersede 逻辑当前排除）
    //    Q.3a 改了 projection key 加 runKind 后缀；存量旧 key 行未来不会被命中，必须显式标记或归并
    db.exec(`
      UPDATE task_projections
      SET
        resumable_actions_json = '["none"]',
        degradation_reason = COALESCE(degradation_reason, 'stage_q_runkind_key_legacy'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE
        task_id LIKE 'skill:%'
        AND task_id NOT LIKE 'skill:detached:%'
        AND task_id NOT LIKE 'skill:run_state:%'
        AND task_id NOT LIKE 'skill:output:%'
        AND (
          length(task_id) - length(replace(task_id, ':', ''))
        ) = 2;  -- 旧 key 'skill:S:K' 只有 2 个冒号；新 key 'skill:S:K:R' 有 3 个
    `)

    // 5. 切换表 + 重建索引
    db.exec(`DROP TABLE skill_task_runs;`)
    db.exec(`ALTER TABLE skill_task_runs_q RENAME TO skill_task_runs;`)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_skill_task_runs_scope_updated
        ON skill_task_runs(scope_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_skill_task_runs_session_status_updated
        ON skill_task_runs(session_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_skill_task_runs_skill_updated
        ON skill_task_runs(skill_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_skill_task_runs_job_id
        ON skill_task_runs(job_id);
      CREATE INDEX IF NOT EXISTS idx_skill_task_runs_detached_task_id
        ON skill_task_runs(detached_task_id);
    `)
  }
}
```

> **首例 CREATE-INSERT-DROP-RENAME 注**：现有 migrations 框架内所有 schema 修改都用 `ALTER TABLE`（参考 `:1224-1236, :1239-1246`），本 migration 是首例表重建。Migration runner 每个 migration 包在 transaction（`:1526-1541`），所以原子性由 runner 保证。PR 描述需明示这是首例 + 注明 transaction 包裹关系。

> **不写 migration 034 stub**：migrations 数组是可执行历史，未 land 的 migration 不能放进去。Forward-fix 路径作为 §6 文档说明，不预先入码。

#### 3.5.2 测试

**新测试**：`src/__tests__/migration-033-invariant.test.ts`（用 better-sqlite3 `:memory:` DB）
- 跑 migrations 001-032
- 注入 4 类 violator row：
  1. `runKind='primitive', toolName='skill_lifecycle', action='skill_write_artifact'`
  2. 同上但 `action=''`
  3. 同上但 `action='skill_lifecycle'`
  4. 同上但 `action='not-a-primitive'`
- 注入 2 类 task_projections violator：(a) blocked + 全空 handle；(b) 旧 key 形态 `skill:S:K`
- 跑 migration 033
- 断言：4 类 row tool_name 修复 + status='cancelled' + failure_kind='stage_q_invariant_cleanup'
- 断言：CHECK 生效——再插一条 violator → throw SQLITE_CONSTRAINT
- 断言：task_projections 的 violator 被置 `resumable_actions_json='["none"]'` + `degradation_reason='stage_q_invariant_cleanup'` 或 `'stage_q_runkind_key_legacy'`
- 断言：listActiveBySession / findLatestRecoverable(includeDone) 不返清洗后 row（因为 status='cancelled'）

> **`verify:native` 不验证 migration**（实测 `scripts/check-better-sqlite3-electron-abi.cjs:18-25` 仅做 `:memory:` ABI smoke）。本测试在 `:memory:` 自跑 migrations，是 migration 真正的合同测试。

---

### 3.6 PR-6（Step Q.5）— 重启三分类（C8, C9）

> v4 修正：PR-6 仅 Q.5；Q.7 退役清扫拆到 PR-7（避免 PR-6 范围过大）。Q.5 和 Q.7 均触 turn-engine.ts，但 Q.7 是机械性退役清扫，可在 Q.5 落地后单独推进。

#### 3.6.1 Q.5 改动表

**新文件**：`src/main/modules/agent-control/restart-intent-classifier.ts`

```ts
import { canResumeShape, type ResumeHandle } from './resume-handle'
import type { TurnUserIntent } from './turn-frame'

export type RestartIntentClass = 'fresh' | 'resume' | 'restart_from_existing'

export interface RestartIntentInputs {
  userIntent: TurnUserIntent  // 含 'cancel' 等完整 union；Codex round 1 校对点 7 修正
  explicitRunStateResource: unknown | null
  providedContinuationState: unknown | null
  continuationRef: ResumeHandle | null
}

export function classifyRestartIntent(inputs: RestartIntentInputs): RestartIntentClass {
  if (inputs.userIntent !== 'start') return 'resume'
  const hasHandle = Boolean(
    inputs.explicitRunStateResource
    || inputs.providedContinuationState
    || canResumeShape(inputs.continuationRef),
  )
  return hasHandle ? 'restart_from_existing' : 'fresh'
}

export const RESTART_INTENT_CLASSES: readonly RestartIntentClass[] = ['fresh', 'resume', 'restart_from_existing']
```

| 文件 | 行 | 改动 |
|---|---|---|
| `src/main/modules/agent-control/turn-engine.ts` | 1690-1702 | `shouldBindSkillContextForTurn` 拆为 `shouldBindForResume = restartClass === 'resume' && (...)` 与 `shouldBindForRestart = restartClass === 'restart_from_existing' && explicitRunStateResourceForTurn`；合并 `shouldBindSkillContextForTurn = shouldBindForResume \|\| shouldBindForRestart` |
| 同上 | 1751-1761 | `inspectLatestSkillTaskForHost` 调用仅在 `shouldBindForResume` 时进行 |
| 同上 | 1736-1739 | 仅 `restartClass === 'resume'` 时二次 `rememberActiveSkillContext` |
| `src/main/modules/agent-control/skill-turn-identity.ts` | 696-700 | `if (activeSkillContext && isSameSkillRunForResume(...) && identity.relation !== 'new')` 才调 |
| `src/main/modules/agent-control/turn-frame-resolver.ts` | 148-167 | `inferLiveness` 签名增 `userIntent: TurnUserIntent`；首行 `if (userIntent === 'start') return 'unknown'` 早退；唯一调用点 `:265` 同步加参（实测 `rg "inferLiveness\("` 仅 2 处） |

#### 3.6.3 Q.5 测试

**新 cjs gate**：`scripts/check-restart-intent-exhaustiveness.cjs`
- 对 `src/main/modules/agent-control/restart-intent-classifier.ts` grep
- 断言 `RESTART_INTENT_CLASSES` 数组长度 = 3 且 union type 也 3 项
- 断言 `turn-engine.ts` 不存在第四个 `userIntent === 'start' && ...` 分支构造特殊 frame

**新测试**：`src/__tests__/restart-frame-no-stale-liveness.test.ts`
- fixture：旧 blocked supervisor snapshot + restart 意图
- 断言：`frame.liveness !== 'blocked' && frame.liveness !== 'recoverable_paused'`
- 断言：`classifyRestartIntent` 返 `'fresh'`

**新测试**：`src/__tests__/restart-intent-classifier.test.ts`
- 4 类用户输入 fixture + 'cancel' / 'inspect' 意图边界
- 断言三类映射 + 互斥穷尽

**humanizer fixture 重命名**：
- 新文件 `src/__tests__/humanizer-zh-identity-authorization.test.ts`
- 从 `turn-engine-route.test.ts` 搬：`:1-24`（imports） + `:77-107`（setup helpers） + 任何 `:233/:343` 用到的共享 utils + `:2652-2755`（humanizer block 本体）
- 旧文件删除 humanizer block；保留其余测试

### 3.7 PR-7（Step Q.7）— 历史代码退役 + verify:q 切换 + §6.24

> v4：原 §3.6.2 拆为独立 §3.7（PR-7）。

#### 3.7.1 Q.7 完整范围（v3 实测纠偏）

| 文件 | 行 | 改动 |
|---|---|---|
| `src/main/modules/agent-control/skill-context-orchestrator.ts` | 262-267 | 删除 `hasActiveSkillExecution()` shim 本体 |
| 同上 | 142 | 删除引用此函数的注释行 |
| `src/main/modules/agent-control/turn-engine.ts` | **1457**（**唯一生产 caller**） | shim 永远返 false，所以 `hasActiveSkill` 永远 false。删除该行 + 删除变量 `hasActiveSkill` 的所有下游引用（grep 验证 `hasActiveSkill` 在 turn-engine.ts 内的使用范围；预期是几个 `\|\| hasActiveSkill` 短路条件，可直接改成 `false` 后简化或一并删除）。无需替换语义——既然永远 false，下游逻辑早已不依赖它真实值 |
| `src/main/modules/agent-control/turn-engine.ts` | `TurnEngineHost` 接口字段 | grep 实测后删除 `hasActiveSkillExecution?: ...` 字段（v2 称在 `:651-655`，PR 实施时实测后填精确行） |
| `src/main/modules/agent-control/skill-turn-identity-snapshot.ts` | snapshot type + collect 函数中相关代码 | grep 实测后删除（v2 称 `:38-43, :236-238`，PR 实施时实测） |
| `src/main/modules/agent-control/run-contracts.ts` | 766-791（`TurnEngineHost`） | 同步删除字段（如该接口在此处声明） |
| **8 个测试文件**：`skill-turn-identity.test.ts` / `turn-engine-force-tool-dispatch.test.ts` / `turn-engine-route.test.ts` / `turn-engine-projection.test.ts` / `agent-runtime-host-contract.test.ts` / `resume-fresh-contract-fields.test.ts` / `turn-engine-contract.test.ts` / `turn-frame-summary-log.test.ts` | 各自引用处 | 删除断言或将 mock 提供该字段的 stub 删除 |
| ~~`src/main/modules/direct-chat.ts`~~ | — | **不改动**（v3 修正：DirectChat 不含 `hasActiveSkillExecution` 字段；v2 错误已撤回） |
| `src/main/modules/skills-runtime/skill-compiler.ts` | 423-428 | 删除 `workflowFile` 默认探测；保留显式 manifest 字段读取 |
| 同上 | 417-443 | advisory/direct 推断的现有测试同步修改 |
| `src/main/modules/agent-control/turn-engine.ts` | 1604-1606 + 1635-1638 | **类型穿越涉及 `resolveRecentSkillTaskRun`，与 `hasActiveSkillExecution` 无关**（v3 修正 v2 的混淆）。改 host 接口正式声明：在 `run-contracts.ts:766-791 TurnEngineHost` 增 `resolveRecentSkillTaskRun?: (sessionId: string \| undefined) => RecentSkillRunForResume \| null` |
| `src/main/modules/agent-control/turn-engine.ts` | 1625-1627 | 删除 `resolveActiveSkillContextLive: resolveActiveSkillContext` 重命名；改为直接传 `resolveActiveSkillContext` 函数引用 |

---

## 4. 测试合同清单

9 个新独立 test 文件 + humanizer 重命名：

| 文件 | 来源 | 覆盖 stage |
|---|---|---|
| `src/__tests__/can-resume-helper.test.ts` | 新 | Q.1 |
| `src/__tests__/reference-primitive-no-lifecycle.test.ts` | 新 | Q.2 |
| `src/__tests__/skill-task-tracker-runkind-invariant.test.ts` | 新 | Q.3a |
| `src/__tests__/migration-033-invariant.test.ts` | 新 | Q.3b |
| `src/__tests__/continuation-intent-rejects-shell.test.ts` | 新 | Q.4 |
| `src/__tests__/cold-start-canresume-projection.test.ts` | 新 | Q.4+Q.6 |
| `src/__tests__/restart-frame-no-stale-liveness.test.ts` | 新 | Q.5 |
| `src/__tests__/restart-intent-classifier.test.ts` | 新 | Q.5 |
| `src/__tests__/humanizer-zh-identity-authorization.test.ts` | 重命名（含 utils 搬迁） | identity/auth 合同保留 |

## 5. CI verify 链（v3 与 Stage P 完全对齐）

最终 PR（PR-7 着陆时）一次性切换：

```json
"test:q:gates": "node --test scripts/__tests__/check-can-resume-single-source.test.cjs scripts/__tests__/check-renderer-no-canresume-import.test.cjs scripts/__tests__/check-supervisor-uses-canresume.test.cjs scripts/__tests__/check-can-resume-callers.test.cjs scripts/__tests__/check-renderer-canresume-only.test.cjs scripts/__tests__/check-restart-intent-exhaustiveness.test.cjs scripts/__tests__/check-task-projection-canresume-derived.test.cjs",
"test:q:focus": "npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/can-resume-helper.test.ts src/__tests__/reference-primitive-no-lifecycle.test.ts src/__tests__/skill-task-tracker-runkind-invariant.test.ts src/__tests__/migration-033-invariant.test.ts src/__tests__/continuation-intent-rejects-shell.test.ts src/__tests__/cold-start-canresume-projection.test.ts src/__tests__/restart-frame-no-stale-liveness.test.ts src/__tests__/restart-intent-classifier.test.ts src/__tests__/humanizer-zh-identity-authorization.test.ts",
"verify:q": "npm run verify:p && node scripts/check-can-resume-single-source.cjs && node scripts/check-renderer-no-canresume-import.cjs && node scripts/check-supervisor-uses-canresume.cjs && node scripts/check-can-resume-callers.cjs && node scripts/check-renderer-canresume-only.cjs && node scripts/check-restart-intent-exhaustiveness.cjs && node scripts/check-task-projection-canresume-derived.cjs && npm run test:q:gates && npm run test:q:focus",
"verify": "npm run verify:native && npm run verify:q && npm run test",
"verify:cloud": "npm run rebuild:native && npm run verify:q && npm run test"
```

**v3 关键纠偏**：
- gate 测试位于 `scripts/__tests__/*.test.cjs`，runner `node --test`（与 Stage P 完全一致）
- 行为测试位于 `src/__tests__/*.test.ts`，runner `npx tsx@^4.19.2 --test --test-concurrency=1`
- 9 个新行为测试（含两个 invariant 测试）全部放 focus（不进 gates）
- 顶层 `npm run test` 会与 `test:q:focus` 重复扫 src/__tests__——按 Stage P 模式接受双跑
- gate 的 cjs 脚本本体（`scripts/check-*.cjs`）由 verify:q 直接调，每个对应一个 `scripts/__tests__/check-*.test.cjs` 测试 gate 的逻辑

## 6. Migration / Rollback / Feature Flag

| Sub-stage | Feature flag | Default | 关闭后行为 | Q.3b 之后 |
|---|---|---|---|---|
| Q.2 | `READY_REFERENCE_PRIMITIVE_LIFECYCLE_FENCE` | `'1'` | 退化为旧路径 | flag 仍可用（不与 schema 冲突） |
| Q.3a | `READY_SKILL_TASK_RUN_INVARIANT_ENFORCED` | `'1'` | 退回跨 runKind 匹配 | **runtime boot 检测 flag=false + CHECK enforced → hard fail；插入位置 `runtime.ts:220-238` 之后、第一次 IPC 注册之前；新函数 `assertSkillTaskRunInvariantConsistency()`** |

### 6.1 Forward-fix 回滚方案（紧急情况，独立 PR）

如果 Q.3b 落地后发现需要回滚：
1. 写 migration 034（独立 PR）：CREATE 新表无 CHECK + COPY + DROP + RENAME（与 033 同模式）
2. 关闭 `READY_SKILL_TASK_RUN_INVARIANT_ENFORCED='0'`
3. migration 034 自身仅 schema 简化，无数据丢失风险

> v2 不预先在代码里写 034 stub；以文档说明形式存在于本节。

### 6.2 Migration 验证

- Migration 033 单独测试（`migration-033-invariant.test.ts`）在 `:memory:` SQLite 跑 migrations 001-033 + fixture 注入
- `verify:native` **不**验证 migration 033——它只验证 better-sqlite3 ABI（`scripts/check-better-sqlite3-electron-abi.cjs:18-25`）
- 真实 dev 环境验证：用户首次启动 Q.3b 后的 build → 检查 `<userData>/ready.db` 内 `skill_task_runs` 的 SQL 含 CHECK 字面量

## 7. 提交序列（PR 边界）— v3 7 PR（v3 拆 PR-6 为 PR-6 + PR-7）

| # | 范围 | sub-stage | verify chain | 备注 |
|---|---|---|---|---|
| **PR-1** | Q.1 helper + 单测 + 2 cjs gate | Q.1 | verify:p（不入 verify:q） | 纯添加 |
| **PR-2** | Q.2 fence + 18 caller 改 + flag 接入 + 测试 | Q.2 | verify:p | feature flag default '1'；selected-skill primitive fence |
| **PR-3** | Q.3a 代码 invariant + 修改既有 2 个 test fixture（精细：保留 typed+lifecycle 同 row，仅拆 primitive） + 新单测 + boot fence 函数（**仅函数体**，CHECK 检测分支留待 PR-5 启用） | Q.3a | verify:p + 新测试 | flag default '1' |
| **PR-4** | Q.4 + Q.6 合并：5 层贯穿 + IPC + UI（ChatPanel + TaskPanel + viewModel） + 测试 + 3 cjs gate + Stage O blacklist 扩展 | Q.4+Q.6 | verify:p | 5 处 helper + 2 处 derive |
| **PR-5** | Q.3b migration 033 + 测试 + boot fence CHECK 检测分支启用（接通 Q.3a 留下的 `assertSkillTaskRunInvariantConsistency` 函数体） | Q.3b | verify:p + migration 测试 | 首例 CREATE-INSERT-DROP-RENAME |
| **PR-6** | Q.5：restart classifier + turn-engine restart split + humanizer 重命名（含 utils 搬迁） + restart 相关测试 + restart-intent-exhaustiveness gate | Q.5 | verify:p | turn-engine.ts 主要改动 |
| **PR-7** | Q.7：hasActiveSkillExecution 完整退役（3 prod + 8 test） + workflowFile 删除 + 类型穿越改正式接口（resolveRecentSkillTaskRun） + resolveActiveSkillContextLive 重命名清理 + 切换 verify:q + 顶层 verify 切到 verify:q + CLAUDE.md §6.24 | Q.7 | verify:q（首次） | **本 PR 是切换点**；机械性退役清扫 |

### 7.1 每个 PR 描述模板

```
## Stage Q · PR-N · <范围>

### 合同变更
- C? : <合同标号 + 一句话>

### 改动文件
- src/...: <一句话>

### 测试
- npm run typecheck: PASS
- npm run test:q:focus / test:q:gates: PASS（如已切换）或本 PR 相关测试: PASS
- npm run verify:native: PASS（仅 PR-5 强制）

### Feature flag 状态
- READY_REFERENCE_PRIMITIVE_LIFECYCLE_FENCE: '1' (default)
- READY_SKILL_TASK_RUN_INVARIANT_ENFORCED: '1' (default)

### Migration evidence（仅 PR-5）
- migrations 001-033 in :memory: PASS
- 4 类 violator row 修复 PASS
- 2 类 violator projection 修复 PASS

### Rollback
- <一句话回滚方案>
```

## 8. CLAUDE.md §6.24（最后一个 PR 同步落地）

新增章节 `### 6.24 Skill Resumability 三层 Fence（Q / Stage 11）`，至少包含：

- **Helper 单源**：`canResumeShape` / `canResumeWithFs` 唯一导出在 `agent-control/resume-handle.ts`；renderer 不允许 import；fs probe 用 `statSync().isFile()` / `.isDirectory()`，不用 existsSync
- **入口 fence (selected-skill primitive fence)**：被 authorization 选中的 skill 若 `executionMode==='advisory'` 或包含任一 `runtime:'reference'` 的 action，则该 skill 的所有 primitive 调用不写 SkillTaskRun / continuity；混合 skill 的 typed_action 不走 primitive 路径所以不受影响；feature flag `READY_REFERENCE_PRIMITIVE_LIFECYCLE_FENCE`（`turn-feature-flags.ts` snapshot）
- **数据模型 invariant**：`skill_task_runs` CHECK `(NOT (run_kind='primitive' AND tool_name='skill_lifecycle'))`；active row 匹配按 runKind 区分；projection key 含 runKind；feature flag `READY_SKILL_TASK_RUN_INVARIANT_ENFORCED` + boot hard fail（flag=0 + CHECK enforced）
- **5 层 canResume 复用**：`hasContinuationHandle` / `loadSkillRunContract` / `hasDurableHandle` / `buildContinuationIntent` / supervisor 两处全部 import helper；`runtime.listTaskProjections` / `runtime.getTaskProjection` 返回前派生 `canResume`
- **renderer 合同**：ChatPanel + TaskPanel + taskCardViewModel 仅消费 `projection.canResume`，与 `resumableActions.includes('continue')` 双重门；不允许 `interactionState==='suspended'` 单读决定按钮可见性
- **buildContinuationIntent 拒空壳**：`null` 时 emit `agent:error{errorKind:'not_resumable',recoverable:false}`
- **restart 三分类**：`fresh / resume / restart_from_existing` 互斥穷尽；`fresh` 与 `restart_from_existing` 不让 stale supervisor 给 frame liveness；`turn-frame-resolver.inferLiveness` 在 `userIntent==='start'` 时早退
- **退役**：`hasActiveSkillExecution` 完整删除（5 文件）；`skill.workflow.json` 默认探测删除；类型穿越 2 处改正式接口
- **CI 强制**：`verify:q` 链 + 7 cjs gates + `test:q:focus`
- **Migration**：033 是首例 CREATE-INSERT-DROP-RENAME；forward-fix 回滚需独立 migration 034；`verify:native` 不验证 migration 真值

## 9. 验收（Stage Q 完成判据）

1. 7 个 PR 全部合入
2. `verify:q` 全绿
3. `npm run typecheck` 无错
4. `npm run verify:native` 通过（ABI 检查；migration 真值由 `migration-033-invariant.test.ts` 单独覆盖）
5. 9 个新测试文件 + 重命名的 humanizer 文件全绿
6. 用户在本机 dev 环境复现：
   - 跑 humanizer-zh + 普通文字交互 + 重启 → 无残留任务卡
   - 跑可继续的长任务（如 video_expert_pipeline）+ 重启 → 卡片可正常继续
   - 主动"重新开始"指令 → 不卡 checkpoint_budget
7. CLAUDE.md §6.24 已落地

## 10. v3 修正日志（Codex round 2 反馈）

| 项 | v2 错 | v3 修正 |
|---|---|---|
| 文件路径 | `src/main/modules/ipc-handler.ts` / `src/preload/electron.d.ts` / `src/main/modules/direct-chat.ts` | 改为 `src/main/modules/claude-bridge/ipc-handler.ts` / `src/renderer/types/electron.d.ts` / `src/main/modules/claude-bridge/direct-chat.ts` |
| Q.2 fence 命名 | "current action context" 实际是 selected-skill 整体判定，名实不符 | 改名为 "selected-skill primitive fence"，明示混合 skill 行为 |
| Q.3a 现有测试影响 | 称 `:544-598` "lifecycle event 创建独立 row" | 修正：lifecycle 仍合并入 typed_action 父 row（合规，runKind 不撞 CHECK），只 primitive 拆出 |
| `hasActiveSkillExecution` 范围 | 称 44 ref / 5 prod 文件 / DirectChat 也改 | 修正：43 ref / 3 prod 文件 (orchestrator + turn-engine + identity-snapshot) + 8 test 文件；DirectChat 不动；唯一生产 caller `turn-engine.ts:1457` 永远 false 可直删而非"替换" |
| 类型穿越点归属 | 错把 `(host as unknown as ...)` 与 `hasActiveSkillExecution` 混入同 PR | 分清：类型穿越是 `resolveRecentSkillTaskRun` 相关，与 `hasActiveSkillExecution` 无关，但同 PR-7 退役 |
| verify:q 测试 runner | TS 测试用 `tsx --test`（错误格式） | 改为 `npx tsx@^4.19.2 --test --test-concurrency=1`（与 Stage P 完全一致）；gate 测试位 `scripts/__tests__/*.test.cjs` |
| PR-6 范围过大 | 单 PR 同时做 Q.5 + Q.7 + verify 切换 + CLAUDE.md | 拆为 PR-6（Q.5 only）+ PR-7（Q.7 + 切换 + 文档），7 PR 总数 |

## 11. v1 修正日志（Codex round 1 反馈）

| 编号 | v1 错误 | v2 修正 |
|---|---|---|
| MUST-FIX 1 | migration SQL 列名 `resumable_actions / continuation_ref` 错；`verify:native` 误称验证 migration | 改为 `resumable_actions_json / continuation_ref_json`；§5/§6 明示 verify:native 仅 ABI 检查 |
| MUST-FIX 2 | Q.2 caller 漏数（仅说"每个 primitive 分支"未列举）；flag 未通过 SkillToolRuntimeContext 透传；混合 skill 处理错误 | 列 18 个 caller 行号；hoist skillKind 一次；threading turnFeatureFlags 进 SkillToolRuntimeContext + tool-executor；混合 skill 注 |
| MUST-FIX 3 | TaskPanel 漏；getTaskProjection 漏；blacklist 是 Set 不是 Array | TaskPanel.tsx:327-352, :633-640 加；getTaskProjection 派生 canResume；`scripts/check-task-card-projection-only.cjs:51-70` Set add |
| MUST-FIX 4 | runKind key 改后存量旧 key projection 处理缺失 | migration 033 第 4 步：清洗 `task_id LIKE 'skill:%'` 但只 2 个冒号的旧 key |
| MUST-FIX 5 | `hasActiveSkillExecution` 退役范围严重低估（仅说"删 shim"） | 完整范围：5 文件 + 生产 caller 替换 + 测试更新；类型穿越 2 处不是 1 处 |
| MUST-FIX 6 | verify:q 把 TS 测试丢进 gates；用 `node --test` 而非 `npx tsx` | 分离：cjs gates / tsx focus；与 Stage P 一致 |
| MUST-FIX 7 | Hard-fail 插入点未指定 | `runtime.ts:220-238` 之后；新函数 `assertSkillTaskRunInvariantConsistency()` |
| ➕ 1 | canResumeWithFs 用 existsSync 太松 | 改用 statSync().isFile()/isDirectory()；DefaultProbe 提供 |
| ➕ 2 | TaskPanel 未在 §3.4 列出 | 加入 |
| ➕ 3 | SkillToolRuntimeContext 缺 turnFeatureFlags | 加必填字段 |
| ➕ 4 | Migration 033 列名错 | 改 |
| ➕ 5 | TS 测试 runner 错 | 改 |
| ➕ 6 | hasActiveSkillExecution 退役范围 | 完整列出 |
| 校对点 7 | TurnUserIntent 含 'cancel' 漏处理 | RestartIntentInputs 用 TurnUserIntent 完整 union |
| 校对点 12 | 8 PR 太多 | 合并为 6（Q.4+Q.6 / Q.5+Q.7） |
| 校对点 13 | CLAUDE.md §6.24 outline 不全 | 8 节展开（match §6.13 / §6.23 level） |

— 完 —
