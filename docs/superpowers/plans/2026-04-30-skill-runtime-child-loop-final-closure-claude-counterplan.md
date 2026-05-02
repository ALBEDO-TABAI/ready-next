---
enforce: false
---

# Skill Runtime Child-Loop Final Closure — Claude Counter-Proposal

> 用途：在 Codex 的 arrangement（同目录 `...arrangement.md`）基础上重组下一阶段计划。本文档是审查 + 反提案，不是 implementation plan；Codex 据此重写 implementation plan，再交回审查。

## 0. 对 Codex 安排的总评

Codex 准确识别了根因（"`SkillChildRun` 是 start-and-watch 包装，不是完整 lifecycle 服务"），覆盖了 6 个可见缺口（A–F）。但作为下阶段蓝图存在以下结构性问题：

1. **D 排在末尾错了。** `terminalReason` 字典是 child driver / awaiter / product / parent 之间的合同。先做 A/B/C 再回来扩字典，要么在中间用占位符（churn），要么各模块就地造词（drift）。D 必须先于 B（B 的核心问题就是 `await_timeout` 究竟是不是一个 close 状态）。
2. **C 把最关键的设计决策留给了实现者。** "child internal actions 用 public `ToolDefinition` 还是 internal-only `ToolDefinition`" 是 admission 语义命门，下阶段计划必须先选定再叫实现。
3. **resume 身份语义未定义。** resume 是新建 `childRunId` 还是延续同一个？这是契约 / single-flight / projection 的入口问题，Codex 整篇没说。
4. **observer wait 的并发与释放语义未定义。** 同一 `childRunId` 多次 `waitForSkillChildRunClose` 是 fan-out 还是拒绝？timeout 后 awaiter 订阅怎么释放？
5. **F 范围太窄。** 只改 `buildBudgetWarningMessage`。但 child-owned session 下还涉及 reference-skill hint / `filterSkillPrimitivesBySession` 的 primitive 曝光语义（CLAUDE.md §6.7、§6.12），plan 必须钉死。
6. **缺 rollback / feature gate。** resume command surface 是行为变更，没有 runtime flag 兜底。
7. **verify 基线不严谨。** "verify 仍因无关 lint 失败"是事实，但 Codex 给的"证明这些文件不在你 diff 里"是逃避；正确做法是先 snapshot baseline 的失败计数 / 文件 set，再要求 diff ≤ 0。
8. **测试名只描述行为，没给固定名。** plan 要求实现者用精确 it 名，那 plan 本身先做示范。
9. **`blocked` 是否可 resume 用 "when resumable" 含糊带过。** 应明确：`blocked` 不可由 parent 直接 resume，必须先解除 block（如 `skill_patch_config`），状态机自然转 `recoverable_paused` 后再 resume。

下面是我的重排与补充。

---

## 1. 设计前置：先确定 4 个未决合同

下阶段在动 production code 之前，**必须把这 4 个合同写定**，之后所有 workstream 才不会互相倒灌。

### 合同 1 — Child Run State Machine + Terminal Reason 字典（来自 Codex D，前置）

唯一权威定义放在 `src/main/modules/agent-control/skill-child-run-types.ts`，所有模块只读。

```ts
type ChildCloseStatus =
  | 'completed'
  | 'failed'
  | 'killed'
  | 'recoverable_paused'
  | 'budget_paused'
  | 'blocked';

type ChildTerminalReason =
  // 终态
  | 'completed_ok'                  // status=completed
  | 'cancelled_user'                // status=killed, 显式用户取消（唯一进 killed 的路径）
  | 'launch_stuck'                  // status=failed, launch 阶段 watchdog 触发
  | 'child_process_crashed'         // status=failed, 子进程崩溃（旧 infra_error 拆出）
  | 'host_unavailable'              // status=failed, runtime host 不可达
  | 'tool_not_registered'           // status=failed, child internal dispatch 找不到工具
  | 'input_validation'              // status=failed, schema 失败
  | 'skill_declared_failure'        // status=failed, skill 自身报错
  // 暂停态
  | 'budget_paused'
  | 'recoverable_paused'
  | 'blocked_external';

// observer 端独立结果，不进 closeStatus
type ChildWaitResult =
  | { kind: 'closed'; closeEvent: SkillChildCloseEvent }
  | { kind: 'observer_timeout'; childRunId: string; elapsedMs: number };
```

**关键规则：**

- `observer_timeout` **不是** close status，**不是** terminalReason；它是 awaiter 维度的独立结果。
- 旧 `terminalReason='infra_error'` 一律迁出到下面三种之一：`child_process_crashed | host_unavailable | tool_not_registered`。
- DB 读出旧字符串时走 `decodeLegacyTerminalReason()`，默认翻成 `child_process_crashed`（最保守解释），并 emit `legacyTerminalReasonCoerced` 指标，**不抛错**。

