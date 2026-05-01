# Skill Runtime 遗留架构债清单（Layer 1 完成后视角）

> **写作背景**：Layer 1（A1/A2/B2/B6 + 测试反模式）已 land 进 git。本文档盘点**所有剩下的**架构性问题——按"根因 / 次生债 / 盲点 / 品味债 / 优先级"五层组织。
>
> **本文档不是 plan 也不是补丁清单。** 它是一份"问题明细 + 复发预测 + 修法方向"的存档，用于驱动后续的阶段性架构演进决策。

---

## 0. 北极星原则（必须刻在脑海里）

下面 26 条问题不是 26 个独立 bug，而是**少数几条根因**的不同投影。如果按 bug 列表逐项打补丁：

- 一轮迭代修 5 个症状，下一轮迭代会暴露 5 个新症状（同一根因换个面孔出现）。
- 团队精力被"看着眼前最响的报警"消耗，永远没空修真因。
- 三个月后回头看，工作量翻倍但架构反而更脆——补丁层叠让任何后续改动的爆炸半径越来越大。

**这是战略级失败。**

正确的姿势是：

1. **先识别根因簇**，把表面散点归并到少数几条结构债。
2. **每一阶段只解决一条根因**，且必须把这条根因相关的 N 个症状一次性收拢——不允许"修了根因但旧症状还散在各处"。
3. **修复必须是合同（type / lint / CI / test）级别的**，不是文档级或注释级。文档只是注脚，合同才是不可绕过。
4. **拒绝在根因未修前做任何"局部优化"**——对长期是负贡献，因为它在错误地基上加重量。

下文每一条问题都标注其所属"根因簇"，方便阶段性修复时一次性圈起来。

---

## 1. 五条根因（B1-C3 + 流程性规约的真正源头）

### 根因 1 — 词汇层缺乏 invariant 强制机制

**所属症状**：B1（terminalReason `infra_error` 写入端散落）、C2（row.status 三态压扁）、B5（`findChildRunByX` 命名说"child run"实际接受任何 row）、N5（Layer 1 借用 `'failed_skill'` 当 resume 启动失败）。

**真正根因**：

系统里有"权威词汇"——`SkillChildRunStatus` 8 状态 union、`SkillChildRunTerminalReason` 16 reason union、row-level `SkillTaskRunStatus` 6 状态。但词汇约束**只在类型层活在 union 里**，不在写入端被强制：

- `coerceSkillChildTerminalReason` 只在**读侧**做迁移（旧 `infra_error` → 新 `child_process_crashed` 等）。
- `skill-child-runner.ts` 里硬编码 `terminalReason: 'infra_error'` 的写入端至少 9 处（`no_driver_registered` / `repository_create_failed` / `no_record` / `no_payload` / `repository_update_failed` / `runner_uncaught` / `driver_init_failed` / `driver_plan_failed` / `driver_observe_failed`）。
- `mapChildStatusToRowStatus` 把 8 状态映射到 5，下游消费 row.status 时永远不知道"这个 'blocked' 是 paused 还是真 blocked"。

类型系统能阻止"非 union 值"被赋值，但**阻止不了 union 内某个偷懒值被滥用**。Union 是建议，不是合同。

**复发预测**：
- 任何加新状态/新 reason 的工作都会重复"加列写入端散落"过程。例：未来加 `'sandbox_violation'` terminalReason，必须改 9 处写入点（其中至少 2 处会被遗忘），决策代码必须永远写 `if (kind === 'infra_error') 退路`。
- C2 的下一形态：UI 上某个新功能依赖"区分 paused vs blocked"，读 row.status 看到 `'blocked'`，写一份 ad-hoc unmap 函数从 payload 反查。第 4 处 ad-hoc unmap，第 5 处，第 N 处。

**修法方向（合同级）**：

