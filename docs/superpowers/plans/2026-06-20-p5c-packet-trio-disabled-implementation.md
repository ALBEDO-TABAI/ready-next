---
title: P5c packet trio disabled implementation
date: 2026-06-20
phase: P5c
covers: [C22]
enforce: true
source:
  - outputs/agent-audit/fix-plan/226-CONSENSUS-P5-SLICED-ROUTE.md
  - outputs/agent-audit/fix-plan/241-CLAUDE-P5C-PLAN-REVIEW.md
  - outputs/agent-audit/fix-plan/242-SUBAGENT-P5C-PLAN-REVIEW.md
  - outputs/agent-audit/fix-plan/243-CONSENSUS-P5C-PACKET-TRIO-DISABLED-ROUTE.md
---

# P5c Packet Trio Disabled Implementation

## Goal

Close C22 only: make it explicit and machine-checked that the packet compiler, packet dispatch, and packet failure settlement modules are dormant code assets and are not in the production path.

任务包体系未启用：Ready currently validates packet fields on task projections, but it does not run packet compile -> dispatch -> failure settlement in the live agent runtime.

## Non-goals

P5c does not:

- touch `packet-fields.ts`;
- remove packet field validation from task projections;
- wire packet compile / dispatch / failure into production scheduling;
- add renderer UI for task packets;
- include P5d/C26 maintenance, CAS, emergence, or `getMaintenanceRoundStatus`;
- claim the dormant trio tests prove a live production feature.

## Implementation Steps

### 1. Add A Gate

Add:

- `scripts/check-unwired-capability-markers.cjs`

The gate must:

- define exactly three unwired files:
  - `src/main/modules/agent-control/quality/packet-compiler.ts`
  - `src/main/modules/agent-control/quality/packet-dispatch.ts`
  - `src/main/modules/agent-control/quality/packet-failure.ts`
- fail unless each file contains both `unwired` and `not in production path`;
- fail if production source imports or requires any of the three files;
- allow tests to import them;
- allow only exact intra-trio imports:
  - `packet-failure.ts` -> `packet-compiler.ts`
  - `packet-dispatch.ts` -> `packet-compiler.ts`
- fail if `packet-fields.ts` is added to the unwired list or marked as disabled.

### 2. Add A Gate Test

Add:

- `scripts/__tests__/check-unwired-capability-markers.test.cjs`

Required assertions:

- missing source marker fails;
- production import of the trio fails;
- test import of the trio passes;
- live `packet-fields.ts` import passes;
- marking `packet-fields.ts` as unwired fails.

### 3. Mark The Trio Only

Update only the header comments in:

- `packet-compiler.ts`
- `packet-dispatch.ts`
- `packet-failure.ts`

Required marker text:

- `P5c/C22 unwired`
- `not in production path`

Do not change function bodies.

### 4. Hook Verify Chain

Update:

- `package.json`

Add the gate and its script test to `verify:evolution-p3`, where the packet trio tests already run.

## Acceptance

P5c is done only when all pass:

```bash
node scripts/check-unwired-capability-markers.cjs
node --test scripts/__tests__/check-unwired-capability-markers.test.cjs
npx tsx --test src/__tests__/packet-compiler-gate.test.ts src/__tests__/packet-dispatch-channels.test.ts src/__tests__/packet-failure-upstream.test.ts
npm run verify:evolution-p3
npm run verify:evolution-p4
npm run typecheck
```

## Deferred

- Future packet activation: production compile -> dispatch -> failure settlement wiring after run-finalizer and background-task channels are ready for that expansion.
- P5d/C26: maintenance/CAS/emergence status re-scope.
- P5e/C23: duplicate derivation/live blueprint boundary.
