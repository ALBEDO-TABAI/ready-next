---
title: Working Agent 长任务与浏览器所有权整治路线图（裁决版）
date: 2026-07-22
kind: roadmap-adjudication
status: approved
enforce: true
approved_by: 白（2026-07-22，三项决策全部按推荐确认）
owner: 白
author: Claude
adjudicates:
  - docs/superpowers/audits/2026-07-22-browser-agent-long-task-root-cause-and-evidence.md
  - docs/superpowers/plans/2026-07-22-browser-agent-sequential-long-task-and-tab-ownership-closure-implementation.md
  - docs/superpowers/plans/2026-07-22-agent-plan-execute-policy-hooks-and-branching-runtime-design.md
requires:
  - docs/architecture/current-runtime-contracts.md §5..§6
  - .claude/architectural-principles.md
---

# Working Agent 长任务与浏览器所有权整治路线图（裁决版）

## 0. 本文职责与边界

本文只做一件事：对 2026-07-22 三份文档（根因审计 + Browser 顺序收口计划 + 长任务架构计划）以及所有相邻在途车道做**跨计划排序与范围裁决**。证据链在审计文档（含其 §6 独立复核）；阶段实施细节在两份配对计划；本文不重复它们，只裁决"谁先谁后、边界在哪、冲突怎么定"。

2026-07-22 用户已确认全部裁决与 §5 三项决策，本文为 approved，是跨计划排序与范围的唯一权威。配对状态：收口计划 `approved-for-implementation / enforce: true`（含 §1.8 默认路由与 S3-min 定稿）；架构计划方向已确认、唯一实施阻塞 = A1–A12。执行入口见配套 handoff：`docs/superpowers/plans/2026-07-22-codex-implementation-handoff.md`。后续任一范围变更先改本文裁决条目，再同步配对计划。

## 1. 事实基座（已独立复核，不再重开）

1. **六个根因成立**：R1 所有权粒度错位（surface 级全局租约 vs tab 级物理身份，含 R1a sticky takeover / R1b stale turn lease / R1c 跨 tab 复用三条确定性缺口）、R2 等待用户不重置无进展时钟、R3 "继续"丢失任务身份、R4 控制失败不入账、R5 接管无返还动作、R6 类型/预算/终态投影分裂（95%，S0 先证）。复核记录见审计 §6：三例最小复现逐字复得、SQLite 读回一致、全部源码锚点逐行确认。
2. **中断向量全图的三个要点**（S0 的输入，完整向量表见 §6 附录）：
   - 研究型长任务的头号杀手是 dynamic-delivery no-progress deadline（120s/240s，`delivery-deadline.ts`），且它终态化为**不可续跑**的 `delivery_failed`（kind:'error'），绕过了全部既有 checkpoint 机器。
   - 主进程 15 分钟守卫**有** awaiting-input 豁免（`orchestrator.ts:390-397` 重置而非击杀），delivery deadline **没有**——"等待用户暂停时钟"这一语义只实现了一半，两处该同语义。
   - 可续跑暂停机器已经存在且充分：browser suspension checkpoints（`agent-sdk-browser-suspension.ts`）、research-incomplete 两次停滞守卫（`agent-sdk-browser-candidate-closure.ts`，`MAX_STALLED=2`）、预算 checkpoint（run_state.json 句柄）、启动 reconciler。R2/R3 的修复本质是**把 deadline 中止路径接入既有机器**，不是新建持久层。
3. **所有权模型的产品层真相**：agent 默认驱动**用户当前活动 tab**（目标缺省=active tab，新 tab owner 缺省 `'manual'`，一切落在 user-view）；专用后台 agent tab 的整套机器——`ensureAgentTab()`、`ScopedBrowserFacade`、`agent-view` 调度、`releaseForBackgroundHandoff()`、bounds-lock——**全部建好未接线（零生产调用方）**。接管信号矩阵不自洽：键盘=整 surface 击杀、切页=整 surface 击杀、**鼠标点击/滚动=零信号**（普通 tab 无 mouse 监听）、**地址栏导航/前进后退/刷新=零信号**（`'navigation'` 信号源定义了但生产从未记录）、关 tab=静默潜伏到下次写入。14 条用户-agent 冲突场景逐条行为已在复核中枚举。
4. **相邻车道现状（修正过时口径）**：07-17 四车道全部落地（浏览器工具面收敛、工具能力可见性与同意、浏览器性能、文档模式性能，均 completed/enforce:true）；07-18 grounded orchestration 为 `partially-implemented-known-failures`，当前工作树 ~117 文件 / 约 +3.9k 行未提交改动即其续作；boost/QuickJS 工作流已在其自身文档 §0 取消（无代码），与架构计划 §12.4 无冲突。
5. **打地鼠的结构解释**：近两周的修复都真实落地了，但都在"单次运行内正确性"层（工具合同、性能、能力可见性、观察纪律）。本次场景死在**跨 run、跨 tab、跨等待窗口**的所有权与连续性层——该层此前没有机器可验合同，每个局部修复都无法覆盖它。这不是修复质量问题，是缺一层合同。

