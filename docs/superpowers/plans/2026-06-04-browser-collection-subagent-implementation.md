---
title: 规划 + 后台浏览器采集子 Agent + 解耦的 Agent 标签页（形态 B）实施计划
date: 2026-06-04
status: approved（Codex AGREE 2026-06-04，形态 B）
owner: 白
executor: Claude
enforce: true
note: 形态 B。主 agent 先规划，再委托一个持租约的后台浏览器采集子 agent（child-run）自主跑"逐篇打开→提取→下载"循环；该子 agent 在一个**专用 agent 标签页**里工作，绝不抢占用户当前界面；agent 标签页有发光提醒，中断 agent 控制需二级确认。先与 Codex 计划循环，双方一致后开发。
related:
  - docs/superpowers/plans/2026-06-04-agent-self-serve-browser-collection-implementation.md（阶段一 A，已落地：曝光解耦 + free-loop 租约 + 高风控执行层 + cookie-aware 下载）
  - docs/superpowers/plans/2026-06-04-agent-browser-visible-crawler-counterplan.md（write-lease + visible_collect + 双泳道 + Agent Browser session + 回放/接管，已落地租约与采集核心）
  - docs/superpowers/plans/2026-06-01-browserview-presentation-unification-implementation.md（BrowserViewIntent 单一边界）
  - CLAUDE.md §2（BrowserView 原生覆盖层硬约束）、§3（child-loop / durable handle / projection 合同）、§4（capability 维度）
evidence_child_run:
  - src/main/modules/agent-control/skills/skill-child-drivers.ts:27-43（SkillChildDriver 接口）
  - src/main/modules/agent-control/video-expert-child-driver.ts（参考 driver 完整生命周期）
  - src/main/modules/agent-control/skills/skill-child-runner.ts:388-392, 509-610, 789-864（start/resume/cancel）
  - src/main/modules/agent-control/tools-runtime/tool-registry.ts:1257-1371（executeSkillActionViaToolGateway，child 单 tool 白名单，browserController 未传入）
  - src/main/modules/agent-control/skills/skill-child-runner.ts:2444-2455, 2714-2723, 1723-1807（进度投影）
evidence_browser:
  - src/main/modules/browser-engine/tab-lifecycle-service.ts（tab owner 'manual'|'agent'，persist:browser）
  - src/main/modules/browser-engine/tab-shell-service.ts:111-130（navigate 操作 active tab → 抢占根因）
  - src/main/modules/browser-engine/agent-browser-turn-lease.ts、browser-write-lease.ts（已落地租约）
  - src/main/modules/browser-engine/ipc-handler.ts（BrowserViewIntent 呈现）
evidence_matrix:
  - prompts-zh/neo-agent-seed/templates/computer-use-dispatcher-skill.md（dispatcher→Worker，传原始任务非脆弱关键词计划，Worker 持 cursor lease 至任务真完成）
  - prompts-zh/neo-agent-seed/templates/neo-computer-skill.md:48-60（cursor lease + 虚拟光标 say 气泡 + 背景安全、禁止前台激活/抢占）
---

# 规划 + 后台浏览器采集子 Agent + 解耦的 Agent 标签页（形态 B）

> 实测暴露三个真问题：(1) agent 在 chat turn 内同步采集 → 用户每次"再试一次"都抢占（preempt）正在跑的工作；(2) agent 即兴一步步走、在"逐篇点开笔记取高清图"上卡住；(3) **agent 操作时会抢占用户当前浏览器界面**（navigate 直接改 active tab）。
>
> 本计划用 Matrix 的 dispatcher→Worker 思路解决：主 agent **先规划**，再把采集任务**委托给一个后台子 agent**（child-run），子 agent 在一个**专用 agent 标签页**里自主跑采集循环、持租约、投影进度、可暂停/接管/恢复；agent 标签页有**发光提醒**，用户**二级确认**才能中断 agent 对浏览器的控制。

---

## 0.1 UI 方向修订（2026-06-04 用户）

监督 UI 不走"标签页发光 + 视图内边缘发光 + 弹窗二级确认"，改为 **fastcard 式嵌套子 agent 面板**（更简、复用现有 task-card / fastcard projection）：
- 一个小浮动面板（类 fastcard），**仅当有被分派出去、带独立任务的子 agent 时出现**；默认折叠在任务卡里。
- 点任务卡 → 展开内部多个折叠的**子 agent session 任务卡**。
- 点某子任务卡 → 显示该子任务名称、子任务内容、**agent 当前工作内容**。
- 接管/停止走任务卡的现有取消 + AgentTabControlGate 冻结（当用户真去操作 agent 标签页时）；发光提醒降级为面板里的活动状态。
- WP4 据此调整：核心是"嵌套子 agent session 投影面板"，而非浏览器视图发光层。

## 0. 一句话

把长采集从"主 agent 在 chat turn 内即兴执行、抢占用户 active tab"改成"主 agent 规划 → 后台浏览器采集子 agent 在专用 agent 标签页里持租约自主执行、进度投影、可监督接管"，彻底解耦于 chat turn 和用户当前浏览界面。