1. **删掉 `infra_error` 联合成员**——编译期强制写入端选具体值。
2. **新增 `mapDriverThrowToTerminalReason(error: unknown): ChildTerminalReason` 集中 factory**——所有 driver 抛出转 reason 必须经此一处出口。
3. **row-level `status` 加 `lifecycle: 'task_run' | 'child_run' | 'detached'` 列**——下游消费者按 lifecycle 选合适 status 视图，而不是裸读 row.status。
4. **`findChildRunByX` 加 `WHERE json_extract(...$.childRun) IS NOT NULL`**——名字与契约一致，或重命名为 `findRunByHandle` 让契约自行说话。

---

### 根因 2 — Prompt / 模型对话注入点没有协调层

**所属症状**：B4（`buildBudgetWarningMessage` 见到 child-owned 长 skill 仍说"继续推进 skill 流程"，与 `turn-frame-steering.ts:416` 的"child-loop runner 已接管"reminder 直接打架）、C1（child 还在 wait 时模型被叫出来空跑一轮回答"还在跑"）、A2 在被修之前的 inline 散落 message。

**真正根因**：

系统里至少有 4 处会向模型注入 system-level 文本：
1. `buildBudgetWarningMessage`（budget 警告）
2. `turn-frame-steering` 的 reminder（child-owned / long-skill 提示）
3. orchestrator inline reference skill injection（`SkillContextOrchestrator.tryInlineReferenceSkillDoc`）
4. close event 自然语言化（resume 后渲染的 message）

**它们互相不知道对方说了什么**。每个注入点单独读自己关心的 frame 字段，独立生成文案，组合时谁先谁后不可预期。

Layer 1 的 `renderChildCommandOutcome` 是这一层的**局部**解（统一 cancel/resume 文案），全局协调层没有。

**复发预测**：

下次有人加新场景（例如"child run 被外部 admin 强制 kill"或"child 的 host_requirements 中途变更"），又会写第 5 个独立的注入点。模型在同一轮收到 4 段文本，每段对"现在该做什么"的描述都不一样——这是模型胡说八道、用错工具、跳步推进的常见诱因。已观察到的实例：B4 + steering reminder 互相打架。

**修法方向（合同级）**：

抽 `SystemReminderRegistry`：

```ts
interface ReminderEntry {
  topic: 'budget' | 'child-owned' | 'reference-skill' | 'child-command-outcome' | ...
  priority: number
  conflictsWith?: string[]   // topic ID 集合，注册时被自动 suppress
  text: string
}

class SystemReminderRegistry {
  register(entry: ReminderEntry): void
  resolve(): string  // 去重 / 优先级 / 冲突消解后拼成最终文本
}
```

所有现有注入点改为 registry 的 consumer 而非 author。Registry 提供"冲突可观测"——CI test 可以构造 frame 让两个注入点同时触发，断言 registry 没产出矛盾文本。

---

### 根因 3 — 测试与生产的语义错位

**所属症状**：B3（`tool-internal-admission.test.ts` 的"行为测试"是 source-string grep）、历史 A1 之所以漏检（Phase 5 mid-test `setupRunner({repo,...})` 重置了 singleton，把"生产从不重置 singleton"这条 invariant 在测试里悄悄破坏）。

**真正根因**：

两层：

**3.1**：测试 helper（`setupRunner`、`__resetSkillChildRunnerForTests`）暗中破坏生产 invariant，但 helper **没有任何机制告诉调用方它破坏了什么**。Layer 1 Team 4 加的 helper banner 是文档级修复——靠人读注释。下一个新写测试的人没读注释，照样可能误用。

**3.2**：项目里"行为测试 vs 结构测试"没有规约。`assert.match(source, /executeToolCall/)` 这种结构断言 typecheck 通过、CI 通过、code review 通过，但它**不验证行为只验证字面量**。

**复发预测**：

- 下次有人加测试 helper（比如 `__seedFakeRuntimeState`），再次破坏一条生产 invariant，下次 review 抓不到，下次 production bug 又是"测试都过为什么挂"。
- 下次有人遇到难以行为测试的命题（比如"两条路径走同一 helper"），又选 source-string grep——这是认知盲点的稳定复发点，B3 就是实证。

