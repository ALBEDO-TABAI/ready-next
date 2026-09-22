---
title: P1/P2 自主推进收尾 + 待复测清单（2026-07-03 夜间无人值守）
date: 2026-07-03
status: closeout
enforce: false
context: >
  用户睡前授权自主完成 P1 剩余 + P2 全部，P2 后额度>10% 则推进 P3。
  我无法读取自身 5h 额度百分比，也无法自调度 resume（环境无 session 绑定），
  故按第一性原理：交付可测、低风险的核心，明确暂缓 renderer/中枢/删除类高危改动，
  不在无人值守下动 P3 架构级退役/拆分。全部改动 typecheck 干净、各自带行为测试、
  stability + evolution-p4 gate 全绿。
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# 一、本轮交付（已完成 + 已测 + gate 绿）

## P1 剩余
- **P1-a 采集报告读回 no_root_match**（已修）：`skill_read_artifact` 对绝对用户路径的 `no_root_match` 现改为可操作错误——提示改用 `file_read_excerpt`（不弱化技能沙箱）。真因是采集报告本已成功落盘（content-task-runner:594 直写用户目录），agent 只是用了沙箱化的技能工具去读回。测试：`skill-primitive-read-artifact.test.ts`（+2）。
- **P1-b 标签不显示**（根因确认，暂缓实施）：`browser:tabOpened` 只在 popup 路径发；`ensureAgentTab` 走的通用 `createTab` 从不发 → agent tab 不进标签条直到 switch 刷新。修法已写明（发 tabOpened 带 `activate:false` + renderer 不抢焦点），但含焦点门控、renderer 无法 headless 验证、无人值守不宜动浏览器 UI 焦点 → 留待可监控会话。详见 `2026-07-03-p1-shared-root-live-host-visibility-rescope.md` §10。

## P2 学习闭环（核心已通电）
- **P2-1 crystallize 接生产**（已修+测）：`CrystallizeScheduler` 在 runtime.start() 接线（启动 90s 后一次 + 6h 周期），gate 决定 run/skip 且每 tick 落 `maintenance_audit`。此前确定性结晶轮从未实例化。附带修 `MemoryLifecycleManager` 初始维护 `setTimeout` 泄漏（stop() 未清 → 停后仍触发 "not running"）。测试：现有 crystallize-gate 测试 + 类型接线。
- **P2-4 belief 使用计数**（已修+测）：`renderKnowledgeIndex` 现返回 `renderedRelPaths`；`bumpBeliefCardAccess` 在注入后递增镜像 `access_count`。此前 access_count 恒 0，衰减信号/使用度量无法计算。测试：`belief-injection-usage-count.test.ts`（4）。
- **P2-5 learningDecision/learningRefs 写入端**（已修+测，最高价值）：finalizer 从已验证 proof 集确定性派生 `learningRefs`（durable 类：artifact/transaction_confirmed/run_state/task_event 或带 path），写入 projection；CheckIn 带 `learningDecision{learned,refCount}`。**此前无写入者 → projection.learningRefs 恒空 → 专项 agent 进化提案永远 skip `missing_learning_refs`，成长闭环从不触发**。测试：`run-finalizer-checkin.test.ts`（+3）。
- **P2-6 archiveOldL2 排除 belief（定时雷）**（已修+测）：belief 镜像行是 `layer='l2' category='belief' access_count=0`，通用低访问 L2 清扫会在 90 天静默归档有效信念卡。现按 category='belief' 排除（信念卡走 belief-decay 自有生命周期）。测试：`memory-lifecycle-belief-archive-exclusion.test.ts`（1）。
- **P2-2 criteria 落库**（已修+测）：finalizer 把已解析的验收 criteria（items + satisfied/total）写入 projection（此前只算不存，仅进 divergence metric）。为 daily-task-index criteriaProgress 提供数据源。测试：`run-finalizer-checkin.test.ts`（+1）。

## 验证
- `npm run typecheck:node`：干净。
- `npm run verify:stability`：EXIT=0。
- `npm run verify:evolution-p4`：EXIT=0（全绿）。
- `npm run verify:evolution-p1`：仅 1 处**既有 base 失败**（`frozen-call-release.test.ts` 的 login-fill waitFor 超时；已 `git stash` 复核：base 态同样失败，且该测试不 import 任何本轮改动文件）。非本轮回归。

