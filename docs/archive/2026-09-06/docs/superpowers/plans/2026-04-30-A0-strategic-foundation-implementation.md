---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# A0 — 战略地基阶段实施计划

> **此文件是 implementation plan，不是 counter-proposal。**
> Codex 据此直接执行，**禁止跳过 plan 步骤直接改代码**——这条规则本身就是 A0 阶段的产出之一。
>
> **依据**：路线 v3 见 `docs/archive/2026-09-06/docs/superpowers/plans/2026-04-30-skill-runtime-agent-layer-reframe.md` §5.1。
> **原则锚点**：`CLAUDE.md §0.5` + `.claude/architectural-principles.md`。
> A0 阶段的存在意义：把那 5 条原则从文档级提升到 CI 强制级，否则后续 A1（SubAgent 抽象）阶段没有地基。

---

## Audit Patch（Codex 2026-04-30 实地核查 + Claude 反向修订）

> Codex 用 3 个只读 explorer 实地 grep + 现实约束核查，找出本 plan 原文里的 7 处不可执行点。Claude 在此之上加 2 项反向修订（baseline 机制 + A0.5 cleanup plan）。**当本 patch 与下文正文冲突时，以 patch 为准**。
>
> **执行声明（2026-04-30 A0 落地版）：worker 只按本 Audit Patch 的 W0-W4 执行；下文正文里的 Team 1-4 只保留为背景材料，不作为执行指令。**

### Codex 实地核查发现的硬事实

1. **ESLint 是 v9 flat config + `type: module`**——下文 §1 D2 / §4-5 用 `.eslintrc.cjs` + `module.exports` 的写法**直接不贴合**。本地 plugin 与配置都必须 ESM (`export default`) + `eslint.config.mjs` 注册。
2. **`npm run lint` 会自动修文件**——所有验收命令必须改用 `npm run lint:check`，否则验收行为会无声修代码。
3. **`'infra_error'` 写入端不止 9 处**——还有 turn-level 写入（待 Worker 1 grep 完整列出）。`mapDriverThrowToTerminalReason` 必须**额外**新增 `'persistence_failed'` reason，区别于 `'host_unavailable'`（DB 写失败 ≠ host 网络不可达，运维处理路径不同）。
4. **source-grep 反模式不止 `tool-internal-admission.test.ts` 一处**——`src/__tests__/` 下大量 contract 测试都在用 `readFileSync + assert.match`。**一次性清历史不现实**；改为"禁新增 + baseline grandfather + A0.5 cleanup plan"三段式（详见反向修订 1）。
5. **`lint:check` 当前已有 23 errors**——baseline 在新规则启用前必须清掉，否则"启用新 rule 后全仓绿"不可达。新增 **Worker 0 — 先清 lint baseline**。
6. **`@{u}` 在没 upstream 的分支会失败**——`check-plan-pairing.cjs` 必须 fallback 到 `main` / `merge-base`，不能因为 `@{u}` 不存在就放行违例。
7. **当前仓未装 Husky**——A0 阶段不引入 Husky 依赖；plan/commit hook 做成"CI + 本地脚本可调用"的形式（详见 §6 修订）。

### Claude 反向修订（必须叠加在 Codex 方案上）

1. **ESLint baseline 文件机制（针对 §A0.2）**：
   - 新建 `eslint-rules/baseline.json`（或同形 ignore-list 文件），列入所有现有 source-grep 违例的 `file + rule + snippetHash` 身份；`line` 只作显示信息，不能参与稳定身份。
   - rule 实现读 baseline，对 baseline 内的违例**降级为 warning**（或 silent），baseline 外的新增违例**直接 error**。
   - 增量脚本 `scripts/check-eslint-baseline.cjs`：读当前 lint 输出 + baseline，**违例数只能减少不能增加**——增加即 CI 失败。
   - 这是把 Codex 的"禁新增"做成可机器验证的合同，避免 grandfather 变成"永远不修"。
2. **A0.5 cleanup plan 是 A1 准入硬条件**：
   - A0 完成后立刻产出 `docs/archive/2026-09-06/docs/superpowers/plans/2026-04-30-A0.5-source-grep-cleanup-implementation.md`（独立 plan，不在 A0 范围内执行）。
   - 该 plan 的合同分两层：agent / skill / runtime source-grep baseline 清零是 A1 硬门；UI / 样式 contract 历史债只要求 baseline 不增加。
   - **A1（SubAgent 抽象骨架）启动前 agent / skill / runtime baseline 必须为空**——这是 v3 路线的硬关卡。
   - 此条同时写入 `...agent-layer-reframe.md` §5.1 作为 A0 → A1 之间新增的 0.5 阶段（W4 收尾时一并 patch）。
3. **W0 必须先出 23 errors 分类清单**：
   - Worker 0 第一动作：跑 `npm run lint:check`，把 23 errors 输出 dump 到 `docs/archive/2026-09-06/docs/superpowers/plans/A0-W0-baseline-cleanup.md`，按 "可安全修 / 需要审 / 历史保留（加 ignore comment）" 三类分类。
   - **分类清单 review 通过后**才动手清，避免"顺手清"破坏其它代码。

### 修订后的 Worker 划分（覆盖原 §2）

| Worker | 内容 | 依赖 | 工期 |
|---|---|---|---|
| W0 | 先清 lint baseline 的 23 errors（warnings 不动；先出分类清单） | 无 | 0.5-1 天 |
| W1 | §A0.1 词汇 invariant（**额外加 `'persistence_failed'`**；grep 完整违例清单不只 runner） | W0 land 后 | 1 天 |
| W2 | §A0.2 + §A0.3 ESLint plugin（**flat config + ESM**；source-grep 走 **baseline 机制**；只重写 `tool-internal-admission.test.ts` 一处历史违例，其它进 baseline） | W0 land 后 | 1 天 |
| W3 | §A0.4 plan/commit hook（**不引入 Husky**；CI + 本地可调用脚本；`@{u}` fallback 到 main/merge-base） | 不依赖其它 | 0.5 天 |
| W4 | 集成验收（用 `lint:check` 不用 `lint`；负向 fixture 7 件 + A0.5 plan 文件落地 + v3 路线 §5.1 patch） | 等 W0-W3 | 0.5 天 |

W1/W2/W3 在 W0 land 之后可并发；W4 串行。**总工期 ≈ 2.5-3 天**（之前 plan 原文估的 1.5-2 天太乐观）。

### 修订后的验收命令清单（覆盖原 §8）