**修法方向（合同级）**：

1. **所有"破坏生产 invariant 的测试 helper"加显式 `__breaksInvariant: string[]` 标记**，运行时 emit 一个 metric；CI 上对该 metric 的 fixture 做 review checkpoint。任何 PR 引入新的 `__breaks*` helper 自动 flag 给人审。
2. **测试规约写入 CLAUDE.md**：禁止 source-string assertion 当行为测试用，并给替代模板。例如"两条路径行为等价" = 同输入两次调用断言输出 deep-equal；"代码不应调 X" = stub X 抛错并断言它没被调用。
3. **加 ESLint rule**（自定义）：禁止在 `__tests__/` 文件里 `readFileSync(*.ts)` + 后续 regex match 的组合——这是 source-grep 反模式的稳定签名。

> **F 阶段已收口（2026-05-01）**：已落地 `__breaksInvariants` / `__noProductionInvariantBreach` 测试 helper 标记、helper 标记 ESLint rule、source-grep 新增冻结、`docs/superpowers/testing-conventions.md` 与 CLAUDE.md / AGENTS.md §6.17。最终 gate 见 `2026-04-30-F-test-conventions-and-e2e-implementation.md`。

---

### 根因 4 — 跨边界的"状态恢复 / 产物复用"语义不完整

**所属症状**：C3（observer-timeout 不杀子进程，但产物孤立——awaiter 走了之后没人接力，下一次重试单飞 active-only 找不到，于是重跑）、B5（exact-lookup 找 terminal row 是给 contract 重建用，但语义和 single-flight 不交叉）、A1 中关于 `process_restarted` 的 reconcile（runner 重启后从 row 恢复，但只在"再次启动同 single-flight key"时被检查）。

**真正根因**：

Child run 在系统里同时是"正在执行的进程"与"持久化产物的所有者"。**两种角色没分开建模**：

- `active map` 管"进程在跑"。
- `row.status` 管"产物长什么样"。
- 但**没有一层说"这个 outputDir 在多长时间内、在什么条件下、可以被未来请求复用而不是重跑"**。

具体地，repository 现在有两种查询：
- `findLatestChildRunByKey` active-only —— 防止重跑 in-flight。
- `findChildRunByXAnyStatus` —— 给 contract 重建用，不给 single-flight。

**没有第三种**：`findReusableRunByKey(key, withinMs, freshness criteria)`——这是 observer-timeout 半生命周期场景缺的合同。

**复发预测**：

- RSS visual analysis 的 "timeout → 用户重试" 路径今天就在重复跑相同视频。流量小不疼，量级上来就是隐性 OOM/CPU 风暴。
- 任何"长任务可重入"需求都会重复发明轮子：每个产品自己写"看 row.status === 'completed' 就读 outputDir"——四份 ad-hoc 实现注定漂移。

**修法方向（合同级）**：

1. **引入显式"产物可复用语义层"**：在 row 上记 `lastReusableUntil: timestamp` + `outputFingerprint: string`（决定产物是否还能 reuse 的 input hash），repository 提供 `findReusableRunByKey({key, asOf})`。
2. **Child runner / RSS / turn-engine 三个上层 consumer 走同一个查询**，禁止任何模块直接读 row.status 当作"可 reuse"信号。
3. **对应文档**：在 §6.13 加"产物复用合同"一节，明确"completed close 不等于产物可复用，需另查 reusable invariant"。

---

### 根因 5 — 流程缺强制门

**所属症状**：流程性规约没落地、B2 漏 `READY_SKILL_CHILD_RESUME_ENABLED` flag（counter-proposal §6 列了，Codex 跳过 plan 步骤直接动代码，没人审计 plan 对照表）、B3 source-string 测试通过 acceptance gate（gate 写法太松："代码应该走 executeToolCall"——可以 source-grep 满足）。

**真正根因**：

