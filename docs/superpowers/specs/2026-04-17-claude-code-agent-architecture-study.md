# Claude Code Agent Architecture Study

**Date:** 2026-04-17

## Goal

系统研究 `CC-Source` 中 Claude Code 的 agent 设计，重点回答四个问题：

1. 它的主循环到底由谁拥有。
2. 会话、消息、工具、权限、子 agent 分别落在哪一层。
3. 工具调度为什么能在复杂产品形态下维持可扩展性。
4. 哪些做法适合直接借鉴到 Ready，哪些不适合照搬。

## Study Inputs

- `CC-Source/src/query.ts`
- `CC-Source/src/Tool.ts`
- `CC-Source/src/tools.ts`
- `CC-Source/src/services/tools/toolExecution.ts`
- `CC-Source/src/services/tools/toolOrchestration.ts`
- `CC-Source/src/services/tools/StreamingToolExecutor.ts`
- `CC-Source/src/services/tools/toolHooks.ts`
- `CC-Source/src/tools/AgentTool/AgentTool.tsx`
- `CC-Source/src/tools/AgentTool/runAgent.ts`
- `CC-Source/src/bridge/sessionRunner.ts`
- `CC-Source/src/services/api/sessionIngress.ts`
- `CC-Source/src/utils/messages.ts`
- `CC-Source/src/utils/sessionStorage.ts`

## One-Line Conclusion

Claude Code 的核心不是“很多 agent 特判”，而是：

**一个单一真相的 turn loop，配一套强约束的 tool contract，再配一层独立的会话/消息/权限/子 agent 基础设施。**

它的大部分复杂能力，都不是靠在主循环里不断加领域分支得到的，而是靠下面三件事稳定扩出来的：

- 主循环只有一个真正 owner。
- 每个工具都带着完整行为契约。
- 消息、转录、UI 展示、权限、工具结果都走统一类型体系。

## 1. 总体架构

### 1.1 真正的主循环只有一个

Claude Code 的运行核心在 `src/query.ts`。

它不是“runtime -> orchestrator -> engine”这种多层都像主控的结构，而是很明确地把以下事情收在一个循环里：

- 当前轮消息集如何构造。
- 是否先做 compact / snip / prefetch。
- 发哪一次模型请求。
- streaming 过程中如何收集 `tool_use`。
- 工具是边流式执行还是批量执行。
- 工具结果如何重新插回消息链。
- 什么时候继续下一轮，什么时候结束本轮。

也就是说，Claude Code 把“turn execution truth”收在一个文件、一条链里。别的模块虽然很多，但它们大多是服务于这个循环，而不是和它争主控权。

### 1.2 主循环之外的模块都围着同一个真相转

围绕 `query.ts`，Claude Code 形成的是一个“单中心，多边界”的结构：

- `Tool.ts` 负责工具契约。
- `tools.ts` 负责工具池装配和过滤。
- `toolExecution.ts / toolOrchestration.ts / StreamingToolExecutor.ts` 负责工具执行与调度。
- `messages.ts` 负责消息构造与 API 边界归一。
- `sessionStorage.ts / sessionIngress.ts / sessionRunner.ts` 负责转录、持久化和桥接。
- `AgentTool.tsx / runAgent.ts` 负责子 agent 生命周期。

这些层不是互相抢决定权，而是各自把“这一块的真相”守住。

## 2. Claude Code 的核心设计单元

### 2.1 Tool Contract 是一等公民

Claude Code 最关键的抽象不是 capability group，也不是 domain executor，而是 `Tool`。

`src/Tool.ts` 里每个工具都不是“字符串名 + schema”这么薄，而是包含完整行为契约：

- `inputSchema`
- `outputSchema`
- `concurrency`（Claude Code 原字段语义对应 `isConcurrencySafe`）
- `isReadOnly`
- `isDestructive`
- `interruptBehavior`
- `checkPermissions`
- `validateInput`
- `maxResultSizeChars`
- `renderToolUseMessage`
- `renderToolResultMessage`
- `mapToolResultToToolResultBlockParam`
- `toAutoClassifierInput`

这意味着 Claude Code 并不是先有一个统一执行器，再在别处额外猜“这个工具能不能并发、能不能中断、怎么展示、会不会太危险”。这些信息都定义在工具本身。

这套设计有两个非常大的好处：

1. 调度层不需要维护越来越多的工具特判表。
2. UI、权限、执行、压缩、日志都能复用同一份工具定义。

### 2.2 工具池是独立装配的，不绑死在主循环里

`src/tools.ts` 的职责非常清楚：

- 给出所有 base tools。
- 按权限模式过滤。
- 合并 MCP 工具。
- 做 coordinator / subagent 场景下的裁剪。
- 稳定排序，保证 prompt cache 命中。

主循环消费的是一份“已经装配好的工具池”，而不是自己一边跑一边去猜：

