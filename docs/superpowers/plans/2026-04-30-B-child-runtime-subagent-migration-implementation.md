---
name: B — Child Runtime → SubAgent 特化迁移
description: v3 路线 B 阶段实施计划。把 SkillChildRunner 改造为 SubAgent 特化（VEA SubAgent 是首个具体实现）；引入 AbortController 树；统一 cleanup registry。Layer 1 的 5 条 contract 全部保留。
status: draft
enforce: true
counter_proposal: 2026-04-30-skill-runtime-agent-layer-reframe.md
implementation_amendment: 2026-05-01-w0-gates-first
---

# B — Child Runtime → SubAgent 特化迁移（实施计划）

> **范围**：把 `SkillChildRunner` 内部实现迁移到 `SubAgent` 框架；引入父子 AbortController 树；把 child run 内部 cleanup（timers / listeners / `try/finally`）统一走 `RunCleanupRegistry`。
>
> **公共 API 不变**：`startSkillChildRun / resumeSkillChildRun / cancelSkillChildRun / getSkillChildRunCloseEvent / waitForSkillChildRunClose` 5 个 module-level 导出签名 + 行为完全保持。turn-engine / skills-tools / runtime-manager 的 call site 不动。
>
> **Layer 1 5 条 contract 全部保留**：A1 identity guard / A2 resume failure surface / B2 RESUME_ENABLED flag / B6 prepareResumeLifecycle / helper banner singleton rule。任何一条破坏 = B 失败。
>
> **B 完成 = A1 boundary 被拆**：`scripts/check-a1-boundary.cjs`、`ready/no-subagent-leak` 对 child-runner 路径的限制、`verify:a1` 中对它们的调用——全部移除。

> **2026-05-01 执行修订**：A1 boundary teardown 前移到 W0b；API checker 前移到 W0a；`SkillChildSubAgent` 放在 `agent-control/skill-child-sub-agent*.ts`，不放进通用 `sub-agent/` 目录，保留 SubAgent 框架隔离。W1 必须显式注入 `executeAction`，定义 action progress payload，并提供 `SubAgentCloseEvent → SkillChildCloseEvent` 映射，不能把两种 close event 直接等同。

---

## 0. Context

### 0.1 为什么现在做

A0 / A0.5 / A1 已 land：
- A0 commit `7de7ca0`、A0.5 commit `c176fcf`、A1 commit `9fe8703`
- A1 SubAgent skeleton + 1 PoC（EchoSubAgent）已就位，contract test 8/8 通过
- `verify:a1` 闸门绿灯，`check-a1-boundary.cjs` 当前要求 `skill-child-*` + `turn-engine.ts` 零变更

A1 §8 准入声明明确写：B 阶段的第一个 PR 必须做 3 件事：
1. 移除 `scripts/check-a1-boundary.cjs`
2. 移除 `verify:a1` 中对它的调用
3. 放开 `ready/no-subagent-leak` 对 child-runner 迁移路径的阻挡

如果 B 不做这 3 件事 = A1 boundary 永远卡住，B 永远进不去；它们是 A1 临时性产物，B 启动 = 它们的退役时机。

### 0.2 Reconnaissance Facts（已通过 Explore agent 实地核查）

下列是 B 设计的输入事实：

**`SkillChildRunner` 公共 API 5 个 module-level 函数**（`skill-child-runner.ts:1158-1209`）：
- `startSkillChildRun / resumeSkillChildRun / cancelSkillChildRun / getSkillChildRunCloseEvent / waitForSkillChildRunClose`
- `configureSkillChildRunner(config)` boot-time 配置（`runtime.ts:244`）
- `__resetSkillChildRunnerForTests()` 测试专用

**Call sites（生产代码，非测试）共 3 个模块**：
- `turn-engine.ts`：1394 (getCloseEvent)、1416 (cancel)、1486 (resume)、2399 (getCloseEvent again)
- `skills-tools.ts:2002-2004`：tool dispatch 启动 child-owned skill
- `runtime-manager.ts:2051,2076`：legacy `startSkillChildRunAndWait` 兼容包装

**生产 driver 注册仅 1 个**：
- VEA driver via `video-expert-child-driver.ts:358`（module-load side-effect）
- `MAX_ACTIVE_VEA_CHILD_RUNS = 3` 全局并发上限

**SkillChildRunner 内部 3 项关键状态**（`skill-child-runner.ts`）：
- `active: Map<string, ActiveRun>` (line 158) — in-flight lifecycle
- `recentCloses: Map<string, SkillChildCloseEvent>` (line 169) — LRU 64 终态缓存
- `inDriverDepth: number` (line 166) — nested-child 计数器（`childInternal: true` 才允许 re-entry）

**Layer 1 5 条 contract 锁定测试**：

| Contract | 测试 | 文件 | Line |
|---|---|---|---|
| A1 identity guard | `'resume completes a second lifecycle without runner singleton reset'` | `skill-child-runner-resume-lifecycle.test.ts` | 334 |
| A2 resume failure | `'Phase 5: skill_failure (success:false) vs process crash throw split correctly'` | `skill-child-runtime-decisions.test.ts` | 250 |
| B2 flag disable | `'resume disabled by flag does not call resumeSkillChildRun and emits metric'` | `turn-engine-route.test.ts` | 3075 |
| B6 stale close | `'resume after pause clears the previous closeEvent in the row payload'` | `skill-child-runner-resume-lifecycle.test.ts` | 388 |
| Helper banner | "IMPORTANT — singleton lifecycle in tests" + `setupRunner` 规约 | `skill-child-runner.test.ts` | 484-526 |

**AbortController 当前是 flat 的**：
- 3 个独立 controller：`tool-runtime.ts:574`、`skill-child-runner.ts:755 (ActiveRun.controller)`、`detached-skill-task-tracker.ts:220`
- **`TurnEngineSession.abortController`（`run-contracts.ts:71-79`）字段已定义但 agent-control 模块内零读取** —— vestigial field，B 阶段才让它 load-bearing
- `request.abortSignal` 在 turn-engine.ts 和 tool-runtime 间 flat 传递，无 child controller 链接

**RunCleanupRegistry 当前 caller**：5 个模块（orchestrator / tool-runtime / turn-engine / document-domain-adapter / sub-agent/sub-agent-cleanup）。skill-child-runner 不用——它走 `try/finally` + `controller.abort()` + `map.delete()` 手工模式。

**SubAgent contract（A1 已锁定）**：
- `SubAgent.run(context): AsyncGenerator<SubAgentWorkEvent, SubAgentRunResult | void>` 只 yield `progress / paused`
- `runSubAgent` 包装 `started / terminal` framing，强制 cleanup.drain() exactly once
- A1 §12 列出的字段集合 / event 形状 / yield 顺序契约**不许修改**（如要修需新 plan）

### 0.3 §4 形态约束（A1 接口对 B 的强制影响）

A1 §4 形态约束在 B 阶段必须实际兑现：

1. **§4.1 lifecycle id ≠ artifact dir**：`SkillChildSubAgent.lifecycleId = childRunId`（每次 resume 复用同一 id，per Layer 1 invariant），`artifactDir = outputDir`（跨 lifecycle 复用）。两个独立的合同。
2. **§4.2 多产品共享**：B 仅迁移 VEA driver；RSS / browser 等其他长任务不在 B 范围。`SkillChildSubAgent` 是 SubAgent 接口的**第一个**生产实现，不是唯一。
3. **§4.3 跨进程恢复**：B 用 factory pattern 实现 `createSkillChildSubAgentFromPersisted(state)`，不复活 A1 删掉的 `restoreFrom` hook。
4. **§4.4 测试可见性**：B 的迁移合同必须有专门 contract test（`skill-child-subagent.test.ts`）压死 SubAgent ↔ SkillChildRunner 协作关系。

