---
title: Stage Y0.5.17 — Release visual — dropdowns + tldraw + text editing dogfood sub-plan
stage: Y0.5.17
surface_id: 17
date: 2026-05-23
status: draft-for-baseline
parent_plan: 2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md
parent_row: §9.1 row 17
operator_class: agent-with-bai-spotcheck
mandatory_bai_spotcheck: true
---

# Surface 17 — Release visual — dropdowns + tldraw + text editing

## 0. §9.1 row reference (verbatim)

- **Minimum scenario**: "Exercise every Settings dropdown, open a tldraw
  widget and draw, focus a text editor and type."
- **Must prove**: "Dropdowns z-index correct over BrowserView; tldraw input
  does not lose focus; text editor IME composition works."

## 1. Detailed reproduction steps

1. Launch app; load a BrowserView tab (so dropdown-over-BrowserView is exercised). Capture build commit.
2. Open Settings. Iterate through every dropdown (theme, language, provider, model, layout, cache mode, etc.). For each:
   - Open the dropdown.
   - Verify it renders ABOVE the BrowserView (no clipping, no z-index leak).
   - Select an option.
   - Close. Re-open to confirm state.
3. Open a document and insert a tldraw widget (or open a tldraw-backed page).
4. Click into the tldraw canvas. Draw 3 strokes.
5. Click off the canvas, then click back. Verify focus is captured and additional strokes draw correctly (no focus loss between operations).
6. Open a text editor pane (document mode).
7. Type a string in English: "Y0.5 IME test baseline".
8. Switch IME to Chinese (Pinyin) and type: `中文输入测试`. Verify the composition popup renders, candidates appear, and Enter commits the chosen character into the editor.
9. Switch IME to Japanese (or another composition-IME) and repeat: `日本語入力テスト`.
10. Stop recording; capture screencap covering dropdowns, tldraw, IME composition.

## 2. Expected result decomposition (test cases)

| # | Invariant | Observable signal |
| ---: | --- | --- |
| 17.1 | Every Settings dropdown z-index correct over BrowserView | Step 2: each dropdown renders fully above BrowserView, no clipping |
| 17.2 | Dropdown selection persists | Step 2: re-opening shows newly-selected option |
| 17.3 | Tldraw canvas captures focus | Step 4–5: strokes registered, no missed inputs |
| 17.4 | Tldraw does not lose focus between operations | Step 5: clicking off + back retains drawing capability |
| 17.5 | Text editor accepts plain typing | Step 7: string appears in editor |
| 17.6 | IME composition works (Chinese) | Step 8: composition popup, candidates, commit all visible |
| 17.7 | IME composition works (Japanese) | Step 9: same as 17.6 for Japanese |
| 17.8 | No focus loss during composition | Editor remains focused throughout composition |

## 3. Pre-existing automated coverage

**None yet** — this surface has zero automated coverage for the three
specific live invariants (dropdown z-index over BrowserView, tldraw focus
retention, IME composition). The browser visibility contracts cover the
BrowserView side, but no test asserts that arbitrary Settings dropdowns
paint above BrowserView in a real product window, and no test exercises
tldraw or IME composition.

Related but tangential:
- `src/__tests__/browser-host-visibility-contract.test.ts` (BrowserView side only)
- `src/__tests__/settings-shell-visual-contract.test.ts` (settings layout only)
- `src/__tests__/settings-liquid-glass-contract.test.ts` (visual style only)

The IME, tldraw, and dropdown-over-BrowserView z-index invariants are NOT
automated. This dogfood is the ONLY evidence for invariants 17.1, 17.3,
17.4, 17.6, 17.7, 17.8.

## 4. Operator class

`agent-with-bai-spotcheck` — per §9.4 rows "2, 7, 16, 17, 18": IME and
tldraw focus are visual/timing-sensitive in ways CI-class hardware may
mask.

## 5. Evidence file path

`docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/surface-17-release-visual-dropdowns-tldraw-text.md`

Manifest: `audits/2026-05-23-stage-y-closeout/dogfood/evidence/surface-17-release-visual-dropdowns-tldraw-text-manifest.json`

## 6. Acceptance

### Per §9.1 "Must prove"

- Dropdowns z-index correct over BrowserView (test 17.1).
- Tldraw input does not lose focus (tests 17.3, 17.4).
- Text editor IME composition works (tests 17.6, 17.7, 17.8).

### Per-test-case checks

- All 8 invariants observable in screencap.

### Mandatory 白 spot-check (per §9.4)

`bai_spotcheck` REQUIRED. IME testing requires real OS-level IME (macOS
Pinyin/Kotoeri) which CI runners typically lack; 白 must reproduce IME
invariants 17.6, 17.7 on macOS.

### Evidence schema compliance

- Per §9.2, manifest includes head-capture, screencap, console output.
- Per §9.2.1, `git_status_porcelain=0`.
- Per §9.2.2, log strictly overlaps reproduction window ± 30s (if any log emitted; visual surfaces may rely primarily on screencap).
