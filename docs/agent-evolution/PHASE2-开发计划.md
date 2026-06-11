# 阶段二开发计划（配套 2026-06-11-agent-evolution-phase2-implementation.md）

> 合同是"做什么、验收什么"；本文是"按什么顺序做、并行度多少、风险在哪盯"。合同 v4 曾经 Codex 复核 APPROVED；2026-06-12 Codex 四轮复审再提 1 点（check_in_pending 扩展面补全：运行态 ScopeRunSummary/EventPayload union、ChatPanel badge 标签、awaiting-user helper），已回修为 **v5，待 Codex 复核确认后方可按波次开工**。

---

## 1. 工单总览与规模

| 工单 | 内容 | 规模 | 依赖 |
|------|------|------|------|
| Q1 | task_projections 质量列迁移（054）+ wire/repository 四字段全链 + 阶段一"053 必须最新"断言改写 + check_in_pending 全链路面扩展（运行态 ScopeRunSummary/EventPayload union + main union + sync 白名单 + IPC wire + renderer 副本 + user/badge 两种 UI 标签 + awaiting-user helper）| ~260 行 | 无 |
| Q2 | Criteria 模板引擎 | ~280 行 | Q1 |
| Q3 | Proof 五源采集（含 assistant_response digest；RunOutcome 增 finalText additive 字段 + done 收口传入） | ~280 行 | Q1 |
| Q4a | task-adjudicator shadow（产 CheckIn 不改终态 + 偏差 metric + gate + 偏差导出脚本；digest proof 先落后裁时序硬条款；CheckIn 覆盖按 RunOutcome.kind 枚举遍历不写死数量） | ~280 行 | Q2/Q3 |
| Q4b | adjudicator enforce（接管终态，零 proof 拒 done 生效） | ~160 行 | Q4a + 可执行转正门槛（≥50 run/≥3 天/≥4 类 task_type + false_reject=0） |
| Q5 | 待裁决队列 + 任务卡裁决出口（interaction_state，不碰生命周期 status） | ~240 行 | Q4b |
| Q6 | 质量红线入 verify:stability | ~40 行 | Q4b |
| K3 | RULES/index 注入（staged 禁令变注入面断言） | ~240 行 | 无（K1/K2 已合入） |
| K4 | RULES 默认内容 + 确认卫生文案 | ~120 行 | K3 |
| K6C | 真值源边界子合同（文档） | 文档 | 无 |
| K6 | 真值源边界落地（watcher/invalid/开关/启动接线） | ~260 行 | K6C 评审通过 |
| C1 | knowledge-index-builder | ~280 行 | 无 |
| C2 | 确定性门控 + crystallize 调度骨架 | ~220 行 | 无 |
| C6 | belief 衰减确定性子集 | ~180 行 | C1 |
| X1b | 任务索引增强 | ~140 行 | Q1 |
| X2 | 预算转向提醒（先 HEAD 勘探） | ~220 行 | Q4b |
| I-auth-D | 对象级授权设计补充（05 §3，文档） | 文档 | 无 |
| I1 | 状态优先决策序 | ~180 行 | 无 |
| I2 | 否定语义三层加深 | ~260 行 | I1 |
| I-auth | 对象级授权实现 + M3 预批准 | ~280 行 | I-auth-D 评审、I2 |
| T1 | 所有权矩阵 + run_meta 快照化 | ~240 行 | Q1 |
| T2 | 写方向 gate（warning 先行）+ malformed-ignored | ~200 行 | T1 |
| T3 | reconcile 泛化 | ~240 行 | Q4b |
| T4-3 | 重试分级收敛 | ~220 行 | 无 |
| E1 | 涌现内核 + 三类卡 | ~280 行 | Q1 |
| E2 | 意图流视图 + 行动出口 | ~300 行 | E1、Q5 |
| B1 | 批量执行 spike（报告） | 报告 | 无（并行长线） |
| G2 | verify 链 + 文档同步 + P 系列核销 | ~80 行 | 全部 |

合计 ~5000 行 diff + 三个文档单，代码单全部满足"单单 ≤300 行、10 分钟自验"纪律。

## 2. 波次排布（关键串行点：run-finalizer.ts 经 Q4a→Q4b→T3；prompt-assembly.ts 经 K3→X1b；tool-executor.ts 经 I2→I-auth）

