# 阶段三开发计划（配套 2026-06-12-agent-evolution-phase3-implementation.md）

> 合同是"做什么、验收什么"；本文是"按什么顺序做、并行度多少、风险在哪盯"。合同 approved v3（2026-06-12 Codex 三轮复审 4 点全 PASS / enforce: true），可按波次开工（A1 先行含 055/056，PK1=057 在 A1 合入后）；遗留轨 R 样本时钟起点=253b6768，且 typedTerminalRuns === totalTerminalRuns（unknown=0）为硬条件。

## 1. 工单总览

| 工单 | 内容 | 规模 | 依赖 |
|------|------|------|------|
| A1 | agents 表（仅主 agent 行）+ registry + **055/056 连号迁移（agents + ownerAgentId 列全链，Q1 范式，写值唯一归 A4）** | ~260 行 | 无 |
| A2 | per-agent 注入**底座**（owner 参数化 + fixture 测试；端到端归 A4） | ~240 行 | A1（K3 已合入） |
| A3 | charter/routing 索引注入主 agent 会话 | ~180 行 | A1/A2 |
| A4 | agent_propose_handoff + 转办卡 + 同会话归属切换 | ~300 行 | A3 |
| C3 | LLM 维护回合 + SubAgent 容器 + C6 衰减真实信号接线 | ~280 行 | C1/C2/K1-K3 已合入 |
| C4 | CAS 合并（USER.md 决策门） | ~220 行 | C3 |
| C5 | 涌现候选维护 + 建议卡投影 | ~260 行 | C3 |
| PK1 | packet 列迁移（**057**，在 A1 的 055/056 之后）+ wire/repository 全链 + 两层校验 | ~220 行 | **迁移编号上依赖 A1 先合入** |
| PK2 | 编译器资产 + 触发门槛（direct_answer 永不分包） | ~240 行 | PK1 |
| PK3 | 三通道查表分发 + verbatim 注入（09 篇 PK3→I4 依赖由本单内置子项满足） | ~260 行 | PK2 |
| PK4 | 汇总包 + 子包失败三选一 + 上行 CheckIn（Q4a 通道） | ~280 行 | PK3 |
| I4 | 最小传话**收口单**（handoff 子项 + 残余转发点 + 全局逐字断言矩阵；非 PK3 前置） | ~160 行 | A4、PK3 |
| B4 | locator 唯一性/snapshot 陈旧守卫 | ~240 行 | **R-B1 报告** |
| B5 | planner 降级 + workflow 接包 | ~260 行 | I4、PK3、R-B1 |
| E3 | 反馈日志 + 卡类型开关 | ~200 行 | **R-E2** |
| E4 | 权重漂移 → preference 卡 | ~200 行 | E3、C3 |
| G3 | verify:evolution-p3 + 文档同步 + 08 回填 + I5 复核核销 | ~80 行 | 全部 |
| 遗留轨 R | Q4b→Q5→{T3,X2}→E2→Q6→G2 + B1（定义见阶段二合同 v7） | — | shadow 门槛/真实浏览器 |

## 2. 波次排布

```
波次 0（解锁检查，随时重跑）
  R 轨门槛核对：export-adjudicator-divergence --since 253b6768 起算；≥50 run 且 typed===total（unknown=0）/≥3 天/≥4 类/false_reject=0
  R-B1 spike 窗口排期（真实浏览器）

波次 1
  A1 agents 表（含 055/056 迁移，**先行**）
  C3 维护回合（C 轨独立并行）
  PK1 packet 列（057，**A1 合入后**——迁移编号连续 gate 约束）

波次 2
  A2 注入覆盖（A1 后）  PK2 编译门槛（PK1 后）
  C4 CAS（C3 后）       C5 候选（C3 后）

波次 3
  A3 routing 注入（A2 后）   PK3 通道分发（PK2 后）

波次 4
  A4 handoff（A3 后）        PK4 失败上行（PK3 后）

波次 5
  I4 传话收口（A4+PK3 后）   E3（R-E2 解锁后）
  B4（R-B1 评审后）

波次 6
  B5（I4+PK3+R-B1）          E4（E3+C3）

波次 7
  G3 收口
```

单执行者建议顺序：A1 → PK1 → C3 → A2 → PK2 → C4 → C5 → A3 → PK3 → A4 → PK4 → I4 →（R 轨解锁窗口：Q4b→Q5→E2 插队）→ E3 → B4 → B5 → E4 → R 轨余单 → G3。

## 3. 开关与灰度

| 开关 | 默认 | 说明 |
|------|------|------|
| agents 表 | 仅主 agent 行（= 现状） | 专项 agent 行只经 A4 采纳/未来 A6 派生进入 |
| LLM 维护回合 | 经 C2 门控（skip 即零调用） | 回退 = 门控强制 skip，确定性轮不受影响 |
| packet 编译 | 门槛代码判定（direct_answer 永不分包） | 回退 = 门槛常闭，单任务路径不变 |
| 转办建议卡 | 开（M4 建议性，采纳须用户点击） | 关闭 = 工具不暴露 |
| 意图流卡类开关 | E3 起逐类可关 | 总上限 ≤8/单类 ≤3 不变 |
| B4/B5 | R-B1 评审通过前不存在 | 高风控站点硬拦永不放宽 |

## 4. 风险与盯防

1. **A 轨最大风险=注入污染**：A2 必须证明跨 agent 谱系零泄漏（C4.3 纪律延伸）；A3 只进主 agent 会话——专项会话注入彼此 charter 即违规。
2. **C3 是首个 LLM 维护回合**：烧 token 风险靠 C2 门控 + 摘要信源 + 空轮合法；写坏卡靠 memory_write_card 校验 + C1 代码重建兜底。
3. **PK 轨与 agent-sdk-runtime 抢文件**：A4/I4/PK3 三单触碰，按波次错开（3/4/5），单内 additive。
4. **遗留轨插队窗口**：shadow 门槛随真实使用随时可能满足——满足即优先 Q4b→Q5→E2（E3 被其阻塞）；R 轨工单全部按阶段二合同 v7 执行，本阶段不改其定义。
5. **B 轨双前置**：B1 报告 + I4/PK3；任何"先写守卫后补报告"的倒序都是违规。
6. **静默吞失败**：PK4 的测试红线（子包失败必须三选一 + 上行）是阶段门级断言。
