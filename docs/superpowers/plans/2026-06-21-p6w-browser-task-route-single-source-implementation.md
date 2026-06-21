---
title: P6w · Browser Task Route Single Source Implementation
date: 2026-06-21
branch: agent-evolution/phase1
enforce: true
source:
  - outputs/agent-audit/fix-plan/00-ROADMAP.md
  - outputs/agent-audit/final/02-CODEX-INDEPENDENT-CANONICAL-FINDINGS.md
  - outputs/agent-audit/fix-plan/449-P6V-FRAME-PATCH-TOOL-NAME-ISLAND-CLOSEOUT.md
  - outputs/agent-audit/fix-plan/452-CLAUDE-P6W-REMAINING-PLAN-PROMPT.md
  - outputs/agent-audit/fix-plan/453-CLAUDE-P6W-REMAINING-PLAN-FAILURE.md
  - outputs/agent-audit/fix-plan/454-CONSENSUS-P6W-BROWSER-TASK-ROUTE-SINGLE-SOURCE.md
---

# P6w Browser Task Route Single Source Implementation

## Verdict

Implement one narrow C32 slice: browser task route single-source.

The current browser task kind vocabulary and default TaskEventBridge route list
are two copies of the same rule. P6w makes `capability-types.ts` the single
source and makes the bridge consume that source.

## Scope In

1. `src/main/modules/browser-engine/capability-types.ts`
   - Add `BROWSER_CAPABILITY_TASK_KINDS` as the runtime constant containing the
     current six task kinds.
   - Derive `BrowserCapabilityTaskKind` from that constant.
2. `src/main/modules/browser-engine/task-event-bridge.ts`
   - Import `BROWSER_CAPABILITY_TASK_KINDS`.
   - Remove the local `DEFAULT_TASK_ROUTES` copied list.
   - Initialize `registeredRoutes` from `BROWSER_CAPABILITY_TASK_KINDS`.
3. `scripts/check-browser-task-route-single-source.cjs`
   - Fail if the browser task kind constant is missing.
   - Fail if the type is not derived from the constant.
   - Fail if `task-event-bridge.ts` reintroduces a local copied route list.
   - Fail if the bridge does not import/use `BROWSER_CAPABILITY_TASK_KINDS`.
4. `scripts/__tests__/check-browser-task-route-single-source.test.cjs`
   - Passing harness.
   - Red tests for missing constant, non-derived type, local copied bridge list,
     missing bridge import/use, missing route, and extra route.
5. `package.json`
   - Add `verify:evolution-p6w` chaining the new gate/self-test, focused
     `task-event-bridge.test.ts`, and `verify:evolution-p6v`.

## Scope Out

- No behavior change to browser task scheduling.
- No change to browser task status vocabulary.
- No change to `TaskEventBridgeStatus`.
- No change to startup reconciliation or browser task persistence.
- No map/amap cleanup.
- No DirectChat/TurnEngine cleanup.
- No C30 type extraction.
- No P2b or browser identity isolation work.

## Acceptance Criteria

1. `task-event-bridge.ts` has no local copied browser task route array.
2. `BROWSER_CAPABILITY_TASK_KINDS` is the only runtime default route source.
3. Existing `task-event-bridge.test.ts` keeps passing.
4. New gate self-tests cover both green and red cases.
5. `npm run verify:evolution-p6w` passes.
6. `npm run typecheck` passes.
7. `git diff --check` passes.

## Anti-Overclaim

This closes only the browser task route-list drift point in C32. It does not
close full C32, full P6, C29, C30, C31, map/amap cleanup, P2b, browser identity
isolation, or specialist-agent product work.
