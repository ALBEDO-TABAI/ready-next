---
name: A1 — SubAgent 抽象骨架
description: v3 路线 A1 阶段实施计划。引入 SubAgent 概念骨架（lifecycle / context / abort / cleanup）+ 1 个 PoC，**不动** child runtime。为 B 阶段（child runtime → SubAgent 特化）准入。
status: draft
enforce: false
counter_proposal: 2026-04-30-skill-runtime-agent-layer-reframe.md
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

## Audit Patch v3 (Codex audit, applied 2026-05-01)

本 plan 的 Audit Patch v3 覆盖原版以下决策。**以本 patch 为准，原版冲突段落作废**：

| 项 | 原版 | v3 修订 | 理由 |
|---|---|---|---|
| C4 边界检查基线 | `git diff main..HEAD` | `git diff c176fcf..HEAD` (A0.5 commit) | `main` 已含 Layer 1 + A0 + A0.5 累积变更，C4 必然误报 |
| `no-subagent-leak` rule | baseline-aware | 硬规则零容忍 | 新建目录无存量违规，baseline 容忍是开后门 |
| `check-subagent-isolation.cjs` 实现 | 简单 regex | 解析 static / side-effect / dynamic import + require | regex 漏洞会让 leak 偷渡 |
| `SubAgent.run()` yield 范围 | 含 `started` / `terminal` | 仅 `progress` / `paused`，runner 包 framing | 避免双 terminal、强制 lifecycle 一致 |
| `restoreFrom` hook | 接口预留 | **删除**，B 用 factory pattern | SubAgent interface 不预设恢复模型 |
| frame/projection patch 类型 | 未规定 | 必须 `unknown`，不 import 现有类型 | A1 不得依赖 `TurnFramePatch` 或 turn-engine 私有类型 |
| Worker 数量 | W1-W4 | W0-W5（加 plan owner + integrator） | 起点锁定与最终 acceptance 拆开 |
| observability 依赖 | 允许清单描述不稳定 | **保留** `metrics` + `tool-error-metrics` 在允许清单 | cleanup drain failure metric 必需 |

A1_BASE = `c176fcf16c2e284f767b815e25c7521c9c6d1125` (A0.5 commit)。W0 开工前必须 `git rev-parse HEAD` 验证；若 HEAD 不是该 commit，停止并重锁 base。

原版 §0-§12 段落保留作为展开细节，但任何与上表冲突的具体描述无效。B 阶段开工的第一个 PR 必须先移除 A1 临时边界：删除 `scripts/check-a1-boundary.cjs`、移除 `verify:a1` 中对它的调用，并放开 `ready/no-subagent-leak` 对 child-runner 迁移路径的阻挡。

# A1 — SubAgent 抽象骨架（实施计划）

> **范围严格**：只引入 abstraction skeleton + 1 个 PoC SubAgent。**不**触动 `skill-child-runner.ts`、**不**改 `turn-engine.ts` 主循环、**不**引入 Coordinator role、**不**做 system prompt 优先级链。这些都在 B/C/D 阶段。
>
> **准入合同**：本 plan 的所有产出必须使 v3 路线 §B（Child Runtime 迁移）的 admission gate 可以打开。即：B 阶段开工时已经有"SubAgent interface" 这个东西，不需要再设计。

---

## 0. Context

### 0.1 为什么现在做

A0（战略地基）+ A0.5（source-grep baseline 清零）已 land：

- A0 commit `7de7ca0` — 词汇 invariant、ESLint baseline-aware 插件、plan-pairing hook、commit-msg hook、5 条战略原则上 CI
- A0.5 commit `c176fcf` — 51 文件迁移，agent/skill/runtime source-grep 清零，`a1-gate` baseline 入口为 0；`verify:a05` exit 0

A1 准入条件已满足（见 v3 §5.1）：
- ✅ `verify:a05` 退出码 0
- ✅ `eslint-rules/baseline.json` 中 `areaPolicy.a1-gate` 当前条目数 = 0
- ✅ `verify:a0` 退出码 0（无 regression）
- ✅ Layer 1 Child Runtime 修复（A1 P0 / A2 / B2 / B6）已 land

只有 A1 真正建立 SubAgent skeleton 后，B 阶段的"child runtime → SubAgent 特化"才有迁移目的地。如果跳过 A1 直接迁移，等于在沙地上盖房——B 阶段会被迫一边设计一边迁移，违反原则 1（先合同后代码）。

### 0.2 Reconnaissance Facts（已通过 Explore agent 核查）

下列事实是 A1 设计的输入，已经过实地 grep 验证：

**turn-engine.ts 现状**（`src/main/modules/agent-control/turn-engine.ts:3632`）：
- `class TurnEngine.execute()` 行 888–3630（2743 行），异步函数，**非 generator**
- 16 个内嵌阶段：skill detection → child run continuation → child cancel/resume → run capability → budget/steering → 主 while loop（行 2295）→ tool dispatch → frame patch → terminal closure
- `runContract` 跨阶段共享，6 处 mutate（1399–1401, 1418–1420, 1491–1494, 2402–2445, 2680–2696, 3153）
- 主循环行 2295：`while (iterations < effectiveMaxToolIterations)`，`request.ensureNotAborted()` 在 loop head（行 2296），单点 abort 检查
- AbortController 流：`request.abortSignal` 单向下传到 `host.requestToolLoopResponse`、`host.executeToolBatch`、`tool runtime context`