CLAUDE.md 是"建议"清单不是"必须"清单。规则靠人审而不是靠 CI / hook 强制。每一轮里 "counter-proposal → plan → 审 plan → 执行 → 审结果" 工作流的某一步都可能被任何参与方擅自跳过。

**复发预测**：

下次大改不改流程的话——**大概率**会有 1 个 gate 漏检、1 个 plan 步骤被跳、1 个反模式测试被批准。这是统计意义上的复发，不是单次失误。

**修法方向（流程层，不是代码层）**：

1. **`.claude/` 加硬关卡**：counter-proposal 文件存在但 `implementation.md` 文件不存在时禁止 Codex 推 commit。
2. **Acceptance gate 写法用 lint rule**：禁止"代码应/不应包含"句式，模板提供"调用 X → 期望 Y"形式。
3. **PR-time CI 加 `gate-check.ts`**：每条 gate 是可执行 assertion，不是文档。文档同步 → 被 CI 强制。
4. **plan 引用强制**：commit message 必须含 `Refs Layer N / Team M in <plan-path>`，CI 解析并校验该 plan 文件存在且 commit 满足某条 gate。

---

## 2. Layer 1 修完后产生的次生债（5 项）

### N1 — `renderChildCommandOutcome` 覆盖率不够，`close.status` 字面量比对仍散落

**位置**：`turn-engine.ts`：
- `computeChildContinuationDecision` (line ~316) 直接读 `live.status`，对 `TERMINAL_CHILD_CLOSE_STATUSES` set 做 in 检查。
- `frame.terminalReason = 'cancelled_user'` 在 cancel 分支硬编码。
- 行 ~2290+ 还有几处直接 status 字面量比较。

helper 只覆盖了"渲染对用户的 message + finish 参数"。状态判定本身依然散在多处。**未来加新 close.status 时仍要追这些散点。**

**所属根因**：根因 1 的延伸（词汇 invariant 缺位的局部表现）。修根因 1 时一并处理。

> **G 阶段已收口（2026-05-01）**：`TERMINAL_CHILD_CLOSE_STATUSES` / status helper 已集中到 `skill-child-run-types.ts`，并由 `scripts/check-child-status-vocabulary.cjs` 防止散点复发。参 `2026-04-30-G-quality-polish-and-control-surface-implementation.md`。

---

### N2 — Resume 的"清状态"语义被切成两半

**问题**：
- `prepareResumeLifecycle` 是 `SkillChildRunner` 的 private 方法，清 `recentCloses[id]` + 写 `closeEvent: null` 到 row。
- `frame.runContract.childCloseEvent = null` 由 turn-engine 自己手动赋值（Team 2 的"显式 null"）。

即"清旧 close"逻辑分布在 runner 内部和 turn-engine 外部两处。今天能跑——问题在未来：哪天有第三个 close 副本（比如 supervisor 也有 `currentClose` cache、UI 也有自己的 frame snapshot），又得记得同时清这第三处。

**正确的合同**：`resumeSkillChildRun` 返回值就是"已清理完毕"的 immutable 状态快照，调用方不再 maintain 任何"上一段"信息。今天的 API 不返回这个保证。

**修法方向**：让 resume 返回 `{ runHandle, freshContractFields: { childCloseEvent: null, childStatus: 'running', parentNextHint: ... } }`，turn-engine 用 spread `Object.assign(contract, freshContractFields)` 一次性更新——杜绝调用方手动赋值的可能。

> **G 阶段已收口（2026-05-01）**：clean resume 现在返回 `freshContractFields`，turn-engine resume 分支整体应用该对象，H1 脚本挡住手动 `childCloseEvent` 赋值。参 `2026-04-30-G-quality-polish-and-control-surface-implementation.md`。

---

### N3 — Close event 没有 mutability 约束

Layer 1 Team 1 的 fan-out 测试断言 `firstResult.closeEvent === secondResult.closeEvent`——同一对象引用。性能上是好事（不复制），但意味着任何 awaiter mutate 这个对象（如 `close.error.message += 'extra'`），所有 sibling awaiter 被波及。

