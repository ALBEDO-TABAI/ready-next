---
name: G — 提质（N1-N4 残债 + O7 用户控制面收口）
description: v3 路线 G 阶段实施计划。把 Layer 1 修完后产生的 4 项次生债（N1 status 字面量散落 / N2 resume 清状态语义切两半 / N3 close event 没有 mutability 约束 / N4 flag 中途切换的测试空白）+ O7（child run UI control surface）一次收口。本阶段是 v3 收尾，G 完成后 6 大根因 + 8 项盲点全部交付。
status: completed
enforce: false
counter_proposal: 2026-04-30-skill-runtime-agent-layer-reframe.md
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# G — 提质（实施计划）

> **范围**：把 `residual-debt §2`（N1-N4 次生债，N5 已在 A0 词汇 invariant 修复时附带处理）+ §3 O7（child run UI control surface）一次收口。这是 v3 §5.1 路线里"G — 提质"的全部内容；G 完成后，v3 路线全部交付。
>
> **G 完成 = 5 件事**：
> 1. **N1 status 字面量单一来源**：`TERMINAL_CHILD_CLOSE_STATUSES` + `isTerminalChildCloseStatus` 集中到 `skill-child-run-types.ts`；`turn-engine.ts` 与 `turn-frame-steering.ts` 的副本删掉。所有"close.status === 'completed' / 'failed' / 'killed'"散点改用 helper。新加 close.status 时只需扩 union 一处，不再追散点。
> 2. **N2 resume 清状态语义合一**：`resumeSkillChildRun` 返回 `{ runHandle, freshContractFields: { childCloseEvent: null, childStatus: 'running', parentNextHint } }`；turn-engine resume 分支用 `Object.assign(contract, freshContractFields)`，不再手动赋值 `childCloseEvent = null`。
> 3. **N3 close event 不可变约束**：`SkillChildCloseEvent` 用 `DeepReadonly<>`；构造完后 `deepFreeze` 一次。CI 测试断言所有 awaiter 拿到的 close 是 `Object.isFrozen() === true`，且嵌套的 `error` / `progress` 字段也 frozen。
> 4. **N4 TurnFeatureFlags per-turn snapshot**：turn 入口处一次读所有 flag 到 immutable `TurnFeatureFlags` 对象，下游一律用对象字段而非函数。CI 测试断言"turn 中途修改 env var 不影响该 turn 行为"。
> 5. **O7 child run 用户控制面**：新增 IPC `agent:listActiveChildRuns` / `agent:cancelChildRun(childRunId)`；renderer 新增最小可用的 child run 列表 + 单点取消按钮；取消 metric 区分 `nlp` vs `ui_button` 来源。**Resume 仍走现有 task-level `agent.resumeRun`，不在 G 范围扩展**。
>
> **不在 G 范围**：
> - **TaskCard 内部"child run 子行"细分渲染** —— 当一个 task 拥有多个并发 child run 时的 UI 拆分，需要先做产品决策（是否暴露 child run 概念给最终用户），G 不预设。
> - **Resume via UI button by childRunId** —— 已有 `agent.resumeRun(scopeId, taskId)` 路径足以覆盖 95% 场景；以 childRunId 为身份的 resume 需要 turn-engine 协议改造，超 G 范围。
> - **Cross-session / cross-device admin view** —— "看其他用户的 child run" 是产品层决策，不属于本阶段。
> - **Pause / budget 进度可视化升级** —— UI 现有 `budget_paused` visual state 已能表达；细化是 UI 队选题。
> - **N5（`'failed_skill'` 借用）** —— A0 词汇 invariant 添加 `'resume_launch_failed'` 时已附带处理；G 仅做 audit 校验，无新代码。

---

## 0. Context

### 0.1 为什么现在做

A0 / A1 / B / C / D / E / F 把"agent 层结构 + 防爆 + 测试规约"立完后，剩下两类残债：

- **N1-N4 是 Layer 1 的"修完之后才浮现"的次生债**：每条都不是 bug，但每条都是"未来某个 PR 会摔进去的坑"。N1 的状态字面量散落在新 close.status 出现时炸 N 个 `assert.equal(status, ...)`；N2 的清状态分两半在新增第三个 close 副本时漏清；N3 的 mutability 在某 awaiter 误 mutate 时连锁污染；N4 的 flag 多次读在新增中途读点时静默行为分裂。**收掉这 4 条让 v3 真正落地的"形态意识"原则不出现"留尾巴"现象**。
- **O7 是用户掌控权的隐性受限**：当前 child run 的 cancel/resume **只能通过 NLP 识别**（"取消"/"继续"等中文短语）。NLP 召回率不是 100%，错过识别等于丢失控制。**对面向产品用户的功能而言这是体验级缺陷；对 RSS 自动化 / 长任务多并发场景是真隐性事故源**。

G 不修任何 bug，但**把"v3 改完之后还有什么会炸"的小颗粒度风险一次性归零**。这是 v3 真正完成的标志。

### 0.2 Reconnaissance Facts（已实地核查）

**N1 状态字面量散点**（W0 audit：`docs/archive/2026-09-06/docs/superpowers/plans/2026-04-30-G-pre-flight-audit-report.md`）：

| 项 | 实测数量 | 命令 |
|---|---|---|
| `TERMINAL_CHILD_CLOSE_STATUSES` definitions | 2 | `rg "^const TERMINAL_CHILD_CLOSE_STATUSES" src/main/modules/agent-control` |
| `TERMINAL_CHILD_CLOSE_STATUSES` references | 4 | `rg "TERMINAL_CHILD_CLOSE_STATUSES" src/main/modules/agent-control` |
| close-status literal decision candidates | 16 | `rg "(close\|closeEvent\|live)\.status\s*(===\|!==)\s*['\"]\|childStatus\s*(===\|!==)\s*['\"]\|['\"](completed\|failed\|killed\|blocked\|recoverable_paused\|budget_paused)['\"]\s*(===\|!==)\s*(close\|closeEvent\|live)\.status" src/main/modules/agent-control src/main/modules/tools src/main/modules/rss-engine src/main/modules/skills-runtime` |

关键分类：

| 文件 | Line | 现状 / 处置 |
|---|---|---|
| `turn-engine.ts` | 316/337 | Set 副本 + `.has(live.status)`，W1 替换 |
| `turn-frame-steering.ts` | 296/307 | Set 副本 + `.has(close.status)`，W1 替换 |
| `turn-engine.ts` | 418-433 | `switch (close.status)`，保留为 outcome mapping 白名单 |
| `child-run-circuit-breaker.ts` | 92 | `close.status === 'failed'`，W1 替换为 helper / predicate |
| `skill-child-runner.ts` | 1158-1161 | retained lifecycle status 链式比较，W1 替换 |
| `skill-child-sub-agent.ts` | 220 | SubAgent reason mapping，白名单 |
| `turn-engine.ts` | 2517-2522 | parent terminal mapping，白名单 |
| `rss-engine/item-analysis-manager.ts` | 608/611/614 | RSS/VEA 产品错误分类，agent-control 外白名单 |
| `skills-runtime/runtime-manager.ts` | 2123/2137 | await helper `success` 兼容计算，agent-control 外白名单 |

helper 化收口对象 = Set 副本 + agent-control 内非白名单状态判定；直接赋值 / 传递不改。

