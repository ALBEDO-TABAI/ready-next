---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Skill Runtime Bootstrap 根因分析与改造计划

> 2026-04-23 起草
> 对照项目：`/Users/user/Documents/实验田/CC-Source`
> 触发事故：`novel_writer_system`（糖糖和小健深夜网吧场景）多轮执行全部退回纯文本

## 0. TL;DR

- 事故复现的根因 **不是** skill 执行器 bug，而是 **工具面的合约与模型的预期不匹配**。
- 我们把「reference / advisory」技能（只是 markdown 方法论）和「workflow」技能（有状态 step-state）混在同一组工具下曝光给模型，且 6 个 `skill_submit_*` / `skill_get_state` / `skill_cancel_*` / `skill_restart_*` 始终出现在工具清单里。
- 当模型调用 reference 技能后没有 execution 被创建，它仍然能「看到」`skill_submit_input`，于是自行编造 `executionId: "new"` 尝试开工作流，命中 `Skill execution new not found` 报错，反复 3 次后放弃 skill，直接拼文本。
- CC-Source 的 skill 系统几乎是反面教材的正例：**单一 `Skill(name, args?)` 工具 + 纯 prompt injection**，没有状态机，没有 step 编号，模型就自己按 markdown 往下写。对 `novel_writer_system` 这类「给我一套方法论，然后我来创作」的技能完全够用。
- 修复方向：**按执行模式分层曝光工具**，reference/advisory 只注入内容、关掉状态机工具；workflow 才解锁 submit_* 工具。同时 align 工具描述与错误提示，让模型不再把 reference 技能当 workflow 开。

---

## 1. 事故回放（事实链）

截图证据（`/Users/user/Desktop/截屏2026-04-23 上午11.58.16.png`）：

```
正在理解需求  进行中
执行细节
  skill_novel_writer_system_read_skill({})        ← ① 读技能方法论（reference runtime）
  skill_submit_input({executionId: "new", ...})   ← ② 伪装 bootstrap 一个新执行
  ← Skill execution new not found.                 ← ③ 被 buildSkillExecutionMissingOutput 拦住
  ← 当前会话没有任何活跃的 skill execution。请先用 skill_get_state…
→ 放弃 skill，"我直接按照 Deep Novel System 的核心方法论来撰写这段场景——"
```

历史摘要提示的「已经写过多次但每次都因为 skill 工具受限退回纯文本输出」进一步说明这不是一次偶发失败，而是这条代码路径的稳定行为。

### 1.1 `skill_novel_writer_system_read_skill` 到底发生了什么

`custom-skill-registry.ts:252-262` 在 manifest 未显式声明 actions 时自动补一个 default：

```ts
actions.push({
  name: 'read_skill',
  description: '读取并应用该技能的说明与方法完成当前任务',
  runtime: 'reference',         // ← 非 python，非 workflow
  entry: documentEntry,         // ← 指向 SKILL.md
  params: [],
  inputMode: 'flags',
  visibility: 'public',
})
```

并且 `custom-skill-registry.ts:314` 给 execution 的 mode 设为 `advisory`：

```ts
execution: { mode: 'advisory', autoAdvance: false },
```

所以 `novel_writer_system` 实际上是 **reference × advisory** 的组合 —— 这在我们的运行时里只会走 `runDefinitionActionDirect()`：

```ts
// runtime-manager.ts:715-747
if (action.runtime === 'reference') {
  const stdout = readFileSync(entryPath, 'utf-8')
  return { success: true, mode: 'reference', stdout: truncateOutput(stdout), … }
}
```

而 `skills-tools.ts:264-272` 的 `formatRunResult` 给 reference 模式贴上了「advisory, no execution state」的注释头：

```
# Skill guidance (advisory, no execution state): novel_writer_system / read_skill
<SKILL.md 正文>
```

