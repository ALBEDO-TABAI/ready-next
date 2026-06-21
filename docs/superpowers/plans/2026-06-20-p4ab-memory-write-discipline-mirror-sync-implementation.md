---
title: P4-AB memory write discipline + mirror sync implementation
date: 2026-06-20
phase: P4-AB
enforce: true
source:
  - outputs/agent-audit/fix-plan/P4-knowledge-memory-discipline.md
  - outputs/agent-audit/fix-plan/206-CLAUDE-P4AB-PLAN-REVIEW.md
  - outputs/agent-audit/fix-plan/207-CONSENSUS-P4AB-MEMORY-WRITE-MIRROR-ROUTE.md
---

# P4-AB · memory_write_card staged discipline + mirror receipt

## Scope

This implementation covers only:

- C18: `memory_write_card` authorization discipline.
- C19: immediate belief-card mirror sync receipt and failure metric.

Explicitly out of scope:

- C20/C21 reflection staged/CAS routing and reflection ledger.
- C27 session recall agent scope and migration 060.
- P5/P6, P2b, browser identity isolation, and specialist-agent product work.

## C18 Contract

`memory_write_card` is model-safe by construction:

- Model and child-runner invokers cannot create active cards through the tool.
- Model-supplied `status:'active'` is downgraded to `staged`.
- `confirmed_active` is not a schema field and is not read from tool args.
- Active-card production remains the existing confirmation path: `BeliefCardStore.transition()`.
- Existing active cards cannot be silently overwritten by model/child-runner calls.
- Agent-scoped paths must match `context.scope.agent`; missing or mismatched owner rejects the write and never falls back to global.

## C19 Contract

After a successful card file write:

- `memory_write_card` calls `syncBeliefCardFile(db, store, relPath)` in the same call stack when a mirror DB handle is available.
- `synced`, `recovered`, and `skipped` mean `mirrorSynced:true`.
- `invalid` after a freshly written valid card is defensive failure: `mirrorSynced:false`, `mirrorSyncErrorKind:'mirror_invalid_after_write'`.
- A thrown sync failure does not fail the tool, but returns `mirrorSynced:false`, includes `mirrorSyncErrorKind`, and emits one `belief_card_mirror_sync_failed` metric with `relPath`.
- `KnowledgeWatcher` remains the hand-edit fallback and is not changed.

## Required Artifacts

- `src/__tests__/memory-card-write-discipline.test.ts`.
- `src/__tests__/memory-card-mirror-sync.test.ts`.
- `scripts/check-model-card-write-staged.cjs`.
- `scripts/__tests__/check-model-card-write-staged.test.cjs`.
- `src/main/modules/tools/memory-tools.ts`.
- `src/main/modules/agent-control/runtime-core/runtime.ts`.
- `src/main/modules/tools/schemas/memory-schemas.ts`.
- `src/__tests__/memory-card-tools.test.ts`.
- `package.json` `verify:evolution-p1`.

## Verification

Focused:

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/memory-card-write-discipline.test.ts src/__tests__/memory-card-mirror-sync.test.ts src/__tests__/memory-card-tools.test.ts src/__tests__/belief-card-db-sync.test.ts
node scripts/check-model-card-write-staged.cjs
node --test scripts/__tests__/check-model-card-write-staged.test.cjs
```

Batch:

```bash
npm run verify:evolution-p1
npm run typecheck
```

This slice is not complete until the focused checks, `verify:evolution-p1`, `typecheck`, and Claude implementation review all pass.
