---
title: Stage Y0.5.02 — Embedded browser dogfood sub-plan
stage: Y0.5.02
surface_id: 2
date: 2026-05-23
status: draft-for-baseline
parent_plan: ../../../../../superpowers/plans/2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md
parent_row: §9.1 row 2
operator_class: agent-with-bai-spotcheck
mandatory_bai_spotcheck: true
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Surface 02 — Embedded browser

## 0. §9.1 row reference (verbatim)

- **Minimum scenario**: "Create tab, navigate, switch tab, reload, open
  popup/new window, drag/split if applicable."
- **Must prove**: "BrowserView bounds, header state, and DOM overlay
  behavior stay aligned."

## 1. Detailed reproduction steps

1. Launch the app (`npm run dev` or built binary). Capture build commit per §9.2.1.
2. Switch workbench mode to `browser`.
3. Create a new tab (click the `+` button on the tab rail).
4. Navigate to `https://example.com/`. Wait for load complete.
5. Create a second tab and navigate to `https://www.iana.org/domains/example`.
6. Switch back to tab 1 using a keyboard shortcut or rail click; confirm BrowserView shows example.com content.
7. Reload tab 1 via the reload button.
8. Trigger a popup: navigate to a fixture page that opens `window.open()` (e.g. tab 2 — open a link with `target="_blank"`). Verify popup policy per `browser-popup-policy.test.ts`.
9. Drag-split: drag tab 1 to the secondary pane (if split is available); verify both BrowserViews render in their bounds.
10. Open a DOM overlay (dropdown, modal, or settings popover) while the BrowserView is active; observe whether `browser.hideAll()` runs first per CLAUDE.md §2.
11. Close the overlay; verify `browser.showActive()` restores the BrowserView with correct bounds.
12. Stop recording. Capture `ready-browser.log` and `ready-tools.log` tail.

## 2. Expected result decomposition (test cases)

| # | Invariant | Observable signal |
| ---: | --- | --- |
| 2.1 | Tab creation aligns header state | New tab row appears in rail; unified header reflects new tab title/URL after navigation |
| 2.2 | BrowserView bounds match active tab on switch | After step 6, BrowserView pixel bounds match the visible content frame (no offset) |
| 2.3 | Reload does not regress bounds | After step 7, BrowserView bounds unchanged |
| 2.4 | Popup policy enforced | Popup either opens as new tab or external window per policy; no zombie BrowserView |
| 2.5 | Split layout: both BrowserViews bounded correctly | Step 9: secondary BrowserView occupies the secondary pane bounds; primary unaffected |
| 2.6 | DOM overlay hides BrowserView first | Log shows `browser.hideAll()` invocation before overlay paint; visually no BrowserView leaks above overlay |
| 2.7 | Overlay close restores active BrowserView | After step 11, BrowserView re-shown with synced bounds (X4.1 BrowserViewIntent contract) |

## 3. Pre-existing automated coverage

Extensive contract coverage at the BrowserView orchestration layer:

- `src/__tests__/browser-view-visibility-consolidation-contract.test.ts`
- `src/__tests__/browser-host-visibility-contract.test.ts`
- `src/__tests__/browser-sync-visible-host-three-step-contract.test.ts`
- `src/__tests__/browserview-intent-mapping.test.ts`
- `src/__tests__/browserview-split-secondary-bounds.test.ts`
- `src/__tests__/browser-tab-rail-*.test.ts` (5+ files)
- `src/__tests__/browser-tab-switch-visibility-contract.test.ts`
- `src/__tests__/browser-resize-stability-contract.test.ts`
- `src/__tests__/browser-popup-policy.test.ts`
- `src/__tests__/browser-mode-startup-resync-contract.test.ts`

50+ browser-* tests give strong contract coverage; this surface adds the
live invariant proof that the contracts hold in the assembled product on
real DOM overlays and real native BrowserView pixel bounds.

## 4. Operator class

`agent-with-bai-spotcheck` — per §9.4 rows "2, 7, 16, 17, 18": BrowserView
behavior is visual/timing-sensitive in ways CI-class hardware may mask.
白 MUST observe at least once before status=pass.

## 5. Evidence file path

`docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/surface-02-embedded-browser.md`

Manifest: `audits/2026-05-23-stage-y-closeout/dogfood/evidence/surface-02-embedded-browser-manifest.json`

## 6. Acceptance

### Per §9.1 "Must prove"

- BrowserView bounds (tests 2.2, 2.3, 2.5).
- Header state (test 2.1).
- DOM overlay behavior aligned (tests 2.6, 2.7).

### Per-test-case checks

- All 7 invariants observable in the screencap and/or log tail.

### Mandatory 白 spot-check (per §9.4)

`bai_spotcheck` frontmatter block REQUIRED with:
- `performed_by`: 白
- `performed_at`: within [captured_at, captured_at + 72h]
- `spotcheck_evidence`: separate artifact (mp4/gif/txt) showing 白 reproducing
  at least one BrowserView overlay round-trip
- `spotcheck_sha256`: matches `sha256sum spotcheck_evidence`
- `spotcheck_signoff_text`: one sentence in 白's voice

If 72h window exceeded, spotcheck needs its own head-capture.txt matching
agent baseline's `build_commit` per §9.2.3.

### Evidence schema compliance

- Per §9.2, manifest includes head-capture, screencap, log tail (browser + tools).
- Per §9.2.1, head-capture.txt shows `git_status_porcelain=0`.
- Per §9.2.2, log tail timestamps strictly overlap reproduction window ± 30s.