---

## 1. 前因后果（实测三问题）

### 1.1 抢占 / 中断（preempt）
采集跑在 chat turn 内（free-loop），用户发新消息就 `preempted previous SDK run`，正在跑的采集被取消。日志实证：13:31/13:33/13:36/13:42 连续 preempt。→ 需要把采集移出 chat turn，跑成**后台 child-run**（不被新消息抢占）。

### 1.2 即兴卡死
agent 读完小红书主页后出现 4.5 分钟空档再 fallback 到 web_search。没有计划、逐步即兴 → 卡在"逐篇点开"。→ 需要**先规划**（编译采集计划：note 列表 + per-note 步骤 + 停止条件），子 agent 按计划确定性执行。

### 1.3 抢占用户当前浏览界面
`tab-shell-service.ts:111-130` 的 navigate 操作 **active tab**——agent 一 navigate 就改了用户正在看的页面。这是"没解耦"的根因。→ agent 必须在**专用 agent 标签页**里工作，绝不碰用户 active tab。

### 1.4 已具备的基础（前两阶段已落地）
- write-lease（idle/held/takeover/expired）+ free-loop turn 租约 + 接管识别骨架。
- visible_collect 后台任务（逐轮 checkpoint、去重、硬预算、丢租约即停、cookie-aware 下载、高风控限速）。
- 曝光解耦 + 采集子集 + 高风控脚本黑名单。
- child-run 机制（driver 接口、生命周期、进度投影、resume/cancel）**复用度 90%+**。

---

## 2. Matrix 借鉴（已核对）

| Matrix 做法 | 证据 | Ready 采纳 |
| --- | --- | --- |
| dispatcher 创建 Worker 子 agent，**传原始任务**非脆弱关键词计划 | computer-use-dispatcher | 主 agent 规划后委托 child-run，计划是结构化 note 列表而非关键词 |
| Worker 持 **cursor lease** 至任务真完成（脚本结束≠任务完成） | neo-computer:48-60 | 子 agent 持 agent-view 租约整段采集，结束才释放 |
| **背景安全、禁止前台激活/抢占**用户应用 | neo-computer:54 | agent 专用标签页，绝不切换/抢占用户 active tab |
| **虚拟光标 + say 气泡**让用户看见 agent 在做什么 | neo-computer:3,57 | agent 标签页发光 + 活动状态条（Ready 适配） |
| Worker 用短 say 汇报进度 | computer-use-dispatcher | 进度投影到任务卡 + 活动摘要 |

Matrix 的 agent 浏览器是**独立隐藏进程**（browser-v2，visibility set(true) 不支持），所以用户根本看不到它抢屏。Ready 在同一 Electron 窗口内，用**专用可见但明确标记的 agent 标签页 + 发光 + 二级确认**做 Ready 适配的解耦与监督。

---

## 3. 目标设计

### 3.0 三道硬边界（Codex R1 核心纠正）

计划的价值不在"复用 child-run"，而在三道**必须新建**的硬隔离边界。把它们钉死，其余复用：

1. **后台运行边界**：browser-collector child-run **不挂当前 chat turn 的 abort**。现状 `skill-child-runner.ts:1358` 用 `linkParentAbort(parentAbortSignal, controller)` 把 child 绑到父 abort，而 direct-chat 新消息会 abort 上一轮 controller（`direct-chat.ts:827-839`）——**所以单纯做成 child-run 并不能解决 preempt**。必须给 browser-collector 一条"后台 abort 策略"：不 link chat turn abort，只响应显式取消 / 窗口关闭 / 显式接管。
2. **写入只打 agent tab 边界**：子 agent 的浏览器写入**只能定向固定的 agentTabId**，禁止 null/active 目标。现状 `browser_navigate` 打 active tab（`browser-tools.ts:2992`）、`createTab` 默认 owner=manual 且激活并 show host（`tab-lifecycle-service.ts:88-115,188`）、`visible_collect(url)` 走 `openTarget` 可能抢前台（`content-task-runner.ts:149`、`capability-service.ts:288`）——这些路径会破坏隔离，必须改。
3. **冻结-再-确认接管边界**：二级确认是一个状态机：用户对 agent tab 的写交互或点"停止/接管" → **先冻结 agent-view 写入（pending）** → 等确认 → 确认才 cancel/takeover，取消确认则恢复。现状 UI cancel 直接 cancel child-run（`active-child-run-ipc.ts:125`、`use-task-interaction-handlers.ts:256`），无 pending/freeze。**注意 BrowserView 是 native overlay，DOM 发光层无法可靠拦截页面点击**——拦截/冻结必须走主进程 Electron 输入信号或先隐藏/冻结 host。

### 3.1 总体形态

```
用户请求
  → 主 agent: 规划阶段（编译采集计划：目标主页 + note 列表 + per-note 步骤 + 停止条件）
  → 主 agent: 委托 child-run（browser-collector driver），传计划 + agent 标签页句柄
  → 后台子 agent: 在 agent 专用标签页里跑 per-note 循环（持 agent-view 租约）
       每篇: 打开 note → 提取高清图 URL → cookie-aware 下载到该篇文件夹 → 下一篇
       逐篇 checkpoint，进度投影到任务卡
  → 用户: 看到 agent 标签页发光；可点开观摩（视图内边缘发光）；二级确认才能中断
  → 子 agent: 完成/阻塞 → close event + proof（已采集 N 篇、文件夹路径）回主 agent
```

