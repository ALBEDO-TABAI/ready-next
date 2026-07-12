---
title: File Emergence P2 Long-term Attention and Intent
status: completed
enforce: true
date: 2026-07-12
---

# P2 implementation contract

## Completion contract

P2 is complete only when all of these are machine-verified:

1. Attention is stored by stable `fileKey`, is backfilled idempotently from the retained 90-day activity/reading window, and survives pruning and a later file move.
2. `future` has four independent deterministic entrances: linked calendar within one year, active structured intent, unfinished reading cadence, or repeated high-investment work. Ordinary chat/browser text cannot create intent.
3. `distant` uses the rollup pool (31–365 days dormant), requires at least two value facts, and observes a 14-day surfaced cooldown.
4. Active intent expires or is invalidated by completion, cancellation, expiry, hidden/archive project state, or missing files.
5. One project appears in at most one bucket in priority order today > future > past > distant. Empty future/distant buckets remain valid.
6. Every generated snapshot appends a privacy-safe immutable record containing only keys, bucket, reason codes, and timestamps.
7. Calendar lookup covers one year and its score decays smoothly without a 60-day cliff.

## Data contract

- `file_attention_rollups`: one row per `file_key`; timestamps, counts, active days, reading totals/progress, mark/link counts, latest related structured fact, surface feedback, existence/archive, observed/history coverage. No body, chat text, or web content.
- `project_intent_facts`: project/file keys, closed kind/source/status vocabularies, bounded dates, and short evidence code/reference only.
- `file_emergence_prediction_snapshots`: append-only generation/project/bucket/reason rows; no title or path.

## Verification

- Native repository tests run under Electron and may not skip SQLite.
- Scoring/service behavior tests cover old-only distant, task/user intent lifecycle, high-investment future, one-year calendar decay, cooldown, empty buckets, pruning survival, and move continuity.
- `npm run verify:file-emergence`, `npm run typecheck`, then real Electron readback.

## Closeout

- 2026-07-12: typecheck passed.
- 2026-07-12: focused verification passed with 74 pure behavior tests and 17 native Electron/SQLite tests, zero skips; migration sequence 1–69 passed.
- Native fixtures proved idempotent backfill, raw-event pruning survival, stable-key move continuity, intent completion, low-sensitive snapshots, 365-day calendar reach, smooth day-59/day-61 decay, high-investment future entry, and distant cooldown.
- 2026-07-12: an isolated real Electron dev profile started successfully, applied migration 069, registered the application services, and reached `main-window-ready-to-show` without a file-emergence startup error.