**subagent-shaped existing code**：
- `SkillChildRunner` 已有 `ActiveRun { controller: AbortController, closePromise, resolveClose, outputDir, runStatePath, eventLogPath, parentNextHint }`（`skill-child-runner.ts:141–154`）
- `SkillChildDriver` 接口已存在：`skillId / ownsSkill? / canStart / canResume / createInitialState / planNextAction / observeAfterAction`（`skill-child-drivers.ts`）
- `RunCleanupRegistry` 已是统一 cleanup 模式（`run-cleanup-registry.ts:1–37`），per-runId、drain-with-timeout
- `SkillChildCloseEvent` 已是 terminal-only 模型（`skill-child-run-types.ts:66–88`）：8 状态（queued/running/recoverable_paused/budget_paused/blocked/completed/failed/killed）+ 17 terminal reasons（A0 词汇 invariant 已强制）

**没有的东西**：
- agent-control 模块**零** async generator（grep 验证）
- 无统一 `SubAgent` 抽象类型
- 无 lifecycle id ↔ artifact dir 分离合同（child-runner 把两者混在 `ActiveRun`）
- 无父子 agent 关系建模（`SkillChildRunner` 仅靠 `singleFlightKey` 做幂等，无 parent agent 引用）
- AbortController 是 flat 的（每组件自有，无 tree——v3 §B 解决，A1 仅文档化此约束）

### 0.3 §4 形态约束（Ready-specific，必须在接口体现）

引用自 v3 §4：

1. **§4.1 长任务产物持久化复用**：CC-Source 的 SubAgent 完成即销毁，产物不复用。Ready 的 VEA outputDir 必须跨 turn / 跨 session 复用。**A1 必须**：lifecycle id 与 artifact dir 是两个独立合同。
2. **§4.2 多产品共享 turn-engine**：A1 不引入 system prompt 装配；`SubAgent` 接受 caller 提供的 system prompt（caller = 未来的 Coordinator），但 A1 阶段 caller 是测试代码或 PoC 自己。
3. **§4.3 跨进程恢复**：A1 仅在接口预留 `restoreFrom(persistedState)` 钩子（type-level），**不实现**——B 阶段用 `markRowProcessRestarted` 路径填空。
4. **§4.4 测试可见性**：A1 的 contract test 模式是 abstraction 的一部分，写入接口注释 + verify:a1 强制运行。

---

## 1. Goals — Hard Contracts CI Verifies

按原则 1（先合同后代码），A1 land 后 CI 必须能机器验证下列 5 条合同：

### C1. SubAgent 接口存在于固定路径，类型签名稳定

```bash
test -f src/main/modules/agent-control/sub-agent/sub-agent-types.ts
test -f src/main/modules/agent-control/sub-agent/sub-agent-runner.ts
npm run typecheck  # 必通过
```

接口最低集合（详见 §3.1）：
- `SubAgent` interface
- `SubAgentLifecycleState` union
- `SubAgentContext` interface
- `SubAgentEvent` discriminated union
- `runSubAgent(subagent, context)` async generator function

### C2. PoC SubAgent 通过 contract test

```bash
npx tsx --test --test-concurrency=1 src/__tests__/sub-agent-contract.test.ts
```

contract test 必含：
- lifecycle 状态机迁移正确（pending → running → terminal）
- abort signal 触发 → cleanup 调用 + terminal state = `cancelled`
- generator 在终态后不再 yield
- 重复 abort 幂等（不抛错）
- artifact dir 与 lifecycle id 独立（同一 artifact dir 可被两次 `runSubAgent` 复用）

### C3. SubAgent 单向依赖：`agent-control/sub-agent/` 不依赖现有 child-runner

```bash
node scripts/check-subagent-isolation.cjs
```

新 script 实现：
- grep `src/main/modules/agent-control/sub-agent/` 下所有文件
- 拒绝 `import .* from '\.\./skill-child-runner'`、`'\.\./skill-child-drivers'`、`'\.\./skill-child-run-types'`
- 仅允许 import：node 内置、`run-cleanup-registry`（已有的统一 cleanup）、`tool-error-metrics`（已有的统一 metric registry）

理由：A1 的目的是**建立**抽象，不是绕过现有代码内化形态。如果 sub-agent/ 依赖 child-runner，A1 就退化为 child-runner 的 wrapper，B 阶段的迁移就无目的地。

### C4. 现有 child-runner 文件零变更

```bash
git diff main..HEAD -- src/main/modules/agent-control/skill-child-runner.ts \
  src/main/modules/agent-control/skill-child-drivers.ts \
  src/main/modules/agent-control/skill-child-run-types.ts | wc -l
# 预期: 0
```

如果有变更说明 A1 越界。允许例外：B 准入 gate 文档（`docs/superpowers/plans/...`）—— 那是 plan 不是代码。

### C5. `verify:a0` + `verify:a05` 无 regression

```bash
npm run verify:a0   # exit 0
npm run verify:a05  # exit 0
```