### 3.2 规划阶段（Plan-first）
- 主 agent 在曝光采集能力时，**先产出结构化采集计划**（复用 browser-task-planner 的 plan 结构思路）：
  - `targetProfileUrl`、`noteList`（从主页可见信息流采集到的 note 链接 + 标题）、`perNoteSteps`、`stopConditions`（max_notes / max_duration / 连续失败上限）、`outputRootDir`。
  - note 列表的获取本身是一次"可见采集"（visible_collect 模板路径在 agent 标签页打开主页后采集 note 链接）。
- 计划可向用户确认（可选；默认直接委托，遵循 Matrix"传原始任务"——计划是给子 agent 的执行依据，不是必须用户逐条确认）。

### 3.3 后台采集子 agent（child-run driver）
新增 `browser-collector` SkillChildDriver（实现 canStart/canResume/createInitialState/planNextAction/observeAfterAction，参照 video-expert-child-driver）：
- `createInitialState`：从计划编译 `CollectionPlan { notes[], cursor, collected:Set, failed:Map, outputRoot }`，记录 agent 标签页 id + 租约。
- `planNextAction`：cursor 到末尾或命中停止条件 → close(completed)；否则返回下一篇的采集 action（open note → collect images → download）。
- `observeAfterAction`：读该篇结果，更新 cursor/collected/failed，写 run_state.json（durable）。
- 进度：`completed=|collected|`、`total=|notes|`、`detail="正在采集第 X/N 篇：<标题>"`。
- resume/cancel 复用现有机制（run_state.json + outputDir 为 durable handle）。

### 3.4 child 内浏览器 action 的执行通路（Codex R2 #1 核心补全）
经核对（Codex R2）：现状 child gateway 把 driver action 固定包成 `skill_${skillId}_${action}` 并只执行该 skill tool（`tool-registry.ts:1298-1332`，`allowedToolNames=new Set([toolName])`）；`SkillChildDriverAction` 只有 `{action,input}` 无 tool kind（`skill-child-run-types.ts:278-280`）；`ToolContext.browserController` 只在 browser domain 分支被消费（`tool-executor.ts:290-320`）。**所以仅给 child ToolContext 塞 browser context 不会让 driver 直接调 `browser_*`。** 必须钉死 dispatch 通路：

**采用：`browser-collector` 是一个 native child-action handler（不是沙箱 skill），其 action 收到一个 ScopedBrowserFacade。**
- driver `planNextAction` 返回 `{action: 'collect_note', input: {noteUrl, title}}`（计划"采哪一篇"）。
- gateway 路由到 native `browser-collector` action handler（类比 `skill_video_expert_pipeline` 的 native 处理），把 **ScopedBrowserFacade** 注入它（不裸传 BrowserController）。
- ScopedBrowserFacade = 一个绑定了 `agentTabId / surface='agent-view' / leaseId / allowedBrowserSubset / controlGate` 的 `executeBrowserTool` 外观：
  - 强制每次调用 `tab_id = agentTabId`，拒绝 null/active/其它 tab；
  - 只允许采集子集白名单（按**可读 / 可写 / 可定向**三类拆，不可定向写工具不进子集）；
  - 每次写前过 agent-view 租约 gate + control gate（§3.6）。
- action handler 用 facade 跑单篇序列：navigate(agentTabId, noteUrl) → collect_images/extract(agentTabId) → cookie-aware download → 返回 `{collectedNoteId, imageCount, savedDir}`。
- `observeAfterAction` 读该结果更新 cursor/collected/failed。

合同：driver 只产 `collect_note` action；浏览器写只经 ScopedBrowserFacade（定向 agentTabId）；child 无法经任何路径调子集外或非定向浏览器工具。

### 3.5 解耦的 agent 专用标签页（核心：不抢占用户界面）
- 新增 `ensureAgentTab` / `createAgentTab`：owner='agent'、**不激活、不 show host**、返回 tabId（修正 `createTab` 默认激活+show 的行为，`tab-lifecycle-service.ts:88-115,188`）。persist:browser 分区带用户登录态。
- 子 agent 的所有 browser 写工具**强制定向 agentTabId，禁止 null/active 目标**：
  - `browser_navigate` 在 child 上下文必须打 agentTabId，不打 active tab。
  - `browser_visible_collect` 在 child 上下文**只能用 tabId，不能用 url**（url 会走 `openTarget` 抢前台，`content-task-runner.ts:149`）；note 的打开由 driver 用定向 navigate 完成。
  - `openForCaptureTarget` / `switchTab` 在 child 路径禁用或改为非激活变体。
