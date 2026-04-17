# Claude Code Vs Ready Agent Gap Analysis

**Date:** 2026-04-17

## Goal

把 `CC-Source` 的 Claude Code agent 设计和 Ready 当前 agent 主链做一次“抄答案式”交叉比对，明确：

- Ready 当前哪些地方已经有正确方向。
- 哪些地方只做了一半。
- 哪些结构问题会持续拖慢 Browser / Document / Skill / Remote IM。
- 下一轮整改应该先动哪一层。

## Current Ready Inputs

- `src/main/modules/agent-control/runtime.ts`
- `src/main/modules/agent-control/orchestrator.ts`
- `src/main/modules/agent-control/run-coordinator.ts`
- `src/main/modules/agent-control/prompt-assembly.ts`
- `src/main/modules/agent-control/execution-intent-resolver.ts`
- `src/main/modules/agent-control/task-type-resolver.ts`
- `src/main/modules/agent-control/task-execution-router.ts`
- `src/main/modules/agent-control/tool-gateway.ts`
- `src/main/modules/tools/tool-executor.ts`
- `src/main/modules/claude-bridge/direct-chat.ts`

## Executive Summary

Ready 现在的问题，不是“没有拆模块”，而是：

**拆出来的模块还没有形成稳定的真相归属。**

当前 Ready 已经有：

- `RunCoordinator`
- `RunProjection`
- capability grouping
- budget runtime
- task projection
- browser/document domain orchestrator

这些都说明方向不差。

但真正影响效果的部分，仍然集中在下面三点：

1. `DirectChatEngine` 仍然是事实上的超级宿主。
2. 工具层仍然只是“字符串前缀分发 + 字符串结果”。
3. runtime / execution / domain / projection 之间还没有形成“谁说了算”的单一真相链。

## 1. 现状对照表

| 维度 | Claude Code 做法 | Ready 当前现状 | 直接后果 | 优先级 |
| --- | --- | --- | --- | --- |
| 主循环 owner | `query.ts` 是单一执行真相 | `runtime -> orchestrator -> direct-chat` 三层都像主控，但真正智能大多在 `direct-chat` | 维护者无法快速判断“这一轮究竟谁负责” | P0 |
| 工具契约 | `Tool` 是完整对象，含并发、权限、中断、展示、结果映射 | `ToolGateway` 更像目录，`tool-executor` 主要按前缀路由 | 调度、权限、UI、结果语义无法复用同一份定义 | P0 |
| 工具调度 | 调度依据来自工具自身声明 | 并行策略来自独立 policy，执行器本身不知道每个工具的完整行为 | 工具扩展越多，主循环越容易继续堆特判 | P0 |
| 工具结果 | 工具结果是结构化 message / tool_result block | 多数工具回给主链的是字符串 | projection、UI、恢复、诊断拿不到稳定语义 | P0 |
| 消息真相 | transcript / progress / attachment 明确分层 | run event、task payload、聊天文本、tool result 多条通路并存 | 前台展示和执行真相容易分叉 | P1 |
| 子 agent | agent 是正式基础设施能力 | Ready 目前更偏单主 agent + domain executor | 无法自然演进到 worker / 子任务 / 后台协作 | P1 |
| 领域接入方式 | 多通过 tool contract 和 message attachment 接入 | Browser / Document / Skill 大量靠 `DirectChatEngine` 分支注入 | 主循环仍然被产品细节侵蚀 | P0 |
| continuation | 沿消息/转录/执行状态延续 | 依赖 task projection + prompt hints + session lookup | 恢复可用，但归属仍偏软 | P1 |
| prompt 策略 | system prompt 重要，但不是唯一结构来源 | `TOOL_SYSTEM_PROMPT` 承担太多产品规则和行为纠偏 | 规则一多就继续膨胀 prompt，而不是补抽象 | P1 |
| capability 暴露 | tool pool 装配独立于主循环 | capability group 已开始起作用，但更多解决“开哪些工具” | 只能解决工具可见性，不能解决执行语义 | P1 |

## 2. Ready 当前最核心的五个问题

### 2.1 `DirectChatEngine` 仍然是超级宿主

虽然 Ready 已经把很多东西拆了出去，但从 `direct-chat.ts` 看，主循环里仍然直接承担了这些事：

- provider 选择
- task type 解析
- execution route 解析
- capability reconcile
- browser 决策准备
- browser deterministic dispatch
- document pipeline 特判
- skill context 注入
- tool loop budget
- tool loop recovery
- planner step 推进
- structured task payload
- continuation 恢复
- document insight/widget cache

这说明当前的拆层更多是“把 helper 挪出去”，不是“把 ownership 移出去”。

这类结构的最大问题不是文件大，而是：

**任何新能力都仍然会下意识回流到 `DirectChatEngine`。**

### 2.2 `ToolGateway` 还不是真正的 tool runtime

Ready 现在已经有 capability groups，这是优点。

但和 Claude Code 对照后会发现，Ready 的 `ToolGateway` 主要回答的是：

- 这组工具叫什么
- 这一组有哪些 schema
- 当前环境应该给模型看哪些工具

它没有回答更关键的问题：

- 工具是不是并发安全
- 工具是不是只读
- 工具有没有独立权限策略
- 工具的结果应该怎么结构化
- 工具被中断时该怎么收尾
- 工具怎样映射成 UI message / transcript / projection

也就是说，Ready 现在有“工具目录”，但还没有“工具运行时”。

### 2.3 `tool-executor` 仍然是“按前缀分发”

当前 `executeToolCall()` 的设计很直接：

- `browser_` 走浏览器执行器
- `document_` 走文档执行器
- `skill_` 走 skill 执行器
- 结果统一回字符串

