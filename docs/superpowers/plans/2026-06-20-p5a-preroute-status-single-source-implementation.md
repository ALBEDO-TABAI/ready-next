---
title: P5a preroute status single source implementation
date: 2026-06-20
phase: P5a
covers: [C25]
enforce: true
source:
  - outputs/agent-audit/fix-plan/P5-unwired-capability-decision.md
  - outputs/agent-audit/fix-plan/225-CLAUDE-P5-PLAN-RESCOPE-REVIEW.md
  - outputs/agent-audit/fix-plan/226-CONSENSUS-P5-SLICED-ROUTE.md
  - outputs/agent-audit/fix-plan/227-SUBAGENT-P5-PLAN-RESCOPE-REVIEW.md
  - outputs/agent-audit/fix-plan/232-SUBAGENT-P5A-PLAN-REVIEW.md
---

# P5a Preroute Status Single Source Implementation

## Goal

Close C25 only:

- remove the duplicated preroute open-status lists;
- remove the hidden follow-up classifier open-status list;
- remove ghost status `active`;
- include `queued` as an open task state;
- make `off` mode a true no-op in both real preroute and Studio simulation.

## Non-Goals

P5a does not:

- hide the handoff new-session option;
- change handoff tool descriptions;
- mark packet files unwired;
- touch maintenance/CAS/emergence;
- touch specialist derivation;
- implement P6 TurnEngine or drift-gate work;
- change browser isolation or P2b shell isolation.

## Implementation Steps

### 1. Add Shared Open-Status Source

Create:

- `src/main/modules/agent-control/contracts/task-open-status.ts`

It must derive open task statuses from the shared child-run status source:

- `SKILL_CHILD_RUN_STATUSES`
- `SKILL_CHILD_RUN_TERMINAL_STATUSES`

The open set must be:

- `queued`
- `running`
- `recoverable_paused`
- `budget_paused`
- `blocked`

Export `isOpenTaskStatus(value)` for P5a. It is acceptable to also export `isPausedStatus(value)` now if it is small and directly reuses the same source, because P6 will consume this file later.

### 2. Add Gate

Add:

- `scripts/check-preroute-status-single-source.cjs`

The gate must fail if:

- `agent-followup-intent.ts` keeps a local continuable-status set;
- `session-preroute.ts` recreates the old inline status set;
- `session-preroute-trace.ts` recreates the old inline status set;
- either file uses `active` as a task status;
- either file hard-codes a local open-status array/set instead of importing the shared helper.
- either real preroute or Studio simulation reads agent/task/routing/trace inventory before the `off` short-circuit.

### 3. Add Behavior Tests

Add:

- `src/__tests__/p5a-preroute-status-single-source.test.ts`

Required assertions:

- a `queued` owned task can trigger state-tier preroute for continuation/status requests;
- terminal tasks do not count as open;
- `session-preroute-trace.ts` uses the same status source for state-owner trace reasons;
- pure preroute `off` mode returns fallback/none;
- the gate proves real `evaluateSessionPreroute` in `off` mode returns before listing agents, tasks, routing cards, or pushing a trace;
- the gate proves Studio simulation in `off` mode returns before agent/task/routing/trace inventory reads.

### 4. Wire Source Into Code

Update:

- `src/shared/skill-child-run-status.ts`
- `src/shared/agent-followup-intent.ts`
- `src/main/modules/agent-control/agents/session-preroute.ts`
- `src/main/modules/agent-control/agents/session-preroute-trace.ts`
- `src/main/modules/agent-control/runtime-core/runtime.ts`

`evaluateSessionPreroute` must short-circuit before:

- `agentRegistry.list()`
- `taskProjectionStore.listRecentTasksForPreroute`
- `getBeliefCardStore().listRoutingCards`
- `pushSessionPrerouteTraceSafely`

`simulateSessionPrerouteForStudio` must also short-circuit before agent/task/routing/trace inventory reads when mode is `off`.

### 5. Hook Verify Chain

Update `package.json`:

- add the new test to `verify:evolution-p4`;
- add `src/__tests__/preroute-trace.test.ts` to `verify:evolution-p4`;
- add `node scripts/check-preroute-status-single-source.cjs` to `verify:evolution-p4`.

Do not create a standalone-only verify script.

## Acceptance

P5a is done only when all pass:

```bash
node scripts/check-preroute-status-single-source.cjs
npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/p5a-preroute-status-single-source.test.ts src/__tests__/session-preroute.test.ts src/__tests__/preroute-trace.test.ts
npm run verify:evolution-p4
npm run typecheck
```

Run broader checks if the implementation touches more than the files listed above.

## Deferred

- P5b/C24: hide handoff new-session option and update the model-visible tool description.
- P5c/C22: mark packet trio not in production path.
- P5d/C26: re-scope maintenance/crystallize/emergence without touching live CAS or deleting consumed status surfaces.
- P5e/C23: re-scope duplicate derivation and live blueprint creation boundary.
- P6 will reuse `task-open-status.ts` and may fold the P5a gate into its broader shared-enum drift gate.