- agent 标签页**不自动夺取前台**：不改变用户当前 active tab；用户可主动点开 agent 标签页观摩。
- **读路径也必须定向（Codex R2 #3）**：`extractStructured(tabId)` 虽在目标 tab 执行 JS，但 `sourceUrl` 现从 active tab 取（`capability-service.ts:381-390`）——agent 后台采集会把用户当前页当来源页，污染相对链接和结果证明。必须改为：read/extract/capture/wait 的来源/结果一律来自 `agentTabId`（解析目标 tab 的 url），绝不回读 active tab。
- 合同：子 agent 运行期间，用户 active tab 的 URL/activeTab/滚动位置/split-tab/host 呈现零变化（对齐 counterplan WP1 + BrowserViewIntent 2026-06-01 回归）；且 read 结果的 sourceUrl 来自 agentTabId 而非 active tab。

### 3.6 视觉提醒 + 二级确认接管（监督 UI，含冻结-确认状态机）
- **标签页发光**：agent 拥有的标签页在 tab strip 上有发光/脉冲标记（renderer，按 owner='agent' + activity='running' 派生）。
- **视图内边缘发光**：用户点开 agent 标签页查看时，视图内边缘发光边框，表示"agent 正在控制此页"。
- **活动状态**（Matrix say 气泡的 Ready 适配）：agent 标签页/任务卡显示当前动作摘要（"正在采集第 X/N 篇"）。
- **冻结-再-确认状态机（独立 control gate，不改 lease state，Codex R2 #2）**：BrowserWriteLease 明确只有 `idle/held/takeover/expired` 且"lease 不是任务状态机"（`browser-write-lease.ts:4-7,28`）。pending/freeze **不塞进 lease**，新增一个 **AgentTabControlGate**（状态：`active / pending_confirm / frozen`）管冻结：
  1. 用户对 agent tab 的写交互（点击页面/输入/导航/关闭）或点"停止/接管" → control gate 进入 **pending_confirm**：ScopedBrowserFacade 每次写前检查 control gate，pending/frozen 时**挡住子 agent 写**（不取消任务）。
  2. 弹二级确认（"Agent 正在采集，确认接管/停止？"）。
  3. 确认停止 → cancelSkillChildRun + lease release；确认接管 → 暂停子 agent + lease.takeover（用户接管 agent-view）；取消确认 → control gate 回 `active`，子 agent 继续。
- **native overlay 拦截（Codex R1 #7）**：BrowserView 是原生覆盖层，DOM 发光层**无法可靠拦截页面点击**。control gate 的触发与冻结走**主进程**：检测对 agent tab 的用户输入信号（Electron `before-input-event` / 导航 / 切 tab IPC）即置 pending_confirm，并在确认前用 hideAll/host 冻结或主进程层拒绝转发，而非依赖 DOM 层。
- 监督只消费 projection 派生状态（renderer 不本地猜测），对齐红线。

### 3.7 租约模型 + 持有者（与解耦协同）
- 子 agent 持 **agent-view 租约**（不是 user-view）——它操作 agent 专用标签页，与用户 active tab（user-view）天然隔离。user-view 不被触碰，自然不抢占。
- **持有者职责钉死**（修正 Codex R1 遗漏）：`agent-view leaseId` 写入 **child run state**（durable）；child runner 在每个 action 前 heartbeat、在 complete/fail/cancel **都必须 release**；driver 只读 leaseId 不持有；visible_collect 在 child 内复用同一 leaseId（不自己 acquire）。
- 二级确认接管 = 对 agent-view 触发 takeover（pending→确认→子 agent 写即停）。**agent-view 的 takeover 信号源就是这套冻结-确认状态机**（修正 Codex R1 遗漏：生产路径此前无 agent-view takeover 调用点）。
- 用户 active tab 的 user-view 租约/接管逻辑保持前阶段不变；子 agent 永远 agent-view，主 agent free-loop 永远 user-view，互不干扰。

### 3.8 后台 abort 归属矩阵（修正 Codex R1 #1/#2 + 遗漏）
| 事件 | browser-collector 行为 |
| --- | --- |
| chat turn 新消息 preempt（abort 父 controller） | **不取消**（不 link parent abort，后台独立运行） |
| 用户显式取消任务卡 | 取消（cancelSkillChildRun + release 租约） |
| 二级确认后选择停止 | 取消（同上） |
| 二级确认后选择接管 | 暂停子 agent（freeze），用户接管 agent-view |
| 窗口关闭 / 应用退出 | 优雅停止 + 持久化 checkpoint（可恢复） |
| session 切换 | 后台继续（不绑当前 session 的 turn abort） |

### 3.9 agent 标签页生命周期（修正 Codex R1 遗漏）
- 创建不激活、不 show host；优先**复用单一长驻 agent 标签页**（per scope），减少 tab 噪声。
- 任务完成后**保留**供用户查看，活动标记清除（不再发光）；用户可手动关闭。
- 崩溃/重启：agent 标签页随 persist:browser 恢复；child run state 的 agentTabId 失效时由 driver resume 时 ensureAgentTab 重建。
- 多采集并发：同一 scope 同时只允许一个 browser-collector child（单飞折叠，复用 skill-child-runner 现有并发门控）；第二个排队或拒绝。