```bash
# 1. 类型
npm run typecheck

# 2. lint check（不自动修；A0 必须使用 :check 形式）
npm run lint:check

# 3. ESLint baseline 增量检查（baseline 行数只能减不能增）
node scripts/check-eslint-baseline.cjs

# 4. 焦点测试（与原 §8 同）
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/skill-child-error-mapping.test.ts \
  src/__tests__/skill-child-state-machine.test.ts \
  src/__tests__/skill-child-runner.test.ts \
  src/__tests__/skill-child-runner-resume-lifecycle.test.ts \
  src/__tests__/skill-child-feature-flags.test.ts \
  src/__tests__/turn-engine-route.test.ts \
  src/__tests__/turn-engine-force-tool-dispatch.test.ts \
  src/__tests__/skill-task-run-repository.test.ts \
  src/__tests__/tool-internal-admission.test.ts \
  src/__tests__/skill-child-run-end-to-end.test.ts

# 5. ESLint plugin 单元测试（ESM 适配）
node --test eslint-rules/__tests__/*.test.mjs

# 6. plan pairing 脚本测试（含无 upstream fallback fixture）
node --test scripts/__tests__/check-plan-pairing.test.cjs

# 7. A0 一键验收入口
npm run verify:a0

# 8. 负向 fixture 7 件（必须按预期失败 / 通过）：
#    详见下文原 §8 第 7 件 end-to-end CI 强制 fixture
```

### 修订后的 A0 完成判据（覆盖原 §10）

A0 完成 = 上面 7 件验收全过 **AND** A0.5 plan 文件已落地（写好但不用执行）+ baseline 文件冻结（行数固定）+ v3 路线 §5.1 已 patch 加入 A0.5 阶段。

**A0 完成 ≠ A1 准入。A1 准入 = A0 完成 + A0.5 完成（agent / skill / runtime source-grep baseline 清零；UI / 样式 baseline 不增加）**。

### 元教训（写入 `.claude/architectural-principles.md` 后续 patch）

我（Claude）出本 plan 原文时**没有先做实地 grep 验证**就交付——这本身违反了我刚立的原则 1（先合同后代码）。Codex 的 explorer 流程才是正确做法。后续 plan 出稿前的标准动作必须是：

> **任何 implementation plan 出稿前，必须先用 ≥1 个 read-only explorer agent 实地 grep 关键事实（typecheck/lint/grep 假设）。Plan 中所有 "grep 出 N 处违例" / "改 X 行" / "用 Y 配置" 类断言，作者必须显式标注 grep 时间戳 + 命令，否则视为推测。**

下次更新 `.claude/architectural-principles.md` 时把这一条加入"原则 1：先合同后代码"的展开部分。

---

## 0. Context

### 0.1 为什么先做 A0

5 条战略原则现在只是 Markdown，靠人审。原则 5 自己说"CI 强制 > 文档约束 > 人审"——如果 A0 不上 CI，A1 阶段引入大型重构（SubAgent 抽象 + turn-engine generator 化）会在沙地上盖楼。

### 0.2 A0 的范围

4 个子项，每项必须配可机器验证的合同：

| 子项 | 内容 | 配套合同形式 |
|---|---|---|
| §A0.1 | 删 `terminalReason: 'infra_error'` + 引入 `mapDriverThrowToTerminalReason` factory | TypeScript 编译期强制 + 单元测试 |
| §A0.2 | ESLint rule 禁 source-grep 反模式（B3 类） | 自定义 ESLint rule + 现有违例修完 |
| §A0.3 | 复发签名机器化（legacy conditional / legacy optional param / TODO remove after migration） | 自定义 ESLint rule × 3 + commit-msg hook |
| §A0.4 | Plan 工作流 hook（counter-proposal → plan 强制配对） | CI + 本地可调用脚本（A0 不引入 Husky） |

### 0.3 A0 完成的判据（最重要的事）

A0 完成 ≠ 上面 4 件做完。A0 完成 = **后续 PR 在违反任何一条 5 原则时，CI 自动红**。

具体地：

- 任何 PR 写 `terminalReason: 'infra_error'` → tsc 报错。
- 任何 PR 写 `if (legacy) ...` 或 `{ legacy?: boolean }` → ESLint 报错。
- 任何 PR 加 source-grep 测试 → ESLint 报错。
- 任何 PR 加 `// TODO: remove after migration` → ESLint 报错。
- 任何 PR commit message 含 "as a follow-up" / "later" → commit-msg hook 拒绝。
- 任何 PR 修动 child runtime 但没配套 implementation plan → pre-push hook 拒绝。

如果上述 6 条 CI 验证 fixture 全部通过，A0 完成。

---

## 1. 架构决定（先于任务划分）

### D1. 词汇迁移用"删 + 重命名"，不留 legacy union 成员

按 §0.5 原则 3（拒绝 legacy 兼容分支）：

- 从 `SkillChildRunTerminalReason` union **彻底删除** `'infra_error'`。
- 新增 `'resume_launch_failed'` 覆盖 resume 启动失败的语义槽位（A2 修复时被借代为 `'failed_skill'` 的债，本阶段还原）。
- DB 读侧的 legacy decoder 输入类型改为 raw `string`（不绑定 union）；只读不写。
- DB 写侧 100% 走 union——任何写入旧 `'infra_error'` 编译失败。

### D2. ESLint plugin 用本地化方案

不引入第三方 plugin。新建 `eslint-rules/` 目录，inline rule 实现，本地 require 加载。理由：

- Ready 项目已经 vendor 化 ESLint 配置（不依赖 npm published plugin）。
- 4 条 rule 共享同一个 plugin 入口，未来加新 rule 也都从这里走。
- 单元测试用 `@typescript-eslint/rule-tester`（项目已经有 `@typescript-eslint` 依赖）。

### D3. ESLint rule 引入策略：先 grandfather，再启用

历史代码可能有不少 `if (legacy)` 之类的 legitimate 用法。引入新 rule 的标准流程：

1. 写 rule（默认 disabled）。
2. 跑全仓 lint，列所有违例。
3. 分类：可改的现场改；不可改的（如真的需要兼容旧浏览器）加 `// eslint-disable-next-line ready/no-legacy-conditional -- <reason>`，注释必须含人话理由。
4. **同 PR** 启用 rule 为 `error` 级，CI 必须绿。

禁止 "先启用 rule + 大量 disable + 后续逐步修" 模式——那是 §0.5 原则 3 的反面。

### D4. Plan 工作流 hook 对历史 plan 文件 grandfather

`docs/superpowers/plans/` 下当前文件：

