---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Matrix.app 多级 Agent 架构技术规格书

**Date:** 2026-06-06
**性质:** 外部产品逆向研究（reference material，非实施合同，enforce: false）

## Goal

系统研究 `/Users/user/matrix-unpack` 解包出的 Matrix.app（flowith，com.matrixai.app v0.1.70）agent 架构，回答五个问题：

1. CEO agent（primary entrypoint）如何管控各个子 agent。
2. 任务如何做多级拆分、细化、执行与产物收拢合并。
3. 各级 agent 如何管理上下文。
4. 技能与工具如何归属、曝光与执行。
5. 哪些机制由代码承担、哪些交给模型判断。

## Study Inputs

- `prompts-extracted/INVENTORY.md`（提取清单：17 个独立提示词文件 + 99 段二进制内嵌片段）
- `prompts-extracted/files/neo-agent-seed/templates/workspace-architecture.md`（完整架构参考，seedVersion 30）
- `prompts-extracted/files/neo-agent-seed/prompts/workspace-schema.md`（注入每个会话的架构摘要）
- `prompts-extracted/files/neo-agent-seed/templates/{department-management,task-management,operating-architecture,skill-creator,computer-use-dispatcher,neo-computer,browser,email,media-generation,debug-and-report}-skill.md`
- `prompts-extracted/files/neo-agent-seed/prompts/crystallize.md` + `crystallize-ceo.md`
- `prompts-extracted/files/neo-agent-seed/scripts/{should-crystallize-run.ts,merge-user-md.sh,integrations-do.py}`
- `prompts-extracted/binary-embedded-prompts.txt`（主二进制内嵌：语音层人设、call_neo_intelligence 路由、@skill 派生任务模板、Computer Use 调度指令）
- `prompts-extracted/files/MatrixUserDebugSkill.md`（暴露 `~/.neo` 运行时目录结构）

## Review Status

本规格基于本轮对 `/Users/user/matrix-unpack` 的只读复审。可直接确认的证据来自解包出的 prompt、技能模板、脚本、`browser-v2/main.js` bundle 中可读的工具注册片段、Mach-O 运行时文件类型，以及 MatrixUserDebugSkill 暴露的 `~/.neo` 运行时目录约定。未确认的边界：没有运行 Matrix.app、没有连接真实 `mcp__matrix__department` / `mcp__okr__state` 服务、没有读取用户本机 `~/.neo` 真实工作区数据。因此本文描述的是 Matrix 暴露出来的架构合同和运行时形态，不声称每条合同都已在当前安装上端到端实测。

---

## 1. 运行时形态

- 原生 Swift/macOS app（非 Electron，无 asar），内嵌 Ghostty 终端、LiveKit（实时语音）、Rust 组件。
- Agent 引擎是独立的 CLI runtime **Neo Intelligence**（symlink `~/.local/bin/neo`，可在任意终端用 `neo` 启动）。从运行时痕迹看是 Claude Code 同形态的 harness：
  - transcript 落在 `~/.neo/projects/<sanitized-cwd>/<sessionId>.jsonl`（与 Claude Code 的 projects 目录消毒规则一致）；
  - 工具面是 Read / Write / Bash + MCP 工具；
  - 技能格式是 `skills/<name>/SKILL.md` + frontmatter（name/description 必填）。
- 每个部门有自己的会话注册表：`departments/{id}/.runtime/sessions/*.json`，字段含 `sessionId / rootSessionId / parentSessionId / transcriptPath / cwd / status / canonicalForDepartment` —— 这就是 **SessionTree**（每次请求的执行图）的持久化形态。另有 `trace.jsonl`（部门级工作痕迹）与 `.runtime/team.json`（worker 团队状态）。
- Worker 池是**异构外部 runtime**：Neo Agent、Codex、Claude Code（二进制文案还提到 Cursor、Devin、自定义 worker）。原生会话型 Worker 以 TUI-first 打开，可恢复持久化的原生 CLI 会话；Activity 面板是只读的 Worker 检查面。
- 桌面操作不走 agent 进程本体，而是独立签名的 `neo-computer` CLI（60MB arm64 Mach-O，bundle id `flowith.matrix.computer-use`），权限（辅助功能/录屏）归属该独立 bundle。
- 语音层是独立低延迟人设（LiveKit），自称"当前部门 lead agent 的语音通道"，凡实质请求一律通过 `call_neo_intelligence` 工具转给文本态 lead agent，自己不持有工具与工作区状态。