### 0.4 战略决定：B 不走 feature flag（与 v3 §6.1 分歧）

v3 reframe doc §6.1 写：
> **缓解**：迁移走 feature flag，新旧两套并存到稳定为止；每条迁移路径单独 verify

**本 plan 不采纳此建议**。理由：

1. **冲突原则 3（拒绝 legacy 兼容分支）**：v3 §6.1 当时 A0 还没落，5 条战略原则未上 CI。A0 commit `7de7ca0` 之后，`if (useSubAgent) { ... } else { ... }` 这种模式 = `ready/no-legacy-backdoor` 规则正面阻挡。
2. **Layer 1 测试套件已是事实安全网**：5 条 critical contract + 全套 Phase 4-6 测试（11 + 8 + 4 = 23 个测试场景），覆盖密度足以在 PR review 阶段拦下 95%+ 回归。
3. **公共 API 不变 = 用户可见行为不变**：B 是内部重构（Ship of Theseus），不动 turn-engine / skills-tools / runtime-manager 的 call site。失败模式 = "child runs 不工作"，被 verify:b 闸门即时检出，不会偷偷上线。
4. **回滚路径清晰**：如果 PR land 后生产挖出未覆盖的回归，`git revert <B-commit>` 比 `flag=0` 更直接、更彻底，不留 dead code。

如果用户 / codex 强烈反对此判断，B plan 可以加一个**临时 emergency flag** `READY_SKILL_CHILD_USE_LEGACY_RUNTIME`（默认 off），但必须满足：
- 删除 commit 已写入 v3 §5.1（"B 完成 = flag 删除 + 30 天烟测"）
- 不进入 `verify:b` 闸门
- 不参与 Layer 1 contract 测试（contract 测试只跑新路径）

**默认采用无 flag 路线**。

---

## 1. Hard Contracts CI Verifies

B land 后 CI 必须能机器验证下列 9 条合同：

### C1. SubAgent 公共 API 5 个 export 签名 100% 不变

```bash
node scripts/check-skill-child-runner-api.cjs
```

新 script 实现：
- 解析 `src/main/modules/agent-control/skill-child-runner.ts` 的 module-level export
- 提取签名（function name + parameter types + return type）
- 与冻结的快照 `scripts/snapshots/skill-child-runner-api.snapshot.json`（W0 land）做 deep equal
- 任何 export 签名变更 → exit 1

冻结的 5 个签名（W0 写入 snapshot）：
- `startSkillChildRun(params: StartSkillChildRunParams): Promise<StartSkillChildRunResult>`
- `resumeSkillChildRun(childRunId: string): Promise<StartSkillChildRunResult>`
- `cancelSkillChildRun(childRunId: string, reason?: string): Promise<SkillChildCloseEvent>`
- `getSkillChildRunCloseEvent(childRunId: string): SkillChildCloseEvent | null`
- `waitForSkillChildRunClose(childRunId: string, options: WaitForSkillChildRunCloseOptions): Promise<ChildWaitResult>`
- `configureSkillChildRunner(config: SkillChildRunnerConfig): SkillChildRunner`
- `__resetSkillChildRunnerForTests(): void`

### C2. Layer 1 五条 contract 测试零修改、零 skip、全绿

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/skill-child-runner-resume-lifecycle.test.ts \
  src/__tests__/skill-child-runtime-decisions.test.ts \
  src/__tests__/skill-child-feature-flags.test.ts \
  src/__tests__/turn-engine-route.test.ts
```

加上 git diff 检查：
```bash
git diff <B_BASE>..HEAD -- \
  src/__tests__/skill-child-runner-resume-lifecycle.test.ts \
  src/__tests__/skill-child-runtime-decisions.test.ts \
  src/__tests__/skill-child-feature-flags.test.ts \
  | wc -l
# 预期: 0
```

> 测试不能改也不能 skip。如果 B 的实现需要新行为，**新增** contract test 而非改旧的。

### C3. 全部 skill-child-* 测试套件零修改、全绿

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/skill-child-*.test.ts
```

`git diff <B_BASE>..HEAD -- src/__tests__/skill-child-*.test.ts` 必为零（除 W4 新增的 `skill-child-subagent.test.ts`）。

### C4. AbortController 树合同：parent abort → child SubAgent 收到 abort

新 contract test `src/__tests__/skill-child-abort-tree.test.ts`：

```ts
it('aborting TurnEngineSession.abortController aborts in-flight SkillChildSubAgent', async () => { ... })
it('aborting SkillChildSubAgent.controller does NOT abort parent TurnEngineSession', async () => { ... })
it('cancelSkillChildRun resolves with status=killed when parent session aborts mid-flight', async () => { ... })
it('SubAgentContext.abortSignal observed in EchoSubAgent matches the linked child controller signal', async () => { ... })
```

C4 验证 D3 的 abort tree 是真链接，不是预留的 dead code。

### C5. cleanup registry 合同：child run 的 timers/listeners 走 RunCleanupRegistry

新 contract test `src/__tests__/skill-child-cleanup-registry.test.ts`：

```ts
it('launchStuckTimer registers cleanup via SubAgentCleanupHandle (no manual clearTimeout in finalize)', async () => { ... })
it('SubAgent.run() abort path drains all registered cleanups exactly once', async () => { ... })
it('multiple cleanups register and drain in registration order', async () => { ... })
```

实现验证：grep `skill-child-runner.ts` for `clearTimeout` 出现次数 ≤ 1（仅允许 launchStuckTimer 自己的拆解，且必须经 cleanup.register 路径）。

### C6. SkillChildSubAgent factory 实现 SubAgent contract

```bash
npx tsx@^4.19.2 --test src/__tests__/skill-child-subagent.test.ts
```

新文件 `src/__tests__/skill-child-subagent.test.ts` 至少 6 个 it：

```ts
it('SkillChildSubAgent.run yields progress event per driver action', ...)
it('SkillChildSubAgent.run yields paused event with pauseReason="budget" on budget exhaustion', ...)
it('SkillChildSubAgent.run yields paused event with pauseReason="recoverable" on recoverable_paused', ...)
it('SkillChildSubAgent.run returns state="completed" + terminalReason="completed" on driver completion', ...)
it('SkillChildSubAgent.run returns state="failed" + terminalReason="failed_subagent" on driver throw', ...)
it('createSkillChildSubAgentFromPersisted reconstructs SubAgent from durable payload (cross-process recovery)', ...)
```

### C7. A1 boundary teardown：3 件事必须 land

```bash
test ! -f scripts/check-a1-boundary.cjs               # 已删除
test ! -f scripts/__tests__/check-a1-boundary.test.cjs # 已删除
grep -q 'check-a1-boundary' package.json && exit 1 || exit 0  # verify:a1 引用已移除
grep -q 'no-subagent-leak.*skill-child' eslint-rules/index.mjs && exit 1 || exit 0  # rule path 限制移除
```

W5 worker 必须做这 3 件事，独立 commit（per A1 §8）。

### C8. `verify:a0` + `verify:a05` + 残留的 `verify:a1`（不含已删脚本部分）零回归