### 3.10 规划阶段 runtime（修正 Codex R1 遗漏）
- 规划由**主 agent LLM** 产出结构化 `CollectionPlan`（schema：targetProfileUrl、notes[{url,title}]、perNoteSteps、stopConditions{maxNotes,maxDurationMs,maxConsecutiveFailures}、outputRootDir），**经 Zod 校验**后才委托 child；校验失败回主 agent 澄清。
- note 列表来源：主 agent 在 agent 标签页打开主页后用 visible_collect（tabId 模板路径）采集 note 链接。
- **24-action child 上限**（`MAX_ACTIONS_PER_CHILD_RUN=24`）：长采集必须**分段续跑**——driver 每段采集 ≤K 篇，命中段上限时复用**现有 `budget_paused / checkpoint_budget` 语义**收尾（Codex R2 #10：不另造名字），由进度卡/自动 resume 续下一段；run state 记 cursor。

---

## 4. 工作包

### WP0 — 合同先行（三道硬边界优先）
- **后台边界**：chat turn 新消息 preempt **不取消** browser-collector；显式取消才取消（§3.8 矩阵）。
- **隔离边界**：子 agent 运行期用户 active tab 的 URL/activeTab/滚动/split-tab/host 呈现零变化（含 BrowserViewIntent 2026-06-01 回归）。
- **写定向边界**：child 内 browser 写工具禁止 null/active 目标，强制 agentTabId（工具层补 tab_id + 实现，proxy 兜底）；visible_collect 仅 tabId 不 url。
- **读定向边界（Codex R2 #3）**：read/extract/capture/wait 的来源/sourceUrl 必须来自 agentTabId，不回读 active tab。
- **dispatch 通路**：child 浏览器只经 `browser-collector` native action 的 ScopedBrowserFacade，无任何旁路调子集外/非定向工具。
- **能力掩码**：child 内只能调采集子集白名单（按可读/可写/可定向拆分），子集外拒绝。
- **冻结-确认**：pending 冻结 agent-view 写入；确认才 cancel/takeover；取消确认则解冻恢复。
- 计划 schema 校验 + per-note checkpoint/resume + 24-action 分段续跑合同。
- 验收：合同测试先红后绿。

### WP1 — 后台 abort 策略 + child 受限浏览器上下文
- browser-collector child **不 link parent abort**（新增后台 abort 策略，§3.8）；只响应显式 cancel / 窗口关闭。
- `ChildGatewayParams` 加 `ScopedChildBrowserContext`（agentTabId/surface/leaseId/allowedBrowserSubset）；`executeSkillActionViaToolGateway` 构建 child ToolContext（受限 controller 代理 + 子集白名单 + agent-view 租约）。
- 验收：新消息不取消该 child；child action 能调采集子集、不能调子集外；非 child 路径不受影响。

### WP2 — agent 专用标签页 + 工具层定向 + ScopedBrowserFacade
- `ensureAgentTab`（owner=agent，不激活、不 show host）；给 `browser_navigate`/`browser_search` 等补 `tab_id` 并实现定向；ScopedBrowserFacade（强制 agentTabId + 子集 + control gate + agent-view 租约），controller proxy 兜底拒绝 null/active/异 tab；read 来源改为 agentTabId（修 extractStructured sourceUrl）；visible_collect 仅 tabId。
- 验收：子 agent navigate/collect 期间用户 active tab URL/滚动/split/host 呈现零变化；read 结果 sourceUrl 来自 agentTabId；facade 拒绝 null/active/异 tab 与子集外工具；BrowserViewIntent 回归通过。

### WP3 — browser-collector child driver + 规划阶段 + 分段
- 新增 driver（canStart/canResume/createInitialState/planNextAction/observeAfterAction）；主 agent LLM 产出 CollectionPlan（Zod 校验）；per-note 确定性循环（导航 agent tab → 模板采集 → cookie-aware 下载 → 下一篇）；24-action 分段续跑。
- 租约持有者：leaseId 写 run state，runner 每 action heartbeat、终态 release。
- 验收：fixture 主页 → 计划 N 篇 → 逐篇采集 → 每篇建文件夹 → 下载；逐篇 checkpoint；取消可查；resume 续跑；超 24 action 分段续跑；leaseId 终态释放。

### WP4 — 进度投影 + 视觉提醒 + 冻结-确认接管
- 进度投影（ScopeRunSkillProgress detail="第 X/N 篇"）；tab strip agent 发光；视图内边缘发光；**AgentTabControlGate 冻结-确认状态机**（独立于 lease；主进程检测对 agent tab 的用户输入信号 → pending_confirm 冻结 facade 写 → 二级确认 → cancel/takeover/解冻）。
- native overlay：冻结/拦截走主进程输入信号 + host 冻结，不依赖 DOM 层；确认后才调 lease takeover/cancel。
- 按 CLAUDE.md §7 最小闭环（IPC/preload/renderer 类型/组件/行为测试/文档）。
- 验收：agent 标签页发光；点开见内边缘发光；用户写交互触发 pending（agent 写冻结）；确认后停止/接管、取消确认后恢复；renderer 只消费 projection。

