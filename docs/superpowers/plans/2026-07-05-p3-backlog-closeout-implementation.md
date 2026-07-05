---
title: P3 Backlog Closeout — D4 声明通道 + D7 LLM 维护回合接线（合同先行）
date: 2026-07-05
status: in-progress
---

# 0. 会话范围

本会话（2026-07-05 自主授权）清账 P3 backlog 剩余项。轻件（D1/D6/D19/C5-b/silent-catch/ipc-contract/npm-test 清账）各自随提交记账于 route §6/§7；本文承载两个**架构级**改动的机器可验证合同：D4 模型声明验收标准通道、D7 LLM 维护回合生产接线。真机验证项统一收敛到《2026-07-05-user-retest-checklist.md》。

# 1. D4 — 模型声明验收标准通道（appendModelCriteria 接裁决）

## 1.1 裁决：新工具（否决协议方案）

通道二选一定案为**新主 agent 工具 `declare_completion_criteria`**：

- 协议方案（从模型自由文本解析声明）违反「模型只做判断题：路由、状态机、可重复转换必须由代码承担」——散文解析即隐式状态机。
- 工具边界天然承载校验（条数/长度/命名空间），工具调用本身即声明账本事件。
- 先例：`ask_user_questions` 已确立「主 agent 结构化工具、独立于 skill 域」的形态。

## 1.2 合同（机器可验证）

1. **工具面**：`declare_completion_criteria`，入参 `{ criteria: string[] }`；代码侧校验 1–8 条、每条 ≤120 字符、拒绝空串；同一 task 重复声明为整组替换（幂等）。
2. **落库**：声明写入 task projection 行 `modelCriteria` 字段（复用既有 projection 写通道，不新增旁路）；renderer 不消费该字段做本地推断（O 合同）。
3. **裁决合流**：`run-finalizer` 终态裁决处，`resolveCriteria(taskType, module)` 之后调用 `appendModelCriteria(resolved, row.modelCriteria)`——模板项不可被覆盖（m1/m2 命名空间语义已在 `criteria-templates.ts` 实现并有单测）。
4. **漂移账本**：声明时 `logAgentMetric('model_criteria_declared', { taskId, count })`；合流时 `logAgentMetric('model_criteria_merged', { taskId, templateCount, modelCount })`。裁决漂移观测=对账两指标与 criteria satisfied/total 投影。
5. **gate 翻面**：`check-mandated-capability-is-live.cjs` 的 `appendModelCriteria` 条目由 `dark-defect` 翻 `live-required`，wiring 锚=工具注册点 + finalizer 合流调用点。
6. **测试**：工具校验矩阵（条数/长度/替换语义）、合流行为（模板+声明并集、模板不可覆盖）、账本两指标、projection 字段写读。

## 1.3 曝光决策

与 D2 criteria-self-check reminder 同门槛：结果型任务（multi_step/research/media/browser_transaction）曝光；direct_answer/short_task 不曝光（省 token 面，门槛是代码不是模型）。

# 2. D7 — LLM 维护回合生产接线

## 2.1 五缺口定案（对应 tier3-monitored closeout §4）

| 缺口 | 定案 |
|---|---|
| ① 生产驱动 | **crystallize tick 捎带**（`runtime.runCrystallizeRoundOnce` 内、decay 捎带先例同缝）；不建独立 scheduler——简单优先，6h 节奏与 EP2-C2 门控天然复用 |
| ② LLM 预算门控 | 三层代码闸：LLM 轮**自己的 durable lastRunAt**（settings 行 `maintenance.llmRound.lastRunAt`）进 `decideCrystallizeRun`（6h 内 skip=零调用，进程重启不重置）；**空信号跳过**（collect() 全空→不调用，audit 记 `no_signals`）；单轮单调用（deps.llm 合同既有） |
| ③ 符号禁令翻面 | `check-mandated-capability-is-live.cjs` maintenance 条目 `deferred-by-design`→`live-required`（wiring 锚=runtime 调用点）；`check-unwired-capability-markers.cjs` 撤销「必须标 unwired」断言，翻为「不得再标 unwired」；源码撤 `P5d/C26 unwired` 注记 |
| ④ staged 写监控 | 既有面复用：强制 staged 写（LLM 铸不出 active 卡）+ `maintenance_audit` metric（skip/run 全记）+ `getLastMaintenanceRoundStatus` 设置页快照（接线后从「未接入驱动」变真实状态）|
| ⑤ kill switch | 两级 AND：知识系统总开关（`isKnowledgeSystemEnabled`，已 gate 整个 tick）∧ 专项开关 `maintenance.llmRound.enabled`（settings 行，缺省=on；'false'=off）。任一 off 即零调用 |

## 2.2 生产 deps 装配

- `signals`：`lastRunAt` 取 durable settings 行；其余计数沿用 tick 的零值（门控退化为纯节奏闸，与 crystallize 同型）。
- `collect()`：v1 = staged 卡清单（store 真值）+ 近期 check-in 摘要（如 projection 有廉价列举面）；learningSummaries 留空至 learningDecision 写入端落地（四痛诊断项，独立流）——不造假数据。
- `llm(prompt, signal)`：走既有单发完成调用（与 agent 同 provider 配置）；provider 未配置→runner 面包屑降级（既有 catch 合同）。
- **不传** `collectDecaySignals/decayEffectors`：decay 已在 crystallize tick 捎带（live-required 在案），双跑=重复衰减。
- 成功后写回 durable lastRunAt（与 report 同事务语义：先跑后写，runner_error 不写——失败轮不占节奏窗口）。

## 2.3 测试合同

- 驱动行为：tick 触发→专项开关 off 零调用；6h 内二次 tick 零调用（durable lastRunAt）；空信号零调用；有 staged 信号→单调用+staged 写。
- gate：两个 gate 脚本翻面后 `verify:evolution-*` 相关链绿。
- 设置页快照：接线后 `getLastMaintenanceRoundStatus()` 非空。

# 3. 验证与记账

- 每件独立 pathspec 提交，真实退出码（`>log; echo EXIT=$?`）。
- D4/D7 完成后：`npm run typecheck`、相关焦点测试、`node scripts/check-mandated-capability-is-live.cjs`、`node scripts/check-unwired-capability-markers.cjs`、`node scripts/check-silent-catch.cjs` 全 EXIT=0。
- route §6.2 对应条目收账；deferred-register D4/D7 段补「已完成」注记。