`SkillChildCloseEvent` 类型没有 `readonly` 标注，没有 `Object.freeze` 调用。**当前没人误用，但合同上敞开**。

**修法方向**：把 `SkillChildCloseEvent` 类型改为 `Readonly<...>` 嵌套版本（`DeepReadonly<T>` 工具类型），构造完后 `Object.freeze` 一次。CI 加测试断言 `Object.isFrozen(close)`。

**所属根因**：独立小问题，不归入五大根因。

> **G 阶段已收口（2026-05-01）**：`SkillChildCloseEvent` 对外为 `DeepReadonly<>`，构造/解码出口统一 freeze，`close-event-immutability.test.ts` 覆盖类型层和运行时层。参 `2026-04-30-G-quality-polish-and-control-surface-implementation.md`。

---

### N4 — Flag 中途切换的测试空白

`isChildResumeEnabled()` 每次调用都读 `process.env`。意味着：
- 一个长 turn 启动时 flag=on → 走 resume 分支。
- turn 中途某处又调 `isChildResumeEnabled()`（比如未来加的代码）→ 此时 flag 改成 off → 行为分裂。

今天没有"中途读 flag"的代码，所以不爆。但加 flag 时**没有一个测试断言"同一 turn 内 flag 读取一次就好"或"读多次必须缓存"**。下次有人天真地在 turn-engine 内多处读 flag 就会出现行为不一致。

**修法方向**：每个 turn 的入口处一次读所有 flag 到 immutable `TurnFeatureFlags` 对象，下游一律用对象字段而非函数。runtime hot-reload 不存在，无副作用。

> **G 阶段已收口（2026-05-01）**：turn-engine 入口使用 frozen `TurnFeatureFlags` snapshot，下游 tool-executor / gateway 消费显式传入的 snapshot，`scripts/check-turn-feature-flags.cjs` 阻止中途读 env helper。参 `2026-04-30-G-quality-polish-and-control-surface-implementation.md`。

---

### N5 — `'failed_skill'` 被借用为"resume 启动失败"，语义错位

Layer 1 Team 2 因为 `TurnTerminalReason` union 不含 `'failed'` 字面量，退而求其次用 `'failed_skill'`。但 `'failed_skill'` 在系统里原本的语义是"skill 自己声明 success=false"——和"resume 启动时 row 找不到"是两件事。

观测面看：metric `terminalReason='failed_skill'` 现在同时反映"skill 真失败"和"resume 启动失败"两类不同 root cause，dashboard 上分不开。

**所属根因**：根因 1 的直接受害者（terminalReason 词汇不细）。修根因 1 时补上 `'resume_launch_failed'` 之类的具体词。

---

## 3. 前几轮 review 完全没触及的盲点（8 项）

### O1 — outputDir 文件系统的生命周期

每个 child run 在 `<runtimeRoot>/outputs/<skillId>/<childRunId>/` 下建一个目录，写 run_state.json、event log、scene_scores 等。但：
- **谁负责清理？** grep 仓库——没找到任何"完成的 child run 清 outputDir"的代码路径。每跑一次 VEA child run 留一个目录，永久。
- **重试场景下旧 outputDir 怎么办？** 如果用户取消并重启同一任务，老 outputDir 的产物被忽略，新 outputDir 重新生成。磁盘双倍占用。
- **跨进程协作？** outputDir 在 row 完成后还会被读（agent 引用 deliveryReport 路径），但读的时候没人保证文件还在——没 lifecycle 标注就无法做 GC。

这是真实的运维问题。Layer 0/1 都没碰。生产部署超过几个月磁盘会爆。

**严重度**：A1 级（数月内必爆）。

---

### O2 — 跨 session/device 的 single-flight 复用语义

`Single-flight key = scope|session|skillId|targetDigest`。同一用户 2 个设备同时请求同一 child run 创建两份不复用。