**状态转移表**（plan 必须照贴，禁止省略）：

| 当前 | 触发 | 下一 | 转换者 |
|---|---|---|---|
| running | normal exit | completed/completed_ok | child driver |
| running | crash throw | failed/child_process_crashed | child runner |
| running | host unavailable | failed/host_unavailable | child runner |
| running | tool not registered (internal) | failed/tool_not_registered | child runner |
| running | input schema fail | failed/input_validation | child runner |
| running | budget hit | budget_paused | child runner |
| running | recoverable pause | recoverable_paused | child driver |
| running | host_requirements 不满足 | blocked/blocked_external | child driver |
| running | 显式用户 cancel | killed/cancelled_user | parent.cancelSkillChildRun |
| running | observer timeout | running（**不变**） | parent.waitForSkillChildRunClose |
| recoverable_paused / budget_paused | resume | running | parent.resumeSkillChildRun |
| blocked | resume | error: `still_blocked`（保留 blocked） | parent.resumeSkillChildRun |
| blocked | block 解除（config 修复等） | recoverable_paused | child driver |
| completed / failed / killed | resume | error: `terminal_not_resumable` | parent.resumeSkillChildRun（拒绝） |

### 合同 2 — Resume 身份语义（Codex 完全漏项）

**结论：resume 复用同一 `childRunId`。**

- DB 行就地 update（status: paused → running），不新插入。
- `runStatePath / outputDir / singleFlightKey / progressFingerprint` 不变。
- supervisor / projection / contract 不需要重 attach。
- 把 resume 时间点记到 `metadata.lastResumedAt`（JSON 字段，不动 schema）。
- 与 CLAUDE.md §6.13 "continuation 全链路必须保留 durable skill handle" 一致。

否决方案 B（新 `childRunId` + `parent_child_run_id` 链）的原因：projection / contract 重组成本高、对当前问题零收益。

### 合同 3 — Child Internal Tool Admission（Codex 把这个最关键决策留给实现者了）

**结论：复用 `executeToolCall` 路径，新增 `visibility: 'internal'` 维度的 `ToolDefinition`。**

- `tool-registry.ts` 在现有 visibility 维度上新增 `'internal'`。`'internal'` 对 LLM 不可见，但 dispatch 走完全相同的 admission 链路：
  1. 定义查找
  2. 允许性检查（child internal allowed）
  3. Zod schema 校验
  4. dispatch / 错误形状
- VEA 子工具（如 `skill_video_expert_ai_analyze`）在 child runner 启动期注册为 `visibility: 'internal'`。
- `executeSkillActionViaToolGateway` 改为只走 `executeToolCall(toolName, args, { invoker: 'child_runner', allowInternal: true })`；**禁止**直接调 `runtimeManager.runSkill / runSkillFromChildRunner`。
- 找不到定义 → `errorKind: 'tool_not_registered'`（与公开链路 bit-equivalent）→ terminalReason `tool_not_registered`。

这一条选定后，Workstream C 的"用 public 还是 internal"自动消解。

### 合同 4 — Observer Wait 的并发与释放语义（Codex 没说，实现一定撞）

```ts
waitForSkillChildRunClose(childRunId, { timeoutMs, signal? }): Promise<ChildWaitResult>
```

- **fan-out**：同一 `childRunId` 多个并发 awaiter 全部允许，子进程仍只有一个；close event 来时所有 awaiter 同步收到。
- **timeout**：awaiter 返回 `observer_timeout`；**不 abort 子进程**；不影响其他 awaiter；不写 `skill_task_runs`。
- **awaiter 上游 abortSignal 触发**：仅 detach 该 awaiter，不影响子进程，不影响 sibling awaiter。
- **实现层**：`Map<childRunId, Set<Awaiter>>`；每个 awaiter 自己的 timer 与 signal listener；close event 来时清整个 Set。
- **observer 是只读**：不允许任何 SQL 写入。

---

## 2. 重排后的 Workstream 顺序

