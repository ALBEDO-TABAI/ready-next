---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Agent Core Loop And Runtime Host Design

**Date:** 2026-04-09

## Goal

为 Ready 的下一阶段 agent 主控收口先定清一件事：

**核心循环到底应该由谁负责，运行时宿主到底应该收哪些职责，哪些职责必须从当前大文件里拆出去。**

这份规格不直接进入 Hermes 对照，也不直接写实施清单。它只解决当前项目内部的结构问题：

- 当前主控链路真实是怎么跑的
- 当前主控为什么容易职责打结
- 下一版主控应该分成哪些稳定层
- 这些层各自的边界、输入、输出和不该再做的事是什么

完成这一步之后，下一步再用这份规格去做 **Hermes Agent vs Ready 当前主控** 的交叉比对，并基于差异列改进计划。

## Scope

本规格只覆盖：

- `runtime -> orchestrator -> direct-chat -> tools/browser` 这条核心执行链
- prompt 组装如何进入主控循环
- tool 可见性、tool 调用和 tool 结果如何回到运行时
- scope run 摘要、任务卡投影、会话级恢复信息如何进入前台
- 浏览器任务为什么会成为主控拆层的第一压力点

本规格不覆盖：

- Hermes 的详细优缺点对照
- 浏览器执行器内部细节改造计划
- 跨会话搜索与回看
- 记忆可插拔与长期记忆策略
- 飞书替换与远程通道改造计划
- 文件级实施步骤与 commit 颗粒度

## Study Inputs

### 当前 Ready 主链

- `src/main/modules/claude-bridge/direct-chat.ts`
- `src/main/modules/agent-control/runtime.ts`
- `src/main/modules/agent-control/orchestrator.ts`
- `src/main/modules/agent-control/prompt-assembly.ts`
- `src/main/modules/agent-control/tool-gateway.ts`
- `src/main/modules/agent-control/session-continuity.ts`
- `src/main/modules/tools/browser-agent-runner.ts`
- `src/main/modules/tools/browser-tools.ts`
- `src/renderer/components/agent/ChatPanel.tsx`
- `src/renderer/modules/agent/scopeRunState.ts`

### 当前文档依据

- `docs/archive/2026-09-06/docs/superpowers/plans/2026-04-08-hermes-agent-inspired-agent-browser-roadmap.md`
- `docs/archive/2026-09-06/docs/superpowers/specs/2026-04-08-hermes-inspired-browser-agent-architecture-design.md`
- `DOCUMENTATION.md`
- `PROGRESS.md`
- `LESSONS_LEARNED.md`

## Current Structure In Ready

### 1. 当前其实有两条“主控”在叠加

Ready 现在不是单一的 agent runtime，而是两条链叠在一起：

1. **运行时宿主链**
   - `AgentControlRuntime` 负责 scope、消息、远程通道、定时任务、memory lifecycle、scope run summary。
   - 它对外是“统一运行时”，但内部已经同时承担了 control plane、conversation persistence、run summary projection、channel bridge 等多种职责。

2. **直接聊天执行链**
   - `ClaudeSdkOrchestrator` 负责把 session 级调用转给 `DirectChatEngine`，并把事件重新包装为 session-aware 输出。
   - `DirectChatEngine` 实际持有 provider 调用、tool loop、browser decision、skill 保留策略、document/design/browser 特判、工具桥接、流式输出和回退逻辑。

结果是：

- `runtime` 像宿主
- `orchestrator` 像适配层
- `direct-chat` 又像真正的核心循环

但三层之间没有一个明确的“loop ownership”。

### 2. `runtime` 已经不只是 runtime

`AgentControlRuntime` 当前至少同时承担了：

- scope / conversation 的数据库宿主
- prompt assembly 的入口
- orchestrator 的装配和驱动
- sidecar / remote channel 的控制面
- scope run summary 的结构化维护
- 自动反思和记忆写回入口
- cron / channel / inbound aggregation 的业务编排

这说明它现在更接近 **control plane + conversation runtime facade**，而不是一个纯执行循环本体。

