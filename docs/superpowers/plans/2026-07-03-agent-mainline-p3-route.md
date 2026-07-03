---
title: 主线回归路线 — P3 架构收口排期（真机关账 → turn-engine 退役 → 巨文件手术 → DirectChat/事件单源）
date: 2026-07-03
status: proposed
enforce: false
source:
  - docs/superpowers/plans/2026-07-02-agent-core-experience-roadmap.md（主线母文档）
  - docs/superpowers/plans/2026-07-03-P3-review-and-surgical-plan.md（Phase A-D 精确手术步骤，权威）
  - docs/superpowers/plans/2026-07-03-HANDOFF-agent-module-rework.md（岔路收口记录，梯队一至三已完成）
  - docs/superpowers/plans/2026-07-03-deferred-work-register.md（D1-D7 工单）
  - docs/superpowers/plans/2026-07-03-p1-p2-autonomous-closeout-and-retest.md（待复测清单）
purpose: >
  7-02 主线（P0 流式→P1 浏览器可靠性→P2 学习回路→P3 架构收口）在 P2/P3 之间
  岔出一条审计修正线（深审→handoff→梯队一二三），现已收口。本文核对"文档声称
  vs 仓库事实"后，把回归主线后的路线排出来。用户记忆的三大项（巨文件手术拆分、
  turn-engine 退役、agent 模块继续优化）确认为 P3 主体，但顺序和范围按实测修正。
---

# 0. 现在位置（文档 × 仓库事实对账）

| 主线阶段 | 状态 | 证据 |
|---|---|---|
| P0 流式与可见性 | ✅ 完成+真机验证 | provider 真 SSE、hold 放行、活动流、心跳、质量面板 |
| P1 浏览器可靠性 | ✅ 代码完成，**真机回归未关账** | roadmap §P1 落地状态全绿，但"三个 XHS 真机回归"从未实战（`browser_transaction_unconfirmed` 生产 0 次触发=机制未经检验） |
| P2 学习回路 | ✅ 完成（含岔路补强） | P2-1..6 + P5d 确定性迁移 + 梯队三（D2 事中自检/D5 反馈/emergence feed） |
| 岔路：审计修正线 | ✅ 收口 | 梯队一（死债）、梯队二（三态正向 gate 注册表）、梯队三（通电）；checkpoint f8682671 + 44802786 + 59936854 |
| **P3 架构收口** | ⬅️ **当前主线** | 本文排期 |

岔路的净收益归位主线：正向 gate 注册表（防"建了没接"复发）、gate-flip 纪律、
真实退出码验证纪律、~1.4k 死债清除——这些都是 P3 手术的安全设施。

# 1. 用户记忆三大项的核对结论

| 记忆 | 核对 | 修正 |
|---|---|---|
| "巨大文件的手术拆分" | ✅ 是 P3 主体（Phase B 系列） | 对象比记忆多：>2.6k 的源文件约 11 个；头号是 browser-tools.ts **8053**（已从 8484 抽出 probe），其次 runtime.ts 4327、runtime-manager 3800、Settings 3486、useAgent 2983、turn-orchestrator 2675（本轮 D2 后） |
| "turn-engine 的退役" | ✅ 是 P3 Phase A | 生产 **0 引用**确证（4827 行 dormant）；难点不在删码而在**253 断言契约测试的外科摘除**（冻结的是被 Stage U 取代的 2026-04-17 旧设计）+ C29/C30 有前次规划失败史。另：DirectChat **不是** dormant（live 服务容器），退役=六职责迁移，单独 Phase C |
| "agent 模块的继续优化" | ✅ 但需具体化 | = Phase C（DirectChat）+ Phase D（run-timeline 事件单源）+ 伴随线（D-register 残项、意图门控漏判专项、债务清理包、E1-E5 体验合同化） |

# 2. 排期（按依赖与风险，每阶段动工前按 §10 转当日 implementation 合同）

## Phase R — 真机回归关账（先做，短，需用户在场）

P1 的验收欠账 + 本轮新件的真机确认，一次跑完：

1. **XHS 三回归**（roadmap P1 验收原文）：发布全链（V0 纪律：重启现源、记录 commit；观察 `browser_transaction_unconfirmed` 是否如实触发/不误触发）、拖拽出视觉分析、账号采集冻结真实笔记。
2. **E1-E5 体验断言首次基线**：按 roadmap §4.1 写统计脚本（tools.log 的 read_page 连读次数→E5、账本 proof_gap 日占比→E2、静默窗→E1），产出基线数字进 quality 面板或脚本。
3. 顺手确认：ct-punc 模型包装上后 video-expert-analyzer 复跑；多步任务后 `criteria_self_check_injected` 出现（D2）；ReadyMode 涌现段有卡时可用。

**出口判据**：三回归各有一次通过记录（或失败已定位为站点/登录态问题并登记）；E 基线数字落档。

## Phase A — turn-engine 退役（A0 可无人值守；A2/A3 建议在场）

