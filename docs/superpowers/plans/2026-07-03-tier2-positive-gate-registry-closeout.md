---
title: 梯队二收尾 — 通用三态能力注册正向 gate + appendModelCriteria 复验缓办
date: 2026-07-03
status: done
enforce: false
parent: 2026-07-03-HANDOFF-agent-module-rework.md
purpose: >
  执行 handoff §5 梯队二。开工前先回应"深审 workflow 曾多次网络中断，
  事实是否可靠"的质疑：所有动刀锚点在本会话直接对代码重验，中断影响的
  是普查覆盖面（skill-runtime/browser-engine/events 仅轻扫）而非已核实
  条目的正确性。appendModelCriteria 复验后判定接线不成立，缓办挂工单。
---

# 1. 交付物：`check-mandated-capability-is-live.cjs`

`check-belief-decay-live.cjs` 的泛化（旧 gate 已退役，belief-decay 断言原语义吸收进表条目）。设计三根柱：

1. **live-required**：接线证据（import/调用正则）+ `*_fired` 账本可观测 + 无陈旧 unwired 标记 + 可选 delegation 边（"排除即托付"：让渡点存在 ⇒ 承接能力必须活）。当前条目：belief-decay、crystallize-round（runtime.ts:52/134/411/758/767/772 全部实测锚定）。
2. **deferred-by-design**：**不重复实现负向检查**——与 `check-unwired-capability-markers.cjs` 的导出表（UNWIRED_PACKET_FILES / UNWIRED_MAINTENANCE_FILES / MIXED_MAINTENANCE_ROUND_REL）做一致性握手：条目必须仍在对应表里。谁接线了能力（从 unwired 表移除）而不翻本表 → 红，**gate-flip 迁移被机器强制**（正是 P2-1 裸接 crystallize 教训的制度化）。当前条目：candidate-maintenance、emergence-cards、packet-trio、maintenance-llm-round。
3. **dark-defect**：锚点符号仍存在 + 暂缓登记文档明确提及（工单不许静默烂尾）。当前条目：appendModelCriteria（D4）、RunFeedbackRepository（D5）。

测试 `scripts/__tests__/check-mandated-capability-is-live.test.cjs`：8/8（fixture 基线 + 真仓 + 排除即托付违反 / fired 缺失 / 陈旧标记 / 接线缺失 / 锚点消失 / 工单缺失各负例）。

**链变更**：`verify:evolution-p3` 中 `check-belief-decay-live.cjs` → `check-mandated-capability-is-live.cjs` + gate 测试；旧 gate 文件删除；handoff §8 基线命令同步。

# 2. appendModelCriteria：复验 → 缓办（D4）

handoff 标 confidence=medium 要求先复验。复验结论（全部实测）：

- 函数存在且确定性（criteria-templates.ts:179，m1/m2 命名空间、模板不可覆盖、空文本丢弃），零调用者。
- 裁决 live 路径：run-finalizer.ts:623 `resolveCriteria` → `adjudicateTerminalOutcome`，criteria 已落库（P2-2 前半）。
- **捕获通道不存在**：全仓无任何字段 / 工具入参 / 解析点承载"模型规划期声明的验收标准"（acceptanceCriteria/modelCriteria/declaredCriteria 等零命中）；设计文档"02 §3.1"不可考。steps/packet 是计划与分包语义，混作验收标准会直接造成裁决漂移。
- 结论：真实工作 = 设计模型可见的声明通道（最佳与 D2 criteria 注入合并设计，同一通道进出）+ 落库 + finalizer merge + 漂移监控。**改模型可见面 + 动裁决脊柱，无人值守不做**。已挂 D4 工单（deferred-work-register），注册表记 dark-defect，实施时按 gate-flip 翻条目。

这是继梯队一 A5（compressToolTrace 接线不成立→删除）后第二个"handoff 修复项在复验下改判"的案例——两次都是 finder 低/中置信自标 + 复验纪律起效。

# 3. 网络中断质疑的正面回答（用户 2026-07-03 问）

- 深审 workflow 3 次跑、前 2 次网络/session-limit 失败、第 3 次覆盖 4/9 子系统，后手审补齐——**中断影响覆盖面，不影响本两轮动刀事实**：梯队一/二所有锚点（文件、行号、引用图、gate 语义、调用者集合）均在本会话 grep/Read 直接重验，与审计文档不符处（A5、tool-parallelism-policy 非孤儿、appendModelCriteria 通道缺失）一律以实测为准。
- 残余风险：轻扫子系统（skill-runtime/browser-engine/events，含 SkillResumabilityCoordinator / DetachedTaskRegistry "无 live new 待验"）可能有漏报 dark 项 → 注册表按"已验证条目"收录，结构可扩展；补审属后续普查工作，不阻塞本梯队。

# 4. 验证证据（2026-07-03，真实退出码）

**方法勘误（本梯队重要副产物）**：此前（含梯队一初版证据）用 `npm run X | tail -N && echo OK` 验证链——管道退出码恒为 tail 的 0，"OK" 无条件打印，全部作废重测。重测方式：`npm run X > log 2>&1; echo EXIT=$?`。重测揪出三件被掩蔽的事：①梯队一删除在 `test-coverage-exemptions.json` 留下三条陈旧 c4Exempt，`check-sqlite-test-skip-pattern`（stability 链成员）正确检出——已修；②p3 有 base 自带的 packet 阈值矩阵失衡（browser_transaction 枚举未同步测试）——测试侧已同步；③p6o 有 3 个 base 自带 sdk 用例 vs 行动宣告闸碰撞——挂 D6，属可监控会话。

最终真实状态（全部 `EXIT=$?` 捕获）：
- `typecheck:node` EXIT=0
- `verify:stability` EXIT=0（含修复后的 exemptions 检查）
- `verify:evolution-p3` EXIT=0（换链后全链：新 gate + gate 测试 + unwired gate + verify:native）
- `verify:evolution-p4` EXIT=0
- `verify:evolution-p6o` EXIT=1 — 失败恰为 D6 三个已知 base 用例，链内其余 102/106 过（含梯队一全部修剪文件）
- 新 gate 真仓直跑 ok；gate 测试 8/8
- 残留扫描：`check-belief-decay-live` 在 package.json/scripts/src 零残留（docs 为历史叙述 + handoff 已注记退役）
- 本梯队 src 侧仅两处测试同步（packet 矩阵 + task-types 冻结数），零运行时行为改动

# 5. 下一步

梯队三（需 UI + 监控，勿无人值守）：RunFeedbackRepository 全栈（D5）、emergence feed 通电、D2+D4 合并设计（criteria 注入 + 模型声明标准回传）。梯队四（架构，合同先行 + 监控会话）：run-timeline 单源、turn-engine/DirectChat 退役、god-object 拆分。
