---
title: Agent Core Experience Diagnosis (Four Pain Points)
date: 2026-07-02
status: diagnosis
enforce: false
source:
  - /Users/user/Library/Application Support/ready/ready.db（只读查询，318 runs / 517 task_projections / 101 browser_tasks / 164 memory rows）
  - <tmpdir>/ready-agent-metrics.log、ready-tools.log、ready-directchat.log、ready-browser.log
  - 工作区代码（feature/vertical-tabs，含 51 文件未提交 WIP，工作区状态视为当前真相）
  - docs/superpowers/plans/2026-07-01-browser-resource-transaction-reliability-{diagnosis,implementation}.md
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-07-01-browser-agent-lane-decoupling-plan.md
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-06-29-web-access-capability-integration-spec.md
  - docs/agent-evolution/00、02、07
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Agent 核心体验诊断（四痛点）

## 0. 结论摘要

四个痛点收敛为**四个结构性根因**，全部有"数据库/日志数字 + 代码 file:line"双证据，置信级别标注在各节。

| # | 根因 | 一句话 | 置信 |
|---|------|--------|------|
| R1 | 可见性断层 | 文本"流式"在 provider 模型层是**伪流式**——阻塞取回全文后当单个 delta 发出（仅字面 `openai` provider 真流式），下游整条链路都在等一个永远最后才来的包；hold-until-final 只是 ~20% 技能授权轮的叠加项；工具活动流其实**已有逐条渲染组件**（ToolTraceCard），残余问题是默认收起、只显最新一行 | 确认（2026-07-02 对抗复核修正版） |
| R2 | 学习回路断链 | 写入侧涓涓细流、**固化引擎（crystallize）未接线**（10 个导出零生产调用方）、注入侧每卡只给一行索引且正文**零次被拉取**（memory_read_card 0 次调用）、执行学习决策 **learningDecision 写入端根本未实现**（`src/` 全仓零出现，repo 列在等一个不存在的写入者） | 确认（对抗复核强化版） |
| R3 | 完成语义与执行能力错位 | 裁决层 6/18 上线后，**全部 run 的 30% 以 proof_gap 终结**（117/151 个 error 是"模型宣告完成被打回"）；初期大半是裁决侧误伤（证据未先落、task_type 三源竞态），WIP 已修一部分，但浏览器执行侧的真实证据链（采集 card_loop 完成率 7.7%）仍是硬缺口 | 确认 |
| R4 | 规模与双运行时惯性 | dormant TurnEngine/DirectChat 未退役、browser-tools.ts ~5.8k 行、turn-orchestrator ~2.4k 行——不直接制造故障，但每轮修复都在为它付税 | 确认（影响度为推断） |

对"浏览器能力差是上游模型还是本地工程"的回答：**证据指向本地工程为主因、模型能力为放大器**（§5.4）。在 A1/A2/P2/lane 解耦/web-access W4-W5 完成之前，无法公平评测模型上限。

## 1. 前因后果（这套系统是怎么走到今天的）

1. **2026-06-10 稳定性收口**：25 工单建立了 run 终态唯一收口（run-finalizer funnel）、事件桥、采集判决单源等六大合同。此时"完成"仍以模型宣告为准。
2. **2026-06-11~13 进化阶段一/三/四**：信念卡/staged 隔离区/专项 agent/维护回合/站点卡学习的**数据模型和写路径**建成。但按 03 篇分期原则，维护回合（crystallize）排在后置——代码建好后**未接进生产驱动**（`crystallize-gate.ts:1` 头注明确写着 "P5d/C26 unwired: not in production driver path"）。
3. **2026-06-18~21 质量框架（EP2-Q 系列）enforce 上线**："完成必须被证明"开始在收口通道强制执行。**proof_gap 从 6/18 首次出现，6/20 单日 23 起**——裁决层把过去"默默假完成"的 run 全部翻了出来，其中混着大量误伤（response digest 证据未在裁决前落库、task_type 在 projection/budget/patch 三源间竞态）。
4. **2026-06-24 起逐步修复**：G0（digest 先落再裁决）、P0-3（有效 task facts 终态 patch 优先）、P1（有证据的 degraded 默认保持 done）、P2（proof_gap 与 adjudication_degraded 分流）陆续进入分支，proof_gap 占当日 run 比例从峰值 74% 降至 20-45% 区间波动，**下降但未稳定、未归零**（详见 §3.1 归一化日线）。
5. **2026-06-29~07-01 浏览器三连**：web-access 集成规格（W0-W8）、Power Browser 授权、资源事务可靠性诊断+实施合同、lane 解耦计划。当前 WIP（51 文件未提交）正在落地其中的 A1/A2/P2/lane Phase1-3。
6. **今天（07-02）**：四痛点是以上历史的叠加态——可见性从未被立项（无任何流式/状态设计文档，全仓 grep 证实）；学习回路建成但断链；浏览器可靠性正在半途；proof_gap 收敛中但语义仍未跑通全链。

