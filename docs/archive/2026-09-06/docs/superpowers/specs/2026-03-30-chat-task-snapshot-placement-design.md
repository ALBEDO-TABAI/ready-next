---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Chat Task Snapshot Placement Design

**Goal**

让任务信息不再固定钉在聊天区顶部，而是跟着对应的 agent 普通回复自然下沉，形成可回看的任务时间线；同时在回复尚未产出时，保留一个底部临时进行中块给用户即时反馈。

## Problem

当前 `ChatPanel` 把 `当前任务 / 后台任务` 作为消息列表上方的固定区域来渲染。这样做的问题是：

- 用户阅读某条回复时，需要把视线拉回顶部才能对照任务进度。
- 一次任务的多个阶段被挤在顶部，和真正解释结果的回复分离。
- 工具调用和任务结果都在顶部汇总，造成“现在这条回复到底对应哪一轮动作”不够清楚。

## Intended Experience

- 每条新的 agent 普通回复，都带着当轮新的任务快照一起出现，挂在该回复下方。
- 这些快照是“当时那一轮”的快照，不会被后续进度回写，从而保留时间线。
- 当任务仍在运行、但本轮普通回复尚未产出时，在聊天底部展示一个临时进行中块。
- 一旦普通回复产出，底部临时块消失，正式快照落到该条回复下方。
- 工具细节不再独占消息区顶部，而作为对应任务快照内的可展开内容。

## Design

### Snapshot Source

- 在 assistant 回复持久化时，把当前 `ScopeRunState` 裁成一份轻量任务快照，写入该消息的 `meta`。
- 快照只保留展示所需信息：标题、摘要、状态、步骤、当前步骤、等待态、可继续动作、最近产物、记忆，以及工具事件分组所需的内容。
- 这样切换会话、重载消息时，快照能稳定回到原来的回复下方。

### Message Placement Rules

- `user` 消息：不挂任务快照。
- `agent` 普通消息：如果消息 `meta` 里有任务快照，就在消息正文后渲染一张内嵌任务卡。
- `system` 消息：不挂任务快照。
- 流式进行中：
  - 如果当前存在活动任务，但流式回复仍为空，消息列表底部显示临时进行中块。
  - 如果流式回复已经开始出现，只保留回复内容，不再额外展示临时块，等回复完成后由正式快照接管。

### Top Area Simplification

- 去掉消息列表上方固定的 `当前任务 / 后台任务` 区块。
- 工具调用胶囊也不再固定顶置；它只在没有任何可锚定回复时作为退路存在，或直接并入临时进行中块的简版摘要。

## Files

- Modify: `src/renderer/components/agent/ChatPanel.tsx`
- Modify: `src/renderer/components/agent/ChatMessages.tsx`
- Modify: `src/renderer/modules/agent/messageComposer.ts`
- Modify: `src/renderer/modules/agent/runtimeDriver.ts`
- Modify: `src/renderer/modules/agent/types.ts`
- Modify: `src/__tests__/agent-task-panel-contract.test.ts`
- Create: `src/__tests__/chat-task-snapshot-placement-contract.test.ts`

## Testing

- 合同测试确认顶部固定任务区不再出现。
- 合同测试确认 `ChatMessages` 支持消息下挂任务快照。
- 合同测试确认底部临时进行中块存在。
- 运行相关测试，确保原有任务卡 view model 仍被复用。
