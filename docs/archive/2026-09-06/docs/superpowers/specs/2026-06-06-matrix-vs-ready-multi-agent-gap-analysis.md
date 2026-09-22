---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Matrix vs Ready 多级 Agent 能力对照与学习方向

**Date:** 2026-06-06
**性质:** 研究与反提案材料（enforce: false）。任何落地动作须另起 `plans/YYYY-MM-DD-*-implementation.md` 并先写可机器验证的合同。
**前置阅读:** `2026-06-06-matrix-agent-architecture-study.md`

## Goal

把 Matrix 的部门制多级 agent 架构与 Ready 当前 agent 主链交叉比对，回答：

1. Ready 哪些机制已经和 Matrix 同构（不用动）。
2. Matrix 有而 Ready 没有的能力里，哪些与 Ready 的需求形态一致、值得吸收。
3. 哪些明确不该抄。
4. 如果走向"类多级 agent 能力"，分几步、每步的合同是什么。

## Current Ready Inputs（2026-06-06 实测）

- `src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts`（AgentSdkRuntime：OpenAI Agents SDK Runner + MemorySession，maxTurns 24 起）
- `src/main/modules/agent-control/runtime-core/turn-frame.ts`（TurnFrame 单源 + TurnFramePatch）
- `src/main/modules/agent-control/prompt-assembly.ts`（L0/L1/L2 三层注入：resident agent/user/工具索引 → scope 消息+日志 → trigger 命中规则段）
- `src/main/modules/agent-control/domain-adapters/`（DomainAdapter 八件套 + run-capability-controller.resolveRunCapabilities 唯一仲裁点）
- `src/main/modules/agent-control/skills/skill-child-runner.ts`（child run：MAX_ACTIVE_VEA_CHILD_RUNS=3、每子 24 action、嵌套子运行守卫=深度 1）
- `src/main/modules/agent-control/sub-agent/`（SubAgent 抽象：started/progress/terminal 事件、close event、artifactDir、framePatch/projectionPatch）
- `src/main/modules/agent-control/runtime-core/parallel-branch-orchestrator.ts`（并行 branch 硬上限 3、AbortSignal 取消、TurnFrame patch 串行合并）
- `src/main/modules/agent-control/contracts/run-contracts.ts`（SkillRunContract durable handle：childRunId/outputDir/runStatePath）
- `src/main/modules/agent-control/task-projection/`（RunProjection、reconciler、run-budget-policy）
- `src/main/modules/agent-control/memory/memory-lifecycle.ts`（6h 维护：过期归档、trigger 命中率调优）
- `src/main/modules/agent-control/session/`（session-manager 复合键、session-continuity、session-recall）

## Review Status

本对照基于本轮只读复审 Ready 当前 checkout。已确认：Ready 有单 agent 主链、scope/session 隔离、L0/L1/L2 prompt 装配、DomainAdapter 能力仲裁、skill child-run、通用 SubAgent 抽象、parallel branch 硬上限、task projection、session recall、memory lifecycle。未确认：没有运行 Ready app、没有跑测试、没有验证 UI 行为；本文是架构规格和落地方向，不是完成实现。

## Re-assessment After User Correction

上一版结论把"部门制不照搬"说成了主结论，容易遮住 Matrix 更重要的机制。修正后的判断是：

**CEO dispatch 是值得学的核心方法论。** 不是因为 CEO 能管理部门，而是因为它在正式执行前做了一次高质量的任务编译：把多维复杂问题拆成多个专长方向，给每个方向配 owner、目标、上下文、完成条件、proof 期待和下一步动作。下游 agent / worker 接到的不是"你自己想办法"，而是窄得多、准得多的工作包。

Ready 当前的主要差距也要改写：不是"缺部门"，而是**缺一个显式的多维拆解与分派层**。现在复杂任务通常在单 agent 会话里串行经过多个 skill / domain adapter / tool loop：每走一步都把上下文、工具结果、技能提示和下一步判断继续堆在同一条链里。这样能完成事，但在复杂任务上有两个天然劣势：

- **上下文压力**：多个技能的规则、工具结果、历史证据挤在同一个主循环里，越到后面越容易压缩、遗忘或误读。
- **速度压力**：多个方向只能被主 agent 依次判断、依次调用；即使底层工具支持并行读，也不是多个专长 agent 同时推进独立切片。