```bash
npm run verify:a0   # exit 0
npm run verify:a05  # exit 0
npm run verify:a1   # exit 0（W5 已重塑此 script，移除 a1-boundary check）
```

A1 §12 锁定的 SubAgent interface 字段集合 / event 形状 / yield 顺序合同**不变**；如有违反 → typecheck / lint:check 即报错。

### C9. 新增 `verify:b` script

```bash
npm run verify:b
```

串联：`typecheck → lint:check → baseline → a1-gate → subagent-isolation → check-skill-child-runner-api → Layer 1 contract suite → skill-child-* full suite → skill-child-subagent / skill-child-abort-tree / skill-child-cleanup-registry → verify:a0 → verify:a05 → verify:a1`。

---

## 2. Out-of-scope（明确不做，留给后续阶段）

按原则 4（形态意识），下列项**不**在 B：

| 项 | 为什么不做 | 留给哪个阶段 |
|---|---|---|
| `RunCleanupRegistry` 在整个 agent-control 模块的全面统一 | B 仅做 child runtime 内部统一；turn-engine 的 longSkillHeartbeat / sidecar timer 等独立子系统先不动 | **D**（reminder + cleanup hardening） |
| 移除 `recentCloses` LRU 64 ring buffer | 性能优化，不属于架构层；recentCloses 仍由 SkillChildRunner orchestrator 持有 | **G**（次生债） |
| `DetachedSkillTaskTracker` 迁移到 SubAgent | 它是另一个 runner 类型（非 child run），B 不动 | **B-prime / 后续** |
| 新增 SubAgent driver（RSS、browser 等） | B 仅迁移 **VEA** 一个 driver，证明 SubAgent 形态可承载真实长任务 | **B-prime** |
| Coordinator role / system prompt 优先级链 | C 阶段范围 | **C** |
| Hook system / 分层 compaction | D 阶段范围 | **D** |
| `SubAgent` interface 修改（即使想加字段） | A1 §12 已锁定 | **新 plan + counter-proposal** |
| AbortSignal.any() 在 `ToolRuntimeContext` 全面引入 | tool-runtime 的 abort 树独立子任务 | **B-prime / D** |
| `SkillChildDriver` 接口形态变更 | 现有 driver 接口被 SubAgent 实现内部消费，但接口本身不动 | **B-prime** |
| 把 `inDriverDepth` 计数器改为 SubAgent metadata | 嵌套 child 防御机制保留在 orchestrator，不下沉 | **G** |

---

## 3. Architecture Decisions（先于任务划分）

### D1. SkillChildRunner 是 orchestrator，SkillChildSubAgent 是 execution unit

明确职责切分：

| 职责 | 归属 |
|---|---|
| `active: Map<string, ActiveRun>` 维护 | SkillChildRunner（orchestrator） |
| `recentCloses` LRU cache | SkillChildRunner |
| `inDriverDepth` 计数器 | SkillChildRunner |
| 单飞 / reconcile / 持久化（DB row） | SkillChildRunner |
| `launchStuckTimer` 启动 + 触发 abort | SkillChildRunner（但 timer 自身注册到 SubAgent.cleanup） |
| `planNextAction` / `observeAfterAction` 循环 | SkillChildSubAgent（execution unit） |
| `SubAgent.run` generator 实现 | SkillChildSubAgent |
| 终态映射（driver action → SubAgentRunResult） | SkillChildSubAgent |
| AbortController 链接父子 | SkillChildSubAgent factory（接收 parent signal） |

`SkillChildRunner` 不消失；它的 `runLoop` 内部从"手工 driver 循环"换成"`for await of runSubAgent(...)`"。

### D2. SkillChildSubAgent 字段映射

```typescript
function createSkillChildSubAgent(params: {
  childRunId: string                  // → lifecycleId AND durableRunId（resume 复用同 id）
  outputDir: string                   // → artifactDir（跨 lifecycle 复用）
  driver: SkillChildDriver
  initialState: SkillChildDriverState
  parentScopeId: string | null
  parentSessionId: string | null
}): SkillChildSubAgent {
  return {
    lifecycleId: params.childRunId,
    durableRunId: params.childRunId,
    subagentName: 'SkillChildSubAgent',
    artifactDir: params.outputDir,
    async *run(context: SubAgentContext): AsyncGenerator<...> {
      // 内部驱动 driver.planNextAction / observeAfterAction
    },
  }
}
```

`lifecycleId === durableRunId === childRunId` 是 Layer 1 invariant：resume 必须复用同一 `childRunId`。这与 A1 §3.D2 "lifecycle id ≠ artifact dir" 不矛盾——A1 强调的是 `lifecycleId` 与 `artifactDir` 是两个独立合同（不是同一个 ID 担两份职责），不是说 `lifecycleId` 必须每次 resume 重生。

### D3. AbortController 树：TurnEngineSession 是父，SkillChildSubAgent 是子

```typescript
// SkillChildRunner.beginRunLoop（内部）
const childController = new AbortController()
const parentSignal = config.repository.getSessionAbortSignal(scopeId, sessionId)  
//                     ^ 新增 repository 方法（D5），返回当前 session 的 AbortSignal
if (parentSignal) {
  // Parent abort cascades to child
  if (parentSignal.aborted) {
    childController.abort(new Error('parent session aborted'))
  } else {
    parentSignal.addEventListener('abort', () => {
      childController.abort(new Error('parent session aborted'))
    }, { once: true })
  }
}
const subagent = createSkillChildSubAgent({ childRunId, outputDir, driver, initialState, ... })
const cleanup = createSubAgentCleanupHandle(childRunId)
const context: SubAgentContext = {
  abortSignal: childController.signal,
  cleanup,
  parentScopeId: scopeId,
  parentSessionId: sessionId,
}
```

注意：
- 父 → 子是单向 cascade。子 abort **不**回传父（C4 第二条 contract test 验证）。
- 父 signal 来源是 `TurnEngineSession.abortController.signal`（vestigial field 升格为 load-bearing）
- 不用 `AbortSignal.any([parent, child])` 因为 Node 18 的 polyfill 不一致；用经典 listener pattern

### D4. cleanup registry：launchStuckTimer / driver listeners 全部走 register

`SkillChildRunner.beginRunLoop` 启动 launchStuckTimer 的代码：

**之前**（手工管理）：
```typescript
const timer = setTimeout(() => active.controller.abort(...), 30000)
timer.unref()
// 没有显式 clearTimeout —— 依赖 timer.unref() + Node GC
```

**之后**（cleanup register）：
```typescript
const timer = setTimeout(() => active.controller.abort(...), 30000)
timer.unref()
cleanup.register(() => clearTimeout(timer))  // ← runSubAgent 的 cleanup.drain() 自动调用
```

效果：finalize / abort / throw 任何路径下 timer 都会被清掉，不依赖 unref + GC。

### D5. `getSessionAbortSignal` 是 SkillTaskRunRepository 新增的查询方法

为了让 SkillChildRunner 拿到父 AbortSignal 但不直接依赖 turn-engine 的 session 状态，repository 层新增：

```typescript
interface SkillTaskRunRepository {
  // ... existing methods ...
  getSessionAbortSignal(scopeId: string | null, sessionId: string | null): AbortSignal | null
}
```

实现：
- 生产环境由 `AgentControlRuntime` 注入实现，runtime 维护 `Map<sessionId, AbortController>` 并在 session lifecycle 入口 / 出口处 set / delete
- 测试环境用 stub，支持显式 `repo.setSessionAbortSignal(scopeId, sessionId, controller)` 测试方法

