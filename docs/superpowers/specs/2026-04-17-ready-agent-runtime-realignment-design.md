---
enforce: false
documentation_status: archived-in-place
archived_at: 2026-09-06
---

> 原位归档（2026-09-06）：固定历史证据仍引用此路径。保留此路径不代表全文仍是当前合同；其中的状态、源码位置和待办属于原记录。现行约束见 [当前运行时合同](../../architecture/current-runtime-contracts.md)，归档去向见 [文档清单](../../documentation-inventory.md)。

# Ready Agent Runtime Realignment Design

**Date:** 2026-04-17

## Goal

基于 Claude Code 的研究结果，为 Ready 设计一版更稳的 agent 目标架构，解决当前这些核心问题：

- 主循环 owner 不清
- `DirectChatEngine` 持续膨胀
- 工具仍然只有前缀分发，没有正式行为契约
- 域内 orchestrator 已出现，但还没成为统一 adapter 体系
- projection 很强，但还没成为 execution truth 的稳定投影

## Non-Goals

本设计不追求：

- 一次性重写整个 agent 模块
- 把 Ready 做成 Claude Code 的复制品
- 抹掉 Browser / Document / Skills / Remote IM 的产品特性

本设计追求的是：

**用更稳定的边界，承接 Ready 自己已经长出来的复杂能力。**

## 1. 目标架构

### 1.1 总体分层

Ready 下一版 agent 建议收口为六层：

1. `AgentRuntimeFacade`
2. `TurnEngine`
3. `ToolRuntime`
4. `DomainAdapter`
5. `Transcript + Projection`
6. `Session / Continuation`

它们之间的关系应该是：

`Renderer / Channel / Cron -> AgentRuntimeFacade -> TurnEngine -> ToolRuntime / DomainAdapter -> Transcript + Projection`

## 2. 各层职责

### 2.1 `AgentRuntimeFacade`

这一层建议由现有 `AgentControlRuntime` 演进而来，但要明确只做 control plane：

- scope / conversation / channel / cron 宿主
- health / heartbeat
- runtime 装配
- persistence service 装配
- 对 renderer / preload 暴露统一 API

它不再直接承担：

- 单轮 execution truth
- provider/tool loop 细节
- domain 内部调度

一句话说，它应该像 Ready 的“运行时外壳”，不是“大脑”。

### 2.2 `TurnEngine`

这一层是整个整改最核心的新 owner。

它应该成为：

- 单轮执行唯一真相来源
- 本轮消息、预算、route、tool results、interaction state 的统一宿主

它负责：

- 接收 `PreparedRunPayload`
- 做 task type / route resolve
- 调 provider client
- 收集 tool calls
- 调 `ToolRuntime`
- 接 `DomainAdapter`
- 推进 step / interaction / continuation
- 产出结构化 `ExecutionTurnResult`

它不负责：

- DB
- sidecar
- renderer IPC
- 具体工具实现
- BrowserView 细节

它相当于 Ready 版的“单一主循环”，但不要求像 Claude Code 那样把所有逻辑都塞到一个大文件里。

### 2.3 `ToolRuntime`

这一层建议从当前 `ToolGateway + tool-executor + tool schema` 演进而来。

它应该至少拥有三种能力：

1. **Tool Definition Registry**
   - 每个工具有正式定义
   - 不再只有 schema 和分组

2. **Tool Pool Assembly**
   - capability group / provider / environment / executor policy 决定“本轮能看见谁”

3. **Tool Execution Runtime**
   - 权限
   - 并发调度
   - 中断策略
   - 超时
   - 结果结构化
   - cleanup hook

建议引入的工具定义字段至少包括：

- `name`
- `domain`
- `kind: read | write | interactive | job`
- `concurrency`
- `interruptBehavior`
- `supportsTextBridge`
- `resultShape`
- `projectionHint`
- `timeoutProfile`

Ready 不一定要复制 Claude Code 全部 `Tool` 接口，但一定要从“字符串前缀分发”升级到“工具行为契约”。

### 2.4 `DomainAdapter`

Ready 和 Claude Code 最大不同，是 Ready 有非常强的宿主域能力。

所以 Ready 不应该把 Browser / Document 变成普通壳工具，而应该保留它们的宿主优势，但统一接入成 adapter：

- `BrowserDomainAdapter`
- `DocumentDomainAdapter`
- `SkillDomainAdapter`
- `RSSDomainAdapter`
- `CalendarDomainAdapter`
- `FeishuDomainAdapter`

每个 adapter 都回答同一类问题：

- 这轮是否应该接管
- 接管后是 deterministic 还是 tool-assisted
- 需要往 turn 中注入哪些结构化提示
- 完成后回什么结构化结果
- 对 projection / continuation 有哪些专属状态

这样 `TurnEngine` 就不需要理解每个域的细节，只需要和统一 contract 交互。

### 2.5 `Transcript + Projection`

Ready 这层不能削，反而要做成正式真相镜像。

建议明确分成两层：

1. `Transcript`
   - 会话真实执行记录
   - tool call / tool result / assistant / interaction / system note 的结构化序列

2. `Projection`
   - 面向 UI 的任务摘要
   - `TaskPanel`、聊天任务卡、继续/重试草稿消费它

重要原则：

