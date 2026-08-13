---
title: Agent Stability Closure 修复路线（roadmap）
date: 2026-06-10
status: consensus v2 — Codex 共识达成（2026-06-10）；实施合同见 pairs 的 implementation 文档
revision_history:
  - v1 (2026-06-10): 初稿。
  - v2 (2026-06-10): 吸收 Codex 第 1 轮审查——补 S4→Plan P WP3+WP5 依赖边（阻塞项，
    以 C4.2 拆分方式解决）；C2.2 收紧自动续跑权限边界；S1 增补 continuation state
    先于 finalize 的写顺序约束；C1.2 触发判据措辞防误读；S0 标注 run_meta 需扩列。
owner: 白
author: Claude (Fable 5)
reviewer: Codex（审查循环进行中）
enforce: false
note: >
  本文是路线文档（roadmap），不是实施合同。与 Codex 达成共识后，
  将拆分为阶段化实施子计划（*-implementation.md, enforce: true）。
  路线基于 2026-06-10 对 agent 模块的全链路取证审查（真实日志 + ready.db
  + 五路代码深查），并显式接续两份在途已批合同，不与其重叠。
related:
  - docs/superpowers/plans/2026-06-09-agent-long-task-budget-resumability-implementation.md（下称 Plan L，enforce: true，在途）
  - docs/superpowers/plans/2026-06-09-browser-observation-probe-layer-implementation.md（下称 Plan P，enforce: true，在途）
  - CLAUDE.md §0.5 架构红线 / §2 当前硬约束 / §5 DomainAdapter 与系统提醒
  - .claude/architectural-principles.md
evidence:
  - ready.db: conv-75076270 会话（2026-06-09 16:58-17:03Z）5 个 run 的完整账本
  - ready.db: browser_tasks 06-06 历史（69 项采集 4 次重试，3 次同样 62/69+7 失败）
  - <tmpdir>/ready-tools.log、ready-agent-sdk.log、ready-directchat.log 同窗口取证
  - 五路只读代码审查（采集链路 / SDK 终止路径 / 续跑账本 / 意图门控 / 错误与可观测）
---

# Agent Stability Closure 修复路线

## 0. 一句话

用户感知的「agent 时不时中途停下、没法继续」不是一组独立 bug，而是**生命周期、判定、记忆三层断裂**的叠加；Plan L/Plan P 已覆盖判定层（预算）与动作层（浏览器操作）的一部分，本路线补上其余缺口——以**少数几个单一收口点（choke point）合同**为核心，而不是继续在症状处打补丁。

## 1. 前因后果

### 1.1 一次真实会话的解剖（2026-06-09 深夜，conv-75076270）

用户指令：「把@[Henry.L]这个博主的全部笔记采集到@[Henry.L]」。账本还原：

| # | 用户视角 | 系统账本 |
|---|---|---|
| run1 | 发出指令 → **无任何回复**，5 秒后被迫输入"继续" | 6 秒结束；IPC `success=true`；projection `killed`；run_meta 永远停在 `working`；chat_messages 无 assistant 行 |
| run2 | "继续" → 收到"已完成 3/6" | visible_collect 发现 6 项 → card_loop 6/6 完成 |
| run3 | 指出"第一篇 10 张图只采了 1 张" → agent 答"让我先打开这篇笔记：" | `terminalReason=done`、`toolTrace=[]` —— **宣布行动、零工具调用、被判完成**；记忆系统写入 "Completed task using 0 tools" |
| run4 | "继续" → agent 答"好，我现在用浏览器打开…" | 又是零工具调用判 done |
| run5 | 第三次"继续" → **再无任何回复**，对话死在这里 | image_gallery 采集 **0 项判 completed**；run 跑 89 秒后无声结束；projection `killed`、run_meta `working` |

三个佐证把偶发变成规律：

1. **06-09 早上的 reddit 调研**：被预算切成 5 段（24/3/27/9/12 次工具调用），每段以"本轮工具调用次数已用完…请继续"收口，用户敲 4 次"继续"才完成一件事（Plan L 的直接动机，已在途修复）。
2. **06-06 的 69 项采集**：整任务重试 4 次，3 次停在 62/69、同样 7 条失败；`status=failed` + `stopReason=completed` 自相矛盾，且 failed 清空 cursor → 每次从零重跑（Plan L WP6 已覆盖一半：partial 可恢复；未覆盖另一半：单项重试与失败记忆）。
3. **账本互相矛盾**：同一 run，run_meta 记 `research/60`，projection budget_json 记 `short_task/24/used=0`；被 kill 的 run 在 run_meta 永远 `working`。