| 顺序 | 工作流 | 依赖 | 说明 |
|---|---|---|---|
| 0 | **D-Contracts**：合同 1+4 落地到 type、新建 `skill-child-state-machine.ts` 纯函数（`canResume / canCancel / decodeLegacyTerminalReason`） | 无 | 全程不动 production dispatch，纯静态合同 |
| 1 | **E**：repository 拆 `findActiveChildRunByX` vs `findChildRunByXAnyStatus`；`run-contracts.loadSkillRunContract` 改用 anyStatus | 无 | 只动 read 层 |
| 2 | **C**：`tool-registry` 加 `visibility: 'internal'`；`executeSkillActionViaToolGateway` 切到 `executeToolCall` | 合同 1+3 | dispatch 替换 |
| 3 | **B**：`waitForSkillChildRunClose` 抽出（fan-out）；`startSkillChildRunAndWait` 不再 cancel；RSS awaiter 翻译 `observer_timeout` 为"仍在运行" | 合同 1+4、C | 新 dispatch 已就位 |
| 4 | **A**：`resumeSkillChildRun` 在 parent continuation 接线；`TurnEngine` 在 `recoverable_paused/budget_paused + 用户继续意图` 时 resume；终态守卫；preferredToolNames 守卫 | D + E（anyStatus 查询）+ B（不影响 awaiter） | 接线层 |
| 5 | **F**：child-owned session 下 `buildBudgetWarningMessage` 分支 + `filterSkillPrimitivesBySession` 是否计入 child run + reference-skill hint 在 child-owned 场景下的曝光审计 | A | prompt 跟随最终 command 模型 |
| 6 | **Verify + docs + lint baseline diff** | 全部 | |

理由：D 是合同必须先；E 是只读层并发安全；C 是 dispatch 替换、要在 B 用 await 之前完成；A 依赖 E 的 anyStatus 查询和 D 的终态守卫。

---

## 3. 对 Codex 既有 acceptance gates 的修订

保留 Codex §2 全部，新增以下**强约束**：

- [ ] **resume 复用同一 `childRunId`**：DB 行就地 update，不新建。测试：`findChildRunById(childRunId)` 在 resume 前后是同一行，`metadata.lastResumedAt` 已更新。
- [ ] **`blocked` 不可由 parent 直接 resume**：`resumeSkillChildRun(blockedRun)` 返回 `still_blocked` 错误；只有 block 解除并转入 `recoverable_paused` 后才能 resume。
- [ ] **`waitForSkillChildRunClose` fan-out 正确**：同一 childRunId 两个并发 awaiter，子进程 close 时同步收到 close event；其中一个 timeout 不影响另一个。
- [ ] **awaiter signal cancel 不杀子进程**：上游 abortSignal 触发时，sibling awaiter 仍可继续等到 close。
- [ ] **legacy `terminalReason='infra_error'` 读出走 decoder**：测试断言 decoder 返回 `child_process_crashed` 并 emit `legacyTerminalReasonCoerced`。
- [ ] **child-internal tool 走完整 admission**：`tool-registry` 显式注册；child-internal 链路与公开链路在错误形状（`errorKind / detail`）上 bit-equivalent。
- [ ] **child-owned session 下 primitive 曝光语义**：plan 必须钉死 `filterSkillPrimitivesBySession` 是否把 active childRunId 计入"running/blocked skill task run"信号。建议：**计入**（与现有"task run 存在即曝光"语义一致），并在该函数添加注释 + 一条断言测试。
- [ ] **child-owned 长 skill 提示词不出现 `typed skill action` 字样**：覆盖 `buildBudgetWarningMessage` 与 `turn-frame-steering` 的 reminder 注入两个点。
- [ ] **lint baseline 不退化**：`npx eslint . --format json` 在 base commit 与 HEAD 各跑一次，错误数与文件 set 求差，diff 必须 ≤ 0。

---

## 4. 测试命名（精确，可 grep）

下阶段计划禁止再用"大概覆盖某行为"，必须用以下精确 it 名：

`src/__tests__/skill-child-state-machine.test.ts`（**新文件**，纯函数）
- `it('canResume returns true for recoverable_paused', ...)`
- `it('canResume returns true for budget_paused', ...)`
- `it('canResume returns still_blocked for blocked', ...)`
- `it('canResume returns terminal_not_resumable for completed', ...)`
- `it('canResume returns terminal_not_resumable for failed', ...)`
- `it('canResume returns terminal_not_resumable for killed', ...)`
- `it('decodeLegacyTerminalReason maps infra_error to child_process_crashed', ...)`
- `it('decodeLegacyTerminalReason preserves new vocabulary unchanged', ...)`

`src/__tests__/skill-child-runner.test.ts`（**追加**）
- `it('observer timeout returns observer_timeout result without aborting child process', ...)`
- `it('observer timeout does not change child run status to killed', ...)`
- `it('two concurrent awaiters receive the same close event', ...)`
- `it('one awaiter timeout does not affect a sibling awaiter still waiting', ...)`
- `it('awaiter abortSignal detaches awaiter without aborting child process', ...)`
- `it('resumeSkillChildRun reuses the same childRunId and updates DB row in place', ...)`
- `it('resumeSkillChildRun rejects with terminal_not_resumable on completed run', ...)`
- `it('resumeSkillChildRun rejects with still_blocked on blocked run', ...)`