- `2026-04-30-skill-runtime-child-loop-final-closure-arrangement.md`（counter-proposal）
- `2026-04-30-skill-runtime-child-loop-final-closure-claude-counterplan.md`（counter-proposal）
- `../../../../../superpowers/plans/2026-04-30-skill-runtime-child-loop-final-closure-implementation.md`（status report，不是真 plan）
- `../../../../../superpowers/plans/2026-04-30-skill-runtime-residual-architectural-debt.md`（debt 清单）
- `../../../../../superpowers/plans/2026-04-30-skill-runtime-cc-source-comparison-and-ideal-architecture.md`（架构对照）
- `2026-04-30-skill-runtime-agent-layer-reframe.md`（v3 路线）
- `2026-04-30-A0-strategic-foundation-implementation.md`（本文档）

新规则：

- counter-proposal 文件名必须含 `arrangement` 或 `counterplan`。
- implementation plan 文件名必须含 `implementation`。
- counter-proposal 存在但同主题 implementation plan 缺失 + 涉及 source 改动时，hook 抛错。
- **历史 grandfathered 文件** 加 frontmatter `enforce: false` 让 hook 跳过。

这是文档管理层 grandfather，不是代码层 legacy。可以接受。

---

## 2. 团队划分

依赖图：

```
Team 1 (§A0.1 词汇 invariant)        ─┐
Team 2 (§A0.2 + §A0.3 ESLint plugin) ─┼─→ Team 4 (端到端验证)
Team 3 (§A0.4 plan 工作流 hook)      ─┘
```

Team 1 / 2 / 3 文件不冲突（已验证），可后台并发。Team 4 等三家完成做集成 verify。

| Team | Files | 工期 |
|---|---|---|
| 1 | `skill-child-run-types.ts`、`skill-child-state-machine.ts`、`skill-child-error-mapping.ts`（新）、`skill-child-runner.ts`、`turn-engine.ts`、相关测试 | 1 天 |
| 2 | `eslint-rules/`（新目录）、`.eslintrc.*`、违例测试（`tool-internal-admission.test.ts`） | 1 天 |
| 3 | `scripts/check-plan-pairing.cjs`（新）、`.husky/`（如已存在则修改，否则新建）、相关 fixture | 0.5 天 |
| 4 | 验证 + commit 整合 | 0.5 天 |

**总工期**：3 天（4 team 串行最大值），并发后约 1.5-2 天。

---

## 3. §A0.1 — 词汇 invariant（Team 1）

### 3.1 目标

- 让 `terminalReason: 'infra_error'` 在编译期不可写（除 legacy decoder）。
- 引入 `mapDriverThrowToTerminalReason(error, context)` 集中映射函数。
- 还原 Layer 1 Team 2 借代的 `'failed_skill'`（resume 启动失败）到正确语义槽 `'resume_launch_failed'`。

### 3.2 改动 1：types.ts 删 `infra_error` + 加 `resume_launch_failed`

**文件**：`src/main/modules/agent-control/skill-child-run-types.ts` line 39-55。

**旧**：

```ts
export type SkillChildRunTerminalReason =
  | 'completed'
  | 'checkpoint_budget'
  | 'checkpoint_background'
  | 'queued_global_concurrency'
  | 'launch_stuck'
  | 'blocked_config'
  | 'blocked_external'
  | 'nested_child_run_not_supported'
  | 'cancelled_user'
  | 'failed_skill'
  | 'infra_error'                  // ← 删
  | 'child_process_crashed'
  | 'host_unavailable'
  | 'tool_not_registered'
  | 'input_validation'
  | 'process_restarted'
```

**新**：

```ts
export type SkillChildRunTerminalReason =
  | 'completed'
  | 'checkpoint_budget'
  | 'checkpoint_background'
  | 'queued_global_concurrency'
  | 'launch_stuck'
  | 'blocked_config'
  | 'blocked_external'
  | 'nested_child_run_not_supported'
  | 'cancelled_user'
  | 'failed_skill'
  | 'child_process_crashed'
  | 'host_unavailable'
  | 'tool_not_registered'
  | 'input_validation'
  | 'process_restarted'
  | 'resume_launch_failed'         // ← 新增

/**
 * Legacy reason set for read-only DB decoding. Old rows may carry
 * `'infra_error'` as terminalReason — `decodeStoredTerminalReason()`
 * (in skill-child-state-machine.ts) is the only sanctioned reader.
 * This type MUST NOT be used for any new write path.
 */
export type SkillChildRunStoredTerminalReason =
  | SkillChildRunTerminalReason
  | 'infra_error'
```

注意：`SkillChildRunStoredTerminalReason` 是新增的 type alias，仅用于"已存在 DB 行的解码"。绝对不可在新写入端使用。

### 3.3 改动 2：state-machine.ts decoder 改名 + 行为加严

**文件**：`src/main/modules/agent-control/skill-child-state-machine.ts`。

把现有 `coerceSkillChildTerminalReason` 改名为 `decodeStoredTerminalReason` 并改输入类型：

```ts
import type {
  SkillChildCloseEvent,
  SkillChildRunStatus,
  SkillChildRunStoredTerminalReason,
  SkillChildRunTerminalReason,
} from './skill-child-run-types'

/**
 * Read-only legacy decoder. Reads a DB row whose terminalReason field
 * may carry the deprecated `'infra_error'` value, returns the canonical
 * union member.
 *
 * Decoding rules:
 * - Known specific kinds via `error.kind`: map to matching reason.
 * - Unknown / missing `error.kind` with `terminalReason='infra_error'`:
 *   default to `'child_process_crashed'` (the safest interpretation —
 *   any infra-level abnormal close that we have no further evidence
 *   for is treated as a process crash).
 * - Already-canonical reasons: return unchanged.
 */
export function decodeStoredTerminalReason(close: {
  terminalReason: SkillChildRunStoredTerminalReason | string
  error?: { kind: string; message?: string } | null
}): SkillChildRunTerminalReason {
  const raw = close.terminalReason
  if (raw === 'infra_error') {
    const mapped = close.error?.kind ? INFRA_ERROR_KIND_TO_TERMINAL_REASON[close.error.kind] : undefined
    return mapped ?? 'child_process_crashed'
  }
  if (isSkillChildRunTerminalReason(raw)) return raw
  // Unknown string — defensive default
  return 'child_process_crashed'
}
```

旧 `coerceSkillChildTerminalReason` 删除（不留 alias，按 §0.5 原则 3）。所有调用方改名。

### 3.4 改动 3：新建 skill-child-error-mapping.ts

**文件**：`src/main/modules/agent-control/skill-child-error-mapping.ts`（**新**）。

