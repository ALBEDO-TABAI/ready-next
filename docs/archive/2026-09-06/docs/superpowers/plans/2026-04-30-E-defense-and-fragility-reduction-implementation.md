---
name: E — 防爆 + 减脆（O1 / O4 / O6 / O8 统一收口）
description: v3 路线 E 阶段实施计划。引入 outputDir 生命周期 + GC（O1）；run_state.json atomic write 全量迁移（O4）；child run 失败的 retry policy + circuit breaker（O6）；child internal action 的 PermissionContext 收口（O8）。所有 4 件落进 SubAgent / Coordinator 框架内，非新建抽象。
status: draft
enforce: false
counter_proposal: 2026-04-30-skill-runtime-agent-layer-reframe.md
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# E — 防爆 + 减脆（实施计划）

> **W0 audit correction（2026-05-01 / Hubble）**：以 `2026-04-30-E-pre-flight-audit-report.md` 为准。当前实测 O4 是 12 个 direct write：8 个 JSON 迁移到 `atomicWriteJson`、3 个文本/config 写迁移到 `atomicWriteText`、1 个临时 `.py` 写不迁移；O6 terminal reason union 是 17 个，不是 16 个；O8 不是“生产 actions 已走 tool-gateway”，而是 gateway 已存在且测试覆盖，但生产 runner 当前经 `runSkillFromChildRunner -> runSkill` 绕过 `executeSkillActionViaToolGateway`，W4 必须修。

> **范围**：把 residual-debt §3 的 4 个 A1/A2 级运维 / 数据 / 容错 / 安全债（O1 / O4 / O6 / O8）一次收口。这是 v3 §5.1 路线里"E — 防爆 + 减脆"的全部内容。
>
> **E 完成 = 4 件事**：
> 1. **O4 atomic-write 全量迁移**：导出 `atomicWriteJson` 到共享 helper，所有 run_state.json / config.json / runtime-state.json 写点全部改用它。`writeFileSync(*.json, ...)` 直写在 agent-control / skills-runtime 内 0 处遗留。
> 2. **O1 outputDir 生命周期 + 后台 GC**：每个 child run outputDir 终态时写 `.lifecycle.json` sidecar；独立 sweep timer 按保留期回收过期目录；emit `output_dir_gc` metric 每次回收。磁盘不再无限增长。
> 3. **O6 retry / circuit-breaker 策略**：按 terminal reason 决定是否自动 retry（`host_unavailable` 退避重试 vs `failed_skill` 直接 fail）；同 single-flight key 滑动窗口失败 N 次进入 cooldown，emit `child_run_circuit_break` metric。RSS 自动化场景的隐性 DoS 关掉。
> 4. **O8 PermissionContext 显式收口**：child internal action 调 skill primitive / driver 内部 shell 的路径必须显式带 `{isChildInternal, parentScopeId, parentSessionId, runtimeOwner}`；admission 同 primitive 同审；CI 测试断言两条路径走相同 admission 函数。
>
> **不在 E 范围**：
> - O2（跨 device single-flight 复用）— 设计意图未定，独立 ADR；
> - O3（parent × child budget 联动）— 监控精度问题，量级未到；
> - O5（e2e 真子进程链路）— 测试基建升级，独立项；
> - O7（child run UI 控制面）— 产品体验，跟 UI 队走；
> - L2 history compaction 算法（D 阶段 stub deferred 到 E 后续）— **本计划不收**，留给 E.5 或 F。

---

## 0. Context

### 0.1 为什么现在做

A0 / A1 / B / C / D（如已 land）把"agent 层结构"立完后，剩下的债是**生产环境运维 / 容错 / 安全级**的：
- **O1**：部署超过几个月磁盘必爆 —— 严重度 A1。
- **O4**：driver 写 run_state 时被 OS-level kill → row 损坏 —— 严重度 A2，半年内可能爆。
- **O6**：RSS 自动化把同一个失败 child run 反复重启 —— 严重度 A2，量级上来即 DoS。
- **O8**：child internal sandbox 边界审计未做 —— 严重度 A2，安全债。

residual-debt §5 优先级矩阵把这 4 个全部归 A1/A2，**不修就是给生产挖 4 个坑**。

E 阶段还有一个隐含好处：B 已把 child runtime 收进 SubAgent 框架，A1+B 的 cleanup / abort tree 让 retry 与 GC 有明确 hook 点（不再像旧 child-runner 一样散落 try/finally）。

### 0.2 Reconnaissance Facts（已实地核查）

**O4 atomic-write 现状**：

| 文件 | Line | 现状 | 是否原子 |
|---|---|---|---|
| `tools/skill-primitives/patch-config.ts` | 186 | `function atomicWriteJson(path, value)` 私有实现（write-tmp + rename）已存在 | ✅ |
| `tools/skill-primitives/patch-config.ts` | 348 / 391 | 用 atomicWriteJson 写 run_state / 目标 JSON | ✅ |
| `skills-runtime/runtime-manager.ts` | 1517 / 1572 / 1784 | `writeFileSync(statePath, JSON.stringify(...))` 直写 run_state / runtime-state | ❌ |
| `skills-runtime/runtime-manager.ts` | 587 / 1636 | 直写 script / 其他文件 | 视情况 |
| `skills-runtime/skill-host-controller.ts` | 237 / 246 / 288 | 直写 config 文件 / backup | ❌ |
| `skills-runtime/custom-skill-registry.ts` | 389 | 直写 manifest | ❌ |

**O4 的真正工作 = 把 `atomicWriteJson` 提升为共享 helper（移到 `agent-control/atomic-write.ts` 或 `shared/`），并迁移上面 5 处直写**。新代码量很少。

**O1 outputDir 生命周期现状**：