A0 / A0.5 的所有合同（baseline 不增加、plan-pairing、commit-msg、词汇 invariant）继续成立。

### Bonus（可选，建议落入）

- C6: `runSubAgent` generator 的 event 顺序符合 spec（`subagent_started → ... → subagent_terminal`，且 terminal 后 done=true）
- C7: 新增 `verify:a1` npm script 串联 C1–C5

---

## 2. Out-of-scope（明确不做）

按原则 4（形态意识），下列项**不**在 A1：

| 项 | 为什么不做 | 留给哪个阶段 |
|---|---|---|
| 把 `SkillChildRunner` 改造成 SubAgent | A1 只做 skeleton，§6.1 明令 | **B** |
| 引入 AbortController 树 / parent-child 信号链 | 现有是 flat，先建立类型再统一信号；混在 A1 会变成大爆炸 PR | **B** |
| Coordinator role / system prompt 优先级链 | 不属于 SubAgent 抽象层 | **C** |
| 把 turn-engine.execute() 改造为 generator | §5.1 提到的"generator 化骨架"在 A1 仅指 `runSubAgent` 自身是 generator；execute() 不动 | **C/D** |
| Reminder registry / 分层 compaction / Hook system | 独立子系统 | **D** |
| OutputDir GC / atomic write / PermissionContext | SubAgent 框架内统一实现 | **E** |
| 测试规约文档化（`SubAgentContractTest`）成为 lint rule | A1 仅写第一份 contract test 作为模板，rule 化等多个 PoC 再说 | **F** |
| 把 `RSSSubagentRunner` 改造成 SubAgent | 它是命名误用（实为 LLM-helper），不属于"独立 lifecycle 长任务"；命名清理是 N1 级技术债 | **G**（命名 cleanup） |

---

## 3. Architecture Decisions（先于任务划分）

### D1. SubAgent 是 contract，不是 class

A1 把 `SubAgent` 定义为 interface（`type SubAgent = { ... }` 或 TS interface），**不**定义 abstract class。

理由：
- TS class 继承会强制 SubAgent 实现共享方法签名，违背"抽象边界 = 形态差异"（CLAUDE.md 待落地的原则 6）
- 不同 SubAgent 实现（VEA / Browser / RSS）形态差异巨大；强制共享继承会导致基类膨胀
- 用 interface + factory function 模式，让每个实现自由组织内部状态

PoC 实现 → factory function 返回 `SubAgent` 对象字面量，不 `extends` 任何东西。

### D2. lifecycle id ≠ artifact dir（§4.1 形态本地化）

```typescript
interface SubAgent {
  readonly id: string                // lifecycle 身份，每次启动唯一（uuid）
  readonly artifactDir: string | null  // 持久化产物根目录，可选；可被后续 SubAgent 复用
  // ...
}
```

合同：
- `id` 必须在每次 `runSubAgent` 启动时新生（即使 artifactDir 复用）
- `artifactDir` 由 caller 决定（caller 知道是不是要复用）
- A1 的 PoC 不实际写文件——`artifactDir = null` 即可，但类型必须支持 string

### D3. Lifecycle state 直接复用 child-runner 的 8 态词汇 + 父子关系字段

```typescript
type SubAgentLifecycleState =
  | 'pending'     // 创建后未 run
  | 'running'
  | 'paused'      // budget / recoverable / external 三种 child-runner 现状的统一抽象
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'   // child-runner 的 'killed' 在 SubAgent 层重命名（更清晰）
```

7 态比 child-runner 的 8 态少 1 个：把 `recoverable_paused` / `budget_paused` 归并为 `paused`，B 阶段迁移时再细分（用 `pauseReason` 字段表达，不增加状态枚举）。

`killed` → `cancelled`：A0 词汇 invariant 不禁止；新抽象用更清晰的词。B 阶段保留旧 `killed` 作 child-runner 的内部细节（不影响 SubAgent 层 contract）。

### D4. SubAgent 的 abort 是 flat（不实现 tree）

A1 的 SubAgent 接口含 `abortSignal: AbortSignal`，`runSubAgent(subagent, ctx)` 在 ctx 中接收。SubAgent 内部 owns 自己的 cleanup；caller owns abort source。

**不**做：
- 父 SubAgent 引用子 SubAgent 的 controller
- AbortController 树自动 propagate
- 父 abort 时 cascade 子 abort

理由：B 阶段才合并 child-runner，那时再做 tree——因为只有那时"父子 SubAgent"才是真实存在的关系。A1 单独的 PoC 没有父子，做 tree 是为不存在的需求设计。

文档化（写入 `sub-agent-types.ts` 顶部块注释）：
> **AbortSignal contract (A1)**: SubAgent 接收单一 AbortSignal，自管 cleanup。父子 SubAgent 之间的信号 propagation **不**在 A1 范围。B 阶段引入 child-runner 迁移时，统一引入 AbortController 树。

### D5. Generator yield contract 固定

```typescript
type SubAgentEvent =
  | { type: 'started'; id: string; subagentName: string }
  | { type: 'progress'; id: string; message: string; payload?: unknown }
  | { type: 'paused'; id: string; reason: string }
  | { type: 'terminal'; id: string; state: SubAgentLifecycleState; closeEvent: SubAgentCloseEvent }

async function* runSubAgent(
  subagent: SubAgent,
  context: SubAgentContext,
): AsyncGenerator<SubAgentEvent, SubAgentCloseEvent, void>
```