按 `2026-07-03-P3-review-and-surgical-plan.md` §3 Phase A 修正版分步，不复述细节，仅记入口与红线：

- **A0 盘点（无人值守可做）**：turn-engine 全部 export 的引用判定（dead / 需抽取 / live 另有等价覆盖）。已知同死候选：`HostCapabilityDispatcher`（唯一生产引用者就是 turn-engine，A0 一并盘点）。
- **A1 抽取 → A2 删类+专属测试 → A3 守卫测试转"文件不存在" gate**。
- **红线**：253 断言契约测试只做外科摘除（stale 的 TurnEngine-owner 断言走、live 的 DirectChat host 契约留）；每步真实退出码验证（管道教训）；`check-directchat-turnengine-dormant-boundary` gate 同步转型。
- 产出：−4.8k 源 + ~10k 测试死重；dormant 侧双运行时税清零。

## Phase B — browser-tools.ts 手术拆分（机械，可无人值守，可与 A 并行）

- 按能力缝抽组：collection / power / media / navigation / observe 各一模块，`browser-tools.ts` 保薄门面 re-export；每抽一组 typecheck+focused 绿。纯移动零行为变更（probe 抽取已验证此法）。
- 目标：主文件 <2k；每步独立可提交。
- B 完成后按同法排队：runtime.ts 4327（能力缝：crystallize/decay 调度、projection 接口、host 装配）、runtime-manager 3800、Settings.tsx 3486（renderer，需在场）、useAgent 2983（renderer，需在场）。**触碰 >2k 文件的工单默认附带"顺路拆出所改区域"**（roadmap §4.5 长期规则）。

## Phase C — DirectChat 职责迁移退役（合同先行 + 在场）

- 六职责逐个迁出（域适配器宿主 / 技能上下文 / 浏览器控制器 / sidecar / runtime / 会话生命周期），每职责一步一契约测试；全部迁完后 orchestrator 不再 `new DirectChatEngine()` → 删。
- **前置**：机器可验证合同（C29/C30 有前次失败史，红线§0.5.1）；A 完成后做（守卫测试转型后边界更清晰）。

## Phase D — run-timeline 事件单源（合同先行 + 在场）

- D1 统一事件模型 → D2 `agent:stream`+`scopeRunEvent` 收敛为投影、renderer 全派生 → D3 gate 防旁路。
- 放最后：renderer 全域改动，白屏高危；P0 的体验收益已经拿到，此项是架构地基不抢时序。

## 伴随线（穿插在 A/B 间隙，多数可无人值守）

| 项 | 内容 | 值守 |
|---|---|---|
| 债务清理包 | ipc-contract 26 条既有违规（allowlist 重锚 + 6 个 handled-only 补调用或登记）；chat-panel-baseline 的 CSS-in-tsx 崩溃修复（vertical-tabs 引入）；silent-catch ~150 条基线收敛策略（分批补 metric/注释，不一次豁免） | 可无人值守 |
| 意图门控漏判专项 | 真机 14:00 事件类：应进浏览器工作流的消息被判 local_chat → 浏览器组被抑制。改进 `resolveTaskTypeFromBrowserWorkflowText`/意图分类信号面 + 漏判账本 | 分析可无人值守，改判定需评估漂移 |
| D-register 残项 | D1 标签 tabOpened（renderer 焦点，在场）；D4 声明通道设计（决策：新工具 vs 协议）；D6 三测试语义仲裁（宣告闸 vs fixture）；**D7 LLM 维护回合**（专门会话：符号禁令 gate-flip + LLM 预算 + staged 监控——用户"后台自动积累"产品观的下一主件） | 各异，见工单 |
| 涌现数据源第二批 | prepare/harvest/forming 的信号采集（日历联动/产物打开跟踪/文件聚类）；与 D7 同属"后台成长"，合并规划，避免再造前台面（feedback 记忆：后台积累优先） | 设计先行 |

# 3. 分支策略（需用户决策的唯一悬点）

主线的全部工作现堆在 `feature/vertical-tabs`（含竖向标签栏自身未完成项：4 个 source-grep 合同待改 + D1 标签可见性）。选项：
- **a）继续在本分支推进 P3，vertical-tabs 完成后一起合 main**（现状惯性，风险=分支越来越大）；
- **b）把 agent 主线工作 cherry-pick/合回 main 或新开 agent-p3 分支，vertical-tabs 归位纯 UI 分支**（干净，但要一次分叉手术）。
建议 b，在 Phase R 关账后做（回归通过=合并信心）。

# 4. 推荐启动顺序（下一个会话即可开工）

1. **Phase R**（用户在场，半天）：三回归 + E 基线 + 新件确认 → 关 P1 账。
2. 并行开 **A0 盘点** + **Phase B 第一组抽取**（无人值守安全，产出证据与纯移动 diff）。
3. A0 证据齐 → 在场会话做 **A2/A3 契约外科** → Phase A 收口。
4. 债务包与意图门控专项穿插；**Phase C、D、D7 各自合同先行、在场排期**。