`src/__tests__/tool-gateway-registry.test.ts`（**追加**）
- `it('child-internal action without ToolDefinition fails with tool_not_registered', ...)`
- `it('child-internal action shares admission shape with public action on schema mismatch', ...)`
- `it('child-internal action does not appear in LLM-visible tool list', ...)`

`src/__tests__/skill-child-run-end-to-end.test.ts`（**追加**）
- `it('loadSkillRunContract reconstructs contract from terminal childRunId', ...)`
- `it('loadSkillRunContract reconstructs contract from terminal outputDir', ...)`
- `it('loadSkillRunContract reconstructs contract from terminal runStatePath', ...)`
- `it('single-flight active lookup ignores terminal completed row with same key', ...)`
- `it('latest-by-skill fallback excludes terminal rows', ...)`

`src/__tests__/turn-frame-steering.test.ts`（**追加**）
- `it('TurnEngine resumes child on user 继续 intent when close=recoverable_paused', ...)`
- `it('TurnEngine resumes child on user 继续 intent when close=budget_paused', ...)`
- `it('TurnEngine surfaces terminal result on completed child without resuming', ...)`
- `it('TurnEngine never injects typed VEA action into preferredToolNames when childRunId exists', ...)`
- `it('budget warning omits typed skill action wording when frame is child-owned', ...)`
- `it('budget warning retains typed skill action wording when no childRunId', ...)`

`src/__tests__/rss-visual-skill-child-run.test.ts`（**追加**）
- `it('RSS awaiter translates observer_timeout to still_running, not user_cancel', ...)`
- `it('RSS awaiter abandons subscription on its own abortSignal without aborting child', ...)`

`src/__tests__/skill-child-runtime-decisions.test.ts`（**追加**）
- `it('crash-shaped throw produces terminalReason=child_process_crashed', ...)`
- `it('runtime host unavailable produces terminalReason=host_unavailable', ...)`
- `it('cancelSkillChildRun maps to killed/cancelled_user only on explicit user path', ...)`

---

## 5. 文件改动清单（Codex 必须按此细化到函数级）

下阶段 plan 必须在每个文件下列出：（a）类型/导出变化；（b）函数签名变化；（c）dispatch 路径变化；（d）每个变化对应的红测试名。

候选文件（★ 标注为新增）：

- ★ `src/main/modules/agent-control/skill-child-run-types.ts`：扩 `ChildTerminalReason`、新增 `ChildWaitResult`。
- ★ `src/main/modules/agent-control/skill-child-state-machine.ts`：新文件，纯函数 `canResume / canCancel / decodeLegacyTerminalReason`。
- `src/main/modules/agent-control/skill-child-runner.ts`：`resumeSkillChildRun`（in-place update）、`waitForSkillChildRunClose`（fan-out + signal）、`cancelSkillChildRun` 收紧到显式用户路径。
- `src/main/modules/skills-runtime/runtime-manager.ts`：`startSkillChildRunAndWait` 改用 `waitForSkillChildRunClose` 的 `observer_timeout` 返回，**不再** 调 `cancelSkillChildRun`。
- `src/main/modules/agent-control/turn-engine.ts`：`computeChildContinuationDecision` 区分"继续/取消/查状态/直答"；`recoverable_paused / budget_paused + 用户继续意图` 路由到 `resumeSkillChildRun`；终态走 surface 不 resume；`buildBudgetWarningMessage` 加 child-owned 分支。
- `src/main/modules/agent-control/turn-frame-steering.ts`：`preferredToolNames` 在 `childRunId` 存在时禁止注入 typed VEA actions。
- `src/main/modules/agent-control/run-contracts.ts`：`loadSkillRunContract` 改用 `findChildRunByXAnyStatus`；latest-by-skill fallback 仍用 active-only。
- `src/main/modules/repositories/skill-task-run-repository.ts`：拆出 `findActiveChildRunBy{RunStatePath|OutputDir|SingleFlightKey|Id}` 与对应的 `*AnyStatus` 版本。
- `src/main/modules/agent-control/tool-registry.ts`：新增 `visibility: 'internal'`；child runner 启动期注册 VEA 子工具的 internal definition。
- `src/main/modules/tools/tool-executor.ts`：`executeToolCall` 接受 `allowInternal: boolean`；child internal 调用走该入口。
- `src/main/modules/rss-engine/item-analysis-manager.ts`：`observer_timeout` 翻译为"still running"产品语义；不写成功；保留 child handle。
- `src/main/modules/agent-control/skill-reference-hints.ts` / `filterSkillPrimitivesBySession`：明确 active childRunId 是否计入 primitive 曝光信号；落注释 + 测试。
- 文档同步：`CLAUDE.md` §6.7 / §6.13、`docs/superpowers/...` 子页。

