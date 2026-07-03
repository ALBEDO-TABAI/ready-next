---
title: Agent Core Experience Roadmap (Target Architecture & Phased Plan)
date: 2026-07-02
status: proposed
enforce: false
source:
  - docs/superpowers/plans/2026-07-02-agent-core-experience-diagnosis.md
  - docs/superpowers/plans/2026-07-01-browser-resource-transaction-reliability-implementation.md（enforce: true，本路线的 P1 子集）
  - docs/superpowers/plans/2026-07-01-browser-agent-lane-decoupling-plan.md（enforce: true，本路线的 P1 子集）
  - docs/superpowers/plans/2026-06-29-web-access-capability-integration-spec.md
  - docs/agent-evolution/00-路线图与目标架构总览.md
---

# Agent 核心体验路线（目标架构与分阶段方案）

> 本文是方案，不是实施合同。按 §10 提交纪律，每个阶段动工前需转为当日
> `*-implementation.md` 合同（可机器验证的完成标准 + gate + verify 入口）。
> 已存在 enforce 合同的部分（7/01 两份）不重立合同，直接归入 P1 执行。

## 0. 一句话战略

诊断结论是"底层机制已建成，缺三段实现/接线和可见面"（2026-07-02 对抗复核后修正：R1 的主因下移到 provider 模型层伪流式、R2 的 learningDecision 是写入端未实现而非闲置、浏览器侧进度反被低估）。路线的形状不是重构，而是：
**先打通首要可见性（P0：真 SSE + 呈现调整），再走完已锁定的（P1，周级），然后把学习回路接上电（P2），最后收架构税（P3）。**
每一阶段独立可验收、独立有用户可感知收益，不存在"要等全部做完才有感"的悬空期。

## 1. 第一性原理：目标体验的可测定义

一个"充分调用工具、准确理解需求、无中断完成任务"的 agent，等价于五个可测量性质。
**这五条应升格为"体验合同"，像稳定性合同一样有断言和回归入口：**

| # | 性质 | 可测定义（验收断言的来源） |
|---|------|--------------------------|
| E1 | 永不静默 | 任意时刻 run 处于可命名状态且 UI 可见；静默窗口（无任何可见变化）≤ 2s（模型生成期）/ ≤ 单步工具时长（工具期） |
| E2 | 完成有证据，失败有出路 | 终态四选一：done+proof / degraded+原因 / blocked+分类+下一步 / checkpoint+可续 handle；**泛化失败卡出现次数 = 0** |
| E3 | 部分进展永不清零 | 62/69 型结果必须以"部分完成+断点"呈现，重试只补失败项（既有合同，升格为体验断言） |
| E4 | 学习可见可控 | 每次知识写入在会话流有一次性提示；staged→active 有一条不进 Settings 也能走完的确认路径 |
| E5 | 观察一次就够 | 浏览器每个动作后返回结构化"变化回执"；同一页面连续 read_page ≥3 次视为回执缺陷（可从 tools.log 回归统计） |

## 2. 目标架构

### 2.1 总图（增量件加 ★，其余为已有）

```
                         用户
                          │
        ┌──────────── 聊天/工作台 UI ─────────────┐
        │ 增量文本渲染(已有)  TaskCard(已有)         │
        │ ★ToolTraceCard 呈现调整（活动流组件已有，   │
        │   调默认态/密度——复核修正：非新建）          │◄─ E1
        │ ★学习提示时刻（"我记住了X"+撤销/确认）      │◄─ E4
        └──────────────────┬───────────────────────┘
                           │ agent:stream / scopeRunEvent（已有通道，先复用；P3 收敛单源）
        ┌──────────────────┴───────────────────────┐
        │ AgentSdkRuntime + turn-orchestrator        │
        │ ★provider 真 SSE（Ready*Model 逐段 delta，  │
        │   替代阻塞整包→单 delta 伪流式）             │◄─ E1 主因
        │ ★技能轮 hold → marker 感知增量放行          │◄─ E1 叠加项(~20%轮)
        │ ★criteria 前置注入（创建时落库+给模型看）    │◄─ E2 源头
        ├────────────────────────────────────────────┤
        │ run-finalizer（窄通道，已有）                │
        │ task-adjudicator（已有）← ★proof 铸造补链：  │
        │   浏览器关键动作/交易成功信号 → 确定性 proof  │◄─ E2/E3
        ├────────────────────────────────────────────┤
        │ 浏览器执行层：分类器/A1/A2/lane（7/01 两合同）│
        │ ★动作回执：每个写动作返回结构化变化摘要       │◄─ E5
        │ web-access W4-W5 收尾（资源→下载→验证闭环）  │
        ├────────────────────────────────────────────┤
        │ 知识层：BeliefCardStore/staged/注入索引(已有) │
        │ ★crystallize gate 接进生产调度（代码已备）    │◄─ E4
        │ ★注入升级：索引→高置信卡片正文直注（预算内）   │
        └────────────────────────────────────────────┘
```