```ts
import type { SkillChildRunTerminalReason } from './skill-child-run-types'

/** Phase 标识 driver/runner 抛错的位置——映射函数据此回退选 reason。 */
export type DriverThrowPhase =
  | 'launch'           // beginRunLoop / mkdirSync / repository.create
  | 'init'             // driver.createInitialState
  | 'plan'             // driver.planNextAction
  | 'observe'          // driver.observeAfterAction
  | 'persistence'      // repository.update / append event log
  | 'resume_lookup'    // resumeSkillChildRun 找不到 row / payload

/**
 * Single source of truth for driver/runner thrown errors → terminalReason.
 *
 * Selection priority:
 *   1. error.name === 'AbortError' → 'cancelled_user'
 *   2. error.message pattern (host unavailable / network / tool not registered)
 *   3. phase fallback
 *
 * Adding a new phase or new error pattern? Update this file + add a unit test.
 * Do NOT inline `if (error.message includes ...) return 'X'` at the call site.
 */
export function mapDriverThrowToTerminalReason(
  error: unknown,
  phase: DriverThrowPhase,
): SkillChildRunTerminalReason {
  // Priority 1 — explicit abort
  if (error instanceof Error && error.name === 'AbortError') return 'cancelled_user'

  // Priority 2 — known message patterns
  if (error instanceof Error) {
    const msg = error.message.toLowerCase()
    if (msg.includes('host unavailable') || msg.includes('econnrefused') || msg.includes('etimedout')) {
      return 'host_unavailable'
    }
    if (msg.includes('tool not registered') || msg.includes('no_tool_definition')) {
      return 'tool_not_registered'
    }
  }

  // Priority 3 — phase fallback
  switch (phase) {
    case 'launch':
    case 'persistence':
      return 'host_unavailable'
    case 'init':
    case 'plan':
    case 'observe':
      return 'child_process_crashed'
    case 'resume_lookup':
      return 'resume_launch_failed'
  }
}
```

### 3.5 改动 4：runner 的 9 处硬编码迁移

**文件**：`src/main/modules/agent-control/skill-child-runner.ts`。

每处调用 `mapDriverThrowToTerminalReason(error, phase)` 选具体 reason，不再 hardcode `'infra_error'`：

| 行号（迁移前）| errorKind | 新 phase | 新 reason |
|---|---|---|---|
| ~195 | `no_driver_registered` | — | 直接选 `'host_unavailable'`（无 error 对象） |
| ~299 | `repository_create_failed` | `persistence` | `mapDriver...(error, 'persistence')` → `host_unavailable` |
| ~343 | `no_record` | `resume_lookup` | 直接选 `'resume_launch_failed'`（无 error） |
| ~346 | `no_payload` | `resume_lookup` | `'resume_launch_failed'` |
| ~401 | `repository_update_failed` | `persistence` | `mapDriver...(error, 'persistence')` |
| ~707 | driver disappeared mid-launch | `launch` | `'host_unavailable'`（无 error） |
| ~757 | `runner_uncaught` | `launch` | `mapDriver...(error, 'launch')` |
| ~795 | `driver_init_failed` | `init` | `mapDriver...(error, 'init')` → 通常 `child_process_crashed` |
| ~861 | `driver_plan_failed` | `plan` | `mapDriver...(error, 'plan')` |
| ~1023 | `driver_observe_failed` | `observe` | `mapDriver...(error, 'observe')` |

每处替换后，对应的 `errorKind` 字段（写入 `close.error.kind`）保持不变——这个字段是诊断细节，不是 terminalReason 决策依据。

**禁止做的**：保留 `'infra_error'` 作为 fallback。删了就是删了。

### 3.6 改动 5：还原 turn-engine.ts 的 'failed_skill' 借代

Layer 1 Team 2 因为 `TurnTerminalReason` union 没有 `'failed'` 而借用 `'failed_skill'` 作为"resume 启动失败"。本阶段还原：

**文件**：`src/main/modules/agent-control/turn-engine.ts`。

1. 检查 `TurnTerminalReason` 类型定义（在 turn-engine.ts 或它 import 的某个 types 文件）。如果它现在是个 union：
   - **加** `'resume_launch_failed'` 成员（或称 `'launch_failed'`，按现有命名风格选）。
2. `renderChildCommandOutcome`（之前 land 的 helper）的 resume failure 分支：
   - 把 `terminalReason: 'failed_skill'` 改回 `terminalReason: 'resume_launch_failed'`。
3. 同步 turn-engine-route.test.ts 的测试断言（精确测试名见 3.8）。

### 3.7 现有 6 处 `'infra_error'` 写入端被 typecheck 强制清零

删除 `'infra_error'` from union 后，全仓 typecheck 会列出所有违例。预期违例位置（grep 当前）：

```
src/main/modules/agent-control/skill-child-runner.ts:  ~195, ~299, ~343, ~346, ~401, ~707, ~757, ~795, ~861, ~1023
```

每处按 3.5 表格映射。

**额外检查**：grep 整个 `src/` 目录里的 `'infra_error'` 字面量，确认改完后只剩在 `skill-child-state-machine.ts` 的 `decodeStoredTerminalReason` 内（legacy 解码用），以及 `skill-child-run-types.ts` 的 `SkillChildRunStoredTerminalReason` 类型定义。

### 3.8 新测试

**文件**：`src/__tests__/skill-child-error-mapping.test.ts`（**新**）。

精确 it 名（一字不差）：

```ts
test('mapDriverThrowToTerminalReason returns cancelled_user for AbortError', ...)
test('mapDriverThrowToTerminalReason returns host_unavailable for ECONNREFUSED message', ...)
test('mapDriverThrowToTerminalReason returns host_unavailable for ETIMEDOUT message', ...)
test('mapDriverThrowToTerminalReason returns tool_not_registered for matching message', ...)
test('mapDriverThrowToTerminalReason phase fallback launch returns host_unavailable', ...)
test('mapDriverThrowToTerminalReason phase fallback persistence returns host_unavailable', ...)
test('mapDriverThrowToTerminalReason phase fallback init returns child_process_crashed', ...)
test('mapDriverThrowToTerminalReason phase fallback plan returns child_process_crashed', ...)
test('mapDriverThrowToTerminalReason phase fallback observe returns child_process_crashed', ...)
test('mapDriverThrowToTerminalReason phase fallback resume_lookup returns resume_launch_failed', ...)
test('mapDriverThrowToTerminalReason explicit abort wins over phase', ...)
```

**文件**：`src/__tests__/skill-child-state-machine.test.ts`（追加）。