### 1.2 六根因 → 三层断裂

六个根因（R1-R6，证据见取证报告）按架构归属收敛为三层：

**断裂一：生命周期层（R1、R2）——「结束」没有合同**
- run 的退出路径分散且无收口保证：done/cancel/kill/preempt/error 各走各的，可以不留用户消息、不落终态账本（run_meta 卡 `working`）、不解释原因。零工具调用 + 行动宣告文本照样判 `done`，系统提示词里"不要只描述将开始采集"是在用 prompt 对抗 runtime 缺陷。
- 后台任务（browser_tasks / skill child）是裸 fire-and-forget（`content-task-runner.ts` scheduleTask 纯 Promise，终态只写 DB），完成/失败/阻塞**没有任何事件推回 agent 循环**，全靠模型"想起来"轮询——而 run 往往早已结束。直接违反 CLAUDE.md 红线 6。

**断裂二：判定层（R3、R4 一部分）——终态判决与事实脱钩**
- 采集引擎：`no_new_content` 无条件映射 `complete`（0 项也 completed）；`emptyRoundsToStop=2` 在去重 + 列表复现场景下提前判定"到底"；部分失败判 `failed` 并清空断点；无单项重试与失败记忆；轮播多图只采首图。
- 预算：模型在耗尽前对预算一无所知，触顶总是突兀（Plan L WP2.9 已规划 70/90% 转向注入，在途）。

**断裂三：记忆层（R4 其余、R5）——跨轮/跨进程状态会蒸发或互相矛盾**
- MemorySession 纯内存，dev 期 45 分钟重启 7 次，每次全部蒸发，启动无 reconcile（run_meta/projection/browser_tasks 的 active 行无人收尸；仅 note_collect 有特判）。
- 任务计划（BrowserTaskPlan 的 steps/verify）一次性生成、不持久、不被消费；跟进意图靠 ≤24 字符正则白名单（"怎么样了"不算继续）；无否定词处理（"不要采集"照样触发采集）；当天记忆全文注入把**无关旧任务**的"请继续这项任务"灌进当前会话。
- 三套账本（run_meta / task_projections / skill_task_runs）对同一 run 各自为政。

### 1.3 为什么现在的修法不够

最近的 commit 流（"treat max-turn exhaustion as continuable"、"re-expose browser tools on a bare 继续"、"don't resume stale note_collect"）都是在症状层打补丁。补丁的共同上游是断裂一：**只要 run 可以无声死亡、后台任务可以无人收尾，任何下游修复的效果都会被"用户不知道发生了什么"吞掉**。所以本路线把生命周期合同放在最前面，判定与记忆随后。

## 2. 与在途计划的关系

| 在途合同 | 覆盖 | 本路线的接续 |
|---|---|---|
| **Plan L**（预算/续跑，WP0-8，PR1-8） | R4 主体：task_type 预算、工具边界记账、70/90% 转向、checkpoint+durable handle、续跑同任务卡、partial 采集可恢复（WP6）、run_meta（WP7）、skill 行 reconcile（WP8）、provider 守卫（WP5） | **不重做**。本路线新增阶段不得与 Plan L 落点冲突；S2 的自动续跑显式复用 WP3 的 continuation 机制。已发现的在途实现缺陷列入 §4.7「Plan L 收尾项」 |
| **Plan P**（观察/探针层） | 浏览器动作层可靠性：页面地图、只读探针、目标行动 gate、动作后复查、站点经验 | **不重做**。S3 的采集判定矩阵在终态层消费 Plan P 的页面证据（如 0 项时附带页面结构诊断）；S4 的 steps.verify 消费复用 Plan P 的动作后复查原语 |

本路线的新增范围 = R1、R2 全部 + R3 中 Plan L/P 未覆盖的判定缺陷 + R5 全部 + R6 中的取证卫生。

## 3. 设计原则（第一性 + 红线对照）

