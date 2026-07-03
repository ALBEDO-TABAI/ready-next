---
title: Agent 模块系统性第一性原理评估（第一遍）+ 大改方向
date: 2026-07-03
status: assessment
enforce: false
scope: >
  ~519 文件 / ~153k 行的 agent 模块（agent-control 78.6k / tools 31.6k /
  browser-engine 21k / claude-bridge 13.6k / skills-runtime 8.5k）。
  本文是基于本轮全程实测证据的第一遍系统评估——非幻觉，凡结论均有代码/DB/日志锚点；
  但 153k 行的彻底再架构是多遍工程，本文是地基与方向，不是完工。
method: 第一性原理——问"agent 要更快/更多/更好，什么在挡路"，逐条对代码取证。
---

# 0. 先理解你的原始设计目标（不推翻，先看懂）

Ready = 集成式创作工作台，agent 要做到：**透明**（用户看得见在干什么）、**会成长**（用得越久越懂你）、**能浏览**（真实网页任务不中断）、**能完成**（理解需求、调动全部工具、闭环交付）。
架构基线是对的：收口 funnel（`finalizeRunOutcome` 单源）、裁决与执行分离、staged 隔离、DomainAdapter 去产品分支、SystemReminderRegistry、gate 文化——这些经本轮证据检验**全部成立**，不要推翻。问题不在骨架，在**接线、聚合与债务**。

# 1. 系统性发现（每条有锚点）

## 发现一（头号债务）：大量"建好但没通电"的子系统——成长/学习故事多为悬空
本轮我亲手接通了四处**建到规格却从未连生产**的能力：
- **学习闭环**（P2-5）：`learningRefs` **无写入者** → `projection.learningRefs` 恒空 → 专项 agent 进化提案永远 `skip missing_learning_refs`。**成长闭环从不触发**。
- **crystallize 结晶轮**（P2-1）：`CrystallizeScheduler` **从未实例化**。
- **belief 使用计数**（P2-4）：镜像 `access_count` **恒 0**，衰减/有用性无法度量。
- **criteria 落库**（P2-2）：验收标准算了不存，只进 divergence metric。

这不是四个孤立 bug，是**一种模式**：精巧子系统被"建到测试绿"就以为完成，却**没接到 live 路径**。grep 提示 reflection/emergence/user-picture 等可能同类。**根因**：没有"这个子系统在生产真的在跑吗"的可观测闸——测试绿 ≠ 通电。这是"感觉 agent 不成长/记忆不透明"的**真正技术根**（对应你最初四痛点之二）。

## 发现二：god-object 化——改动慢且危
- `runtime.ts` **4297 行 / 27 个 `private readonly` 协作者**（我本轮在里面接 crystallize/belief 计数，牵一发动全身）。
- `browser-tools.ts` **8484 行**（本轮 Phase B 已抽出 `browser-probe.ts` -431 行；但主体仍是 3000 行 `executeBrowserTool` if-链 dispatch + 交织的 schema/helper）。
- `orchestrator` / `skill-child-runner`(3560) / `skills-tools`(3055) 同类。
这些是**速度税**：每次触碰都要做依赖考古（Phase B 一个"纯"块都藏着 `ToolDomainError` 隐依赖）。

## 发现三：双运行时纠缠——维护税 + 认知混乱
- 权威现状（2026-06-16 doc）：**live = AgentSdkRuntime**；`turn-engine.ts`(4827, 生产 0 引用) 与 `DirectChatEngine` dormant。
- 但 `DirectChatEngine` **仍是 live 服务容器**（orchestrator 里 host 域适配器/技能上下文/浏览器控制器/sidecar/会话生命周期）。
- 且契约测试**冻结了已被取代的 2026-04-17 "TurnEngine 为 owner" 旧设计**（stale），与实际实现矛盾。C29/C30 退役**有前次规划失败**。
→ 一套活运行时 + 一套半死不活还挂着服务的旧运行时 + 冻结的旧设计契约 = 认知与维护双重税。

## 发现四：事件通道三重化
`agent:stream` + `scopeRunEvent` + projection 三通道载荷重叠，renderer 分别消费（P0 已复用改 UI）。单源未收敛 = UI 派生逻辑分散、旁路易增。

