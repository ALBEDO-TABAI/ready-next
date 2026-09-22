---
title: Stage Y0.5.06 — Calendar dogfood sub-plan
stage: Y0.5.06
surface_id: 6
date: 2026-05-23
status: draft-for-baseline
parent_plan: ../../../../../superpowers/plans/2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md
parent_row: §9.1 row 6
operator_class: agent-only
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Surface 06 — Calendar

## 0. §9.1 row reference (verbatim)

- **Minimum scenario**: "Create event, recurring event, navigate day/week,
  accept one agent suggestion."
- **Must prove**: "Timezone/recurrence render correctly; remote suggestion
  does not bypass scope rules."

## 1. Detailed reproduction steps

1. Launch app; switch to `calendar` mode. Capture build commit.
2. Confirm local timezone display in the calendar header.
3. **Create one-off event**: tomorrow at 14:00 local, 1h duration, title `Y0.5 calendar one-off`.
4. **Create recurring event**: every Tuesday at 10:00, 30min, title `Y0.5 calendar recurring`, recurrence count 3.
5. Switch view: Day → Week → Day. Verify both events render at correct hour-slot positions.
6. Cross-timezone check: ask the calendar agent "把这个一次性事件转成 UTC 时间显示". Verify display does not shift the underlying storage time.
7. Trigger an agent suggestion: ask "下周二上午能空 30 分钟么". Wait for the agent to propose a suggestion card.
8. Accept the suggestion → confirm a new event is created at the suggested slot.
9. Verify the new event's scope: should belong to the local calendar workspace, not bypass scope to another workspace (CLAUDE.md §2 scope rules).
10. Stop recording; capture `ready-directchat.log` + `ready-tools.log` + console.

## 2. Expected result decomposition (test cases)

| # | Invariant | Observable signal |
| ---: | --- | --- |
| 6.1 | One-off event renders at correct local hour-slot | Step 3 then step 5: event appears at 14:00 local on tomorrow's column |
| 6.2 | Recurring event renders at 3 occurrences | Step 4 then step 5: 3 occurrence cells across 3 weeks |
| 6.3 | Timezone display does not corrupt storage | Step 6: switching display TZ does not move the source-of-truth time on disk/DB |
| 6.4 | Day/week navigation preserves selection | Step 5: returning to Day view keeps focused day |
| 6.5 | Agent suggestion routes through suggestion card | Step 7: a suggestion card UI appears (not a raw chat message) |
| 6.6 | Accepted suggestion creates scoped event | Step 8–9: new event lands in current workspace's calendar |
| 6.7 | Remote suggestion does not bypass scope | Step 9: event ownership matches local workspace |

## 3. Pre-existing automated coverage

Extensive coverage at the calendar agent and schema layer:

- `src/__tests__/calendar-agent-handler.test.ts`
- `src/__tests__/calendar-agent-snapshot-shape.test.ts`
- `src/__tests__/calendar-assistant-ui-contract.test.ts`
- `src/__tests__/calendar-dark-surface-contract.test.ts`
- `src/__tests__/calendar-event-sync-contract.test.ts`
- `src/__tests__/calendar-remote-suggestion-ui.test.ts`
- `src/__tests__/calendar-schemas.test.ts`
- `src/__tests__/calendar-shell-outline-contract.test.ts`
- `src/__tests__/calendar-tool-renderer-bridge.test.ts`
- `src/__tests__/calendar-week-solid-surface-contract.test.ts`

10+ calendar-* tests. Timezone and recurrence visual rendering at the live
product layer is partial; this dogfood proves invariants 6.1–6.3, 6.7 in
the assembled product.

## 4. Operator class

`agent-only` — per §9.4 row 6: "Timezone correctness is verifiable from
logs + screencap." `bai_spotcheck` optional.

## 5. Evidence file path

`docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/surface-06-calendar.md`

Manifest: `audits/2026-05-23-stage-y-closeout/dogfood/evidence/surface-06-calendar-manifest.json`

## 6. Acceptance

### Per §9.1 "Must prove"

- Timezone/recurrence render correctly (tests 6.1, 6.2, 6.3).
- Remote suggestion does not bypass scope rules (tests 6.6, 6.7).

### Per-test-case checks

- All 7 invariants observable in screencap and/or log tail.

### Operator-class enforcement (per §9.4)

- `operator_class: agent-only`. `bai_spotcheck` NOT required.

### Evidence schema compliance

- Per §9.2, manifest includes head-capture, screencap, log tail.
- Per §9.2.1, `git_status_porcelain=0`.
- Per §9.2.2, log strictly overlaps reproduction window ± 30s.
