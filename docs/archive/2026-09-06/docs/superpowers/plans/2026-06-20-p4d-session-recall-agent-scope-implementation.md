---
title: P4-D session recall agent scope implementation
date: 2026-06-20
phase: P4-D
covers: [C27]
enforce: false
source:
  - outputs/agent-audit/fix-plan/P4-knowledge-memory-discipline.md
  - outputs/agent-audit/fix-plan/220-CONSENSUS-P4C-P4D-ROUTE.md
  - outputs/agent-audit/fix-plan/223-CLAUDE-P4D-PLAN-REVIEW-FAILURE.md
  - outputs/agent-audit/fix-plan/218-P6B-CONTEXT-BUDGET-COMPACTION-CLOSEOUT.md
  - outputs/agent-audit/fix-plan/224-P4D-SESSION-RECALL-AGENT-SCOPE-CLOSEOUT.md
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# P4-D Session Recall Agent Scope Implementation

## Goal

Close C27 without broadening P4:

- `session_recall_metadata` records the owning conversation `agent`.
- Existing metadata rows are backfilled from `chat_conversations.agent`.
- Rows that cannot be backfilled remain `NULL` and do not match agent-filtered automatic recall.
- Search, recent-session listing, and automatic recall can filter by agent.
- Runtime automatic recall passes `scope.agent`.

## Non-Goals

This slice does not:

- Change session recall UI product behavior beyond returning filtered data.
- Change manually attached recall references.
- Change reflection, `memory_write_card`, browser, P5, or P6.
- Introduce a new recall ranking model.
- Rename existing migrations.

## Implementation Steps

1. Add migration `063_session_recall_agent_column`.
   - Add nullable `agent` to `session_recall_metadata` when missing.
   - Backfill it from `chat_conversations.agent` using `conversation_id = chat_conversations.id`.
   - Create a supporting index for agent-filtered recall reads.
   - Keep orphan metadata rows nullable.

2. Persist agent on write.
   - Update `syncConversationRecallMetadata` to write `conversation.agent`.
   - Keep existing channel/source/user behavior unchanged.

3. Filter recall reads by agent.
   - Add optional `agent` to `searchSessionRecall`, `listRecentSessions`, and `getAutomaticRecallCapsules`.
   - `matchesFilters` must require exact agent match when `agent` is supplied.
   - `agent: NULL` rows must not match an agent-filtered request.
   - No agent filter means current manual/global search behavior stays broad.

4. Wire runtime automatic recall.
   - Pass `scope.agent` from runtime into `getAutomaticRecallCapsules`.
   - Do not change manually attached recall context listing.

5. Add focused tests and wire the verify chain.
   - `migration-session-recall-agent.test.ts`
   - `session-recall-agent-scope.test.ts`
   - a runtime/source contract that automatic recall passes `scope.agent`
   - add the new tests to `verify:evolution-p4`

## Acceptance

P4-D is done only when:

- migration 063 registration, schema, idempotence, and backfill tests pass;
- same-channel/same-user/different-agent recall filtering tests pass;
- automatic recall no longer returns another agent's history when `agent` is supplied;
- runtime automatic recall passes `scope.agent`;
- `verify:evolution-p4` passes;
- `verify:evolution-p6b` passes after P4-D changes, because recall/autoRecall are part of the P6b context-budget contract;
- `typecheck` passes.

## Deferred

Still out of scope:

- Session recall UI affordances for showing the owning agent.
- Recall card editing or lifecycle controls.
- Any P6 compaction or context-budget implementation work. P4-D only reruns the existing P6b guard after recall changes.
