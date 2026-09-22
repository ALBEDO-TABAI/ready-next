---
title: P4-C reflection staged/CAS ledger implementation
date: 2026-06-20
phase: P4-C
covers: [C20, C21]
enforce: false
source:
  - outputs/agent-audit/fix-plan/P4-knowledge-memory-discipline.md
  - outputs/agent-audit/fix-plan/219-CLAUDE-P4CD-PLAN-REVIEW.md
  - outputs/agent-audit/fix-plan/220-CONSENSUS-P4C-P4D-ROUTE.md
  - outputs/agent-audit/fix-plan/221-CLAUDE-P4C-IMPLEMENTATION-REVIEW-FAILURE.md
  - outputs/agent-audit/fix-plan/222-P4C-REFLECTION-STAGED-CAS-LEDGER-CLOSEOUT.md
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# P4-C Reflection Staged/CAS Ledger Implementation

## Goal

Close the reflection write hole without broadening P4:

- Reflection must not directly write prompt-visible `resident_user` or `scope_memory` memory rows.
- Stable user preference observations go through the existing user-picture CAS path when the runtime has a DB handle.
- Session summaries do not get persisted into prompt-visible memory in this slice.
- Every reflection attempt emits one `reflection_outcome` metric.

## Non-Goals

This slice does not:

- Change `memory_write_card` C18/C19 behavior.
- Add the C27 recall agent migration.
- Change run finalizer or run terminal status.
- Redesign the memory capture UI.
- Create a staged-card UI for summaries.

## Implementation Steps

1. Add a narrow optional CAS dependency to `ReflectionService`.
   - It accepts `userId` plus deterministic picture observations.
   - Runtime wires it to `runUserPictureCasMerge` with the current raw DB.

2. Stop reflection direct memory writes.
   - Remove the active call path to `memoryRepository.createMemory` for `resident_user`.
   - Remove the active call path to `memoryRepository.createMemory` for `scope_memory`.
   - Keep reflection output available as the method return value, but return `memoryCapture: null`.

3. Add `reflection_outcome` metrics.
   - Very short conversations emit `decision: "skip"`.
   - No CAS dependency emits `decision: "skip"`.
   - CAS merged emits `decision: "cas_merged"`.
   - CAS gate/cas skips emit `decision: "skip"`.
   - Provider/runtime errors emit `decision: "error"` and do not throw to the caller.

4. Wire tests and verification.
   - Add `reflection-staged-not-resident.test.ts`.
   - Update existing reflection tests so direct resident/scope writes are no longer considered success.
   - Add the new test to `verify:evolution-p1`.

## Acceptance

P4-C is done only when:

- Focused reflection tests pass.
- `verify:evolution-p1` passes.
- `typecheck` passes.
- A Claude implementation review is attempted and recorded.

Closeout note: Claude CLI produced no usable review output for the implementation review, so that attempt is recorded as a failure in `221`. A narrow alternate reviewer found a runtime wiring blocker; the blocker was fixed and `222` records the passing verification.

## Deferred

P4-D remains next:

- `063_session_recall_agent_column`
- recall write/query/automatic recall agent scoping
- migration backfill from `chat_conversations.agent`