```ts
test('decodeStoredTerminalReason maps legacy infra_error with kind to specific reason', ...)
test('decodeStoredTerminalReason defaults legacy infra_error without kind to child_process_crashed', ...)
test('decodeStoredTerminalReason returns canonical reasons unchanged', ...)
test('decodeStoredTerminalReason returns child_process_crashed for unknown string defensively', ...)
```

**文件**：`src/__tests__/turn-engine-route.test.ts`（更新现有测试名）：

把 Layer 1 加的测试 `resume failure with no_record surfaces failed terminalReason and failure message` 里 `terminalReason === 'failed_skill'` 的断言改为 `terminalReason === 'resume_launch_failed'`。同样改 `resume failure with no_payload surfaces failed terminalReason`。

### 3.9 §A0.1 验收合同

CI 可机器验证：

- (a) `npm run typecheck` 通过；任何文件写 `terminalReason: 'infra_error'` 必失败（除 `decodeStoredTerminalReason` 内）。
- (b) `grep -r "'infra_error'" src/` 在 `decodeStoredTerminalReason` + types 文件 + 已注释代码之外**零结果**。
- (c) 新增 11 个 `mapDriverThrowToTerminalReason` 测试 + 4 个 `decodeStoredTerminalReason` 测试全部通过。
- (d) 既有 turn-engine-route 套件零回归（`resume_launch_failed` 替换 `failed_skill` 后断言更新）。
- (e) Layer 1 land 的 `skill-child-runner-resume-lifecycle.test.ts` 等套件零回归。

---

## 4. §A0.2 — ESLint rule 禁 source-grep（Team 2 上半）

### 4.1 目标

禁止测试用 `readFileSync(*.ts) + regex` 当行为测试。

### 4.2 改动 1：建 ESLint plugin 框架

**新目录**：`eslint-rules/`（项目根）。

**新文件**：`eslint-rules/index.js`（plugin 入口）：

```js
module.exports = {
  rules: {
    'no-source-grep-test': require('./no-source-grep-test'),
    'no-todo-remove-after-migration': require('./no-todo-remove-after-migration'),
    'no-legacy-conditional': require('./no-legacy-conditional'),
    'no-legacy-optional-param': require('./no-legacy-optional-param'),
  },
}
```

### 4.3 改动 2：rule 实现

**新文件**：`eslint-rules/no-source-grep-test.js`。

行为：在 `*.test.ts` 文件里，flag 任何 `readFileSync(...)` 调用且参数是 `.ts`/`.tsx`/`.js`/`.jsx` 文件路径，且该 readFileSync 的返回值后续被 `assert.match` / `assert.doesNotMatch` 消费。

```js
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Forbid source-string regex matching as behavior tests in .test.ts files',
      recommended: true,
    },
    schema: [],
    messages: {
      sourceGrepTest:
        'Do not use readFileSync + regex match as behavior test. ' +
        'Replace with actual call → expect output assertion. ' +
        'See .claude/architectural-principles.md (Principle 5).',
    },
  },
  create(context) {
    const filename = context.getFilename()
    if (!filename.endsWith('.test.ts') && !filename.endsWith('.test.tsx')) return {}

    const sourceReadVarsAtScope = new Set()

    return {
      VariableDeclarator(node) {
        // const x = readFileSync('...', 'utf-8')
        if (
          node.init?.type === 'CallExpression'
          && node.init.callee.type === 'Identifier'
          && node.init.callee.name === 'readFileSync'
          && node.init.arguments.length >= 1
        ) {
          const arg0 = node.init.arguments[0]
          // Heuristic: the path argument's source text mentions .ts/.tsx/.js/.jsx
          const sourceText = context.getSourceCode().getText(arg0)
          if (/\.(ts|tsx|js|jsx|cjs|mjs)['"`]/.test(sourceText)) {
            if (node.id.type === 'Identifier') {
              sourceReadVarsAtScope.add(node.id.name)
            }
          }
        }
      },
      CallExpression(node) {
        // assert.match(<varInSet>, /.../) or assert.doesNotMatch(...)
        if (
          node.callee.type === 'MemberExpression'
          && node.callee.object.type === 'Identifier'
          && node.callee.object.name === 'assert'
          && node.callee.property.type === 'Identifier'
          && (node.callee.property.name === 'match' || node.callee.property.name === 'doesNotMatch')
          && node.arguments.length >= 1
        ) {
          const arg0 = node.arguments[0]
          // arg0 is Identifier named X, where X 是从 readFileSync(*.ts) 来的
          if (arg0.type === 'Identifier' && sourceReadVarsAtScope.has(arg0.name)) {
            context.report({ node, messageId: 'sourceGrepTest' })
          }
          // arg0 is CallExpression like fnReturningSource(...)
          if (
            arg0.type === 'CallExpression'
            && arg0.callee.type === 'Identifier'
            && /Source$/i.test(arg0.callee.name)
          ) {
            context.report({ node, messageId: 'sourceGrepTest' })
          }
        }
      },
    }
  },
}
```

### 4.4 改动 3：rule 单元测试

**新文件**：`eslint-rules/__tests__/no-source-grep-test.test.js`。

用 `@typescript-eslint/rule-tester`（项目已依赖）：

```js
const { RuleTester } = require('@typescript-eslint/rule-tester')
const rule = require('../no-source-grep-test')

const ruleTester = new RuleTester({ parser: require.resolve('@typescript-eslint/parser') })

