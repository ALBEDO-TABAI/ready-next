---
title: P6d · C32 status and errorKind drift gate
date: 2026-06-20
phase: P6d
scope: C32 shared status/errorKind drift first slice
enforce: true
sources:
  - outputs/agent-audit/fix-plan/274-CLAUDE-P6D-C32-PLAN-REVIEW.md
  - outputs/agent-audit/fix-plan/276-SUBAGENT-P6D-C32-PLAN-REVIEW.md
  - outputs/agent-audit/fix-plan/277-CONSENSUS-P6D-C32-STATUS-DRIFT-ROUTE.md
---

# P6d · C32 Status and ErrorKind Drift Gate

## Goal

Close the narrow C32 drift slice without widening P6.

This plan prevents duplicated status/errorKind vocabularies from drifting while keeping each state machine semantically distinct.

## In Scope

- Shared run_meta terminal status source.
- `check-run-finalize-funnel.cjs` consumes the shared run_meta source.
- P5a `task-open-status.ts` is reused; direct-resume status gets a dedicated helper.
- TurnEngine, run-contracts, and turn-frame resolver stop duplicating recoverable/budget paused checks.
- Detached task status aliases `NormalizedRunStateStatus`.
- detached_task and send-im errorKinds are registered in `error-kinds.ts`.
- New `check-shared-enum-drift.cjs` gate with fixture tests.
- Package scripts wire the new gate into `test:l:gates`, `verify:l:gates`, and focused `verify:evolution-p6d`.

## Out of Scope

- C30 giant-file split.
- C31-b primitive-wide path redaction.
- C29 TurnEngine/DirectChat retirement.
- all-tool errorKind taxonomy.
- fixing the existing full-repo lint/no-fire baseline.
- claiming P6 is complete.

## Verification

Required:

- `node scripts/check-shared-enum-drift.cjs`
- `node --test scripts/__tests__/check-shared-enum-drift.test.cjs`
- `node scripts/check-run-finalize-funnel.cjs`
- `node --test scripts/__tests__/check-run-finalize-funnel.test.cjs`
- `npm run verify:evolution-p6d`
- `npm run typecheck`
- relevant adjacent chains: `test:l:gates`, `verify:stability`, `verify:evolution-p4`

Broader `verify:l:gates` is desirable, but if it fails on the existing no-fire baseline after the new C32 gate has passed, the closeout must record that as blocked and must not claim full `verify:l:gates` success.
