---
title: Stage Y0.5.18 — Release visual — shell empty states + first-open warm-up dogfood sub-plan
stage: Y0.5.18
surface_id: 18
date: 2026-05-23
status: draft-for-baseline
parent_plan: ../../../../../superpowers/plans/2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md
parent_row: §9.1 row 18
operator_class: agent-with-bai-spotcheck
mandatory_bai_spotcheck: true
mandatory_bai_only_scope: first-open warm-up p95 ≤ 3000ms on W3.3 hardware
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Surface 18 — Release visual — shell empty states + first-open warm-up

## 0. §9.1 row reference (verbatim)

- **Minimum scenario**: "Cold-start app with empty user-data; observe each
  workbench-mode empty state; record first-open warm-up time (cold-start →
  ready-to-input)."
- **Must prove**: "Empty states render per spec; warm-up time p95 ≤ 3000ms
  on W3.3 hardware (carry-over from W3 chosen-layout-model)."

## 1. Detailed reproduction steps

1. Wipe user-data: locate the app's userData directory (`~/Library/Application Support/<app-name>` on macOS) and back it up; then delete or move it aside. Capture build commit.
2. Launch app from cold. Start a wall-clock timer at launch moment.
3. Observe first paint. Verify the configured theme is applied (cross-link with surface 16).
4. Observe each workbench mode's empty state in turn:
   - `browser` empty state (no tabs)
   - `document` empty state (no docs)
   - `rss` empty state (no feeds)
   - `calendar` empty state (no events / week scaffold)
5. For each empty state: capture screencap; verify the rendering matches the spec (placeholder copy, CTA buttons, illustration if applicable).
6. **Warm-up timing**: capture the timestamp when the app reaches "ready-to-input" (composer focused OR user can interact with main surface without further loading). Compute elapsed time = ready-to-input - launch.
7. Repeat the cold-start + timing measurement at least 10 times to compute p95. (For W3.3 hardware: this requires 白's W3.3 box per §9.4.)
8. Stop recording; capture `ready-tools.log`, console, screencaps for each empty state.

## 2. Expected result decomposition (test cases)

| # | Invariant | Observable signal |
| ---: | --- | --- |
| 18.1 | Browser mode empty state per spec | Step 5: matches design spec (copy, CTA, illustration) |
| 18.2 | Document mode empty state per spec | Step 5 |
| 18.3 | RSS mode empty state per spec | Step 5 |
| 18.4 | Calendar mode empty state per spec | Step 5 |
| 18.5 | First-open warm-up p95 ≤ 3000ms on W3.3 | Step 6–7: p95 across 10 cold-starts ≤ 3000ms (bai-only) |
| 18.6 | No white-flash during cold-start (visual continuity) | Cross-link with surface 16 invariant 16.1 |

## 3. Pre-existing automated coverage

Partial coverage:

- `src/__tests__/browser-empty-state-bootstrap-contract.test.ts`
- `src/__tests__/mode-switch-ritual.test.ts`
- `src/__tests__/workbench-mode-switch-transform-contract.test.ts`
- `src/__tests__/browser-mode-switch-contract.test.ts`
- `src/__tests__/document-mode-switch-pointer-contract.test.ts`

The browser empty-state contract is covered. Document/RSS/Calendar
mode-specific empty states are partially covered. The warm-up timing
invariant (18.5, p95 ≤ 3000ms) is NOT automated and is W3.3-hardware
specific; this dogfood is the ONLY evidence for invariant 18.5.

## 4. Operator class

`agent-with-bai-spotcheck` overall, with `bai-only` scope for the
warm-up-p95 invariant. Per §9.4: "Surfaces that must run on 白's W3.3
hardware: 18 (first-open warm-up p95 ≤ 3000ms is W3.3-baseline-dependent).
Y0.4 already owns the W3.3-specific shell mode-switch + split-pane drag
evidence."

Agent may produce baseline for invariants 18.1–18.4, 18.6 on CI-class
hardware. 白 MUST produce the warm-up p95 evidence on W3.3 hardware.

## 5. Evidence file path

`docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/surface-18-release-visual-empty-states-warmup.md`

Manifest: `audits/2026-05-23-stage-y-closeout/dogfood/evidence/surface-18-release-visual-empty-states-warmup-manifest.json`

## 6. Acceptance

### Per §9.1 "Must prove"

- Empty states render per spec (tests 18.1–18.4).
- Warm-up time p95 ≤ 3000ms on W3.3 hardware (test 18.5).

### Per-test-case checks

- All 6 invariants observable in screencap and/or log tail.
- Test 18.5 requires p95 computation from ≥ 10 cold-start samples.

### Mandatory 白 spot-check (per §9.4)

`bai_spotcheck` REQUIRED. For invariant 18.5 specifically, 白's evidence on
W3.3 hardware is mandatory; agent baseline cannot substitute. Evidence file
should include either a CSV/log of cold-start timings or a screencap of
the p95 computation.

### Cross-reference

- Cross-link to Y0.4 for the W3.3-specific shell mode-switch + split-pane drag evidence.

### Evidence schema compliance

- Per §9.2, manifest includes head-capture, screencaps for each empty state, warm-up timing log/csv.
- Per §9.2.1, `git_status_porcelain=0`.
- Per §9.2.2, log strictly overlaps reproduction window ± 30s.
