---
title: Stage Z seed — release-candidate phase
date: 2026-05-24
stage: Z-seed
status: seed-pending-z-entry-plan
predecessor_closeout: docs/superpowers/audits/2026-05-23-stage-y-closeout/CLOSE-NOTE.md
parent_y_plan: docs/superpowers/plans/2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md
enforce: false
---

# Stage Z seed plan — release-candidate phase

This is a seed, not an implementation plan. Stage Z will refine each
P0/P1/P2 row below into its own `YYYY-MM-DD-Z-<scope>-implementation.md`
file with concrete contracts, gates, and exit criteria before any
source edit lands. The scope here is the deliberate Stage Y closeout
hand-off per Y plan §13 + the Y-to-Z handoff matrix at
`docs/superpowers/audits/2026-05-23-stage-y-closeout/y-to-z-handoff-matrix.md`.

## Predecessor

Stage Y closeout: see
[`docs/superpowers/audits/2026-05-23-stage-y-closeout/CLOSE-NOTE.md`](../audits/2026-05-23-stage-y-closeout/CLOSE-NOTE.md).

Stage Y verification freeze: 11 / 11 commands at exit 0 per
[`no-drift.md`](../audits/2026-05-23-stage-y-closeout/no-drift.md).

Stage Y deferred-work ledger entry-points: see
[`deferred-work-ledger.md`](../audits/2026-05-23-stage-y-closeout/deferred-work-ledger.md);
filter by `bucket = "Stage Z release-candidate"`.

## Stage Z entry conditions (verified)

Per Y plan §13 — both conditions met at Y closeout:

- ✅ All Y0 P0 rows green or explicitly deferred per §3.2, EXCEPT
  Y0.7 + Y0.8 (non-deferrable per §3.2 carve-out) which ARE green.
- ✅ Y1.1 + Y1.3 + Y1.4 (release-relevant P1 subset) all green.

Stage Z may enter immediately after the Y closeout codex review loop
closes (2 consecutive PASS rounds per Y plan §18).

## P0 — Stage Z release-blocking work

Per Y plan §13 contract:

### Z0.1 — Release-candidate gate bundle

One command or script records: `verify:native`, `typecheck`,
`lint:check`, `verify:lint-budget`, `check-eslint-baseline`,
`verify:ipc-contract`, `verify:meta-paths`,
`verify:stage-x-known-regressions`, `verify:stage-y-known-regressions`,
`verify:stage-y-p0-ledger`, `verify:stage-y-dogfood-evidence`,
`test`, `build`, deep-gates as configured, release smoke.

Inherits the Y closeout 11-command freeze + extends with `test` +
`build` + deep-gates + release smoke. Z0.1 owns the workflow file
`.github/workflows/ready-release.yml` (new) or extends the existing
`ready-merge-gates.yml` with a `release` job.

### Z0.2 — Platform parity

macOS packaged smoke plus Windows smoke. Windows must cover:
- Startup (Electron 34 + native bindings)
- SQLite native (better-sqlite3 install + rebuild on Windows)
- BrowserView or equivalent shell behavior
- RSSHub / process cleanup
- File paths (drive letters, separators)
- Build (`npm run build` on Windows runner)
- Y closeout ledger row `stage-u-checklist-row-03-windows-bg-color`
  inherited from Y0.6 reconciliation

### Z0.3 — Release manual checklist

Old manual rows become a dated checklist with owner, evidence, and
pass/fail. Inherits from Y closeout:
- `release-handoff.md` §3 (19 manual-action rows) — execute each
- `release-handoff.md` §4 (3 retired-with-reason rows) — confirm
  still-retired or reopen
- `bai-operator-runbook.md` — field guide for live dogfood per surface
- Y0.5 dogfood matrix 20 surfaces — flip per-surface from
  `deferred-with-owner` to `pass` via 白's live sessions

### Z0.4 — Branch protection + CI policy