**结论：第 ① 步完全正确**—— 模型读到了技能方法论，而且被明确告知「no execution state」。运行时也没有创建任何 `skill_executions` 行。

### 1.2 为什么模型还是去调了 `skill_submit_input`

关键证据在 `skills-tools.ts:122-124` 和 `tool-registry.ts:402-418`：

```ts
function getSkillToolDefs(): SkillToolDef[] {
  return [...getSkillActionToolDefs(), ...EXECUTION_TOOL_DEFS]
}
```

`EXECUTION_TOOL_DEFS` 是 **常驻** 的 6 个执行控制工具（`skill-execution-tool-defs.ts:36-73`）：`skill_get_state` / `skill_submit_input` / `skill_submit_confirmation` / `skill_submit_agent_result` / `skill_restart_from_step` / `skill_cancel_execution`。无论当前会话有无 execution，无论此次命中的技能是 reference 还是 workflow，这 6 个工具永远出现在 Anthropic/OpenAI 的 tools 列表里。

再看它们的描述（LLM 看到的原文）：

| 工具 | 描述 |
|------|------|
| `skill_get_state` | 读取当前 skill execution 状态、当前 blocker、已完成步骤和最近产物。若不提供 executionId，会优先读取当前会话最近的活跃 execution。 |
| `skill_submit_input` | 向一个被 need_input 阻塞的 execution 提交输入并继续推进。 |
| `skill_submit_confirmation` | 提交 confirmation 结果并继续执行 skill workflow。 |
| `skill_submit_agent_result` | 向 need_agent_result 阶段提交 Claude 生成的正文和结构化输出，并继续推进 workflow。 |
| `skill_restart_from_step` | 从指定 step 重新开始 skill execution… |
| `skill_cancel_execution` | 取消一个正在进行的 skill execution。 |

全是 workflow 语义的词：「execution」「step」「blocker」「推进」「提交正文」。读完 `novel_writer_system` 的方法论（里面也反复讲「第一步、第二步、生成场景」），模型的 world model 很自然得出结论：**「现在我应该进入 workflow 模式，先提交我的场景初稿到 submit_agent_result 或 submit_input，让系统推进下一步」**。

它不知道这个技能根本没有 workflow。它只知道工具清单里有 `skill_submit_input`，并且刚才那个 reference 结果的头注释「advisory, no execution state」太过低调（相对几十行技能正文而言）。

### 1.3 `executionId: "new"` 为什么会被构造出来

`skill_submit_input` 的 schema（`schemas/skill-control-schemas.ts`）只要求 `executionId: string`，没有枚举、没有正则、没有「必须来自上一次工具返回」的约束。模型为了绕过「我没有 id」这个障碍，选择了占位符 `"new"`—— 这是它自己编的。

命中后，路径是：

1. `skills-tools.ts:360-367` → `manager.submitExecutionInput("new", …)`
2. `runtime-manager.ts` 委派到 `ExecutionCoordinator.submitInput("new", …)`
3. `execution-coordinator.ts:258-260` → `this.store.getExecution("new")` 返回 `undefined` → `throw new Error("Execution not found: new")`
4. `skills-tools.ts:228` 的正则 `EXECUTION_NOT_FOUND_RE = /execution not found/i` 捕获异常
5. `skill-execution-missing.ts:14-50` 构造结构化错误：「Skill execution new not found. 当前会话没有任何活跃的 skill execution…」

**没有任何代码路径支持把 `executionId === "new"` 当成「请帮我开一个新 execution」。** 那个提示「请先用 skill_get_state 定位当前状态」在真有 active execution 被误引用时是正确的，但在「reference 技能 + 无 execution」场景下实际上是死胡同：模型接着 get_state 也只会拿到 `'No active skill execution found.'`。

### 1.4 轮次增多后为什么直接放弃

会话摘要（context compression）把前几次失败压成了一条「该任务已经写过多次」的短记录。模型综合 3 条信号：