## 2. 调查方法与证据源

按 ready-debug 优先级顺序取证：**数据库健康 → run 生命周期账本 → 工具日志 → 浏览器日志 → 代码链路 → WIP 核对**。四类证据源交叉：

1. `ready.db` 只读 SQL（318 runs、517 task_projections、101 browser_tasks、164 memory rows）；
2. 四份运行日志（metrics/tools/directchat/browser，均新鲜至 07-01/07-02）；
3. 代码一手直读（流式链路、收口通道、裁决器、注入组装、门控各 file:line 见下）；
4. 既有诊断/合同文档（7/01 三份、6/29 规格、agent-evolution 系列）。

> 注意事项（继承 7/01 诊断的教训）：历史日志里可能混有 stale process 的假信号；本文所有"当前行为"结论均以工作区代码为准，凡依赖运行时行为且未实测的均标"待验证"。

## 3. 全局证据基线（原始数字）

### 3.1 run 终态分布（run_meta，全量 318）

```
done/done                125   (39.3%)
error/proof_gap           95   (29.9%)  ← 最近 14 天占 92
error/adjudication_degraded 20 + done/adjudication_degraded 18   (12.0%)
error/blocked_external    20
cancelled/cancelled_user  15
error/blocked_tool_error   6
checkpoint/checkpoint_steered 5 + checkpoint_budget 2
error/blocked_config 5、persistence_failed 3、delivery_failed 2
interrupted/main_process_restarted 2
```

- **error 合计 151（47.5%）**；其中 initiator='done' 的 117 个——即"模型宣告完成→裁决打回"是 error 的主形态。
- proof_gap 按 task_type：multi_step_task 67、short_task 26、direct_answer 2；**没有一条 browser_transaction**——发布类任务死的时候身份已经丢了（与 7/01 诊断的 task_type 丢失一致）。
- proof_gap 日线（**按当日 run 总量归一化**，2026-07-02 复核修正）：6/18=6/20(30%)、6/20=23/31(**74%**)、6/22=16/34(47%)、6/23=11/22(50%)、6/24=17/41(41%)、6/25=**0/20(0%)**、6/27=1/12(8%)、6/29=5/11(45%)、6/30=6/26(23%)、7/01=4/6(67%，n 小且含 XHS 交易测试)。**峰值期与裁决 enforce 上线重合；此后占比下降但噪声大、未稳定**——G0/P0-3/P1/P2 修复与占比下降在时间上一致，但 6/25 全零与 7/01 反弹说明"已收敛"不成立，只能说"在收敛中"。

### 3.2 浏览器任务（browser_tasks，101）

```
visible_collect  38 完成 / 14 失败 /  4 取消   （完成率 68%）
card_loop         3 完成 / 21 失败 / 13 取消 / 1 paused / 1 waiting_human （完成率 7.7%）
note_collect      3 完成 /  2 失败 /  1 取消
```

失败 error 字段的形态（每条都是一个结构性问题的**化石**——07-02 复核确认 37 条 failed 全部早于当前 WIP，其中 62/69 三条均为 06-06，早于 S3-1 修复）：

- `expected 69, collected 62, failed 7, stopReason completed` 仍记 **failed** ×3（62/69 的部分成功被塌缩成失败——"失败路径塌缩"的历史直接证据；**该形态已被 06-10 提交的 S3-1 修复**：同输入现走 note_collect → status='paused'/keepCursor=true/对外 'partial'，collection-verdict-matrix.test.ts:219-232 精确重放该输入断言 paused、实跑绿）；
- `expected 69, collected 0~1, failed 3~4, stopReason too_many_failures` ×7+（污染目标列表逐项深访逐项死——7/01 诊断"185 条导航链接"场景的账本面）；
- `could not acquire user-view lease: lease_held` ×5（agent 与用户抢同一写入锁——lane 未解耦的直接证据）;
- `could not navigate agent tab: tab-5` ×2（tab 绑定丢失）。

### 3.3 知识/学习系统真实状态

