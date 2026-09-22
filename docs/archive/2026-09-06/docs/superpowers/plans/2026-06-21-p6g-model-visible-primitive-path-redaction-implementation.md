---
title: P6g/C31-b model-visible primitive path redaction implementation
date: 2026-06-21
status: enforce
enforce: false
scope: C31-b primitive-wide host-path redaction
source:
  - outputs/agent-audit/fix-plan/310-CONSENSUS-P6G-C31B-MODEL-VISIBLE-PATH-REDACTION-ROUTE.md
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Goal

Prevent model-visible tool-result text from exposing host paths emitted by skill primitives while preserving raw internal handles for follow-up tools and continuation.

# Non-goals

- Do not mutate raw `ToolExecutionOutput.data`.
- Do not mutate `projectionPatch`, `framePatch`, `contextModifier`, `activeArtifactRoots`, `runContract`, `outputDir`, `runStatePath`, or continuation handles.
- Do not change filesystem sandbox behavior.
- Do not close P2b, C30, C32 follow-up, or full C29/P6.

# Work Plan

1. Add a model-visible tool-result redaction helper.
   - It must reuse the existing host-path redactor.
   - It must clone/redact strings recursively for model-visible `text`, `data`, `projectionPatch`, and `framePatch`.
   - It must not mutate the original output.

2. Wire model-visible surfaces.
   - SDK native tool return JSON uses redacted copies.
   - Text-tool bridge `[tool_result]` blocks use redacted serialization.
   - Old TurnEngine tool result handoff uses redacted serialization.
   - SDK provider history replay redacts prior `function_call_result.output`.
   - OpenAI-compatible history sanitizer redacts flattened Anthropic `tool_result` blocks and OpenAI `role: "tool"` content.
   - SDK tool-result trace text and direct document-domain tool result chunks/summaries are redacted, while accompanying projection patches and raw tool args remain raw.

3. Prove internal handles are unchanged.
- Same-turn active roots must still be raw in later SDK tool context.
- Raw output objects must remain byte-for-byte usable after serialization.
- Prior `function_call_result.output` must be redacted in Anthropic, OpenAI chat, and OpenAI responses request bodies.

# Required Verification

Run at minimum:

- `npm run verify:evolution-p6g`
- `npm run typecheck`
- `npm run verify:evolution-p6f`
- `npm run verify:stability`

If a broader verify command fails on the known repository lint baseline, closeout must record that honestly and must not claim the broad command passed.

# Completion Criteria

- Model-visible tool result strings no longer include raw `/Users/<name>`, `/home/<name>`, `C:\Users\<name>`, JSON-escaped Windows home paths, or `%USERPROFILE%`.
- Internal raw path fields remain unchanged and still drive follow-up tool access.
- History replay request bodies no longer reintroduce raw host paths from prior tool results.
- Claude no-output is recorded as failure, not approval; subagent review replaces it.
- Roadmap updates `source`, refresh note, stage overview, current queue, gate index, and document index.
