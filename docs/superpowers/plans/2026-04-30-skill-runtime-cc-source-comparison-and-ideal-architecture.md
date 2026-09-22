---
enforce: false
documentation_status: archived-in-place
archived_at: 2026-09-06
---

> 原位归档（2026-09-06）：固定历史证据仍引用此路径。保留此路径不代表全文仍是当前合同；其中的状态、源码位置和待办属于原记录。现行约束见 [当前运行时合同](../../architecture/current-runtime-contracts.md)，归档去向见 [文档清单](../../documentation-inventory.md)。

# CC-Source 对照分析 + Ready 项目理想架构路线

> **写作背景**：上一份文档（`2026-04-30-skill-runtime-residual-architectural-debt.md`）盘点了 Layer 1 完成后剩下的 26 项架构债（5 根因 + 5 次生债 + 8 盲点 + 小品味债）。本文档去 `/Users/user/Documents/实验田/CC-Source`（Claude Code 2.1.88 源码——Anthropic 自家的"标准答案"）对照，看每条根因 / 盲点在工业级 agent harness 里是怎么处理的，再翻译到 Ready 项目的形态约束下，得出"理想架构"路线。
>
> **关键预判**：CC-Source 不是照抄目标。它和 Ready 是不同形态的产品，照抄会错。本文核心工作是**翻译**——理解 CC 的设计哲学 → 在 Ready 的约束下重新表达。

---

## 0. 战略原则（必须比上一份更狠地刻进脑海）

上一份文档已写 8 条北极星原则。这一份再加 3 条**形态意识**原则：

1. **不要把 CC-Source 当圣经。** 它是 REPL 形态、单进程、每个 turn 短暂；Ready 是长任务形态、跨进程、产物复用是核心需求。形态错位 → 照抄出来的代码是错的。
2. **学设计哲学，不学具体类。** 比如 CC 用 `AbortController` 树 + `cleanupRegistry` 解决资源回收，Ready 不必精确照抄这两个类，但应该吸收"信号传播 + 中央回收注册"这一组合。
3. **每一条"理想架构"建议都必须问一句：CC 没有这个问题是因为它本来就没这个需求，还是因为它解得更好？** 前者照抄会引入复杂度，后者照抄能解掉债。

---

## 1. CC-Source 项目快速画像

- 包名：`@anthropic-ai/claude-code` 2.1.88
- 形态：CLI REPL — 用户交互一轮，模型响应一轮，工具调用嵌在响应里
- src/ 结构（与 Ready 对照）：
  - `Task.ts` / `tasks/` — 任务状态机（与 Ready `skill-task-runs` + child runner 对应）
  - `coordinator/` — 多 agent 协调（Ready 没有直接对应）
  - `query/` + `QueryEngine.ts` — 模型调用循环（Ready `turn-engine.ts`）
  - `services/` — 后台服务（如 cleanupRegistry）
  - `tools/` — 工具实现
  - `skills/` — Skill 系统（Ready 同名）
  - `state/` — 状态管理
- 测试位置：**源码包里无 `__tests__/`**——测试在 Anthropic 私有 repo，本数据点不可参考

---

## 2. 五个维度对照（CC-Source 的设计 vs Ready 当前现状）

### 维度 1 — 词汇 invariant（status / terminal reason）

#### CC-Source

```ts
// src/Task.ts:15-20
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed'
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}
```

- **5 个状态**——极简。
- **没有 paused / blocked / queued**——因为 CC 没这些概念。
- **abort reason 直接从 `AbortSignal.reason` 字段传**（`utils/abortController.ts:35` 的 `weakChild.deref()?.abort(parent?.signal.reason)`），不做映射层。
- **没有 brand type / factory function**——状态空间小到不需要。

#### Ready 当前

- 8 个 child run 状态 + 16 个 terminal reason + row-level 5 个 status，三层映射有损（`mapChildStatusToRowStatus` 把 8 → 5）。
- `infra_error` 仍在 union 里被 9 处写入端当 catch-all。

#### 翻译到 Ready 的理想

**关键洞察**：CC-Source 没有这个问题是因为**状态空间本来就小**。Ready 状态空间大有不可避免的部分（pause/resume/blocked 是真实需求），但**也有可避免的扩张**：