---

## 6. Rollback / Feature Gate

- `process.env.READY_SKILL_CHILD_RESUME_ENABLED`，默认 `'1'`；`'0'` 时 `TurnEngine` 跳过 resume，回退到现有 checkpoint 行为；emit `skillChildResumeDisabledByFlag`。
- `process.env.READY_SKILL_CHILD_INTERNAL_STRICT_ADMISSION`，默认 `'1'`；`'0'` 时 `executeSkillActionViaToolGateway` 回退到旧的 telemetry-only 直调 `runtimeManager.runSkill`；emit `skillChildInternalAdmissionRelaxed`。
- 文档（CLAUDE.md §6.13）写明：默认开，出问题切 `'0'` 即可；不允许通过删代码回退。

---

## 7. Verify Bar（取代 Codex §6）

```bash
# 0. baseline lint snapshot（在分支基底上跑，记录已有失败）
git stash --include-untracked
git rev-parse HEAD~1 > /tmp/before.sha   # 或 main merge-base
git checkout "$(cat /tmp/before.sha)"
npx eslint . --format json > /tmp/lint-baseline.json 2>/dev/null || true
git checkout -
git stash pop || true

# 1. 类型
npm run typecheck

# 2. 焦点测试
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/skill-child-state-machine.test.ts \
  src/__tests__/skill-child-runner.test.ts \
  src/__tests__/skill-child-single-flight.test.ts \
  src/__tests__/skill-child-runtime-decisions.test.ts \
  src/__tests__/skill-child-run-end-to-end.test.ts \
  src/__tests__/tool-gateway-registry.test.ts \
  src/__tests__/tool-input-schemas-registry.test.ts \
  src/__tests__/rss-visual-skill-child-run.test.ts \
  src/__tests__/task-projection-sync.test.ts \
  src/__tests__/turn-frame-steering.test.ts

# 3. lint diff（不允许新增错误）
npx eslint . --format json > /tmp/lint-head.json 2>/dev/null || true
node -e '
  const b = require("/tmp/lint-baseline.json");
  const h = require("/tmp/lint-head.json");
  const count = (a) => a.reduce((n, f) => n + (f.errorCount || 0), 0);
  const bc = count(b), hc = count(h);
  if (hc > bc) { console.error(`lint regressed: ${bc} -> ${hc}`); process.exit(1); }
  console.log(`lint ok: ${bc} -> ${hc}`);
'

# 4. full verify（允许失败，但失败必须只来自 baseline 文件集；步骤 3 已机器证伪）
npm run verify || true
```

> 把 "verify 失败可接受" 从主观判断变成可证伪：lint diff 不涨即过。

---

## 8. 不允许的实现方式（取代 Codex §7）

保留 Codex §7 全部，并加：

- 不允许 resume 时新建 `childRunId`（违反合同 2）。
- 不允许 child-internal action 通过 telemetry-only 通过 admission（违反合同 3）。
- 不允许 observer timeout 触发任何 SQL 写入到 `skill_task_runs`（observer 是只读）。
- 不允许新增 `terminalReason` 不更新 `decodeLegacyTerminalReason`。
- 不允许 `blocked` 由 parent.resume 直接转 running（必须经状态机的 `blocked → recoverable_paused`）。
- 不允许测试只 stub 不跑真路径（与 commit `9fb93c9` 的 child runtime 验证门一致）。
- 不允许把 `experimental` flag 写死成 always-on 而不留可关闭通道。

---

## 9. Handoff

Codex 据此 counter-proposal 重写 implementation plan，落到：

```
docs/superpowers/plans/2026-04-30-skill-runtime-child-loop-final-closure-implementation.md
```

implementation plan 必须满足：

1. §1 的 4 个合同已映射到具体 type / 函数 / 测试。
2. §2 的 workstream 顺序按 D-Contracts → E → C → B → A → F → Verify。
3. §4 的 it 名一字不差出现在新增测试文件里。
4. §5 的每个文件都有"类型变化 / 签名变化 / dispatch 变化 / 红测试名"四项。
5. §6 的两个 env flag 在代码里有读取点 + 默认值 + metric。
6. §7 的 verify 步骤可机器执行。

完成后由我审查 implementation plan，再开实施。