### WP5 — 高风控 + 限速 + 合规（隔离之后的保护层）
- 在上述隔离合同之上叠加：子 agent 高风控沿用脚本黑名单 + 限速限量；只采可见、不绕登录/验证码；敏感动作确认。
- 验收：fixture 必须；真实小红书人工 dogfood 证据。

---

## 5. 复用 vs 新建（据 Explore 报告）

| 能力 | 现状 | 复用 | 新建 |
| --- | --- | --- | --- |
| child driver 接口/生命周期 | SkillChildDriver + video-expert 参考 | 90% | browser-collector driver |
| 进度投影/resume/cancel | 完整 | 95-100% | detail 模板 |
| write-lease / 接管 | 已落地 | 100% | agent-view 用法 + 二级确认 |
| visible_collect / cookie-aware 下载 / 高风控 | 已落地 | 90% | per-note 循环复用其原子 |
| child 内 browser 工具 | 仅单 skill tool，无 browserController | 0% | **ChildGatewayParams 扩展 + 能力掩码（高风险）** |
| agent 专用标签页定向 | owner 元数据无隔离，navigate 操作 active tab | 20% | **写工具定向 agent tab（中高风险）** |
| 视觉发光 + 二级确认 | 无 | 0% | **renderer 监督 UI（中风险）** |

---

## 6. 风险与处理
- **preempt 未解耦（高，Codex R1 #1）**：child 默认 link parent abort，新消息仍杀 child。处理：后台 abort 策略不 link chat turn abort；合同测试锁"新消息不取消"。
- **裸传 BrowserController（高，Codex R1 #2）**：把全权浏览器能力带进 child。处理：受限浏览器上下文（强制 tabId + 子集白名单 + agent-view 租约），不裸传。
- **写工具碰 active tab（高，Codex R1 #5）**：navigate/createTab/visible_collect(url)/openForCaptureTarget 抢前台。处理：ensureAgentTab 不激活、写工具强制 agentTabId 拒 null/active、visible_collect 仅 tabId；BrowserViewIntent 回归。
- **二级确认竞态 + native overlay（中高，Codex R1 #7）**：DOM 发光层拦不住页面点击。处理：冻结-确认状态机走主进程输入信号 + host 冻结，先冻结再确认。
- **per-note 可靠性（中高）**：单篇失败/超时/部分采集。处理：driver 区分可恢复 vs 终端错误，失败计数 + 跳过 + 上限。
- **24-action 上限（中）**：长采集被 child 上限截断。处理：分段续跑 + cursor。
- **child-run 复杂度（中）**：分阶段，WP1 后台+使能 → WP2 定向 → WP3 driver → WP4 UI（同轮）。

---

## 7. 决策（R1 后已定）

已定（吸收 Codex R1）：
1. **agent 标签页**：复用单一长驻 agent 标签页（per scope），完成保留供查看（§3.9）。
2. **规划确认**：不强制用户确认（Matrix 传原始任务），但 CollectionPlan 经 Zod 校验 + 可见（§3.10）。
3. **per-note**：driver 确定性循环（note URL 已知，导航+模板采集+下载可确定性编排），模板失败降级（§3.3）。
4. **二级确认触发点**：任何对 agent tab 的写交互 + 显式"停止/接管"按钮都触发 pending（§3.6）。
5. **租约边界**：子 agent 永远 agent-view，主 agent free-loop 永远 user-view，互不干扰（§3.7）。
6. **后台 abort**：browser-collector 不 link chat turn abort（§3.8）。
7. **持有者**：leaseId 在 child run state，runner heartbeat/终态 release（§3.7）。

8. **tab 定向（Codex R2 #4 已定）**：**工具层定向为主**——给 `browser_navigate` / `browser_search` 等补 `tab_id` 参数并实现定向（现状无 tab_id、走 `controller.navigate(null,url)`，`browser-interaction-schemas.ts:20-22`、`browser-tools.ts:2992-3038`）；child gateway 强制注入 `agentTabId`；ScopedBrowserFacade 的 controller 代理只做**最后一道防线**（拒绝 null/active/异 tab），不把安全藏在代理魔法里。合同直接钉工具层定向。

---

## 8. 非目标
1. 不引入独立 Chromium（沿用 Electron + agent 标签页）。
2. 不绕登录/验证码/权限；不批量压测抓取。
3. 不让子 agent 无限自治（硬预算 + 停止条件 + 可接管）。
4. 不在本轮做拟人化输入（按 dogfood 决定）。
5. 不把网页内容当可信指令。

---

## 9. 成功标准
1. 用户让 agent 采集小红书博主笔记图片，agent **先给计划**再后台执行，**不抢占用户当前浏览界面**（active tab 零变化）。
2. 采集跑成后台 child-run，用户发新消息**不再 preempt** 采集；进度在任务卡可见（第 X/N 篇）。
3. agent 操作的标签页**发光提醒**；点开见**内边缘发光**；**二级确认**才能中断 agent 控制。
4. 逐篇建文件夹、cookie-aware 下载高清图；可暂停/接管/恢复。
5. 高风控只采可见、限速限量、不绕权限。
6. 所有跨边界状态有合同与测试。

