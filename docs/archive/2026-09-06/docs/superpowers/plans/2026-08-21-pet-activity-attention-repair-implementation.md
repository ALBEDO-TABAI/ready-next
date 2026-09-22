---
title: 宠物任务注意力状态修复实施合同
date: 2026-08-21
status: complete
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# 宠物任务注意力状态修复

## 1. 现场事实

- 截图中的当前任务 `req-1787298693336-3r2lin` 已由 canonical closeout 写成 `done / completed`。
- 宠物展示的“正在整理任务边界、资源与可用能力”来自另一个 scope 中 2026-08-20 的历史 `failed` 投影。
- 当前聚合器只给 `completed` 保存已读标记；`failed` 没有可消费的注意力回执，因此会永久压过后续 `ready` 和 `running`。

## 2. 机器可验证合同

1. 宠物只读取 Main 的 canonical `task_projections`，不推导或改写任务终态。
2. cutover 之后的 `needs_input` 与 open `blocked / recoverable_paused / budget_paused` 是当前未解决状态，直到任务投影改变前持续显示。
3. terminal `completed / failed` 是注意力通知：只在活动接线切换点之后、且该 scope 尚未读到对应更新时间时显示。
4. 升级创建一次性 cutover；cutover 之前的 terminal 或 paused/blocked 历史不进入新宠物通知队列。
5. 用户点击活动时，Main 校验 exact `revision + taskId + scopeId + runId + messageId + updatedAt`，打开准确会话，并将该 terminal 活动写成已读；不能只在 Renderer 临时隐藏。
6. 用户直接打开并成功加载一个会话时，Main 将该 scope 已呈现的 terminal 活动推进到已读高水位；其他 scope 不受影响。
7. 已读写入后立即重新聚合，选择下一条 eligible 活动；不得硬编码切到 idle，也不得让旧失败继续占位。
8. 同时存在 eligible 活动时保持官方优先级：`needs_input > blocked > ready > running > idle`。

## 3. 验收

- 迁移前历史 `failed` + 迁移后 `completed`：显示 `ready`，不显示历史阻塞。
- 迁移后未读 `failed` + `completed`：先显示 `blocked`；点击后切到下一条活动。
- 已读 terminal 失败不再出现；open blocked 即使已查看仍保持，直到投影改变。
- 点击身份漂移时拒绝写已读。
- 直接打开 scope 只推进该 scope 的 terminal 已读高水位。
- migration、SQLite readback、聚合器、IPC/Renderer 合同、类型检查和真实 Electron 行为全部通过。

## 4. 验收结果

- 专项行为测试：14 项通过。
- SQLite / migration 原生验证：116 项通过。
- TypeScript 类型检查与生产构建通过。
- 真实 Electron 单次启动依次验证：历史失败被抑制、运行中、最新失败、点击后空闲、完成待查看、点击后空闲；持久化已读时间精确回读，网络请求为 0。
- 证据：`outputs/ui-acceptance/pet-activity-a6d3aae06c642ff7bee0/report.json`。
