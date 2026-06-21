---
title: P5b handoff new-session hidden implementation
date: 2026-06-20
phase: P5b
covers: [C24]
enforce: true
source:
  - outputs/agent-audit/fix-plan/226-CONSENSUS-P5-SLICED-ROUTE.md
  - outputs/agent-audit/fix-plan/P5-unwired-capability-decision.md
  - outputs/agent-audit/fix-plan/234-CLAUDE-P5B-PLAN-FAILURE.md
  - outputs/agent-audit/fix-plan/235-SUBAGENT-P5B-PLAN-REVIEW.md
  - outputs/agent-audit/fix-plan/236-CONSENSUS-P5B-HANDOFF-NEWSESSION-HIDDEN-ROUTE.md
---

# P5b Handoff New-session Hidden Implementation

## Goal

Close C24 only:

- hide the visible "新会话接手（预填原话）" option from the production handoff proposal card;
- keep the future implementation assets intact;
- update the model-visible `agent_propose_handoff` description so it no longer advertises a hidden option.

## Non-goals

P5b does not:

- delete `HANDOFF_NEW_SESSION_OPTION`;
- delete `adopted_new_session`;
- delete or weaken `prefillVerbatim`;
- implement renderer/preload/new-session prefill wiring;
- add a feature flag or settings toggle;
- change same-session handoff adoption;
- touch packet, maintenance, derivation, browser isolation, or P6 structural-debt work.

## Implementation Steps

### 1. Add A Behavior Test

Add:

- `src/__tests__/handoff-newsession-hidden.test.ts`

Required assertions:

- emitted handoff card options contain `HANDOFF_ADOPT_OPTION`;
- emitted handoff card options contain `HANDOFF_REJECT_OPTION`;
- emitted handoff card options do not contain `HANDOFF_NEW_SESSION_OPTION`;
- manually resolving the retained hidden option still drives the asset branch and returns `adopted_new_session`;
- retained branch preserves `prefillVerbatim` byte-for-byte and keeps `contextRefs`.

### 2. Add A Gate

Add:

- `scripts/check-unwired-handoff-newsession.cjs`

The gate must fail if:

- `handoff-proposal.ts` production `question.options` contains `HANDOFF_NEW_SESSION_OPTION`;
- `HANDOFF_NEW_SESSION_OPTION` is missing;
- `HandoffProposalOutcome` no longer includes `adopted_new_session`;
- `runHandoffProposal()` no longer contains the `answer === HANDOFF_NEW_SESSION_OPTION` branch;
- the retained branch lacks an `unwired-handoff-newsession` marker comment;
- `agent-interaction-tool-defs.ts` still advertises "新会话接手" in `PROPOSE_HANDOFF_DESCRIPTION`.
- renderer or preload files add a `prefillVerbatim` consumer in this B1 slice.

### 3. Hide Production Exposure Without Deleting Assets

Update:

- `src/main/modules/agent-control/agents/handoff-proposal.ts`

Required shape:

- `question.options` includes only same-session adoption and reject options;
- `HANDOFF_NEW_SESSION_OPTION` remains exported;
- `adopted_new_session` remains in `HandoffProposalOutcome`;
- the retained runtime branch remains reachable for asset tests;
- add marker comment `unwired-handoff-newsession` immediately above the retained branch.

### 4. Update Model-visible Description

Update:

- `src/main/modules/tools/agent-interaction-tool-defs.ts`

Required shape:

- the `agent_propose_handoff` description must not say the card exposes "新会话接手";
- it should describe only the exposed choices: same-session adoption and rejection;
- it must keep the advisory / user-click-only handoff rule.

Do not change the input schema.

### 5. Hook Verify Chain

Update:

- `package.json`

Add the new behavior test and gate to `verify:evolution-p4`.

## Acceptance

P5b is done only when all pass:

```bash
node scripts/check-unwired-handoff-newsession.cjs
npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/handoff-newsession-hidden.test.ts src/__tests__/agent-handoff-proposal.test.ts src/__tests__/verbatim-relay.test.ts
npm run verify:evolution-p4
npm run typecheck
```

Run broader checks if implementation touches files outside this plan.

## Deferred

- Future A slice: real renderer/preload/new-session prefill wiring.
- Future B2 decision: full deletion of the retained new-session branch.
- P5c/C22: packet trio not-live marking.
- P5d/C26: remaining maintenance/emergence re-scope.
- P5e/C23: duplicate derivation/live blueprint boundary.