是设计意图（避免跨 session 状态污染）还是默认行为没人想过？**没有 ADR、没有注释解释**。如果是后者，"用户在公司电脑跑了一半，回家电脑接着跑"的需求今天做不到。

**严重度**：B2 级（隐性 UX 缺陷）。

---

### O3 — Parent turn budget × child internal budget 不联动

- Parent: `MAX_AGENT_ITERATIONS = 220` (turn-engine)
- Child: `MAX_ACTIONS_PER_CHILD_RUN = 24` (skill-child-runner)

它们彼此 unaware。Parent 已经用了 219 次工具时，child 仍可花 24 次内部 actions。从模型预算管理视角：parent 已经在 budget 边缘，child 又拉出 24 次没人通知模型——模型对"我还能花多少 tokens / actions"的认知与系统真实 budget 漂移。

不会立即出 bug，但 budget 监控的精度从这里开始失真。

**严重度**：B2 级。

---

### O4 — Run-state 文件 vs runner 内存状态的 invariant

- `runStatePath` 上的 JSON 由 driver 自己写，runner 的 `recentCloses` / `active` 由 runner 写。两者可能 drift：
  - runner crash 中间态 → 重启时 `markRowProcessRestarted` 路径介入。
  - 但 runner 没 crash、driver 在写 run_state 时被 OS-level kill（OOM、磁盘满）→ run_state 写到一半，runner 内存没感知。
  - 下一个 `driver.observeAfterAction` 读 run_state 拿到半段 JSON 解析失败——不知道是损坏还是中间态。

这是真实可发生的 corruption 路径。当前没有 invariant 检查。

**严重度**：A2 级（半年内可能爆）。

---

### O5 — e2e 测试链路缺失

现在所有测试都是 unit / component / contract 级，**全部用 fake driver / fake runtime / fake repository**。

`skill-child-run-end-to-end.test.ts` 名字像 e2e，但它跑的是 contract 重建链路（`loadSkillRunContract`）的端到端，**不跑真子进程**、不跑真 driver 的 stage 切换、不跑真 ffmpeg/yt-dlp。

意味着：runner / driver / repository / turn-engine 这条链路某个 prod-only assumption（比如 yt-dlp 真的能找到 video，或 ffmpeg 输出 schema 真的对）被破坏，单测全过、集成测全过、e2e 全过——上线挂。

Layer 0 commit message 引用过"SQLite-backed 验收前必须先跑 npm run rebuild:native"——意识到一半。但全链路 e2e 始终没建。

**严重度**：C 级（基础设施债，但每次大改都被它噎着）。

> **F 阶段已收口（2026-05-01）**：已新增 opt-in VEA happy-path e2e，覆盖 `startSkillChildRun → driver plan → runtime lifecycle → 真 ffmpeg/scenedetect 输出 → close event delivered`；默认本地验证跳过，`READY_E2E=1 npm run verify:f:e2e` 真跑。

---

### O6 — Child run 的 retry / circuit-breaker 策略

Child run 失败后下一次启动同样 single-flight key 会怎样？看代码：直接启动新 run（active-only 单飞过滤掉 terminal）。

但：
- **已知 retriable failure**（如 `host_unavailable`）应该自动重试还是必须用户手动？没策略。
- **重复失败**（5 次都 `child_process_crashed`）是否要 circuit-break？没机制。
- **抖动失败**（瞬时 host 不可达后立即可达）是否要 backoff？没。

今天的 system 是"人肉用户重试"——这对面向产品用户的功能没问题，但对 RSS 自动化场景是隐性 DoS（每次轮询都重试同一个失败的 child run，没有冷却）。

**严重度**：A2 级（量级上来就爆）。

---

### O7 — Child run 的 visibility / 用户控制面

review 过 turn-engine 处理用户输入"继续"/"取消"，但**没审 UI 端**：
- 用户能在 UI 上**主动**看到 child run 列表吗？
- "暂停"状态有视觉化？继续/取消按钮还是只能打字？
- 多个 child runs 并发时（concurrency cap = 3），用户怎么区分？