## 2. 裁决清单

### 裁决 1：审计采信

审计作为 L0 证据基座**采信**，含两点增补（已写入审计 §6）：agent 自身存在可触发 takeover 信号的代码路径（popup follow / `tabs_switch` 经共享 `switchTab()`）；R3/R5 定性为对 contracts §6 既有承诺的**实现回归**，R1/R2 定性为**合同缺口**（修复方向不同：回归修实现、缺口先改合同）。

### 裁决 2：Browser 顺序收口计划——方向采纳，S3 收缩为 S3-min

S0、S1、S2、S4（维持 R6 proof 前置门）、S5 照案采纳。S3 收缩：

**移交架构计划**（doc 3 为唯一建表地）：§1.5 四张 interaction lifecycle / suspension epoch / outcome delivery / progress clock 持久表及其全边界崩溃注入矩阵（归入 P3）；§1.5.1 四张 call-scope / provider-request / parent-budget / budget-entry 账本（本就与 doc 3 §2.2 同源，归 P1）。

**S3-min 保留五件套**：
1. deadline 改显式 suspend/resume 状态机：交互创建即 suspend、resolved 即一次进展并重置**完整**窗口——与主守卫 awaiting-input 豁免同语义，消除半实现；
2. `noteProgress` 增加 `user_input_resolved` 入口，进程内 `InteractionLifecycleRegistry` 包装现有 ask / 技能 ask / 高危确认 / 页面挑战 / 接管 pending 源（不建表）；
3. §1.6 终态映射：deadline 中止在存在 durable Browser child/plan/journal 时走既有 browser suspension 机器产出可续跑 `blocked_tool_error`/checkpoint，**不再裸 `delivery_failed`**；
4. "继续"闭环：typed resume 直连 + 自然语言从 TurnFrame 结构化候选做语义选择、多候选必反问、零候选按新请求；
5. 续跑保持 taskId / browserTaskId / request anchor 不变，`runOrigin=continuation`。

**理由**：(a) 不倒置评审顺序——不能以"浏览器 bugfix"名义先落一份尚未获批架构的最深层 schema，这正是两份计划自述"互相阻塞"的根源；(b) 既有 E3 checkpoint 机器足以承载续跑修复，A1-A12 的用户可见行为验收一条不缩水；(c) 缩短原任务恢复可用的时间。

**接受的过渡风险（明示）**：崩溃窗口内（ask pending 时重启、outcome 应用中途崩溃）恢复粒度较粗（按现有 checkpoint 冷启动合同结算为可续跑暂停）且理论上存在重复计费窗口；**不产生重复外部副作用**——页面动作仍由既有 action journal 与 unknown-effect 纪律去重。该风险在 L1 P3 落表后消除。单一路径原则不破：S3-min 完全替换现行为，不留双轨。

### 裁决 3：长任务架构计划——方向采纳，三点增补

混合架构方向（ReAct 降为节点内叶子执行器、canonical ExecutionPlan 为代码控制面、typed policy 三层固定优先级、hooks 收缩为 observer、唯一零工具 final verifier、拓扑按 顺序→只读 fan-out→候选分支→Browser 子代理 分期）**采纳**。增补：

1. P1 出口必须含用户可见价值验收（真实长任务在 canonical plan 下端到端跑通），不允许账本-only 阶段（已批注入 doc 3 P1）。
2. 吸收裁决 2 移交的持久表（P1 账本、P3 interaction 表，已批注入 doc 3 §2.2）。
3. HookRegistry 按其 §8 二选一处置，**倾向删除**（符合"建好没接生产=头号系统债"的既定政策；live 等价物是 SystemReminderRegistry + tool-executor 准入 + action-confirmation-policy 三件）。

