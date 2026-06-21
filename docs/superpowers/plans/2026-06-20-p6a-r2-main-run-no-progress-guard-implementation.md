---
title: P6a-R2 main run no-progress guard implementation
date: 2026-06-20
phase: P6a-R2
enforce: true
depends:
  - docs/superpowers/plans/2026-06-20-p6a-run-continuity-hotfix-implementation.md
sources:
  - outputs/agent-audit/fix-plan/228-CLAUDE-P6A-P6B-CURRENT-REVIEW.md
  - outputs/agent-audit/fix-plan/229-CONSENSUS-P6A-R2-MAIN-GUARD-ROUTE.md
---

# P6a-R2 · Main Run No-Progress Guard

## Goal

Close the remaining installed-app run-continuity gap: main must be able to interrupt or resumably mark a stuck active run even when the renderer watchdog does not fire.

P6a-R2 is a narrow P1-backed hotfix. It complements the existing renderer-to-main timeout report; it does not reopen full P6.

## Non-Scope

Do not include:

- context-budget or compaction policy changes;
- `L1_summary` truncation prevention;
- TurnEngine retirement;
- giant-file splitting;
- Windows/path redaction;
- shared enum cleanup;
- browser identity/profile isolation;
- specialist-agent UI or product work;
- document tool timeout tuning.

## Contract

1. Main tracks active run liveness by `agent + scopeId + requestId`.
2. The active run ledger records `startedAt`, `lastProgressAt`, and enough authority to interrupt the owning runtime.
3. Progress events refresh `lastProgressAt`:
   - model output / stream delta;
   - tool dispatch or result;
   - scope-run status event;
   - explicit checkpoint/progress status.
4. A guard tick only acts if the active run still matches the same `scopeId + requestId`.
5. If no progress occurs beyond the threshold, main requests cancellation through the owning runtime and lets the normal terminal/finalizer path settle the run.
6. If the run cannot be finalized immediately, it must be marked as takeover pending or resumable with a durable handle, not silently left active.
7. Renderer-visible failure classification must distinguish main no-progress timeout from renderer infrastructure timeout, model timeout, and tool timeout.

## Implementation Shape

- Put the guard at the `AgentControlRuntime` / `ReadyAgentOrchestrator` boundary where active run authority already exists.
- Reuse the existing request-id authority pattern from `reportInfrastructureTimeout`.
- Avoid broad session-level kill APIs that do not prove the request id.
- Keep thresholds local and testable; do not introduce user-facing settings in this slice.
- Prefer deterministic fake-clock or injected timer tests over real sleeps.

## Tests / Gates

Required:

- `src/__tests__/orchestrator-main-no-progress-guard.test.ts`
  - main interrupts an active no-progress run without any renderer timeout report;
  - progress refresh prevents premature interruption;
  - stale tick for an old request is a no-op after a newer same-scope request starts.
- Extend `src/__tests__/renderer-error-mapping.test.ts` if a new errorKind is introduced.
- Keep `node scripts/check-run-finalize-funnel.cjs` green.

Fold into:

```bash
npm run verify:evolution-p6a
npm run verify:stability
npm run typecheck
```

## Exit Standard

P6a-R2 is complete only when:

- the focused main-guard behavior tests pass;
- `verify:evolution-p6a` passes with the new test included;
- `verify:stability` passes;
- `typecheck` passes;
- `00-ROADMAP.md`, `214-P6A-RUN-CONTINUITY-HOTFIX-CLOSEOUT.md`, and this implementation doc agree that P6a first pass closed the renderer-reported path, while P6a-R2 closes the main-only stuck-run path.

## Closeout

Closed by `outputs/agent-audit/fix-plan/230-P6A-R2-MAIN-RUN-NO-PROGRESS-GUARD-CLOSEOUT.md`.