这在功能少的时候很省事，但一旦进入现在这种多域产品，会出现三个问题：

1. 工具行为元数据没地方挂。
2. 工具结果语义被抹平。
3. 执行策略只能越来越依赖外层 if/else。

Claude Code 的经验很明确：

**如果工具层只是字符串路由，主循环就一定会越来越胖。**

### 2.4 领域 orchestrator 现在更像外挂，不像 adapter

Ready 现在的 `BrowserDomainOrchestrator`、`DocumentDomainOrchestrator`、`DocumentToolLoopOrchestrator` 都已经开始发挥作用，这是当前架构里最值得保留的部分。

但它们和 Claude Code 的差异在于：

- 现在更多是被 `DirectChatEngine` 主动“调用一把”。
- 还不是正式插在统一 turn engine 里的 adapter。

结果就是：

- orchestrator 文件存在，但 `direct-chat.ts` 依然要理解太多领域语义。
- 新增领域能力时，最自然的做法还是去改 `direct-chat.ts`。

### 2.5 前台任务投影已经开始像真相，但还没完全是

Ready 这块其实比 Claude Code 更接近“产品应用型 agent”：

- 有 `ScopeRunSummary`
- 有 `TaskProjection`
- 有 `TaskPanel`
- 有 continuation
- 有 budget/runtime diagnostics

这是好事。

问题在于，这一层现在仍然部分依赖：

- 文本 cue
- task payload 注入
- tool loop 中途补消息
- summary 推断

所以 projection 虽然好用，但还不是绝对 execution truth。

## 3. Claude Code 能直接给 Ready 的“答案”

### 3.1 答案一：执行真相必须单点收口

Ready 目前最需要抄的，不是某个 browser planner，而是 Claude Code 那种“turn loop 只有一个 owner”的纪律。

对 Ready 来说，正确方向应该是：

- `AgentControlRuntime` 退回 control plane。
- `ClaudeSdkOrchestrator` 退回 transport / session bridge。
- 新的 `TurnEngine` 成为唯一 execution truth owner。
- `DirectChatEngine` 缩成 provider client + host adapter，而不是继续当超级宿主。

### 3.2 答案二：工具应该先定义，再执行

Claude Code 是“工具对象先行，调度策略后置”。

Ready 当前更像“先有执行器，再按前缀映射工具”。

如果要抄答案，Ready 下一步最该做的是给工具引入正式定义层，例如至少补齐这些属性：

- tool family / domain
- read vs write vs interactive
- concurrency safe
- interrupt behavior
- result shape
- projection hook
- optional UI rendering metadata

### 3.3 答案三：领域能力应该作为 adapter 接主循环

Claude Code 并没有把所有产品能力都硬写进 loop 里。

对 Ready 来说，对照后最合理的演进方式是：

- Browser 继续保留 domain orchestrator
- Document 继续保留 domain orchestrator
- Skill / RSS / Calendar / Feishu 也都补到同一类 adapter contract

然后让 turn engine 只关心：

- 这轮 route 是什么
- 该调用哪个 adapter
- adapter 返回什么结构化结果

而不是自己看懂每个域的细节。

### 3.4 答案四：字符串结果必须让位给结构化结果

Claude Code 很多稳定性其实来自它对 message 和 tool result 的严谨建模。

Ready 如果还长期停留在：

- 工具执行器回字符串
- 外层靠正则和 cue 再猜结果含义

那后面 continuation、projection、UI 卡片、恢复、审计都会越来越费劲。

这是 P0 级基础债。

## 4. Ready 当前可以保留的部分

不是所有东西都要推翻。对照后，Ready 有几块反而是值得保留并继续做厚的：

### 4.1 `RunCoordinator`

这层已经有清晰价值：

- 统一 prompt assembly 接入
- 统一 execution host 调用
- 统一 success/failure/reflect 收口

这层应该保留。

### 4.2 `RunProjection` + `TaskProjection`

这套是 Ready 作为应用型 agent 的强项。

Claude Code 在 CLI 语境下没有这么强的任务投影层，Ready 不应该因为学它而削弱这部分，反而应该让这层更接近真正 runtime truth。

### 4.3 capability grouping

虽然当前只做了一半，但 capability group 不是错方向。

它只是不能替代 tool contract。

正确做法应该是：

- capability group 负责“工具面暴露”
- tool definition 负责“工具行为语义”

### 4.4 domain orchestrator 雏形

Browser / Document 这两块已经拆出独立 orchestrator，这是很好的起点。

问题不在于它们存在，而在于主循环还没真正围绕它们重组。

## 5. 当前整改优先级

### P0：先解决真相归属

优先处理：

- turn loop owner
- tool contract
- structured tool result
- direct-chat 职责收缩

如果这几项不先做，后面继续加 Browser / Document / Skill 能力，只会继续堆在巨型宿主里。

### P1：再解决接入方式

在 P0 之后处理：

- browser/document/skill/rss/calendar/feishu adapter contract
- projection 真值回写
- interaction state 的统一结构化表达

### P2：最后再做子 agent / worker

如果 P0、P1 还没收口，就急着做 worker / subtask，只会把混乱复制到更多层。

## 6. 结论

Ready 当前不是“做得太少”，而是“做了很多，但真相层没有收口”。

Claude Code 给出的核心答案可以浓缩成三句话：

1. 只有一个 turn engine 负责执行真相。
2. 工具必须是有行为契约的对象，不是字符串前缀。
3. 领域能力应该插到统一执行骨架上，而不是反向侵入骨架。

如果 Ready 按这个顺序整改，现有 `RunCoordinator / TaskProjection / capability group / domain orchestrator` 这些积累都能被保下来；如果继续在 `DirectChatEngine` 上补能力，后面每加一个域，维护成本都会继续陡增。