### 3. `orchestrator` 已经很薄，但边界还不够明确

`ClaudeSdkOrchestrator` 当前做了三类事：

- 持有 `DirectChatEngine`
- 维护 session/task state 的轻量表象
- 把 engine 的 output/status/error 重新归一化后转发给外层

它的优点是薄，但当前薄得还不够“有主见”：

- 它没有成为真正的 run coordinator
- 它也没有成为 provider/runtime host
- 它更像一个 transport-style wrapper

也就是说，现在真正的 loop intelligence 仍然在 `DirectChatEngine`。

### 4. `direct-chat` 现在是事实上的核心循环宿主

`DirectChatEngine` 当前直接负责：

- session message 累积
- multimodal 入参归一
- provider 能力判断
- tool 可见性与保留策略
- browser task decision / continuity injection / deterministic runner 选择
- document/design/browser 专项 nudges
- text tool bridge 与 native tools 双轨处理
- tool loop 的迭代上限、回退与结束条件
- 流式输出事件发射

这使它变成了一个 4000+ 行的“超级循环宿主”，既有 provider loop，又有产品策略，又有模块特判。

当前最大的问题不是“它太大”本身，而是：

**不同抽象层的决策都在这里发生。**

### 5. prompt assembly 已经独立，但只独立了前半段

`PromptAssemblyService` 现在已经从主控里抽出，负责：

- L0/L1/L2 记忆拼装
- trigger 命中
- context budget 控制
- bootstrap message 注入
- run outcome 写回

这层已经是一个较清楚的独立单元。

但它现在仍然只解决“把 prompt 准备好”，还没有和后续 loop host 形成更正式的合同，比如：

- prompt assembly 结果由谁消费并持久化
- tool policy / capability policy 在 prompt assembly 之前还是之后决定
- memory refs / trigger hits / run summary 到底归谁拥有

### 6. tool gateway 还不是正式的 tool dispatch 边界

`ToolGateway` 现在更像元数据目录：

- 能列出工具分组
- 能按模块列出能力
- 能数工具数量

但它不拥有真正的执行路径，不控制：

- 哪些工具当前对模型可见
- 当前 run 能用哪些 tool family
- native tool / text bridge / deterministic module action 怎么选
- tool result 如何回收成结构化运行态

这些关键决策仍然散在 `direct-chat`、`tools/index`、`executeToolCall` 和模块级 helper 中。

### 7. 浏览器任务是当前主控拆层压力最大的来源

浏览器链已经先暴露出主控问题：

- planner 在 `direct-chat` 决定是否走 deterministic runner
- runner 自己还要维护阶段、证据、连续性和 task projection
- tool loop 仍然可能走浏览器工具面
- diagnostics / scope run summary / ChatPanel 又要消费这些结果

所以浏览器不是“额外功能”，而是当前主控拆层中最先把边界问题放大的模块。

## Core Problems To Solve

### 问题 1：loop ownership 不明确

当前看上去像三层：

- runtime
- orchestrator
- direct-chat

但真正的执行循环、tool policy 和模块策略大多在 `direct-chat`。

这会带来两个后果：

- `runtime` 名义上是运行时，实际上不是 loop owner
- `orchestrator` 名义上是编排层，实际上也不是协调中心

### 问题 2：control plane 和 run-time plane 混在一起

`runtime.ts` 里既有：

- channel/schedule/control plane

又有：

- sendScoped / inbound execution / scope run summary / reflection trigger

这导致：

- 会话宿主、任务宿主、远程通道宿主、记忆宿主没有被明确拆开
- 后续只要想增强 loop，就容易被 channel / cron / scope summary 这些控制面职责绊住

### 问题 3：tool policy、module policy、provider policy 交错

当前在一次 sendMessage 里会同时决定：

- provider wire protocol
- native tools vs text bridge
- 是否保留 tools（尤其视频/skill 场景）
- document/design/browser 特定的 policy
- browser deterministic vs tool loop
- 最大 tool iterations

这些决策并不在同一抽象层上，但都挤在同一个 run loop 方法里。

### 问题 4：scope run summary 目前仍偏“后置整理”