| 项 | 数字 | 含义 |
|----|------|------|
| task_projections.criteria_json | **0/517** | 裁决判据从未落库（只在裁决瞬间内存计算），模型执行中看不到"完成标准"。唯一例外：active-plan-step-reminder.ts:216/223 注入步级弱判据（advanceOnTools），与裁决判据集不相交。daily-task-index 里已有 criteriaProgress 消费者（daily-task-index-builder.ts:30/65/91），因本列恒空而恒为 null |
| task_projections.learning_refs_json | **0/517** | 复核升级：`learningDecision` 在 `src/` 实现里**零出现**——不是"通道闲置"而是**写入端未实现**（repo 列/序列化在 task-projection-repository.ts:276/364，无任何写入者；finalizer 也不传 learningRefsValid）。读端 specialist 进化提案 33 次全部死在更早的闸：checkin_not_accept 18 / terminal_status 12 / missing_owner 3 |
| task_projections.checkins_json / proof_refs_json | 280 / 297 | 裁决与证据采集本身在真实运转 |
| agent_memory_metadata：belief 类 14 张 | access_count 合计 0（**此数字本身不具证明力**：递增仅存在于 prompt-assembly 三条注入路径 :616/:769/:849，belief 镜像行结构性够不到；memory_read_card / memory_search 均不计数，access_log 表 0 行） | 行为侧证据支持同向结论：`memory_read_card` 在 tools.log 全程 **0 次调用**——卡片正文从未被主动拉取（title+description 每轮经索引可见） |
| agent_memory_metadata：summary 类 149 张 | access 460 次 | 会话摘要经注入路径被正常使用（460 只证明注入路径计数在工作，**不构成 belief 行的对照组**——见上行） |
| staged 卡现存 | 1 张 | 隔离区几乎空转 |
| browser_site_experience 表 | **0 行** | 站点经验结构化存储：读侧已接（browser-domain-orchestrator.ts:547 queryHints），**写侧无一调用方**（全仓仅 store 自身的 INSERT） |
| run_feedback 表 | 0 行 | 用户反馈回路无数据 |
| reflection_outcome 指标 | 15 次 | 反思账本在发（写侧活着，量级小） |
| specialist_task_evolution_proposal 指标 | 33 次 | 专项 agent 进化提案在产生 |
| crystallize 维护回合 | **无生产调用方** | `crystallize-gate.ts:1` 自注 "P5d/C26 unwired"；`decideCrystallizeRun` 无 maintenance/ 目录外调用者 |

文件侧（agent-memory/）：3 个专项 agent（copywriter/analyst/video-editor）RULES/FOUNDATION/knowledge 齐备，routing 卡 3 张，站点卡 sites/www.xiaohongshu.com.md 存在，memory/ 日记 ~45 天。**落盘层是健康的，死的是"流转"。**

### 3.4 工具与运行行为谱（ready-tools.log，2158 次浏览器工具调用）

```
browser_read_page 378   extract_structured 247   get_tabs 213
wait 188 + wait_for_condition 180                collect_images 188
click_text 183          go_back 173              download_urls 173
power_cdp 40            power_eval 21            inspect_resources 4
```

观察类+等待类 ≈ 1000 次，动作类（click/type/navigate）≈ 250 次——**模型把大部分预算花在"看清楚现在是什么状态"上**，这是观察面弱（每步动作后无结构化回执）迫使的行为模式，不是模型偏好。

### 3.5 其他有信息量的指标

- `agent_sdk_auto_context_compacted` 121 次：压缩频繁，长任务上下文压力真实存在；
- `context_bill` 70 次：注入账单已接线（X4 落地）；
- `runtime_auto_recovered_undelivered_answer` 9 次：答案未送达自恢复在工作；
- directchat.log 一次 12.5 分钟 run 以 `Database not available` 失败（07-01 09:14）：基础设施类中断存在但少见；
- `pending_confirmations` 现存 4 行：确认闸门等待也是一类用户可见"卡住"。

## 4. 痛点一：聊天面板无流式、无及时工作状态（R1，确认）

> ⚠️ 本节为 2026-07-02 当日对抗复核后的**修正版**。初版把主因归给 hold-until-final 开关，
> 复核证明那只是 ~20% 技能轮的叠加项，真正主因在 provider 模型层的伪流式。修正记录见 §8。

### 4.1 机制链路（全部 file:line 一手核实 + 对抗复核）

```
SDK 调用层     agent-sdk-provider.ts:113-151
               runner.run(..., {stream:true}) → output_text_delta → onTextDelta   ✅ 管道存在
     ↓
provider 模型层 ← ❌❌ 真正的主因在这里（100% 轮次受影响）
               ReadyOpenAICompatibleModel.getStreamedResponse (:381)：阻塞整包 HTTP
               （responses 路径 :342 显式 stream:false；chat 路径收到 SSE 直接抛错），
               取回全文后作为【单个 delta】一次性发出；
               ReadyAnthropicModel.getStreamedResponse (:483) 同为伪流式；
               仅字面 provider==='openai' 走真流式 SDK（:225-233）。
               用户真实配置（openai-compatible + anthropic 协议）全部命中伪流式。
     ↓
编排层         agent-sdk-turn-orchestrator.ts:1581-1592   ← ❌ 叠加项（约 20% 轮次）
               普通会话轮走 timed-flush（700ms 定时器 + marker/4000 字符分段，
               NATIVE_TEXT_BUFFER_TIMED_FLUSH_MS=700 @ :302；agent-sdk-utils.ts:111-145）；
               仅技能授权轮（allowedToolNames 含 skill_ask_user）命中 hold-until-final，
               文本压到 :1774 才放。
     ↓
IPC / preload / renderer   ipc-handler.ts:1391 → preload:314-317 → runtimeDriver:868-962
               → useAgent.ts 写 state.messages → ChatMessages 渲染            ✅ 全链真实可用
```