---

## 10. 评审循环记录

### Round 1（2026-06-04，Codex → AGREE-WITH-CHANGES，10 条必改全采纳）

核心架构七点获认可。Codex 核心纠正："计划把'已有机制可复用'和'已有机制已满足后台隔离'混在了一起"，真正要补三道硬边界（已核对 file:line 并写进 §3.0）：
1. **child-run 不被 chat preempt**：`skill-child-runner.ts:1358` linkParentAbort + `direct-chat.ts:827` 新消息 abort → 单纯 child-run 不解决 preempt。新增后台 abort 策略（§3.8、WP1）。
2. **浏览器写只打 agent tab**：navigate 打 active、createTab 激活+show、visible_collect(url) openTarget 抢前台 → ensureAgentTab 不激活 + 写定向 agentTabId + visible_collect 仅 tabId（§3.5、WP2）。
3. **冻结-再-确认接管**：UI cancel 直接 cancel，无 pending；BrowserView native overlay，DOM 拦不住点击 → 冻结-确认状态机走主进程输入信号（§3.6、WP4）。

其余采纳：不裸传 BrowserController 改受限上下文（§3.4）；ToolContext 已有 browserController/allowedToolNames/browserLease（gateway 未传，已核对 tool-executor.ts:76,80,99）；浏览器子集按可读/可写/可定向拆；leaseId 持有者钉死在 child run state（§3.7）；abort 归属矩阵（§3.8）；agent 标签页生命周期（§3.9）；规划 runtime + Zod 校验（§3.10）；24-action 分段续跑（§3.10）；高风控限速作为隔离之后的保护层（WP5）。

### Round 2（2026-06-04，Codex → AGREE-WITH-CHANGES，三边界 PASS，4 阻塞 → 已修）

三道硬边界 PASS，10 条多数 PASS。4 个阻塞补全（均已核对 file:line）：
1. **child 浏览器 dispatch 通路**（最大）：仅塞 ToolContext 不够——gateway 把 action 包成 `skill_${id}_${action}` 只跑该 skill tool，browserController 只在 browser domain 分支消费。改为 `browser-collector` 是 **native child-action handler**，其 action 收 **ScopedBrowserFacade**（绑定 agentTabId/agent-view/leaseId/子集/control gate 的 executeBrowserTool 外观），单篇序列经它跑（§3.4 重写）。
2. **pending 不进 lease state**：lease 只 idle/held/takeover/expired。新增独立 **AgentTabControlGate**（active/pending_confirm/frozen）管冻结，确认后才调 lease takeover/cancel（§3.6）。
3. **读路径也定向**：`extractStructured` 的 sourceUrl 现从 active tab 取（capability-service.ts:381-390）→ 改为来自 agentTabId（§3.5、WP0/WP2 合同）。
4. **tab 定向：工具层为主、proxy 兜底**：给 navigate/search 补 tab_id + 实现，gateway 注入 agentTabId，proxy 只做最后防线（§7.8、WP2）。
另：24-action 复用现有 budget_paused/checkpoint_budget 语义（§3.10）。

### Round 3（2026-06-04，Codex 终审 → AGREE）

4 条修复逐条 PASS，无新阻塞。Codex 结论："无补充，达成一致，可以开始开发。" 实现期需用测试钉住 url 形态旧绕路（extract_structured(url)/scroll_collect(url)/visible_collect(url)）——facade 拒 url、navigate(agentTabId)-first。计划评审循环结束，进入开发。

## 11. 实施记录（Claude，2026-06-05，待 Codex 结果评审）

### 11.1 关键架构偏离（需 Codex 审）：执行层走 content-task-runner，不走 SkillChildDriver child-run

计划 §3.3/§3.4/WP3 规定子 agent 是 `SkillChildDriver` child-run，action 经 ScopedBrowserFacade。实现时**改为把"执行"挂到现有 `BrowserContentTaskRunner` 的新 `note_collect` 后台任务**，理由：

- **§1.1/§3.8 的 preempt 根因在 child-run 本身**（`skill-child-runner.ts:1358` linkParentAbort）。`content-task-runner` 的后台任务**天然不绑 chat-turn abort**（`activeRuns` map，SQLite 持久化，与 visible_collect 同机制），直接满足"不被 preempt"，无需新写 §3.8 的后台 abort 策略，规避了 §3.4 evidence 指出的最大风险点（gateway 不给 child 传 browserController）。
- **执行是确定性的**：主 agent 产出 `CollectionPlan`（判断题），引擎跑 `planNextNote → collectNote → recordNoteResult`（状态机）。不需要 child 内再开 LLM 循环 → 对齐"模型只做判断题"原则。
- content-task-runner 已有 start/checkpoint/resume/cancel + 自持租约 + lease-loss 检测（proven by visible_collect）。
- **三道硬边界仍由 ScopedBrowserFacade + AgentTabControlGate + agent-view lease 保住**：`note_collect` 经注入的 CollectorFacadeFactory 拿到绑定 agentTabId/agent-view/leaseId/子集/control-gate 的 facade（executeBrowserTool 懒加载避免静态环）。url 形态旧绕路由 facade 拒绝（scoped-browser-facade.test.ts 已钉）。