Required GitHub status checks configured and documented; deep gates
either required for release branches or documented as manual release
gates. Inherits from Y closeout:
- `release-handoff.md` §5a — Y0.2.b verbatim hand-off (push branch +
  capture first-remote-URL + classify run delta + flip deep-gates +
  configure required-status-check + branch-up-to-date toggle)
- `y0-1-2-stage-r-t-charter-decision.md` §"Policy downgrade" — decide
  whether to re-embed `verify:r`/`verify:t` in plain `verify` for
  release-track strictness, OR document `verify:cloud`-only as
  permanent

### Z0.5 — Release notes + handoff

User-facing changelog + known limitations + rollback steps + next debt
budget. Inherits from Y closeout CLOSE-NOTE.md "Lessons learned"
section + the Y0.5 dogfood matrix per-surface status as the
"What's tested in this release" appendix.

### Z0.6 — Y2.1 large-file extraction wave residual (added at Y plan r7)

If Stage Y exercised the §20.3 Q12 option (a) cap-at-5-files default
(deferring 12 of 17 §12.1 files), Stage Z owns those 12 files. Each
extraction is its own micro-plan; no batch extraction allowed.

Inherits from Y closeout ledger row `electron-d-ts-extraction` +
the Y1.4 sub-plan's 7-extraction proposal for `src/renderer/types/
electron.d.ts`.

## P1 — Stage Z hardening

### Z1.1 — Stage Y P1.5 + P1.6 (e2e suite + bundled-skills audit)

Per Y plan §11.5 + §11.6, Y1.5 + Y1.6 are post-Stage-Z polish per
§13 release-relevant subset rule. Stage Z may execute them as part
of release hardening if release-engineer-time allows; otherwise
they roll into post-release debt.

### Z1.2 — Y2.x large-file extraction wave continuation

Per Y plan §12.1, Y2.1 was budgeted at 30-60h for the 5 highest-
priority files (cap-at-5 default per §20.3 Q12). The remaining 12
files inherit to Z0.6. Z1.2 covers Y2.2 (useAgent split), Y2.3
(database/migration harness), Y2.4 (Windows parity groundwork),
Y2.5 (verify-chain simplification) if Stage Z scope expands.

### Z1.3 — VEA real per-apiKind probe adapter

Per Y closeout ledger row `vea-vision-real-probe-deferred` (deferred
from Y1.1 honest-label path). Stage Z adds real HTTP probe for
vision-model per `apiKind` (OpenAI Chat / OpenAI Responses /
Anthropic Messages), each with different payload + auth header shapes.
Needs consent UX for sending user API key over network.

### Z1.4 — MCP real transport landing

Per Y closeout ledger row `y0-7-mcp-labeling-disposition` (Y0.7 chose
labeling path). Stage Z adds real MCP transport for at least one
provider (stdio recommended per Y plan §11.0b option a).

### Z1.5 — Cache eviction real landing

Per Y closeout ledger row `y0-8-cache-quota-relabel-disposition`
(Y0.8 chose relabel path). Stage Z adds real eviction logic (LRU +
size-trigger), with consent UX if user-confirm-required.

## How Stage Z opens

A Stage Z entry plan should:

1. Read this seed.
2. Read the Y-to-Z handoff matrix verbatim
   ([`y-to-z-handoff-matrix.md`](../audits/2026-05-23-stage-y-closeout/y-to-z-handoff-matrix.md)).
3. For each P0 row, write a dedicated `YYYY-MM-DD-Z-<id>-<slug>-implementation.md`.
4. Dispatch codex Z plan-review loop (mirror Y plan r1-r7 + 2 consecutive PASS rule).
5. Open a Stage Z closeout bundle at
   `docs/superpowers/audits/<date>-stage-z-closeout/` mirroring the
   Y closeout 15-deliverable pattern.

This file itself becomes inert once a Stage Z entry plan exists; do
not edit in place — link to it from the Stage Z entry plan instead.