三个开关的赋值与**真实覆盖面**（对抗复核修正）：

1. `useTextToolBridge = capabilities?.toolCallTransport === 'text'`（:718）——命中面仅 `fox`（NewCLI Codex 类）provider（ai-providers.ts:497-505），**不是当前用户配置**，降级为边缘场景；
2. `bufferNativeTextUntilParsed = !useTextToolBridge && toolDefinitions.length > 0`（:1455-1457）——常态成立，走 700ms 分段 flush（本身可用）；
3. `holdNativeTextUntilFinal = bufferNative && allowedToolNames.includes('skill_ask_user')`（:1458-1460）——**并非常态**：普通会话轮经 `buildExplicitNoSkillAuthorization('no_skill_signal')`（agent-sdk-runtime.ts:1014-1016）剥掉全部 `skill_*` 工具（skill-tool-authorization.ts:206-211）；ready-tools.log 实测 35 轮中 28 轮（80%）无 skill_ask_user、7 轮（20%）有。

**因此"用户从未见过流式"的完整解释是：** 100% 轮次的文本在模型完整生成后才以单个整包 delta 到达编排层（伪流式），普通轮的 timed-flush 只能把"整条消息"一次放出；20% 技能轮再叠加 hold 扣到 run 末。只改 hold 策略对 80% 常态轮**零收益**——第一优先修复是 Ready*Model.getStreamedResponse 实现真 SSE。

### 4.2 工作状态链路：活动流已存在，问题是呈现密度（对抗复核修正）

初版声称"toolEvent 只被折叠成计数器、聊天区无逐条消费者"——**该结论被证伪**，实际链路：

- 工具事件逐条产生：agent-sdk-tool-executor.ts:759-797 每次工具调用/结果各发一条 → ipc-handler.ts:1397-1465 发 `agent:scopeRunEvent`（带 toolEvent）；
- renderer 双路消费：scopeRunState.ts:1076-1083 计数器（初版只看到了这条）+ **runtimeDriver.ts:1632-1643 逐条 append 进 `toolTrace`**；
- 聊天区逐条渲染真实存在：`ToolTraceCard`（TaskCard.tsx:749-855，**收起态只显最新一条事件、展开态 events.map 逐条**），挂载于 pendingToolTrace / live-tool / per-message snapshot（TaskToolSnapshot.tsx:293-363），无任务时还有全局胶囊（ChatMessages.tsx:406-528）。

**残余的真问题**：默认收起 + 只见最新一行 + 文本期无任何输出（4.1 伪流式）共同构成"没有及时工作状态"的体感；以及 run 开始 → 首个事件之间的静默段（意图分类+组装+首次模型调用无心跳）。directchat.log 实测一轮普通 sendScoped start→done 84 秒。

### 4.3 结论（修正版）

- 修复优先级重排：**(a) provider 模型层实现真 SSE 流式（主因，覆盖 100% 轮次）；(b) 技能轮 hold 改 marker 感知增量放行（叠加项，覆盖 ~20%）；(c) ToolTraceCard 的默认态/密度调整（组件已在，调呈现而非新建）；(d) 首事件前心跳。** text-bridge 心跳兜底降级为 fox-only 边缘项。
- 卡片占比/分布问题（任务卡、工具卡大小）是真实的但次级——先把"有东西可看"解决，再调"看起来舒不舒服"（那属于 UI 规范迭代，参照 workbench 极简基准）。

## 5. 痛点二：知识/经验/记忆更新不透明、成长性存疑（R2，确认）

### 5.1 回路五跳逐跳状态