如果只能通过对话 NLP 识别"继续"/"取消"，那 child run 的控制面被 NLP 层强行包装——错过 NLP 识别就丢失控制。系统设计上"用户掌控权"被 NLP 准确率间接限制。

**严重度**：B1 级（产品体验级问题）。

> **G 阶段已收口（2026-05-01）**：新增 `agent:listActiveChildRuns` / `agent:cancelChildRun` 与 Settings 调试区控制面，取消来源区分 `nlp` / `ui_button` 并进入 metric。参 `2026-04-30-G-quality-polish-and-control-surface-implementation.md`。

---

### O8 — Child internal sandbox 边界

CLAUDE.md §6.12 规定 skill primitive 的精确 sandbox（命令白名单、artifact 路径限制等）。Child runner 调用 skill action（**包括** primitives）走的是同一条 admission path 吗？

review 过 internal admission（B3），但没审 sandbox 链路：
- Child internal action 是否被 `requiresExplicitAllowlist` 检查？
- Child runner 是否能调 skill primitive（`skill_run_shell`、`skill_write_artifact`）？通过什么路径？跨过 sandbox 吗？
- VEA driver 内部的 shell 调用（`yt-dlp`、`ffmpeg`）走 `SHELL_ALLOWLIST` 吗？还是绕过？

这些是 security-critical 问题。**没审过——不代表安全，只代表盲点。**

**严重度**：A2 级（安全债）。

---

## 4. 小品味债（不是架构问题）

- N5 提到的 `'failed_skill'` 占位（语义错位，归入根因 1）。
- `makeFailedClose` / `makeKilledClose` 在 `turn-engine-route.test.ts` 内 inline，应该统一到 `makeChildCloseEvent`。
- CLAUDE.md §6.13 加了 flag bullet，但项目其它 flag（`READY_DEV_LOG_AGENT_METRICS` 等）不一定在 §6.13——文档分布漂移。

这些是**未来 refactor 的纸屑**，不是架构问题。修根因 1 / 根因 5 时顺手清。

---

## 5. 优先级矩阵（"复发风险 × 修复代价"排序）

| 等级 | 项 | 类别 | 工作量 | 不修代价 |
|---|---|---|---|---|
| **A0** | 根因 1 — 词汇 invariant（删 `infra_error` + 集中 `mapDriverThrowToTerminalReason`） | 架构债 | ~1 天 | 每加一个新状态就重复 9 处写入端漂移 |
| **A0** | 根因 5 — 流程硬关卡（plan-before-code + acceptance gate 写法规约） | 流程债 | ~半天 | 每轮大改都漏 1 个 gate / 跳 1 个 plan 步骤 |
| **A1** | 根因 3 — 测试 helper invariant 标记 + 行为/结构测试规约 | 流程+测试债 | [x] F completed 2026-05-01 | 已由 `verify:f` 挡新增复发 |
| **A1** | O1 — outputDir 生命周期 / GC | 运维架构 | ~1-2 天 | 部署超过 3 个月磁盘必爆 |
| **A2** | O8 — child internal sandbox 边界审计 | 安全 | ~1 天审 + 未知工作量修 | 隐性 sandbox 逃逸 |
| **A2** | 根因 4 — 产物可复用合同（`findReusableRunByKey`） | 架构债 | ~1 天 | RSS 路径每轮 timeout 都重跑相同视频 |
| **A2** | O4 — run_state 文件 vs runner 内存 invariant | 数据完整性 | ~1 天 | 半年内出现破损 row |
| **A2** | O6 — retry / circuit-breaker 策略 | 容错 | ~1 天 | RSS 自动化场景隐性 DoS |
| **B1** | N1-N4（Layer 1 次生债） | 局部 refactor | 各 2-4 小时 | 累积 |
| **B1** | 根因 2 — system message registry | 架构债 | ~2-3 天 | budget warning / steering 反复打架 |
| **B1** | O7 — child run 用户控制面 | 产品体验 | ~1 天 | 用户失控感 |
| **B2** | C1 / C2（局部症状） | 小修 | 各 1-2 小时 | 单独都不致命 |
| **B2** | O2 — 跨 session 复用 / O3 — budget 联动 | 各 1-2 天 | 都是隐性问题 |
| **C** | O5 — e2e 测试链路 | 测试基础设施 | [x] F completed 2026-05-01 | 已有 opt-in VEA 真 ffmpeg e2e 样板 |