因此 Ready 应该学习的是"CEO as decomposition compiler"：不搬 Matrix 的持久部门目录，但引入一个轻量、可验证的 **Dispatch Plan / Work Package** 合同，让主 agent 先生成结构化工作图，再由代码层把可并行的工作包分给专长执行席位，最后按 proof 收拢。

## 一、需求形态一致性判断（红线 4：先判断形态再借鉴）

Matrix 的形态：**个人工作操作系统**。用户=CEO，部门=用户生活/工作的长期领域分身，任务以"天/周"为时间尺度持续运营，agent 主动性（周期唤醒、check-in、dashboard）是产品主体。

Ready 的形态：**集成式创作工作台**。agent 服务于浏览/文稿/RSS/日程等工作台场景，会话以"分钟/小时"为尺度，任务多数在一次会话或一次长任务续跑内闭环。

结论：**持久部门拓扑与 Ready 形态不一致，不照搬；CEO 式多维拆解与专长分派方法论一致，应该吸收。** Matrix 自己也把三个平面分开（拓扑/知识/执行）——Ready 可以不取"部门目录"，但要取"先拆解、再分派、再证明收拢"这条执行平面方法。

## 二、逐维对照

| 维度 | Matrix | Ready 现状 | 差距定性 |
|---|---|---|---|
| 组织拓扑 | Workspace→Department→Lead→Worker，部门是持久 owner | 单 agent，scope 隔离（来源频道+thread+agent） | 形态不同，**不抄结构**，但"owner+路由记忆"概念可借 |
| 多维拆解 | CEO/primary 先把宽问题拆成 owner、结果、criteria、proof、worker 切片 | 主 agent 在同一会话里边想边串行调用 skill/tool | **应重点学习**：Dispatch Plan / Work Package 层（P0）+ specialist 二轮细化（P2） |
| 分维细化（第二段） | brief 落进部门 lead 的专长上下文（自有身份/知识/技能），lead 在干净上下文里二轮细化后才派 worker | 不存在：子运行全是确定性执行器，细化只能发生在主会话通才上下文里 | **本轮修正后的核心差距**（P2） |
| 任务多级拆分 | Objective→KR→Task→Criteria→Proof→Check-in 分形状态机，工具层校验 | task tracker + projection + child-run 合同；无目标层级、无 Criteria/Proof/Check-in 字段 | **最大可吸收差距** |
| 完成判定 | Criteria 全 satisfied + proof ref 才 completed；占位符=blocker | projection 状态由 runtime 事实派生，但"什么算完成"无机器合同 | 可吸收，与用户"done=CI green+real build+self-test"的要求同向 |
| 并行执行 | 同 owner worker 任意并行（Neo/Codex/Claude Code 异构池），workTaskId 绑定 | ParallelBranchOrchestrator（cap 3、patch 单点合并）+ SubAgent A1（已留 systemPrompt/permissionMode 槽）+ SubtaskRuntime（parentTaskId 绑定）；但 branch 全是确定性 worker，无模型循环 | 地基已在，缺口收敛为 specialist 模型循环（P2） |
| 跨 agent 协作 | department message（send/reply+outcome/note/queue/thread），文件做大件交接 | 无 agent-to-agent 消息 | 形态暂不需要；若做多 agent 才需要 |
| 结果收拢 | proof refs → Check-in → KR 建议(accept/modify/reject) → dashboard 投影 | close event + projectionPatch → 任务卡 | Ready 机制对，缺"判定"环节 |
| 上下文注入 | 固定小注入集 + index-only + 按需读卡 | L0/L1/L2 + trigger 规则 + session recall | 已同构；index 条目的"检索线索化"写法可借 |
| 记忆 | 双写者 + 4h crystallize + 付费前闸门 + 信念卡图谱 + CAS 共享 USER.md | DB 三层记忆 + 6h lifecycle（归档/调优，非整理）；无后台固化 | 部分吸收：闸门+固化 pass，可不要图谱 |
| 技能 | 文件 SKILL.md 双 scope，description 承重，learningDecision 入口 | manifest action + primitive + 本轮授权（更严格） | Ready 更强；可借"技能从重复结晶"的入口机制 |
| 主动性 | 周期唤醒 + operating refs 优先级 + cron 绑 Task | 无主动唤醒；任务靠用户消息续跑 | 形态部分一致（长任务续跑），可小步吸收 |
| 安全确认 | 浏览器四档行动确认 taxonomy | Browser Agent 走"理解→计划→分步→复核"+确认 | Matrix 的 taxonomy 更系统，可参考补全 |