**N2 resume 清状态分两半**（`grep -rn "prepareResumeLifecycle\|childCloseEvent.*null\|childCloseEvent =" src/main/modules/agent-control/`）：

| 位置 | 行为 |
|---|---|
| `skill-child-runner.ts:703-716` `prepareResumeLifecycle` private | `recentCloses.delete(id)` + `repository.updateChildRun({ status:'running', closeEvent: null })` |
| `turn-engine.ts:1580` | `turnFrame.skill.runContract.childCloseEvent = resumed.closeEvent ?? null` 手动赋值 |

→ "清旧 close" 分布在 runner 内部和 turn-engine 外部两处。N2 真实存在。

**N3 close event mutability**（`rg -n "Object\.freeze|DeepReadonly|Readonly<.*CloseEvent|freeze.*Close|Object\.isFrozen" src/main/modules/agent-control/skill-child-*.ts src/__tests__/skill-child-*.test.ts`）：

→ **零结果**。`SkillChildCloseEvent` 类型是普通 `interface`（`skill-child-run-types.ts:66`），构造时无 `Object.freeze`。N3 真实存在（合同上敞开，今天没人误用）。

**N3 close event 构造点**：

| 文件 | 构造点 | 是否 frozen |
|---|---|---|
| `skill-child-runner.ts` | local `makeCloseEvent` + 多处调用；`decodeStoredSkillChildCloseEvent` 读取返回 | 否 |
| `skill-child-sub-agent.ts` | local `makeCloseEvent`；driver close metadata 透传 | 否 |
| `skill-child-sub-agent-close-mapping.ts` | `makeMappedClose` + preserved metadata copy | 否 |
| `skill-child-state-machine.ts` | stored close decode/reconstruction | 否 |

**N4 flag 中途读**（`rg -n "isChildResumeEnabled|isChildInternalStrictAdmissionEnabled|isChildRunCircuitBreakerEnabled" src/main/modules src/shared src/preload src/renderer`）：

| 位置 | 现状 |
|---|---|
| `skill-child-feature-flags.ts:34` | `isChildResumeEnabled(env = process.env)` 每次调用读 env |
| `tool-definition.ts:63` | `isChildInternalStrictAdmissionEnabled(env = process.env)` 同形态 |
| `child-run-circuit-breaker.ts:95` | `isChildRunCircuitBreakerEnabled(value)` parser/helper |
| `turn-engine.ts:1535` | resume 分支调一次 `isChildResumeEnabled()` |
| `tool-executor.ts:116` | dispatch 准入调一次 `isChildInternalStrictAdmissionEnabled()` |
| `skill-child-runner.ts:200` | constructor 读 `READY_CHILD_RUN_CIRCUIT_BREAKER_ENABLED` |
| **未发现** turn 内多次调用同一 flag 的代码 | 但**没有任何机制阻止未来加** |

→ 今天没爆，但 invariant "同 turn 内 flag 必须一致" 没机制保护。W4 需要覆盖 `tool-executor.ts`；circuit breaker 若定义为 runner-lifetime flag，可不纳入 per-turn snapshot。

**O7 UI 现状**（`grep -rln "child[Rr]un\|childRunId" src/renderer/` + `grep -rn "cancelDetachedSkillTask\|resumeRun" src/renderer/`）：

| 文件 | 行为 |
|---|---|
| `src/renderer/components/ready/TaskPanel.tsx:406` | `handleResumeProjection` → `agent.resumeRun({scopeId,taskId,continuationIntent})` |
| `src/renderer/components/ready/TaskPanel.tsx:444` | `handleCancelProjection` → `cancelDetachedSkillTask(detachedTaskId)` 或 `agent.suspendRun({scopeId,taskId})` |
| `src/renderer/components/agent/ChatPanel.tsx:2576/2587/2627` | 另一套 task-level suspend / cancelDetached / resume 控制 |
| `src/renderer/modules/agent/taskCardViewModel.ts` | `TaskCardVisualState` / `TaskCardAction = 'continue' \| 'retry' \| 'open_artifact' \| 'cancel'` |
| **实测** | renderer 内 `childRunId` 引用数 = 0；UI 完全按 task / scope 维度操作 |

→ task 级控制已存在；child-run 级别零控制面。O7 的 G-MVP = 在不破坏现有 task-level UI 的前提下增设 child-run-level IPC + 最小渲染面；W0 推荐入口是 Settings/debug 子区，而不是 TaskCard 子行。

**verify chain 现状**（截至 G 开工时序：v3 §5.1 顺序为 D ← E ← F ← G）：

```
verify:a0 ← a05 ← a1 ← b ← c ← d ← e ← f
```

`package.json` 已存在 `verify:f`，且 `verify:f` 链 `verify:e`。因此 `verify:g` 必须内嵌 `verify:f`，不再需要 fallback 到 `verify:e` / `verify:d`。

**已建立的 ESLint factory pattern**（C/D/F 阶段建立的 `eslint-rules/index.mjs:127` `createNoCoordinatorIdLeakRule()` 形态）：G 不新增 hard rule（N1-N4 是结构债，CI 强制走 `scripts/check-*.cjs` 即可）。

### 0.3 与前序阶段的边界

| 阶段 | 是否阻塞 G | 备注 |
|---|---|---|
| A0 词汇 invariant | 必须 land | N1 的 helper 化要追加到 §0.5 原则 1 的合同 set |
| A1 SubAgent skeleton | 必须 land | child run 的"runHandle"对象在 freshContractFields 里需要稳定形状 |
| B child runtime 迁移 | 必须 land | N2 的 freshContractFields 在 SubAgent 入口返回 |
| C Coordinator | 推荐已 land | 不直接依赖；如未 land 不影响 |
| D reminder/compaction/hooks | 推荐已 land | 不直接依赖 |
| E 防爆减脆 | 推荐已 land | N4 的 TurnFeatureFlags 与 E 引入的 retry / circuit-breaker flag 同框架收口 |
| F 测试规约 + e2e | 推荐已 land | G 的所有新测试按 `testing-conventions.md` 行为测试模板写 |

→ **G 实际硬依赖只 A0 / A1 / B**；其余建议但非必须。**最低门槛 = A0 + A1 + B land**。

---

## 1. Hard Contracts（CI 必须可机器验证）

### G-Contract-1：`TERMINAL_CHILD_CLOSE_STATUSES` 单一来源

`TERMINAL_CHILD_CLOSE_STATUSES` set + `isTerminalChildCloseStatus(status)` helper 仅在 `src/main/modules/agent-control/skill-child-run-types.ts` 内导出。所有其他文件**禁止**：

- 重新声明同名 set；
- 用 `[...].includes(status)` / 内联 set 字面 / 等价表达对终态做判定；
- 对 `close.status` / `live.status` 做 `===` / `!==` 字面比较，**除了**少数已知的 mapping switch（如 `renderChildCommandOutcome` 的大 switch、SubAgent close-mapping 的语义分类点 —— 白名单显式列出）。

**CI 验证**：新建 `scripts/check-child-status-vocabulary.cjs`（TS Compiler API）：