- 哪些工具本轮应该暴露。
- 哪些工具对子 agent 禁用。
- 哪些工具来自 MCP。
- 哪些工具要为了缓存稳定性调整顺序。

这点很重要，因为它把“工具可见性真相”和“工具执行真相”分开了。

### 2.3 Tool Execution 被拆成了独立运行时

Claude Code 的工具执行至少拆成三层：

1. `toolExecution.ts`
   - 单个工具调用的完整生命周期。
   - 包含校验、权限、hooks、telemetry、结果包装、错误处理。

2. `toolOrchestration.ts`
   - 非流式场景下的批量调度。
   - 根据 `concurrency`（Claude Code 原字段语义对应 `isConcurrencySafe`）把工具调用分为并发组和串行组。

3. `StreamingToolExecutor.ts`
   - 流式响应期间边收 `tool_use` 边执行。
   - 允许读型工具尽早并发执行，但最终结果依然按接收顺序吐回。

这三层拆开以后，主循环只负责：

- 收集了哪些 tool call。
- 何时把它们交给工具运行时。
- 如何把结果接回下一轮消息。

主循环本身不直接承担“每个工具的权限和 hook 细节”。

### 2.4 Session / Transcript / UI Message 是单独建模的

Claude Code 在消息层也很讲究边界。

从 `messages.ts` 和 `sessionStorage.ts` 可以看到，它明确区分了：

- API-bound message
- transcript message
- progress message
- attachment message
- system message
- tombstone message

尤其重要的是：

- 并不是所有 UI message 都进入 transcript。
- progress 属于临时 UI 态，不应该污染会话链。
- transcript 的 parent/child chain 有明确规则，避免 resume 时断链。

这说明 Claude Code 并没有把“为了让界面好看而产生的状态”混进真正的会话执行真相里。

### 2.5 Session Persistence 和 Execution Host 分离

`sessionRunner.ts`、`sessionIngress.ts`、`sessionStorage.ts` 三者分工非常清楚：

- `sessionRunner.ts` 负责桥接子进程/CLI session，处理活动、stderr、permission request。
- `sessionIngress.ts` 负责远程日志顺序追加和重试。
- `sessionStorage.ts` 负责本地 transcript、sidechain transcript、resume 读取、会话文件组织。

主循环不需要理解“session 如何落盘、如何重试、如何串起来”，因为会话基础设施本身就是独立层。

### 2.6 Subagent 不是“顺手加一个工具”，而是一套完整生命周期

`AgentTool.tsx` 和 `runAgent.ts` 表明，Claude Code 对子 agent 的理解不是：

- 让模型调用一个 `agent_*` 工具后直接跑另一个 prompt

而是：

- 子 agent 有单独 tool pool。
- 子 agent 有单独 permission context。
- 子 agent 有单独 transcript。
- 子 agent 可以带独立 MCP。
- 子 agent 有 worktree / remote / background 等隔离策略。
- 子 agent 的进度、结果、失败、清理都有完整生命周期。

这使得“agent”在 Claude Code 里其实是基础设施能力，不是业务层补丁。

## 3. Claude Code 的执行流程

### 3.1 单轮执行主链

可以把 `query.ts` 的主链概括成：

1. 准备本轮状态
2. 做上下文压缩、prefetch、预算检查
3. 发模型请求并流式消费消息
4. 收集 assistant text / tool_use
5. 交给 tool runtime 执行工具
6. 把 tool result、attachment、队列事件重新拼回消息链
7. 需要继续则进入下一轮；否则结束

这里有几个很关键的特征：

- 它是 turn loop，不是假装 planner 的 loop。
- continuation 是天然由消息链继续，而不是另外拼一条平行执行链。
- 领域能力大多通过工具和附件进入，而不是主循环里散布大量 domain 分支。

### 3.2 Streaming 时也不打破真相

Claude Code 之所以复杂却还能稳，很重要的一点是：

**流式优化没有破坏主真相。**

即使使用 `StreamingToolExecutor`，它也只是让工具更早开始执行，而不是改写主循环的归属关系。

它仍然保证：

- 工具结果最终按收到 tool use 的顺序回收。
- 并发安全由工具自身声明驱动。
- 错误、取消、fallback 都回到统一消息模型里。

也就是说，它优化的是“时机”，不是“架构归属”。

## 4. Claude Code 的工具调度是怎么实现的

### 4.1 调度依据来自工具定义，不来自主循环猜测

Claude Code 的批量调度策略核心依据是工具上的这些声明：

- `concurrency`（Claude Code 原字段语义对应 `isConcurrencySafe`）
- `isReadOnly`
- `interruptBehavior`
- `checkPermissions`

调度器并不需要维护一堆“哪些工具看起来像只读”的额外白名单，因为工具自己已经回答了这件事。

### 4.2 串行/并发分组非常保守

`toolOrchestration.ts` 的规则并不花哨：

