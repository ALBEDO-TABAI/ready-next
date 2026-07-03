---
title: 会话交接 — Ready agent 模块系统改造（长会话 → 新会话续跑）
date: 2026-07-03
status: handoff
enforce: false
purpose: >
  本长会话（P0→P3 诊断修复 + 深度审计 + P5d 迁移）上下文过长，恐降准确度。
  这份是**单一权威续跑文档**：新会话只读本文 + §7 索引的文档即可无缝接续，
  不需要原始对话历史。所有结论均有 file:line / 命令锚点，非记忆臆测。
---

# 0. 怎么用这份文档（新会话第一步）
1. 读本文全文（尤其 §4 论点、§5 路线图、§6 纪律）。
2. 读 §7 索引里与你要做的任务相关的 2-3 份文档。
3. 从 §8「从这里开始」执行。
4. 动任何"接线/删除"前，务必遵 §6 的 gate 纪律与 verify 链。

# 1. 一句话现状
Ready agent 模块（~519 文件/~153k 行）**骨架是对的，不重写**；真正的债是**"建了没接"的成长/维护能力 + god-object 速度税 + 双运行时认知税**。本会话已把最痛的两处（流式 + belief 学习/衰减闭环）通电并加了防复发正向 gate；剩余按 §5 路线图推进。

# 2. 本会话时间线（做了什么）
- **P0**（已真机验证）：provider 真 SSE 流式（P0-0，`provider-sse.ts`+`agent-sdk-provider.ts`）、hold 释放、工具轨迹卡、心跳、质量面板。
- **P1**（部分真机验证）：采集/发布可恢复化（`collection-verdict.ts` highControl→paused）、A1 power 失败结构化、W5 字节校验、E5 动作回执、finalizer proof_gap→browser_transaction_unconfirmed、任务卡标题泄漏修复、skill 工具曝光修复、XHS 站点卡"写长文发布流程"知识、read-artifact no_root_match 指向 file_read_excerpt。
- **P2 学习闭环通电**：P2-1 crystallize 接线、P2-4 belief 使用计数(`bumpBeliefCardAccess`)、P2-5 learningRefs 写入端(finalizer)、P2-6 archiveOldL2 排除 belief（拆定时雷）、P2-2 criteria 落库。
- **P3 审查**：证伪 roadmap 多处失真（browser-tools 8484 非 5.8k；AgentSdkRuntime 已拆到 1076；DirectChat 非 dormant 是 live 服务容器；turn-engine 生产 0 引用但契约测试冻结已取代的旧设计 + C29 有前次规划失败）。**未删 turn-engine**（entangled，留监控会话）。
- **Phase B**：browser-tools.ts 抽出 `browser-probe.ts`（8484→8053，测试绿），其余并入审计驱动的能力缝拆分。
- **深审 workflow**（3 次跑，前 2 次网络/session-limit 失败，第 3 次覆盖 4/9 子系统）+ **手审补齐 9/9**：得 ~17 已对抗验证 dark，见 `2026-07-03-agent-module-deep-audit-findings.md`。
- **P5d 确定性部分迁 live**（用户选 Option A，已完成）：见 §3。

# 3. 已完成 + 已验证绿（精确）
- **P5d 迁移（本会话最后一大块）**：
  - crystallize 合法化（gate-flip 做对）：`check-unwired-capability-markers.cjs` 的 UNWIRED_MAINTENANCE_FILES 去掉 crystallize-gate.ts；`crystallize-gate.ts:1` 去 unwired 标记；gate 测试更新；runtime 加 `crystallize_round_fired` 账本。**修好我 P2-1 弄红的 evolution-p3 gate**。
  - belief-decay 接线：`runtime.ts:runCrystallizeRoundOnce` 每 crystallize tick 跑 `runBeliefDecayRound`（与 dark LLM 轮解耦：`collectBeliefDecaySignals` 移到 `belief-decay.ts`）；`createBeliefDecayEffectors`（file-backed）+ `readBeliefCardAccessStats`（mirror）+ `belief_decay_round_fired` 账本。**闭掉 P2-6 制造的 belief 永不淘汰泄漏**。
  - 首个正向 gate `check-belief-decay-live.cjs`（进 verify:evolution-p3）："排除即托付"——memory-lifecycle 排除 belief → belief-decay 必须 live+fired。
  - 测试：`belief-decay-store-effectors.test.ts`（demote-before-delete/两阶段/duplicate 永不删/used+recent 永保）。