### 2.2 三个架构判断（回答"最佳架构是什么"）

1. **现有合同体系是对的，不要推翻。** 收口 funnel、裁决分离、staged 隔离、gate 文化经本轮证据检验全部成立（误伤已在收敛）。目标架构 = 现架构 + 三段接线，不引入新框架。
2. **事件模型最终应单源，但分两步走。** 现状 `agent:stream`/`scopeRunEvent`/projection 三通道载荷重叠——P0 先复用（改 UI 不改通道），P3 再收敛为单一 run-timeline 事件流（UI 全派生），避免"为了架构纯净推迟用户收益"。
3. **确定性证据优于模型自证。** proof 铸造（发布成功信号、下载校验、文档 diff）必须由代码在动作发生点铸造，模型只负责触发动作——这是把 proof_gap 从"惩罚"变成"导航"的前提，也符合"模型只做判断题"的项目铁律。

## 3. 分阶段方案

### P0 — 打通首要可见性（目标：2-4 天）

**动机**：R1 修复。⚠️ 2026-07-02 对抗复核后优先级重排：主因是 provider 模型层伪流式（覆盖 100% 轮次），hold 开关只是 ~20% 技能轮的叠加项——只改 hold 对常态轮零收益。

| 项 | 改动面 | 说明 |
|----|--------|------|
| **P0-0 真 SSE 流式（第一优先）** | agent-sdk-provider.ts 的 ReadyOpenAICompatibleModel（:381 getStreamedResponse；chat 路径 :305 现状收到 SSE 抛错、responses 路径 :342 显式 stream:false）与 ReadyAnthropicModel（:483） | 三条路径实现真增量：请求体开 stream、逐 SSE chunk 解析并逐段 yield output_text_delta，替代"阻塞取全文→单包 delta"。下游（编排 700ms timed-flush、IPC、renderer 增量渲染）**已就绪无需改动**。逐 provider 灰度（env 开关），失败回退整包路径 |
| P0-1 技能轮 hold 放行 | agent-sdk-turn-orchestrator.ts:1455-1592 | `holdNativeTextUntilFinal`（仅命中含 skill_ask_user 的 ~20% 轮次）从"全扣"改为"ask-user marker 前缀感知"持留；改造前先写"ask 卡文本不得半截泄漏"行为测试钉死回归面 |
| P0-2 活动流呈现调整 | TaskCard.tsx:749-855 ToolTraceCard + ChatMessages.tsx:406-528 全局胶囊 | **组件已存在**（对抗复核修正：初版误判为缺失）——改呈现：运行中默认展开最近 N 条（收起态显最新一条+计数）、加每条耗时、完成后自动收起；不新建消费者、不进正文消息 |
| P0-3 首事件前心跳 | ipc-handler.ts 运行事件 | run 开始→首个可见事件之间发 phase 心跳（"正在理解/正在组装上下文/正在调用模型"）；text-bridge（仅 fox provider，非当前配置）作为无流式兜底一并覆盖 |
| P0-4 proof_gap 看板 | 复用 run_close/divergence 指标 | proof_gap **按日占比**（不是绝对数）、divergence 率、首 token 延迟做成 debug 面板一页，收敛趋势可持续观测 |

**验收**：真实 dev 下首 token 可见 < 2s 且逐段增长（P0-0 后）；技能轮 ask 卡回归测试绿；一次多工具 run 期间活动行逐条可见；`verify:stability` 不回退。
**不做**：不动 IPC 通道结构；不做卡片视觉重设计（信息先于美学）。

### P1 — 走完已锁定的浏览器可靠性（目标：1-2 周）

**动机**：两份 enforce 合同已锁方向且 60-70% 落地，剩余项就是 XHS 发布失败链的残余敞口。

内容 = 既有合同的剩余项（07-02 对抗复核后按真实进度重标），不新增发明：