合同（contract test 验证）：
- 第一个 event 必为 `started`
- 最后一个 event 必为 `terminal`
- `terminal` 之后 `next()` 返回 `{ done: true, value: closeEvent }`
- 中间可有 0..N 个 `progress` / `paused` event
- abort 触发 → 立即 yield `terminal` event with `state: 'cancelled'`，generator return

### D6. PoC = `EchoSubAgent`，纯测试用

A1 的 PoC 是 `EchoSubAgent`：接收一个 `string[]` payload，依次 yield 每条作为 `progress` event，最后 `terminal: completed`。

不依赖任何 Ready 业务模块（不依赖 skills、browser、document）。仅依赖：
- `node:crypto`（生成 id）
- `RunCleanupRegistry`（验证 cleanup wiring）

PoC 价值：**证明 abstraction 可实现**，让 contract test 有载体。如果 EchoSubAgent 都写不出来，说明接口设计有问题。**不是产品功能**。

### D7. 文件布局

新建目录与文件（**全部新增，零修改现有文件**，例外：plan/doc + npm script + ESLint rule 注册）：

```
src/main/modules/agent-control/sub-agent/
  sub-agent-types.ts             # D1-D5 类型定义
  sub-agent-runner.ts            # runSubAgent generator 实现
  sub-agent-cleanup.ts           # 包装 RunCleanupRegistry，让 SubAgent 用单一入口
  poc/
    echo-subagent.ts             # D6 PoC

src/__tests__/
  sub-agent-contract.test.ts     # C2 contract test
  sub-agent-runner.test.ts       # generator 内部行为测试

scripts/
  check-subagent-isolation.cjs   # C3 单向依赖检查

eslint-rules/
  a0-rule-utils.mjs              # +RULE_IDS.subAgentLeak（仅注册，rule 实现简单）
  index.mjs                      # +'no-subagent-leak' rule

# Plan & docs（更新）
docs/archive/2026-09-06/docs/superpowers/plans/2026-04-30-skill-runtime-agent-layer-reframe.md  # §5.1 A1 [x] marker
docs/archive/2026-09-06/docs/superpowers/plans/2026-04-30-A1-subagent-skeleton-implementation.md # 本文件
```

---

## 4. Team 划分（4 队，串行 + 局部并行）

```
W1 (Types) ──┬──> W2 (Runner) ──┬──> W3 (PoC + Tests) ──┐
             │                   │                        │
             └───────────────────┴──> W4 (Boundary + Verify) ──> verify:a1 绿
```

W1 必须先 land；W2、W4 可并行（W4 依赖 W1 但不依赖 W2 实现，仅依赖 W1 类型）；W3 依赖 W1+W2 全部 land。

### W1 — SubAgent 类型骨架

**Owner agent type**: general-purpose

**目标文件**：
- `src/main/modules/agent-control/sub-agent/sub-agent-types.ts`（新）

**改动清单**：

1. 文件顶部 `block comment` 写入：
   - 设计目标（节选自 §0.3 §4 形态约束）
   - AbortSignal contract A1 限制（D4 文档化）
   - lifecycle vocabulary 与 child-runner 的对照（D3）
   - artifact dir 形态约束（D2）

2. 导出类型集合（最小集合，不要扩张）：
   ```typescript
   export type SubAgentLifecycleState = ... // D3 7 态

   export interface SubAgentContext {
     readonly abortSignal: AbortSignal
     readonly cleanup: SubAgentCleanupHandle  // 见 W2 sub-agent-cleanup.ts
     readonly logger?: { info: (msg: string, meta?: unknown) => void }
     // 可选：未来扩展 systemPrompt / parentScopeId 等，A1 先不放
   }

   export interface SubAgentCloseEvent {
     readonly id: string
     readonly state: SubAgentLifecycleState
     readonly terminalAt: number   // ms epoch
     readonly progressFingerprint?: string | null
     readonly artifactDir?: string | null
     readonly error?: { kind: string; message: string } | null
   }

   export type SubAgentEvent =
     | { readonly type: 'started'; readonly id: string; readonly subagentName: string }
     | { readonly type: 'progress'; readonly id: string; readonly message: string; readonly payload?: unknown }
     | { readonly type: 'paused'; readonly id: string; readonly reason: string }
     | { readonly type: 'terminal'; readonly id: string; readonly closeEvent: SubAgentCloseEvent }

   export interface SubAgent {
     readonly id: string
     readonly subagentName: string
     readonly artifactDir: string | null
     run(context: SubAgentContext): AsyncIterable<SubAgentEvent>
     // restoreFrom(persisted) — 形态预留，A1 不强制实现，使用 `(persisted: unknown) => SubAgent | null` 签名
     restoreFrom?(persisted: unknown): SubAgent | null
   }
   ```

3. **不**导出任何 class、不 import 任何 child-runner / skill-child-* / turn-engine 文件。

