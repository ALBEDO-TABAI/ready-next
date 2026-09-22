---
title: P6b context budget and compaction continuity implementation
date: 2026-06-20
phase: P6b
enforce: false
depends:
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-06-20-p6a-run-continuity-hotfix-implementation.md
sources:
  - outputs/agent-audit/fix-plan/216-CODEX-P6B-C28C29-INDEPENDENT-REVIEW.md
  - outputs/agent-audit/fix-plan/217-CONSENSUS-P6B-CONTEXT-COMPACTION-ROUTE.md
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# P6b · Context Budget And Compaction Continuity

## Goal

Close the first C28/C29 slice after P6a:

- make prompt context budget reporting cover every actually injected prompt section;
- prove the live SDK compaction and snapshot seed paths preserve continuity-critical context;
- lock dormant compaction out of the live SDK path.

## Non-Scope

Do not implement:

- TurnEngine retirement;
- DirectChat send path deletion;
- C30 giant-file splitting;
- C31 path redaction;
- C32 shared enum/errorKind drift gate;
- P4 reflection/recall policy;
- browser isolation;
- specialist-agent product work.

## Step 1: Context Budget Alignment

Files:

- `src/main/modules/agent-control/prompt-assembly.ts`
- `src/main/modules/agent-control/context-bill.ts`
- `src/main/modules/agent-control/contracts/types.ts`
- `src/renderer/modules/agent/types.ts`
- `src/renderer/types/electron.d.ts`
- `src/__tests__/prompt-context-budget-coverage.test.ts`

Contract:

- Keep legacy `totalChars`, `l0Chars`, `l1Chars`, `l2Chars`, and `droppedRefs`.
- Add `totalBytes`, `sectionBytes`, and `truncations`.
- `contextBudget.totalBytes` equals the emitted `context_bill.total` for the same assembled prompt.
- `sectionBytes` uses the same section keys as `context_bill`.
- Rules, knowledge index, agent routing, recall, autoRecall, and L2 trigger text are nonzero when injected.

## Step 2: Continuity-Preserving Compaction Proof

Files:

- `src/main/modules/agent-control/compaction/compact-agent-input.ts`
- `src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts`
- `src/main/modules/agent-control/session/scope-session-snapshot.ts`
- `src/__tests__/compact-agent-input.test.ts`
- `src/__tests__/session-snapshot-lazy-restore.test.ts`

Contract:

- Latest user request in the retained tail stays present.
- Complete tool call/result pairs stay together.
- Orphan calls/results are removed.
- Snapshot seed restoration uses the same `normalizeSessionSnapshotForSeed()` rule as live compaction paths.
- Manual compaction and overflow/pre-send compaction continue using `compactAgentInputItems()`.

## Step 3: Dormant Compaction Boundary Gate

Files:

- `scripts/check-dormant-compaction-not-in-live-path.cjs`
- `scripts/__tests__/check-dormant-compaction-not-in-live-path.test.cjs`
- `package.json`

Contract:

- `agent-sdk-runtime.ts` may import `compact-agent-input`.
- `agent-sdk-runtime.ts` must not import `layered-compactor`, `layered-compactor-l2-stub`, or `context-compression`.
- `prompt-assembly.ts` may import `context-compression` for L1 prompt summary.
- Existing dormant `turn-engine.ts` / `direct-chat.ts` imports may remain until a later retirement slice.
- `layered-compactor.ts` may remain referenced only by dormant TurnEngine code until a later retirement slice.

## Verification

Run:

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/prompt-context-budget-coverage.test.ts src/__tests__/compact-agent-input.test.ts src/__tests__/session-snapshot-lazy-restore.test.ts
node scripts/check-dormant-compaction-not-in-live-path.cjs
node --test scripts/__tests__/check-dormant-compaction-not-in-live-path.test.cjs
npm run verify:evolution-p6b
npm run verify:d
npm run typecheck
```

Run `npm run verify:evolution-p1` if the prompt budget fold-in changes that script.

## Done When

- All focused tests and gates pass.
- `verify:evolution-p6b` passes.
- Existing folded-in verify chains pass.
- `typecheck` passes.
- `00-ROADMAP.md` and closeout docs record P6b as closed.
