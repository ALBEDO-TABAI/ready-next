---
title: Stage Y0.5.14 — Automation / schedules dogfood sub-plan
stage: Y0.5.14
surface_id: 14
date: 2026-05-23
status: draft-for-baseline
parent_plan: 2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md
parent_row: §9.1 row 14
operator_class: agent-only
enforce: false
documentation_status: archived-in-place
archived_at: 2026-09-06
---

> 原位归档（2026-09-06）：固定历史证据仍引用此路径。保留此路径不代表全文仍是当前合同；其中的状态、源码位置和待办属于原记录。现行约束见 [当前运行时合同](../../architecture/current-runtime-contracts.md)，归档去向见 [文档清单](../../documentation-inventory.md)。

# Surface 14 — Automation / schedules

## 0. §9.1 row reference (verbatim)

- **Minimum scenario**: "Create, list, pause, resume, and fire one
  reminder/scheduled task."
- **Must prove**: "Schedule state is durable; fired task links back to
  correct conversation/workspace."

## 1. Detailed reproduction steps

1. Launch app; capture build commit.
2. Navigate to the automation / schedule page or use the reminder UI.
3. **Create**: create a reminder/scheduled task "Y0.5 schedule fixture" set to fire 2 minutes from now in the current conversation/workspace context. Note the schedule id.
4. **List**: verify the schedule appears in the schedule list with correct name + next-fire time.
5. **Pause**: pause the schedule. Verify the row reflects paused state.
6. **Resume**: resume the schedule. Verify it returns to scheduled state. Adjust next-fire time if needed.
7. Restart the app (clean restart). Verify the schedule persists in the list (durability invariant).
8. Wait for the schedule to fire (~2 minutes after step 6).
9. Verify the fired task arrives in the original conversation/workspace (not a different scope).
10. Verify the fired task references the schedule id and original conversation id in `ready-tools.log`.
11. Stop recording; capture `ready-directchat.log`, `ready-tools.log`, console.

## 2. Expected result decomposition (test cases)

| # | Invariant | Observable signal |
| ---: | --- | --- |
| 14.1 | Create succeeds | Step 3: schedule id assigned |
| 14.2 | List shows schedule | Step 4: name + next-fire time visible |
| 14.3 | Pause toggles state | Step 5: UI reflects paused |
| 14.4 | Resume toggles state | Step 6: UI reflects scheduled |
| 14.5 | Durability across restart | Step 7: schedule list contains the row after restart |
| 14.6 | Fire arrives in correct conversation | Step 9: fired task appears in original conversation, not elsewhere |
| 14.7 | Fire references correct workspace | Step 10: tools log shows correct workspace id |
| 14.8 | Fire timing within tolerance | Step 8: fires within ±10s of the scheduled time |

## 3. Pre-existing automated coverage

Extensive at the schedule / reminder layer:

- `src/__tests__/current-date-reminder.test.ts`
- `src/__tests__/reminder-codec.test.ts`
- `src/__tests__/reminder-cold-start.test.ts`
- `src/__tests__/reminder-editor-behavior.test.ts`
- `src/__tests__/reminder-scheduler.test.ts`
- `src/__tests__/schedule-group-register.test.ts`
- `src/__tests__/sync-scheduler.test.ts`
- `src/__tests__/system-reminder-registry.test.ts`
- `src/__tests__/turn-engine-reminder-delegation.test.ts`

Strong coverage of the reminder/scheduler codec, cold-start, and scheduler
logic. The end-to-end live "create → restart → fire → arrives in correct
conversation" invariant (14.5, 14.6, 14.7) is partially covered; this
dogfood adds the live invariant proof.

## 4. Operator class

`agent-only` — per §9.4 row "1, 4, 5, 8, 14, 15".

## 5. Evidence file path

`docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/surface-14-automation-schedules.md`

Manifest: `audits/2026-05-23-stage-y-closeout/dogfood/evidence/surface-14-automation-schedules-manifest.json`

## 6. Acceptance

### Per §9.1 "Must prove"

- Schedule state is durable (tests 14.5).
- Fired task links back to correct conversation/workspace (tests 14.6, 14.7).

### Per-test-case checks

- All 8 invariants observable in screencap and/or log tail.

### Operator-class enforcement (per §9.4)

- `operator_class: agent-only`. `bai_spotcheck` NOT required.

### Evidence schema compliance

- Per §9.2, manifest includes head-capture, screencap, `ready-tools.log`, `ready-directchat.log`.
- Per §9.2.1, `git_status_porcelain=0`.
- Per §9.2.2, log strictly overlaps reproduction window ± 30s (reproduction window includes the 2-minute wait + fire).