代价：放弃了 child-run 的 24-action 分段（§3.10）与"子 agent 即 LLM 循环"的形态；进度也未走 TaskProjection（content-task 不投影到 renderer），改为 supervision 面板**轮询** `browser:getAgentSupervisionState`。请 Codex 判断该偏离是否可接受，或是否必须回到 child-run。

### 11.2 已落地（6 commit，typecheck 绿，全量 4786 pass / 2 known liquid-glass fail）

- **WP0/WP2 合同**：`agent-collection-plan`（CollectionPlan Zod + 逐篇 loop）、`ScopedBrowserFacade`（子集/freeze/url 拒绝/定向）、`AgentTabControlGate`（active/pending_confirm/frozen，独立于 lease）、navigate/search 补 tab_id + 定向、extractStructured sourceUrl 从 agentTabId 取。
- **执行核心**：`collectNote`（单篇 navigate→collect_images→cookie-aware download）、`runBrowserCollection`（确定性 loop，可从 checkpoint 续跑，shouldStop 探针）、`note_collect`（自持 agent-view 租约 + 引擎 + 每篇 checkpoint，停于 cancel/freeze='cancelled'/takeover='lease_lost'）。
- **曝光**：`browser_collect_notes` 工具（schema/catalog/写分类 ALWAYS_WRITE/采集子集）。
- **解耦**：`ensureAgentTab`（建 owner:'agent' 后台标签页 + 还原用户 active tab）。
- **监督 UI**：agent 标签页发光（TabRail）、`AgentBrowserSupervisionPanel`（嵌套子 agent 卡 + 二级确认中断）、supervision IPC 桥。
- **WP5**：高风控限量（≤60 篇/≤20min）+ 逐篇 1.5s 限速。
- **测试**：collectNote(5)、engine(6 含 pacing/resume/stop)、note_collect runner(6 含 lease/freeze/takeover)、collect_notes dispatch(2)、控制门(7)、facade(6)。

### 11.3 待实测（dev app 验证项）

- agent 标签页是否真不抢前台（ensureAgentTab 还原 active tab 的实际效果）。
- supervision 面板在 native BrowserView 上的可见性/定位（与 BrowserDiagnosticsDock 同框，待确认是否被遮挡或需 hideAll）。
- freeze → 引擎下一篇 shouldStop 命中的实际时延。
- 登录态下对真实小红书主页逐篇采集的端到端跑通。

### 11.4 结果评审 Round 1（2026-06-05，Codex → REQUEST-CHANGES，5 条已修）

Codex 接受架构偏离方向，但要求守住配套硬边界。5 条必改逐条修复：

1. **二级确认后立即取消任务**：`confirmAgentInterruption` 现在 freeze 后立即 `cancelTask` 所有 note_collect 任务（不等下一循环）；`runNoteCollect` 终态按 stopReason 写 `cancelled`（freeze/lease takeover 不再写成 completed）。
2. **agent tab 用户交互触发冻结**：`ensureAgentTab` 给 agent tab webContents 挂 `before-input-event`——用户真实键入（agent 自身经 CDP/loadURL 不触发）→ requestInterruption + preventDefault 拦截，直到二级确认；新增 `browser:agentControlChanged` 推送，面板即时刷新。
3. **scrollCollect 定向 sourceUrl**：`scrollCollect` 的 sourceUrl 改从目标 tabId 取（与 extractStructured 一致），不再污染为 active tab。
4. **ensureAgentTab 真不抢前台**：`createTab` 新增 `background` 形态——后台标签页不 setActive、不 showHost、不 finalizeSwap，页面后台加载、零闪烁；ensureAgentTab 改用 background:true。
5. **高风控预算**：新增全局并发 cap（高风控限 1 并发 → 同域串行 = per-domain 频控）+ 逐篇 1.5s 限速 + 下载量预算（`maxTotalImages`=400，引擎累计图片数到顶停 `max_images`；字节级预算需下载层报告字节数，留作后续）。

新增/更新测试：engine `max_images`、runner freeze/takeover 终态 `cancelled`。typecheck 绿，全量通过（仅 2 个既有 liquid-glass 失败）。仍待实测：before-input-event 冻结、background tab 不抢前台、面板遮挡。

复审残留（commit 1df2026a）：#1 的 `pending_confirm` 也被 `isWriteBlocked` 判 true，runner 在 pending 阶段就 cancelled——拆分探针：新增 `AgentTabControlGate.isFrozen()`（仅 frozen）供 runner cancel，`isWriteBlocked()`（pending+frozen）仍供 facade 阻塞写。pending 只阻塞写 + 弹二级确认，确认→frozen→cancelTask 才取消。

**结果评审 Round 2（2026-06-05，Codex → APPROVE）**：5 条全部 PASS，残留已清。本轮结果评审循环结束。仍存上述 dev app 实测项（need live verification）。