ruleTester.run('no-source-grep-test', rule, {
  valid: [
    { filename: 'src/__tests__/foo.test.ts', code: `assert.match(actualResult, /pattern/)` },
    { filename: 'src/foo.ts', code: `const s = readFileSync('a.ts', 'utf-8'); assert.match(s, /pattern/)` },  // 非 .test.ts 文件
    { filename: 'src/__tests__/foo.test.ts', code: `const s = readFileSync('data.json', 'utf-8'); assert.match(s, /pattern/)` },  // 非源码
  ],
  invalid: [
    {
      filename: 'src/__tests__/foo.test.ts',
      code: `import { readFileSync } from 'node:fs'; const s = readFileSync('foo.ts', 'utf-8'); assert.match(s, /executeToolCall/)`,
      errors: [{ messageId: 'sourceGrepTest' }],
    },
    {
      filename: 'src/__tests__/foo.test.ts',
      code: `function gatewaySource() { return readFileSync('x.ts', 'utf-8') } assert.doesNotMatch(gatewaySource(), /\\.runSkill\\(/)`,
      errors: [{ messageId: 'sourceGrepTest' }],
    },
  ],
})
```

### 4.5 改动 4：在 `.eslintrc` 注册并启用

**修改**：项目根 `.eslintrc.cjs` 或 `.eslintrc.json`（找现有的）。

```js
module.exports = {
  // ... existing
  plugins: [
    // ... existing
    'ready-local',  // 注册本地 plugin
  ],
  rules: {
    // ... existing
    'ready-local/no-source-grep-test': 'error',
  },
}
```

并在配置里注册本地 plugin path：

```js
{
  plugins: {
    'ready-local': require('./eslint-rules'),  // resolverPath 视实际 ESLint 版本调整
  },
}
```

具体注册方式根据当前 .eslintrc 风格选择（flat config vs legacy config）。

### 4.6 改动 5：修现有违例

**文件**：`src/__tests__/tool-internal-admission.test.ts`。

这是已知违例（Layer 1 review 中明确指出）。重写两处 source-grep 测试为行为断言：

**旧测试 1**（line 110-142）：

```ts
test('child internal action dispatches through executeToolCall', async () => {
  const source = gatewayFunctionSource()
  assert.match(source, /executeToolCall\(/)
  assert.doesNotMatch(source, /runSkillFromChildRunner/)
  // ...
})
```

**新测试**（精确 it 名）：

```
test('child internal action and public model action have bit-equivalent admission shape', ...)
```

要点：

- ARRANGE：构造一个不存在的 tool name；构造 schema-mismatched 输入。
- ACT：分别 `executeToolCall(badName, badInput, { invoker: 'model', ... })` 和 `executeToolCall(badName, badInput, { invoker: 'child_runner', allowInternal: true, childInternalSkillAction: ... })`。
- ASSERT：两次返回的 `data.errorKind` / `data.reason` / `data.toolName` 完全相同。

**旧测试 2**（line 151-157）：

```ts
test('executeToolCall rejects internal tools unless child internal context is allowed', () => {
  const source = toolExecutorSource()
  assert.match(source, /context\.allowInternal/)
  // ...
})
```

**新测试**：

```
test('executeToolCall on internal-visibility tool rejects when invoker is model', ...)
test('executeToolCall on internal-visibility tool accepts when invoker is child_runner with allowInternal', ...)
```

要点：注册一个 `executionVisibility: 'internal'` 的 ToolDefinition 到 mock registry，分别用两种 invoker 调，断言响应。

### 4.7 §A0.2 验收合同

- (a) Rule 单元测试通过（fixture valid + invalid）。
- (b) `npm run lint` 在新 rule 启用后通过（`tool-internal-admission.test.ts` 已重写）。
- (c) 故意构造一个违例 fixture（`src/__tests__/__fixtures__/lint-fixture-source-grep.ts.fixture`，文件名带 `.fixture` 让其它测试不跑），跑 ESLint 在该文件上必报 `no-source-grep-test`。

---

## 5. §A0.3 — 复发签名机器化（Team 2 下半）

### 5.1 目标

把 `.claude/architectural-principles.md` 的反模式速查表里**可机器化**的条目落到 ESLint rule + commit-msg hook。

### 5.2 改动 1：rule `no-todo-remove-after-migration`

**文件**：`eslint-rules/no-todo-remove-after-migration.js`。

行为：检查注释（line / block）匹配 `/TODO.*remove\s*after\s*migration|deprecated.*will\s*deprecate|legacy.*will\s*remove/i` → flag。

```js
module.exports = {
  meta: { /* ... */ messages: { found: 'Legacy migration TODO is forbidden — see Principle 3 (.claude/architectural-principles.md)' } },
  create(context) {
    return {
      Program() {
        const sc = context.getSourceCode()
        for (const c of sc.getAllComments()) {
          if (/TODO.*remove\s*after\s*migration/i.test(c.value)) context.report({ node: c, messageId: 'found' })
          if (/deprecated.*will\s*deprecate/i.test(c.value)) context.report({ node: c, messageId: 'found' })
          if (/legacy.*will\s*remove/i.test(c.value)) context.report({ node: c, messageId: 'found' })
        }
      },
    }
  },
}
```

### 5.3 改动 2：rule `no-legacy-conditional`

**文件**：`eslint-rules/no-legacy-conditional.js`。

行为：在条件表达式里，identifier 名是 `legacy` / `isLegacy` / `legacyXxx` / `xxx.legacy` / `xxx.isLegacy` → flag。

```js
module.exports = {
  meta: { /* ... */ messages: { found: 'Legacy conditional branches are forbidden — see Principle 3' } },
  create(context) {
    function isLegacyIdentifier(name) {
      return name === 'legacy' || /^legacy[A-Z]/.test(name) || /^isLegacy/.test(name)
    }
    function checkCondition(node) {
      if (!node) return
      if (node.type === 'Identifier' && isLegacyIdentifier(node.name)) {
        context.report({ node, messageId: 'found' })
      } else if (node.type === 'MemberExpression' && node.property.type === 'Identifier' && isLegacyIdentifier(node.property.name)) {
        context.report({ node, messageId: 'found' })
      } else if (node.type === 'UnaryExpression' && node.operator === '!') {
        checkCondition(node.argument)
      }
    }
    return {
      IfStatement(node) { checkCondition(node.test) },
      ConditionalExpression(node) { checkCondition(node.test) },
    }
  },
}
```

### 5.4 改动 3：rule `no-legacy-optional-param`

**文件**：`eslint-rules/no-legacy-optional-param.js`。

行为：函数 / 类型 / 接口的参数对象类型里，如有可选字段命名 `legacy` / `isLegacy` / `legacyXxx` → flag。

实现思路：访问 TSPropertySignature / TSTypeLiteral，检查 `optional && key.name === 'legacy'` 等。

### 5.5 改动 4：commit-msg hook 防 follow-up 句式

**文件**：`.husky/commit-msg`（新 / 修改）。

```bash
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

MSG_FILE="$1"
MSG=$(cat "$MSG_FILE")

# Block phrases that signal kicked-down-the-road work
if echo "$MSG" | grep -iE 'as a follow.up|in a separate pr|will (be )?addressed (in )?(a )?later|we.?ll fix (this|that) later' > /dev/null; then
  echo "❌ commit-msg blocked: message contains a 'kicked-down-the-road' phrase."
  echo "   Principle 2 says: fix the root cause now or open an explicit issue."
  echo "   .claude/architectural-principles.md"
  exit 1
fi

# Allow but warn on TODO references
if echo "$MSG" | grep -iE 'TODO' > /dev/null; then
  echo "⚠️  commit message contains TODO — make sure it links a tracking issue."
fi

exit 0
```

注意：A0 不引入 Husky；本阶段只提供 CI 与本地可调用脚本入口。

### 5.6 改动 5：rule 单元测试 × 3

每个新 rule 配 `eslint-rules/__tests__/<rule-name>.test.js`，valid/invalid fixture 各 2-3 条。

### 5.7 改动 6：grandfather 现有违例

跑全仓 lint 列出违例。预期可能命中：
- `if (legacy)` 模式
- `// TODO ...` 类
- 类型里的 `legacy?` 参数

每条违例**当 PR 修复**或加 `// eslint-disable-next-line ready-local/<rule> -- <reason>` 注释（reason 必须是人话）。

### 5.8 §A0.3 验收合同

- (a) 3 个新 rule 各自单元测试通过。
- (b) `npm run lint` 在所有新 rule 启用后通过。
- (c) Commit-msg hook 在 fixture 测试下：违规 commit 拒绝、合规 commit 通过。
- (d) 现有违例已修或已 grandfather（grandfather 数量必须有人话注释，否则 review 拒绝）。

---

## 6. §A0.4 — Plan 工作流 hook（Team 3）

### 6.1 目标

counter-proposal 文件存在但同主题 implementation plan 文件缺失 + 涉及 source 改动时，pre-push hook 拒绝。

### 6.2 改动 1：约定文件命名规则（写入 CLAUDE.md / AGENTS.md §0.5）

由 Team 3 的最后一步加（同 PR）：

CLAUDE.md / AGENTS.md §0.5 的"为什么要立这 5 条"段落后，加一段：

```markdown
**Plan 文件命名规则（A0.4 hook 强制）**：
- Counter-proposal: `docs/superpowers/plans/YYYY-MM-DD-*-{arrangement,counterplan}.md`
- Implementation plan: `docs/superpowers/plans/YYYY-MM-DD-*-implementation.md`
- 历史 grandfathered 文件可在 frontmatter 标 `enforce: false` 让 hook 跳过。
```

### 6.3 改动 2：脚本 check-plan-pairing.cjs

**文件**：`scripts/check-plan-pairing.cjs`（**新**）。

```js
#!/usr/bin/env node
// scripts/check-plan-pairing.cjs
//
// Pre-push hook script:
// 1. Scan docs/superpowers/plans/ for counter-proposals (filename matches arrangement|counterplan).
// 2. For each counter-proposal, check if same-prefix (YYYY-MM-DD-*) implementation plan exists.
// 3. If counter-proposal has no implementation pair AND the push contains source changes:
//    block push.
// 4. Files with frontmatter `enforce: false` are skipped.

const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const PLAN_DIR = path.join(process.cwd(), 'docs/superpowers/plans')

function readFrontmatterEnforce(filePath) {
  // Naive: read first 200 bytes, look for `enforce: false`
  try {
    const head = fs.readFileSync(filePath, 'utf8').slice(0, 800)
    if (/^---[\s\S]*?\benforce:\s*false\b[\s\S]*?---/m.test(head)) return false
  } catch {}
  return true
}

function listPlanFiles() {
  if (!fs.existsSync(PLAN_DIR)) return []
  return fs.readdirSync(PLAN_DIR).filter((f) => f.endsWith('.md'))
}

function classifyPlanFile(name) {
  if (/-(arrangement|counterplan)\.md$/.test(name)) return 'counter'
  if (/-implementation\.md$/.test(name)) return 'impl'
  return 'other'
}

function planPrefix(name) {
  // YYYY-MM-DD-<topic>-<suffix>.md  →  YYYY-MM-DD-<topic>
  return name.replace(/-(arrangement|counterplan|implementation)\.md$/, '')
}

function getPushedSourceFiles() {
  // List files staged for this push (vs upstream)
  try {
    const upstream = execSync('git rev-parse --abbrev-ref --symbolic-full-name @{u}', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const out = execSync(`git diff --name-only ${upstream}...HEAD`, { encoding: 'utf8' })
    return out.split('\n').filter(Boolean)
  } catch {
    return []
  }
}

function isSourceFile(p) {
  return /^src\//.test(p) || /^scripts\//.test(p) || /^eslint-rules\//.test(p)
}

function main() {
  const planFiles = listPlanFiles()
  const counterByPrefix = new Map()
  const implByPrefix = new Map()

  for (const f of planFiles) {
    const cls = classifyPlanFile(f)
    const prefix = planPrefix(f)
    const enforced = readFrontmatterEnforce(path.join(PLAN_DIR, f))
    if (!enforced) continue
    if (cls === 'counter') counterByPrefix.set(prefix, f)
    if (cls === 'impl') implByPrefix.set(prefix, f)
  }

  const orphans = []
  for (const [prefix, file] of counterByPrefix.entries()) {
    if (!implByPrefix.has(prefix)) orphans.push({ prefix, file })
  }

  if (orphans.length === 0) process.exit(0)

  const pushedSrc = getPushedSourceFiles().filter(isSourceFile)
  if (pushedSrc.length === 0) process.exit(0)

  console.error('❌ Plan pairing violation (Principle 1: contracts before code):')
  for (const o of orphans) {
    console.error(`   - ${o.file} has no matching ${o.prefix}-implementation.md`)
  }
  console.error('   You are pushing source changes without a paired implementation plan.')
  console.error('   Either: (a) write the implementation plan, or')
  console.error('           (b) add `enforce: false` frontmatter to the counter-proposal if it is historical.')
  process.exit(1)
}

main()
```

### 6.4 改动 3：注册 pre-push hook

**文件**：`.husky/pre-push`（新 / 修改）。

```bash
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

node scripts/check-plan-pairing.cjs
```

如果项目还没有 husky，按 §5.5 的做法初始化。

### 6.5 改动 4：脚本单元测试

**文件**：`scripts/__tests__/check-plan-pairing.test.cjs`（**新**）。

用 Node 自带 test runner（`node:test`）+ 临时目录 fixture：

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

function setupFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-pairing-'))
  // ... 建 git repo + commit + 模拟 push 状态
}