boost/QuickJS 无需用户重裁：其自身文档已取消，架构计划 §12.4 与其一致。

### 裁决 4：总排序

```text
L-1 在途清算（先于一切编码，见 §3）
 -> L0 = Browser 顺序收口（S0 -> S1 -> S2 -> S3-min -> [S4 | R6 proof] -> S5）
      出口 = A1-A12：原始 18 组小红书任务真实 Electron 连续 3 过
      （无干预 / 接管后恢复 / 重启后恢复）
 -> L1 = 长任务架构 P0 -> P6（P1 吸收账本 + 可见价值出口；P3 吸收 interaction 表；
      每阶段重跑 verify:browser-sequential-regression）
 -> L2 = Browser 多标签页 target-isolated 调研子代理（doc 3 P7 入场合同，另立计划）
```

并行不阻塞车道：kimi-k3 specialization（in_progress，正交）；C1 长研究上下文性能切片（S5 后）。07-18 计划被 doc 2 supersede；其在途实现的处置属 L-1。

### 裁决 5：产品北极星——并行共处的默认路由（新增决策）

目标状态一句话：**用户和 agent 在同一个浏览器里各干各的，互不踩踏；用户看 agent 干活不打断它，动它的页面才接管它，且只接管那一页。**

三层配合，缺一不可：
1. **S1 的 target claim 让冲突"安全"**（tab 级所有权，接管只冻结精确 target）；
2. **S2 的信号归因让冲突"可判"**（correlation 区分 agent 回声 / 用户呈现 / 页面自发 / 真实输入）；
3. **本裁决让冲突"罕见"**：research / collection 型 Browser 工作默认在 **agent 自有 tab**（owner:'agent'）上进行，呈现不抢用户活动 tab（不自动 switchTab 到 agent 工作页）；只有任务确实关于用户当前页面、或用户明确要求"让我看着"时才驱动用户所在 tab。查看 agent tab 不等于接管（doc 2 §1.2 信号表已定）。

实施落点（并入 L0，不另立计划）：
- S1 range 内裁决 dormant 件的去留：`ensureAgentTab` / `ScopedBrowserFacade` / `releaseForBackgroundHandoff` / bounds-lock 一律**删除或改写为 claim 时代的等价物**，不得以"复活旧代码"的方式接线（07-18 审计已指认旧后台路径可绕过 ownerRunId/journal/stop 纪律）；surface 保留为呈现路由（doc 2 §1.1 原案）。
- S2 range 内补齐两个信号缺口：目标 tab 的**指针输入监听**（当前普通 tab 无 mouse 监听，用户点击与 agent 动作在同页赛跑且零仲裁）；**chrome 发起的用户导航**（地址栏/前进后退/刷新）记为该 target 的用户信号（当前 `'navigation'` 定义了但从未记录）；**用户关 tab** 同事务结算 claim（当前静默潜伏到下次写入，且失败不入账）。

### 裁决 6：并行子代理诉求的位置

"分配子 agent 多开标签页并行搜索"映射到 L2（doc 3 P7 入场合同：每分支独占 target claim、同 target 串行不同 target 并行、最多 2 个 target_isolated_browser_research 分支、接管只暂停对应分支）。前置硬门 = L0 A1-A12 + L1 P5。在 surface 级全局锁上直接并行会把现有死锁放大成跨代理越权——顺序都没站稳之前不开并行，此序不可倒。2026-06-04 三份旧计划维持 superseded。

### 裁决 7：文档权威地图（本轮之后）

| 文档 | 唯一职责 |
| --- | --- |
| 审计 2026-07-22（含 §6 复核） | 失败证据与根因真值；不再追加计划内容 |
| doc 2 顺序收口计划 | L0 阶段权威（S3 按本文裁决 2 执行 S3-min） |
| doc 3 架构计划 | L1/L2 阶段权威（含吸收的持久表） |
| 本文 | 跨计划排序与范围裁决的唯一入口 |
| current-runtime-contracts.md | 只在对应 gate 通过后同步当前权威合同 |

过时口径一并修正：boost 已取消；07-17 四车道已落地；`agent-view`/后台采集子代理为 dormant 而非可用能力。

## 3. L-1 在途清算（先于一切编码）