- 扫描 `src/main/modules/agent-control/` 下所有 `.ts` 文件。
- 报错 1：除 `skill-child-run-types.ts` / `skill-child-sub-agent-close-mapping.ts`（白名单）外，任何文件出现 `Set<SkillChildCloseEvent['status']>` 字面 → fail。
- 报错 2：除白名单 switch 外，`close.status === '<literal>'` / `closeEvent.status === '<literal>'` / `live.status === '<literal>'` 的 BinaryExpression → fail。
- 白名单 switch 列表（实施时按 W0 audit 确定，**不**超过 3 处）。
- 同时写 `scripts/__tests__/check-child-status-vocabulary.test.cjs` 锁住脚本行为。

### G-Contract-2：`resumeSkillChildRun` 返回 `freshContractFields`

`resumeSkillChildRun(childRunId)` 的 return shape 增加 `freshContractFields: { childCloseEvent: null; childStatus: 'running'; parentNextHint: SkillChildRunParentNextHint }` 字段。

`turn-engine.ts` resume 分支**禁止**手动 `contract.childCloseEvent = ...` 赋值；必须调 `Object.assign(contract, resumed.freshContractFields)`（或等价的 spread）。

**CI 验证**：

- 新建 `src/__tests__/resume-fresh-contract-fields.test.ts`：
  - it('resumeSkillChildRun returns freshContractFields with childCloseEvent=null')
  - it('freshContractFields.childStatus is "running" on success')
  - it('freshContractFields includes parentNextHint')
  - it('turn-engine resume branch applies freshContractFields wholesale; turnFrame.runContract has zero stale fields from previous lifecycle')
- 在 `scripts/check-child-status-vocabulary.cjs` 同步加规则：禁止 `turn-engine.ts` 内出现 `*.childCloseEvent = <非 freshContractFields 的 expr>` 直接赋值（只允许通过 Object.assign / spread freshContractFields 间接修改）。

### G-Contract-3：`SkillChildCloseEvent` 不可变

类型层：`SkillChildCloseEvent` 与其嵌套字段（`error`、`progress`）改为 `DeepReadonly<...>`（新建 `src/shared/deep-readonly.ts` 工具类型）。

运行时层：所有构造 close event 的工厂（W0 audit 列出）必须在返回前调 `deepFreezeCloseEvent(close)` 一次。

**CI 验证**：

- 新建 `src/__tests__/close-event-immutability.test.ts`：
  - it('close event from runner finalize is Object.frozen at top level')
  - it('close.error and close.progress are also frozen (deep)')
  - it('two awaiters share the same frozen reference; mutate attempt throws in strict mode')
  - it('typecheck rejects close.error.message = "..." assignment (compile-time check via tsd or @ts-expect-error)')
- TS 编译期检查通过 `// @ts-expect-error` 钉死 readonly 违例。

### G-Contract-4：TurnFeatureFlags per-turn snapshot

新建 `src/main/modules/agent-control/turn-feature-flags.ts`：

```ts
export interface TurnFeatureFlags {
  readonly childResumeEnabled: boolean
  readonly childInternalStrictAdmission: boolean
  readonly childRunCircuitBreakerEnabled: boolean  // 如 E 已 land
  // 未来新增 flag 都加在这里
}

export function snapshotTurnFeatureFlags(env?: NodeJS.ProcessEnv): TurnFeatureFlags
```

`turn-engine.execute()` 入口调一次 `snapshotTurnFeatureFlags()`，存为 `const flags = ...`，下游所有 flag 判定改用 `flags.childResumeEnabled` 而非 `isChildResumeEnabled()`。

**CI 验证**：

- 新建 `src/__tests__/turn-feature-flags.test.ts`：
  - it('snapshotTurnFeatureFlags reads each flag once at construction')
  - it('subsequent env var mutations do not affect existing snapshot')
  - it('returned object is frozen (Object.isFrozen)')
- `scripts/check-child-status-vocabulary.cjs`（既然已经在扫 turn-engine.ts，复用）追加规则：`turn-engine.ts` 内除 `execute()` 入口的 1 处外，**禁止**直接调 `isChildResumeEnabled` / `isChildInternalStrictAdmissionEnabled`。其他 caller 必须接 `flags: TurnFeatureFlags` 参数。

### G-Contract-5：Child run 用户控制面（IPC + 最小 UI）

新增主进程 IPC：

- `agent:listActiveChildRuns(): Promise<ActiveChildRunSummary[]>`
  - 返回所有当前 active map 中的 child run summary。
  - shape：`{ childRunId, skillId, sessionId, scopeId, status, startedAt, outputDir, runStatePath }`
- `agent:cancelChildRun(childRunId: string, reason?: 'ui_button'): Promise<{ ok: boolean; close: SkillChildCloseEvent | null }>`
  - 直接调 `cancelSkillChildRun(childRunId)`。
  - 不依赖 NLP intent。
  - 调用方默认 `reason='ui_button'`，metric `child_run_cancelled` 的 source 字段记录之。

Renderer：

- 新增最小渲染面（**优先**复用现有 settings/devtools 入口，**不**新建顶层 panel）：列出 active child runs，每行一个"取消"按钮。
- 不做样式打磨；功能性可见、可点击、可取消即可。

**CI 验证**：

- 新建 `src/__tests__/active-child-run-ipc.test.ts`：
  - it('agent:listActiveChildRuns returns empty when no active runs')
  - it('agent:listActiveChildRuns reflects newly started runs')
  - it('agent:cancelChildRun by id terminates the run; close.terminalReason="cancelled_user"')
  - it('cancel via UI emits child_run_cancelled metric with source="ui_button"')
  - it('cancel via NLP emits child_run_cancelled metric with source="nlp"')
- 新建 `scripts/check-child-control-ipc.cjs`（轻量）：grep `preload/index.ts` 必须 expose `listActiveChildRuns` + `cancelChildRun`；grep `renderer/types/electron.d.ts` 必须有对应类型声明。
- Renderer 测试：单组件 mount + click + assert mock IPC 被调（按 F 阶段 `testing-conventions.md` 模板）。

### G-Contract-6：A0/A1/B/C/D/E/F 不退化 + verify:g 绿

`verify:g` 内嵌 `verify:f`（如 F 已 land）→ `verify:e`（如 E 已 land）→ `verify:d` → `verify:c` → `verify:b`（含 a*）。任一退化则 G fail。

`verify:g` 内容：

```
"verify:g": "npm run typecheck && npm run lint:check && node scripts/check-child-status-vocabulary.cjs && node scripts/check-child-control-ipc.cjs && npm run test:g:gates && npm run test:g:focus && npm run verify:f",
"test:g:gates": "node --test scripts/__tests__/check-child-status-vocabulary.test.cjs scripts/__tests__/check-child-control-ipc.test.cjs",
"test:g:focus": "npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/resume-fresh-contract-fields.test.ts src/__tests__/close-event-immutability.test.ts src/__tests__/turn-feature-flags.test.ts src/__tests__/active-child-run-ipc.test.ts <renderer 控制面测试>"
```

### G-Contract-7：lint baseline 不增加

`eslint-rules/baseline.json` 总数不变。N1-N4 修完后**反而期望减少**（散落字面消失），但 G **不**强制减少（避免实施时为了过 baseline 削减而强行删测试断言）。

---

## 2. 架构决定（Architecture Decisions）