test('check-plan-pairing exits 0 when counter-proposal has matching implementation', ...)
test('check-plan-pairing exits 0 when no source files changed', ...)
test('check-plan-pairing exits 1 when counter has no impl and source files changed', ...)
test('check-plan-pairing skips counter-proposals with enforce: false frontmatter', ...)
```

### 6.6 改动 5：grandfather 历史文件

为 `2026-04-30-skill-runtime-child-loop-final-closure-arrangement.md` 与 `...claude-counterplan.md` 加 frontmatter：

```yaml
---
enforce: false
reason: |
  Historical (pre-A0). The accompanying *-implementation.md is a status
  report, not a true implementation plan. Future plans must follow the
  full counter-proposal → implementation plan workflow.
---
```

注：这些文件原内容前面就直接是 `# Skill Runtime Child-Loop Final Closure Arrangement` 等。frontmatter 加在最顶（`---` 上下夹住 `enforce` 字段，下面留一空行再接原 markdown）。

### 6.7 §A0.4 验收合同

- (a) 脚本 4 条单元测试全过。
- (b) Pre-push hook 在 fixture（孤立 counter-proposal + source change）下抛错。
- (c) Pre-push hook 在 grandfathered counter-proposal 下放行。
- (d) CLAUDE.md / AGENTS.md §0.5 加了 plan 文件命名规则段落。

