---
title: P5d Maintenance/Emergence Status Boundary Implementation
date: 2026-06-20
enforce: true
scope: P5d / C26
---

# P5d Maintenance/Emergence Status Boundary

## Goal

维护回合 / 涌现候选未启用。

> **边界演进（2026-07-05 D7 gate-flip）**：上句在本文成文时同时覆盖两者；现
> `runMaintenanceLlmRound` 已经 `maintenance-llm-driver` 挂上 crystallize tick
> 生产驱动（mandated 表 live-required 条目 + 三层预算闸），**「未启用」自
> 07-05 起仅指涌现候选（candidate-maintenance）**。合同见
> `2026-07-05-p3-backlog-closeout-implementation.md` §2。

This slice closes the stale C26 assumption without connecting dormant lifecycle code to production. It makes the current boundary explicit:

- `cas-merge.ts` is live and stays live.
- `getLastMaintenanceRoundStatus` is a live settings status surface and stays wired.
- `runMaintenanceLlmRound`, crystallize runner/scheduler, candidate maintenance, and emergence feed helpers have no production driver in this slice. (2026-07-05 起 `runMaintenanceLlmRound` 除外，见上注。)

## Implementation

1. Extend `scripts/check-unwired-capability-markers.cjs` to cover P5d alongside P5c.
2. Mark only the dormant driver surfaces as `P5d/C26 unwired`.
3. Keep the settings payload and renderer surface, but render the empty `llmRound` state as `未接入驱动`.
4. Positively guard live CAS wiring and the consumed maintenance status surface.

## In Scope

- File-level dormant markers:
  - `src/main/modules/agent-control/maintenance/crystallize-gate.ts`
  - `src/main/modules/agent-control/emergence/candidate-maintenance.ts`
  - `src/main/modules/agent-control/emergence/emergence-cards.ts`
- Function-level dormant marker:
  - `runMaintenanceLlmRound` in `maintenance-llm-round.ts`
- Gate/test coverage for:
  - no production import of dormant maintenance/emergence modules;
  - no production reference to `runMaintenanceLlmRound`;
  - `cas-merge.ts` not marked unwired;
  - runtime still references `runUserPictureCasMerge`;
  - settings status still carries `llmRound`;
  - renderer null-state copy says `未接入驱动`.

## Out Of Scope

- Do not delete `getLastMaintenanceRoundStatus`.
- Do not mark `cas-merge.ts` unwired.
- Do not connect `runMaintenanceLlmRound`, `runCrystallizeRound`, `CrystallizeScheduler`, `maintainAgentCandidates`, or emergence feed helpers into production.
- Do not add scheduling, run/finalizer writes, migrations, or lifecycle jobs.
- Do not alter P5c packet files, P5b handoff, P5a preroute, P5e derivation, P6 compaction, browser isolation, or specialist agent product routes.

## Verification

- `node scripts/check-unwired-capability-markers.cjs`
- `node --test scripts/__tests__/check-unwired-capability-markers.test.cjs`
- `npm run verify:evolution-p3`
- `npm run verify:evolution-p4`
- `npm run typecheck`