### D1. N1 Helper 化的边界 = "比较" 而非 "传递"

可以保留 `contract.childStatus = close.status` 类**赋值 / 传递**（status 作为数据载荷流转）；必须替换的是**判定 / 比较**：`if (close.status === 'completed')` / `Set.has(status)` / `status in TERMINAL_SET`。

**理由**：

- 词汇 invariant 的本质是"判定语义不可在多处再造"。数据传递只是搬运字符串，不参与决策。
- 强行让所有 status 触碰都过 helper 会把代码改得难读，且引入无意义间接层。
- F 阶段 `testing-conventions.md` 的"行为测试 vs 结构测试"原则 → 这里执行"判定集中、传递放任"。

### D2. N2 freshContractFields 是 immutable，调用方一次 spread

```ts
interface ResumeSkillChildRunResult {
  // ... 现有字段
  freshContractFields: Readonly<{
    childCloseEvent: null
    childStatus: 'running'
    parentNextHint: SkillChildRunParentNextHint
  }>
}
```

turn-engine resume 分支**唯一**允许的写法：

```ts
const resumed = await resumeChild(childRunId)
Object.assign(contract, resumed.freshContractFields)
// 不允许：contract.childCloseEvent = null
// 不允许：contract.childCloseEvent = resumed.closeEvent ?? null
```

**理由**：

- 把"清状态"的语义集中到 runner 一侧（runner 知道清什么），turn-engine 只做"接受新状态"的搬运。
- spread 是机器可验证的（CI lint 可禁止 `*.childCloseEvent = <expr>` 直接赋值，仅放行 `Object.assign(<obj>, *.freshContractFields)`）。
- 未来加第三个 close 副本时，runner 只需扩 `freshContractFields` 字段，turn-engine 零改动。

### D3. N3 deepFreeze 在 builder 层做一次

不在每个 awaiter 收到 close 时检查 frozen，也不在每次构造时遍历 freeze；而是在**唯一构造点**（W0 audit 列出，预计 1-2 处：`finalizeRun` + 偶尔的 mock）调用 `deepFreezeCloseEvent(close)` 一次。

```ts
// src/shared/deep-readonly.ts
export type DeepReadonly<T> = ...

// src/main/modules/agent-control/skill-child-run-types.ts
export function deepFreezeCloseEvent(close: SkillChildCloseEvent): DeepReadonly<SkillChildCloseEvent> {
  if (close.error) Object.freeze(close.error)
  if (close.progress) Object.freeze(close.progress)
  return Object.freeze(close) as DeepReadonly<SkillChildCloseEvent>
}
```

**理由**：

- Type 层（`DeepReadonly<>`）和 runtime 层（`Object.freeze`）双保险；type 层防误改，runtime 层防 type 绕过（`as any` 等）。
- 单点 freeze 比每个 awaiter 各自 freeze 简洁，且测试可直接断言 `Object.isFrozen(close) === true`。

### D4. N4 TurnFeatureFlags 是 frozen object，per-turn 创建

```ts
export function snapshotTurnFeatureFlags(env = process.env): TurnFeatureFlags {
  return Object.freeze({
    childResumeEnabled: readEnvFlag(env, 'READY_SKILL_CHILD_RESUME_ENABLED'),
    childInternalStrictAdmission: readEnvFlag(env, 'READY_SKILL_CHILD_INTERNAL_STRICT_ADMISSION'),
    childRunCircuitBreakerEnabled: readEnvFlag(env, 'READY_CHILD_RUN_CIRCUIT_BREAKER_ENABLED'),
  })
}
```

`turn-engine.execute()` 入口：

```ts
const flags = snapshotTurnFeatureFlags()
// ... 全部下游用 flags.<name>，不再调 isXxxEnabled()
```

**理由**：

- 同 turn 内行为一致是合同；object frozen 让"中途某代码偷偷调函数读 env" 直接被 ESLint 抓（`turn-engine.ts` 内除 1 处入口 snapshot 外禁止调 `isXxxEnabled` 形态函数）。
- frozen + readonly 类型双保险。

### D5. O7 控制面 = 调试入口，不做产品化

G 的 O7 范围目标是**"用户在 NLP 失效时仍能取消任何 active child run"**。形态：

- 主进程 IPC + preload + renderer 类型声明（必须）
- Renderer：复用既有 settings 页或调试入口（如开发者工具页面），列出 active child runs + 取消按钮
- **不做**视觉打磨、不做 task-card 内子行细分、不做 cross-session admin

**理由**：

- 全产品化设计需要 UX 决策（child run 是否暴露给最终用户作为概念？）。G 不预设。
- 调试入口足以闭合"NLP 错过识别 → 完全失控"的事故路径。
- 后续 UI 队需要时基于现有 IPC 扩展，零额外架构成本。

### D6. Cancel metric 区分来源

```ts
TOOL_ERROR_METRICS.childRunCancelled = 'child_run_cancelled'

// emit shape
logAgentMetric('child_run_cancelled', {
  childRunId,
  skillId,
  source: 'nlp' | 'ui_button',
  // ...
})
```

`source` 字段必填。NLP 路径（turn-engine 识别 cancel intent → cancelSkillChildRun）填 `'nlp'`；UI 路径（agent:cancelChildRun IPC）填 `'ui_button'`。

**理由**：

- 后续 dashboard 上能分辨"NLP 召回率"vs"UI 主动取消比例"。
- 如果发现 ui_button 占比突增，提示 NLP 召回率下降 / UI 摩擦点。

### D7. N5 是 audit-only，不重新动代码

A0 词汇 invariant 添加 `'resume_launch_failed'` 时已附带处理 N5（`failed_skill` 不再被 resume 启动失败借用）。**G 范围内仅做 audit 校验**：grep 全仓 `terminalReason: 'failed_skill'` 出现的位置，**断言**所有出现都是合法的 "skill 自己声明 success=false" 语义。

**CI 验证**：W0 audit 报告中显式列出每一处 `terminalReason: 'failed_skill'`，写明用途。如果发现还有"resume launch 借用"的残留，由 W2 合并修复（**不**单独成 W）。

---

## 3. Worker 划分（7 队）

### W0 — Pre-flight Audit

**Owner**：general-purpose 1 人 / 0.5 天

**输出**：`docs/archive/2026-09-06/docs/superpowers/plans/2026-04-30-G-pre-flight-audit-report.md`

**任务**：

1. **N1 audit**：完整列出所有 `close.status` / `closeEvent.status` / `live.status` 字面比较点；分类成"应替换为 helper" vs "白名单 switch / mapping"。给出 W1 替换清单。
2. **N2 audit**：列出 turn-engine resume 分支所有 `*.childCloseEvent = <expr>` 直接赋值点（截至 G 开工时序）。
3. **N3 audit**：列出 `SkillChildCloseEvent` 的所有构造点（finalize / mock / 测试 fixture）。给出 W3 freeze 注入清单。
4. **N4 audit**：列出所有 `isChildResumeEnabled` / `isChildInternalStrictAdmissionEnabled` / 未来 flag 函数的 caller。给出 W4 替换清单。
5. **O7 audit**：
   - 列出 main-process side `cancelSkillChildRun` / `resumeSkillChildRun` API 的真实 export 形态。
   - 列出 renderer-side 现有的 settings / devtools / 调试入口候选（W5 渲染面应该挂哪）。
   - 列出 preload `electronAPI.agent.*` 现有方法，确认 `listActiveChildRuns` / `cancelChildRun` 没有已存在同名占用。