1. **单一收口点优先于分散修补**。每层断裂用一个 choke point 合同收口：run 终止走唯一 finalize 通道；后台任务终态走唯一事件桥；采集终态走唯一判定矩阵（纯函数）。合同可机器验证（CI gate + 行为测试），符合红线 1/5。
2. **复用既有原语，不造第二套**。续跑用 Plan L 的 continuation 机制；提醒注入用 `SystemReminderRegistry`；快照卫生用 `normalizeSessionSnapshotForSeed()/applyToolPairIntegrity()`；投影推送扩展现有 `taskProjectionSink` 模式；UI 仍只消费 projection（红线 3/O 阶段合同）。
3. **代码做路由，模型做判断题**。跟进意图分类是判断题（可给模型兜底），但分类结果到行为的映射、守卫、重试、状态机全部在代码（红线"模型只做判断题"）。
4. **失败要响亮，且响给两个受众**：用户（可见收口消息）与系统（终态账本 + initiator）。沉默是最昂贵的失败模式。
5. **效率约束**：每个 Codex 工单 ≤ 约 300 行 diff、可在 10 分钟内完成并自验；阶段间按文件域划分避免冲突（agent-control 轨 vs browser-engine 轨可并行）。

## 4. 修复路线（阶段定义）

> 每阶段给出：目标 / 核心合同（可机器验证）/ 落点 / 验收。详细工单拆分在共识后的 implementation 文档中。

### S0. 取证卫生与终止可观测（小、先行）

**目标**：让后续每个阶段的失败都可诊断；消除测试对生产日志的污染。

核心合同：
- C0.1 测试环境（`VITEST`/`NODE_ENV=test`）下，rotating-logger 与 metrics 写入隔离目录（`<tmpdir>/ready-test-logs/`），生产日志文件不出现测试 fixture。CI gate：测试运行后断言生产日志路径无新增行。
- C0.2 每次 run 关闭在 metrics 与 run_meta 同步记录 `{runId, terminalReason, initiator, toolCallsUsed, durationMs}`；`AbortController` 链路带 `initiator` 字段（`user_stop|preempted|timeout|host_unavailable|budget|error`）。注意：现有 run_meta schema（迁移 049 后）无 `initiator`/`duration_ms` 列，本条是 **schema 扩列 + 接线**，不是纯接线；需新迁移，沿用迁移 049 的幂等模式。

落点：`src/main/utils/rotating-logger.ts`、`platform.ts`、`agent-sdk-runtime.ts`（abort 包装）、`run-meta-repository.ts`（与 Plan L WP7 共用 schema，不加第二张表）。

验收：跑一次 `npm run test` 后生产日志无污染；人为 stop 一个 run 后能从 run_meta 单行回答"谁停的、为什么"。

### S1. Run 终止合同（断裂一·上半）

**目标**：消灭无声死亡。任何 run 的结束对用户和账本都有交代。

核心合同：
- C1.1 **唯一收口通道**：所有退出路径（done/error/cancel/kill/preempt/checkpoint/进程关闭）必须经过单一 `finalizeRunOutcome()`，原子完成三件事：run_meta 写终态（终态后不允许 `working`）、projection 写终态 patch、用户可见收口（本 run 至少一条 assistant 消息，或显式登记豁免类——目前唯一豁免：被同一用户的新消息抢占）。`checkpoint_budget` 是 finalize 通道的一个合法出口而非旁路，且必须保持现有写顺序：**continuation state（run_state.json 等 durable handle）先落盘，finalize 后行**（对齐 Plan L WP3 与现实现 `agent-sdk-runtime.ts` ~L3842/~L5248 的顺序）。CI gate（仿 `check-ledger-writer-funnel`）：禁止 finalize 通道之外写终态。
- C1.2 **行动宣告守卫**：触发判据为三条件同时成立——(a) 本 run（或末段）**有**助手文本且以行动宣告句式收尾（"让我/我现在/接下来将…"），(b) 该段零工具调用，(c) 存在未完成任务指涉。注意不是"输出为空"判据：空输出由 C1.1 的可见收口要求兜住，本守卫针对的是"说了不做"。命中时不允许直接判 `done`——注入一次有界转向（"立即执行或说明阻塞"，走 `SystemReminderRegistry`），仍不行动则降级为显式 checkpoint（带 honest 收口消息 + 可继续句柄）。行为测试用 Plan L WP0 的 scripted-model seam 驱动。
- C1.3 **启动 reconcile 泛化**：启动时统一收尸三账本——run_meta `working`→`interrupted(main_process_restarted)`；projection active→按 `canResumeShape()` 分流为 `recoverable_paused` 或 `interrupted`；browser_tasks `running`→有 checkpoint 则 `paused` 否则 `cancelled(restart)`。吸收并取代 note_collect 特判与 Plan L WP8 的 skill 行逻辑共用一个入口。
- C1.4 kill/preempt 类终态必须产出用户可见胶囊或消息（"已被新消息接管"/"已手动停止"），且 memory capture 不得把零工具 run 写成成功记忆。