1. **A1 补全（复核降级后的头号残项）**：结构化失败输出当前仅 browser_power_eval 1/4 部分落地（缺 tabId/origin、hint 未按 4 类差异化、0 测试）；补齐 `browser_power_cdp`（现状 7632 抛错落外层 8293-8303 泛化字符串）、network_trace、resource_forensics 的 catch 分支 + 差异化 nextSuggestedAction + 焦点测试;
2. `2026-07-01-browser-resource-transaction-reliability-implementation.md` 剩余：V0 复测（重启现源实走 XHS 发布全链——`browser_transaction_unconfirmed` 生产 0 次发生，机制未经过实战）、Phase B（拖拽视觉分析前后端同源）、Phase D（站点卡按活动 tab 域名匹配）、Phase 3C 三边界收口（note_collect 传 targetQuality、customScript 路径接 structureFor、质量判据泛化到非小红书账号页）;
3. lane 解耦收尾：Phase 2/4/6 已在 WIP 基本成形（verify:browser-lane 38 pass），剩 **Phase 5（popup 归属跟随 lane）** + 真机回归确认 `lease_held` 类失败清零;
4. web-access W5 验证闭环：下载路径已落地；补媒体验证（存在+字节阈值+可选 ffprobe）——**先改 browser-tool-catalog.ts:334 的工具描述**（当前宣称了不存在的 ffprobe 校验，描述先于实现是诚实性缺陷），实现落地后再恢复描述;
5. **★P1-新增一项（本路线唯一新增的浏览器工程）——动作回执（E5）**：`browser_click*/type*/navigate` 等写动作的返回值附加结构化变化摘要（URL 变化/焦点元素/可见 toast/新增节点计数，代码铸造），并在同一回执里铸造相应 proof（如发布成功页信号 → `transaction_confirmed`）。这一项需并入可靠性合同的修订版或单独立合同。

**验收**：三个 XHS 真机回归（发布到编辑器或可续状态、拖拽出视觉分析、账号采集冻结真实笔记）；`card_loop` 完成率显著抬升（账本可查）；`lease_held` 类失败 = 0；四个 Power 工具失败输出结构化测试全绿；`verify:browser-reliability` + `verify:browser-lane` + `verify:native` + `verify:stability` 绿。

**P1 落地状态（2026-07-03，工作区未提交，待真机回归）**：
- A1 补全 ✅：四 Power 工具（eval/cdp/network_trace/resource_forensics）全部结构化失败输出 + 4 类差异化 hint + tabId/origin（`browser-power-failure.ts` + 6 测试）；
- 采集三边界 ✅：note_collect 传 targetQuality（handoff plan 透传）+ 完成规则不吞污染列表；customScript 缺结构上下文永远留痕；质量判据去 XHS 门控、结构信号泛化到任意站点（+4 通用站点测试）；
- Phase D ✅：站点卡按活动 tab 域名匹配（`getActiveBrowserUrl` 注入 PromptAssembly，+3 测试）；
- Phase B ✅（WIP 已完成，本轮核实）：拖拽视觉分析前后端同源共享 `canAttemptVisualAnalysis`，单源 gate 覆盖两端；
- lane Phase 2/4/5/6 ✅（WIP 已完成，本轮核实）：默认 agent-view、supervision 接前台 workflow、popup 继承 agent 归属并更新 boundTabId、verify:browser-lane 38 pass；
- W5 ✅：媒体下载真字节校验（`media-verification.ts`，文件存在+非空才算完成）+ 去掉工具描述里未实现的 ffprobe 声明（+5 测试）；
- 动作回执（E5，新增合同 `2026-07-03-browser-action-receipt-implementation.md`）✅：click/click_text/type 附结构化变化回执（url/焦点/toast）+7 测试。
- 验证：typecheck 绿、verify:browser-reliability 104/0、verify:browser-lane 38/0、verify:streaming 仅 3 个改造前既有失败、verify:stability EXIT=0。

### P2 — 学习回路接上电（目标：2 周）

**动机**：R2 的四个断点各自修复量都不大，合起来把"成长性"从 0 拉到可观测。

| 项 | 改动面 | 说明 |
|----|--------|------|
| P2-1 crystallize 接线 | 生产调度（启动后 + 空闲钩子）调 decideCrystallizeRun | 门控代码已备（6h/20turns/学习信号），只差驱动；skip 也留痕。晋升"二次信号"通道随之激活 |
| P2-2 criteria 前置 | 任务创建时按模板**落库 criteria_json** 并注入模型可见面 | 把裁决从"事后打回"变"事中自检清单"。复核红利：daily-task-index 的 criteriaProgress 渲染是**现成消费者**（daily-task-index-builder.ts:30/65/91，现因列恒空而恒 null）——落库即点亮 |
| P2-3 学习提示时刻 | run 收口若产生 staged 卡/学习建议 → 会话流一次性系统提示（内容+确认/撤销/稍后） | E4 的推式面；Settings 面板保留为管理面。遵守"每 turn 最多一次、可关闭"的降噪原则 |
| P2-4 注入升级 + 使用度量通道 | prompt-assembly 知识索引 → 高置信 active 卡正文直注（预算内、context_bill 记账）；同时补 belief 使用计数通道 | 终结"一行索引、正文零拉取"（memory_read_card 0 次）；复核修正：**access_count 对 belief 行结构性不可达**，须先建计数通道（直注命中/读卡调用计数）否则任何"使用率"验收都无法度量 |
| P2-5 learningDecision 写入端实现 | CheckIn 组装处新增字段 + learningRefs 写入者 + finalizer 传 learningRefsValid | 复核升级：这不是"激活闲置通道"而是**从零补写入端**（字段全仓零出现）；同时排查进化提案读端三道前置闸（checkin_not_accept/terminal_status/missing_owner 拦下了全部 33 次）的放行条件是否过紧 |
| P2-6 衰减与归档修正 | belief-decay 接线（传递性未接线，指标 0 次）；**修 archiveOldL2Memories 定时雷** | memory-lifecycle.ts:140-161 按 l2 全查不排除 belief 类，调度器已启动（runtime.ts:723）——卡龄到 90 天会把信念卡镜像行归档掉，需显式排除或按 category 分策略 |