6. **N5 audit-only**：grep `terminalReason: 'failed_skill'` 全仓，分类每处用途。
7. **D/E/F land 状态确认**：决定 `verify:g` 链入哪个 verify。
8. **白名单 switch 列表**：`renderChildCommandOutcome` 的大 switch 是否在 W1 收口范围？给出明确清单（建议白名单理由）。

**完成判据**：报告 push，每节给出可机器执行的下游产物（替换清单 / 构造点清单 / IPC 方法清单 / 白名单理由）。

**依赖**：无。

### W1 — N1 状态字面量集中化

**Owner**：general-purpose 1 人 / 0.5 天

**目标文件**（修改）：

- `src/main/modules/agent-control/skill-child-run-types.ts`：
  - 新增 export `TERMINAL_CHILD_CLOSE_STATUSES = new Set<...>([...])` + `isTerminalChildCloseStatus(status): boolean`。
- `src/main/modules/agent-control/turn-engine.ts:316-320`：删本地副本，改 import。`turn-engine.ts:337` 改用 helper。
- `src/main/modules/agent-control/turn-frame-steering.ts:296-300`：同上。
- `src/main/modules/agent-control/skill-child-sub-agent.ts:220`：`closeEvent.status === 'failed'` 改 helper（如 W0 audit 判定其属于 "判定" 类）。
- 其他 W0 audit 列出的散点：替换为 helper。

**目标文件**（新建）：

- `scripts/check-child-status-vocabulary.cjs`：按 G-Contract-1 §CI 验证。
- `scripts/__tests__/check-child-status-vocabulary.test.cjs`：脚本自测。

**完成判据**：

- `check-child-status-vocabulary.cjs` 在主分支 0 报错。
- 故意在 turn-engine.ts 加一行 `if (close.status === 'completed') ...` → 报错。
- typecheck / 既有测试零退化。

**依赖**：W0。

### W2 — N2 resume freshContractFields

**Owner**：general-purpose 1 人 / 0.5-1 天

**目标文件**（修改）：

- `src/main/modules/agent-control/skill-child-run-types.ts`：扩 `StartSkillChildRunResult` / 等价 type，加 `freshContractFields: Readonly<{...}>` 字段。
- `src/main/modules/agent-control/skill-child-runner.ts:333+` `resumeSkillChildRun`：在成功路径返回值里填 `freshContractFields`。失败路径 `freshContractFields` 为 null（不需要应用）。
- `src/main/modules/agent-control/turn-engine.ts:1580` 附近：删手动 `childCloseEvent = ...` 赋值，改 `Object.assign(contract, resumed.freshContractFields)`。
- `scripts/check-child-status-vocabulary.cjs`：扩规则 —— turn-engine.ts 内禁止 `*.childCloseEvent = <非 freshContractFields 的 expr>` 直接赋值。

**目标文件**（新建）：

- `src/__tests__/resume-fresh-contract-fields.test.ts`：按 G-Contract-2 §CI 验证。

**完成判据**：

- 4 个新测试通过。
- N5 audit 如发现 resume 启动失败 还有 `failed_skill` 借用，在本 PR 一并修。
- typecheck / 既有 resume 测试（`skill-child-runner-resume-lifecycle.test.ts`）零退化。

**依赖**：W0、W1（vocabulary script 复用）。

### W3 — N3 close event deep freeze

**Owner**：general-purpose 1 人 / 0.5 天

**目标文件**（新建）：

- `src/shared/deep-readonly.ts`：
  ```ts
  export type DeepReadonly<T> = T extends Function ? T :
    T extends Array<infer U> ? ReadonlyArray<DeepReadonly<U>> :
    T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } :
    T
  ```
- `src/__tests__/close-event-immutability.test.ts`：按 G-Contract-3 §CI 验证。

**目标文件**（修改）：

- `src/main/modules/agent-control/skill-child-run-types.ts`：
  - `SkillChildCloseEvent` interface 字段保持原样（type 层用 `DeepReadonly<SkillChildCloseEvent>` 在 export 处包装，避免大改 fixture）。
  - 新增 `deepFreezeCloseEvent(close)` helper。
- `src/main/modules/agent-control/skill-child-runner.ts`：W0 audit 列出的所有 close event 构造点（预计 1-2 处，主要是 `finalizeRun`），在 push 到 awaiters / 写 row 之前调一次 `deepFreezeCloseEvent`。
- 其他构造点（W0 audit 列出）同上。

**注意**：

- 测试 fixture / mock 内构造的 close event **不**强制 freeze（避免大量测试改写）；只产品代码路径强制。CI 测试断言只覆盖产品路径。
- 如发现某处 mutate close 是真实需要（不应该有，但万一），ESCALATE 不强行 freeze；audit 报告记录待处理项。

**完成判据**：

- 4 个新测试通过。
- 既有 fan-out 测试（"firstResult.closeEvent === secondResult.closeEvent"）仍通过 + 新增"两 awaiter 都 frozen"断言。
- typecheck 通过。

**依赖**：W0。可与 W1 / W2 并行。

### W4 — N4 TurnFeatureFlags

**Owner**：general-purpose 1 人 / 0.5 天

**目标文件**（新建）：

- `src/main/modules/agent-control/turn-feature-flags.ts`：按 D4。
- `src/__tests__/turn-feature-flags.test.ts`：按 G-Contract-4 §CI 验证。

**目标文件**（修改）：

- `src/main/modules/agent-control/turn-engine.ts`：在 `execute()` 入口加 `const flags = snapshotTurnFeatureFlags()`；line 1535 `if (!isChildResumeEnabled())` 改 `if (!flags.childResumeEnabled)`。
- 其他 W0 audit 列出的 caller（如 `tool-executor.ts` 的 `isChildInternalStrictAdmissionEnabled` 调用点）：改接 `flags: TurnFeatureFlags` 参数（caller 一路传下去）。
- `scripts/check-child-status-vocabulary.cjs`：扩规则 —— turn-engine.ts 内除 `execute()` 入口的 1 处外禁止调 `isXxxEnabled` 形态函数。

**完成判据**：

- 3 个新测试通过。
- 故意在 turn-engine.ts 中途加一行 `if (isChildResumeEnabled()) ...` → 脚本报错。
- typecheck / 既有 flag-related 测试零退化。

**依赖**：W0。可与 W1 / W2 / W3 并行。

### W5 — O7 child run 控制面 IPC + 最小渲染面

**Owner**：general-purpose 1 人 / 1-1.5 天

**目标文件**（新建）：

- `src/main/modules/agent-control/active-child-run-summary.ts`：
  ```ts
  export interface ActiveChildRunSummary {
    childRunId: string
    skillId: string
    sessionId: string | null
    scopeId: string | null
    status: SkillChildRunStatus
    startedAt: string  // ISO
    outputDir: string | null
    runStatePath: string | null
  }

  export function listActiveChildRunSummaries(
    runner: SkillChildRunner,
  ): ActiveChildRunSummary[]
  ```