- 连续的 concurrency-safe tool 可以并发。
- 其它工具串行。
- 非安全工具会切断并发批次。

这个策略简单，但好处是：

- 推理成本低。
- 出错面小。
- 不容易出现“误把可变更工具当成并发读工具”的事故。

### 4.3 Streaming 执行解决的是吞吐，不是语义

`StreamingToolExecutor.ts` 解决的是：

- 模型 streaming 时尽快起工具。
- 并发工具别傻等。
- 进度消息先显示。

但它没有把语义搞乱：

- 结果仍然按原 tool use 顺序落回。
- 并发错误会触发 sibling abort。
- interrupt/cancel 和 streaming fallback 有独立处理。

这说明它把“体验优化”建立在“调度语义稳定”之上，而不是反过来。

### 4.4 Hooks、Permission、Telemetry 都挂在工具生命周期上

Claude Code 的 hooks 不是主循环里临时插进去的 if/else，而是跟着工具生命周期走：

- pre-tool
- permission
- post-tool
- post-tool-failure

这让权限系统、规则系统、遥测系统都能复用同一条工具执行链，而不用在 runtime、UI、tool executor 各写一遍。

## 5. 为什么这套设计能撑住复杂产品

### 5.1 主循环只有一个真相来源

Claude Code 并没有把 execution truth 分散到：

- runtime
- orchestrator
- direct-chat
- domain executor

多层里同时做一半。

它复杂，但主真相非常集中。

### 5.2 工具是能力单元，不是字符串前缀

它不是“browser_* 一类、document_* 一类”这样先按名字分组，再由主循环猜行为。

它先定义工具对象，再把行为、权限、展示、结果映射都绑到对象上。

### 5.3 消息层有很强的结构纪律

Claude Code 非常重视：

- transcript 不能乱
- progress 不能污染会话
- tool_result 必须和 tool_use 配对
- compact/resume 不能打破 API 不变量

这一层严格，后面才不需要到处打补丁。

### 5.4 子 agent 是基础设施，不是产品技巧

Claude Code 没把“agent”当 prompt 技巧，而是把它当 execution primitive：

- 独立上下文
- 独立权限
- 独立 transcript
- 独立工具池
- 独立隔离策略

这也是它后面能做 coordinator / worker / background / remote 的原因。

## 6. 不适合直接照搬的部分

虽然 Claude Code 有很多值得借鉴的地方，但也有几类不适合直接复制：

### 6.1 不能照搬它的文件体量

`query.ts` 非常大。

它之所以还能站住，是因为：

- 消息模型和工具契约已经足够稳。
- 代码库里很多能力都围绕这一个 loop 设计。

Ready 当前没有这套基础，直接照搬“大一统 loop”只会把现有混乱再放大。

### 6.2 不能忽略它背后的强类型和长期积累

Claude Code 很多看似简单的做法，其实依赖这些前提：

- 完整的 `Tool` 契约
- 稳定的 `Message` 体系
- transcript 持久化规则
- permission/hook 机制

如果只抄表层形式，不补底层契约，效果会很差。

### 6.3 Ready 有自己的产品约束

Ready 不是 CLI coding agent，而是：

- Electron 主应用
- BrowserView
- 文档编辑器
- RSS
- Calendar
- 远程通道
- Skills runtime

所以 Ready 不应该复制“所有能力都变成通用文件/壳工具”的路径，而应借 Claude Code 的抽象纪律，保留自己的宿主优势。

## 7. 对 Ready 最有价值的四条启发

### 7.1 先收口 loop ownership，再谈 domain orchestration

Claude Code 的第一启发不是“怎么做浏览器 planner”，而是：

**同一轮执行只能有一个真正 owner。**

### 7.2 先把 Tool Contract 做厚，再谈 capability grouping

Ready 当前已经开始做 capability group，但 Claude Code 的经验说明：

**分组只能解决“看见谁”，解决不了“怎么调度谁、怎样安全执行谁”。**

### 7.3 把消息真相和前台展示真相分开

Claude Code 对 transcript、progress、attachment 的严格分层，正好是 Ready 当前最该补的基础之一。

### 7.4 让 domain logic 作为 adapter 插入，而不是把 loop 变成领域特判仓库

Claude Code 虽然也有很多产品能力，但大多通过：

- tool contract
- message attachment
- session infrastructure

接入，而不是把主循环变成“browser/document/skill/rss/calendar 全都懂一点”的巨型宿主。

## Final Takeaway

Claude Code 的真正答案不是“planner 很强”或者“子 agent 很多”，而是：

- 一条主循环负责真正执行。
- 一套工具契约负责能力边界。
- 一层消息/转录体系负责状态真相。
- 其它能力都在这个骨架上外挂，而不是反过来侵入骨架。

对 Ready 来说，最该抄的不是 Claude Code 的功能表，而是它的**真相归属方式**。