**验收**：
- typecheck 过
- `node scripts/check-subagent-isolation.cjs` 不抱怨该文件（W4 land 后才能跑，但 W1 land 时手动 grep `import.*skill-child` 应零结果）

---

### W2 — runSubAgent generator + cleanup wiring

**Owner agent type**: general-purpose

**目标文件**：
- `src/main/modules/agent-control/sub-agent/sub-agent-cleanup.ts`（新）
- `src/main/modules/agent-control/sub-agent/sub-agent-runner.ts`（新）

**改动清单**：

1. **`sub-agent-cleanup.ts`**: 包装 `RunCleanupRegistry`，对 SubAgent 暴露简单 API：
   ```typescript
   export interface SubAgentCleanupHandle {
     register(callback: () => void | Promise<void>): void
     drain(): Promise<void>
   }

   export function createSubAgentCleanup(opts: {
     id: string
     timeoutMs?: number  // 默认 1500ms（与 RunCleanupRegistry 同），上限 5000ms
   }): SubAgentCleanupHandle
   ```
   实现内部 hold 一个 `RunCleanupRegistry` 实例（**复用现有**，不复制粘贴），用 SubAgent.id 作为 runId key。

2. **`sub-agent-runner.ts`**: 实现 `runSubAgent` 生成器：
   ```typescript
   export async function* runSubAgent(
     subagent: SubAgent,
     context: SubAgentContext,
   ): AsyncGenerator<SubAgentEvent, SubAgentCloseEvent, void>
   ```
   职责：
   - 入口 yield `started` event
   - 委托给 `subagent.run(context)`，逐个 yield 收到的 event
   - 监听 `context.abortSignal`：
     - 已 abort → 立即 yield `terminal` with `state: 'cancelled'`，调 `context.cleanup.drain()`，return closeEvent
     - 中途 abort → 同上
   - subagent.run() 抛错 → yield `terminal` with `state: 'failed'`，包装 error，调 cleanup.drain()，return
   - 正常完成（subagent.run() 自行 yield `terminal`）→ 透传 closeEvent，调 cleanup.drain()，return
   - 任何路径都**保证** cleanup.drain() 被调用，且只调用一次（用 once flag）
   - 任何路径都**保证** terminal event 是最后一个

3. **不**实现：
   - 父子 SubAgent
   - AbortController.linkChild
   - Persistent state save / restore（`subagent.restoreFrom` 类型预留，runner 不调用）

**复用的现有工具**：
- `RunCleanupRegistry`（`src/main/modules/agent-control/run-cleanup-registry.ts`）
- 不复用其他 child-runner / skill-child-* 代码

**验收**：
- typecheck 过
- W3 contract test 验证 generator 行为

---

### W3 — Echo PoC + Contract Tests

**Owner agent type**: general-purpose

**目标文件**：
- `src/main/modules/agent-control/sub-agent/poc/echo-subagent.ts`（新）
- `src/__tests__/sub-agent-contract.test.ts`（新）
- `src/__tests__/sub-agent-runner.test.ts`（新）

**改动清单**：

1. **`echo-subagent.ts`**: 实现 PoC：
   ```typescript
   export function createEchoSubAgent(opts: {
     payload: string[]
     artifactDir?: string | null
     subagentName?: string
   }): SubAgent
   ```
   `subagent.run(ctx)` 是 async generator：
   - 对每条 `payload[i]`：
     - 检查 `ctx.abortSignal.aborted`（abort → 不再 yield，让 runner 处理）
     - yield `progress` event
     - `await sleep(0)`（让出 microtask，模拟真实 SubAgent 的异步等待）
   - 全部完成后 yield `terminal` with `state: 'completed'`
   - 注册一个 cleanup 回调（`ctx.cleanup.register(() => { /* sentinel */ })`）用于测试验证

2. **`sub-agent-contract.test.ts`**: 5 个 it（精确名，可 grep）：
   ```ts
   it('runSubAgent yields started event first then progress events in payload order', ...)
   it('runSubAgent yields terminal event last and closeEvent.state is completed for happy path', ...)
   it('aborting via context.abortSignal yields terminal with state cancelled and drains cleanup', ...)
   it('idempotent abort (abort twice) does not throw and produces single terminal event', ...)
   it('artifact dir is independent of lifecycle id (two SubAgent runs share same artifactDir without state leakage)', ...)
   ```
   每个 it 用 `for await` 收集 events 到数组，然后断言序列。

3. **`sub-agent-runner.test.ts`**: 4 个 it（runner 内部行为）：
   ```ts
   it('cleanup.drain is called exactly once on happy path', ...)
   it('cleanup.drain is called exactly once on abort path', ...)
   it('cleanup.drain is called exactly once on subagent throw path', ...)
   it('subagent throw produces failed terminal with error.kind set to error.name', ...)
   ```
   用 spy 包装 cleanup callback，断言调用次数。

4. **不**测试：
   - 真实 child-runner 行为（不在 A1 范围）
   - 真实 turn-engine 集成
   - 跨进程 restore（`restoreFrom` 不实现）

**禁止反模式**（A0/A0.5 已强制）：
- ❌ 不允许 `readFileSync` source-grep 测试
- ❌ 不允许 `JSON.stringify(...).includes(...)`
- ❌ 不允许 `test.skip` / `xtest`
- ❌ 不允许引入新的 baseline.json 条目

