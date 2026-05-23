---
title: Stage Y seed — product surface completion and release prep
date: 2026-05-23
stage: Y-seed
enforce: false
parent_roadmap: docs/superpowers/plans/2026-05-22-X-trust-foundation-and-w5-recovery-implementation.md
predecessor_closeout: docs/superpowers/audits/2026-05-22-stage-x-closeout/CLOSE-NOTE.md
---

# Stage Y seed plan — product surface completion and release prep

**This is a seed, not an implementation plan.** Stage Y will refine each
P0/P1/P2 row below into its own `YYYY-MM-DD-Y-<scope>-implementation.md`
file with concrete contracts, gates, and exit criteria before any source
edit lands. The scope here is the deliberate Stage X handoff per X plan
§11 + the four W5/X4 evidence-pending items that need 白's live equipment.

## P0 — release-blocking once Stage Y opens

These are the items that must clear before any release-candidate work
(Stage Z) can start.

### P0.1 — Full product dogfood matrix

| Surface | Why P0 | Seed acceptance |
| --- | --- | --- |
| file manager | Core workspace surface; not exercised in Stage W5 dogfood | Open/move/rename/delete a file across two workbench modes; no crash; tree state persists across mode switch. |
| embedded browser | Core mode; X4 PR-shell-1/2/4 landed contract only — needs live exercise | All 5 BrowserViewIntent kinds dispatch correctly with the 100 ms ack budget under real navigation. |
| RSS | Mode exists; Stage W5 item 2 covered subset | Subscribe to 3 sources, refresh, expand article preview without RSSHub worker leak. |
| document editor / preview / widgets | Stage W4 work; widget skeletons + H1/H2 freeform | All A-G skeletons render, one freeform trigger word works, no widget drops to default skeleton silently. |
| calendar | Mode exists | Create one event, navigate ±1 day, recurring instances render. |
| Agent panel | Stage W4 + X2 session/composer recovery | Send-then-fail-then-retry round-trip; composer unlocks on every failed send including HTTP 402; tab strip survives provider switch. |
| settings | Stage X out-of-scope per §1 | Open every settings page; no infinite-render bug; provider edit + save round-trip. |
| skills | Stage R-T work in deep gates | Install one skill; run one skill action; child run resumability across app restart. |
| provider failure recovery | Stage X2 fixed code; needs live extended scenarios | Network timeout, HTTP 402, HTTP 429, provider 5xx, malformed stream — all unlock composer without manual Stop. |

Each row is a separate Stage Y implementation plan. Acceptance evidence
format: reproduction steps + 30 s screencap + log tail (`ready-tools.log`,
`ready-directchat.log`, or `ready-browser.log` as relevant).

### P0.2 — Release checklist synchronization for old Stage U yellow/manual items

Stage U deferred a small list of "yellow" / "manual reviewer" items into
the closeout ledger. Stage Y must enumerate them and either (a) automate
the check, (b) move into a written release-engineer checklist, or
(c) explicitly retire as not-applicable. The Stage U ledger row in
`docs/superpowers/audits/2026-05-19-stage-u-closeout/deferred-work-ledger.md`
(or the equivalent location) is the start of this work.

### P0.3 — W5 item 3 live evidence (carry from X2)

`docs/superpowers/audits/2026-05-22-stage-x-closeout/w5-item-03-rerun/PENDING-USER-RUN.md`
documents the exact reproduction steps. The code landed at X2.2-2.6; live
re-measurement on the W3.3 equipment is 白's responsibility per X plan §3
exit criterion 4 "explicitly deferred" branch.

### P0.4 — Workbench shell Scenario C + D live measurements (carry from X4)

`docs/superpowers/audits/2026-05-22-stage-x-closeout/workbench-shell-report.md`
has Scenario C (mode-switch p95) + Scenario D (split-pane drag) tables
pre-baked with W3.3 baselines and `_(待补)_` markers. 白's MacBook Pro
M5 Pro 24 GB / macOS 26.4 / 120 Hz ProMotion is the only validated
equipment. Stage Y will flip the report frontmatter
`status: skeleton → status: complete` after the rerun.