- **验证状态**：`npm run typecheck:node` 净；`npm run verify:stability` EXIT=0；`node scripts/check-unwired-capability-markers.cjs` + `node scripts/check-belief-decay-live.cjs` 均 ok；17 belief/maintenance 测试绿。

# 4. 核心论点与策略（不要偏离）
1. **built-but-dark 集中在"成长/学习/维护"能力簇**，执行子系统（browser/skill/events）天天被跑保持 wired。dark = 建了没接的成长能力 = "agent 不成长"痛点的技术根。
2. **现有 gate 全是负向（防误接），防不了漏接**——这是复发根因。修法=**三态能力注册 `@capability-status: {deferred-by-design | dark-defect | live-required}` + `*_fired` 运行时账本 + 正向存活 gate + "排除即托付"闸**。`check-belief-decay-live.cjs` 是第一个正向 gate 的具体落地，是通用注册表的模板。
3. **接线 deferred 能力 = gate-flip 迁移，不是裸 import**：改 UNWIRED 表/去标记/更文档/加 fired 账本/加正向 gate。**我 P2-1 裸 import crystallize 破坏了 gate（跑 p1/p4 没跑 p3 漏检）——这是最大教训，别重犯。**
4. 骨架成立（收口 funnel/裁决分离/staged 隔离/DomainAdapter/gate 文化），**不重写**。

# 5. 前进路线图（ROI 排序，每项含风险/可否无人值守）
**梯队一（安全、可无人值守、先做）**
- **删死债**：`LayeredCompactor`(`compaction/layered-compactor.ts`，被 `compactAgentInputItems` 取代)、`ExecutionLoopOrchestrator`+`ToolRuntime.executeBatch`(被 OpenAI Agents SDK 工具循环取代)。删前确认无 live 引用（turn-engine dormant 除外），删后 typecheck+verify:stability。
- **廉价接线 compressToolTrace/Artifacts**：`context-compression.ts:61/86` 两函数，在 `prompt-assembly.ts:buildForScopedRun` 并排于 `compressHistoryForPrompt` 调用，并把 `:1270-1271` 硬编码 `toolTraceCompressed:false/artifactSummaryUsed:false` 改真值。**finder 标 confidence=low，接前先复验**。需注意别踩 `check-dormant-compaction-not-in-live-path.cjs`（该文件是 live 的，两函数是文件内死能力，接线不违规但要确认 gate 语义）。

**梯队二（价值高，防复发）**
- **通用三态注册 + 正向 gate**：把 `check-belief-decay-live.cjs` 泛化成 `check-mandated-capability-is-live.cjs`（合同能力→期望 live 入口/fired 事件映射表）；给 dark-defect 项挂工单，deferred-by-design 指向 defer 文档。
- **appendModelCriteria 接裁决**（`criteria-templates.ts:179`）：在 `run-finalizer.ts:623` 上游捕获模型规划期声明的标准并 merge。confidence=medium，需监控裁决漂移。

**梯队三（需 UI + 监控）**
- **RunFeedbackRepository 全栈**（`task-projection/run-feedback-repository.ts`，`run_feedback` 表 migration 036）：实例化 + IPC `agent:runFeedback:submit/list` + preload/electron.d.ts + renderer 评分控件。
- **Emergence feed 通电**（最高成长价值，合同强制 CLAUDE.md §2）：producer(scheduler/scope-run 事件调 `assembleEmergenceFeed`) + IPC + preload + UI 面。`emergence-cards.ts`（仍在 UNWIRED 列，需 gate-flip 迁移）。
- **P5d LLM 维护回合 + candidate-maintenance**：需 live 信号采集 + LLM 预算 + staged 写监控。最后做。

**梯队四（架构，单独监控会话，合同先行）**
- run-timeline 事件单源（P3 Phase D，三通道→单投影+gate）；turn-engine/DirectChat 退役（P3 Phase A/C，见 `2026-07-03-P3-review-and-surgical-plan.md`，注意 stale 契约测试 253 断言外科手术）；god-object 拆分（browser-tools 8053/runtime.ts 4297+）。