1. **dirty tree 定性与处置**：当前未提交改动（~117 文件，约 +3.9k 净增，含 2 份未跟踪源码 `agent-sdk-provider-request-retry.ts` / `grounded-delivery-repair.ts`）是 07-18 计划续作。处置：先跑 `npm run typecheck`、`npm run verify:browser-orchestration`、`npm run verify:stability` 与受影响专项 gate——
   - 绿：按 07-18 部分实现收尾提交（commit message 标注 partially-implemented-known-failures 状态与本路线图指针）；
   - 不绿或与 S1 改动面冲突过大：独立分支封存，S0 从干净基线开始。
   禁止带着未定性的 4k 行进入 S1。已确认（2026-07-22）按本项执行，操作细则见 handoff 第一批动作。
2. **文档落库**：三份 07-22 文档 + 审计 §6 复核 + 本文，单独 docs-only 提交。
3. **探针清理**：`.ready-exact-prompt-live*.{mjs,json}`、`.ready-provider-probe.mjs` 移入 `outputs/agent-audit/` 归档或删除（审计引用的 report 保留归档），不留在仓库根目录。

## 4. S0 失败测试补充输入（来自向量全图与所有权复核）

doc 2 S0 清单之外，以下缺口必须同批入 S0 失败测试或 L1 对应 gate（标注归属）：

| 缺口 | 归属 |
| --- | --- |
| A1 deadline 中止终态断言（当前无测试断言其产出不可续跑 `delivery_failed`；修复后断言产出可续跑暂停） | L0-S0 |
| 用户回答后获得完整新窗口（1s 轮询击杀路径） | L0-S0（doc 2 已列） |
| 鼠标点击 / chrome 导航 / 关 tab 三类信号的 target 级归因与 claim 结算 | L0-S0/S2 |
| stale-projection 30 分钟收尾（`stale-projection-finalizer.ts`）无任何测试 | L0-S0 |
| 主守卫 15 分钟真实击杀路径无直接测试 | L0-S0 |
| R8 投影 UoW 不变量违规（`bound Browser Parent requires workflow unit-of-work`，五日内 ×9，含击杀一次 sendScoped）——找出绕过路径并写失败测试 | L0-S0 |
| R9 handoff 启动恢复僵尸循环（`core_closeout_owner_mismatch` 每次开机重试 ×11）——恢复失败需有终态 receipt 出口 | L0-S0 |
| R7 孤儿 run 定性（07-21 14:36 三连 compaction + wire request 后 20 分钟全日志静默、无 run_close 无崩溃记录；process-events 日志 07-20 后停摆的观测缺口一并修） | L0-S0 定性 / L1-P1 request ledger 根治 |
| R10 排他技能组合在浏览器研究请求上误选择（tag-forge floors 饿死 browser 面，×1）——路由/选择层定性 | L0-S0 定性 |
| `link-parent-abort` 传播、missing-tool 一次性恢复 | L1-P0 |
| 死代码清理：`PREEMPT_SETTLE_TIMEOUT_MS` 死导入、`withToolExecutionTimeout` 无调用方、`'navigation'` 信号源、dormant 后台 tab 全家（随 S1 删除或接线，不留第三态） | L0-S1 |
| delivery deadline 与主守卫双计时器语义统一（同一 awaiting-input 语义、明确谁是长任务权威时钟） | L0-S3-min |

## 5. 已确认决策记录（2026-07-22，白）

三项决策全部按推荐确认，并已定稿写入配对文档：

1. **S3-min 两段式**：收口计划 S3 章节已重写为执行版（进程内时钟状态机 + §1.6 终态映射 + typed 续跑），§1.5/§1.5.1 保留为移交架构计划的目标设计原文；§4 验证命令同步（新增 `verify:agent-continuation-clock`；`verify:agent-interaction-lifecycle` / `verify:provider-request-ledger` 移至架构计划 P3/P1）；验收矩阵 A7 已按 L0 行为面改写。
2. **研究默认走 agent 自有 tab**：定稿为收口计划 §1.8，并落入 §0.3 总完成标准第 13 条、§1.2 信号表（chrome 导航行 + 信号源缺口说明）、S1/S2 改动与 Gate、验收矩阵 A1（用户活动 tab 零打扰）。
3. **L-1 dirty tree 处置**：按选项 A 执行——先 docs-only 提交，再逐条跑 gate 记录 EXIT；全绿则按 07-18 部分实现收尾提交，任一红则封存 wip 分支后以干净基线开工。操作细则见 handoff。

