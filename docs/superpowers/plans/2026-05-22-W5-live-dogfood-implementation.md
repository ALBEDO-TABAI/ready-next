---
name: W5-live-dogfood-implementation
stage: W5
date: 2026-05-22
status: implementation-draft
enforce: false
parent_roadmap: docs/superpowers/plans/2026-05-22-W-ready-stabilization-roadmap.md
predecessor_phase: docs/superpowers/plans/2026-05-22-W4-useagent-ownership-implementation.md
---

# W5 — Live Ready dogfood implementation plan

## 0. Scope

W5 runs the live Ready app against the dogfood checklist defined in roadmap § 8 and produces a self-contained evidence directory. It is required because the Stage V multi-session features, BrowserView transitions, document split, and RSS preview have only test coverage, not user-flow validation (audit § G6).

In scope: launching Ready with isolated user data, executing the 6-item checklist, capturing run-level metadata + per-item evidence, filing failures as W3 / W4 follow-ups or new issue records.

Out of scope: fixing failures (failures become follow-up tracked work, not in-line W5 fixes). Adding new features. Performance benchmarking beyond the W3 reflow measurements.

## 1. Preconditions

- W1 closed (lint clean baseline).
- W3 exit review complete (so dogfood findings can be classified against W3 failure-mode enumeration).
- W4 exit review complete (so dogfood findings can be classified against W4 ownership areas).
- Local Ready build works: `npm run dev` launches without crash.

## 2. Success criteria

1. `docs/superpowers/audits/2026-05-22-stage-w-closeout/dogfood/` directory exists with:
   - `RUN-META.md` — run-level metadata (build info, user data dir, session start/end, operator).
   - `REPORT.md` — one row per checklist item: `<id>  Pass/Fail  <evidence-link>`.
   - `items/<item-id>/evidence.{png,mov}` for every checklist item (Pass and Fail).
   - `items/<item-id>/log-window.txt` for items asserting runtime events (optional, see roadmap § 8 evidence format).
   - `issues/<issue-id>.md` for every Fail without an existing W3/W4 follow-up.
2. Every Fail row in `REPORT.md` has a tracking reference (W3 / W4 / new issue file).
3. No Fail exits W5 without a successor.

## 3. Step-by-step

### W5.1 — Prepare run-level metadata

Create `RUN-META.md` before launching:

```md
# Stage W dogfood run metadata

- **Operator**: <name>
- **Date**: 2026-05-22
- **Session start**: <ISO timestamp>
- **Session end**: <ISO timestamp, filled at the end>
- **Build**: Ready <version from package.json>
- **Git HEAD**: <git rev-parse HEAD>
- **OS**: <uname -a>
- **Electron / Node**: <from `verify:native` output>
- **User data dir**: `~/.ready-w5-dogfood-2026-05-22` (isolated; created fresh)
```

Before launching:

```bash
rm -rf ~/.ready-w5-dogfood-2026-05-22
mkdir ~/.ready-w5-dogfood-2026-05-22
```

Ready reads the userData dir from the `READY_USER_DATA_DIR` env var (see `src/main/index.ts` line 68: `app.setPath('userData', READY_USER_DATA_DIR)`). Launch dev with isolated data:

```bash
READY_USER_DATA_DIR=~/.ready-w5-dogfood-2026-05-22 npm run dev
```

Verify the dir is being used: after first launch, `ls ~/.ready-w5-dogfood-2026-05-22/` should show Ready-managed files (e.g., SQLite db, settings json).

### W5.2 — Run the 6-item checklist

Per roadmap § 8:

| # | Item | Required evidence |
| --- | --- | --- |
| 1 | Start Ready with isolated user data | Screenshot of first-render workbench |
| 2 | Open Browser / Document / RSS / Calendar / Agent panel | One screenshot per mode (5 screenshots) |
| 3 | Create/switch agent sessions, hit 3-session cap, wait for toast, click back | Screencap (`.mov`) of full sequence + log-window from `ready-directchat.log` covering the session lifecycle |
| 4 | Toggle sidebar/chat panel + switch modes incl. BrowserView mode transition | Screencap of full sequence + log-window from `ready-browser.log` |
| 5 | Open real document, verify split/freeze not broken | Screenshot before + after split open; screenshot after split close |
| 6 | Record any UI issue | Per-issue file under `issues/` |

For each item, write to `items/<item-id>/evidence.{png,mov}` and update `REPORT.md` row immediately.

### W5.3 — Classify failures

For each Fail in `REPORT.md`:

- If it matches a W3 failure mode (from `docs/superpowers/audits/2026-05-22-w3-workbench-shell-diagnosis/failure-modes.md`): link to that mode's section.
- If it touches `useAgent` per-area state: link to the relevant W4 ownership area.
- Otherwise: create `issues/<issue-id>.md` with title, reproduction steps, evidence link, suggested owner.

### W5.4 — Close the run

Fill `RUN-META.md` session end timestamp. Run a final sanity check:

```bash
test -s docs/superpowers/audits/2026-05-22-stage-w-closeout/dogfood/RUN-META.md
test -s docs/superpowers/audits/2026-05-22-stage-w-closeout/dogfood/REPORT.md
ls docs/superpowers/audits/2026-05-22-stage-w-closeout/dogfood/items/
```

Every checklist item has a directory and at least one evidence file. Every Fail row has a tracking link.

## 4. Final verification

- `REPORT.md` contains exactly 6 rows.
- Each row's evidence link resolves to an existing file.
- Each Fail row's tracking link resolves to either a W3 failure-mode anchor, a W4 area anchor, or an `issues/*.md` file.

## 5. Codex review

Per roadmap § 2.2:

- Plan review before W5.1.
- W5 exit review after `REPORT.md` is complete. Codex's job: confirm all 6 items have evidence, every Fail has a successor, the run metadata is intact.

W5 closes when exit review returns 0-异议.