- 评估 8 状态能否合并：`queued` 与 `running` 的实际差异很小（runner 启动是同步的），是否能合并？
- `recoverable_paused` 与 `budget_paused` 的下游处理几乎一致，是否合并为单一 `paused` + `pauseReason: 'recoverable' | 'budget'`？
- 16 个 terminal reason 是否真的都需要独立分桶？
  - dashboard 视角看，`completed_ok / cancelled_user / launch_stuck / blocked_*` 是 4 个真正语义独立的桶，其余 12 个能不能折叠为子分类（`failure_kind: 'crash' | 'host' | 'tool' | 'validation' | 'declared'`）？

**学 CC 的两点**：
1. **abort.reason 直接传递**——Ready 的 `abortController.signal.reason` 现在没被 carry 到 close event 里（cancel 路径手动构 `cancelled_user`）。如果 cancel reason 直接走 abort.reason 链，可以省掉一半"为什么是这个 terminalReason"的语义模糊。
2. **状态守卫函数**（`isTerminalTaskStatus` 模式）——Ready 已经有 `classifySkillChildRunStatus`，但用得不彻底。所有状态比对都应走守卫，禁止字面量。

**不学 CC 的一点**：
- CC 没有 brand type / factory，**Ready 仍然需要 factory**（`mapDriverThrowToTerminalReason`）——因为 Ready 的失败模式更复杂（host_unavailable / tool_not_registered / input_validation 等真的是不同类）。这是 Ready 的形态特性，不是债。

---

### 维度 2 — System message / prompt 注入协调

#### CC-Source

两层体系：

**层 1**：静态 `systemPromptSection`（src/constants/systemPromptSections.ts）

```ts
export function systemPromptSection(name: string, compute: ComputeFn): SystemPromptSection {
  return { name, compute, cacheBreak: false }
}
export function DANGEROUS_uncachedSystemPromptSection(name, compute, _reason) {
  return { name, compute, cacheBreak: true }
}
```

- 每个 section 命名 + 是否打破缓存。
- `buildEffectiveSystemPrompt`（src/utils/systemPrompt.ts:41-75）按优先级堆叠：`override > coordinator > agent > custom > default`。

**层 2**：工具结果内联 `<system-reminder>` 标签（src/tools/FileReadTool/FileReadTool.ts:715）——每个工具自己决定是否注入。

#### Ready 当前

至少 4 处独立注入：
1. `buildBudgetWarningMessage`（turn-engine）
2. `turn-frame-steering` reminder
3. `SkillContextOrchestrator.tryInlineReferenceSkillDoc`
4. close event 自然语言化（Layer 1 抽出的 `renderChildCommandOutcome` 是局部解）

它们互不知道彼此说了什么，B4 就是直接打架的实证。

#### 翻译到 Ready 的理想

**关键洞察**：CC 没有 reminder registry——它有 prompt section 优先级链 + 工具内联两层。但 CC 的注入点远少于 Ready，且工具内联 reminder 跟工具调用上下文一一对应（FileReadTool 自己加），不会跨工具冲突。

Ready 的注入点更多 + 跨模块（budget warning 来自 turn-engine，steering 来自 frame-steering，reference skill 来自 orchestrator——它们看的 frame 字段不一样）。**直接照抄 CC 的"section 优先级链"不够用**。

**理想方案**：

抽 `SystemReminderRegistry`，但用 CC 的优先级链作为 dedupe / 冲突消解的基础规则：

```ts
type ReminderTopic =
  | 'budget'
  | 'child-owned'
  | 'reference-skill'
  | 'child-command-outcome'

interface ReminderEntry {
  topic: ReminderTopic
  priority: number      // override > coordinator > agent > custom > default
  conflictsWith?: ReminderTopic[]   // 注册时被自动 suppress
  text: string
  source: string        // 'budget-warning' | 'frame-steering' | ...，便于审计
}

class SystemReminderRegistry {
  register(entry: ReminderEntry): void
  resolve(): { combined: string; suppressed: ReminderEntry[] }   // suppressed 暴露给 metric
}
```

- 优先级链借自 CC。
- conflictsWith 是 Ready 多注入点的特有机制——CC 不需要因为它注入点少。
- `suppressed` 暴露成 metric，审计两个 reminder 是否经常打架（B4 类问题的早期信号）。

---