落点：`agent-sdk-runtime.ts`（收拢散布的退出路径——本阶段唯一允许的较大重构面）、`run-meta-repository.ts`、`task-projection-sync.ts`、`direct-chat.ts`（preempt）、`main/index.ts` 或 app-control（startup reconcile 入口）、新 CI gate 脚本。

验收：复演 conv-75076270 的 run1/run3/run5 形态（scripted seam）：零工具宣告→被转向或显式 checkpoint；kill→有胶囊；DB 不再出现终态 `working`。

### S2. 后台任务事件桥（断裂一·下半）

> **历史路线，已退役，非当前生产合同（2026-08-12）。** 当前只保留 projection sink；
> Agent notifier、终态提醒注入、pending 自动续跑和设置开关均已删除。

**目标**：后台任务的终态变化主动回到 agent 循环与用户面前，废除纯轮询。

核心合同：
- C2.1 **唯一事件桥**：browser_tasks 与 skill child 的终态/阻塞迁移通过一个 `TaskEventBridge` 发布（扩展现有 projection sink 模式为双消费者：projection + agent notifier，不另造事件总线）。合同：`scheduleTask` 不允许在桥上无注册路由（运行时断言 + 测试）。
- C2.2 **回灌策略**：scope 有活跃 run → 下一次模型调用前注入系统提醒（"后台任务 X 终态：62/69，失败 7 条：…"）；scope 无活跃 run → 落 `pending_task_event` 并触发一次**有界自动续跑**（`taskType=continuation`，复用 Plan L WP3 的续跑机制与单飞守卫）。**权限边界（硬约束）**：自动续跑只允许播报结果、解释失败明细、提出建议；浏览器采集的 resume、任何写分类工具、以及高风控平台动作一律不得在自动续跑中执行，必须等用户显式确认（对齐 Plan L WP6.6 与 §10 风险表"显式 continue"规则）。用户可在设置中关闭自动续跑（默认开）。
- C2.3 `browser_get_task`/事件 payload 携带可行动失败明细（每条 `{url, reason, attempts, retryable}`），模型能够回答"哪几条失败、能否重试"。
- C2.4 `waiting_human` 任务在用户说"好了/已验证"后能经事件桥回到原任务（接 Plan L WP6.6 的显式 continue 语义）。

落点：`content-task-runner.ts`、`task-persistence-service.ts`、`agent-control/runtime-core/runtime.ts`（自动续跑入口）、`SystemReminderRegistry` 注册项、`browser-tools.ts`（payload）、settings（开关）。

验收：行为测试——后台任务在 run 结束后完成 → 自动产生一条向用户的播报消息（或活跃 run 内的提醒注入）；用户全程不需要输入任何"继续"。

### S3. 采集终态判定矩阵（断裂二，browser-engine 轨，可与 S1/S2 并行）

**目标**：采集结果的终态判决与事实一致；重试有意义。

核心合同（单源纯函数 `resolveCollectionVerdict()`，真值表测试覆盖）：
- C3.1 `collected=0` 永不判 `completed`：→ `needs_attention`，附 Plan P 页面结构诊断（页面是否登录墙/空列表/选择器失配）。
- C3.2 `0<collected<expected` → 按 Plan L WP6 分流 `recoverable_paused`（有 cursor）或解释性 terminal partial；**任何含部分进展的终态不得清空 cursor/partialResults**（修正现状 `finalStatus='failed'` 即清空的行为）。
- C3.3 `no_new_content` 停止前必须先做一次有界滚动升级探测（更大滚动步长 + 加载指示检测），探测仍无新内容才允许停；`expected` 已知且 `frozenCount<expected` 时 discoveryStatus 不得为 `complete`。
- C3.4 单项失败进入失败账本 `{url, reason, attempts}`；任务末尾对 retryable 失败做一轮有界重试（≤2 次/项）；不可重试原因（已删除/风控终态）记为显式跳过。整任务重试只重试失败项。
- C3.5 轮播多图：card_loop 检测轮播指示器并逐帧采集（受 max_images 约束），杜绝"10 张只采 1 张"。