为什么放 repository：
- 与现有 `findLatestChildRunByKey` 等 session-scope 查询共置（语义对齐）
- 避免 SkillChildRunner 直接 import turn-engine（违反单向依赖）
- B 之后此接口可移到更合适的位置（如 SessionRegistry 模块）—— 现在不动

### D6. Migration 是 Ship of Theseus，不走 feature flag

见 §0.4。

实操上：
- W2 PR：内部替换 runLoop 实现，SubAgent 一旦集成 = 默认生效
- 没有 `if (USE_SUBAGENT)` 分支
- 失败模式 = Layer 1 五条 contract 测试中**至少一条**红，PR 不能 merge
- Production 验证：合并后跑 dev mode 烟测（v3 §5.4 步骤），观察 VEA 启动 / 暂停 / 继续 / 完成全链路绿

### D7. 文件布局

新建：
```
src/main/modules/agent-control/
  skill-child-sub-agent.ts                # SubAgent 特化实现
  skill-child-sub-agent-factory.ts        # createSkillChildSubAgent + createSkillChildSubAgentFromPersisted
  skill-child-sub-agent-close-mapping.ts  # F1 terminal mapping
  skill-child-sub-agent-events.ts         # F3 progress payload
  link-parent-abort.ts                    # F4 parent abort explicit unlink

src/__tests__/
  skill-child-subagent.test.ts            # C6 合同
  skill-child-abort-tree.test.ts          # C4 合同
  skill-child-cleanup-registry.test.ts    # C5 合同

scripts/
  check-skill-child-runner-api.cjs        # C1 API snapshot 校验
  snapshots/
    skill-child-runner-api.snapshot.json  # W0 freeze
```

修改：
```
src/main/modules/agent-control/
  skill-child-runner.ts          # 内部 runLoop 切换到 runSubAgent；保持公共 API
  run-contracts.ts               # TurnEngineSession.abortController 升格为 load-bearing
  runtime.ts                     # 共享 repository + register/unregister session abort
  
src/main/modules/claude-bridge/direct-chat.ts  # DirectChat 注册/注销 session abort controller

src/main/modules/repositories/skill-task-run-repository.ts  # 新增 session abort signal registry

eslint-rules/
  index.mjs                      # W0b 已开放 child runner 必需例外

package.json                     # +verify:b script；verify:a1 已在 W0b 重塑

scripts/                         # W0a 已新增 API checker，W0b 已删除 check-a1-boundary

docs/superpowers/plans/2026-04-30-skill-runtime-agent-layer-reframe.md  # §5.1 B 行 [x]
```

---

## 4. Worker 划分（6 队，串行 + 局部并行）

```
W0 (Plan/Snapshot) ──> W1 (SubAgent factory) ──┬──> W2 (Internal migration) ──┐
                                                │                                │
                                                └──> W3 (Abort tree) ────────────┴──> W4 (Cleanup) ──> W5 (A1 teardown + verify:b)
```

W0 必先 land；W1 land 后 W2/W3/W4 可顺序串行；W5 是 closure。

### W0 — Plan / API Snapshot Owner

**Owner agent type**: general-purpose

**目标**：
- `docs/superpowers/plans/2026-04-30-B-child-runtime-subagent-migration-implementation.md`（本文件）staged 入 git
- `scripts/snapshots/skill-child-runner-api.snapshot.json` 写入冻结的公共 API 签名
- 验证 `B_BASE = 9fe87039e4e62c020243560e821ed6bac4358c2e` (A1 commit)

**改动清单**：

1. plan 文件加 git tracking。
2. 新建 `scripts/snapshots/skill-child-runner-api.snapshot.json`，内容：
   ```json
   {
     "version": 1,
     "frozenAt": "B-stage W0 (2026-XX-XX)",
     "exports": [
       {
         "name": "startSkillChildRun",
         "signature": "(params: StartSkillChildRunParams) => Promise<StartSkillChildRunResult>"
       },
       {"name": "resumeSkillChildRun", "signature": "(childRunId: string) => Promise<StartSkillChildRunResult>"},
       {"name": "cancelSkillChildRun", "signature": "(childRunId: string, reason?: string) => Promise<SkillChildCloseEvent>"},
       {"name": "getSkillChildRunCloseEvent", "signature": "(childRunId: string) => SkillChildCloseEvent | null"},
       {"name": "waitForSkillChildRunClose", "signature": "(childRunId: string, options: WaitForSkillChildRunCloseOptions) => Promise<ChildWaitResult>"},
       {"name": "configureSkillChildRunner", "signature": "(config: SkillChildRunnerConfig) => SkillChildRunner"},
       {"name": "__resetSkillChildRunnerForTests", "signature": "() => void"},
       {"name": "isChildOwnedSkill", "signature": "(skillId: string) => boolean"}
     ],
     "types": [
       "StartSkillChildRunParams", "StartSkillChildRunResult", "WaitForSkillChildRunCloseOptions", "SkillChildRunnerConfig"
     ]
   }
   ```
3. 验证 `git rev-parse HEAD === 9fe8703...`，否则停工 + 重锁 base。

**不**改任何代码、测试、ESLint 配置。

**完成判据**：
- plan 与 snapshot 成为 commit 的一部分
- `git log -1 --format=%H` matches `9fe87039e4e62c020243560e821ed6bac4358c2e` 之上的下一个 commit
- 后续 worker 都从此 commit 起步

---

### W1 — SkillChildSubAgent factory

**Owner agent type**: general-purpose

**目标文件**（**全部新增**）：
- `src/main/modules/agent-control/skill-child-sub-agent.ts`
- `src/main/modules/agent-control/skill-child-sub-agent-factory.ts`
- `src/main/modules/agent-control/skill-child-sub-agent-close-mapping.ts`
- `src/main/modules/agent-control/skill-child-sub-agent-events.ts`
- `src/__tests__/skill-child-subagent.test.ts`

**改动清单**：

1. **`skill-child-sub-agent.ts`**: 实现 `SubAgent` 接口的 SkillChild 特化：

   ```typescript
   export interface SkillChildSubAgentParams {
     readonly childRunId: string
     readonly outputDir: string
     readonly driver: SkillChildDriver
     readonly initialState: SkillChildDriverState
     readonly executeAction: (
       action: SkillChildDriverAction,
       state: SkillChildDriverState,
     ) => Promise<SkillRunResult>
     readonly parentScopeId: string | null
     readonly parentSessionId: string | null
     readonly maxActions?: number  // 默认 24
   }

   export function createSkillChildSubAgent(params: SkillChildSubAgentParams): SubAgent
   ```

   `subagent.run(context)` 内部循环：
   - 每次 `driver.planNextAction(state)` 前 check `context.abortSignal.aborted`
   - 如果 driver 返回 action：调用注入的 `executeAction(action, state)` → `driver.observeAfterAction(state, result)` → yield `progress` event
   - 如果 driver 返回 closeEvent（terminal）：return SubAgentRunResult { state, terminalReason, framePatch, projectionPatch, error, ... }
   - 如果 budget 耗尽：return { state: 'blocked', terminalReason: 'checkpoint_budget' }（or yield paused budget then return）
   - 如果 driver throw：让异常上抛（runSubAgent 包成 failed terminal）

   **F2 execution 注入合同**：`executeAction` 是 `SkillChildSubAgentParams` 字段，不是 `SubAgent` 公共接口字段；runner orchestrator 注入 closure 捕获 `SkillsRuntimeManager`。测试可注入 stub，SubAgent 只负责 driver loop。

   **F3 progress payload 合同**：`skill-child-sub-agent-events.ts` 定义三种 typed payload：
   - `action_started`: `{ kind, actionName, actionInput, actionIndex }`，`actionIndex` 为 1-indexed。
   - `action_completed`: `{ kind, actionName, success, durationMs }`。
   - `state_observed`: `{ kind, stage, fingerprint }`。
   runner 只用 type narrowing 把 payload 写入 child JSONL，不再由 SubAgent 直接写 runner log。

