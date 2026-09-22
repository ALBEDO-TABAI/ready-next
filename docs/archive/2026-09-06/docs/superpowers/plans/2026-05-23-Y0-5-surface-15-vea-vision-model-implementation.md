---
title: Stage Y0.5.15 — VEA / vision model dogfood sub-plan
stage: Y0.5.15
surface_id: 15
date: 2026-05-23
status: draft-for-baseline
parent_plan: ../../../../../superpowers/plans/2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md
parent_row: §9.1 row 15
operator_class: agent-only
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Surface 15 — VEA / vision model

## 0. §9.1 row reference (verbatim)

- **Minimum scenario**: "Configure a vision model, run image analysis, force
  missing-key/disabled state."
- **Must prove**: "Test button performs a real probe or clearly says it only
  validates fields (depends on Y1.1 / Y0.8 disposition)."

## 1. Detailed reproduction steps

1. Launch app; capture build commit.
2. Open Settings → External services → Vision (or VEA) section.
3. Configure a vision-capable provider (e.g. an OpenAI-compatible vision endpoint or VEA provider). Enter valid key and Save.
4. Click Test. Record whether Test performs a real probe (round-trip) or only validates fields.
5. Switch workbench mode to agent panel. Send a message with an image attachment: "描述一下这张图".
6. Verify the vision model is invoked (visible in `ready-tools.log`).
7. Verify the response describes the image content.
8. Force missing-key state: clear the key in Settings. Save.
9. Repeat step 5. Verify a clear, user-visible error (NOT silent green; NOT a meaningless fallback).
10. Force disabled state: toggle the vision feature off (if such toggle exists). Save. Repeat step 5. Verify the disabled state surfaces.
11. Restore key + enable feature.
12. Stop recording; capture `ready-tools.log`, `ready-directchat.log`, console.

## 2. Expected result decomposition (test cases)

| # | Invariant | Observable signal |
| ---: | --- | --- |
| 15.1 | Vision configured saves correctly | Step 3: reopen Settings shows persisted config |
| 15.2 | Test button classified per Y1.1/Y0.8 | Step 4: evidence records "real-probe" or "field-validation-only" |
| 15.3 | Vision model invoked on image ask | Step 6: tools log shows vision model call |
| 15.4 | Vision response describes image | Step 7: text describes image content |
| 15.5 | Missing-key state visible | Step 9: clear error toast/banner |
| 15.6 | Disabled state visible | Step 10: clear disabled toast/banner |

## 3. Pre-existing automated coverage

Partial coverage at the VEA + vision-tool layer:

- `src/__tests__/embedded-skill-vea-host-requirements.test.ts`
- `src/__tests__/embedded-skill-vea-run-state-contract.test.ts`
- `src/__tests__/embedded-skill-vea-runtime-failure-paths.test.ts`
- `src/__tests__/skill-inspect-run-state-vea-contract.test.ts`
- `src/__tests__/skill-running-projection-vea-progress.test.ts`
- `src/__tests__/vision-tool-gating.test.ts`
- `src/__tests__/typed-action-context-modifier-no-vea-gate.test.ts`

Strong coverage of VEA skill runtime + vision-tool gating. The
Test-button-classification invariant (15.2) and the live missing-key /
disabled-state surfacing (15.5, 15.6) in the assembled product are unique
to this dogfood.

## 4. Operator class

`agent-only` — per §9.4 row "1, 4, 5, 8, 14, 15".

## 5. Evidence file path

`docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/surface-15-vea-vision-model.md`

Manifest: `audits/2026-05-23-stage-y-closeout/dogfood/evidence/surface-15-vea-vision-model-manifest.json`

## 6. Acceptance

### Per §9.1 "Must prove"

- Test button performs a real probe OR clearly says it only validates fields (test 15.2).

### Per-test-case checks

- All 6 invariants observable in screencap and/or log tail.

### Operator-class enforcement (per §9.4)

- `operator_class: agent-only`. `bai_spotcheck` NOT required.

### Pre-condition

- Y1.1 / Y0.8 Test-button disposition (real-probe vs field-validation) must be either landed OR explicitly noted as pending in the evidence file's `## Pass/fail rationale`.

### Evidence schema compliance

- Per §9.2, manifest includes head-capture, screencap, `ready-tools.log`.
- Per §9.2.1, `git_status_porcelain=0`.
- Per §9.2.2, log strictly overlaps reproduction window ± 30s.