---

## 7. 团队执行 prompts（Codex 用）

### Team 1 prompt 概要

> 你是 Team 1（A0.1 词汇 invariant）。
> 完整任务定义：本文件 §3。
> 文件：`skill-child-run-types.ts`、`skill-child-state-machine.ts`、`skill-child-error-mapping.ts`（新）、`skill-child-runner.ts`、`turn-engine.ts`、相关测试。
> 验收：§3.9。
> 不要做：保留 `'infra_error'` 作为 fallback；改 ESLint 配置；改 hook。
> 完成后报告：改了哪些文件、新增 11 测试 + 4 decoder 测试是否全过、typecheck 干净、`grep -r "'infra_error'" src/` 结果。

### Team 2 prompt 概要

> 你是 Team 2（A0.2 + A0.3 ESLint plugin）。
> 完整任务定义：本文件 §4 + §5。
> 文件：`eslint-rules/`（新目录）、`.eslintrc.*`、`.husky/commit-msg`、`tool-internal-admission.test.ts`（重写违例）。
> 验收：§4.7 + §5.8。
> 不要做：改 source 代码（除了重写违例测试）；改 plan hook。
> 完成后报告：4 rule 单元测试 + commit-msg hook fixture + `npm run lint` 全绿。

### Team 3 prompt 概要

> 你是 Team 3（A0.4 plan 工作流 hook）。
> 完整任务定义：本文件 §6。
> 文件：`scripts/check-plan-pairing.cjs`（新）、`.husky/pre-push`、`scripts/__tests__/`、CLAUDE.md / AGENTS.md §0.5 追加 plan 命名规则、给历史 plan 文件加 frontmatter。
> 验收：§6.7。
> 不要做：改 source 代码；改 ESLint 配置。
> 完成后报告：脚本测试 + hook fixture + grandfathered 文件 frontmatter 落地。

---

## 8. 端到端验证（Team 4）

完成所有 Team 后整合 verify：

```bash
# 1. 类型检查
npm run typecheck

# 2. 全仓 lint
npm run lint   # 必须 0 errors（lint baseline 不退化是 §A0.2/3 启用的前提）

# 3. 焦点测试套（A0 相关 + Layer 1 不退化）
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/skill-child-error-mapping.test.ts \
  src/__tests__/skill-child-state-machine.test.ts \
  src/__tests__/skill-child-runner.test.ts \
  src/__tests__/skill-child-runner-resume-lifecycle.test.ts \
  src/__tests__/skill-child-feature-flags.test.ts \
  src/__tests__/turn-engine-route.test.ts \
  src/__tests__/turn-engine-force-tool-dispatch.test.ts \
  src/__tests__/skill-task-run-repository.test.ts \
  src/__tests__/tool-internal-admission.test.ts \
  src/__tests__/skill-child-run-end-to-end.test.ts

# 4. ESLint plugin 单元测试
npx mocha eslint-rules/__tests__/*.test.js   # or 项目用的 test runner

# 5. Plan pairing 脚本单元测试
node --test scripts/__tests__/check-plan-pairing.test.cjs

# 6. Hook fixture 验证
.husky/commit-msg <(echo "fix: resolve as a follow-up")  # 必须 exit 1
.husky/commit-msg <(echo "fix: real fix with verification")  # 必须 exit 0

# 7. End-to-end CI 强制 fixture
# 故意写一行 terminalReason: 'infra_error'（在新文件里），跑 typecheck 必失败。
# 故意写一行 if (legacy)，跑 lint 必失败。
# 故意写一个 source-grep test，跑 lint 必失败。
echo "if these all fail as expected, A0 is done"
```

如果 7 件全部按预期表现（合规通过、违规失败），A0 阶段完成，可开 A1（SubAgent 抽象骨架）。

---

## 9. 不允许做的事（按 §0.5 原则映射）

| 反模式 | 违反原则 |
|---|---|
| 保留 `'infra_error'` 在 union 里"作为兼容" | 原则 3 |
| 用 `// eslint-disable-next-line` 大批量绕过新 rule（除少量 grandfathered） | 原则 3 |
| 把 §A0.x 拆成多 PR 分批 land——其中一段 land 后 CI 部分红 | 原则 1（合同必须一起 enforce） |
| 用 commit message "as a follow-up will fix" 推迟某条违例 | 原则 2 + 5 |
| 写"参考 ESLint 官方某 rule 实现"但不解释为什么这个实现适合本项目 | 原则 4 |
| 在 Team 间偷偷改对方文件 | 一般工程纪律 |

---

## 10. 完成判据（A0 整体）

- [ ] §A0.1 — `'infra_error'` 从 union union 删除；`mapDriverThrowToTerminalReason` 落地；9 处写入端迁移；turn-engine `'failed_skill'` 借代还原；典型 11 + 4 测试过。
- [ ] §A0.2 — `no-source-grep-test` rule 落地；`tool-internal-admission.test.ts` 重写违例；rule 单元测试过。
- [ ] §A0.3 — 3 条新 rule（todo / legacy-cond / legacy-optional-param）落地；commit-msg hook 落地；现有违例修完或 grandfathered。
- [ ] §A0.4 — `check-plan-pairing.cjs` 落地；pre-push hook 落地；CLAUDE.md / AGENTS.md §0.5 加命名规则；历史 plan 加 frontmatter。
- [ ] 端到端 7 件 fixture 全部按预期通过 / 失败。
- [ ] Layer 1 全部既有套件零回归。
- [ ] `npm run typecheck` + `npm run lint` 全绿。

A0 完成 → 准入 A1 SubAgent 抽象阶段。

---

## 11. 文档维护

- 完成后本文件不删，作为 A0 的"已落地证据"。
- 任何 A0 完成后发现的漏网之鱼（比如某条新 rule 误判过多）走独立 patch PR，引用本文件。
- 后续阶段（A1+）的 implementation plan 必须按本文件示范的格式（必须含 §合同 + §不允许做的事）。