# 6. 关键纪律与坑（务必遵守）
- **接 deferred 能力先 gate-flip**（§4.3），别裸 import。改完**必跑 `npm run verify:evolution-p3`**（不只 p1/p4）——p3 含 unwired/belief-decay gate。
- **belief-decay 会 demote/delete 卡**：改其逻辑/阈值前跑 `belief-decay-deterministic.test.ts` + `belief-decay-store-effectors.test.ts`。
- **verify 链**：typecheck:node、verify:stability、verify:evolution-p3、verify:evolution-p4；SQLite 相关跑 verify:native（需 electron）。
- **已知 base 失败别误判为回归**：`frozen-call-release.test.ts` 的 "login fill" waitFor 超时是 base 自带（git stash 复核过，不 import 本会话文件）；分支 base 另有若干既有失败。
- **未提交**：本会话所有改动在 `feature/vertical-tabs` 工作树未提交（137 changed，含 branch 原有）。新会话继承工作树即续跑；如需 checkpoint 可提交（用户未要求则先不提交）。
- **renderer/BrowserView 改动是白屏高危 + headless 无法验证**：P1-b 标签 surface、P2-3 学习提示 UI、emergence UI、RunFeedback UI 都需可监控会话真机验证，勿无人值守动。
- **无法自调度**：本环境 send_later/create_trigger 报 "no session_id in auth claims"，不能自设定时续跑；也读不到自身 5h 额度。

# 7. 文档索引（本会话产出，权威）
- 诊断+路线：`2026-07-02-agent-core-experience-diagnosis.md`、`-roadmap.md`
- P1 重审/收尾：`2026-07-03-p1-shared-root-live-host-visibility-rescope.md`、`2026-07-03-p1-p2-autonomous-closeout-and-retest.md`（含待复测清单）
- 暂缓登记：`2026-07-03-deferred-work-register.md`（P1-b/P2-2 前置/P2-6 decay[已做]）
- P3 审查+手术计划：`2026-07-03-P3-review-and-surgical-plan.md`（roadmap 更正 + turn-engine 退役精确步）
- 系统评估：`2026-07-03-agent-module-systematic-review.md`
- **深审 census（最新、最全）**：`2026-07-03-agent-module-deep-audit-findings.md`（9/9 子系统 + 通电普查表 + 三态注册策略 + P5d 迁移记录 + census 完成结论）
- 记忆：`project_agent-module-built-but-dark`、`project_agent-four-pain-diagnosis`

# 8. 新会话「从这里开始」

> **2026-07-03 更新：梯队一、二已完成**，见 `2026-07-03-tier1-dead-debt-removal-closeout.md`、`2026-07-03-tier2-positive-gate-registry-closeout.md`。
> 梯队一复验修正：①删死债实际范围含 package.json 3 处 verify 链、1 个 gate 退役、2 个 gate 收缩、6 个测试文件（handoff 低估）；②compressToolTrace"廉价接线"不成立（buildForScopedRun 无 tool-trace/artifact 数据源），按深审 A5 备选项改为删除两死函数。
> 梯队二产物：`check-mandated-capability-is-live.cjs`（三态注册表正向 gate，与 unwired gate 导出表握手强制 gate-flip；替换退役的 check-belief-decay-live 进 p3 链）；appendModelCriteria 复验后判"捕获通道不存在"→挂 D4 缓办（与 D2 合并设计）。
> **验证方法勘误**：`npm run X | tail && echo OK` 的管道会掩蔽退出码，链验证必须 `>log; echo EXIT=$?`。真实链状态：typecheck/stability/p3/p4 全 0；p6o=1 是 base 自带 D6（sdk 三用例 vs 行动宣告闸，可监控会话修）。
> 下一步=梯队三（需 UI + 监控：D5 RunFeedback、emergence feed、D2+D4 合并设计），勿无人值守。

用户已认可思路，下一步做**梯队一**（安全、可无人值守）：
1. 先跑 `npm run typecheck:node && npm run verify:stability && node scripts/check-unwired-capability-markers.cjs && node scripts/check-mandated-capability-is-live.cjs`，确认继承的工作树是绿的基线。（原 `check-belief-decay-live.cjs` 已于梯队二泛化为 `check-mandated-capability-is-live.cjs` 并退役。）
2. **删死债**：先 `grep -rln 'LayeredCompactor\|ExecutionLoopOrchestrator' src/main --include='*.ts' | grep -v __tests__` 确认无 live 引用，再删文件 + 清 barrel(`compaction/index.ts`)/引用，typecheck+stability。
3. **接 compressToolTrace/Artifacts**：先复验（读 `prompt-assembly.ts:671` 与 `:1270`），接线 + 改 flag + 加测试。
4. 做完梯队一 → 梯队二（通用正向 gate 注册表，防复发）。
5. 每步：改动小、typecheck+对应 verify 绿、不破坏既有测试；renderer/架构类留监控会话。
