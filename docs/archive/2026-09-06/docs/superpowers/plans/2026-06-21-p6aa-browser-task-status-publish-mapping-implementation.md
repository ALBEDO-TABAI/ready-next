---
title: P6aa Browser Task Status Publish Mapping Implementation
date: 2026-06-21
phase: P6aa
priority: P2
enforce: false
depends:
  - outputs/agent-audit/fix-plan/490-CLAUDE-P6AA-BROWSER-TASK-STATUS-PLAN.md
  - outputs/agent-audit/fix-plan/491-CODEX-P6AA-PLAN-REVIEW.md
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# P6aa Browser Task Status Publish Mapping Implementation

## Goal

Close one narrow C32 follow-up: make the browser-task persisted-status to
`TaskEventBridge` publish mapping a single typed source.

This is not a full browser task status cleanup. The persisted status vocabulary
and bridge status vocabulary intentionally differ.

## Scope In

1. Add a typed total mapping in `task-event-bridge.ts`:
   `BrowserCapabilityTaskStatus -> TaskEventBridgeStatus | null`.
2. Export `toBridgeStatus(status)`.
3. Route the two persisted-status publish sites through that helper:
   `task-persistence-service.ts` and `content-task-runner.ts`.
4. Keep `isTaskEventBridgeStatus()` as the arbitrary-string bridge membership
   guard.
5. Add `check-browser-task-status-publish-single-source.cjs`.
6. Add gate self-tests.
7. Add behavior tests proving the same statuses publish and the same statuses do
   not publish.
8. Add `verify:evolution-p6aa`.

## Scope Out

- Do not merge `needs_attention` into persisted browser task status.
- Do not make `cancelled` a bridge terminal.
- Do not change startup reconciliation.
- Do not change projection `state` or `publicStatus` mapping.
- Do not change `listPendingTasks`.
- Do not change renderer status unions or UI copy.
- Do not touch browser identity/session/profile isolation, P2b, C29, C30, or
  specialist-agent product work.

## Required Mapping

- `queued -> null`
- `running -> null`
- `waiting_human -> waiting_human`
- `paused -> paused`
- `completed -> completed`
- `failed -> failed`
- `cancelled -> null`

`needs_attention` stays bridge-only.

## Gate Requirements

`check-browser-task-status-publish-single-source.cjs` must fail when:

- the mapping omits a persisted browser task status;
- the mapping has an extra persisted-status key;
- a mapping value is not a bridge status or `null`;
- `queued`, `running`, or `cancelled` becomes a publisher;
- `needs_attention` appears in the persisted status union;
- either persisted-status publish site stops using `toBridgeStatus`;
- either publish site reintroduces a local bridge-status list.

The gate must not inspect projection state, publicStatus, startup reconciler SQL,
renderer supervision status, or `listPendingTasks`.

## Verification

Run:

```bash
node scripts/check-browser-task-status-publish-single-source.cjs
node --test scripts/__tests__/check-browser-task-status-publish-single-source.test.cjs
npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/task-event-bridge.test.ts src/__tests__/browser-task-persistence.test.ts
npm run verify:evolution-p6aa
npm run typecheck
git diff --check
```

`verify:evolution-p6aa` chains both P6w and P6z so the browser-task C32 lineage
and the latest P6 tip remain covered.

## Anti-Overclaim

P6aa closes only the browser-task persisted-status to bridge-publish mapping. It
does not close full C32, full P6, C29, C30, C31 residual, P2b isolation, browser
identity isolation, or specialist-agent product work.