- `src/__tests__/active-child-run-ipc.test.ts`：按 G-Contract-5 §CI 验证。
- `scripts/check-child-control-ipc.cjs`：grep preload + electron.d.ts 必须 export 对应 API。
- `scripts/__tests__/check-child-control-ipc.test.cjs`：脚本自测。

**目标文件**（修改）：

- `src/main/modules/claude-bridge/ipc-handler.ts`（或 W0 audit 指定的 IPC 注册位置）：注册 `agent:listActiveChildRuns` / `agent:cancelChildRun` handler。
- `src/preload/index.ts`：expose `electronAPI.agent.listActiveChildRuns` / `cancelChildRun`。
- `src/renderer/types/electron.d.ts`：加对应类型声明。
- `src/main/modules/agent-control/tool-error-metrics.ts`：注册 `childRunCancelled: 'child_run_cancelled'`。
- `src/main/modules/agent-control/skill-child-runner.ts:cancelSkillChildRun` 入口：接受可选 `source: 'nlp' | 'ui_button'` 参数（默认 `'nlp'`），emit metric。
- `src/main/modules/agent-control/turn-engine.ts` cancel 分支：传 `source: 'nlp'`。
- IPC handler `agent:cancelChildRun`：传 `source: 'ui_button'`。
- Renderer：在 W0 audit 选定的 settings/devtools 入口加最小列表 UI。**不**做样式打磨。
  - 1 个新组件 `<ActiveChildRunList />`（functional）；
  - 列出 `listActiveChildRuns` 结果，每行展示 childRunId / skillId / status / startedAt + 取消按钮；
  - 取消按钮调 `electronAPI.agent.cancelChildRun(id, 'ui_button')` + refetch。

**完成判据**：

- 5 个新测试通过（4 IPC behavior + 1 metric source 区分）。
- `check-child-control-ipc.cjs` 主分支 0 报错。
- 渲染面在 dev mode 跑通（W5 owner 提供截图 / log）。
- typecheck / lint 零退化。

**依赖**：W0。可与 W1-W4 并行（不冲突文件）。

### W6 — verify:g gate + 文档同步 + 路线图收尾

**Owner**：general-purpose 0.5 人 / 0.5 天

**目标文件**（修改）：

- `package.json`：加 `verify:g` / `test:g:gates` / `test:g:focus` script。
- `CLAUDE.md`：新增 §6.18（接 F 的 §6.17 之后）"提质 + 控制面（G 阶段）"段落。
- `AGENTS.md`：同步 §6.18。
- `docs/archive/2026-09-06/docs/superpowers/plans/2026-04-30-skill-runtime-agent-layer-reframe.md` §5.1：把 G 行从工作量描述改为 `[x] completed YYYY-MM-DD`；§5.1 末尾追加"v3 路线交付完成"note。
- `docs/superpowers/plans/2026-04-30-skill-runtime-residual-architectural-debt.md` §2 / §3：N1-N4 / O7 末尾追加 `> **G 阶段已收口（YYYY-MM-DD）**：参 `2026-04-30-G-quality-polish-and-control-surface-implementation.md`。`

**CLAUDE.md §6.18 内容**（5-8 行精简摘要）：

```
### 6.18 提质 + 控制面（G 阶段）
- **状态字面量单一来源**：`TERMINAL_CHILD_CLOSE_STATUSES` + `isTerminalChildCloseStatus` 只在 `skill-child-run-types.ts` 导出；其他文件禁止再造副本或对 `close.status` 做字面比较（白名单 switch 例外）。CI 由 `scripts/check-child-status-vocabulary.cjs` 强制。
- **Resume 清状态合一**：`resumeSkillChildRun` 返回 `freshContractFields`；turn-engine resume 分支用 `Object.assign(contract, freshContractFields)`，禁止手动 `childCloseEvent = null` 直接赋值。
- **Close event 不可变**：`SkillChildCloseEvent` 用 `DeepReadonly<>` + builder 层 `deepFreezeCloseEvent` 一次性 freeze。所有 awaiter 拿到的 close 是 frozen 引用。
- **TurnFeatureFlags per-turn**：turn-engine `execute()` 入口一次 `snapshotTurnFeatureFlags()`，下游禁止再调 `isXxxEnabled()` 函数。同 turn 内 flag 行为一致，不受中途 env 修改影响。
- **Child run 控制面**：IPC `agent:listActiveChildRuns` / `agent:cancelChildRun(id, source)`；renderer 提供调试级列表 + 单点取消按钮。`source: 'nlp' | 'ui_button'` 区分进入 metric `child_run_cancelled`。
```

**完成判据**：

- `npm run verify:g` 主分支跑成功。
- 故意 break 检查（CI 应该挡住）：
  - 在 turn-engine.ts 加 `close.status === 'completed'` → 脚本报错
  - 删除 freshContractFields 字段 → 测试报错
  - 加 `close.error.message = 'x'` → typecheck 拒绝（DeepReadonly）+ runtime 抛错（frozen）
  - turn-engine.ts 中途加 `isChildResumeEnabled()` → 脚本报错
  - 删除 preload `cancelChildRun` → check-child-control-ipc 报错
- CLAUDE.md / AGENTS.md / 路线图 / 残债文档同步完成。

**依赖**：W1-W5 全部 land。

---

## 4. 团队依赖与执行顺序

```
W0 audit ─┬─→ W1 (N1 status helper)
          ├─→ W2 (N2 freshContractFields)        — 可与 W1 并行
          ├─→ W3 (N3 deep freeze)               — 可与 W1/W2 并行
          ├─→ W4 (N4 TurnFeatureFlags)          — 可与 W1/W2/W3 并行
          └─→ W5 (O7 IPC + UI)                  — 可与 W1-W4 并行
                                                          │
                                          W1-W5 全 land ─→ W6 (verify:g + docs)
```

**串行段**：W0 → 任一 W1-W5；W6 等 W1-W5 全部 land。
**并行段**：W1-W5 全程并行（不冲突文件 —— vocabulary script 由 W1 创建后 W2/W4 各自扩规则，但同文件 PR 串行 land）。

**Land 顺序约束**：

- W1 必须在 W2/W4 之前（vocabulary script 是它们的依赖）
- W2/W3/W4 之间无强约束，按 PR ready 顺序 land
- W5 完全独立（IPC 不碰 vocabulary）
- W6 最后

---

## 5. 端到端验证

```bash
# 1. 类型 + lint baseline
npm run typecheck
npm run lint:check
node scripts/check-eslint-baseline.cjs

# 2. G 自有 lint + 焦点测试
node scripts/check-child-status-vocabulary.cjs
node scripts/check-child-control-ipc.cjs
node --test scripts/__tests__/check-child-status-vocabulary.test.cjs
node --test scripts/__tests__/check-child-control-ipc.test.cjs
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/resume-fresh-contract-fields.test.ts \
  src/__tests__/close-event-immutability.test.ts \
  src/__tests__/turn-feature-flags.test.ts \
  src/__tests__/active-child-run-ipc.test.ts \
  src/__tests__/skill-child-runner-resume-lifecycle.test.ts \
  src/__tests__/turn-engine-route.test.ts

# 3. 不退化 gate
npm run verify:f   # 含 verify:e / verify:d / verify:c / verify:b / verify:a*

# 4. 故意 break 检查（CI 应该挡住）
# - 在 turn-engine.ts 加 if (close.status === 'completed') → check-child-status-vocabulary 报错
# - 删 ResumeSkillChildRunResult.freshContractFields → resume-fresh-contract-fields 测试报错
# - 在 close event builder 删 deepFreezeCloseEvent → close-event-immutability 测试报错
# - 在 turn-engine.ts 中途加 isChildResumeEnabled() 调用 → check-child-status-vocabulary 报错
# - 在 preload 删 cancelChildRun export → check-child-control-ipc 报错

# 5. 手动 dev 烟测
# - 启动 VEA child run，等到 running 状态
# - 在 settings/devtools 列表里看到该 child run
# - 点取消按钮 → child run 立即终止，metric child_run_cancelled with source='ui_button'
# - 输入"取消" NLP → metric source='nlp'
# - 跑两段 lifecycle resume → 验证 N2 freshContractFields 在第二段开始时清干净
```

