---
title: Stage Y0.5.08 — Settings / external services dogfood sub-plan
stage: Y0.5.08
surface_id: 8
date: 2026-05-23
status: draft-for-baseline
parent_plan: 2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md
parent_row: §9.1 row 8
operator_class: agent-only
---

# Surface 08 — Settings / external services

## 0. §9.1 row reference (verbatim)

- **Minimum scenario**: "For each of OpenAI-compatible, RSSHub, Jina,
  DuckDuckGo, Amap, VEA: open Settings → external services page; edit one
  field; click Save; click Test. Then for each, force the missing-key state
  (clear key, click Test). (Codex r2 should-fix #4: was 'edit/save/test'
  without specifying scope.)"
- **Must prove**: "Save round-trip is real (value persists across reopen);
  Test button distinguishes 'real probe pass' vs 'field validation only'
  per Y1.1 disposition; missing-key state surfaces understandable error
  toast (not silent green)."

## 1. Detailed reproduction steps

For EACH provider in {OpenAI-compatible, RSSHub, Jina, DuckDuckGo, Amap, VEA}:

1. Launch app; open Settings → External services page. Capture build commit.
2. Edit one field (e.g. base URL, endpoint, or display name — NOT the secret key).
3. Click Save. Observe save confirmation.
4. Close Settings; reopen. Verify edited field persists.
5. Click Test. Observe:
   - Does Test perform a real probe (round-trip)?
   - Or does it only validate the form fields locally?
   - Mark the answer per Y1.1 disposition behavior.
6. Clear the API key (or equivalent secret). Save.
7. Click Test. Verify a missing-key error surfaces as a user-visible toast/banner, NOT silent green.
8. Restore the key. Save.
9. Repeat for the next provider.

10. Stop recording; capture `ready-tools.log`, `ready-directchat.log`, console.

## 2. Expected result decomposition (test cases)

For each provider P ∈ {OpenAI-compat, RSSHub, Jina, DuckDuckGo, Amap, VEA}:

| # | Invariant | Observable signal |
| ---: | --- | --- |
| 8.P.1 | Save round-trip persists | Step 4: edited field still shows after reopen |
| 8.P.2 | Test classification recorded | Step 5: evidence file records "real-probe" or "field-validation-only" per Y1.1 |
| 8.P.3 | Missing-key state surfaces | Step 7: visible error toast/banner, not silent success |
| 8.P.4 | Restored-key works again | Step 8: subsequent Test succeeds |

Total: 6 providers × 4 invariants = 24 test cases.

## 3. Pre-existing automated coverage

Partial coverage at the settings layer:

- `src/__tests__/settings-capability-runtime-contract.test.ts`
- `src/__tests__/settings-cache-quota-relabel.test.ts`
- `src/__tests__/settings-ai-layout-contract.test.ts`
- `src/__tests__/settings-liquid-glass-contract.test.ts`
- `src/__tests__/settings-shell-visual-contract.test.ts`
- `src/__tests__/settings-mcp-not-shipped-labeling.test.ts`
- `src/__tests__/settings-emergency-feature-flag-restore.test.ts`
- `src/__tests__/settings-legacy-key-one-shot-migration.test.ts`
- `src/__tests__/settings-no-legacy-key-read-after-migration.test.ts`
- `src/__tests__/external-services-and-skill-config.test.ts`
- `src/__tests__/rss-settings.test.ts`

The settings tests cover layout, migration, and capability contracts. The
**Test-button classification** (real probe vs field validation) and the
**missing-key error surfacing** in the assembled product is the unique
contribution of this dogfood surface.

## 4. Operator class

`agent-only` — per §9.4 row "1, 4, 5, 8, 14, 15".

## 5. Evidence file path

`docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/surface-08-settings-external-services.md`

Manifest: `audits/2026-05-23-stage-y-closeout/dogfood/evidence/surface-08-settings-external-services-manifest.json`

## 6. Acceptance

### Per §9.1 "Must prove"

- Save round-trip is real (test 8.P.1 for all 6 providers).
- Test button classification per Y1.1 disposition (test 8.P.2 for all 6).
- Missing-key state surfaces visibly (test 8.P.3 for all 6).

### Per-test-case checks

- All 24 test-case rows observable in screencap and/or log tail.
- Evidence file's `## Observed result` section MUST list each provider's
  Test-button classification explicitly per row.

### Operator-class enforcement (per §9.4)

- `operator_class: agent-only`. `bai_spotcheck` NOT required.

### Evidence schema compliance

- Per §9.2, manifest includes head-capture, screencap, `ready-tools.log`, console output.
- Per §9.2.1, `git_status_porcelain=0`.
- Per §9.2.2, log strictly overlaps reproduction window ± 30s.
