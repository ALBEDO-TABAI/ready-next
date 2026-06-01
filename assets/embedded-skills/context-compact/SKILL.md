---
name: context-compact
description: 手动压缩当前 Agent 会话上下文，释放模型上下文窗口
when-to-use: 用户明确要求压缩、整理、瘦身、compact 当前 Agent 上下文或长会话历史
---

# Context Compact

Use `skill_compact_context` once when the user explicitly asks to compact the current Agent context.

Do not summarize the conversation manually. Do not run shell commands. After the tool result returns, tell the user plainly whether compaction ran or was queued.
