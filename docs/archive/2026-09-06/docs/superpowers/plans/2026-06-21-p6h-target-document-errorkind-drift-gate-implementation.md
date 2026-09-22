---
title: P6h target-document errorKind drift gate implementation
date: 2026-06-21
status: enforce
enforce: false
scope: C32 target-document errorKind registry and drift gate
source:
  - outputs/agent-audit/fix-plan/319-CONSENSUS-P6H-TARGET-DOCUMENT-ERRORKIND-ROUTE.md
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Goal

Move SDK target-document guard errorKind values into the shared registry and make the drift gate prevent future local copies.

# Work Plan

1. Extend `error-kinds.ts`.
   - Add `TARGET_DOCUMENT_ERROR_KINDS`.
   - Include it in `isRegisteredErrorKind` and `lookupErrorKindMeta`.

2. Extend `check-shared-enum-drift.cjs`.
   - Require all six `target_document_*` values.
   - Require `agent-sdk-runtime.ts` to consume `TARGET_DOCUMENT_ERROR_KINDS`.
   - Fail if SDK runtime copies the registered literals into `errorKind` fields.

3. Extend gate tests.
   - Red when a target-document kind is unregistered.
   - Red when SDK runtime copies a target-document literal.

4. Update SDK runtime.
   - Replace only the six target-document `errorKind` literals with shared constants.
   - Do not refactor document guard behavior.

5. Add focused verification.
   - Add `verify:evolution-p6h`.

# Non-goals

- No broad tool error taxonomy cleanup.
- No C29 dormant compaction cleanup.
- No C30 file split.
- No P6 completion claim.

# Required Verification

- `npm run verify:evolution-p6h`
- `npm run verify:evolution-p6d`
- `npm run typecheck`
- `npm run verify:evolution-p6g`
- `git diff --check` on touched files

# Completion Criteria

- `check-shared-enum-drift.cjs` fails on unregistered target-document errorKinds.
- `check-shared-enum-drift.cjs` fails on local target-document literals in SDK runtime.
- The real codebase passes the shared-enum gate.
- P6g regression still passes.
- `317` is recorded as Claude no-output and replaced by subagent review, not treated as Claude approval.