3. **`skill-child-sub-agent-close-mapping.ts`**：实现纯函数 `mapSubAgentCloseToChildClose(subAgentClose, runtimeContext)`，无副作用。

   **F1 terminal mapping 合同**：
   - completed/completed → completed/completed。
   - cancelled/aborted → killed/cancelled_user（用户 cancel）或 killed/process_restarted（父 session abort），由 runner runtime context 标记决定。
   - failed/failed_subagent → failed_skill、child_process_crashed、launch_stuck、input_validation、host_unavailable，按 error.kind 与 runtime context 分流。
   - failed/persistence_failed → failed/persistence_failed。
   - blocked/checkpoint_budget → budget_paused/checkpoint_budget。
   - blocked/checkpoint_background → budget_paused/checkpoint_background。
   - blocked/blocked_external → blocked/blocked_external。
   - blocked/blocked_config → blocked/blocked_config。
   runtime context 必须由 runner 持有 `isUserCancel / isParentSessionAbort / isLaunchStuckFired`，SubAgent 自己不推断这些来源。

4. **`skill-child-sub-agent-factory.ts`**: 实现工厂函数：

   ```typescript
   export function createSkillChildSubAgent(params: SkillChildSubAgentParams): SubAgent
   export function createSkillChildSubAgentFromPersisted(persisted: SkillChildRunPayload, driver: SkillChildDriver): SubAgent
   ```

   `createSkillChildSubAgentFromPersisted` 的实现：
   - 从 persisted payload 重建 `initialState`（调 `driver.canResume(...)` + 用 driver 的 resume hook 重建）
   - 注意：A1 §F2 删了 `restoreFrom`，用 factory 替代——不复活该接口
   - 如果 driver.canResume 返回 false → 抛 error（caller 走 markRowProcessRestarted 路径）

3. **`skill-child-subagent.test.ts`**: 写 6 个 it 满足 C6 合同。
   - 用 stub `SkillChildDriver`（同 `skill-child-runner.test.ts` 的 fakeDriver 模式）
   - 不接 SkillChildRunner——纯粹验证 SubAgent 实现的合同
   - 测试断言用真行为：`for await (const event of runSubAgent(subagent, ctx))`，断言 event 序列

**禁止**：
- 不 import `skill-child-runner.ts` 的内部状态（active map / recentCloses）
- 不 import `turn-engine.ts`
- 测试不写 `readFileSync` source-grep
- 不创建 `__forTesting_xxx` seam 在 SubAgent 接口上（A1 §12 锁定）

**完成判据**：
- 6 个 it 全绿
- isolation: `node scripts/check-subagent-isolation.cjs` 退出 0
- typecheck + lint:check 0 errors

---

### W2 — SkillChildRunner 内部迁移

**Owner agent type**: general-purpose

**目标文件**：
- `src/main/modules/agent-control/skill-child-runner.ts`（修改 internal `runLoop` / `beginRunLoop`，不动公共 API）

**改动清单**：

1. **替换 `runLoop` 内部实现**（line ~819 起）：

   **之前**：手工 `while (true)` 循环调 `driver.planNextAction → driver.observeAfterAction`

   **之后**：
   ```typescript
   const subagent = createSkillChildSubAgent({
     childRunId: active.childRunId,
     outputDir: active.outputDir,
     driver,
     initialState,
     parentScopeId: params.scopeId,
     parentSessionId: params.sessionId,
     maxActions: this.config.maxActionsPerRun,
   })
   const cleanup = createSubAgentCleanupHandle(active.childRunId)
   const context: SubAgentContext = {
     abortSignal: active.controller.signal,
     cleanup,
     parentScopeId: params.scopeId,
     parentSessionId: params.sessionId,
   }
   
   try {
     for await (const event of runSubAgent(subagent, context)) {
       if (event.type === 'started') continue  // orchestrator 不关心 started
       if (event.type === 'progress') {
         // 持久化 action_started / action_completed 到 JSONL
         await this.appendActionLogFromProgress(active, event)
         continue
       }
       if (event.type === 'paused') {
         // budget / recoverable_paused → 写 row 状态
         await this.persistPauseFromEvent(active, event)
         continue
       }
       if (event.type === 'terminal') {
         await this.finalizeRun(active, event.closeEvent)
         break
       }
     }
   } catch (err) {
     // runSubAgent 不应该抛——它包了所有 throw 成 terminal event
     // 如果到这里，说明 cleanup.drain() 之外的事情坏了，按 infra error 处理
     await this.finalizeRun(active, mapDriverThrowToCloseEvent(active, err))
   }
   ```

2. **`finalizeRun` 的 identity guard 不动**（line 1098-1100，A1 修复）。

3. **`prepareResumeLifecycle` 不动**（line 655-669，B6 修复）。

4. **`recentCloses` LRU cache 保留**（line 169 + 1122-1127）。

5. **`inDriverDepth` 保留**（line 166），但不下沉到 SubAgent。

6. **公共 API 5 个 module-level export 100% 不动**（C1 验证）。

**关键约束**：
- 不修改任何测试文件
- 不修改 turn-engine.ts、skills-tools.ts、runtime-manager.ts、video-expert-child-driver.ts
- 内部 helper 函数（`appendActionLogFromProgress` 等）可新增

**完成判据**：
- 全部 skill-child-* 测试套件绿（C2/C3）
- `check-skill-child-runner-api.cjs` 退出 0（C1）
- typecheck + lint:check 0 errors

---

### W3 — AbortController 树

**Owner agent type**: general-purpose

**目标文件**：
- `src/main/modules/agent-control/run-contracts.ts`（保留 `TurnEngineSession.abortController` 字段，**新增**注释说明此字段现在是 load-bearing）
- `src/main/modules/repositories/skill-task-run-repository.ts`（新增 session abort signal registry）
- `src/main/modules/agent-control/runtime.ts`（共享 repository 实例，并暴露 register/unregister 入口）
- `src/main/modules/claude-bridge/direct-chat.ts`（DirectChat 持有 abort controller，负责注册/注销）
- `src/main/modules/agent-control/link-parent-abort.ts`（**新增**，F4 显式 unlink helper）
- `src/main/modules/agent-control/skill-child-runner.ts`（`beginRunLoop` 接父 signal，linkParent → child）
- `src/__tests__/skill-child-abort-tree.test.ts`（**新增**，C4 合同）

**改动清单**：

1. **`run-contracts.ts`**: `TurnEngineSession.abortController` 字段加块注释：
   > **B-stage**: this field is now load-bearing. Aborting it cascades to in-flight `SkillChildSubAgent` instances via `SkillTaskRunRepository.getSessionAbortSignal()`. See `docs/superpowers/plans/2026-04-30-B-child-runtime-subagent-migration-implementation.md` §3 D3.