### 维度 3 — 任务 / agent lifecycle（pause / resume / cancel）

**这是 CC 与 Ready 最大形态差异的地方。慎重对照。**

#### CC-Source

```ts
// src/utils/abortController.ts:68-99
export function createChildAbortController(parent: AbortController, maxListeners?): AbortController {
  const child = createAbortController(maxListeners)
  if (parent.signal.aborted) {
    child.abort(parent.signal.reason)
    return child
  }
  const weakChild = new WeakRef(child)
  const weakParent = new WeakRef(parent)
  const handler = propagateAbort.bind(weakParent, weakChild)
  parent.signal.addEventListener('abort', handler, { once: true })
  child.signal.addEventListener('abort', removeAbortHandler.bind(weakParent, new WeakRef(handler)), { once: true })
  return child
}
```

- **AbortController 树**：parent → child via `WeakRef`，防止内存泄漏。
- **没有 pause/resume**：cancel 即 abort，"resume" 是从持久化历史新开 query engine + 新 abort controller，**不复用 id**。
- **stopTask** 是单出口（`src/tasks/stopTask.ts:38-100`），所有终止都经此一处。
- **CleanupRegistry**（`src/utils/cleanupRegistry.ts:14-16`）集中管理 cleanup 函数。

```ts
export function registerCleanup(cleanupFn: () => Promise<void>): () => void {
  cleanupFunctions.add(cleanupFn)
  return () => cleanupFunctions.delete(cleanupFn)
}
```

#### Ready 当前

- **没有 AbortController 树**：每个 child runner 自建 controller，turn-engine 取消时是手动调 `cancelSkillChildRun`，不靠信号传播。
- **有 pause/resume，复用 id**（Layer 1 修复后才正确生效）。
- **没有集中 cleanup registry**：cleanup 散在各处（runner 的 `recentCloses` ring eviction、driver 的 launch-stuck timer cleanup、observer wait 的 timer/listener cleanup 等）。

#### 翻译到 Ready 的理想

**关键洞察**：

CC-Source 选择"resume = 新 instance 从持久化重建"是**有意的简化**——它不需要 outputDir 复用、不需要进度断点续跑。Ready 选择 "resume = 同 id in-place 续跑" 是因为 VEA 长任务的 outputDir/run_state 复用是核心 UX。

**Ready 的形态决定了不能照抄"不复用 id"模式**。但可以照抄两件事：

**抄 1：AbortController 树形传播**

- 当前 turn-engine 的 abortSignal 跟 child runner 的 controller 是分开的。如果用 CC 的 `createChildAbortController(parentSignal)` 模式：
  - turn-engine 自己有 controller（用户取消 turn 时 abort）。
  - child runner 创建 ActiveRun 时 `child = createChildAbortController(parentSignal)`。
  - 用户取消 turn → parent abort → child 自动 abort（信号传播）。
  - WeakRef 防止持有 parent 内存。
- **解掉的问题**：A1 修复时遗留的"resume 中间窗口的取消语义"（counter-proposal §3 提到，`cancelSkillChildRun` 在 resume 立即返回的 case 下走 `if (!active)` 分支）会更清晰——所有取消走信号传播，不需要管 active map 是否还有 entry。

**抄 2：CleanupRegistry**

- 当前 child runner 的 `recentCloses` ring eviction（写死 64）、launch-stuck timer 的 unref()、observer wait 的 timer/listener 清理，都是**散在各自模块的 ad-hoc cleanup**。
- 引入 `ChildRunCleanupRegistry`（child runtime 局部的；不是全局——避免和 CC 的 cleanupRegistry 跨项目混淆）：
  - ActiveRun 创建时 `register(() => clearTimeout(launchStuckTimer))`。
  - finalize 时统一 `runRegisteredCleanups(childRunId)`。
  - **副产品**：N2（resume 清状态切两半）自然解——resume 启动新 lifecycle 时，先 `runRegisteredCleanups` 旧的，再 `prepareResumeLifecycle`。
- **解掉的问题**：N2 + N3（close event mutability，可以在 register 时 freeze）+ O1 的一部分（outputDir 清理可以注册到这个 registry——长 lifecycle 上的资源跟着 lifecycle 一起回收）。

**不抄 1：状态空间不能简化到只有 5 个**