**验收**：
- 9 个 it 全绿
- `npm run lint:check` 0 errors
- `node scripts/check-eslint-baseline.cjs --area a1-gate --max 0` 通过

---

### W4 — Boundary Enforcement + Verify Script + Doc Update

**Owner agent type**: general-purpose

**目标文件**：
- `scripts/check-subagent-isolation.cjs`（新）
- `eslint-rules/a0-rule-utils.mjs`（修改：注册 `subAgentLeak` rule id）
- `eslint-rules/index.mjs`（修改：导出 `no-subagent-leak` rule）
- `eslint.config.mjs`（修改：启用新 rule，仅在 `agent-control/sub-agent/**` 路径）
- `package.json`（修改：新增 `verify:a1` script）
- `docs/archive/2026-09-06/docs/superpowers/plans/2026-04-30-skill-runtime-agent-layer-reframe.md`（修改：§5.1 表格 A1 行 `[x] completed YYYY-MM-DD`）

**改动清单**：

1. **`check-subagent-isolation.cjs`** —— C3 合同实现：
   - 用 `node:fs` + `node:path` 递归扫描 `src/main/modules/agent-control/sub-agent/**/*.ts`
   - 对每个文件，正则匹配 `import .* from ['"]([^'"]+)['"]`
   - 拒绝清单（任一命中即 exit 1，输出违规位置）：
     - 任何 `skill-child-*` 路径
     - 任何 `turn-engine` 路径
     - 任何 `run-coordinator` 路径
     - 任何 `domain-adapter` 路径
   - 允许清单（命中允许）：
     - node 内置 `node:*`
     - 同目录或子目录相对 import
     - `../run-cleanup-registry`
     - `../tool-error-metrics`
     - 第三方包（无相对路径前缀）
   - 任何不在允许清单也不在拒绝清单的相对 import → exit 1（白名单制）
   - 通过则 exit 0，输出 `subagent isolation: ok`

2. **ESLint rule `no-subagent-leak`** —— 防止反向泄漏（现有 child-runner 文件不能 import sub-agent）：
   - `a0-rule-utils.mjs`: 在 `RULE_IDS` 添加 `subAgentLeak: 'subAgentLeak'`，在 `scanRuleViolations` 添加对应实现：
     - 仅对 `src/main/modules/agent-control/skill-child-*.ts` 与 `turn-engine.ts` 文件生效
     - 检测 `from ['"][^'"]*sub-agent[^'"]*['"]` 模式
     - 命中即报告
   - `index.mjs`: 添加 `'no-subagent-leak': createBaselineAwareRule(RULE_IDS.subAgentLeak, { description, messageId, message })`
   - `eslint.config.mjs`: 在合适的 override block 启用该 rule（具体配置位置参考现有 `no-source-grep-test` rule 的注册）

3. **`package.json` `verify:a1` script**：
   ```json
   "verify:a1": "npm run typecheck && npm run lint:check && node scripts/check-eslint-baseline.cjs --area a1-gate --max 0 && node scripts/check-subagent-isolation.cjs && npx tsx --test --test-concurrency=1 src/__tests__/sub-agent-contract.test.ts src/__tests__/sub-agent-runner.test.ts"
   ```

4. **更新 v3 路线 §5.1**：
   - 在 A1 行追加 `[x] completed <commit-date>`，commit hash 占位 `(commit hash)` 让 commit 时填
   - 在 §5.1 表后追加 §5.1.1 "B 阶段准入" 段：
     > **B（Child Runtime 迁移）准入**：A1 的 5 条 hard contract 全部 land，`verify:a1` 退出码 0，C3 单向依赖检查通过。B 阶段允许首次反向引用（child-runner 实现 SubAgent interface），但需在 B 启动 PR 同时移除 `no-subagent-leak` rule 对 child-runner 路径的限制。

**验收**：
- `npm run verify:a1` exit 0
- `node scripts/check-subagent-isolation.cjs` exit 0
- ESLint 跑全仓 0 errors
- §5.1 文档更新

---

## 5. 端到端验证

每队 land 后跑：

```bash
# 1. 类型 + lint baseline
npm run typecheck
npm run lint:check

# 2. A0 / A0.5 / A1 三层闸门
npm run verify:a0
npm run verify:a05
npm run verify:a1

# 3. 焦点测试
npx tsx --test --test-concurrency=1 \
  src/__tests__/sub-agent-contract.test.ts \
  src/__tests__/sub-agent-runner.test.ts

# 4. 单向依赖检查
node scripts/check-subagent-isolation.cjs

# 5. Layer 1 / 现有 child-runner 测试零回归
npx tsx --test --test-concurrency=1 \
  src/__tests__/skill-child-runner.test.ts \
  src/__tests__/skill-child-runner-resume-lifecycle.test.ts \
  src/__tests__/skill-child-feature-flags.test.ts \
  src/__tests__/turn-engine-route.test.ts

# 6. git diff 验证现有 child-runner / turn-engine 文件零变更
git diff main..HEAD -- \
  src/main/modules/agent-control/skill-child-runner.ts \
  src/main/modules/agent-control/skill-child-drivers.ts \
  src/main/modules/agent-control/skill-child-run-types.ts \
  src/main/modules/agent-control/turn-engine.ts \
  | wc -l
# 预期: 0
```