---

## 6. 关键文件路径速查

修改：

- `src/main/modules/agent-control/skill-child-run-types.ts`（W1：vocabulary export；W2：freshContractFields type；W3：DeepReadonly + deepFreezeCloseEvent）
- `src/main/modules/agent-control/skill-child-runner.ts`（W2：resumeSkillChildRun 返回 freshContractFields；W3：finalize 调 deepFreeze；W5：cancel 接 source 参数）
- `src/main/modules/agent-control/turn-engine.ts`（W1：删 vocabulary 副本 + 改 helper；W2：spread freshContractFields；W4：execute 入口 snapshot flags + 下游用 frozen object；W5：cancel source='nlp'）
- `src/main/modules/agent-control/turn-frame-steering.ts`（W1：删 vocabulary 副本）
- `src/main/modules/agent-control/skill-child-sub-agent.ts`（W1：close mapping 改 helper / 进白名单）
- `src/main/modules/agent-control/tool-error-metrics.ts`（W5：注册 childRunCancelled）
- `src/main/modules/agent-control/tool-executor.ts`（W4：接 flags 参数，删内部 isChildInternalStrictAdmissionEnabled 调用）
- `src/main/modules/claude-bridge/ipc-handler.ts`（W5：注册 IPC handler）
- `src/preload/index.ts`（W5：expose API）
- `src/renderer/types/electron.d.ts`（W5：类型声明）
- `src/renderer/components/...`（W5：最小列表 UI 挂入既有调试入口）
- `package.json`（W6：verify:g）
- `CLAUDE.md` / `AGENTS.md`（W6：§6.18）
- `docs/archive/2026-09-06/docs/superpowers/plans/2026-04-30-skill-runtime-agent-layer-reframe.md`（W6：路线图）
- `docs/superpowers/plans/2026-04-30-skill-runtime-residual-architectural-debt.md`（W6：N1-N4 / O7 完成 note）

新建：

- `src/shared/deep-readonly.ts`（W3）
- `src/main/modules/agent-control/turn-feature-flags.ts`（W4）
- `src/main/modules/agent-control/active-child-run-summary.ts`（W5）
- `scripts/check-child-status-vocabulary.cjs`（W1）
- `scripts/check-child-control-ipc.cjs`（W5）
- `scripts/__tests__/check-child-status-vocabulary.test.cjs`（W1）
- `scripts/__tests__/check-child-control-ipc.test.cjs`（W5）
- `src/__tests__/resume-fresh-contract-fields.test.ts`（W2）
- `src/__tests__/close-event-immutability.test.ts`（W3）
- `src/__tests__/turn-feature-flags.test.ts`（W4）
- `src/__tests__/active-child-run-ipc.test.ts`（W5）
- `docs/archive/2026-09-06/docs/superpowers/plans/2026-04-30-G-pre-flight-audit-report.md`（W0）

---

## 7. 显式 out-of-scope

不在 G 范围，留给后续独立 PR / UI 队 / 产品决策：

- **TaskCard 内 child run 子行细分**：当 1 task 拥有 N>1 child run 时的 UI 拆分。需要 UX 决策（child run 是否暴露给最终用户作为概念）。
- **Resume via UI button by childRunId**：以 childRunId 为身份的 resume；现有 task-level `agent.resumeRun` 路径足够。
- **Cross-session / cross-device admin view**：看其他用户 / 其他设备的 child run。
- **Pause / budget 进度可视化升级**：UI 已有 `budget_paused` visual state；细化是 UI 队选题。
- **N5（`failed_skill` 借用）**：A0 已附带处理，G 仅 audit 校验。
- **Child run 历史 / 审计 view**：列已结束 child run + 产物链接。F 阶段 `e2e/fixtures/README.md` + 现有 task projection 已能覆盖。
- **Renderer 端样式打磨**：G 的 UI 是调试级；产品化由 UI 队后续接入。
- **DeepReadonly 工具类型扩展到其他 type**：本 G 只覆盖 `SkillChildCloseEvent`；类型工具复用是后续选题。
- **ESLint hard rule 替代 cjs script**：G 的 vocabulary / IPC check 用 cjs 脚本，CI 强制；如未来想升级到 ESLint custom rule，独立 PR 重构（按 C/D 已建立的 factory pattern）。

---

## 8. 风险与缓解

### 8.1 W1 helper 化误判产品代码 vs 测试代码

**风险**：vocabulary script 扫到 `__tests__/` 下的 close.status 字面比较（mock fixture 经常这样写），误报。

**缓解**：

- 脚本默认豁免 `src/__tests__/` 路径。
- 白名单理由列在 W0 audit 报告 + 脚本注释。
- 测试代码自身用 `// allow-status-literal: <reason>` 注释豁免，规则同 F 阶段 `// allow-source-grep: <reason>` 模式。

### 8.2 W2 freshContractFields 与 SubAgent 入口 shape 不一致

**风险**：B 阶段 SubAgent 重构时 resume 入口可能已经是 SubAgentResume；W2 的 freshContractFields 字段需要与 SubAgent 的 result type 协调。

**缓解**：

- W0 audit 必须读 `skill-child-sub-agent.ts` 的 resume 路径，确认 freshContractFields 应该挂在哪一层（SubAgent vs runner）。
- 如果 SubAgent 已经有等价语义字段，W2 改用既有字段而非新增。
- 如果发现冲突无法在 W2 范围内解决，ESCALATE，**不**强行加新字段。

### 8.3 W3 deepFreeze 对既有 mutate 代码造成回归

**风险**：W0 audit 应该 enumerate 所有 close 构造点，但可能漏掉某条路径在拿到 close 后 mutate（如错误信息追加）。frozen 之后这些 mutate 会抛 TypeError。

**缓解**：

- W3 land 前跑全套 `npm test`，frozen 引发的 TypeError 会立即冒泡到测试 fail。
- 如发现真实的 mutate 需求（不应该有，但万一），ESCALATE，**不**用 `try { close.x = ... } catch {}` 隐藏问题。
- 测试 fixture / mock 不强制 freeze 是 D3 显式决定，避免误伤。

### 8.4 W4 flag snapshot 漏覆盖某条 caller 路径

**风险**：未 audit 出来的某条路径（如 worker thread / child runner 内部）继续直接调 `isChildResumeEnabled()`，导致同 turn 内行为分裂。

**缓解**：