| 跳 | 设计（01/03/06 篇） | 实际状态 | 证据 |
|----|--------------------|----------|------|
| ① 采集 | reflection、CheckIn learningDecision、站点卡学习、涌现候选 | **半活**：reflection_outcome 15 次、evolution_proposal 33 次、learnFromCheckIn 已接线（turn-orchestrator 6 处）；但 learningDecision **写入端未实现**（全仓零出现），且进化提案读端 33 次全部死在 checkin_not_accept/terminal_status/missing_owner 三道前置闸 | metrics + 全仓 grep（07-02 复核） |
| ② 固化（staged→active） | crystallize 维护回合：过期/去重/索引/二次信号晋升 | **死**：unwired（crystallize-gate.ts:1 自注 + 全部导出无 maintenance/ 外调用方）；晋升只剩 Settings 手动面板一条通道。nuance：cas-merge 子件（用户画像合并）**已接线**（runtime.ts:133 runUserPictureCasMerge），死的是回合主体 | 代码头注 + grep（07-02 复核） |
| ③ 注入 | L1.5 知识索引 + per-agent RULES/knowledge + routing 卡 | **半活**：索引注入在跑（prompt-assembly.ts:1100-1135，active 卡、字符上限），形态为每卡一行 `title（confidence）: description → relPath`（belief-card-store.ts:339），**无正文**；正文唯一入口 memory_read_card（memory-tools.ts:416-432）**0 次被调用**——索引给了一行，模型从不翻卡 | SQL + 代码 + tools.log |
| ④ 观测 | 设置页知识面板、reflection_outcome 账本 | **半活**：BeliefCardsPanel 已接 Settings.tsx:2672-2738（拉式，用户要主动去看）；**没有任何推式"我学到了 X"时刻** | 代码 |
| ⑤ 衰减/反馈 | belief-decay、访问计数、run_feedback | **死/空转 + 一颗定时雷**：belief-decay 传递性未接线（唯一调用链经未接线的维护回合；belief_decay 指标 0 次）；run_feedback 0 行；**潜在 bug**：archiveOldL2Memories（memory-lifecycle.ts:140-161，调度器已启动 runtime.ts:723）按 l2 全查**不排除 belief 类**——目前只因卡龄未到 90 天而无害，到期会把信念卡镜像行归档掉 | SQL + 代码（07-02 复核） |

### 5.2 因果排序（为什么"感觉不成长"）

1. **固化引擎未接线是第一因**：staged 隔离区设计要求"落盘不丢观察、注入须晋升"，但晋升的自动通道（维护回合二次信号）不存在 → staged 永远 staged（现存 1 张）→ 用户没有确认时刻 → 注入面永远只有出厂知识。复核补强：现存 13 张 active 卡**全部是 builtin 种子**，晋升事件历史为 0；BeliefCardsPanel 之外还有两条手动通道（systemStudio confirmContentEdit 采纳即 active、派生勾选 activateRouting），同样从未产生过晋升；
2. **执行→学习的入口不是"没触发"而是"没建成"**：learningDecision 字段在实现里不存在（设计有、代码无），criteria 也从未注入模型可见面——即使明天模型想学，也没有落笔的地方；补上写入端后还有第二道坎：进化提案读端的三道前置闸（checkin_not_accept/terminal_status/missing_owner）目前拦下了全部 33 次；
3. **注入是"一行索引不是知识"**：模型每轮看到每卡一行的标题+描述，正文需 memory_read_card 拉取，实际 0 次发生——学了也等于没学（注意：不能用 access_count=0 论证此点，该计数对 belief 行结构性不可达；论据是 tools.log 的 0 次调用）；
4. **一切都不可见**：以上三条断链没有任何用户可感知的症状，只有 Settings 深处一个面板——所以体感是"不透明、不知道它学没学"。

> 修正一个可能的误判：知识系统的**落盘层与读路径本身是好的**（summary 类 460 次访问、专项 agent RULES/知识文件齐备、站点卡在注入）。断的是"经验流转"，不是"存储"。

## 6. 痛点三：浏览器能力不理想、发布类任务反复中断（R3 浏览器面，确认）

7/01 两份文档已把根因钉死（两共享根因：无统一资源分类器、失败路径塌缩状态），本轮不重复论证，只交付**实现核对**与**剩余失败链**。

### 6.1 既有计划落地核对（工作区 WIP 一手核实）

