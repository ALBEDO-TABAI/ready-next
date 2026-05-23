---
title: Stage Y0.5.03 — RSS / RSSHub dogfood sub-plan
stage: Y0.5.03
surface_id: 3
date: 2026-05-23
status: draft-for-baseline
parent_plan: 2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md
parent_row: §9.1 row 3
operator_class: agent-with-bai-spotcheck
mandatory_bai_spotcheck: true
---

# Surface 03 — RSS / RSSHub

## 0. §9.1 row reference (verbatim)

- **Minimum scenario**: "Fixed fixtures: subscribe to (a)
  `https://news.ycombinator.com/rss`, (b) one Bilibili up-master route via
  personal RSSHub, (c) one Twitter/X user via personal RSSHub; refresh all
  three; preview the latest item from each; open one item in browser;
  trigger `analyze-rss-feed` skill on the HN feed. (Codex r2 should-fix #4:
  was 'three sources, one analysis path' without specifying.)"
- **Must prove**: "Worker cleanup (no leaked RSSHub child process after
  refresh); preview handoff (DOM overlay before BrowserView showActive);
  browser handoff (URL opens in active tab); analyze path produces
  structured output."

## 1. Detailed reproduction steps

1. Launch the app; ensure RSSHub instance is configured in Settings → External services per §9.1 row 8 fixture. Capture build commit.
2. Switch workbench mode to `rss`.
3. Subscribe (a): add feed URL `https://news.ycombinator.com/rss`.
4. Subscribe (b): pick one Bilibili up-master id (白's known active up-master). Construct the RSSHub route `https://<personal-rsshub>/bilibili/user/dynamic/<uid>` and subscribe.
5. Subscribe (c): pick one Twitter/X handle. Construct the RSSHub route `https://<personal-rsshub>/twitter/user/<handle>` and subscribe.
6. Trigger Refresh All. Wait for all three to complete.
7. In a separate terminal: `ps -ax | grep -i rsshub | grep -v grep | wc -l` BEFORE refresh, AFTER refresh, and 60s after refresh; record counts.
8. Click into feed (a); preview the latest item — verify DOM overlay paints first, then BrowserView lift if applicable.
9. Click into feed (b); preview the latest item.
10. Click into feed (c); preview the latest item.
11. From one preview, click "Open in browser" → confirm the URL loads in the active browser tab (handoff).
12. Trigger the `analyze-rss-feed` skill on feed (a) — Hacker News. Wait for the structured output (summary, top items, signals).
13. Stop recording. Capture `ready-tools.log`, `ready-browser.log`, and console output.

## 2. Expected result decomposition (test cases)

| # | Invariant | Observable signal |
| ---: | --- | --- |
| 3.1 | All 3 feeds refresh successfully | Step 6 shows non-error status on each feed; item counts > 0 |
| 3.2 | No leaked RSSHub child process | `ps` count returns to baseline (or `0` leak above baseline) 60s after refresh |
| 3.3 | DOM overlay paints before BrowserView showActive | Log sequence: `browser.hideAll()` → overlay paint → preview → `browser.showActive()` on close |
| 3.4 | Browser handoff opens URL in active tab | Step 11: BrowserView navigates to the item URL, no new window |
| 3.5 | `analyze-rss-feed` skill produces structured output | Step 12: skill returns a typed result (not a raw blob), child-run handle visible in projection UI |
| 3.6 | RSSHub-derived feeds (b, c) parse correctly | Items from Bilibili / Twitter routes render with title, author, content/snippet |

## 3. Pre-existing automated coverage

Extensive at the RSS pipeline and analysis layer:

- `src/__tests__/rss-analysis-manager.test.ts`
- `src/__tests__/rss-analysis-group-register.test.ts`
- `src/__tests__/rss-bilibili-browser-acquisition.test.ts`
- `src/__tests__/rss-browser-acquisition.test.ts`
- `src/__tests__/rss-browser-handoff.test.ts`
- `src/__tests__/rss-browser-verification-contract.test.ts`
- `src/__tests__/rss-database-upsert-contract.test.ts`
- `src/__tests__/rss-agent-workbench-regressions.test.ts`
- `src/__tests__/migration-041-rss-analysis-source-id.test.ts`
- `src/__tests__/embedded-skill-lets-go-rss-migration.test.ts`

10+ rss-* test files. RSSHub child-process leak is NOT automated-tested
(requires live network + child process introspection); this dogfood surface
provides the only live evidence for invariant 3.2.

## 4. Operator class

`agent-with-bai-spotcheck` — per §9.4 row 3: RSSHub network behavior varies
by personal RSSHub instance; only 白's box has the configured instance.
白's spot-check is mandatory.

## 5. Evidence file path

`docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/surface-03-rss-rsshub.md`

Manifest: `audits/2026-05-23-stage-y-closeout/dogfood/evidence/surface-03-rss-rsshub-manifest.json`

## 6. Acceptance

### Per §9.1 "Must prove"

- Worker cleanup (test 3.2).
- Preview handoff: DOM overlay before BrowserView showActive (test 3.3).
- Browser handoff: URL in active tab (test 3.4).
- Analyze path: structured output (test 3.5).

### Per-test-case checks

- All 6 invariants observable in screencap and/or log tail.

### Mandatory 白 spot-check (per §9.4)

`bai_spotcheck` REQUIRED. 白's RSSHub instance covers the Bilibili and
Twitter routes — agents on CI-class hardware cannot reproduce (b) and (c).
Agent baseline may cover (a) Hacker News alone; 白 must add (b) and (c) plus
process-leak observation.

### Evidence schema compliance

- Per §9.2, manifest includes head-capture, screencap, `ready-tools.log`, `ready-browser.log`.
- Per §9.2.1, `git_status_porcelain=0` at capture time.
- Per §9.2.2, log tail timestamps strictly overlap reproduction window ± 30s.