## 2. 组织模型（静态拓扑）

```
Workspace（顶层协调边界）
└── Department（稳定的 owner 容器：身份/记忆/技能/任务/协作史的长期归属）
    ├── Lead Agent（部门大脑：每部门一个 canonical lead session，持久）
    └── Worker Agents / subagents（同 owner 的临时执行席位，跑在部门文件系统里）
```

核心裁决线：

- **三个平面严格分离**：部门拓扑（谁拥有）/ 知识（知道什么）/ 执行（现在谁在跑、用什么证明）。
- **Primary department（`primary-entrypoint`，产品里叫 CEO Office）** 是工作区操作员：用户直接对话入口、请求路由、跨部门协调、维护工作区级资源（RULES.md / OKR.md / workspace memory），同时维护自己部门根目录的执行态。明确要求它"避免成为默认的专家执行者"——专家执行属于非主部门。
- **非主部门**是领域 owner：通过 department message 和 Task packet 接活，自管 memory/skills/artifacts/storage。
- 物理目录扁平（所有部门都是 `departments/{id}` 顶层兄弟），逻辑父子用 workspace `config.json` 里的 `parentDepartmentId` 表达。部门 CRUD 只有 primary entrypoint 能做（`mcp__matrix__department`），其他部门只能 `message.send` 提案。
- **Worker 不是组织单位**：Task 属于部门，永远不属于 worker。Worker 是"同 owner 并行切片"的执行席位；跨 owner 工作必须走 department message，子部门是 owner（有自己的 session），不能用 worker 替代。

## 3. 任务模型（多级拆分的状态形态）

任务分级不是 prompt 里的临时计划，而是**分形 OKR 状态机**，全部走 `mcp__okr__state` 工具读写，工具层做字段校验（"malformed records are ignored"）：

```
Objective（workspace/okr.json，只存 Objective）
└── Key Result（owning department 的 okr.json，引用 objectiveId）
    └── Task（department tasks/{task-id}.md，packet 形态）
        ├── Criteria（任务内完成门，[open|satisfied|blocked|not_applicable]）
        ├── Proof（具体引用：文件/URL/截图/任务输出/消息/报告）
        └── Check-in（判定记录：author/judgment/status/nextAction/proofRefs/learningRefs）
```

关键合同：

- **Objective** 必填 `objectiveId/title/ownerDepartmentId/summary/status/timeHorizon`；status ∈ draft|active|blocked|completed|cancelled。
- **Key Result** 必须写进 owning department 的 store（子部门的 KR 决不写进父部门）；必填 `keyResultId/objectiveId/ownerDepartmentId/title/targetState/status/priority`。
- **Task packet** 是带 frontmatter 的 markdown，必备小节：`## Brief / ## Trigger / ## Criteria / ## Context Refs / ## Next Action / ## Proof Refs / ## Learning Refs / ## Check-ins`。
- **Inbox Task**：可以没有 OKR 链接就开工（ad hoc 工作保持可见、可 check-in），但要影响 KR/Objective 状态必须同时补上 `objectiveId + keyResultId`，半截链接非法。
- `task.upsert` 开/改 packet；`task.check_in` 以 blocked|completed|failed|cancelled 收口，必须带 author、judgment、proof、next action；blocked/failed 还要带 `blockerCategory`（user_input_missing | department_waiting | external_system_failure | permission_or_credential | business_blocker）。
- **完成的真实性由 Criteria 闸门保证**：只有每条 Criteria 都 satisfied 或 not_applicable、每条 satisfied 都有 proof、Task 至少有一条 proof ref，才允许标 completed。占位符（TBD、空 owner、"待对方输入"）按规则**算 blocker 不算 proof**。
- Check-in 的两个显式决策位：`keyResultDecision`（accept|modify|reject —— 链接任务的 check-in 对 KR 状态建议的裁决）和 `learningDecision`（ignore | proof-only | memory-card | skill-update | next-task —— 学习去哪）。选 memory-card / skill-update 时必须先写目标文件、把路径放进 `learningRefs`。
- 结构变更本身也是 Task 事实：建/撤/并部门走 `org_change` 类型的 structure-change Task，由 primary entrypoint 拥有，记录理由与 proof。
- 评审/审批是 `Task(kind: "review")`，不是 Objective/KR 事实。