1. 摘要：历史里 skill 工具都不工作
2. 工具返回：`skill_submit_input` 又一次失败
3. 对话目标：用户要的是文本输出（小说场景），而不是一个 execution 状态

所以它选择最高胜率的 fallback：**跳过 skill，直接写**。这在单一 turn 内看着像放弃，其实是它在已知工具不可用的前提下做出的理性决策。

---

## 2. 交叉对比 —— CC-Source 的 skill 是怎么做的

### 2.1 模型面只有一个工具

```ts
// CC-Source: src/tools/SkillTool/SkillTool.ts
export const SkillTool = buildTool({
  name: 'Skill',
  description: async ({ skill }) => `Execute skill: ${skill}`,
  prompt: async () => getPrompt(getProjectRoot()),
  inputSchema: z.object({
    skill: z.string().describe('The skill name. E.g., "commit", "review-pr", or "pdf"'),
    args: z.string().optional().describe('Optional arguments for the skill'),
  }),
})
```

只有 `Skill(name, args?)` 一个入口。没有 submit_input、没有 get_state、没有 restart_from_step。

### 2.2 模型要做什么都写在系统提示里

```
Execute a skill within the main conversation

How to invoke:
- Use this tool with the skill name and optional arguments
  - skill: "pdf"
  - skill: "commit", args: "-m 'Fix bug'"

Important:
- Available skills are listed in system-reminder messages in the conversation
- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke
  the relevant Skill tool BEFORE generating any other response about the task
- NEVER mention a skill without actually calling this tool
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)
- If you see a <command-name> tag in the current conversation turn, the skill
  has ALREADY been loaded - follow the instructions directly instead of calling
  this tool again
```

这段提示里 **没有一个词提到 execution / step / blocker / state**。skill 就是「把一段 markdown 搬到对话里，然后按它的指示做事」。

### 2.3 技能文件本身也是 markdown + frontmatter

```yaml
---
name: Optional Display Name
description: Short one-line description
when-to-use: |
  Detailed guidance on when to invoke this skill.
allowed-tools: [...]
context: inline   # 或 fork
model: opus
---

# Skill Title
<markdown 正文>
```