```
波次 0（文档先行，与波次 1 并行评审）
  K6C 真值源子合同      I-auth-D 授权设计补充      B1 spike 启动（长线）

波次 1（全并行）
  Q1 质量列迁移         K3 RULES/index 注入
  C1 index-builder      C2 门控骨架
  I1 状态优先           T4-3 重试收敛

波次 2（依赖波次 1）
  Q2 Criteria（Q1 后）   Q3 Proof（Q1 后）
  X1b 索引增强（Q1 后；K3 合入后再碰 prompt-assembly）
  T1 账本矩阵（Q1 后）   E1 涌现内核（Q1 后）
  K4 文案（K3 后）       C6 衰减（C1 后）       I2 否定加深（I1 后）

波次 3（串行关键路径）
  Q4a adjudicator shadow（Q2/Q3 后；run-finalizer 串行窗口开启）
  T2 写方向 gate（T1 后，warning 模式）
  K6 真值源落地（K6C 评审通过后）

波次 4（Q4a shadow 期跑真实使用、复核偏差清单后进入）
  Q4b enforce（偏差清单复核通过后接管终态）
  I-auth 实现（I-auth-D 评审 + I2 后）

波次 4.5
  Q5 裁决出口（Q4b 后）   T3 reconcile（Q4b 后）   X2 预算转向（Q4b 后，先勘探）

波次 5
  E2 意图流视图（E1 + Q5 后）   Q6 红线入 stability
  B1 spike 报告评审

波次 6
  G2 收口（verify:evolution-p2、CLAUDE/AGENTS 同步、08 表 P 系列核销、阶段门核对）
```

单执行者建议顺序：Q1 → K3 → C1 → I1 → T4-3 → C2 → Q2 → Q3 → X1b → T1 → E1 → K4 → C6 → I2 → Q4a → T2 → K6 →（shadow 期偏差复核）→ Q4b → I-auth → Q5 → T3 → X2 → E2 → Q6 → G2。

## 3. 开关与灰度

| 开关 | 默认 | 说明 |
|------|------|------|
| RULES/index 注入 | 开（预算截断 + context_bill 可观测） | 回退 = 关注入段，K1/K2 存储不动 |
| adjudicator 裁决 | Q4a=shadow（产 CheckIn + 偏差 metric，不改终态）；Q4b=enforce（合同内置两单，不是部署开关） | 转正前置 = 可执行门槛（合同 Q4b 前置四条）：≥50 终态 run 且 ≥3 自然日、≥4 类 task_type（必含 direct_answer/multi_step_task）、`export-adjudicator-divergence.cjs` 导出清单 `false_reject`=0、复核清单入 repo 留痕 |
| 写方向 gate | warning 模式跑一个版本 | 存量违规清单收齐后小单转 error |
| belief 衰减新分支 | 开（与时间衰减并存一个版本，可回退） | 升降档审计行可查 |
| 意图流视图 | 开（≤8 张 + confidence 门槛 + 类型可关） | 噪音失控先关 extractor 不下视图 |
| M3 预批准（I-auth） | 关，评审通过后灰度开 | M1 永不受影响；禁缓存解禁仅随 I-auth 一起 |

## 4. 风险与盯防

1. **Q4a/Q4b 是全阶段最大风险段**：动 run-finalizer 必须通道内扩展，funnel gate 全程绿；shadow→enforce 拆成两单是合同条款（消除"影子期不改终态"与"零 proof 立即降级"的验收矛盾）；finalizeRunOutcome 内时序 = digest proof 先落账、verdict 后裁决（合同硬条款，防 direct_answer 结构性零 proof 误伤）；转正按 Q4b 前置四条可执行门槛走，不靠人感觉放行。
2. **X2 依赖预算账本健康**：历史上存在 checkpoint 仅耗尽写/续跑重置用量等半态；勘探结论先写入工单，半态先修或显式声明边界。
3. **K6 是文件系统级改造**：watcher 幂等与回滚开关必须在子合同里写成可机器验证断言再开工。
4. **T2 收紧可能暴露存量违规**：warning 先行是合同条款不是建议。
5. **E2 触 renderer**：UI 只消费 projection；视觉以 workbench 极简基准，避免新视图自立一套样式。
6. **B1 spike 与生产隔离**：实验代码不进主线；高风控站点硬拦不因 spike 放宽。
7. **08 表 P 系列核销是阶段门**：G2 收口时按合同 G2 的 P1-P10 核销表逐行核对（P6/P7/P10 为"仅复核状态"行），缺一不放行。
8. **G2 最终门是可执行口径**：强制绿 = evolution-p2 链 + stability + native + typecheck；全量 test 按"基线失败清单不新增"判定（清单在合同 G2 内，归 base 分支收口）。