```bash
$ grep -rn "outputDir.*delete\|outputDir.*unlink\|cleanupOutput\|sweepOutput" src/main/modules/
```
→ **零结果**。

每个 VEA child run 在 `<runtimeRoot>/outputs/<skillId>/<childRunId>/` 留一个目录，跑完就**永久**留着。重试场景下旧 outputDir 与新 outputDir 双倍占用。

**O6 retry 现状**：

| 路径 | 是否有 retry | 备注 |
|---|---|---|
| `tool-runtime.ts:415` `resolveRetryDelayMs` | ✅ tool-call 级 retry | per-tool，不是 child run 级 |
| `skill-child-runner.ts` | ❌ 无 | 失败即 finalize，新 start 是新 lifecycle |
| RSS 自动化轮询 | ❌ 无 | 每次轮询都 startSkillChildRun，没有冷却 |

**O8 PermissionContext 现状**：

| 文件 | Line | 现状 |
|---|---|---|
| `tools/tool-executor.ts` | 84 | `childInternalSkillAction?: { ... }` context 字段 |
| `tools/tool-executor.ts` | 116 | `isChildInternalStrictAdmissionEnabled()` flag check |
| `tools/tool-executor.ts` | 131 | `definition.requiresExplicitAllowlist && !allowedToolNames?.has(toolName)` admission |
| `agent-control/tool-runtime.ts` | 484 | 同上 belt-and-suspenders |
| `agent-control/tool-registry.ts` | 520 / 534 / 547 / 626 | `requiresExplicitAllowlist: skillMeta?.visibility === 'internal'` |
| `agent-control/skill-child-runner.ts` | 107 | `childInternal?: boolean` 入口字段 |
| `agent-control/video-expert-child-driver.ts` | 12 | "driver does NOT spawn anything itself — it returns plans" |

→ **现状大部分正确**：driver 不直接 spawn，actions 走 tool-gateway，admission 检查 `requiresExplicitAllowlist`。**E 阶段 O8 = 审计 + 在 CI 锁住合同 + 修发现的 1-2 个漏洞**，不是大重构。

**已有 sweep 模式可借鉴**：`skills-runtime/runtime-manager.ts:433/455` `startReferenceHintSweep` —— 独立 setInterval timer，boot 时启动，30 分钟 idle 淘汰。E 阶段的 outputDir GC 可同形态。

### 0.3 与 D 的边界

如 D 已 land：D 的 `LayeredCompactor` / `HookRegistry` / `SystemReminderRegistry` 已在位。E 不动这些。

如 D 未 land：E 完全不依赖 D，可独立开工。

如 E 与 D 并行：W3（retry）的 circuit-break metric 走 `tool-error-metrics.ts` 注册（已在），不依赖 D 的 hook registry。

---

## 1. Hard Contracts（CI 必须可机器验证）

### E-Contract-1：所有 *.json 写入走 atomicWriteJson

`src/main/modules/agent-control/` 与 `src/main/modules/skills-runtime/` 下任何 `.ts` 文件**禁止**对 `*.json` 路径直接调 `writeFileSync` / `fs.writeFile`，**除了**：
- `agent-control/atomic-write.ts`（E 新建，helper 自身）
- 显式白名单：测试 / 一次性脚本 / 非状态类 JSON（manifest 写入由 `custom-skill-registry` 接管，但同样走 atomicWriteJson）

**CI 验证**：新建 `scripts/check-atomic-write.cjs`（TS Compiler API）。扫描两个目录树下所有 `CallExpression`：
- `writeFileSync(arg0, ...)` 且 arg0 是 string literal 含 `.json` 或 string template 末尾含 `.json`
- 或 `fs.writeFile(arg0, ...)` / `writeFile(arg0, ...)` 同条件

报错：`<file>:<line> direct JSON write — use atomicWriteJson()`. 白名单：`atomic-write.ts`、测试文件、`scripts/`。

### E-Contract-2：每个终态 child run 的 outputDir 有 `.lifecycle.json` sidecar

终态 = `completed / failed / killed / blocked`（不含 `budget_paused / recoverable_paused` —— 这两个是中态，可继续）。

`.lifecycle.json` schema：
```ts
interface OutputDirLifecycle {
  state: 'active' | 'retained' | 'expired'
  childRunId: string
  skillId: string
  terminalAt?: string   // ISO 时间戳，state >= retained 必填
  terminalReason?: SkillChildRunTerminalReason
  retainUntil?: string  // ISO 时间戳，state >= retained 必填
}
```

终态 finalize 时 runner 写入 `state: 'retained' / terminalAt: now / retainUntil: now + retentionDays`。

**CI 验证**：`src/__tests__/output-dir-lifecycle.test.ts`（E 新建）至少 4 条：
- it('terminal completed writes lifecycle.json with state=retained and retainUntil')
- it('terminal cancelled writes lifecycle.json with state=retained')
- it('budget_paused does NOT write lifecycle.json')
- it('lifecycle.json schema validates against zod schema')

### E-Contract-3：outputDir sweep 在 retainUntil 过期时回收 + emit metric

后台 sweep timer：boot 时启动（`SkillsRuntimeManager.startOutputDirSweep`），首跑 60s 后，之后每 6 小时一次。每次扫所有 `<runtimeRoot>/outputs/<skillId>/<childRunId>/`：
- 读 `.lifecycle.json`，state === `retained` 且 `retainUntil < now` → 整目录 rm + emit `output_dir_gc` metric。
- state === `active` → 跳过（child run 还在跑 / 进程刚重启未恢复）。
- 缺 `.lifecycle.json` → 视为 legacy，用 dir 创建时间 + 30 天宽限期保守判定。

**CI 验证**：`output-dir-sweep.test.ts`（E 新建）：
- it('sweep removes expired retained dirs and emits output_dir_gc metric')
- it('sweep skips active state dirs')
- it('sweep treats missing lifecycle as legacy with 30d grace')
- it('sweep is idempotent — second run on same fixture removes 0 more')

