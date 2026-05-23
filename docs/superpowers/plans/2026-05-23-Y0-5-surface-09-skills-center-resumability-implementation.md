---
title: Stage Y0.5.09 — Skills center (restart + crash + forced-quit resumability) dogfood sub-plan
stage: Y0.5.09
surface_id: 9
date: 2026-05-23
status: draft-for-baseline
parent_plan: 2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md
parent_row: §9.1 row 9
operator_class: agent-only
---

# Surface 09 — Skills center (restart + crash + forced-quit resumability)

## 0. §9.1 row reference (verbatim)

- **Minimum scenario**: "Install bundled skill, run one action that produces
  an artifact, then in three separate sessions: (a) clean app restart,
  (b) `kill -9` on Electron process mid-run, (c) Cmd-Q forced quit mid-run.
  After each, reopen app and verify the child-run handle resumes."
- **Must prove**: "Child-run durable handle works in ALL THREE scenarios per
  CLAUDE.md §3; artifact paths survive; the projection UI shows the correct
  continuable state without renderer guessing."

## 1. Detailed reproduction steps

For EACH of three scenarios A, B, C — fresh app instance each time:

1. Launch app. Capture build commit. Confirm bundled skill (e.g.
   `analyze-rss-feed` or `vea`) is installed.
2. Start the chosen skill action; verify a child-run begins. Note `childRunId` or `outputDir + runStatePath` in `ready-tools.log`.
3. While the action is still running (BEFORE artifact emission completes):
   - **Scenario A (clean restart)**: trigger the app's Quit (Cmd-Q on macOS, or File → Quit). Wait full cleanup. Relaunch.
   - **Scenario B (kill -9)**: in a separate terminal `pgrep -lf Electron` to find the main process; `kill -9 <pid>`. Wait. Relaunch.
   - **Scenario C (forced quit)**: hold Cmd-Q (forced quit) or Force Quit from the Dock context menu. Relaunch.
4. After relaunch: open the Skills center / task projection UI.
5. Verify the child-run handle is visible AND the projection UI labels it as `continuable` (NOT renderer-guessed "completed" per CLAUDE.md §3 line 49–50).
6. Trigger Resume on the child-run handle.
7. Verify the artifact path from the original run is intact on disk (read the path from `outputDir`).
8. Verify the resumed run completes the action and emits the final artifact at the original path (or appends to it per spec).
9. Capture `ready-tools.log`, `ready-directchat.log`, and a screencap of the projection UI.

10. Repeat steps 1–9 for scenarios A, B, C separately.

11. Stop recording.

## 2. Expected result decomposition (test cases)

| # | Invariant | Observable signal |
| ---: | --- | --- |
| 9.A.1 | Scenario A: child-run handle survives clean restart | Step 5 (A): handle visible after relaunch |
| 9.A.2 | Scenario A: artifact path survives | Step 7 (A): file exists on disk |
| 9.A.3 | Scenario A: resume completes | Step 8 (A): final artifact at original path |
| 9.B.1 | Scenario B: child-run handle survives kill -9 | Step 5 (B) |
| 9.B.2 | Scenario B: artifact path survives | Step 7 (B) |
| 9.B.3 | Scenario B: resume completes | Step 8 (B) |
| 9.C.1 | Scenario C: child-run handle survives forced quit | Step 5 (C) |
| 9.C.2 | Scenario C: artifact path survives | Step 7 (C) |
| 9.C.3 | Scenario C: resume completes | Step 8 (C) |
| 9.4 | Projection UI labels state per CLAUDE.md §3 | All 3 scenarios: projection shows "continuable", not "completed" guess |
| 9.5 | No empty-shell taskRunId/skillId masquerading as continuable | Per CLAUDE.md §3 line 50: durable handle requires childRunId / detachedTaskId / outputDir+runStatePath |

## 3. Pre-existing automated coverage

Extensive at the child-run + durable-handle layer:

- `src/__tests__/active-child-run-ipc.test.ts`
- `src/__tests__/active-skill-context.test.ts`
- `src/__tests__/child-run-circuit-breaker.test.ts`
- `src/__tests__/child-run-retry-policy.test.ts`
- `src/__tests__/detached-skill-task-tracker.test.ts`
- `src/__tests__/embedded-skill-deep-research.test.ts`
- `src/__tests__/embedded-skill-fac-three-skills.test.ts`
- `src/__tests__/embedded-skill-managed-sync.test.ts`
- `src/__tests__/embedded-skill-vea-host-requirements.test.ts`
- `src/__tests__/embedded-skill-vea-run-state-contract.test.ts`
- `src/__tests__/embedded-skill-vea-runtime-failure-paths.test.ts`
- `src/__tests__/skill-inspect-run-state-vea-contract.test.ts`
- `src/__tests__/skill-running-projection-vea-progress.test.ts`

Strong coverage. The three-scenario kill/forced-quit resumability matrix
in the assembled product (signals 9.B.*, 9.C.*) is NOT automated; this
dogfood adds the live invariant proof.

## 4. Operator class

`agent-only` — per §9.4 row 9: "Resumability test; visual aspect is
minimal. Forced-quit / `kill -9` paths require careful evidence capture;
agent may need to script them."

## 5. Evidence file path

`docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/surface-09-skills-center-resumability.md`

Manifest: `audits/2026-05-23-stage-y-closeout/dogfood/evidence/surface-09-skills-center-resumability-manifest.json`

## 6. Acceptance

### Per §9.1 "Must prove"

- Child-run durable handle in ALL three scenarios (tests 9.A.1, 9.B.1, 9.C.1).
- Artifact paths survive (tests 9.A.2, 9.B.2, 9.C.2).
- Projection UI shows correct continuable state without renderer guessing (tests 9.4, 9.5).

### Per-test-case checks

- All 11 test-case rows observable in screencap and/or log tail.
- Evidence must contain SEPARATE screencaps per scenario (A, B, C) OR a composite with named time-ranges per scenario.

### Operator-class enforcement (per §9.4)

- `operator_class: agent-only`. `bai_spotcheck` NOT required.

### Evidence schema compliance

- Per §9.2, manifest includes head-capture, 3 screencaps (or 1 composite), `ready-tools.log` per scenario.
- Per §9.2.1, `git_status_porcelain=0`.
- Per §9.2.2, log strictly overlaps each scenario's reproduction window ± 30s.
