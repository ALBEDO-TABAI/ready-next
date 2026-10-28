---
name: context-compact
description: 手动压缩当前 Agent 会话上下文，释放模型上下文窗口
when-to-use: 用户明确要求压缩、整理、瘦身、compact 当前 Agent 上下文或长会话历史
---

# Context Compact

In Ready, sending this skill on its own (`@[context-compact]` with nothing else) runs the compaction directly, the same as “压缩上下文” in the chat menu; no Agent turn is started. Long tasks are also compacted automatically when the context fills.

If this skill arrives together with other requests, call `skill_compact_context` once: it reports that compaction runs between turns. Tell the user plainly to send the skill on its own or use the chat menu, then continue with the rest of the request. Do not summarize the conversation manually. Do not run shell commands.