2. **`skill-task-run-repository.ts`**: 新增方法 + 内部 Map：
   ```typescript
   private sessionAbortSources = new Map<string, AbortController>()
   
   registerSessionAbortController(scopeId: string | null, sessionId: string | null, controller: AbortController): void
   unregisterSessionAbortController(scopeId: string | null, sessionId: string | null, controller?: AbortController): void
   getSessionAbortSignal(scopeId: string | null, sessionId: string | null): AbortSignal | null
   ```
   key = `${scopeId ?? '_'}|${sessionId ?? '_'}`。注销时如果传入 controller，必须做 identity check，避免旧 finally 清掉新 controller。

3. **`runtime.ts`**: 使用一个共享 `SkillTaskRunRepository` 实例配置 child runner，并暴露 register/unregister 入口。不要改 `turn-engine.execute()` 主循环。

4. **`direct-chat.ts`**: DirectChat 创建/持有 session abort controller 后调用 runtime register；finally 中调用 unregister。DirectChat 是真实 abort controller owner，Runtime 不接管生命周期。

5. **`link-parent-abort.ts`**：新增显式 unlink helper：

   ```typescript
   export interface ParentAbortLink {
     readonly childSignal: AbortSignal
     readonly dispose: () => void
   }

   export function linkParentAbort(
     parent: AbortSignal | null,
     childController: AbortController,
   ): ParentAbortLink
   ```

   **F4 listener 合同**：如果 parent 已 abort，同步 abort child 并返回 no-op dispose；如果 parent 未 abort，注册 `{ once: true }` listener，同时返回 `dispose()` 显式 `removeEventListener`。child 正常结束、child 自己 cancel、父 abort 三条路径都必须经 cleanup drain 调用 dispose，避免长寿父 signal 上 listener 泄漏。

6. **`skill-child-runner.ts`** `beginRunLoop`: 启动 SubAgent 前 query parent signal，`const link = linkParentAbort(parentSignal, active.controller)`，并 `cleanup.register(() => link.dispose())`。

7. **`skill-child-abort-tree.test.ts`** 写 4 个 it（C4 合同），其中第 4 个必须覆盖：`parent listener is removed when child terminates normally (no listener leak on long-lived parent signal)`。

**关键约束**：
- 父 → 子是单向 cascade
- 子 abort 不回传父
- listener 用 `{ once: true }` + cleanup dispose 显式 unlink 避免泄漏
- 重复 abort 父 → 子 listener 已 once，无副作用

**完成判据**：
- 4 个 abort-tree contract test 绿（C4）
- 既有 skill-child-* 测试套件零回归
- W2 的 internal migration 与 W3 的 abort tree 联动测试（W2 cancel 路径 + W3 父 abort 路径都能正确终止 child run）

---

### W4 — Cleanup Registry 统一（child runtime 内部）

**Owner agent type**: general-purpose

**目标文件**：
- `src/main/modules/agent-control/skill-child-runner.ts`（`launchStuckTimer` + 其他 timer / listener 走 `cleanup.register`）
- `src/main/modules/agent-control/skill-child-sub-agent.ts`（如果 SubAgent.run 内部有 timer，也走 register）
- `src/__tests__/skill-child-cleanup-registry.test.ts`（**新增**，C5 合同）

**改动清单**：

1. `launchStuckTimer` 启动后立即 `cleanup.register(() => clearTimeout(timer))`（per D4）
2. `skill-child-runner.ts` 中所有手工 `clearTimeout / setInterval / removeEventListener / controller.signal.removeEventListener` 调用清查；适合下沉到 cleanup 的全部下沉
3. 写 3 个 it（C5 合同）

**关键约束**：
- 不重构非 child-runtime 的 cleanup（B 范围只限 child runtime 内部）
- timer.unref() 保留——它是兜底，cleanup.register 是主路径

**完成判据**：
- 3 个 cleanup-registry contract test 绿（C5）
- grep `clearTimeout|clearInterval` in `skill-child-runner.ts` 总数 ≤ 1（仅允许 cleanup 自身的拆解逻辑）
- 既有 skill-child-* 测试套件零回归

---

### W5 — Acceptance closure + verify:b

**Owner agent type**: general-purpose

**目标文件**：
- `package.json`（新增 `verify:b`；`verify:a1` 已在 W0b 重塑）
- `docs/superpowers/plans/2026-04-30-skill-runtime-agent-layer-reframe.md`（§5.1 B 行 `[x] completed YYYY-MM-DD`）
- `docs/superpowers/plans/2026-04-30-B-child-runtime-subagent-migration-implementation.md`（§8 B Acceptance 段，commit 时填）

**改动清单**：

1. **新增 `verify:b` script**：

   ```json
   "verify:b": "npm run typecheck && npm run lint:check && node scripts/check-eslint-baseline.cjs && node scripts/check-eslint-baseline.cjs --area a1-gate --max 0 && node scripts/check-subagent-isolation.cjs && node scripts/check-skill-child-runner-api.cjs && npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/skill-child-*.test.ts src/__tests__/sub-agent-contract.test.ts src/__tests__/sub-agent-runner.test.ts && npm run test:a0:gates && npm run verify:a0 && npm run verify:a05 && npm run verify:a1"
   ```

2. **更新 v3 §5.1**：B 行 `[x] completed YYYY-MM-DD`，并在表后追加 §5.1.2 "C 阶段准入" 段：
   > **C（Coordinator 抽象）准入**：B 的 9 条 hard contract 全部 land，verify:b 退出码 0；child runtime 已是 SubAgent 特化（VEA SubAgent）。C 阶段开工 PR 必须把 turn-engine 内嵌的 mode switch 重构为 Coordinator role 注册。

3. **B Acceptance 段**（plan §8）：跑完 verify:b 后填写真实结果，包括退出码、关键测试条数、lint baseline 与最终 commit hash。
4. **dev 烟测**：VEA 启动、暂停继续、取消、重启恢复、resume flag 关闭 5 个手动烟测；不能用假输出填 acceptance。

**关键约束**：
- A1 boundary teardown 与 API checker 已前移到 W0a/W0b，W5 不再重复动这些文件
- verify:b 必须真跑过 + 全绿后才能 land

**完成判据**：
- `verify:b` 退出 0
- v3 §5.1 + plan §8 更新
- acceptance commit 落地

---

## 5. 端到端验证

每队 land 后跑（W5 land 前 verify:b 还没存在，跑 verify:a1 即可）：

```bash
# 1. 类型 + lint
npm run typecheck
npm run lint:check

# 2. 全部闸门（W5 land 后）
npm run verify:a0
npm run verify:a05
npm run verify:a1
npm run verify:b

# 3. Layer 1 五条 contract（必须 100% 绿）
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/skill-child-runner-resume-lifecycle.test.ts \
  src/__tests__/skill-child-runtime-decisions.test.ts \
  src/__tests__/skill-child-feature-flags.test.ts \
  src/__tests__/turn-engine-route.test.ts

# 4. 全套 skill-child-*（W2 land 后）
npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/skill-child-*.test.ts

# 5. B 新增 contract test（W4 land 后）
npx tsx@^4.19.2 --test src/__tests__/skill-child-subagent.test.ts \
  src/__tests__/skill-child-abort-tree.test.ts \
  src/__tests__/skill-child-cleanup-registry.test.ts

# 6. 公共 API 签名快照零差异
node scripts/check-skill-child-runner-api.cjs

# 7. 测试文件零修改（除 W4 新增的 3 个 contract test）
git diff <B_BASE>..HEAD -- src/__tests__/skill-child-*.test.ts \
  | grep -v "skill-child-subagent\|skill-child-abort-tree\|skill-child-cleanup-registry" \
  | wc -l
# 预期: 0

# 8. 现有 child-runner 文件 / turn-engine 文件 0 行测试改动
# 公共 API 0 改动（已在 W2 验证）

# 9. 手动 dev 烟测
# - 启动 dev mode
# - 触发 VEA skill 长任务
# - 暂停 → 输入"继续" → 完成（验证 resume 路径）
# - 启动 → 立即取消（验证 cancel 路径）
# - 启动 → 进程 kill -9 → 重启 → DB 行 status=recoverable_paused → 输入"继续" → 完成（验证 reconcile + resume 路径）
# - 设 READY_SKILL_CHILD_RESUME_ENABLED=0 → 暂停后输入"继续"应不进 resume（验证 B2 flag 仍生效）
```