| 计划项 | 状态 | 证据 |
|--------|------|------|
| A1 Power 工具结构化失败输出（保留 tab/URL/frame/nextSuggestedAction/Session patch） | ◐ **仅 1/4 工具部分落地**（07-02 对抗复核降级） | 仅 browser_power_eval 有结构化失败 catch（browser-tools.ts:7564-7599，且缺 tabId/origin、hint 未按 4 类差异化、0 测试）；**browser_power_cdp 无 catch**（7632 抛错落外层 8293-8303 → `Error executing browser_power_cdp:` 泛化字符串——正是 A1 要消灭的形态）；network_trace/forensics 同样无 catch |
| A2 browser_transaction 终态连续性（unconfirmed 而非 proof_gap） | ✅ 已落地 | run-finalizer.ts:440-448、496-501 |
| P0-3 有效 task facts（终态 patch > projection 行 > budget） | ✅ 已落地 | run-finalizer.ts:394-428 |
| P2-1 共享分类器 src/shared/browser-tab-resource-classifier.ts | ✅ 已建（07-01） | 文件存在 5.6KB |
| Phase 3C 污染目标列表判决 | ✅ 已落地（带三条边界） | 真链路非仅类型：capability-service.ts:186-203 structureFor（nav/aside/header/main 祖先）→ 三模板 rawFields.structure → deriveCollectionTargets 消费（collection-targets.ts:119-127、219-225）→ assessCollectionTargets 赋 targetQuality（:372-422）→ resolveCollectionVerdict（content-task-runner.ts:1348）。边界：质量判据以小红书账号页为前置；note_collect 调用（:1565）不传 targetQuality；customScript 路径绕过 structureFor |
| 单源 gate ×2 | ✅ 新增未提交 | scripts/check-browser-resource-classifier-single-source.cjs、check-browser-agent-lane-bound-target.cjs |
| lane 解耦 Phase 1/2/3/4/6 | ✅ **基本成形于 WIP**（07-02 对抗复核**上调**——初版低估） | boundTabId+tab_id 自动补齐（browser-agent-runner.ts:291-296、363-373）；前台 workflow 真实默认已翻转 agent-view（runner:2526、ipc-handler:1190；binding:109 的 `?? 'user-view'` 只是 fallback）；不再改用户 active tab 的 owner（4 处 owner:'agent' 写点均限新建/agent-lane/agent popup）；supervision 已接前台 workflow（ipc-supervision.ts:94-105）；agent tab 输入冻结已接（ipc-handler:1292-1304）；`verify:browser-lane` 已建且实跑 38 pass。**Phase 5（popup 归属）待核** |
| web-access W1 header-correct 下载 | ✅ 已落地 | download-service.ts:16,36-43,97（Referer 白名单） |
| web-access W2 CDP session + 网络观察 | ✅ 文件已建 | cdp-session-service.ts、network-observer-service.ts、resource-sniffer.ts |
| web-access W3 browser_inspect_resources | ✅ 已上线 | 工具日志 4 次真实调用 |
| web-access W4（resolve_video 接嗅探） | ✅ 基本落地（07-02 复核上调） | 嗅探候选优先（browser-tools.ts:6826-6857，已提交）+ Douyin 策略（fastcard-video-resolver 9 处）+ 候选下载走 downloadHeaders/Referer（2260-2268 → ipc-handler:2423 → download-service:173） |
| web-access W5（下载验证闭环） | ◐ **下载已落地、验证未动工** | 无媒体验证服务（grep 空）、无字节阈值；verification 块是自白占位（browser-tools.ts:7888-7894 "ffprobe integration can promote this…"）；**工具描述已宣称 ffprobe 校验（browser-tool-catalog.ts:334）先于实现——描述≠落地，须先改描述或补实现** |
| 7/01 实施 Phase B/D（拖拽视觉分析、站点卡按 tab 域名匹配） | ◐ 未核 | 待验证 |

**这意味着：7/01 锁定的方案方向被本轮证据完全支持，且已走完约 60-70%。** 剩余失败链敞口：

### 6.2 当前仍开放的失败链（发布一篇小红书笔记）

```
任务进入 → 意图/预算分类           【A2+P0-3 后改善；分类首帧正确性待 V0-2 实测】
  → lane 绑定 agent tab            【boundTabId 已有；surface 默认 user-view 未翻转 → 仍可能与用户抢 lease（账本可见 lease_held ×5）】
  → 编辑器交互（点写长文/传图/富文本）【A1 后失败保状态；但隐藏/折叠态节流问题（lane 计划风险5）未验证；上传路径依赖 gesture 级动作】
  → 每步观察                        【read_page 378 次模式未解——动作后无"变化回执"，模型只能反复读图】
  → 成功证据（transaction_confirmed）【证据由谁在何时铸造是关键待验证项：需要"发布成功"页面信号→proof 的确定性通道】
  → 收口                            【browser_transaction_unconfirmed 已有；用户可见文案与续跑入口待核】
```

### 6.3 与 web-access 的差距定性

6/29 规格的判断经本轮证据复核依然成立且需强调一half：web-access 的可靠感 = **真实浏览器身份（Ready 天然更强）+ 网络观察（W2 已建）+ header-correct 下载（W1 已落）+ 方法论纪律（评估路径升级而非重试同路）**。Ready 真正还缺的不是工具数量，是 §6.2 里的两件事：**每步动作的结构化回执**（减少 read_page 轮询）与**成功证据的确定性铸造**。工具面数量上 Ready 已超过 web-access。