## 4. 控制流（CEO 如何管控子 agent）

### 4.0 CEO 的核心价值：任务拆解编译器，不只是部门管理员

本轮复审修正一个重点：`primary-entrypoint` / CEO Office 的价值不只是"谁管哪个部门"。它更像一个**任务拆解编译器**：把一个多维、模糊、混合多种能力的问题，先转换成若干有 owner、有目标、有完成条件、有上下文引用、有证明要求的工作包，再把这些工作包交给合适的专长 agent 或 worker 继续细化和执行。

这个过程至少拆出六类信息：

- **方向层**：用户真正要推进的方向、优先级、取舍、持续性意图。
- **归属层**：哪个现有 owner 能负责；是否需要新 owner；哪些部分是跨 owner 协作，哪些是同 owner 并行。
- **结果层**：每个切片要产出什么可判断结果，而不是只列动作。
- **完成层**：Criteria、Proof、Check-in 怎么证明完成，缺什么事实就标 blocker。
- **上下文层**：只向下传必要 brief、context refs、artifact refs；原始大上下文留在源头。
- **执行层**：lead 自己做、发 department message、创建 worker、调用脚本工具、委托 Browser Agent 单步，还是等待用户确认。

因此 Matrix 的多级能力不是"部门多所以强"，而是**每一级都先把上一级的宽问题变窄**：CEO 把工作拆给 owner；owner lead 把 owner 范围内的问题拆成 Task / Criteria / worker 切片；worker 拿到的是较窄、较准、带 proof 期待的执行问题。收拢时反向汇总：worker proof → owner check-in → KR/Objective 建议 → CEO/仪表盘投影。

### 4.1 路由决策梯（Decision Ladder）

一个问题定 ownership："这件事落在某个现有部门的职责内吗？"

1. 是 → `message.send` 路由给那个 owner。
2. 否 → 现在创建**最小 owner 集合**（部门创建只用于 fan-out：工作落在所有现有部门职责之外时）。
3. 模糊的野心 → 变成责任部门下的 inbox Task。

派生规则：同 owner 并行用 worker；跨 owner 协作用 department message；一次性零碎留 Task 不建部门。"两次相似的用户动作"就足以提议建 owner（去除重复 setup）。

### 4.2 跨部门协作环（消息合同）

`mcp__matrix__department` 上的显式协作循环，四个性质：发起方说清期望产出与上下文 → 接收方先确认 ownership 再做长活 → 接收方以具体结果/blocker/拒绝回复 → 发起方从回复继续，不留隐式交接。

- `message.send`：派发新工作（请求/评审/答案/续作），动作本身开启工作，**不带 outcome**。
- `message.reply kind:"reply"` + `outcome ∈ completed|failed|cancelled`：收口。
- `message.reply kind:"note"`：只在已有 thread 上加静默上下文，对方要行动就必须用 send。
- `message.queue` / `message.thread`：查队列与历史。
- `chat.read_recent` / `chat.search`：读另一个部门的对话史（用户提到跨部门旧话题时先读再答）。
- **大件产物走文件不走消息**：完整结果写 `artifacts/department-messages/{topic-or-deliverable}-{date}.md`，路径放 `attachments`，消息正文只留摘要+路由上下文；"一个 deliverable 落在一个消息和一个文件里"。
- **带 outcome 的回复+附件 = 相关 Task 的 proof**：接收部门交结果，发送方/owning 部门记 Check-in 并更新链接 KR。
- 冲突仲裁：多个部门收到对同一 artifact/承诺/决策不兼容的指示时，把确切冲突上报 primary entrypoint，本地只做廉价可逆的检查，等决策落地再走最小对齐步。