### E-Contract-4：retry 决策由策略表单点决定

新建 `child-run-retry-policy.ts`：

```ts
interface RetryDecision {
  retriable: boolean
  maxAttempts: number     // 0 = no auto retry
  backoffMs: number[]     // 每次重试的等待，越后越长
}

const RETRY_POLICY: Record<SkillChildRunTerminalReason, RetryDecision> = {
  'host_unavailable':       { retriable: true,  maxAttempts: 3, backoffMs: [1_000, 5_000, 30_000] },
  'persistence_failed':     { retriable: true,  maxAttempts: 2, backoffMs: [2_000, 10_000] },
  'process_restarted':      { retriable: true,  maxAttempts: 1, backoffMs: [0] },
  'launch_stuck':           { retriable: false, maxAttempts: 0, backoffMs: [] },
  'child_process_crashed':  { retriable: false, maxAttempts: 0, backoffMs: [] },
  'failed_skill':           { retriable: false, maxAttempts: 0, backoffMs: [] },
  'failed_subagent':        { retriable: false, maxAttempts: 0, backoffMs: [] },
  'cancelled_user':         { retriable: false, maxAttempts: 0, backoffMs: [] },
  'completed':              { retriable: false, maxAttempts: 0, backoffMs: [] },
  'checkpoint_budget':      { retriable: false, maxAttempts: 0, backoffMs: [] },
  'checkpoint_background':  { retriable: false, maxAttempts: 0, backoffMs: [] },
  'blocked_config':         { retriable: false, maxAttempts: 0, backoffMs: [] },
  'blocked_external':       { retriable: false, maxAttempts: 0, backoffMs: [] },
  'input_validation':       { retriable: false, maxAttempts: 0, backoffMs: [] },
  'tool_not_registered':    { retriable: false, maxAttempts: 0, backoffMs: [] },
}

export function decideRetry(terminalReason: SkillChildRunTerminalReason, attemptIndex: number): RetryDecision | null
```

**CI 验证**：`src/__tests__/child-run-retry-policy.test.ts`：
- it('host_unavailable retries up to 3 times with growing backoff')
- it('failed_skill never retries')
- it('all 17 terminal reasons covered (exhaustive switch)')
- it('decideRetry returns null when attemptIndex >= maxAttempts')

### E-Contract-5：circuit breaker 阻断 single-flight key 重复失败

新建 `child-run-circuit-breaker.ts`：每个 single-flight key（`scope|session|skillId|targetDigest`）维护滑动窗口。窗口期 = 5 分钟，阈值 = 5 次失败。命中阈值 → cooldown 状态持续 15 分钟。cooldown 期内 `startSkillChildRun` 直接返回 `circuit_break` failure（不进入 runner 实际逻辑）。

**CI 验证**：`child-run-circuit-breaker.test.ts`：
- it('records failures per single-flight key')
- it('after 5 failures within 5min, key enters cooldown')
- it('cooldown rejects new starts with circuit_break terminal')
- it('after cooldown duration, key recovers and accepts new starts')
- it('emit circuit_break metric on entering cooldown')

注意：circuit_break **不是新 terminalReason**（A0 词汇 invariant），是 startSkillChildRun 入口的同步 reject 路径。返回值用 `StartSkillChildRunResult` 的 `status: 'rejected_circuit_break'`（添加新 status 成员，需更新 status union）—— 或者复用 `host_unavailable` + 新 errorKind `'circuit_break'` 走"软 fail"路径（**首选这条**，避免动 status union）。

### E-Contract-6：child internal action 与 primitive 走相同 admission

CI 测试断言：当一个 tool 同时被 child internal action 路径与 primitive 路径调用时，admission 函数被调用的入参 shape 一致（`requiresExplicitAllowlist` / `allowedToolNames` / `isChildInternal` 三字段）。

**CI 验证**：`src/__tests__/tool-internal-admission.test.ts`、`src/__tests__/skill-child-runner.test.ts`、`src/__tests__/tool-gateway-registry.test.ts`：
- it('child internal action dispatches through executeToolCall')
- it('child internal action requires runSkillFromChildRunner and never falls back to runSkill')
- it('W4: child runner action goes through gateway admission before runtime dispatch')
- it('T6: gateway succeeds when input matches the same schema the public dispatch path resolves')

### E-Contract-7：A0/A1/B/C/D 不退化 + verify:e 绿灯

`verify:e` 内嵌 `verify:d`（如已 land）→ `verify:c` → `verify:b`（含 a0/a05/a1）。任一退化则 E fail。

`scripts/check-atomic-write.cjs` 每次都跑。

`eslint-rules/baseline.json` 在 `output-dir-*` / `child-retry-*` / `permission-context-*` namespace 零条目（hard rules）。

---

## 2. 架构决定（Architecture Decisions）

### D1. atomicWriteJson 提升为共享 helper

新文件 `src/main/modules/agent-control/atomic-write.ts`：

```ts
import { mkdirSync, writeFileSync, renameSync, fsyncSync, openSync, closeSync } from 'node:fs'
import { dirname } from 'node:path'

export function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  // fsync(tmp) before rename to flush data to disk before metadata update.
  // Avoids "rename succeeded but data not flushed" on power loss.
  const fd = openSync(tmp, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, path)
}

export function atomicWriteText(path: string, text: string): void { ... }
```

**理由**：
- `patch-config.ts` 已有的实现是正确骨架，但**少了 fsync(tmp)** —— POSIX rename atomic 保证文件系统一致性，但**不**保证数据已落盘。E 阶段顺手把 fsync 补上。
- `atomicWriteText` 同形态，给非 JSON 用（如 `runtime-manager.ts:587` 的 script 写入）。