- CC 没有 paused 是因为它根本没长任务。Ready 必须保留。但词汇可以收紧（见维度 1 的状态合并讨论）。

---

### 维度 4 — 测试规约 + e2e 链路

#### CC-Source

- 包源里**无测试**——测试在 Anthropic 私有 repo。
- 仅在 prompts.ts:207-211（Ant-only）有"必须 verify it actually works"这种代码注释级提醒。

#### Ready 当前

- 大量 unit/component/contract 测试，全部用 fake driver/runtime/repository。
- B3：source-string assertion 当行为测试用。
- 历史 A1：测试 helper（`setupRunner`）暗中破坏生产 invariant。
- O5：无真 e2e 链路（不跑真子进程）。

#### 翻译到 Ready 的理想

**关键洞察**：CC 这个数据点对我们没有直接参考价值——它的测试在私有 repo 我们看不到。但**反过来想**：CC 不在公开源码里强制测试规约，靠的是 Anthropic 内部工程文化 + code review 严格度。Ready 没有那个文化基础，**必须**用机制强制。

**理想方案不变**（沿用上一份文档的根因 3 修法）：
1. test helper 加 `__breaksInvariant: string[]` 标记 + metric。
2. 自定义 ESLint rule 禁止 `readFileSync(*.ts)` + regex 的 source-grep 反模式。
3. e2e 链路要建（O5 留到阶段 E）。

---

### 维度 5 — 文件系统 / 产物 / sandbox / retry

#### CC-Source

- `cleanupRegistry`（如上）用于资源回收。
- 原子写靠**代码注释 + 同步块**（FileWriteTool.ts:267 注释 "Please avoid async operations between here and writing to disk to preserve atomicity"）——**没有 mkdtemp/rename 模式**。
- Retry 仅在 QueryEngine 的 model fallback（src/QueryEngine.ts:895-926）——**tool 层无 retry**。
- Sandbox 在 `ToolPermissionContext`（权限系统）层，不在 shell 层。

#### Ready 当前

- 无 cleanup registry。
- O4：run_state 没有 atomic write 保护。
- O6：tool 层无 retry / circuit-breaker。
- O8：sandbox 散在 skill primitive 各自的 SHELL_ALLOWLIST 等位置。

#### 翻译到 Ready 的理想

**抄 1：CleanupRegistry 模式**——已在维度 3 提出。

**抄 2：Retry 在高层不在 tool 层**——CC 的设计决定值得借鉴。
- O6 不要在 tool dispatch 层加 retry。retry 应该在 child run 层面（"这个 child run 第 N 次重试"），不在 tool 调用层（"这个 tool 调用第 N 次"）。
- 后者会无限递归：tool 调用 retry → 失败 → 上层 child run retry → 重新发起 tool 调用 → 又 retry → ...
- 应在 `startSkillChildRun` 入口决定 retry 策略，且只 retry "已知 retriable" 的 terminalReason（host_unavailable / process_restarted），不 retry crash / validation。

**抄 3：Sandbox 上移到权限层**
- O8 不要在每个 skill primitive 各自实现 allowlist；应该有一个 `ChildRunPermissionContext`（类比 CC 的 `ToolPermissionContext`），把"这个 child run 允许哪些 primitive、哪些 shell 命令、哪些 outputDir 路径"集中表达。
- skill primitive 的 SHELL_ALLOWLIST 改为读这个 context。
- **副产品**：未来某个 skill 想要更宽松的 shell（例如开发模式），只需提供不同的 PermissionContext，而不是 fork primitive 实现。

**不抄：原子写靠注释**
- CC 用代码注释表达原子约束（"avoid async operations here"）。这种 fragile，下次有人无意 await 一下就破坏。
- Ready 的 O4 应该走真正的 atomic write：`mkdtemp + rename` 或 `write to .tmp + rename`，从机制层面保证。注释级保证不是合同。

---

## 3. Ready 项目本质形态差异（"不能照抄"的根本原因）

总结上面 5 个维度的对照，Ready 与 CC-Source 的关键形态差异：