落点：`content-task-runner.ts`、`agent-collection-plan.ts`、`browser-collector-actions.ts`、`agent-browser-collect.ts`、真值表测试新文件。

验收：复演 06-06 场景（62/69+7 失败）：重试只跑 7 条且每条有原因；复演 0 项场景：返回 needs_attention + 诊断；轮播笔记图片数 = 实际张数。

### S4. 跟进意图三分类与计划持久化（断裂三·任务记忆）

**目标**：跟进消息不再丢上下文；多步任务的计划跨轮存活并被复核。

核心合同：
- C4.1 **跟进分类器**（代码主导）：`{new_task | continue_task | status_query | correction}` 四分类——启发式快路径 + 歧义时模型判断题兜底；含否定词守卫（"不要采集"压制采集意图）。替换 ≤24 字符正则白名单。分类结果到能力暴露/任务指涉的映射全在代码，有真值表测试。
- C4.2a **计划持久化与回注**（无 Plan P 依赖）：任务计划（含 BrowserTaskPlan）写入 TurnFrame frame-state 与 projection `steps_json`（schema 已有此列）；每轮经 `SystemReminderRegistry` 回注"当前步骤 + 完成判据"。
- C4.2b **证据化步骤完成判定**（前置条件：Plan P WP3+WP5 验收通过）：步骤完成判定消费 Plan P 的动作后复查证据，不再信模型口头"步骤 N 完成"（呼应 Plan P §1.3.4）。在 Plan P 该两包就绪前，C4.2b 不得开工；C4.2a 期间步骤推进暂以"工具结果存在性"为弱判据并在 projection 标注 `verify=weak`。
- C4.3 **记忆注入限域**：L1 注入的当天记忆按当前 scope/任务谱系过滤；其他任务的 checkpoint 祈使文本不得进入当前会话上下文。
- C4.4 status_query 类消息（"怎么样了"）路由到任务状态播报（读 projection/事件桥），不重启任务、不丢能力暴露。

落点：`shared/browser-collection-intent.ts`、`agent-sdk-runtime.ts`（跟进门控）、`turn-frame.ts`、`prompt-assembly.ts`、`session/session-recall-service.ts`、`browser-task-planner.ts`（序列化）。

验收：场景测试——"接着弄/怎么样了/不要采集了，先看看"三类消息各自落到正确分支；隔轮后计划步骤仍可见；无关任务记忆不再出现在 system prompt（contract 测试断言）。

### S5. 会话快照与 provider 重试（断裂三·会话记忆，P2 优先级）

**目标**：重启不再失忆；provider 瞬时错误不再杀 run。

核心合同：
- C5.1 每次 run 正常收口时持久化 scope 级会话快照（复用 `normalizeSessionSnapshotForSeed()`，存储复用 Plan L 的 state-directory 模式）；重启后首条消息懒恢复并显式告知"已恢复到上次会话"；恢复失败时明示"会话已重置"，不装失忆。
- C5.2 SDK 主循环对 429/5xx/流中断按既有 `error-classifier`/`recovery-router` 策略做有界重试（与 tool-runtime 路径同一策略源，不造第二套）。

落点：`agent-sdk-runtime.ts`、`session/session-continuity.ts`、`claude-bridge/error-classifier.ts` 接线。

验收：kill 主进程→重启→"继续"能接上上文；模拟 429 两次后第三次成功，run 不死。

### S4.7 Plan L 收尾项（并入 Plan L 轨道，非新阶段）

本次审查发现的在途实现缺陷，归还给 Plan L 的剩余 PR 处理，列出以免遗漏：
1. 续跑时 `rebindTaskBudgetRuntime` 重置 usage，违反 Plan L I1/WP1.6"preserve usage"——续跑必须累加。
2. 预算 checkpoint 的单飞（trusted-handle/single-flight）实现不完整（Map 定义缺失），并发"继续"可能双跑。
3. 70/90% 转向注入（WP2.9）尚未见实现，warning 仍仅是被动元数据。
4. run_meta 与 projection 对同一 run 的 taskType/预算判定不一致（research/60 vs short_task/24）——单源化到 run 准入时一次解析。
5. checkpoint 仅在耗尽时写一次：改为滚动（每 N 个工具批次）或至少在每个干净批次边界更新（Plan L I4 的自然延伸）。

## 5. 顺序、并行与工单切分