### 4.3 Lead → Worker 派发

二进制内嵌文案给出了 lead 的派发判断："Decide whether to execute directly or create the smallest Worker Agent. If you create a Worker Agent, pass AgentTool metadata workTaskId=..." —— worker 通过 `workTaskId` 元数据**绑死到 Task**。流程：lead 留上下文 → 选对 worker（Neo/Codex/Claude Code）→ 派发 → **review 返回的 proof**。

Dispatcher/Worker 的**两技能分工**（Computer Use 是范本）：

- `computer-use-dispatcher` 技能给 dispatcher（lead 侧）：只允许跑只读 readiness 检查（`neo-computer status --json`），就绪则创建 Worker 并把**用户原话**传给它（"不要改写成脆弱的关键词计划"），自己被明令禁止执行任何桌面动作。
- `neo-computer` 技能给 Worker（执行侧）：lease 纪律（一个 cursor lease 跑完整个任务，"脚本结束≠任务结束"）、先观察后行动（capture AX 树再动手）、前台安全规则、完成必须回传 UI 状态 proof（status、lease id、截图/节点数、前台变化、失败命令+exit code）。

浏览器同样分两档：`browser.script.run`（结构稳定、可重复验证的步骤走脚本）和 `browser.task.message`（把**单步**视觉任务委托给 Browser Agent，明令"不要把整段任务交给 Browser Agent；只委托一个边界清晰的步骤，然后调用方继续掌控"）。

### 4.4 系统驱动的回路（非用户触发的 turn）

App 用 `@skill:<name>` 模板**合成带技能指令的 turn** 注入 lead 会话（正则 `@skill:([\p{L}\p{N}_\-./]+)`）。二进制里的派生任务模板包括："Check in proof for Task …"、"Create the next concrete Task for Key Result …"、"Solve blocked Task …"、"A user-confirmed Objective page edit set …"。即 **UI 事件 → 合成的 task-management 技能 turn**，由 agent（而非 UI 代码）决定是否需要下一个 Task。

周期唤醒（periodic wake）与 Dashboard Task 列表共享同一份 **operating refs**（从 Task/KR 事实派生），每条 ref 带 owner、route、stop condition，优先级硬编码：

1. `due_time_trigger` → 2. `blocked_task` → 3. `proof_check_in_pending` → 4. `active_task` → 5. `active_key_result_missing_task` → 6. `active_objective_missing_first_key_result`

时间触发纪律：cron 只能绑在**已存在的 Task** 上（先建 Task 再挂 schedule，绑 `taskId`）。Trigger 只有三类：`manual` / `time` / `department_message`；外部事件是条件不是 trigger，需要执行时转换成三类之一。

### 4.5 增益来源：专长上下文隔离 + 扁平多级（补 4.0 的机制账）

4.0 说了"每一级都把宽问题变窄"，这一节回答**为什么变窄发生在 Matrix 里质量更高、成本更低**——关键在两段细化跑在不同的上下文里：

- **第一段（CEO，粗拆）的上下文只有**：部门目录（charter）、路由记忆卡、workspace 状态。**没有任何领域技能正文**——CEO 不需要会做浏览器自动化才能把活派给会做的人。
- **第二段（lead，细化）的上下文只有**：本部门身份（RULES.md）、本域知识 index（按需读卡）、本部门 skills/、收到的窄 brief。其他维度的材料完全不在场。

由此得到三个增益和一个附加项：