### D2. outputDir lifecycle marker = sidecar JSON

每个 outputDir 内一个 `.lifecycle.json`，内容见 §1 E-Contract-2 schema。

**为什么是 sidecar 而不是数据库行的 lifecycle 字段**：
- DB row 已有 status/closeEvent，但 sweep 是文件系统层操作 —— 让 sweep 只读文件系统，不依赖 DB（runtime 启动顺序 / DB 可用性）。
- sidecar 是 self-describing：未来手工调试 / 跨进程查看 / external admin tools 都能读。
- DB row 与 sidecar 的同步性是 best-effort —— 如果 sidecar 缺失，sweep 用 dir 创建时间 + 30 天 grace 保守判定（不会误删活跃任务）。

### D3. 保留期默认 7 天，可配置

`READY_OUTPUT_DIR_RETENTION_DAYS` env，默认 `7`。`READY_OUTPUT_DIR_LEGACY_GRACE_DAYS` env，默认 `30`（无 sidecar 的目录额外宽限）。

**理由**：
- 7 天足够用户 "上周跑的 VEA，今天来续 / 看产物"。
- 7 天后还要回头看的属于"产物归档"需求 —— 走 user-action（`skill_export_artifact` 或类似），不是 child run lifecycle。
- legacy 30 天 grace 让旧部署升级时不立即删既有目录。

### D4. Sweep timer 复用 startReferenceHintSweep 形态

`SkillsRuntimeManager` 加 `startOutputDirSweep()` / `stopOutputDirSweep()`：
- 启动后 60s 首跑（与 reference hint sweep 错开）。
- 之后每 6 小时跑一次（GC 不需要高频，6h 足够）。
- App 退出时 `cleanupAgentRuntime` 调 stopOutputDirSweep。

### D5. retry 触发位置：runner.startSkillChildRun 入口

在 `startSkillChildRun(params)` 入口检查：
1. 该 single-flight key 是否在 cooldown？是 → 返回软 fail（`StartSkillChildRunResult.status='failed'` + closeEvent.error.kind='circuit_break'）。
2. 该 single-flight key 上次失败的 terminalReason 决定是否需要 schedule retry：
   - 不在 cooldown 且最近失败 reason 是 retriable → 这次 startSkillChildRun **是用户的"自然 retry"**，runner 正常执行。
   - 同时 runner 内部如失败，触发 internal-retry：在 finalize 之前根据 RETRY_POLICY 决定再跑一次（在同一 lifecycle 内，用 backoff timer）。

**这里有两层 retry**：
- **External retry**（用户主动重启，OS 进程级 / 用户自发）：runner 不主动重新尝试，只是不阻挡（除非 cooldown）。
- **Internal retry**（runner 在同一 lifecycle 内自动重试）：仅对 `host_unavailable` / `persistence_failed` 这种瞬态错误。

**E 阶段 W3 实现仅 external retry 路径 + circuit breaker**。Internal retry 留给后续（语义复杂，需要新 close event 类型，超出 E 范围）。

### D6. PermissionContext 是显式 gateway context，不是 runtime fallback

```ts
interface ChildGatewayParams {
  readonly skillId: string
  readonly action: string
  readonly childRunId: string
  readonly scopeId: string | null
  readonly sessionId: string | null
  readonly outputDir: string | null
  readonly runStatePath: string | null
  readonly childInternal: true
}
```

`SkillChildRunner.beginRunLoop` 内构造一个 permission，传给 `executeAction` closure。executor 把 permission 写入 `tool-executor.ts:childInternalSkillAction` context（已存在的字段）—— **本质是把 implicit 来源 explicit 化**。

**理由**：admission 函数 `tool-executor.ts:131` 已经做了正确的 check，但它依赖 caller "正确填上 context"。E 阶段把 caller 侧的 context 构造从隐式（runner 内部 `inDriverDepth` 推导）改成 explicit object，CI 才能断言 shape 一致。

### D7. circuit_break 走"软 fail"路径不增 status

`StartSkillChildRunResult.status` 已有 union: `started / running / paused / blocked / failed / completed / killed`. circuit-break 复用 `failed`，但 closeEvent 字段为：
```ts
{
  status: 'failed',
  terminalReason: 'host_unavailable',  // 复用既有可重试 reason
  error: { kind: 'circuit_break', message: 'single-flight key in cooldown until <ts>' }
}
```

**理由**：
- A0 词汇 invariant 锁住 terminalReason union —— 不能加新成员。
- circuit_break 在语义上是"暂时不可用"，复用 `host_unavailable` 是合理近似。
- error.kind 字符串区分（`'circuit_break'`）让 metric / UI 能分辨。

---

## 3. Worker 划分（7 队）

### W0 — Pre-flight Audit

**Owner**：general-purpose 1 人 / 0.5 天

**输出**：`docs/archive/2026-09-06/docs/superpowers/plans/2026-04-30-E-pre-flight-audit-report.md`

**任务**：
1. **O4 audit**：完整列出 `agent-control/` 与 `skills-runtime/` 下所有 JSON `writeFileSync` / `writeFile` 调用，按"是否 run_state 类"分桶。校验 §0.2 表。
2. **O1 audit**：给定一台已用 1 个月的 dev 环境（如有），跑 `du -sh <runtimeRoot>/outputs/*/*`，列出占用 top 10 outputDir 的 size 与 age；估算 7 天 retention 下能回收多少。如无 dev fixture，理论估算（每 child run 平均 200MB，每天 N 次）。
3. **O6 audit**：grep RSS 自动化代码（`rss-engine/`）找 child run 触发点，确认是否对失败做 backoff。如确认无，列出每个触发点 file:line。
4. **O8 audit**（**重点**）：审 child internal action 调用链：
   - VEA driver 的 `runSkill` plan 是否进 `tool-executor.ts:131` 的 admission？grep `executeSkillActionViaToolGateway` / `runSkillFromChildRunner` 调用链。
   - VEA driver 是否 spawn shell？审 `video-expert-child-driver.ts` 是否真的"不 spawn"。
   - 如果发现 driver 直接绕过 admission（spawn / 直接 fs op），列出每个绕过点。