### 6.4 "模型不行还是工程没做完"（用户原问）

判定：**现阶段无法归因给模型，工程面责任占主导。** 依据：

- 工具日志里模型的策略是合理的（找"写长文"tab → power_eval 被拒 → 换 power_cdp → 核对 active 状态 → wait），失败源于工具失败丢状态（A1 修复前）与最终 task_type 错配判决；
- 观察/等待类调用占比 ~50% 是观察面弱迫使的，不是模型低效；
- 47.5% error 里 117 个是"模型认为完成了"——模型的完成判断与系统的证据要求之间缺的是**证据通道**，不是模型智力。
- 待 P1（roadmap）完成后再做一轮同任务评测，若仍高失败，才轮到"换模型/加视觉通道"的讨论。

## 7. 痛点四：任务中断/阻塞普查（R3 收口面 + R4，确认）

### 7.1 中断源分类表

| 中断源 | 触发 | 用户可见 | 恢复路径 | 分类 |
|--------|------|----------|----------|------|
| proof_gap（30%） | done 宣告 + 零有效证据 | 失败卡（曾为泛化文案） | 无引导重来 | **误伤为主，收敛中**（G0/P0-3/P1/P2 后剩余量待观测） |
| adjudication_degraded（12%） | 有证据但判据不满足 | WIP 后默认保持 done+degraded 可见 | — | 设计内（P1 已软化） |
| browser_transaction_unconfirmed | 交易无成功证据 | "网页操作还没有成功证据，可以继续" | 设计上可续 | 设计内（新，覆盖面待验证） |
| blocked_external（20 次） | 网络/站点/provider 故障 | 失败 | C5.2 重试后 blocked | 设计内 |
| checkpoint_budget/steered | 预算/转向 | 可续跑卡 | continuation handle | 设计内；**裁决不通过且可续时也转 checkpoint_budget（run-finalizer.ts:449-451），语义略混叠** |
| 确认闸门等待（现存 4 pending） | M1-M4/grant_required | 等确认 | 用户点卡 | 设计内，但**与"卡住"体感无区分展示** |
| lease_held（×5+） | agent/用户抢写锁 | 采集直接失败 | 重来 | **意外脆弱→WIP 已大幅收敛**（lane Phase 2/4/6 已成形，待真机回归确认） |
| 采集部分成功塌缩 | 62/69 记 failed（均为 06-06 历史行） | 失败卡 | — | **已修**（S3-1，06-10 提交：同输入现→paused/'partial'，矩阵测试实跑绿）；残余边界=note_collect 不传 targetQuality、customScript 绕过结构上下文 |
| 基础设施（DB不可用/进程重启） | 少见（1+2 次） | 失败/中断 | startup reconciler 在跑（metrics 18 次，孤儿 0） | 设计内兜底已建 |
| 配置/持久化/送达类 | blocked_config 5、persistence_failed 3、delivery_failed 2 | 失败 | 无引导 | 设计内分类已有，恢复引导缺失 |
| 静默窗口（非终态） | §4.2 | "像卡死" | — | **体验缺陷**（R1：provider 伪流式为主因） |

### 7.2 结构面评估

- 收口合同是真实执行的：`finalizeRunOutcome` 调用点集中在 turn-orchestrator(11)/lifecycle/stale-projection-finalizer/runtime，gate 在管。no-progress 真守卫在 orchestrator.ts:275-393（tick 按 requestId 双重校验 :369-370），此前初版点名的"4 个文件"实为分类/映射点而非守卫本体（07-02 复核修正）。**稳定性地基可信，本轮没有发现旁路终态类缺陷。** 但要诚实标注：run_meta 中 `main_no_progress_timeout` 与 `browser_transaction_unconfirmed` 均为 **0 次实际发生**——机制存在 ≠ 生产验证过，两者都还没接受过真实事故的检验。
- 真正的敞口是**语义层**：完成证据链（谁铸造 proof）没跑通到浏览器/多步任务的每个关键动作上——裁决层是好的守门员，但没人给它送球。
- R4 维护性：turn-engine.ts dormant 未删（P6f 边界内合法但持续付税）、browser-tools.ts ~5.8k 行、turn-orchestrator ~2.4k 行、Settings.tsx ~3.5k 行。**本轮多个根因的修复都要穿过这几个巨文件**——拆分不是洁癖，是后续所有工作的速度税。

## 8. 确认 / 修正记录 / 待验证清单

### 8.1 对抗复核记录（2026-07-02 当日，3 条 Claude 证伪线 + 1 条 codex 交叉复核）

初版结论经四线对抗审查后的完整判决（codex 对五条头条 5/5 CONFIRM；Claude 三线共 22 项判决）：