虽然当前已经有结构化 run state，但仍然存在两个现象：

- 一部分任务状态来自显式字段
- 一部分任务状态仍然要从阶段文本中推断

这意味着 run projection 还没成为真正的正式产物层。

### 问题 5：浏览器连续性已经存在，但不是正式 loop state

`session-continuity.ts` 已经在记录：

- 最近动作
- 最近浏览器工作流
- 最近技能运行

但它当前仍是浏览器域的“辅助上下文”，还不是 loop host 正式依赖的 session execution memory。

## Design Principles

### 原则 1：先明确谁是 loop owner，再谈拆层

不能继续让：

- runtime 像 loop owner
- orchestrator 像 loop owner
- direct-chat 也像 loop owner

下一版必须明确只有一个层负责：

- 单次 run 的主循环
- tool turn 的推进
- 中断/取消/完成判断

### 原则 2：control plane 与 run-time plane 分开

下一版要把“运行一个任务”和“管理整个系统”拆开：

- control plane 负责 scope、channel、schedule、persistence、health
- run-time plane 负责一次会话请求如何被执行、如何推进、如何结束

### 原则 3：prompt assembly、tool dispatch、run projection 都要成为正式合同

它们不能再只是“大文件中的一个阶段”，而应该是独立层：

- Prompt Assembly：负责准备输入上下文
- Tool Dispatch：负责决定工具暴露与执行路径
- Run Projection：负责把结构化执行态投影到 scope run / ChatPanel

### 原则 4：浏览器 orchestration 是 run-time plane 的子域，不再塞回 engine 主体

浏览器决策和浏览器执行可以继续非常强，但它们应当是 loop host 可调用的域能力，而不是 engine 主体自己的大量内联策略。

## Chosen Architecture

### Layer 0: Agent Control Plane

这一层由当前 `AgentControlRuntime` 收口，但职责要被重新定义为：

- scope / conversation lifecycle
- channel / sidecar / cron / inbound aggregation
- persistence / repository access
- runtime health / heartbeat
- run summary store 的宿主

它**不再直接拥有复杂 loop intelligence**。

它是系统宿主，不是单轮执行器。

### Layer 1: Run Coordinator

这是当前最缺的一层。

它负责一轮 run 的正式生命周期：

- 接收 scope + message + requestId
- 调用 prompt assembly
- 选择 execution host
- 维护本轮 run 的开始 / 更新 / 完成 / 失败 / 取消
- 保证 scope run summary 和 stream event 的一致性

它是 **单轮执行的正式 owner**。

当前最接近这层的位置是 `orchestrator + runtime.sendScoped` 的组合，但还没有形成一个清楚单元。

### Layer 2: Execution Host

这一层承接当前 `DirectChatEngine` 的主体能力，但边界要明显收紧：

- provider request/response loop
- tool loop turn-taking
- session message buffer
- stream output emission
- provider fallback / bridge fallback

它不再直接承载大量产品域策略。

换句话说，Execution Host 只负责：

**模型怎么与工具循环往返。**

它不直接决定浏览器要怎么规划，也不直接决定 document/design/browser 的业务策略细节。

### Layer 3: Prompt Assembly Contract

`PromptAssemblyService` 保持独立，但合同要明确：

- 输入：scope + incoming message + recent conversation
- 输出：system prompt + bootstrap blocks + trigger hits + memory refs + budget report

它不负责：

- tool policy
- module policy
- provider policy
- run summary

Prompt Assembly 是 run coordinator 的前置输入构造器，而不是 runtime 的隐性附属品。

### Layer 4: Tool Capability + Dispatch Layer

当前 `ToolGateway` 需要从“目录”升级为正式边界，但这份规格先定义边界，不定义实施方案。

这一层未来必须能回答：

- 本轮 run 能暴露哪些工具组
- 哪些工具只对宿主开放，不对模型开放
- 当前是 native tools、text bridge、还是 deterministic module action
- tool result 该如何回写为统一运行态

这层的重点不是“多一个 registry”，而是成为：