5. 校验 D 是否已 land —— 影响 verify:e 链路。

**完成判据**：报告 push，每个 O 子项有数字化结论（不只是 "yes/no"）。

**依赖**：无。

### W1 — O4 atomic-write helper + 全量迁移

**Owner**：general-purpose 1 人 / 0.5-1 天

**目标文件**（新建）：
- `src/main/modules/agent-control/atomic-write.ts`：`atomicWriteJson` + `atomicWriteText`，按 D1。
- `scripts/check-atomic-write.cjs`：CI 扫描。
- `scripts/__tests__/check-atomic-write.test.cjs`：脚本测试。

**目标文件**（修改）：
- `src/main/modules/tools/skill-primitives/patch-config.ts`：删本地 `atomicWriteJson`，改 import shared helper。
- `src/main/modules/skills-runtime/runtime-manager.ts`：line 1517 / 1572 / 1784 改 atomicWriteJson；line 587 / 1636 视情况用 atomicWriteText。
- `src/main/modules/skills-runtime/skill-host-controller.ts`：line 237 / 246 / 288 改 atomicWriteJson 或 atomicWriteText。
- `src/main/modules/skills-runtime/custom-skill-registry.ts`：line 389 改 atomicWriteJson。

**新测试**（修改既有 / 新建）：
- `src/__tests__/atomic-write.test.ts`：
  - it('atomicWriteJson creates parent dir if missing')
  - it('atomicWriteJson is atomic — partial state never visible')（mock spawn kill 中 tmp file，断言 path 仍读得旧版本）
  - it('atomicWriteJson fsyncs before rename')

**完成判据**：
- `check-atomic-write.cjs` 在 main 跑 0 报错。
- `verify:b` 不退化。

**依赖**：W0。

### W2 — O1 outputDir 生命周期 + 后台 GC

**Owner**：general-purpose 1 人 / 1 天

**目标文件**（新建）：
- `src/main/modules/agent-control/output-dir-lifecycle.ts`：
  ```ts
  export interface OutputDirLifecycle { ... }  // §1 E-Contract-2 schema
  export function readLifecycle(outputDir: string): OutputDirLifecycle | null
  export function writeLifecycle(outputDir: string, lifecycle: OutputDirLifecycle): void  // 用 atomicWriteJson
  export function shouldRetain(lifecycle: OutputDirLifecycle, now: Date): boolean
  ```
- `src/main/modules/skills-runtime/output-dir-sweep.ts`：
  ```ts
  export function sweepOutputDirs(opts: { runtimeRoot: string; retentionDays: number; legacyGraceDays: number }): { reclaimed: string[]; skipped: string[] }
  ```
- `src/__tests__/output-dir-lifecycle.test.ts`、`src/__tests__/output-dir-sweep.test.ts`：见 §1。

**目标文件**（修改）：
- `src/main/modules/agent-control/skill-child-runner.ts`：在 `finalizeRun` 内、写完 DB row + recentCloses 之后，调用 `writeLifecycle(active.outputDir, { state: 'retained', terminalAt, retainUntil, ... })`。中态（budget_paused / recoverable_paused）**不写**。
- `src/main/modules/skills-runtime/runtime-manager.ts`：在 `start()` 内调 `startOutputDirSweep()`；在 `cleanup()` 内调 `stopOutputDirSweep()`。
- `src/main/modules/agent-control/tool-error-metrics.ts`：注册 `outputDirGc: 'output_dir_gc'`、`outputDirSweepFailed: 'output_dir_sweep_failed'`。

**完成判据**：
- `output-dir-lifecycle.test.ts` 4 测试通过。
- `output-dir-sweep.test.ts` 4 测试通过。
- 在 dev 环境跑一次 finalize 后能在 `<outputDir>/.lifecycle.json` 看到 sidecar。

**依赖**：W1（atomicWriteJson 共享 helper 已就位）。

### W3 — O6 retry policy + circuit breaker

**Owner**：general-purpose 1 人 / 1 天

**目标文件**（新建）：
- `src/main/modules/agent-control/child-run-retry-policy.ts`：`RETRY_POLICY` 表 + `decideRetry(reason, attemptIndex)`，按 §1 E-Contract-4。
- `src/main/modules/agent-control/child-run-circuit-breaker.ts`：
  ```ts
  export class ChildRunCircuitBreaker {
    constructor(opts: { windowMs: number; threshold: number; cooldownMs: number })
    recordFailure(key: string, terminalReason: SkillChildRunTerminalReason): void
    isInCooldown(key: string): boolean
    cooldownExpiresAt(key: string): number | null
  }
  ```
  默认 windowMs=300_000（5min）、threshold=5、cooldownMs=900_000（15min）。
- `src/__tests__/child-run-retry-policy.test.ts`、`src/__tests__/child-run-circuit-breaker.test.ts`：§1。

**目标文件**（修改）：
- `src/main/modules/agent-control/skill-child-runner.ts`：
  - `SkillChildRunner` 持有 `circuitBreaker: ChildRunCircuitBreaker` 实例。
  - `startSkillChildRun(params)` 入口：先算 single-flight key，问 `circuitBreaker.isInCooldown(key)`；是 → 直接返回 `failed` + `host_unavailable` + `error.kind='circuit_break'` 软 fail（不进 runner 实际逻辑）。
  - `finalizeRun(active, close)` 内：如果 close.status === 'failed' → `circuitBreaker.recordFailure(singleFlightKey, close.terminalReason)`；如命中阈值 → emit `child_run_circuit_break` metric。