| 维度 | CC-Source | Ready | 含义 |
|---|---|---|---|
| 交互形态 | REPL，每 turn 短暂 | 长任务（VEA 30min）+ REPL | Ready 必须有 pause/resume，CC 不需要 |
| 进程形态 | 单进程 CLI | Electron 多进程（main / renderer / sidecar）+ 跨进程恢复 | Ready 多一层"进程边界 invariant" |
| 产物 | 临时（reset 即可） | 持久化（outputDir 用户拥有，跨 session 引用） | Ready 多一层"产物 lifecycle" |
| 子任务复用 | 不复用，每次新建 | 必须复用（VEA 30min 不能每次重跑） | Ready 多一层 single-flight + reusable 语义 |
| 测试可见性 | 私有 repo 测试 | 公开 monorepo 测试 | Ready 必须有公开规约 |
| 多产品共享 | 单 CLI，单角色 | 浏览器 / 文档 / RSS / 日历 / Skill 共享 turn-engine | Ready 必须有 multi-domain 协调 |

**这意味着**：CC-Source 的"标准答案"在 5 个维度上各自只对了**一部分**——
- 维度 1（词汇）：CC 简到不需要，Ready 简化空间有限。学守卫函数风格。
- 维度 2（reminder）：CC 的优先级链是 dedupe 基础，Ready 在它之上加 conflict-resolution。
- 维度 3（lifecycle）：CC 的 AbortController 树 + cleanupRegistry 直接抄，但 resume id 复用是 Ready 的形态特性，不能改。
- 维度 4（测试）：CC 数据点不可参考。
- 维度 5（资源）：抄 cleanupRegistry + retry 高层 + sandbox 上移；不抄注释级原子写。

---

## 4. Ready 理想架构（最终方向）

把上面所有翻译合并：

### 4.1 Lifecycle 层

- **AbortController 树**：turn-engine 持有 root signal；child runner 创建 ActiveRun 时 `controller = createChildAbortController(turnSignal)`。取消信号自动从 turn 向 child 传播。
- **resume 仍复用 id**（Layer 1 已实现），但内部清理走新引入的 `ChildRunCleanupRegistry`。
- **stopChildRun 单出口**（类比 CC 的 stopTask）：所有终止路径（cancel / abort / failure / completion）走同一个 finalize 路径。

### 4.2 资源层

- **`ChildRunCleanupRegistry`**（child runtime scope，不全局）：register / runAll on lifecycle end。
- **outputDir GC**：注册"完成 N 天后清理"的 cleanup 函数，由独立 sweeper 跑。
- **atomic write**：driver 写 run_state.json 用 `write-to-tmp + rename` 模式，不靠注释约束。
- **close event Object.freeze**：finalize 完构造的 close event 一律 freeze。

### 4.3 Prompt 层

- **`SystemReminderRegistry`** with priority chain（学 CC）+ conflicts-with（Ready 加）+ suppressed metric。
- 现有 4 个注入点改为 registry consumer。

### 4.4 词汇层

- 评估状态合并（queued+running、recoverable_paused+budget_paused = paused with reason）。
- 删 `infra_error` union 成员。
- `mapDriverThrowToTerminalReason` 集中 factory。
- 所有状态比对走守卫函数（`isTerminal` / `isPaused` / `isResumable`），禁止字面量。
- row-level `lifecycle` 列区分 child_run / task_run / detached。

### 4.5 控制流层

- **Retry 上移到 child run 启动**（不在 tool 层），只 retry 已知 retriable 的 terminalReason，带 backoff + circuit-breaker。
- **`ChildRunPermissionContext`**：sandbox / allowlist / outputDir 访问权限集中表达，skill primitive 读这个 context。

### 4.6 测试层

- helper `__breaksInvariant` 标记 + metric。
- ESLint rule 禁 source-grep 反模式。
- 真 e2e 链路（跑真子进程，不再 fake-only）。

### 4.7 流程层

- `.claude/` 硬关卡：counter-proposal → plan → 审 plan → 执行 → 审结果 工作流强制。
- Acceptance gate 写法 lint：禁"代码应/不应包含"句式。
- Plan ↔ commit 关联强制（CI 校验）。

---

## 5. 演进阶段重排（基于本文档新增的洞察）

上一份文档的 5 阶段路线（A 地基 / B 防爆 / C 减脆 / D 提质 / E 工程基建）整体仍成立。但**根据 CC-Source 对照得到的新洞察**，调整两点：

### 调整 1：阶段 A 加入 AbortController 树 + CleanupRegistry 引入

之前阶段 A 只有"词汇 invariant + 流程门"。现在加：