1. **上下文经济学**：CEO 持有 O(维度数) 的 brief+摘要；每个 lead 只装单维度材料。对照"单 agent 串行装 N 个技能"的形态——Σ(技能正文+中间产物) 挤同一个窗口、靠 compaction 损失信息——这是结构性优势，不是调参能弥补的。
2. **细化质量**：第二轮细化的注意力不被其他维度稀释，且由就近的领域知识/技能支撑；worker 因此拿到"准确、有指向性"的指令。
3. **时延**：维度间并行，整体时延 max(t_i) 而非 Σt_i。
4. 附加项：部门**持久性**让领域记忆随时间积累（crystallize 喂回路由与细化质量）。四项增益里只有这一项依赖"组织壳"，前三项只依赖**可实例化的专长上下文**。

**多级 ≠ 深嵌套**：Matrix 没有深 call-stack。层级由"扁平 owner + 消息合同 + 每个 owner 内单层 worker fan-out"组成；耐久调用帧是 Task packet 与 message thread（CEO→部门是平级消息，不是嵌套子进程），深嵌套固有的取消传播/上下文继承/跨进程恢复难题被状态合同消解。

## 5. 产物收拢与合并

信息流的方向合同：

- **向下**（子部门/worker）：Task packet + 精选上下文引用 + 期望产出。
- **向上**（父/请求方）：结果摘要 + artifact 引用 + 开放问题。
- **横向**（部门内）：Task refs、artifacts、storage、同 owner worker。
- **briefs 和文件引用在层间旅行；大块原始上下文留在原地。**

收拢链路：worker 产出 → lead review proof → proof refs 挂 Task/Criteria → Check-in 判定 → KR 状态建议（accept/modify/reject）→ Objective 进度 → 隐藏 Dashboard Agent 从源事实刷新投影（`dashboard.state`，普通部门只维护源事实，最多五张 v2 卡片）。后台任务完成通知的输出文件本身就是 proof ref。

## 6. 上下文管理（各级 agent 各自看到什么）

### 6.1 会话启动注入集（固定且小）

每个部门会话自动加载：

- Workspace 级：`RULES.md`、`OKR.md`、`USER.md`、`memory/knowledge/index.md`
- Department 级：`RULES.md`、`memory/knowledge/index.md`
- 外加 `workspace-schema.md`（架构摘要，"decision contract"），完整版 `WORKSPACE_ARCHITECTURE.md` 按需读。

**知识体系只注入 index，不注入卡片**。index 条目是检索线索不是摘要：格式固定 `- [[slug]] — description [H]`，描述要写成触发条件（"Read before..." / "Use when..." / "Applies to..." / "Remember when..."）。命中当前请求的条目，动手前先读链接卡片。

### 6.2 文件系统即上下文边界

- 文件放进**最窄的耐久归属**：服务一个部门的事实留部门 memory，服务工作区的进 workspace memory（storage/artifacts 同理）。
- 全部文件工作落在自己部门根下；丢弃型文件进 `tmp/`（TMPDIR/mktemp/os.tmpdir() 已重定向到那里）；值得活过会话的，升格为 Task/artifact/storage/memory card/消息附件。
- 工具管理的状态躲在 MCP 工具后面（部门注册表/消息、OKR/Task 事实），agent 不直接编辑 `.neo/`、`.runtime/`、`dashboard.json`。
- agent 创建的文件一律 kebab-case（保证 shell 不用引号）。

### 6.3 模型循环内预算

prompt 材料未暴露 token 级预算机制（那在 Neo Intelligence 引擎里），但行为约束清晰：大上下文留在源头、只传 brief 和引用、读 index 按需取卡、技能 body >500 行就拆 references/。

## 7. 记忆系统

### 7.1 双写者模型（同一张信念网络）

| 写者 | 节奏 | 负责 |
|---|---|---|
| Agent（实时） | 即时 | 原子信念卡 `memory/knowledge/{slug}.md`（至少一条前向 `[[wikilink]]`）、Task proof refs、artifacts/storage、`USER.md` 直接 Write |
| Crystallize（后台维护） | 每 4h、按部门错峰 | 衰减/孤儿/去重、`## Backlinks` 重建、`index.md` 重建、漏写卡片补写、USER.md 合并 |

