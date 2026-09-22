---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Agent Core Loop Stage 5 Prep

**Date:** 2026-04-09

## Goal

在 2/3/4 阶段基本收口后，先把下一阶段真正值得做的增强项准备清楚，避免后续直接开做时又把主控边界打乱。

这份文档只回答四件事：

1. **共享 iteration budget** 应该挂在哪一层。
2. **并发非交互工具** 应该由谁调度。
3. **context compression** 应该从哪一层接入。
4. **provider fallback 统一化** 应该由谁收口。

本文件是开工底稿，不包含代码实施。

## Target Areas

### 1. 共享 Iteration Budget

- 归属层：`RunCoordinator`
- 原因：
  当前 iteration budget 还主要由 execution host / browser 域自己算，更适合先提升为单轮 run 的统一预算。
- 第一版入口：
  - `RunCoordinatorRequest`
  - execution host 调用前的 run budget seed
  - domain orchestration 返回的 budget hint
- 不做：
  - 跨 scope 的全局配额
  - 多 agent 间共享预算

### 2. 并发非交互工具

- 归属层：execution clients + `ExecutionLoopOrchestrator`
- 原因：
  并发是否安全，和协议层/工具返回合流强相关，不能塞回 domain orchestrator，也不适合放 renderer。
- 第一版只考虑：
  - 不改页面状态
  - 不依赖前一步页面交互结果
  - 无需用户确认
- 候选工具族：
  - 文本检索/读取类
  - 文档/设计只读检查类
  - skill / memory / rss 的只读状态类
- 不做：
  - 浏览器交互步骤并发
  - 文档写入并发
  - 需要 tool result 顺序语义的混合并发

### 3. Context Compression

- 归属层：`PromptAssemblyService` + `RunCoordinator`
- 原因：
  压缩是 prompt 前置准备，不该落回 provider client 或 domain 层。
- 第一版入口：
  - 超长历史摘要
  - 超长 tool trace 折叠
  - 历史 artifact 摘要化
- 结果要求：
  - 前台仍能看到真实原始任务状态
  - 压缩只影响 prompt，不影响前台 truth
- 不做：
  - 长期记忆策略重写
  - 跨会话检索策略改造

### 4. Provider Fallback 统一化

- 归属层：execution clients
- 原因：
  fallback 是协议/供应商兼容问题，应该在 OpenAI / Anthropic / Kimi 这些客户端内部统一，不应该再让 `DirectChatEngine` 拼分支。
- 第一版入口：
  - native tools -> text bridge
  - video block -> frame fallback
  - OpenAI wire API fallback
  - Kimi Coding 专属 fallback
- 不做：
  - 跨 provider 热切换
  - 宿主外部配置的自动 provider 迁移

## Dependencies

- `RunCoordinator`
  需要先成为真正唯一的单轮 owner，后续 budget 与 fallback 才有单一入口。
- execution clients
  需要维持当前拆分结果稳定，避免阶段 5 又回头重做客户端分层。
- `RunProjection`
  需要先保持“前台吃正式字段，文本只兜底”的现状，否则压缩与并发后会更难验证 truth。
- domain orchestrators
  浏览器/文档/设计/技能要继续保持域内策略在各自层，不把增强项塞回主循环。

## Risks

- **Budget 放错层**
  如果预算仍放在 browser 或 provider client 内，会重新制造多 owner。
- **并发边界太激进**
  如果把交互类工具也纳入并发，容易直接破坏页面/文档状态。
- **Compression 影响前台 truth**
  若把压缩结果直接回写前台，会让任务卡与真实执行脱节。
- **Fallback 重新回流主循环**
  如果每个 fallback 仍要 `DirectChatEngine` 手写判定，阶段 2 的收口会被反向冲掉。

## Acceptance For Stage 5 Start

进入阶段 5 前，至少满足：

1. `DirectChatEngine` 不再承担 provider 主链、技能上下文判断、浏览器执行细节、文档/设计循环监督。
2. 文档/设计/浏览器/技能在前台都优先消费正式任务字段。
3. Anthropic / Kimi / OpenAI 三条执行链都已有稳定客户端边界。
4. 已知无关旧失败仍被隔离，本轮主控相关测试稳定通过。

只有满足这些前提，阶段 5 才值得正式开工。