**被推翻（3 项，已改写正文）**：
1. ~~"流式主因是 hold-until-final 开关"~~ → 主因是 **provider 模型层伪流式**（阻塞取全文后单包 delta；仅字面 `openai` 真流式），hold 只影响 ~20% 技能授权轮（普通轮 no_skill 授权剥掉 skill_ask_user，80/20 分布来自 tools.log 实测 35 轮）；
2. ~~"聊天区无逐条工具活动消费者"~~ → toolEvent 经 runtimeDriver:1632-1643 进 toolTrace，由 ToolTraceCard（TaskCard.tsx:749-855）逐条渲染，残余问题是默认收起+只显最新一行；
3. ~~"access_count=0 证明 belief 卡未被读（以 summary 460 为对照组）"~~ → 该计数对 belief 行结构性不可达（递增仅在 prompt-assembly 三条注入路径），0 值不具证明力；同向结论改由 memory_read_card 0 次调用支撑。

**被降级/过度声明修正（3 项）**：
4. "A1 已落地" → 仅 browser_power_eval 1/4 部分落地，power_cdp/trace/forensics 仍是泛化 catch；
5. "proof_gap 已收敛（日均 23→4）" → 量混淆；按占比 74%→20-45% 波动，未稳定（本项为自查发现）；
6. "main_no_progress_timeout 接线于 4 文件" → 4 文件是分类/映射点，真守卫在 orchestrator.ts:275-393；且该终态与 browser_transaction_unconfirmed 在 run_meta 中均为 0 次实际发生。

**被反向上调（2 项，进度比初版结论更好）**：
7. lane 解耦：Phase 2/4/6 已在 WIP 基本成形（默认已翻转 agent-view、supervision 已接、verify:browser-lane 38 pass），初版低估；
8. 采集部分成功塌缩：已被 06-10 提交的 S3-1 修复（62/69 类输入现→paused/'partial'），DB 里的 failed 行全部是修复前化石。

**被强化（2 项，结论更重了）**：
9. "learningDecision 从未触发" → **写入端根本未实现**（src/ 零出现），且读端 33 次全死在更早前置闸；
10. "crystallize unwired" → 10 个导出穷举零生产调用方 + maintenance_audit 指标 0 次，另发现定时雷：archiveOldL2Memories 不排除 belief 类（90 天后会归档信念卡镜像）。

其余 12 项判决为 CONFIRMED（含 §4.1 三开关、§7 收口转换链、C2/C3/C6 全链、B1/B2/B3/B6/B7/B8）。

### 8.2 仍为推断（单证据或合理外推）

静默窗口各段的相对占比；R4 对修复速度的影响度；"观察面弱迫使 read_page 轮询"的因果方向。

### 8.3 待验证（写码前必做，继承 7/01 V0 纪律）

1. 重启现源后，XHS 发布 task_type 首帧分类与 `browser_transaction_unconfirmed` 全链路实走一次（V0-2 复测；该终态生产 0 次发生，属未经实战的机制）；
2. `transaction_confirmed` proof 的铸造点现状（哪个信号、谁写、何时写）；
3. 真 SSE 改造的 per-provider 细节：openai-compatible chat 路径当前**收到 SSE 会抛错**（:305）、responses 路径显式 stream:false（:342）、anthropic 路径（:483）——三条路径各自的流式协议支持面需逐一确认；
4. hold 放行改造前，ask-user 卡文本半截泄漏的行为测试先行钉住（仅涉 20% 技能轮）；
5. lane Phase 5（popup 归属）与 7/01 实施 Phase B/D（拖拽视觉分析、站点卡按 tab 域名匹配）的精确状态；
6. belief 使用度量通道设计：修复计数（让 memory_read_card/直注计数）或改验收口径，二选一后 P2 验收断言才可用。

## 9. 结语：四痛点其实是一个故事

这套系统在 6 月完成了从"裸奔"到"合同化"的跨越（收口、裁决、staged、gate 文化都是对的），但**三条"最后一公里"没有接**：事件到用户眼睛的一公里（R1）、经验到下次运行的一公里（R2）、动作到完成证据的一公里（R3）。它们共享同一个形状：**底层机制已建成，缺一段实现/接线和一个可见面**——对抗复核把三个"缺口"的坐标钉得更准了：R1 缺的是 provider 模型层的真 SSE 实现（不只是开关），R2 缺的是 learningDecision 写入端与固化引擎的接线（不只是触发），R3 的浏览器侧其实比初判走得更远（lane/采集判决已基本成形），剩余敞口收敛到 A1 补全、W5 验证闭环与 transaction proof 铸造。修复仍是局部工程，不是重构工程。配套路线见同日 `2026-07-02-agent-core-experience-roadmap.md`（已按复核结论重排优先级）。