---

## 6. 风险与缓解

### 6.1 抽象设计错位

**风险**：A1 的 SubAgent 接口与 B 阶段实际迁移 child-runner 时的需求不匹配，B 必须修 A1 的接口（破坏稳定性）。

**缓解**：
- W1 类型定义阶段，写完后**先跑 W3 PoC**，再让 codex 把 `SkillChildRunner` 的核心方法签名（`startSkillChildRun / resumeSkillChildRun / cancelSkillChildRun / waitForClose`）映射到 `runSubAgent` 调用上，做 paper PoC（不写代码，只在 plan 注释里画对应表）。如果某个方法找不到映射，说明接口缺。
- 在 W1 定义中预留 `restoreFrom` 钩子（D2/§4.3）即使 A1 不实现，避免 B 阶段被迫加字段。

### 6.2 PoC 失真

**风险**：EchoSubAgent 太简单，contract test 全过但发现真实 SubAgent（B 阶段）需要的能力 A1 没暴露。

**缓解**：
- W3 contract test 写 5 条 it 而非 1 条，每条对应 D1-D5 的不同合同。
- 第 5 条 `artifact dir is independent of lifecycle id` 直接验证 §4.1 形态。
- W4 `verify:a1` 强制运行所有 contract，PR review 时检查"5 条 it 名是否对应 D1-D5"。

### 6.3 边界规则反向泄漏

**风险**：A1 land 后某次开发不小心从 child-runner 引用 sub-agent/，污染单向依赖。

**缓解**：
- C3（`check-subagent-isolation.cjs`）+ ESLint `no-subagent-leak` rule 双重防护
- ESLint rule 用 baseline-aware 模式（与 `no-source-grep-test` 同模式），允许将来 B 阶段移除限制时不需要改 rule 实现，只改 ESLint config 的 path filter

### 6.4 工期失控

**风险**：A1 计划工期 5-7 天，但因为是首次定义新抽象层，可能持续讨论接口形态。

**缓解**：
- 本 plan 已 freeze D1-D7 设计决策；codex 执行时**不**重新讨论形态，只能在违反 §4 形态约束时报告问题
- W1 类型完成 = 0.5 天，W2 generator = 1.5 天，W3 PoC + tests = 2 天，W4 boundary + doc = 1 天，缓冲 1-2 天
- 如果 W2 实现遇到 generator + abort + cleanup 的 race condition 难解，回退到 callback 模式（牺牲 D5 generator 形态）作为 fallback——但需 ESCALATE 给 plan owner 确认

---

## 7. 关键文件路径速查

**新建**（W1-W4）：
- `src/main/modules/agent-control/sub-agent/sub-agent-types.ts`
- `src/main/modules/agent-control/sub-agent/sub-agent-cleanup.ts`
- `src/main/modules/agent-control/sub-agent/sub-agent-runner.ts`
- `src/main/modules/agent-control/sub-agent/poc/echo-subagent.ts`
- `src/__tests__/sub-agent-contract.test.ts`
- `src/__tests__/sub-agent-runner.test.ts`
- `scripts/check-subagent-isolation.cjs`

**修改**（仅 W4）：
- `eslint-rules/a0-rule-utils.mjs`（注册 RULE_IDS.subAgentLeak）
- `eslint-rules/index.mjs`（导出 no-subagent-leak rule）
- `eslint.config.mjs`（启用新 rule on agent-control/skill-child-*.ts + turn-engine.ts）
- `package.json`（添加 verify:a1 script）
- `docs/archive/2026-09-06/docs/superpowers/plans/2026-04-30-skill-runtime-agent-layer-reframe.md`（§5.1 [x] marker + §5.1.1 B 准入段）

**严禁修改**（C4 验证）：
- `src/main/modules/agent-control/skill-child-runner.ts`
- `src/main/modules/agent-control/skill-child-drivers.ts`
- `src/main/modules/agent-control/skill-child-run-types.ts`
- `src/main/modules/agent-control/skill-child-error-mapping.ts`
- `src/main/modules/agent-control/turn-engine.ts`

---

## 8. A1 Acceptance — Recorded 2026-05-01

- C1 ✅ — `npm run typecheck` exit 0；SubAgent type / cleanup / runner / Echo PoC 文件存在。
- C2 ✅ — `npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/sub-agent-contract.test.ts src/__tests__/sub-agent-runner.test.ts`：8 tests pass。
- C3 ✅ — `node scripts/check-subagent-isolation.cjs` exit 0。
- C4 ✅ — `node scripts/check-a1-boundary.cjs --base c176fcf16c2e284f767b815e25c7521c9c6d1125` exit 0。
- C5 ✅ — `npm run verify:a1` exit 0；`npm run verify:a0` exit 0；`npm run verify:a05` exit 0。
- C6 ✅ — generator event order spec 已由 SubAgent contract / runner tests 覆盖：`started` first、`terminal` last、terminal 后 return close event。
- C7 ✅ — `verify:a1` npm script 已落地。
- A1_BASE ✅ — `c176fcf16c2e284f767b815e25c7521c9c6d1125`。