## 三、不抄清单（先说死）

1. **文件系统即数据库**。Matrix 用 okr.json/markdown packet 当状态存储，靠工具层校验兜底。Ready 红线：SQLite + 显式跨边界建模 + verify:native 验收。抄合同不抄存储形态。
2. **部门制组织拓扑**。Ready 没有"用户=CEO 运营多个长期部门"的产品需求；scope 隔离已覆盖多入口。建部门=建一堆要喂养的持久状态，违反简单优先。
3. **prompt 文本承载路由纪律**。Matrix 的 decision ladder 是 prompt 约定，靠模型自觉。Ready 红线 5：CI 强制 > 文档约束 > 人审。任何路由/预算/状态机必须落代码。
4. **异构外部 worker 池（Codex/Claude Code/Cursor）**。引入外部 CLI runtime 作为执行席位超出 Ready 当前产品边界，且把可靠性外包给第三方进程。
5. **语音层架构**。产品形态不同。
6. **OKR 全家桶语言**。Objective/KR 两层对创作工作台过重；只取 Task 层内核（Criteria/Proof/Check-in），目标层级等真实需求出现再说。

## 四、学习方向（按依赖序分五步，每步独立成立）

### P0 · Dispatch Plan：先拆问题，再分派执行（修正后的第一优先级）

**现状缺口**：Ready 现在是主 agent 在一条链里连续做"理解问题 → 选 skill → 调工具 → 读结果 → 再选下一个 skill"。这适合小任务，但对复杂任务会把所有专长判断、上下文和证据都压在同一会话里。Matrix 的 CEO 强在第一步先把宽问题编译成多个窄问题，每个窄问题再进入自己的执行上下文。

**吸收方式**：

- 新增一个轻量 **DispatchPlan** read/write 合同，不是长期部门系统。它只服务当前复杂任务或长任务。
- DispatchPlan 由多个 **WorkPackage** 组成。每个 WorkPackage 至少包含：`id`、`title`、`dimension`（问题维度）、`ownerCapability`（browser/document/research/skill/memory/rss/calendar/custom）、`brief`、`contextRefs`、`criteria`、`expectedProof`、`dependencies`、`parallelizable`、`suggestedExecutor`。
- 由模型负责判断"怎么拆"；由代码负责校验结构、依赖、并发上限、工具授权、可恢复 handle、结果收拢。
- WorkPackage 可以发给现有 DomainAdapter、skill child-run、SubAgent、browser worker，或 P2 的 specialist 模型循环。主 agent 不再把所有技能提示都背在一个上下文里。
- **WorkPackage 与 P1 的 task packet 必须是同一个状态对象**（WorkPackage = 带 criteria/proof/check-in 的 task projection 子节点），不允许"计划系统"和"任务系统"两套并行状态——Matrix 在 task-management 里点名过这个坑（"without adding a second Key Result system"）。
- **拆分是两段式的，不要求 P0 一次拆到底**：主 agent 只产出窄 brief（维度+owner+criteria+期望产出），具体执行步骤留给接收端在自己上下文里细化（P2）。CEO 拆得粗、specialist 细化得准，这正是 Matrix 流水线的分工。
- 对用户仍然不说 DispatchPlan，只说"我把这件事分成几路：资料核对、方案整理、产物生成、验证收口"这类自然语言。

**机器可验证合同**：结构 schema；依赖图不能成环；没有 criteria/proof expectation 的 WorkPackage 不允许进入 completed；同一资源的写操作不能并行；每个 WorkPackage 必须有 ownerCapability 和收拢路径。
**影响面**：新增 dispatch-plan 合同与状态服务；task-projection 增加父子工作包视图；先接入 1-2 个现有执行器，不动所有 skill。

### P1 · Task packet 合同升级：给任务卡补上 Criteria / Proof / Check-in

**现状缺口**：Ready 的 projection 能回答"任务跑到哪了"，回答不了"凭什么算完成"。完成判定散落在 runtime 事实里，没有机器合同——这正是用户反复强调的"done = 验证过的 done"在产品内的缺位。

**吸收方式**：

- 扩展 task projection 的状态形态：任务携带 `criteria[]`（id/text/status ∈ open|satisfied|blocked|not_applicable + proofRefs）、`proofRefs[]`（文件路径/URL/截图/输出目录）、`checkIns[]`（author=agent|user、judgment、status、nextAction）。
- 写入走一个**代码层状态服务**（对应 Matrix 的 `mcp__okr__state`）：字段校验、状态机转移合法性、"completed 必须全 criteria satisfied 且有 proof"在代码里硬卡，模型只产出判断内容。
- 占位符检测（TBD/空 owner）归为 blocker 的规则可以做成校验函数。
- renderer 仍只消费 projection 派生状态（不破坏 O 阶段收口）。