- W0 audit 必须 grep 全仓 `isChildResumeEnabled` / `isChildInternalStrictAdmissionEnabled`。
- 漏 audit 的 caller 在 W4 land 后由 vocabulary script 抓（脚本扫 turn-engine.ts 之外的 agent-control 文件，禁止调 isXxxEnabled）。
- runner 内部如确有 flag 需要，由 caller（turn-engine）传 flags 参数下来；runner 不直接读 env。

### 8.5 W5 渲染面入口选择不当

**风险**：复用既有 settings 页可能跟产品 UI 冲突；新建独立 panel 又超 G 范围。

**缓解**：

- W0 audit 列出 3 个候选入口 + 评估每条的"是否影响产品 UI"。
- 默认放在 dev-only 入口（如 settings 的"调试"区，未来可由 UI 队迁移）。
- 如所有候选入口都不合适，W5 owner 可在 settings 页加一个"调试"折叠区，按需打开。

### 8.6 G-Contract-1 vocabulary script 和 D-Contract-1 reminder rule 互相干扰

**风险**：D 阶段已经在 ESLint 注册 rule；G 又加 cjs 脚本规则。两套规则可能误报或顺序 fail。

**缓解**：

- G 的 vocabulary script 是 cjs 脚本（不 ESLint rule），独立运行。
- 文件白名单 / 报错文案均与 D rule 不冲突。
- W6 `verify:g` 显式列每条 check 的运行顺序。

---

## 9. 与战略原则的对照

`CLAUDE.md §0.5` 5 条 + 升维 2 条原则在 G 的应用：

1. **先合同，后代码**：§1 给 7 条 hard contract，每条 CI 可机器验证（cjs script / typed test / IPC parity）。
2. **修根因，不修症状**：N1-N4 都是"Layer 1 修完后冒出来的次生债"。G 不打补丁，**改让它们的根因（vocabulary 散点 / 状态分二处 / 类型敞开 / flag 多处读）不可能再以同形态复发**。
3. **拒绝 legacy 兼容分支**：G 不留 fallback。`isChildResumeEnabled()` 直接调被禁；`childCloseEvent = null` 手动赋值被禁。新代码强制走新合同。
4. **形态意识**：N3 的 freeze 选择"builder 一次性"而非"awaiter 各自"是因为 Ready 形态特有 fan-out 共享引用模式（Layer 1 测试已确认）；CC-Source 单进程 CLI 不需要这层。
5. **CI 强制 > 文档约束 > 人审**：G 全部 6 条都 CI 强制；CLAUDE.md §6.18 是辅助，不是 enforcement。
6. **抽象的边界 = 形态的差异**：DeepReadonly 边界 = 编译期 vs 运行期；TurnFeatureFlags 边界 = turn 内 vs turn 间；vocabulary 边界 = 判定 vs 传递。三个新抽象各自有清晰的形态分割。
7. **重新做一遍优于继续打磨**：N2 重新做 resume API（freshContractFields）而不是"再加一处清状态"；N4 重新做 flag 读取（snapshot）而不是"加一个 cache 函数"。

---

## 10. 文档维护

- G 完成后更新路线图 §5.1（W6）。
- 残债文档 §2 / §3 在 N1-N4 / O7 末尾追加完成 note（W6）。
- 如 W0 audit 发现 §0.2 表数字与现实不符（如 Set 副本数 ≠ 2，N5 残留借用 ≠ 0），**优先**修计划，不就地"算了"。
- W0 audit 报告产出后，如发现更多 Layer 1 次生债（N6+），列入"G 后续 follow-up"段落，**不**塞进本计划。

---

## 11. v3 路线交付完成（G 完成后的状态）

G 完成 = v3 路线 8 阶段（A0 / A0.5 / A1 / B / C / D / E / F / G）全部交付。届时：

- **6 大根因 + 5 项次生债 + 8 项盲点**全部收口或显式 deferred 到产品决策。
- **ESLint baseline** 仅剩 UI / 样式历史债，agent-control / skill-runtime 区域零条目。
- **CI 强制网**覆盖：词汇 invariant（A0）/ A1 boundary / B 9 contracts / C coordinator / D reminder + compaction + hooks / E atomic + GC + retry + admission / F testing conventions + e2e harness / G vocabulary + IPC parity。
- **CLAUDE.md §6.x** 7 条新增段落（§6.13 - §6.18）描述 v3 抽象的全部形态。
- **路线图 §5.1** 全部行 `[x] completed`。

未来再发现"还有更上一层"问题时，写第四份 reframe 文档（参 v3 §10 文档维护规约），不修改历史路线。

> **提示**：G land 后建议立即开 review session 校对 §6.13 - §6.18 6 条 CLAUDE.md 段落的内部一致性 —— v3 是 7 个阶段叠出来的，文档段落分散写作可能有重复或冲突。统一 review + 必要的合并（如 §6.13 / §6.14 / §6.15 是否有重叠）由 G 之后的"v3 文档收尾 PR"处理，**不**塞进 G。

---

## 12. Final Record（2026-05-01）

### 12.1 HEAD 与验证

- HEAD：`806e9b1141abb6a20f95b1e072a1315add3aff61`
- Final gate：`npm run verify:g` exit 0
- `verify:g` 内嵌链路：`verify:f` 通过，随后 G 三个 cjs gate 与四个 focus test 文件通过
- G gate pass count：`14/14`
- G focus pass count：`54/54`
- `git diff --check`：通过

### 12.2 N0 → N_FINAL

| Item | N0（W0 audit） | N_FINAL | 说明 |
| --- | ---: | ---: | --- |
| `TERMINAL_CHILD_CLOSE_STATUSES` definitions | 2 | 1 | 状态集合收敛到 `skill-child-run-types.ts` |
| `TERMINAL_CHILD_CLOSE_STATUSES` references | 4 | 2 | 只保留定义与 helper 使用 |
| close-status literal decision candidates | 16 | 11 | 剩余项为 W0 allow / baseline；checker 通过 |
| `childCloseEvent =` candidates | 8 | 7 | resume 手动赋值已移除；剩余项为 reset / allowed baseline |
| flag helper refs | 10 | 10 | 直接中途读取由 checker 拦截；剩余为定义 / snapshot / tests |
| renderer `childRunId` refs | 0 | 16 | 新增 Settings debug 控制面 |

### 12.3 六类 break gate 手测结果

| Break | 结果 |
| --- | --- |
| 新增 status 字面量比较 | `scripts/check-child-status-vocabulary.cjs` 拦截 |
| 删除 `freshContractFields` | `resume-fresh-contract-fields.test.ts` 失败 |
| resume 分支手写 `contract.childCloseEvent = closeEvent` | `scripts/check-child-status-vocabulary.cjs` 拦截 |
| 手动 mutate close event | `close-event-immutability.test.ts` 的 type/runtime 双层测试拦截 |
| turn 中途直接读 env flag helper | `scripts/check-turn-feature-flags.cjs` 拦截 |
| 删除 preload IPC export | `scripts/check-child-control-ipc.cjs` 拦截 |

### 12.4 文档同步

- `CLAUDE.md` / `AGENTS.md` 已新增 §6.18。
- v3 路线图已将 G 标记为 completed。
- residual debt 文档已为 N1-N4 与 O7 追加完成记录。
