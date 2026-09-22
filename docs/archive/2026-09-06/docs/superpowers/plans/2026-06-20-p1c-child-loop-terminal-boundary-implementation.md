---
title: P1c child-loop terminal boundary implementation
date: 2026-06-20
branch: agent-evolution/phase1
enforce: false
source:
  - outputs/agent-audit/fix-plan/00-ROADMAP.md
  - outputs/agent-audit/fix-plan/P1-terminal-finalize-funnel.md
  - outputs/agent-audit/fix-plan/194-CONSENSUS-P1C-CHILD-LOOP-TERMINAL-BOUNDARY-ROUTE.md
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# P1c child-loop terminal boundary implementation

## Completion Standard

Child-loop terminal projection writes are protected by a dedicated machine-checkable boundary. Existing child-run behavior remains unchanged.

## Required Work

- Add `scripts/check-child-loop-terminal-boundary.cjs`.
- Add `scripts/__tests__/check-child-loop-terminal-boundary.test.cjs`.
- Add `src/__tests__/child-loop-terminal-funnel.test.ts`.
- Wire the new gate and focused test into `verify:stability`.

## Gate Rules

- `buildChildTaskProjectionRecord(...)` call sites are allowed only in:
  - `publishScopeRunClose`
  - `upsertChildTaskProjection`
  - `publishInactiveChildRunClose`
  - `updateInactiveChildRunProjectionSiblings`
- `type: 'finished'` scope-run events are allowed only in `publishScopeRunClose`.
- Direct child projection terminal writes outside this boundary fail.

## Runtime Test Rules

The funnel test must drive real child-run closes and assert observable rows:

- completed close -> child projection `completed`;
- failed close -> child projection `failed`;
- killed close -> child projection `killed`;
- `taskId` is `skill-child:<childRunId>`;
- `runId` is the child run id;
- `module` is `skill`;
- `interactionState` is `suspended`.

## Verification

```bash
node scripts/check-child-loop-terminal-boundary.cjs
node --test scripts/__tests__/check-child-loop-terminal-boundary.test.cjs
npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/child-loop-terminal-funnel.test.ts
npm run verify:stability
npm run typecheck
git diff --check
```