**tool visibility + tool routing + tool execution mode** 的唯一真相。

### Layer 5: Domain Orchestration Units

浏览器、文档、设计、RSS、Calendar 这类模块应当是 loop host 的域单元，而不是 engine 大量内联分支。

其中浏览器是第一优先子域，应至少包括：

- browser planner
- browser deterministic runner
- browser continuity
- browser structured task projection

但它们作为 **domain orchestration unit** 被调用，而不是继续塞在 Execution Host 本体里。

### Layer 6: Run Projection Layer

scope run summary、message-level task snapshot、ChatPanel 恢复态，需要从 loop 中独立出来，成为正式输出层。

它要消费的是：

- prompt assembly metadata
- execution host events
- structured tool results
- domain orchestration payloads

它不应该再主要依赖阶段文本猜测。

## Responsibility Matrix

| 层 | 负责什么 | 不再负责什么 |
|---|---|---|
| Control Plane | scope、channel、schedule、repo、health | 单轮执行主循环 |
| Run Coordinator | 单轮 run 生命周期、assembly 接入、execution host 选择、summary 一致性 | provider 协议细节、域内业务策略 |
| Execution Host | provider loop、tool loop、stream 事件 | browser/document/design 的大量产品特判 |
| Prompt Assembly | system prompt、bootstrap、memory refs、trigger hits | tool policy / module policy |
| Tool Dispatch | tool visibility、tool routing、execution mode | conversation persistence |
| Domain Orchestration | 浏览器/文档等模块的高层策略与结构化执行 | provider loop 基础能力 |
| Run Projection | scope run summary、ChatPanel task snapshot | 实际工具执行 |

## What Should Change First

### 第一优先：先补 Run Coordinator，而不是先重写 engine

当前如果直接拆 `DirectChatEngine`，容易在 provider、tool bridge、browser policy 三块同时失血。

更稳的顺序是：

1. 先在 `runtime/orchestrator` 之间补出真正的 run coordinator 概念
2. 明确 prompt assembly、execution host、run projection 的调用顺序
3. 再逐步把 browser/document/design 这类域策略从 engine 主体抽走

### 第二优先：把浏览器 orchestration 视作主控拆层的试金石

浏览器链已经是当前最复杂、最前台、最容易出边界问题的子域。

所以浏览器不是“一个模块要配合主控拆层”，而是：

**主控拆层是否成功，首先看浏览器链能否接到新边界上。**

### 第三优先：tool gateway 先补边界定义，不急着大改工具列表

当前最急的是让 tool dispatch 有正式边界，而不是立刻重做能力矩阵。

换句话说，这一步先收口“怎么判断和怎么路由”，不先扩展“能看到多少工具”。

## Explicit Non-Goals For This Spec

- 不在这一步设计 Hermes 对照表
- 不在这一步产出实施任务清单
- 不在这一步重写 `direct-chat.ts`
- 不在这一步决定 memory / cross-session / capability grouping 的最终方案
- 不在这一步讨论 UI 入口细节

## Acceptance Criteria For This Spec

当后续进入 Hermes 对照与实施计划时，这份规格至少要能支持以下判断：

1. 当前主控链路的 loop owner、control plane、execution host 已经被明确区分。
2. prompt assembly、tool dispatch、run projection 三个边界已经被正式命名，而不是继续当作大文件内部阶段。
3. 浏览器 orchestration 被明确视为 domain orchestration unit，而不是 engine 主体内联策略。
4. 后续可以基于这份规格，单独去做 “Hermes vs Ready 当前主控” 的交叉比对，而不用重新解释 Ready 内部结构。

## Next Step

下一步不是直接改代码，而是基于这份规格做一次正式交叉比对：

- Hermes 的 loop owner 在哪里
- Hermes 的 provider/runtime/tool dispatch 边界如何划分
- 哪些点比 Ready 当前更稳定
- 哪些点 Ready 因为产品内宿主特性不能照搬
- 最后再基于差异列一份局部改进计划

也就是说：

**这份规格先把 Ready 自己讲清楚，下一步再讲 Ready 和 Hermes 的真正差异。**
