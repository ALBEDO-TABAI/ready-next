# Agent Evolution 阶段四开发计划

> 合同是"做什么、验收什么"；本文是"按什么顺序做、并行度多少、风险在哪盯"。
> 合同：`docs/superpowers/plans/2026-06-13-agent-evolution-phase4-implementation.md`（**draft v2，一轮评审 6P1/3P2 已吸收，待复审；评审通过前不开工**）。
> 阶段三基线：主轨 13 单全部收口（整轮审查零 P1），回归入口 `verify:evolution-p3`。

## 1. 工单总览（7 单 + 收口）

| 工单 | 内容 | 前置 | 规模 |
|------|------|------|------|
| EP4-K-mirror | agent 作用域卡进镜像/衰减/维护信源 | 无 | ~200 |
| EP4-A5 | 会话创建预路由 + agent_auto_routing 设置项 | A4（已合入）、I1（已合入） | ~290 |
| EP4-A6a | AgentFactory 派生数据层（迁移 058 + 种子 RULES + 迁移清单） | A5 | ~300 |
| EP4-A6b | 派生确认 UI + 采纳闭环 | A6a | ~300 |
| EP4-A7 | 退休/合并 + agent 列表管理 UI | A6b | ~300 |
| EP4-B6 | 失败 → 站点卡学习回路 | Q4a + C3（均已合入） | ~260 |
| EP4-E5 | prepare/harvest/forming 三类卡内核 | E1（已合入） | ~280 |
| EP4-G4 | verify:evolution-p4 + 文档同步 + 08 回填 | 全部 | ~80 |

## 2. 波次排布

```
波次 0（解锁检查，随时重跑）
  遗留轨 R 门槛核对：export-adjudicator-divergence --since 253b6768
  （Q4b 链解锁后 E3/E4 插队；R-B1 评审通过后 B4/B5 插队——均按阶段二/三合同执行）

波次 1
  K-mirror（独立，地基先行）    A5 预路由（A 轨起步）

波次 2
  A6a 派生数据层（A5 后）       B6 站点卡学习（独立并行）

波次 3
  A6b 确认 UI + 采纳闭环（A6a 后）   E5 剩余卡类内核（独立并行）

波次 4
  A7 生命周期（A6b 后）

波次 5
  G4 收口
```

单执行者建议顺序：K-mirror → A5 → A6a → A6b → A7 → B6 → E5 →（遗留轨解锁窗口：Q4b→Q5→E2 / B1 评审插队）→ G4。
B6/E5 无 A 轨依赖，A 轨任何单被评审卡住时可前移。

## 3. 开关与灰度

| 开关 | 默认 | 说明 |
|------|------|------|
| agent_auto_routing | suggest | off=会话创建零行为变化；auto 仅先例命中直建+可改回；派生永远确认 |
| 派生流程 | 仅经候选卡确认对话 | 无候选卡确认 = 不存在派生入口（无确认自动派生永不做） |
| routing 卡生效 | 落盘即 staged | 确认流勾选"立即生效"才 active；staged 不参与 A5 先例匹配 |
| 站点卡学习 | 确定性 extractor 常开 | 只产 staged 卡/证据行；风险变更走建议卡待确认 |
| 剩余卡类 | 随既有 emergence 开关 | 继承 ≤8/单类 ≤3/confidence/可关闭四重控制 |

## 4. 风险与盯防

1. **A 轨最大风险 = 路由误判打扰**：suggest 档是默认，建议条必须可一键忽略；continue 类回原 agent 是硬断言（误路由代价=多走一站，但 continue 断链是真伤害）。
2. **派生最小化纪律**：种子 RULES 只种证据支持的内容——LLM 产物用户可改且确认前不落盘；知识迁移逐项勾选、文件级可逆。
3. **B6 不碰拦截语义**：学习回路对硬拦清单零写权；对既有卡（含 active）零自动改写——更新一律产 staged 旁卡（possible-update-of），用户确认才并入。
4. **E5 噪音控制**：harvest 卡在 R-E2 解锁前只有内核+接口，不投影到任何用户面；文件树消费 forming/prepare 时 UI 数据形状不变（零视觉回归）。
5. **共享文件**：belief-card-store/mirror（K-mirror 先于 B6）；agent-registry-repository（A6a→A7 串行）；emergence-cards（E5 与遗留轨 E3 协调）；agent-sdk-runtime 零触碰。
6. **迁移编号**：合同固定 A6a=058；若开工时 058 已被（如遗留轨）占用，**必须先修订合同再开工**，不得擅自顺延（连续 gate `check-migration-numbering-sequential.cjs` 约束）。

## 5. 验证入口

- 阶段回归（G4 后）：`npm run verify:evolution-p4`
- 终验门：`verify:evolution-p4 && verify:evolution-p3 && verify:evolution-p2 && verify:evolution-p1 && verify:stability && typecheck`
- 全量 test 口径：基线失败清单不新增（清单归 base 分支）。
