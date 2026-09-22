---
title: Stage Y0.5.16 — Release visual — BrowserView overlay + theme boot dogfood sub-plan
stage: Y0.5.16
surface_id: 16
date: 2026-05-23
status: draft-for-baseline
parent_plan: ../../../../../superpowers/plans/2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md
parent_row: §9.1 row 16
operator_class: agent-with-bai-spotcheck
mandatory_bai_spotcheck: true
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Surface 16 — Release visual — BrowserView overlay + theme boot

## 0. §9.1 row reference (verbatim)

- **Minimum scenario**: "Toggle BrowserView visibility under dropdown/modal
  overlay; cold-start app and observe theme application before first paint."
- **Must prove**: "Overlay blanking behaves per X4.1 BrowserViewIntent
  contract (5 kinds); no white-flash on theme boot."

## 1. Detailed reproduction steps

1. Cold start the app (kill all instances; `rm -rf` any cached `userData/window-state` if needed). Capture build commit.
2. Observe the very first paint: is the configured theme (dark or light) applied BEFORE any user content paints? Capture first-frame screencap.
3. Switch to `browser` mode. Load a tab to `https://example.com/`.
4. Trigger each of the 5 BrowserViewIntent contract kinds in turn:
   - (i) **dropdown over BrowserView** (e.g. open the unified header's URL dropdown)
   - (ii) **modal over BrowserView** (e.g. open Settings as a modal if applicable)
   - (iii) **tab-switch with BrowserView swap**
   - (iv) **mode-switch with BrowserView hide/show**
   - (v) **fullscreen / blanking** (if applicable)
5. For each kind, observe:
   - BrowserView is hidden before the overlay/blanking paints.
   - BrowserView is shown with synced bounds after the overlay closes.
   - No flicker / no z-index leak.
6. Force a theme change (light → dark or vice versa). Observe whether the transition is smooth (no white-flash, no app-race).
7. Stop recording; capture `ready-browser.log` + `ready-tools.log` + console.

## 2. Expected result decomposition (test cases)

| # | Invariant | Observable signal |
| ---: | --- | --- |
| 16.1 | Theme applied before first paint | Step 2: first-frame screencap shows theme background, not default white/grey |
| 16.2 | Intent kind (i) dropdown — BrowserView hidden first | Step 4(i): log sequence + visual confirmation |
| 16.3 | Intent kind (ii) modal — BrowserView hidden first | Step 4(ii) |
| 16.4 | Intent kind (iii) tab-switch — BrowserView swap correct | Step 4(iii): correct view active after swap |
| 16.5 | Intent kind (iv) mode-switch — hide/show correct | Step 4(iv) |
| 16.6 | Intent kind (v) fullscreen/blanking correct | Step 4(v) |
| 16.7 | No white-flash on theme transition | Step 6: smooth transition, no flash |
| 16.8 | No app-race on theme transition | Step 6: log shows ritual orchestration completes per contract |

## 3. Pre-existing automated coverage

Partial coverage at the theme + BrowserView intent contract layer:

- `src/__tests__/browserview-intent-mapping.test.ts`
- `src/__tests__/browser-startup-theme-contract.test.ts`
- `src/__tests__/browser-view-visibility-consolidation-contract.test.ts`
- `src/__tests__/browser-host-visibility-contract.test.ts`
- `src/__tests__/theme-ritual-orchestration-contract.test.ts`
- `src/__tests__/theme-ritual-icon-swap-contract.test.ts`
- `src/__tests__/theme-transition-backdrop-contract.test.ts`
- `src/__tests__/theme-transition-no-app-race-contract.test.ts`
- `src/__tests__/theme-system-change-silent-contract.test.ts`
- `src/__tests__/theme-liquid-default.test.ts`

The theme ritual + BrowserView intent contracts are unit-tested. The
first-paint visual confirmation (16.1) and the live no-white-flash
invariant (16.7) require live observation in the assembled product; this
dogfood adds the live invariant proof.

## 4. Operator class

`agent-with-bai-spotcheck` — per §9.4 rows "2, 7, 16, 17, 18": visual /
timing-sensitive in ways CI-class hardware may mask.

## 5. Evidence file path

`docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/surface-16-release-visual-browserview-theme.md`

Manifest: `audits/2026-05-23-stage-y-closeout/dogfood/evidence/surface-16-release-visual-browserview-theme-manifest.json`

## 6. Acceptance

### Per §9.1 "Must prove"

- Overlay blanking behaves per X4.1 BrowserViewIntent contract (tests 16.2–16.6).
- No white-flash on theme boot (tests 16.1, 16.7, 16.8).

### Per-test-case checks

- All 8 invariants observable in screencap and/or `ready-browser.log`.

### Mandatory 白 spot-check (per §9.4)

`bai_spotcheck` REQUIRED. 白 must observe the cold-start first-paint AND at
least one of the 5 BrowserViewIntent kinds in person.

### Evidence schema compliance

- Per §9.2, manifest includes head-capture, screencap (cold-start first-paint + intent-kind transitions), `ready-browser.log`.
- Per §9.2.1, `git_status_porcelain=0`.
- Per §9.2.2, log strictly overlaps reproduction window ± 30s.