```
轨道 A（agent-control）：S0 → S1 → S2 → S4 → S5
轨道 B（browser-engine）：S3（与 S1/S2 并行；与 Plan P 协调落点）
轨道 L（Plan L 剩余 PR + §4.7 收尾）：与 S0/S1 并行推进；S2 依赖其 WP3 续跑机制可用
```

依赖关系：S2 依赖 S1（事件桥的"无活跃 run→自动续跑"需要终止合同先成立，否则播报 run 自己也可能无声死亡）+ Plan L WP3；S4 的 C4.1/C4.2a/C4.3/C4.4 依赖 S1（TurnFrame 回注走同一提醒通道）；**S4 的 C4.2b 额外依赖 Plan P WP3+WP5 验收通过**（消费其动作后复查证据原语，未就绪前不得开工）；S3、S5 无强依赖。S3 显式定位为 **Plan L WP6 的扩展而非替代**——WP6 已落的 partial-resume 语义与测试保持为既成事实，S3 的判定矩阵在其上增加 0 项/no_new_content/单项重试/轮播条款。

Codex 工单切分原则：每单一个合同条款（如 C1.1）或更小；先合同测试（红）后实现（绿）；每单自验命令明确（focused test + typecheck）；跨文件大重构（仅 S1 收拢退出路径）拆成"先建通道→逐路径迁移→上 gate 禁旧路径"三单。

## 6. 全局完成标准（场景级验收）

全部阶段完成后，以下三个真实场景必须以行为测试（scripted-model seam）+ 一次 dogfood 复演通过：

1. **Henry.L 场景**：采集指令 → 不再出现无声 run；零工具宣告被转向或显式 checkpoint；轮播 10 图采 10 图；后台任务完成后自动播报，全程无需用户输入"继续"。
2. **reddit 调研场景**：预算 70/90% 有转向；触顶为受控 checkpoint；"继续"恢复同任务卡且预算累加；最终交付不需要用户连敲 4 次"继续"（自动续跑或一次显式确认）。
3. **重启场景**：任务进行中 kill 主进程 → 重启后三账本无 `working/running` 残留；可恢复任务出现在任务卡且"继续"真的能继续；不可恢复任务有明确解释。

外加既有门禁：`npm run typecheck`、`npm run test`、`npm run verify:native` 全绿；新 CI gate（终态 funnel、日志隔离、scheduleTask 路由注册）纳入 verify 链。

## 7. 风险与回退

| 风险 | 缓解 |
|---|---|
| S1 收拢退出路径触碰 5400 行核心文件，回归面大 | 三步走（建通道→迁移→封旧路）；每步独立可回退；scripted seam 行为测试先行 |
| 自动续跑（C2.2）造成意外 token 消耗或打扰 | 有界（continuation 预算 24）、单飞、可设置关闭；播报型续跑默认只做"叙述+建议"，执行型动作需既有授权在续跑状态中可证 |
| 行动宣告守卫误伤纯对话回答 | 守卫仅在「存在未完成任务指涉 + 末段零工具 + 行动宣告句式」三条件同时成立时触发，且只转向一次 |
| 事件桥与 projection sink 双消费者引入时序问题 | 事件桥消费侧幂等（按 taskId+终态去重）；测试覆盖"先 run 结束后任务完成"与反序 |
| 与 Plan L/P 在途改动冲突 | 落点表已按文件域隔离；冲突文件（agent-sdk-runtime.ts、content-task-runner.ts）上的工单按轨道串行 |
| 跟进分类器引入模型判断题成本 | 仅歧义路径调用（启发式置信时跳过）；判断题用最小上下文 |

## 8. 给 Codex 的审查问题清单

1. S1 的唯一收口通道与你正在实现的 Plan L checkpoint 分支（`checkpoint_budget`）如何合流最干净？是否同意 checkpoint 也作为 finalize 通道的一个出口而非旁路？
2. C2.2 的"无活跃 run→有界自动续跑"是否过于激进？备选：只落 pending 通知 + UI 红点，由用户点击触发播报。请基于 token 成本与打扰度给出倾向。
3. C1.2 行动宣告守卫的触发判据（零工具 + 宣告句式 + 未完成任务指涉）是否会漏掉/误伤你在实测中见过的形态？
4. S3 的 `resolveCollectionVerdict()` 单源化是否与你在 WP6 已写的 partial-resume 测试冲突？若有，以哪边为准合并？
5. 工单切分粒度（≤300 行/单）对你的执行节奏是否合适？
6. 你认为路线中缺了什么会导致"稳定好用"目标仍然达不到的项？