- `src/main/modules/agent-control/tool-error-metrics.ts`：注册 `childRunCircuitBreak: 'child_run_circuit_break'`。

**完成判据**：
- 2 测试文件全过。
- `verify:b` Layer 1 / B contract 测试不退化（circuit breaker 在 happy path 不影响）。
- 手动构造 5 次连续 failed_skill → 第 6 次 startSkillChildRun 在 5min 内被 cooldown。

**依赖**：W0。可与 W1/W2/W4 并行。

### W4 — O8 PermissionContext 收口

**Owner**：general-purpose 1 人 / 1-1.5 天

**目标文件**（修改）：
- `src/main/modules/agent-control/skill-child-runner.ts`：
  - `executeAction` closure 走 `executeSkillActionViaToolGateway`，显式传 `childInternal` context。
- `src/main/modules/tools/tool-executor.ts`：child-internal action 必须依赖 `runSkillFromChildRunner`，不再 fallback 到 runtime `runSkill`。
- W0 audit 发现的 driver 直接 spawn / 绕过 admission 漏洞：在 W4 内 patch（如发现 0 漏洞，文档记录"audit 通过"）。

**完成判据**：
- `skill-child-runner.test.ts` 的 gateway admission 测试通过。
- `tool-internal-admission.test.ts` 既有测试不退化。
- W0 audit 记录的所有绕过点已 patch。

**依赖**：W0（audit 出输入）。可与 W1/W2/W3 并行（不冲突文件）。

### W5 — Lint / verify:e gate

**Owner**：general-purpose 1 人 / 0.5 天

**目标文件**（修改）：
- `package.json`：加 `verify:e` script。
- `eslint-rules/index.mjs` / `eslint.config.mjs`：如 W4 发现需 hard rule 锁某条 admission 模式，注册新 rule（按发现来定，可能为空）。

**verify:e 内容**：
```
"verify:e": "npm run verify:d && node scripts/check-atomic-write.cjs && node --test scripts/__tests__/check-atomic-write.test.cjs && npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/atomic-write.test.ts src/__tests__/output-dir-lifecycle.test.ts src/__tests__/output-dir-sweep.test.ts src/__tests__/skill-child-run-log.test.ts src/__tests__/child-run-retry-policy.test.ts src/__tests__/child-run-circuit-breaker.test.ts src/__tests__/skill-child-runner.test.ts src/__tests__/rss-visual-skill-child-run.test.ts src/__tests__/tool-internal-admission.test.ts src/__tests__/tool-gateway-registry.test.ts src/__tests__/tool-input-schemas-registry.test.ts"
```
（D 已 land，E gate 固定先跑 `verify:d`。）

**完成判据**：
- `npm run verify:e` 主分支跑成功。
- 故意把 `runtime-manager.ts:1517` 改回 `writeFileSync(*.json,...)` → check-atomic-write.cjs 报错。

**依赖**：W1-W4 全部 land。

### W6 — 文档同步 + 路线图状态

**Owner**：general-purpose 0.5 人 / 0.5 天

**改动清单**：

1. `CLAUDE.md` 新增 §6.16 防爆 + 减脆：
   ```
   ### 6.16 防爆 + 减脆（E 阶段）
   - **Atomic JSON write**：所有 run_state.json / config.json / runtime-state.json 写入走 `atomicWriteJson`（write-tmp + fsync + rename）。`writeFileSync` 直写 *.json 在 `agent-control/` / `skills-runtime/` 内被 `scripts/check-atomic-write.cjs` 拦截。
   - **outputDir 生命周期**：每个 child run 终态时写 `<outputDir>/.lifecycle.json` sidecar；`SkillsRuntimeManager.startOutputDirSweep` 每 6 小时回收 retainUntil 过期目录。默认保留期 7 天（`READY_OUTPUT_DIR_RETENTION_DAYS`）；legacy（无 sidecar）30 天 grace。
   - **Retry policy + circuit breaker**：`RETRY_POLICY` 表按 terminalReason 决定是否 retriable（`host_unavailable / persistence_failed / process_restarted` 可重试，其他不行）。同 single-flight key 5 分钟内连续 5 次失败进入 15 分钟 cooldown，期间 `startSkillChildRun` 返回软 fail（`error.kind='circuit_break'`）。
   - **PermissionContext**：child runner 调 skill action 时显式走 `executeSkillActionViaToolGateway` 的 child-internal context；admission 路径与 primitive 同审，`tool-internal-admission.test.ts` 与 `skill-child-runner.test.ts` 锁住。
   ```
2. `AGENTS.md` 同步。
3. 路线图 §5.1 把 E 行从工作量描述改为 `[x] completed YYYY-MM-DD`。
4. 路线图 §5.1.4 加 F 准入 note：F 阶段开工要求 E 的 7 条 hard contract 全绿。

**完成判据**：
- CLAUDE.md / AGENTS.md / 路线图同步。
- W5 已 land。

**依赖**：W5。

---

## 4. 团队依赖与执行顺序

```
W0 audit ─┬─→ W1 (atomic-write) ──→ W2 (outputDir GC, 用 atomic-write)
          ├─→ W3 (retry+circuit-breaker)
          └─→ W4 (PermissionContext)
                                   │
                                   └─→ W5 (verify:e gate) ──→ W6 (docs)
```

**串行段**：W0 → W1 → W2（W2 必须用 W1 的 helper）。W5 在 W1-W4 都 land 后跑。
**并行段**：W3 / W4 与 W1/W2 完全独立，可全程并行（不冲突文件）。

---

## 5. 端到端验证