**等级语义**：
- **A0** = 不修不能上规模生产。
- **A1** = 数月内必爆。
- **A2** = 半年内必爆。
- **B** = 渐进退化。
- **C** = 工程能力建设。

---

## 6. 修复建议路径（不可一次性、必须分阶段）

按"先修地基才能在上面盖房"原则，**强烈建议**的阶段顺序：

### 阶段 A — 地基（A0 项）

修：根因 1（词汇 invariant）+ 根因 5（流程门）。

**为什么这俩先做**：

- **根因 1** 是任何 child runtime 后续改动的"地基修复"——下面任何一阶段修 retry / sandbox / outputDir 都会写新的 terminalReason / status，不先把词汇合同立起来，那些工作都会带新的散点。
- **根因 5** 是"做后续工作的工程纪律地基"——不立这一关，每一轮我都能在你手里 catch 1-2 个 gate 漏审、1 个 plan 跳过、1 个反模式测试。

**这两件不修，后面 A1/A2 任何工作都是在沙地上盖楼。**

### 阶段 B — 防爆（A1 项）

修：根因 3（测试规约）+ O1（outputDir GC）。

理由：第一个是工程纪律的延续，第二个是数月内必爆的实在风险。

### 阶段 C — 减脆（A2 项）

修：O8（sandbox 审计）+ 根因 4（产物复用）+ O4（state 完整性）+ O6（retry 策略）。

可并行做，因为彼此不交叉耦合。

### 阶段 D — 提质（B 项）

修：根因 2（reminder registry）+ N1-N4 + O7。

阶段 D 是"系统从能跑到优雅"的层。前置阶段没修完前不要进 D。

### 阶段 E — 工程基建（C 项）

修：O5（e2e 测试链路）。

留到最后，因为 e2e 测试在前面阶段不存在的情况下也能跑（fake-based unit 测试已经够用），等真实链路稳定了再投入是更高 ROI。

---

## 7. 反模式警告：禁止做的事

下面这些做法在过去几轮 review 里都出现过，**新阶段开始前必须人工确认不会重蹈覆辙**：

1. **看到症状就修症状**。每一个症状都必须先归入根因簇，确认根因是否同步修，否则不开 PR。
2. **加 `if (legacy) ...` 兼容分支保留旧词汇/旧路径**。这是根因 1 复发的种子。每一次"暂时保留"都会变成永久。
3. **在 acceptance gate 里写"代码应/不应包含 X"**。强制改为"调用 X → 期望 Y"。
4. **测试里用 `setupRunner({...repo})` 形式跨 lifecycle reset singleton**。生产 invariant 会被掩盖，A1 实证。
5. **新增 prompt 注入点**（系统 reminder / budget warning / steering message）而**不**经 SystemReminderRegistry。修了根因 2 之后这条变成硬规则。
6. **在 `SkillChildRunner` 里加新 `recentXXXCache: Map<childRunId, ...>` 类的字段**。同样的 lifecycle epoch 问题会复发。
7. **修复一个 close.status 字面量比对的散点而不修剩下的**。N1 不允许半修。

---

## 8. 文档维护

本文档随每个阶段完成更新——已修项打勾、新发现的根因/盲点追加、不再适用的删除。

**禁止把它改成"todo 清单"形式**。它是"债务地图"，不是"任务列表"。任务列表请走 Plan 文件。