设计意图：实时写者保证耐久观察当回合落地，后台维护做积累态整理；信念卡按部门本地化避免跨部门写竞争。

### 7.2 Crystallize（后台记忆固化）的工程细节

- 跑在**短命维护会话**里（独立 session id，不进用户聊天 transcript），所有效果必须落盘。
- **付费闸门在 LLM 之前**：`should-crystallize-run.ts` 是确定性 gate 脚本，跑在生成维护子进程之前，说 skip 就记录 skipped 痕迹直接退出，**一个 LLM token 都不花**。进了会话之后"空轮也是合法的可审计结果"。
- 卡片有 `confidence: H|M|L` 和 `tag: knowledge|self|aspire|north-star`；重复确认升 confidence，遇反例降，90 天无引用的 aspire 卡先降级后删除（**偏好降级而非删除**）。近重复卡不直接合并（破坏性），标 `possible-duplicate-of` 留给下轮。
- Backlinks 是托管区段（HTML 注释标记包裹），由 shell 脚本重算图谱后重写；index.md 每轮从磁盘真相重建（MOC 卡置顶，按 tag 分组、confidence 降序）。
- **USER.md 是工作区共享单文件，≤40 行，第三人称**，多部门维护会话可能并发：实时 agent 直接 Write，后台维护必须走 `merge-user-md.sh`（noclobber 锁 + SHA256 CAS + 原子 mv；macOS 无默认 flock，所以用 POSIX noclobber）。CAS 不匹配就干净放弃这轮，下个 cron 重试 —— "静默丢数据的代价远高于跳过一轮"。
- PII 纪律：凭据/敏感标识符永不落盘；用户给的公开 handle 属于 USER.md 不属于信念卡。

### 7.3 CEO 部门的额外职责（crystallize-ceo addendum）

primary entrypoint 的 crystallize 多一项：**让工作区结构跟上用户真实工作流**。

- **涌现候选**：重复工作流以 `tag: aspire` 信念卡追踪，frontmatter 带 `status: hint|candidate|emerged|routed|retired`，必须含带日期的证据。两次相似 turn（输入稳定、过程可重复、产出可识别、有明显 owner）就标记；单个超出所有现有部门职责的项目也标记（提示 CEO 提前 fan-out）。
- **路由记忆**：每个部门建立后，CEO 必须有 `memory/knowledge/routing-*.md`（`tag: self`，`confidence: H`），写明路由条件、目标部门、CEO 本地保留什么、首条消息带什么上下文。
- **校准**：模式消失/被更好 owner 覆盖/短命批次 → 降 confidence；结构看着不对就写合并/退役/改道建议（执行权留给运行时的 CEO）。

## 8. 技能与工具

### 8.1 技能形态

- `skills/<name>/SKILL.md`，两个 scope：workspace 级（跨部门复用）与 department 级（领域专属）。
- frontmatter：`name`（kebab-case = 目录名）、`description`（**承重字段**——agent 只凭它决定要不要调用，必须写 WHAT+WHEN+触发短语）、`category`、`symbolName`（SF Symbol，app UI 用）、`seedVersion`（正文实质变更时递增）、可选 `user-invocable: false`、`allowed-tools`。
- 目录槽位：`scripts/`（可执行辅助）、`references/`（按需加载的文档，变体多就一变体一文件，SKILL.md 只做路由）、`assets/`。
- 正文风格合同：祈使语气、解释 WHY 而非只列步骤、具体输入/输出例子、<500 行、除安全关键外避免 MUST/NEVER 轰炸。
- **技能从重复模式结晶，不从单次任务**——入口是 Check-in 的 `learningDecision: skill-update`，以及 skill-creator 元技能（捕获意图 → 选 scope → 草拟 → 真实任务试跑 → 按失败改 → 1-3 轮迭代，验收=用户跑 2-3 个新鲜任务都满意）。

### 8.2 工具面（按归属分层）