```bash
# 1. 类型 + lint baseline
npm run typecheck
npm run lint:check
node scripts/check-eslint-baseline.cjs

# 2. E 自有 lint + 焦点测试
node scripts/check-atomic-write.cjs
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/atomic-write.test.ts \
  src/__tests__/output-dir-lifecycle.test.ts \
  src/__tests__/output-dir-sweep.test.ts \
  src/__tests__/skill-child-run-log.test.ts \
  src/__tests__/child-run-retry-policy.test.ts \
  src/__tests__/child-run-circuit-breaker.test.ts \
  src/__tests__/skill-child-runner.test.ts \
  src/__tests__/rss-visual-skill-child-run.test.ts \
  src/__tests__/tool-internal-admission.test.ts \
  src/__tests__/tool-gateway-registry.test.ts \
  src/__tests__/tool-input-schemas-registry.test.ts

# 3. 不退化 gate
npm run verify:c   # 含 verify:b、verify:a*
# 如 D 已 land：npm run verify:d

# 4. 故意 break 检查（CI 应该挡住）
# - 在 runtime-manager.ts 加一行 writeFileSync('foo.json', ...) → check-atomic-write 报
# - 修改 RETRY_POLICY 删掉某个 terminalReason → exhaustive switch 测试报

# 5. 手动 dev 烟测
# - 跑一次 VEA child run 跑完，看 outputDir 内有 .lifecycle.json
# - 把 retainUntil 改成过期，等 6 小时 sweep 触发，目录消失，metric 上报
# - 故意触发 5 次 host_unavailable → 第 6 次启动被 circuit break
# - VEA driver 内部 yt-dlp 调用，断点 SHELL_ALLOWLIST 被 hit
```

---

## 6. 关键文件路径速查

修改：
- `src/main/modules/tools/skill-primitives/patch-config.ts`（W1：删本地 atomicWriteJson 改 import）
- `src/main/modules/skills-runtime/runtime-manager.ts`（W1：5 处 writeFileSync 改 atomic；W2：startOutputDirSweep）
- `src/main/modules/skills-runtime/skill-host-controller.ts`（W1：3 处 writeFileSync 改 atomic）
- `src/main/modules/skills-runtime/custom-skill-registry.ts`（W1：1 处 writeFileSync 改 atomic）
- `src/main/modules/agent-control/skill-child-runner.ts`（W2：finalize 写 lifecycle；W3：startSkillChildRun cooldown gate；W4：build permission 传给 executeAction）
- `src/main/modules/tools/tool-executor.ts`（W4：explicit permission 接收）
- `src/main/modules/agent-control/tool-error-metrics.ts`（W2/W3：新 metric 注册）
- `package.json`（W5：verify:e）
- `CLAUDE.md` / `AGENTS.md`（W6）
- 路线图 §5.1（W6）

新建：
- `src/main/modules/agent-control/atomic-write.ts`（W1）
- `src/main/modules/agent-control/output-dir-lifecycle.ts`（W2）
- `src/main/modules/skills-runtime/output-dir-sweep.ts`（W2）
- `src/main/modules/agent-control/child-run-retry-policy.ts`（W3）
- `src/main/modules/agent-control/child-run-circuit-breaker.ts`（W3）
- `scripts/check-atomic-write.cjs`（W1）
- `scripts/__tests__/check-atomic-write.test.cjs`（W1）
- `src/__tests__/atomic-write.test.ts`（W1）
- `src/__tests__/output-dir-lifecycle.test.ts`、`src/__tests__/output-dir-sweep.test.ts`、`src/__tests__/skill-child-run-log.test.ts`（W2）
- `src/__tests__/child-run-retry-policy.test.ts`、`src/__tests__/child-run-circuit-breaker.test.ts`（W3）
- `docs/archive/2026-09-06/docs/superpowers/plans/2026-04-30-E-pre-flight-audit-report.md`（W0）

---

## 7. 显式 out-of-scope

不在 E 范围，留给 F / 后续 follow-up：

- **O2（跨 device single-flight 复用）**：设计意图未定，独立 ADR。
- **O3（parent × child budget 联动）**：需要 token estimator 准确度；监控精度问题，量级未到。
- **O5（e2e 真子进程链路）**：测试基建升级，独立 PR；E 不靠 e2e 完成验证。
- **O7（child run UI 控制面）**：产品体验，跟 UI 队走。
- **Internal retry**（runner 在同一 lifecycle 内自动重试）：语义复杂，需要新 close event 类型 / 新 status；超出 E 范围，留给后续。
- **L2 history compaction 算法**（D 阶段 stub）：D 已立 circuit breaker；E 不实做算法。
- **跨进程 sweep 协调**：多 Electron 实例同时 sweep 可能 race。E 接受 last-rename-wins 简化。
- **outputDir 归档 / 导出工具**：用户主动归档 7 天后产物的需求。E 不做。
- **`buildBudgetWarningMessage` 文案 / B4 残余**：D 阶段 reminder registry 范围。

---

## 8. 风险与缓解

### 8.1 atomicWriteJson 加 fsync 后写性能下降

**风险**：`patch-config.ts` 既有版本无 fsync，跑得快；E 加 fsync 后每次 atomic write 多一次 syscall + disk flush，run_state 高频写场景慢。

**缓解**：
- VEA driver 写 run_state 频次是 per-action（大约每 30s 一次）—— fsync 开销可忽略。
- 如发现某条路径写 run_state 高频（>10/s），那条路径不应该走 atomic write，应该走 buffered 写 + flush。E 不优化，记入 W0 audit 报告 follow-up。
- 单测覆盖 fsync 行为，确保不静默失败。

### 8.2 outputDir 7 天保留期太短 / 太长

**风险**：用户上次 VEA 跑完 8 天后回来想看产物 → 已 GC。