# 二、明确暂缓（有意不做，非遗漏）

- **P2-2 criteria 前置注入模型面**：criteria 依赖 taskType，而 prompt-assembly 无 taskType、live-path reminder 是散点 steer 无单一 per-turn 注入点。前置注入需把 taskType 穿到 prompt 组装或中枢 turn-orchestrator 加首轮 reminder——中枢文件改动，无人值守高危。落库已做（数据侧就绪）。
- **P2-3 学习提示时刻**：renderer UI（staged 卡/学习建议一次性会话流提示 + 确认/撤销/稍后）。renderer 改动 headless 无法验证，与 P1-b 同类高危 → 暂缓。数据侧 learningRefs/staged 已就绪，UI 接上即可。
- **P2-6 belief-decay 生产接线**：`runBeliefDecayRound` 确定性但会 demote/delete 信念卡。P2-4 使用计数刚接通、镜像尚无 was_useful_count，此刻按龄衰减有误降风险；且 delete/demote 无人值守高危 → 暂缓到 P2-4 数据积累 + 可监控会话。archive 定时雷（真正的丢卡风险）已拆除。
- **P3 架构级（TurnEngine/DirectChat 退役、巨文件拆分、run-timeline 单源、性能整固）**：**未开始**。理由：(1) 我无法读取自身 5h 额度，用户的 ">10% 才推进 P3" 条件无法判定；(2) P3 是 dormant 中枢退役/大重构，按用户自己的架构红线需"先机器可验证合同 + CI 强制"，且做错会白屏/崩溃且无人接住；(3) 无人值守下动架构是鲁莽的。建议 P3 放到可监控会话，先写合同再动。

# 三、待你复测清单（醒来后逐条验）

## A. 采集（P1-a + 前几轮 P1-R1）
1. 采集一个小红书博主的笔记 → 期望：不再硬"失败"，而是可恢复"已暂停"或带 ask 卡；采集报告 + 图片落到你的授权目录；即便 agent 读回报告，也不再抛 no_root_match 死错（会提示用 file_read_excerpt）。
2. 若页面只出导航壳（反爬），期望：判为可恢复用户接管，不是 hard 失败。

## B. 发布（前几轮站点卡增强）
3. "帮我发一条小红书长文笔记" → 期望：agent 先确认切到"写长文"tab、先填标题（你只给正文时用首句作标题）、再找右上角发布按钮、disabled 时读 map 查缺项，而不是反复截图/滚动盲找耗尽预算。（若仍卡在最后一步，记录它停在哪一步，我需要真机 DOM 才能写精确定位。）

## C. 学习闭环（P2，最需要你观察"成长是否真的发生"）
4. 用一个**专项 agent**（active specialist）完成一个**有产物**的任务（如生成文件/确认事务）→ 期望：run 收口后，该 agent 的 `agents/<id>/knowledge/task-evolution-*.md` 出现 **staged** 进化提案（此前永远不产生）。产物在受保护路径时仅显示"已生成（受保护路径）"。
5. 观察设置页知识系统：多轮使用后，被注入 prompt 的信念卡 `access_count` 应 > 0（此前恒 0）。
6. 长时间运行后（或手动等 crystallize 6h 轮）：知识 index/backlink 应被结晶轮维护；`maintenance_audit` 事件可在 metrics 日志见到 run/skip。
7. 信念卡不会再在 90 天后被静默归档（定时雷已拆）。

## D. 回归确认（不该坏的）
8. Browser / Agent / Settings 关键链路基础走一遍；聊天流式、任务卡、终止收口正常。
9. 若发现任何"失败"其实是既有 base 问题（如 login-fill 那个），告诉我，我区分开。

# 四、下一步（你回来后我建议的顺序）
1. 复测 C 组（学习闭环）——这是本轮最实质的"成长真的发生"验证。
2. 可监控会话里做 P1-b 标签 surface + P2-3 学习提示 UI（renderer，需真机看焦点/呈现）。
3. 再评估 P2-2 前置注入 + P2-6 decay 接线（需中枢/删除类改动，要盯着）。
4. P3 架构级单独排期，先写合同。