- projection 来源于 transcript/runtime truth
- projection 不能反向定义 execution truth

也就是说，任务卡是“显示层”，不是“事实源”。

### 2.6 `Session / Continuation`

Ready 这层已经有基础，但要进一步正式化。

它负责：

- session scope
- continuation lookup
- resumable task recovery
- recent context recall
- task lineage

但 continuation 不能再只靠：

- 文本提示
- projection 兜底
- prompt 注入补语义

它应该尽量从结构化 runtime/transcript 状态恢复。

## 3. 当前文件如何映射到目标架构

### 3.1 建议保留并继续做厚

- `run-coordinator.ts`
- `run-projection.ts`
- `run-budget-policy.ts`
- `task-execution-router.ts`
- `execution-intent-resolver.ts`
- `browser-domain-orchestrator.ts`
- `document-domain-orchestrator.ts`
- `document-tool-loop-orchestrator.ts`

这些文件说明 Ready 已经有目标骨架，不应该推翻。

### 3.2 建议缩职责、重新定位

#### `runtime.ts`

保留为 facade / control plane，不再向 execution host 倾斜。

#### `orchestrator.ts`

保留 transport / session bridge 角色，不再承担“半主控”期待。

#### `direct-chat.ts`

这是整改重点。

建议分阶段把它拆成：

- `turn-engine.ts`
- `provider-clients/*`
- `domain-dispatch/*`
- `turn-state/*`

`DirectChatEngine` 最终应缩成“provider-facing execution host shell”，不再继续作为产品策略总控。

### 3.3 建议新增

- `tool-definition.ts`
- `tool-registry.ts`
- `tool-runtime.ts`
- `tool-result-types.ts`
- `domain-adapter.ts`
- `turn-engine.ts`
- `turn-transcript.ts`

这些文件不一定都要立刻创建，但架构上需要有这些责任位。

## 4. 目标执行链

### 4.1 单轮请求进入

1. `AgentRuntimeFacade` 收到 scope request
2. `RunCoordinator` 组装 prompt / envelope / recall / budget
3. 进入 `TurnEngine`

### 4.2 `TurnEngine` 执行

1. resolve intent / task type / route
2. 装配本轮 tool pool
3. 问对应 provider client 发请求
4. 收集 text / tool calls / interaction signal
5. 如果命中 domain shortcut，则走 adapter
6. 如果命中工具调用，则交给 `ToolRuntime`
7. 更新 transcript state
8. 同步 projection patch
9. 决定下一轮 continuation 或结束

### 4.3 输出

1. `TurnEngine` 产出结构化 turn result
2. `RunProjection` 持久化投影
3. renderer 只消费 projection + transcript event

## 5. 这版设计为什么比当前结构稳

### 5.1 它让真相归属回到单点

Ready 现在最大的痛点不是功能不足，而是谁都管一点。

这版设计会让：

- control plane
- execution plane
- tool runtime
- domain adapter
- projection

各自都有明确 owner。

### 5.2 它不要求放弃宿主能力

Claude Code 偏 CLI，Ready 偏宿主应用。

这版设计没有要求把 Browser / Document 做薄，反而允许它们通过 adapter 继续保持宿主优势。

### 5.3 它能承接未来的 worker / 子任务

只要 `TurnEngine`、`ToolRuntime`、`Transcript` 三层真相收住，后面再加：

- worker
- subtask
- background task
- plan/execute split

就不会再是“在超级宿主上叠特判”。

## 6. 迁移原则

### 6.1 不做 big bang

当前 Ready 已经有很多用户面能力，不能一把重写。

建议采用“保留外壳、替换内核”的迁移方式：

- 先让旧入口继续存在
- 再逐步把内部 ownership 移到新层

### 6.2 先补工具契约，再抽主循环

如果工具仍然只是字符串分发，先抽主循环也抽不干净。

所以更稳的顺序是：

1. 先把 tool definition 做起来
2. 再把 tool runtime 收口
3. 再让 `TurnEngine` 接管 execution truth

### 6.3 Projection 先镜像，不反控

任务投影很重要，但它应该镜像 runtime truth，而不是倒过来驱动主链。

### 6.4 保留当前 domain orchestrator 的投资

Browser / Document 当前已有独立 orchestrator，不要推倒重来，而是让它们升级成正式 adapter。

## 7. Success Criteria

当下面这些条件同时满足，才算这轮整改成功：

- `DirectChatEngine` 不再是唯一超级宿主。
- 单轮 execution owner 清晰可指认。
- 工具有正式定义层，不再只按前缀分发。
- 工具结果开始结构化，不再全部回字符串。
- Browser / Document / Skill / RSS / Calendar / Feishu 都通过统一 adapter contract 接入。
- projection 更接近 transcript/runtime truth，而不是提示性 UI 数据。
- continuation 恢复更多依赖结构化状态，而不是 prompt 补词。

## Final Takeaway

Ready 当前不是缺想法，而是缺“真相收口”。

这版设计的核心不是多加几层，而是把已有模块重新排成一条稳定链：

- facade 管 control plane
- turn engine 管 execution truth
- tool runtime 管工具语义
- domain adapter 管宿主特性
- transcript/projection 管状态镜像

只有这样，Ready 的 agent 才会从“功能越来越多，但越来越难维护”变成“功能继续长，但边界越来越稳”。