**机器可验证合同**：状态机转移表 + 行为测试（无 proof 不得 completed；blocked check-in 必带 blockerCategory 类似物）。
**影响面**：task-projection/*、tool 层加 1-2 个状态工具、任务卡 UI 增量。不动 runtime 主循环。

### P2 · Specialist 执行席位：带专长上下文的模型循环子代理（方法论的下半场）

**现状缺口（本轮实测修正）**：并行地基已经在位——`ParallelBranchOrchestrator`（cap 3、AbortSignal、frame patch 串行单点合并 + 既有 gate `check-parallel-branch-frame-merge.cjs`）、`SubAgent` A1 合同（close event、artifactDir，且 `SubAgentContext` 已预留 `systemPrompt`/`permissionMode` 槽位）、`SubtaskRuntime`（worker 自动绑 `parentTaskId/parentStepId`，projection 上行）。真正缺的是：**没有任何一种 branch 是模型循环**。今天的 branch/子运行全是确定性 worker（收集 runner、inline callback），只能执行已细化的指令，承担不了方法论里的"第二轮细化"。P0 把问题拆窄之后，如果接收端仍是主会话自己（继续串行装技能）或哑执行器，上下文与时延的增益都拿不到——两段式细化流水线断在第二段。

**吸收方式**：

- **SpecialistProfile 注册表**（新合同）：`profileId`、路由用 `description`（只把目录行注入主 agent prompt，正文不注入——对应 Matrix CEO 只看部门 charter、不背部门技能正文）、身份 prompt 片段、技能授权预设（复用 `SkillToolAuthorization` 机器）、能力 profile（喂给 `resolveRunCapabilities`，子 turn 工具面仍由既有唯一仲裁点裁决）、预算切片规则。首批 profile 不新造领域，从现有 DomainAdapter 域出发（浏览器调研、文档产出、research 核对）。
- **Specialist 模型循环 runner**（真正的新件，实现 SubAgent 接口）：fresh `MemorySession`——不继承父会话历史，只吃 WorkPackage brief（原话相关切片 + context refs + criteria + 期望产出）；用 profile 的 systemPrompt（A1 槽位已留）；工具/技能面按 profile 缩窄；预算独立切片。它在自己的干净上下文里做第二轮细化（读资料、选技能、定步骤），然后直接执行或驱动叶子执行器（browser collect runner、content task runner）。
- **深度按角色类型封顶**，不是裸计数：decomposer（主 agent）→ specialist（模型循环，可 spawn 叶子执行器）→ 叶子执行器（确定性，禁止 spawn 任何 agent）。specialist 不得 spawn specialist。
- WorkPackage 绑定沿用 `SubtaskRuntime` 的 `parentTaskId/parentStepId`；孤儿 branch 拒绝（对应 Matrix worker 必带 `workTaskId`、"cron 只能绑已存在的 Task"的纪律）。
- **向下传原话+精选引用，向上传摘要+artifact 引用**：specialist 启动包不做关键词改写（Matrix dispatcher 纪律"不要改写成脆弱的关键词计划"）；大件产物落文件，回流只带路径与摘要。
- 收拢仍走 close event + projectionPatch + `mergePatchesSerially` 单点，不开第二条 frame 写通道。

**成本诚实账**：每个 specialist 重付一份小 base（profile prompt + brief），换走的是主上下文里 Σ(技能正文+中间产物) 的累积与 compaction 损耗；时延从 Σt 变 max(t)。单维任务不分派，零成本路径保持现状。并发模型调用会放大瞬时 token 消耗——预算切片（run-budget-policy 派生）必须与 runner 同批落地，超限可观测。

**机器可验证合同**：profile 注册表 schema gate；角色类型深度测试（specialist spawn specialist 必须被拒）；孤儿 branch 拒绝测试；预算切分行为测试；fresh-context 测试（specialist 输入不得包含父会话历史）。
**影响面**：sub-agent/（新增 specialist runner）、prompt-assembly（profile 装配变体）、run-capability-controller（子 turn 入参）、task-projection。主循环只加"分派→等待→收拢"一段，单 agent 既有路径不动。
**依赖**：P0+P1 先行（brief/criteria/收拢判定的状态形态骑在它们上面）。

### P3 · 记忆固化 pass + 付费前闸门

**现状缺口**：MemoryLifecycleManager 做归档和 trigger 调优，不做**整理**（合并重复、置信度升降、把会话学习固化为持久记忆）。Matrix 的 crystallize 证明这条路工程上能走稳，且它的两个护栏直接可抄：

- **确定性 gate 脚本先于 LLM 花费**（无活动→skip，零 token）。对应 Ready"预算是硬限制"。
- **固化跑在独立维护会话**，产物全部落 DB（Ready 形态下不是落文件），空轮合法。

**吸收方式**：给 scope_memory/resident 层加 confidence 字段与升降规则；6h lifecycle 扩一个 crystallize 子任务：读最近会话摘要 → 新增/强化/弱化记忆条目 → 重复条目标记待合并（不破坏性直并）。共享条目（如 resident_user）的并发写入用 DB 事务天然解决，不需要 CAS 脚本——这是 Ready 用 SQLite 的红利。

**机器可验证合同**：gate 决策可单测（无新会话→skip）；固化写入走 repository 校验。
**影响面**：memory-lifecycle.ts、memory-repository、一个新维护 prompt。

### P4 · 主动唤醒（最后做，且最小化）

**现状缺口**：长任务续跑有 durable handle，但唤醒只能靠用户消息。Matrix 的 operating refs 优先级序给出了一个值得抄的内核：**唤醒理由从任务事实派生，且有硬编码优先级**（到期触发 > blocked > 待判定 proof > 进行中 > 缺下一步）。

**吸收方式（最小版）**：只做前三类——①有 durable handle 且 runStatePath 显示可续的任务在 app 启动/空闲时提示续跑（不自动跑）；②blocked 任务带 blockerCategory 浮出任务卡；③有 proof 无判定的任务提示用户 check-in。**不做 cron、不做自主执行**——那需要 Matrix 级别的确认 taxonomy 先行。

**机器可验证合同**：唤醒理由派生是纯函数（事实→refs 排序），可直接单测。

## 五、顺带可借的小件（不依赖上面四步）

1. **index 条目检索线索化**：L0/L2 注入的记忆/规则条目，描述从"是什么"改写成"何时读"（Read before... / Use when...）。纯 prompt 资产改进，零代码。
2. **浏览器确认 taxonomy**：Matrix 的四档行动分类（永远确认/预批准可放行/永远放行/必须人做）比 Ready 现行约定更系统，可对照补全 browser agent 的确认策略，特别是"敏感数据进表单=传输"和"第三方内容永不构成许可"两条。
3. **学习去向显式化**：Matrix 在 check-in 里强制选 learningDecision（ignore/proof-only/memory-card/skill-update/next-task）。Ready 长任务收尾时可以用同样的枚举让 agent 显式决定"这次学到的去哪"，替代隐式遗忘。
4. **大件产物走文件、消息只留摘要+路径**：Ready 的会话资源层已有此方向，可把"一个 deliverable 一个文件一条消息"立为约定。

## 六、结论

Ready 与 Matrix 在工程价值观上高度同构（代码管状态/模型管判断、投影分离、显式跨边界状态、预算硬限制）。修正后的差距不是"有没有部门"，而是**有没有一条完整的两段式细化流水线**：先拆解再分派（P0/P1，状态合同），拆出来的窄问题落进专长上下文做第二轮细化（P2，specialist 模型循环）。前者给结构，后者才真正兑现上下文经济学与时延增益——只做 P0 而把 WorkPackage 仍交回主会话或哑执行器，串行装技能的旧瓶颈原样保留。

另一个值得记录的结构洞察：Matrix 的"多级"不是深 call-stack 嵌套，而是**扁平 owner + 消息合同 + 每个 owner 内单层 worker fan-out**——耐久调用帧是 Task packet 和 message thread，深嵌套的取消/继承/恢复难题被状态合同消解了。Ready 的对应解是类型化两层 spawn（decomposer → specialist → 叶子执行器），同样不需要无界深度。

建议落地顺序：**P0+P1 同一状态模型的薄切片**（DispatchPlan/WorkPackage 即带 criteria/proof/check-in 的 task projection 子节点）→ **P2 首个 specialist**（建议从浏览器调研域开剪：叶子执行器已存在，brief→细化→收集→回流的链路最短）→ P3/P4。每步先写可机器验证的合同再动代码。