## P1 — should land in Stage Y core scope

### P1.1 — MCP real transport or "not shipped" labeling

X plan §11 P1 item. Either land real MCP transport for at least one
provider, or surface "MCP not shipped" in the product UI. The Stage T
work proved the authorization gate; the transport itself is the gap.

### P1.2 — Settings cache quota enforcement

X plan §11 P1 item. Stage Y owns the design + implementation.

### P1.3 — Warning reduction below the 771 budget

Start with the correctness-relevant rules:

- `react-hooks/exhaustive-deps` (18 occurrences) — each one is a
  potential stale closure bug
- `react-refresh/only-export-components` (17) — each one breaks Vite HMR
  for a real renderer file
- `@typescript-eslint/no-unused-vars` (182) — start with the
  ChatPanel.tsx + 8 X2-touched files where stale imports remained after
  the X2 refactor

`@typescript-eslint/no-explicit-any` (551) is volume but lower
correctness signal; tackle it last.

### P1.4 — Source-grep gate replacement with behavior tests

Stage W carried this; Stage X added 1 new source-grep test at X4.3
(`browserview-split-secondary-bounds.test.ts:156`) with the standard
allowlist comment. Stage Y should sweep:

- Current `// eslint-disable-next-line ready/no-source-grep-test`
  occurrences (grep'd above)
- The 4 Stage X1.8 retired sub-gates (`check-stage-r-verify-switch`,
  `check-stage-t-verify-switch`, `check-testing-conventions-doc`,
  `check-research-adapter-registered-in-host`) — each needs a real
  behavior or contract test before retirement is permanent.

### P1.5 — Stage X1.8 4 retired gates → real fixes

The replacement gate `verify:stage-x-known-regressions` pins these as
known regressions. Stage Y must either:

(a) fix the underlying CLAUDE.md/AGENTS.md heading drift + research
    adapter array ordering + sqlite test guards, then re-add the gates
    to `verify:c/r/s/t`, OR
(b) decide the gates are obsolete and remove them from the replacement
    gate + retire the ledger row.

## P2 — Stage Y stretch / Stage Z carry

### P2.1 — Windows parity

Process cleanup, RSSHub worker behavior, file path normalization. Stage W6
W3.3 measurements were Mac-only; Stage Z release must cover Windows.

### P2.2 — Large-file extraction

After boundaries are stable. X plan §11 P2 list:

- `turn-engine.ts`
- `browser-tools.ts`
- `agent-sdk-runtime.ts`
- `skill-child-runner.ts`
- `Settings.tsx`
- `database.ts`
- `FileTree.tsx`
- `useAgent.ts` (W4.8 explicitly deferred)
- document task pipeline executor

These are mechanical extractions but each can break implicit cross-file
contracts; do not bundle them.

### P2.3 — CI first-run record

X3 deliverable: the first remote CI run URL was deferred from X3 to X5
to X5+. Once `.github/workflows/ready-merge-gates.yml` runs on a real PR,
append the URL to `ci-gate-report.md` § 3 and (if the run reveals any
delta vs the local merge gate) record the delta in this seed plan or
its successor.

## How Stage Y opens

A Stage Y entry plan should:

1. Read this seed.
2. For each P0 row, write a dedicated implementation plan.
3. For each P1 row, decide scope vs further deferral.
4. Land P0.3 + P0.4 first to unblock release-track.
5. Open a Stage Y closeout bundle at
   `docs/superpowers/audits/<date>-stage-y-closeout/` mirroring the
   Stage W §2.1 + Stage X §10 5-artifact pattern.

This file itself becomes inert once Stage Y entry plan exists; do not
edit in place — link to it from the Stage Y plan instead.