**B 阶段（Child Runtime → SubAgent 特化）admission gate 现已打开。**

第一个 B 阶段 PR 启动时：
1. 写 plan `2026-XX-XX-B-child-runtime-subagent-migration-implementation.md`。
2. 在该 plan 引用本 plan commit hash。
3. 移除 `scripts/check-a1-boundary.cjs`（独立 commit）。
4. 移除 `verify:a1` script 中对 `check-a1-boundary.cjs` 的调用。
5. 移除 `ready/no-subagent-leak` rule 对 child-runner 迁移路径的限制。
6. child-runner 改造为 `function createSkillChildSubAgent(...): SubAgent`。

---

## 9. 与战略原则的对应

| 原则 | A1 体现 |
|---|---|
| 1. 先合同后代码 | §1 列出 5 条 hard contract，CI 可机器验证。**先有合同再有 code**。 |
| 2. 修根因不修症状 | A1 不修任何 bug。但建立的 SubAgent abstraction 是 child-runner 系列 bug 复发的元根源解，B 阶段一次性消解 root cause 0。 |
| 3. 拒绝 legacy 兼容分支 | A1 不引入 `if (subagentEnabled) { newPath } else { oldPath }`。SubAgent 是新建抽象，不与 child-runner 共存于同一 callsite。 |
| 4. 形态意识 | §4 写明哪些 CC-Source 形态**不**抄（没有父子树、没有 fork、没有 system prompt 链），哪些 Ready 形态必须本地化（artifact dir 复用、cross-process recovery 预留）。 |
| 5. CI 强制 > 文档约束 > 人审 | C1-C5 全部 CI 强制；§4 形态约束写入接口注释（文档）；不依赖人审。 |

---

## 10. 完成判据汇总

| 队 | 完成判据 |
|---|---|
| W1 | sub-agent-types.ts 编译通过；类型签名匹配 §3.1 D1-D5；不依赖 child-runner |
| W2 | runSubAgent generator 按 D5 yield 顺序产出 events；abort + cleanup 正确 wired |
| W3 | sub-agent-contract.test.ts 5 it 全绿；sub-agent-runner.test.ts 4 it 全绿 |
| W4 | check-subagent-isolation.cjs exit 0；no-subagent-leak ESLint rule 注册并启用；verify:a1 script 落地；§5.1 [x] marker + §5.1.1 准入段更新 |
| 集成 | 现有 child-runner / turn-engine 文件零变更；verify:a0 + verify:a05 + verify:a1 全绿 |

---

## 11. Codex 执行注意

1. **严守边界**：不要"顺手"改 child-runner 或 turn-engine。任何对它们的修改都违反 C4。
2. **不抄就 review**：写 sub-agent-runner.ts 时如果 lookup 了 child-runner 的实现作参考，**不要复制粘贴**——SubAgent skeleton 是新设计，借鉴形态可以，复制代码不可以。
3. **Contract test 先于实现**：W3 阶段建议先写 contract test 让它**失败**，再实现 PoC 让它通过（TDD）。如果 PoC 写完后 contract test 一次过——回头审查 contract test 是否真在测合同，还是在测实现细节。
4. **形态不抄 CC-Source**：D4 已明令 abort 不做 tree。如果觉得"那 SubAgent 不就是 useless wrapper 嘛"——那就是对的，A1 就是要建立一个看起来 useless 的骨架，B 阶段才赋予它实际价值。**不要试图在 A1 内塞入"有用"的能力**。
5. **W1 完成后立即 paper PoC**：把 `SkillChildRunner.startSkillChildRun / resumeSkillChildRun / cancelSkillChildRun / waitForClose` 4 个方法在 `sub-agent-types.ts` 文件末尾的注释里映射到"如果是 SubAgent，会是什么形态"，让 plan owner review 接口完整性。这个 paper PoC **不写代码**，纯文字。

---

## 12. 与未来阶段（B/C/D/E）的接口锁定

A1 land 后，以下接口对未来阶段视为**已锁定**（修改需写新 plan + counter-proposal）：

- `SubAgent` interface 的字段集合（D1）
- `SubAgentLifecycleState` union 的成员（D3）
- `SubAgentEvent` discriminated union 的形状（D5）
- `runSubAgent` generator 的 yield 序列契约（D5）
- `SubAgentContext` 必含 `abortSignal` + `cleanup`（D4）

允许扩展（无须新 plan）：
- `SubAgentContext` 添加新字段（如 `systemPrompt`、`parentSubAgentId`）—— 添加为 optional
- `SubAgentEvent` 添加新 type 成员（如 `'tool_call'`、`'state_observed'`）—— discriminated union 易于扩展
- `SubAgent` 添加新 optional 方法（如 `pause`、`getProgressFingerprint`）

不允许扩展（需 plan）：
- 修改任何已有字段类型
- 删除任何已有字段
- 修改 generator yield 顺序契约
- 引入 inheritance / abstract class

---

> 本 plan 是 v3 路线 A1 阶段的唯一权威实施依据。任何与本 plan 冲突的实现细节，以本 plan 为准；plan 本身需要修改时，写 counter-proposal + 新 plan。