**验收**：跑一周真实使用后账本断言——staged 卡产生 ≥N、晋升事件 ≥1、belief 正文拉取或直注命中 > 0（经 P2-4 新通道度量，**不用 access_count 旧口径**）、learningDecision 非零；`verify:evolution-p1/p3/p4` 不回退；新增 crystallize 行为测试进 verify 链。

### P3 — 架构收口与性能（目标：2-4 周，可与 P2 部分并行）

1. **dormant 双运行时退役**：按 P6f 边界推进 TurnEngine/DirectChat 删除（C29/C30/C31 序列），消除双路径维护税;
2. **巨文件拆分续期**：browser-tools.ts(~5.8k)、turn-orchestrator(~2.4k)、Settings.tsx(~3.5k) 按既有 V3 拆分方法论分阶段（每步 typecheck+焦点测试绿）;
3. **run-timeline 事件单源**：定义单一运行时间线事件模型（turn/文本/工具/状态/收口），`agent:stream` 与 `scopeRunEvent` 收敛为其投影，renderer 全部派生——P0 的体验修复此时获得架构级地基；配 gate 防新增旁路事件通道;
4. **性能整固**：流式放行后测量首 token 延迟基线；context_bill 加注入预算回归断言；浏览器观察面以"page map+回执"替代截图/read_page 轮询（E5 的度量随 tools.log 回归统计）。

**验收**：`verify:*` 全家绿 + 双运行时代码删除 diff + 事件单源 gate + E1-E5 体验断言首次全量跑通。

## 4. 可维护性与性能原则（沉淀为长期规则）

1. **体验也要合同化**：E1-E5 进入回归资产（部分为自动断言，部分为 tools.log/账本统计脚本），防止体验回退像功能回退一样静默;
2. **接线优先于新建**：本轮四根因全部是"机制在、接线缺"——未来任何"做个新系统"的提案先问"已有件为什么没接上";
3. **确定性证据优先**：proof 由代码在动作点铸造；模型自证只允许作为 digest 级兜底;
4. **可见性预算**：注入走 context_bill、UI 走"每 turn 最多一次主动提示"、日志走既有轮转——所有新增可见面都带上限与关闭开关;
5. **巨文件是速度税**：新增代码落到拆分后的窄模块；触碰 >2k 行文件的工单默认附带"顺路拆出所改区域"的子任务（手术式，不顺手重构无关区）。

## 5. 与既有文档的关系

- 7/01 两份 enforce 合同：**本路线不修改其条款**，P1 是其执行排期 + 一项新增（动作回执）需按合同修订流程并入;
- 6/29 web-access 规格：W1-W3 已落地（诊断 §6.1），P1 覆盖 W4-W5，W6-W8 顺延不阻塞;
- agent-evolution 00 路线图：P2 相当于其"阶段二知识与质量闭环"的接线补课 + "阶段四站点卡学习回路"的前置；不改变其阶段间依赖;
- 稳定性合同：全程为硬边界，任何阶段不得新增旁路终态/旁路事件写入。

## 6. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 流式放行泄漏 ask-user/工具标记半截文本 | 改造前行为测试钉死；marker 前缀持留；灰度开关（env）保留一键回退 |
| criteria 前置注入抬高 token 成本 | 模板判据 ≤3 条/任务；direct_answer 零判据豁免保留；context_bill 断言注入增量上限 |
| 学习提示打扰用户 | 每 turn ≤1 条、聚合展示、全局开关（沿用 00 §5.9 主动性原则） |
| P1 真机回归依赖登录态/站点变化 | 沿用 V0 纪律：重启现源、记录 commit、失败先判 stale；站点改版损坏项降级为分类器规则更新而非临时补丁 |
| 双运行时退役牵连隐性依赖 | 沿用 P6 系列的 island/gate 渐进法，每步独立可回滚 |

## 7. 不做清单

- 不重写聊天 UI 框架、不引入新状态管理;
- 不新建第二套知识存储或第三个站点策略层（7/01 合同红线）;
- 不外接浏览器/不恢复自由脚本面（Power 合同边界不动）;
- 不做 per-agent 模型路由、跨 agent 消息总线（00 §6 不做清单继承）;
- 不追求"一步到位事件单源"而推迟 P0 体验修复。