| 层 | 工具 | 归属与纪律 |
|---|---|---|
| 组织状态 | `mcp__matrix__department` | 部门 CRUD（仅 primary）、消息、跨部门 chat 读取；注册表/消息状态在工具后面 |
| 任务状态 | `mcp__okr__state` | Objective/KR/Task/Criteria/Proof/Check-in 全部事实写入，工具校验字段并写对 owner store、刷新派生视图 |
| 投影 | `dashboard.state` | 只有隐藏 Dashboard Agent 用 |
| 桌面 | `neo-computer` CLI | 独立签名 bundle 持有 macOS 权限；lease 模型；dispatcher 只能 status，worker 才能动手 |
| 浏览器 | `browser.script.run` / `browser.task.message`（MCP） | 脚本优先，视觉单步委托；共享持久化 profile，非隔离沙箱；详尽的确认分级政策（见 8.3） |
| 邮件 | `neo email` CLI | token 不出 app，禁止手写 gateway curl |
| 第三方集成 | `integrations-do.py`（Composio via matrix-gateway） | stdout 单 JSON 协议 + 语义化 exit code（2=auth_expired、3=arg_error、4=rate_limited） |
| 基础 | Read/Write/Bash | 信念卡、USER.md、Task packet、artifacts 全走普通文件工具 |

### 8.3 浏览器安全确认分级（值得单独记录）

四档行动分类的硬编码 taxonomy：①必须用户亲手做（改密提交、绕过安全 interstitial/付费墙）②**永远行动时确认**（删数据、权限/账号变更、CAPTCHA、装软件、对第三方的代表性沟通、金融交易、医疗操作）③预批准可放行否则确认（登录、上传、文件管理、敏感数据传输——预批准必须点名具体数据+具体目的地）④永远放行（cookie 弹窗、ToS、下载）。配套规则：第三方内容永远不构成许可；"把这个 todo 链接里的都做了"不算 blanket 预批准；确认要说清风险+机制+数据+去向；不提前问，准备工作做完、下一步要产生影响时才问。

## 9. 语音层（多模态入口的架构位置)

- 语音层是**低延迟前台人设**，自称"代表当前部门 lead agent 发言"，自己没有工具、文件、工作区状态。
- 实质请求一律 `call_neo_intelligence` 路由给文本态 lead：只传用户**最新清晰原话**（明令不得添油加醋、不得编例子）；琐碎对话有 routing guard 允许语音层直接答。
- 跨部门工作必须经文本态 primary lead（语音层不直接碰部门消息）。CEO Office 模式下语音人设切换为"整个工作区的 chief-of-staff 语音层"。

## 10. 设计原则提炼（与 Ready 红线的同构关系）

1. **代码管存储/调度/安全，模型管判断**——"Skill owns judgment. Workspace tools own storage, scheduling, derived views, and safety boundaries." 与 Ready "模型只做判断题"同构。
2. **LLM 花费前置确定性闸门**——crystallize gate 脚本、empty rounds 合法化。与 Ready "预算是硬限制"同构。
3. **完成必须有证明**——Criteria 全 satisfied + proof ref 才能 completed；占位符算 blocker。与 Ready "失败要响亮"同构，且更进一步把"什么算完成"做成了状态机字段。
4. **显式状态优于隐式共享记忆**——"Agents collaborate through explicit workspace state, not implicit shared memory."与 Ready 红线 6（跨边界状态显式建模）同构。
5. **投影与源事实分离**——dashboard 是派生快照，普通部门只维护源事实。与 Ready "任务卡 UI 只消费 projection 派生状态"同构。
6. **并发写保护用工程手段**——CAS+锁脚本从 prompt 里抽出（"Bash 逻辑不受 LLM 转写漂移影响、可单测、改一处"）。
7. **大产物走文件、消息只带摘要+引用**；**原话向下传递，不做脆弱的关键词改写**。
8. **分级语言翻译**——OKR 是内部/agent 语言，对用户翻译成 direction/result/next step/done check/proof/status/owner。