---

## 6. 风险与缓解

### 6.1 Layer 1 contract 在 W2 内部迁移时破坏

**风险**：W2 替换 runLoop 时，identity guard / prepareResumeLifecycle / recentCloses 的某个细节走样，5 条 contract 任一红 → B 失败。

**缓解**：
- W2 worker 必须先跑 Layer 1 五条 contract test 确认绿底；改完每个增量 commit 都跑一次
- W2 land PR review 重点：**diff Layer 1 锁定的 5 个 line range（`finalizeRun:1098-1100` / `prepareResumeLifecycle:655-669` / `recentCloses` 各 access 点）必须保持等价语义**
- 出现回归 → revert，不 patch on patch

### 6.2 AbortController 树死锁 / 信号丢失

**风险**：父 abort listener 只 fire 一次（once: true），如果父 controller 在 SubAgent 启动前已 abort，cascade 不触发。

**缓解**：
- D3 实现已写入显式检查：`if (parentSignal.aborted) childController.abort(...)` 同步处理
- C4 contract test 第三条专门验证此 race：`it('cancelSkillChildRun resolves with status=killed when parent session aborts mid-flight', ...)` 包含 abort-before-spawn 与 abort-during-run 两个分支

### 6.3 `getSessionAbortSignal` 注入到 repository 是错位

**风险**：repository 是数据访问层，不该持 AbortController。语义上别扭。

**承认**：是的，这是临时位置。理由：
- B 不引入新的 SessionRegistry 模块（避免范围爆炸）
- 共置 `findLatestChildRunByKey` 等 session-scope 查询语义对齐
- §2 已声明这是 out-of-scope 的优化项，B-prime 或 D 阶段移到正确位置

W3 worker 实施时在方法上加 TODO 注释（**仅此一处允许 TODO**，因有显式后续阶段计划）：
```typescript
// TODO(B-prime): move to SessionRegistry module; repository should not hold AbortControllers
getSessionAbortSignal(scopeId, sessionId): AbortSignal | null { ... }
```
此 TODO 不被 `no-migration-todo` rule 捕获——它指向具体后续阶段，符合 A0 词汇 invariant 例外（W5 worker 验证 lint:check 不报错；如报错 → 用 `eslint-disable-next-line ready/no-migration-todo -- reviewed: B-prime relocation tracked in v3 §5.1`）。

### 6.4 工期失控

**风险**：B 计划工期 4-6 天，但 W2 内部迁移触及 Layer 1 临界区，调试可能拉长。

**缓解**：
- W0 ~0.5 天，W1 ~1.5 天，W2 ~2 天，W3 ~1 天，W4 ~0.5 天，W5 ~0.5 天，缓冲 ~1 天 = 7 天上限
- 如果 W2 卡住超 1 天 → 不强推；分析根因：是 SubAgent 接口表达力不够（→ 写新 plan 修 A1 §12 锁定）还是迁移机制有 bug（→ 继续修）
- 不允许跳过 W4 / W5 提前合并（C7 / C9 是 admission gate，跳过 = B 不算完成）

### 6.5 不走 feature flag 路径误判生产风险

**风险**：D6 决定不走 flag。如果生产挖出未覆盖回归，没有快速回退按钮。

**缓解**：
- `git revert <B-commits>` 是回退路径
- B 的所有 commit 必须满足 "可独立 revert" 原则：W1-W5 各 worker 的 commit 都可逆
- 如有 emergency，30 分钟内可以 cherry-pick revert + redeploy
- 监控信号：dev mode 烟测必须覆盖 §5 第 9 步全部场景；任一红 = B 不能 land

如果用户 / codex 拒绝此判断，临时加 emergency flag `READY_SKILL_CHILD_USE_LEGACY_RUNTIME`（默认 off）作为 30 天兜底，但 B 完成日（[x] commit）= 该 flag 删除日。

---

## 7. 关键文件路径速查

**新建**（W0 / W1 / W3 / W4 / W5）：
- `docs/superpowers/plans/2026-04-30-B-child-runtime-subagent-migration-implementation.md`（W0，本文件）
- `scripts/snapshots/skill-child-runner-api.snapshot.json`（W0）
- `scripts/check-skill-child-runner-api.cjs`（W0a）
- `src/main/modules/agent-control/skill-child-sub-agent.ts`（W1）
- `src/main/modules/agent-control/skill-child-sub-agent-factory.ts`（W1）
- `src/main/modules/agent-control/skill-child-sub-agent-close-mapping.ts`（W1）
- `src/main/modules/agent-control/skill-child-sub-agent-events.ts`（W1）
- `src/main/modules/agent-control/link-parent-abort.ts`（W3）
- `src/__tests__/skill-child-subagent.test.ts`（W1）
- `src/__tests__/skill-child-abort-tree.test.ts`（W3）
- `src/__tests__/skill-child-cleanup-registry.test.ts`（W4）

**修改**：
- `src/main/modules/agent-control/skill-child-runner.ts`（W2 / W4）
- `src/main/modules/agent-control/run-contracts.ts`（W3，加注释）
- `src/main/modules/agent-control/runtime.ts`（W3，共享 repository + session abort 注册入口）
- `src/main/modules/claude-bridge/direct-chat.ts`（W3，注册/注销 DirectChat abort controller）
- `src/main/modules/repositories/skill-task-run-repository.ts`（W3，新方法）
- `eslint-rules/index.mjs`（W0b，no-subagent-leak path 调整）
- `package.json`（W0b/W5，verify:a1 已重塑；W5 加 verify:b）
- `docs/superpowers/plans/2026-04-30-skill-runtime-agent-layer-reframe.md`（W5，§5.1 B 行 + §5.1.2 C 准入）

**删除**（W0b）：
- `scripts/check-a1-boundary.cjs`
- `scripts/__tests__/check-a1-boundary.test.cjs`

**严禁修改**（C2/C3 验证）：
- `src/__tests__/skill-child-runner-resume-lifecycle.test.ts`
- `src/__tests__/skill-child-runtime-decisions.test.ts`
- `src/__tests__/skill-child-feature-flags.test.ts`
- `src/__tests__/turn-engine-route.test.ts`
- `src/__tests__/skill-child-runner.test.ts`
- `src/__tests__/skill-child-run-end-to-end.test.ts`
- `src/__tests__/skill-child-runtime-decisions.test.ts`
- `src/__tests__/skill-child-run-migration.test.ts`
- `src/__tests__/skill-child-state-machine.test.ts`
- `src/__tests__/skill-child-run-log.test.ts`
- `src/__tests__/skill-child-run-id.test.ts`
- `src/__tests__/skill-child-single-flight.test.ts`