**缓解**：
- 7 天是默认值，可改 `READY_OUTPUT_DIR_RETENTION_DAYS=30`。
- W2 完成后在 CLAUDE.md §6.16 / 用户文档明确告知"7 天保留期"。
- 长期归档需求（30 天+）走未来的 `skill_export_artifact`，不是 child run lifecycle。
- 如运营反馈强烈，运行时改默认值，不需改代码。

### 8.3 circuit breaker 误判

**风险**：5 次连续 `host_unavailable` 可能是真实 host 长期故障，cooldown 阻断后用户手动重试也被拒 —— 误判为"系统 hang"。

**缓解**：
- cooldown 期内的软 fail 文案要清晰：`error.message` 包含"cooldown until <time>"。UI / turn-engine 渲染时透传给用户。
- env `READY_CHILD_RUN_CIRCUIT_BREAKER_ENABLED=0` 关掉（紧急运维降级）。
- W6 在 CLAUDE.md / AGENTS.md §6.13 feature flags 与 §6.16 写明这个 kill switch 和"重启清 cooldown"语义。

### 8.4 PermissionContext 改造引入 admission 漏洞

**风险**：W4 把 implicit `childInternal` 推导改为 explicit。如果迁移漏掉某条路径，那条路径的 admission 失效（变成"看起来过了 admission 但其实没过 child internal check"）。

**缓解**：
- `tool-executor.ts` 的旧 implicit 推导**保留**作为兜底 —— 只有 explicit permission 没传时才走 implicit。这样新路径迁移不完整也不会"裸奔"。
- `tool-internal-admission.test.ts` 与 `skill-child-runner.test.ts` 验证两条路径走相同 admission shape —— 任一漏迁都会被测试抓住。
- W4 完成后 follow-up：6 个月后 audit 一次"explicit permission 是否覆盖 100% 路径"，如是则删掉 implicit 兜底（独立 PR）。

### 8.5 W0 audit 暴露 driver 直接 spawn 漏洞

**风险**：W0 audit 发现 VEA driver 真的有"未走 admission 的 spawn"。

**缓解**：
- 这是**好事**——证明 O8 的存在。W4 范围扩展 patch 这条路径。
- 如发现的漏洞修不完（如 driver 设计上必须 spawn），W4 范围内只 patch 能 patch 的 + 在 audit 报告里列待解项；剩下的开 separate PR。
- W4 owner 在 audit 阶段给出"修不完"判定时立即 ESCALATE，不强行 land。

---

## 9. 与战略原则的对照

`CLAUDE.md §0.5` 5 条 + 升维 2 条原则在 E 的应用：

1. **先合同，后代码**：§1 给 7 条 hard contract，每条 CI 可验证。
2. **修根因，不修症状**：O1/O4/O6/O8 都是"已知投影点"，E 一次收口而不是逐 case 修补；CI lint rule 防止单产品再次绕过。
3. **拒绝 legacy 兼容分支**：W1 atomicWriteJson 全量迁移，不保留"既支持 atomic 又支持直写"双轨。但 W4 PermissionContext 保留 implicit 兜底是**有意外的安全保守**（避免迁移漏失 = 安全 hole），不是 legacy debt。
4. **形态意识**：CC-Source 没有 outputDir 复用 / 跨 turn 产物概念，沙箱也是单进程 CLI 简单形态。Ready 这 4 件全部是 Electron 多进程 + 跨 session 复用的**特化**需求，不能照抄 CC。
5. **CI 强制 > 文档约束 > 人审**：E-Contract-1/2/3/4/5/6 全部 CI；CLAUDE.md §6.16 是文档辅助。
6. **抽象的边界 = 形态的差异**：atomic-write / output-dir-lifecycle / retry-policy / circuit-breaker / permission 5 个新模块各自单一职责，边界清晰。
7. **重新做一遍优于继续打磨**：O8 PermissionContext **不**就 implicit 推导继续修补；改成 explicit object。

---

## 10. 文档维护

- E 完成后更新路线图 §5.1（W6）。
- 如 W0 audit 发现 §0.2 表数字与现实不符，**优先**修计划，不就地"算了"。
- W0 audit 报告产出后，如发现更多债（不在 O1/O4/O6/O8 范围），列入"E 后续 follow-up"段落，**不**塞进本计划。
- CLAUDE.md §6.13 的 feature flag 段落 W6 同步加上 `READY_CHILD_RUN_CIRCUIT_BREAKER_ENABLED` 与 `READY_OUTPUT_DIR_RETENTION_DAYS`。

---

## 11. Final Record（2026-05-01）

- HEAD：`18000aed7f0fe37ea2d8dc9493afa7cf15c23e16`。
- W0 audit：`2026-04-30-E-pre-flight-audit-report.md` 已产出；O4 实测为 12 个 direct write（8 JSON、3 text/config、1 临时 `.py` 不迁移），O6 terminal reason 为 17 个，O8 实测为 runner 绕过 gateway，硬 ESCALATE 条件未触发。
- W1 fsync 实测：50 次写入，p95 `5.655ms`，max `9.1ms`，低于 `100ms` 硬线；未启用全局 no-fsync，未发现需要局部 no-fsync 的路径。
- W5 反测：临时新增 `src/main/modules/agent-control/e-check-atomic-fixture.ts` 直写 JSON，`node scripts/check-atomic-write.cjs` 按预期报错；删除临时文件后检查恢复通过。
- W6 final verify：`npm run verify:e` 退出码 0；最终 E 专项块 `# tests 87 / # pass 87 / # fail 0`，duration `7181.016167ms`。`lint:check` 仍报告既有 `540 warnings / 0 errors`，未新增 error。
- Circuit breaker 运维说明已同步到 `CLAUDE.md` / `AGENTS.md`：`READY_CHILD_RUN_CIRCUIT_BREAKER_ENABLED=0` 是 kill switch；cooldown 为进程内存态，重启 Electron 会清空。
