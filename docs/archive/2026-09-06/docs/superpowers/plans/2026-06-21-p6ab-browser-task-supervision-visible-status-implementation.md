---
title: P6ab Browser Task Supervision-Visible Status Implementation
date: 2026-06-21
phase: P6ab
route: P6 structural-debt drift
audit_ids:
  - C32
status: ready
enforce: false
source:
  - outputs/agent-audit/fix-plan/499-SUBAGENT-P6-REMAINING-AFTER-P6AA-CONSENSUS.md
  - outputs/agent-audit/fix-plan/495-P6AA-BROWSER-TASK-STATUS-PUBLISH-CLOSEOUT.md
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# P6ab Browser Task Supervision-Visible Status Implementation

## Completion Standard

This slice is complete only when a browser task in `waiting_human` is visible in
the agent-browser supervision panel from main IPC through renderer filtering,
while startup resume still does not auto-run that task.

## Root Issue

P6aa made browser task status publishing single-sourced, but the supervision
visibility path still has separate hand-written active-status lists:

- main IPC filters tasks to `running/queued/paused`;
- BrowserMode filters tasks to `running/queued/paused`;
- `AgentBrowserSupervisionPanel` filters tasks to `running/queued/paused`;
- note-collect reproject has its own re-enterable status rule.

That means a persisted `waiting_human` task can correctly exist, correctly
publish, and correctly project as verification-paused, yet vanish from the
browser supervision panel.

## Scope In

- Add one shared browser task status helper for supervision-visible statuses.
- Include `queued`, `running`, `paused`, and `waiting_human`.
- Use that helper in:
  - `src/main/modules/browser-engine/ipc-supervision.ts`
  - `src/main/modules/browser-engine/content-task-runner.ts`
  - `src/renderer/pages/modes/BrowserMode.tsx`
  - `src/renderer/components/browser/AgentBrowserSupervisionPanel.tsx`
- Add a visible label for `waiting_human`.
- Add a gate plus self-test that rejects future hand-written supervision-visible
  status lists.
- Add focused behavior tests for helper behavior, persistence startup boundary,
  and renderer copy.
- Add `verify:evolution-p6ab`.

## Scope Out

- No change to P6aa `TaskEventBridge` publish mapping.
- No change to `publicStatus` semantics.
- No change to startup reconciliation or auto-resume behavior.
- No browser identity isolation work.
- No C29/C30/C31 changes.
- No full C32/P6 closure claim.

## Likely Files

- `src/shared/browser-task-status.ts`
- `src/main/modules/browser-engine/capability-types.ts`
- `src/main/modules/browser-engine/ipc-supervision.ts`
- `src/main/modules/browser-engine/content-task-runner.ts`
- `src/renderer/modules/browser/useAgentBrowserSupervision.ts`
- `src/renderer/pages/modes/BrowserMode.tsx`
- `src/renderer/components/browser/AgentBrowserSupervisionPanel.tsx`
- `src/__tests__/browser-task-persistence.test.ts`
- `src/__tests__/browser-supervision-panel-copy.test.tsx`
- `src/__tests__/browser-task-status.test.ts`
- `scripts/check-browser-task-supervision-status-single-source.cjs`
- `scripts/__tests__/check-browser-task-supervision-status-single-source.test.cjs`
- `package.json`

## Proofs

Red/green expectations:

- `waiting_human` is included by the shared supervision-visible helper.
- The supervision panel renders `waiting_human` as waiting for verification.
- `listPendingTasks()` still excludes `waiting_human`, proving this slice does
  not turn verification waits into startup auto-resume.
- Main and renderer supervision filters use the shared helper, not local
  `queued/running/paused` lists.

Verification commands:

```bash
node scripts/check-browser-task-supervision-status-single-source.cjs
node --test scripts/__tests__/check-browser-task-supervision-status-single-source.test.cjs
npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/browser-task-status.test.ts src/__tests__/browser-task-persistence.test.ts src/__tests__/browser-supervision-panel-copy.test.tsx src/__tests__/browser-agent-pane-contract.test.ts
npm run verify:evolution-p6ab
npm run typecheck
```

## Closeout Wording

Allowed:

- "P6ab closes one C32 browser supervision visibility drift: `waiting_human`
  tasks remain visible to the supervision panel through a shared status helper."

Forbidden:

- "P6ab closes C32."
- "P6ab closes P6."
- "P6ab fixes browser identity isolation."
- "P6ab changes startup resume behavior."