运行时会：
- `context: 'inline'`（默认）→ 把 markdown 作为一条 `isMeta: true` 的 user message 注入对话，做 `$ARGUMENTS` 替换、`!`shell` 展开，然后模型自己继续生成；
- `context: 'fork'` → 起一个 sub-agent 在隔离上下文里跑。

### 2.4 没有 `skill_executions` 表，没有 step 状态

整个 CC-Source 搜一遍都找不到 step / blocker / execution_state 这类概念。唯一的「状态」是 `STATE.invokedSkills` 这个 Map，用途只是：**压缩对话时保留已注入的技能正文，避免 compact 丢上下文**。完全不是工作流状态机。

### 2.5 与我们当下场景的对照

| 维度 | CC-Source | 我们 |
|------|-----------|------|
| 工具入口数 | 1（`Skill`） | 6 + 每技能 N（`skill_*_read_skill` 等） |
| 状态模型 | 无（内联即完成） | `skill_executions` 表 + step/artifact/blocker |
| 模型心智负担 | 低（读进来 → 按说明做） | 高（判断 reference/advisory/workflow，判断该调哪个工具） |
| Reference 技能体验 | 注入 markdown，模型继续 | 注入 markdown，但工具列表还有 workflow 入口 → 诱导误调 |
| Workflow 需求 | 用 sub-agent fork 实现 | 原生表驱动，针对 `lets-go-rss` / `video-copy-analyzer` 等场景 |
| 新技能上手成本 | 写 SKILL.md 就完事 | 写 SKILL.md + 手动 manifest + 懂 action.runtime/executionMode/visibility 组合 |

**关键差异**：CC-Source 默认「skill = prompt injection」；我们默认「skill = 状态机」。对绝大多数创作型 / 方法论型技能，**CC-Source 的默认是对的**。

---

## 3. 根因三段论

### 3.1 结构性根因
工具层把 6 个 workflow 控制工具无条件曝光 —— 即便当前会话没有任何 execution、即便唯一涉及的技能是 reference。这与技能运行时的实际执行模型相悖：reference 技能根本不产生可被 submit 的 state。

### 3.2 诱导性根因
工具描述全部写成 workflow 动作语义（「提交」「推进」「blocker」「execution」）；技能自身的 markdown 也充满「步骤」语言。两边共同作用下，模型把 reference 技能的「概念步骤」等同于 workflow 运行时的「真实 step」，去调 `skill_submit_input`。

### 3.3 终结性根因
`skill_submit_input` 的错误处理是「温柔地提示 get_state」，但在无 execution 场景下 get_state 又只会返回 `No active skill execution found.`，形成死循环。模型只能在若干轮后放弃 skill 退回纯文本，这正是截图显示的终态。

---

## 4. 修复方案（分阶段）

总体原则：**按技能的执行模式动态调整工具面，让模型看到的工具清单和系统可提供的能力保持一致。** 同时保留现有的 workflow 技能（`lets-go-rss` / `video-copy-analyzer` / `video-expert-analyzer` 靠它们跑），不做破坏性变更。

### Phase 0 —— 最小止血（今日可合）

**P0-1　execution-control 工具按会话状态动态曝光**
- 位置：`src/main/modules/tools/skills-tools.ts::getSkillToolDefs` + `tool-registry.ts::resolveSkillToolSchemas`
- 动作：让 `getSkillAnthropicTools(sessionId?)` 与 `getSkillOpenAITools(sessionId?)` 接受会话 id；当 `findExecutionForSession(sessionId)` 为 null 时：
  - 仍保留 `skill_get_state`（读操作，零副作用，有用）
  - 过滤掉 `skill_submit_input` / `skill_submit_confirmation` / `skill_submit_agent_result` / `skill_restart_from_step` / `skill_cancel_execution`
- 调用侧 `tool-registry.ts:402-418` 拿到 sessionId 后透传进去
- 回归：`src/__tests__/execution-tool-filter-skill-preservation.test.ts` 已有类似过滤测试，扩一条「无 active execution 时 5 个 submit_* 被过滤」的用例
- 效果：模型在 reference 场景下根本看不到 `skill_submit_input`，无法再编造 `executionId: "new"`

**P0-2　工具描述改成「禁用性」**
- `skill-execution-tool-defs.ts:36-73` 给每个 submit_* 工具加一句前置：
  - `skill_submit_input.description = 'ONLY call this if a previous skill_* tool returned an explicit executionId. Never fabricate an id such as "new". 向一个被 need_input 阻塞的 execution 提交输入并继续推进。'`
  - 其他 4 个 submit_* / restart / cancel 工具同样前置 ONLY call 子句
- 配套更新 `skill-zod-golden-snapshot.test.ts`（如快照仍有意义）
- 效果：即使没走到 P0-1，仅通过描述也能降低 LLM 编造 id 的概率

**P0-3　`skill_submit_*` 错误语义分场景**
- 位置：`skill-execution-missing.ts::buildSkillExecutionMissingOutput`
- 扩展 `params`，传入 `lastReferenceSkill?: { id, name }`（由 orchestrator 记下最近一次 reference 技能读取）
- 当 `activeExecution === null` 且 `lastReferenceSkill` 存在时，改写提示：
  > 你刚刚读取的技能 `${name}` 是 reference/advisory 类型，没有 workflow 状态可以提交。不要再调 `skill_submit_*`；直接按技能方法论完成写作任务即可。
- 否则保持现在那条「请先用 skill_get_state」提示
- 效果：即使 P0-1 漏掉某条路径，错误消息也能明确把模型推回正确轨道

### Phase 1 —— 对齐 CC-Source 的「inline 注入」语义（一周内）

**P1-1　Reference 技能默认内联注入，隐藏 action 工具**
- `custom-skill-registry.ts` 给 `read_skill` 默认 action 加 `visibility: 'internal'`
- Orchestrator `maybeInjectExplicitSkillContext` 检测到 reference 技能时：
  - 绕过工具调用，直接 `readFileSync(entryPath)` 获取 SKILL.md
  - 作为 `{ role: 'user', content: <skill 正文>, isMeta: true }` 注入
  - 在注入消息结尾补一句：「已加载 ${name}；不要调 `skill_*` 工具，请直接按方法论输出结果。」
- 调用 telemetry：`logAgentMetric('skill_reference_inlined', ...)` 方便观测
- 对应 CC-Source `processPromptSlashCommand` + `addInvokedSkill` 的行为

**P1-2　统一「Skill(name, args?)」入口（可选）**
- 新增 `skill_invoke` 通用工具（schema：`{ skill: string, args?: Record<string, unknown> }`）
- 内部路由：
  - 若 skill 是 reference → 执行 P1-1 的内联注入，返回简短确认
  - 若 skill 是 workflow/default action → 走现有 `runSkill({ executionMode: 'workflow' })` 并回出 executionId
- 老的动态 `skill_<id>_<action>` 工具保留一段弃用期，但只对 workflow 技能曝光
- 与 CC-Source 的 `Skill(name, args?)` 概念对齐

**P1-3　System prompt 侧加一段 skill usage guidance**
- 参考 CC-Source `SkillTool/prompt.ts:173-196` 的文案
- 要点：
  - 已加载的技能在本轮 `isMeta` 注入里，看到就直接按说明做
  - 只有工具返回带 `executionId` 时才用 `skill_submit_*`
  - 不允许编造 `executionId`
- 让模型有显式的 mental model，减少猜测

### Phase 2 —— 清理结构性债务（两周内）

**P2-1　execution_mode 合法性审计**
- 审计所有 `assets/embedded-skills/*/SKILL.md` 以及 custom skills：哪些确实需要 workflow，哪些该降级为 reference。
- 建立一条 manifest 合法性检查：如果 `execution.mode === 'workflow'` 但没有真正的 multi-step workflow 文件，则在启动期告警。

**P2-2　把 `EXECUTION_TOOL_DEFS` 从「静态常量」变成「工厂」**
- 现在 `skill-execution-tool-defs.ts:36` 是纯 const；Phase 0 改成工厂函数 `buildExecutionToolDefs({ hasActiveExecution, lastReferenceSkillId })`
- `toAnthropicTool` / `toOpenAITool` 透传会话上下文
- `skills-tools-static.ts` 里的 STATIC_SKILL_TOOL_NAMES 也相应分层（always-on vs. execution-gated）

**P2-3　`skill_get_state` 的兜底更实用**
- 当前返回字符串 `'No active skill execution found.'`，模型看到后仍可能转去试 `skill_submit_input`
- 改为：附加 `lastReferenceSkill?` 信息与「无 workflow 状态可提交」明确提示
- 保证每个非成功路径都有「下一步该怎么做」的明文

### Phase 3 —— 体验层（持续）

- **技能列表注入**：学 CC-Source 的 `skill_listing` system-reminder，按 budget 裁剪，按会话增量下发，避免技能太多时全塞进 prompt。
- **胶囊状态正确化**：`buildSkillProjectionPatch` 目前把 reference 技能的「读取说明」也塞进 steps 胶囊，视觉上暗示「进行中的 workflow」。Phase 1 内联后，reference 技能不再入胶囊，走普通回答流。
- **会话摘要策略**：context compression 要把「skill 工具受限」这种假性失败从摘要里剔除，避免后续轮次延续失败预期。

---

## 5. 验证矩阵（修完每一阶段都要过）

| 场景 | 期望行为 |
|------|----------|
| 用户说「用 novel_writer_system 写 XX 场景」 | 方法论注入 → 模型直接输出场景；**不**出现 `skill_submit_input` 调用 |
| 用户调用 `lets-go-rss` 的 rss_add workflow | 创建 execution → `skill_submit_input` 正常推进；`skill_submit_input({executionId: "new"})` 不再被模型尝试（工具描述已禁用） |
| 用户中途取消 workflow | `skill_cancel_execution` 仍可见、仍可用 |
| 无 active execution 时调用 `skill_get_state` | 返回明确「无 workflow 可查；若刚读过 reference 技能请按说明继续」 |
| 连续两次要求同一个 reference 技能 | 第一次注入完整，第二次注入短提示（CC-Source 式 sentSkillNames 去重） |
| 历史摘要里包含「skill 工具受限」字样 | Phase 3 摘要策略生效前，至少 Phase 0 能让新轮次重新成功，不被老摘要拖下去 |

自动化测试补齐（最小集）：

- `skill-execution-tool-filter.test.ts`：无 active execution + sessionId 存在 ⇒ submit_* 被过滤，get_state 保留
- `skill-execution-missing-output.test.ts`：新增「lastReferenceSkill 存在 ⇒ 文案变更」用例
- `skill-context-orchestrator.test.ts`：reference 技能被内联注入、不再触发 `skill_*` 工具调用
- `skill-zod-golden-snapshot.test.ts`：更新描述后刷新快照（有意为之的 breaking change）

---

## 6. 风险与取舍

- **Phase 0 动态工具面**可能让某些已经训练/记忆依赖「submit_input 永远可见」的 prompt 行为漂移。缓解：Phase 0 只改 reference × 无 execution 这一条组合，workflow 场景工具面保持不变。
- **Phase 1 内联注入**会绕过 tool_use 循环，失去 tool log。保留 telemetry（`skill_reference_inlined`）并在前端胶囊里显示一条「已加载技能：XX」轻量态，兼顾透明度。
- **Phase 2 统一 `skill_invoke`** 是较大结构调整；必须带 deprecation 双写期（`skill_<id>_<action>` 与 `skill_invoke` 同时可用一段时间），不强推。
- **不做的事**：不删除 `skill_executions` 表、不拆 `execution-coordinator`。workflow 技能仍然需要它们。CC-Source 的「纯 prompt 注入」是默认但不是唯一模式。

---

## 7. 追加参考指针

- 本项目关键文件
  - `src/main/modules/tools/skills-tools.ts`（工具调度与错误包装）
  - `src/main/modules/tools/skill-execution-tool-defs.ts`（6 个 execution-control 工具的静态清单）
  - `src/main/modules/tools/skill-execution-missing.ts`（无 execution 时的错误文案）
  - `src/main/modules/skills-runtime/custom-skill-registry.ts`（custom skill manifest 默认值、reference runtime 兜底）
  - `src/main/modules/skills-runtime/runtime-manager.ts:623-646`（workflow 启动决策 + reference 直读）
  - `src/main/modules/agent-control/skill-context-orchestrator.ts`（explicit skill 注入与工具偏好）
  - `src/main/modules/agent-control/tool-registry.ts:402-418`（skill 工具进入 LLM schema 的入口）
- CC-Source 参考点
  - `src/tools/SkillTool/SkillTool.ts`（单一 `Skill(name, args?)` 工具）
  - `src/tools/SkillTool/prompt.ts:173-196`（工具提示文案）
  - `src/utils/attachments.ts:2661-2751`（`getSkillListingAttachments` 按预算裁剪的技能清单）
  - `src/skills/loadSkillsDir.ts:185-265`（SKILL.md frontmatter 解析）
  - `src/bootstrap/state.ts:1510-1540`（`invokedSkills` 用于 compact 保留而非状态机）