---

## 8. B Acceptance — Recorded 2026-05-01

```markdown
- C1 ✅ — check-skill-child-runner-api.cjs exit 0；公共 API 5 个签名 snapshot 完全 match（verify:b 内与 W4 post-land 均验证）
- C2 ✅ — Layer 1 contract 全绿：test:a0:gates 42 pass；sub-agent contract/runner 8 pass；a1-gate current entries = 0
- C3 ✅ — 全部 skill-child-* 测试套件绿：114 pass / 0 fail；既有测试文件未为通过而改写或 skip
- C4 ✅ — skill-child-abort-tree.test.ts 4 it 全绿
- C5 ✅ — skill-child-cleanup-registry.test.ts 3 it 全绿；skill-child-runner.ts 内 clearTimeout/clearInterval 出现次数 = 1
- C6 ✅ — skill-child-subagent.test.ts 14 it 全绿（含 F1 terminal mapping / F2 executeAction 注入 / F3 progress payload）
- C7 ✅ — scripts/check-a1-boundary.cjs 已在 W0b 删除；no-subagent-leak path 限制已开放最小例外；verify:a1 已重塑
- C8 ✅ — verify:a0 / verify:a05 / verify:a1 全绿；lint:check 0 errors / 537 existing warnings；A0 ESLint baseline = 143 entries
- C9 ✅ — npm run verify:b 退出码 0；main-process VEA smoke 43 pass / 0 fail，覆盖启动、暂停继续、取消、重启恢复、resume flag off

已验证实现 tip：fdf73f1（W4）；W5 acceptance commit 在本段落提交后由 git history 记录。

**B 阶段（Child Runtime → SubAgent 特化）admission gate 现已关闭。C 阶段（Coordinator 抽象）admission gate 现已打开。**

第一个 C 阶段 PR 启动时：
1. 写 plan `2026-XX-XX-C-coordinator-abstraction-implementation.md`
2. 在该 plan 引用本 plan commit hash
3. turn-engine 内嵌的 mode switch（browser / document / skill / RSS 等产品分支）抽出为 Coordinator role 注册机制
```

---

## 9. 与战略原则的对应

| 原则 | B 体现 |
|---|---|
| 1. 先合同后代码 | §1 列出 9 条 hard contract，CI 可机器验证（含 API snapshot、abort tree、cleanup registry 三个新增 contract test 文件） |
| 2. 修根因不修症状 | 不 patch 现有 SkillChildRunner；从 root cause 0（缺 SubAgent 抽象）迁移内核。Layer 1 的 5 个 fix 都是同一根因的不同投影，B 完成后这个根因被消解 |
| 3. 拒绝 legacy 兼容分支 | §0.4 D6 明令不走 feature flag。Ship of Theseus migration，无 `if (USE_SUBAGENT) { ... } else { ... }` 分支 |
| 4. 形态意识 | §0.3 §4 形态约束兑现：`lifecycleId === childRunId`（resume 复用，per Layer 1 invariant）、`artifactDir === outputDir`（跨 lifecycle 复用）、AbortController 树**单向 cascade**（不抄 CC-Source 的双向 propagation）、不复活 A1 删掉的 `restoreFrom` |
| 5. CI 强制 > 文档约束 > 人审 | 9 条 contract 全部 CI 强制；`check-skill-child-runner-api.cjs` 自动 snapshot diff；测试 diff 检查 + 文件路径 git diff 检查；`no-migration-todo` rule 防止 W3 的临时 TODO 永久化 |

---

## 10. 完成判据汇总

| 队 | 完成判据 |
|---|---|
| W0 | plan + snapshot tracked into git；B_BASE 验证 |
| W1 | skill-child-subagent.test.ts 6 it 全绿；isolation 退出 0 |
| W2 | Layer 1 5 条 contract test 全绿；公共 API snapshot match；既有 skill-child-* 测试套件全绿 |
| W3 | skill-child-abort-tree.test.ts 4 it 全绿；既有测试零回归 |
| W4 | skill-child-cleanup-registry.test.ts 3 it 全绿；clearTimeout/clearInterval 计数 ≤ 1 |
| W5 | verify:b 退出 0；v3 §5.1 + plan §8 更新；acceptance 填真实输出和 commit hash |
| 集成 | 全套 skill-child-* + sub-agent-* 测试全绿；公共 API 0 改动；Layer 1 测试文件 diff 0 行；dev mode 烟测 5 场景全绿 |

---

## 11. Codex 执行注意

1. **Layer 1 神圣不可侵犯**：W2 内部迁移触及 `finalizeRun` / `prepareResumeLifecycle` / `recentCloses` 时，对照 Explore 报告的 line range 验证语义等价。每 commit 跑 5 条 contract test。
2. **公共 API 5 签名 100% 不动**：W2 不允许借机"顺手优化"签名（如把 `reason?: string` 改 `reason: string`、把 `Promise<void>` 改 `Promise<undefined>` 等）。snapshot diff 不容忍。
3. **测试文件不得改、不得 skip、不得 .only**：W2/W3/W4 worker 出现"测试不过"念头时，第一反应是"我的实现有 bug"，不是"测试该改"。如果真有合理的测试调整需求 → ESCALATE，写新 plan 走 counter-proposal。
4. **不复活 `restoreFrom` hook**：A1 §F2 删掉了它，B 的 `createSkillChildSubAgentFromPersisted` 是 factory function 不是 hook。如果你觉得 hook 比 factory 更顺手 → 不行，A1 §12 锁定。
5. **不动 turn-engine.execute() 主循环**：W3 在 turn-engine 入口处的改动只是把 session.abortController 注入到 request；不重构 execute() 内的任何 phase（A1 §11 已禁）。
6. **W5 是 closure 不是补丁**：A1 boundary teardown 必须独立 commit。如果偷懒把它和 W2/W3/W4 混进同一 PR → review 会要求拆。
7. **dev 烟测不可省**：§5 第 9 步 5 场景必须真跑过；如果烟测失败 → B 不能 land。

---

## 12. 与未来阶段（C/D/E）的接口锁定

B land 后，下列接口对未来阶段视为锁定（修改需新 plan + counter-proposal）：

- `SubAgent` interface（A1 §12 已锁定，B 不动）
- `SkillChildSubAgent` factory 签名（W1 写入）
- `SkillTaskRunRepository.getSessionAbortSignal` 签名（W3 写入；位置未来可改但签名不变）
- AbortController 父子 cascade 单向语义（D3）
- SkillChildRunner 公共 API 5 个 export 签名（C1 snapshot 永久 freeze）

允许扩展（无须新 plan）：
- 新增 `SkillChildDriver` 实现（仅一个 driver = VEA，未来 RSS / browser 也按 SubAgent 形态接入）
- `SkillChildSubAgentParams` 新增 optional 字段
- `verify:b` 内部步骤增减（保持 9 条 contract 即可）

不允许扩展（需 plan）：
- 新增 SkillChildRunner module-level export
- 修改 active map / recentCloses 语义
- 修改 Layer 1 五个 fix 的 line range 行为
- 复活 feature flag for migration（即使加 emergency 也需 plan 写明删除日）

---

> 本 plan 是 v3 路线 B 阶段的唯一权威实施依据。任何与本 plan 冲突的实现细节，以本 plan 为准；plan 本身需要修改时，写 counter-proposal + 新 plan。