> 阶段 A 也包含**引入 AbortController 树形传播 + ChildRunCleanupRegistry**。

理由：这两件是后续所有"资源 / lifecycle / 取消"工作的共同底座。如果 outputDir GC、retry、circuit-breaker、observer wait 改造都各自处理 cleanup，就是补丁堆叠。先把底座立起来，后续阶段在底座上长。

### 调整 2：阶段 C 加入"权限上下文"

之前阶段 C 只是"sandbox 审计"。现在升级为：

> O8 不再是"审一遍现状"，而是**引入 `ChildRunPermissionContext` 把 sandbox 上移到权限层**。

理由：审一遍现状的产出是"哪些地方危险"，但修复散在各处。引入 PermissionContext 是合同级修复，一次到位。

### 调整后的完整阶段路线

| 阶段 | 内容 | 工作量 | 阶段成功的合同检查 |
|---|---|---|---|
| **A — 地基** | 根因 1（词汇 invariant）+ 根因 5（流程门）+ AbortController 树 + ChildRunCleanupRegistry | 3-4 天 | (a) `infra_error` 从 union 消失；(b) `.claude/` 关卡阻止跳过 plan；(c) child runner 用 parent signal 派生；(d) finalize 走 cleanup registry 不直接 clearTimeout |
| **B — 防爆** | 根因 3（测试规约）+ O1（outputDir GC，借用阶段 A 的 cleanup registry） | 1-2 天 | (a) ESLint rule 拒 source-grep；(b) outputDir 自动按 N 天清理 |
| **C — 减脆** | 根因 4（产物可复用合同）+ O4（atomic write）+ O6（高层 retry）+ O8（PermissionContext） | 4-5 天 | (a) `findReusableRunByKey` 落地；(b) run_state 走 mkdtemp/rename；(c) startSkillChildRun 入口判 retry；(d) primitive 读 PermissionContext |
| **D — 提质** | 根因 2（reminder registry）+ N1-N4（Layer 1 次生债）+ O7（用户控制面） | 3-4 天 | (a) registry suppressed metric 不报警；(b) close event Object.freeze 测试通过；(c) UI 暴露 child run 列表 |
| **E — 工程基建** | O5（真 e2e 链路） | 5+ 天 | (a) e2e test 跑真 yt-dlp + ffmpeg；(b) CI 自动跑 |

---

## 6. 战略原则（5 条，不疲于奔命）

把上一份文档的 8 条原则 + 本文档新增的 3 条形态原则，浓缩为**5 条战略级原则**——这些就是"刻进脑海"的核心：

1. **先合同，后代码。** 任何阶段开始前，先写"如果这阶段成功，CI 能机器验证哪几条合同"——再开实施。合同写不出来 = 不知道在修什么 = 别动。

2. **修根因，不修症状。** 26 项遗留问题归并为 5 根因 + 8 盲点，每条都要先归簇再 PR。看到症状先问"这是哪条根因的投影"，不是"先把这个 bug 修了"。

3. **拒绝 legacy 兼容分支。** `if (legacy) ...`、`infra_error` 留 union 不删、"暂时保留"——这些都是根因 1 复发的种子。删 legacy 是合同的一部分，不是技术债。

4. **形态意识。** 抄 CC-Source 之前先问"这是 CC 没有这个问题，还是 CC 解得更好？" 前者照抄 = 引入复杂度，后者 = 解债。

5. **CI 强制 > 文档约束 > 人审。** 合同必须 CI 强制；CI 不行再用文档；文档不行才用人审。**永远不要用"我下次注意"** 当解决方案。

---

## 7. 相关文档

- 上一份：`2026-04-30-skill-runtime-residual-architectural-debt.md`（问题清单 + 优先级）
- Layer 1 计划：`2026-04-30-skill-runtime-child-loop-final-closure-claude-counterplan.md`
- Layer 0 baseline：commit `48539bc`
- Layer 1 commits：`d0f0ab7` / `51bd90c` / `1e65c2f` / `a5682d2`

下一步建议：根据本文档的 5 阶段路线，挑阶段 A 启动——先写阶段 A 的 plan（含 AbortController 树 + CleanupRegistry 的具体接口设计 + 词汇 invariant 的 type/factory + 流程门的 `.claude/` 配置），再分 team 落地。