配对状态同步完成：收口计划 `approved-for-implementation / enforce: true`；架构计划 `approved-direction-blocked-by-browser-sequential-closure`（唯一阻塞 = A1–A12）；本文 `approved / enforce: true`。

## 6. 附录：中断向量全图（S0 输入）

系统性向量清单（2026-07-22 工作树核对；行号按当时快照，实施时以符号定位）。可续跑/不可续跑分界线是 S0/S3-min 的核心验收对象。

| 向量 | 触发 | 常量/入口 | 对 run 的效果 | 现有测试 |
| --- | --- | --- | --- | --- |
| A1 delivery no-progress deadline | 无 text/tool 进展 | 120s/240s、硬顶 300s；`delivery-deadline.ts` | abort → 不可续跑 `delivery_failed`（S3-min 改映射） | 部分（缺终态断言与回答后重置） |
| A2 Main no-progress 守卫 | 引擎无事件 15 分钟 | `orchestrator.ts:60`；awaiting-input 时重置而非击杀（:390-397） | `main_no_progress_timeout` | 间接（击杀路径无直接测试） |
| A3 SSE idle | 流 120s 无字节 | `provider-sse.ts:25` | 结构化超时 → 分类重试 | 有 |
| A4 Renderer watchdog | 60s 活性探针 | `runtimeDriver.ts` | 只解锁输入，不杀 Main 活跃 run | 有 |
| A5 stale projection 收尾 | 无句柄卡死 30 分钟 | `stale-projection-finalizer.ts:10` | `interrupted/stale_without_handle` | 无 |
| B1/B2 provider 重试 | transport/可重试状态 | `agent-sdk-provider-request-retry.ts` + model-loop | 有界重试 → 耗尽分类失败 | 有 |
| B3 context overflow | 分类命中 | `agent-sdk-turn-model-loop.ts:482` | 压缩一次否则 error | 部分 |
| B4 missing-tool 恢复 | SDK 工具缺失 | model-loop:503 | 一次提醒重试 | 无 |
| B5 SDK max turns | 内部轮次上限 | model-loop:471 | browser 转 checkpoint，其余失败 | 部分 |
| C1 预算耗尽 | warningLevel exhausted | `run-budget-policy.ts`（research 220） | `checkpoint_budget` 可续跑 | 有 |
| E1 research-incomplete 守卫 | 覆盖不足的终稿 | `agent-sdk-browser-candidate-closure.ts`（2 次停滞） | 续做 → `checkpoint_incomplete` | 有 |
| E2 observation barrier | 未观察的 mutation | `agent-sdk-browser-turn-control.ts` | 强制观察 → `checkpoint_user_input` | 有 |
| E3 browser suspension | 接管/权限/挑战/预算 | `agent-sdk-browser-suspension.ts` | `manual_suspend`/`checkpoint_*` 可续跑 | 有 |
| E4 浏览器工具期限 | 单动作 60s | `browser-action-executor.ts` | 工具级失败，run 继续 | 有 |
| F1 用户停止 | stop | `agent-sdk-runtime.ts:951` | `cancelled_user` | 有 |
| F2 supersede/preempt | 新 send 抢占 | `agent-sdk-turn-closeout.ts:367` | preempted/killed | 有 |
| F3 post-run abort guard | 中止后 settle | `agent-sdk-execution-utils.ts` | 不得报 done | 有 |
| G1/G2 会话关闭/应用退出 | close/quit | `orchestrator.ts:987` / `index.ts:1081` | 进程级终止 → G3 清扫 | 部分 |
| G3 启动 reconciler | 遗留 working/running | `startup-run-reconciler.ts` | interrupted → 可续跑暂停或 blocked | 有 |

分界线：可续跑集合 = `checkpoint_*` / `manual_suspend`（E1/E2/E3/C1 产出）；不可续跑集合 = `delivery_failed` / `cancelled_user` / `main_no_progress_timeout` / `stale_without_handle` / superseded / 分类 provider 失败。S3-min 的使命是把 A1 从后者移入前者（在有 durable child 时）。死代码/半接线清单（S1 一并处置）：`PREEMPT_SETTLE_TIMEOUT_MS` 死导入、`withToolExecutionTimeout` 无调用方、`'navigation'` 信号源未接线、dormant 后台 tab 全家。

## 7. 执行入口

Codex 的启动步骤、命令、红线与汇报合同全部在配套 handoff（唯一执行入口，不在本文重复）：`docs/superpowers/plans/2026-07-22-codex-implementation-handoff.md`。