## 发现五：浏览器可靠性的真实天花板是"访问路径"，不是管线
本轮实测：采集管线（导航/抽取/污染检测/拒绝）本身正确工作；失败真因是 **XHS 对 agent 导航只出导航壳（反爬/门控）** + **写长文发布卡在编辑器最后一步**。即：`理解→计划→执行→复核`链是对的，**执行原语撞真实世界墙**（登录态/xsec_token/富编辑器）。这是能力上限项，非架构 bug。

## 发现六：模型 vs 代码的边界大体守得住，但"接线层"薄弱
路由/重试/状态机/预算/收口都在代码侧（好）。薄弱在**子系统间的接线与可观测**——建好的能力靠"记得去接"，没有强制接线的合同/gate（呼应发现一）。

# 2. 大改方向（按 ROI 排序，先接线后拆分再收敛）

## 方向 A（最高 ROI，最快见效）：**把已建好的通电**
成长/学习/记忆的能力**已经存在**，缺的是接线 + 可观测。做完这批，agent 立刻"更懂你、更透明"，几乎不需新建。
- 接通 reflection/emergence/user-picture 等剩余 dark 子系统（逐个查"是否 live 触发"）。
- 加**"通电闸"**：每个学习/维护子系统落一条 `*_wired`/`*_fired` 可观测账本 + 一个 gate 断言"该子系统在生产路径被调用"——把"测试绿=完成"升级为"通电=完成"。这直接消灭发现一的模式债。
- P2 剩余（criteria 前置注入自检 / belief-decay 接线）按登记表推进。

## 方向 B：**沿能力缝拆 god-object**（Phase B 做对的版本）
不做机械行数搬移，按**能力域**拆：
- `browser-tools.ts` → schemas / dispatch-router / {collection,power,media,navigation,observe} handlers / probe(已拆)。dispatch 从 8000 行 if-链 → 注册表 + 每能力一 handler 模块。
- `runtime.ts` → 把 27 协作者按域收敛成几个显式 service（memory/knowledge、run-lifecycle、browser-host、skill-host），runtime 只做组装。
- 每步 typecheck + 焦点测试绿，纯移动零行为。

## 方向 C：**收掉双运行时**（P3 Phase A/C，需监控+合同先行）
- 先把 DirectChatEngine 的服务职责显式迁给 orchestrator/SDK 持有者，再删；同步清掉冻结旧设计的 stale 契约测试（外科式）。
- turn-engine 生产零风险，但牵连 253 断言契约测试的 stale 部分——按 P3 计划分步。

## 方向 D：**事件单源**（P3 Phase D）
定义统一 run-timeline 事件模型，三通道收敛为其投影，renderer 全派生 + gate 防旁路。P0 的体验修复获架构地基。

## 方向 E：**浏览器执行原语强化**（提能力上限）
- 访问路径优先复用用户已渲染的可见 tab / 保 xsec_token 的站内跳转；高风控只出壳时走用户接管（本轮已把硬失败改可恢复）。
- 富编辑器发布走站点知识（本轮已加 XHS 写长文流程）+ 通用"必填项/发布按钮"探测原语。
- 这是让 agent"能做更多真实任务"的能力投资。

# 3. 执行建议
- **先 A 后 B/D，C 单独监控推进。** A 是"用已有能力立刻变强"，性价比最高，且直接解你最初痛点（成长不透明）。
- 153k 行的彻底评估建议用**多 agent 并行**（每子系统一个 explore+对抗验证 agent）做一遍权威 map + "dark 子系统"全量普查——本文是第一遍地基，全面普查值得一次专门的并行 workflow（需你开一句话授权）。
- 每个方向落地前按你的架构红线：先写机器可验证合同/gate，再动代码。

# 4. 一句话结论
你的 agent 骨架是对的，卡点不在设计而在**"建了没接"的接线债 + god-object 速度税 + 双运行时认知税**。把已建好的通电（方向 A）能以最小改动让 agent 立刻更懂你、更透明；随后按能力缝拆分与收敛，agent 会更快、更多、更好。**最好的 working agent 不需要重写，需要把你已经建好的东西真正接通、并让它们看得见。**
