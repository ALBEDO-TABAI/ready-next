---
title: Stage Y0.5.01 — File manager dogfood sub-plan
stage: Y0.5.01
surface_id: 1
date: 2026-05-23
status: draft-for-baseline
parent_plan: 2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md
parent_row: §9.1 row 1
operator_class: agent-only
---

# Surface 01 — File manager

## 0. §9.1 row reference (verbatim)

- **Minimum scenario**: "Fixed fixture: open `/tmp/ready-y0-5-fixture/` (created
  by sub-plan with one file `notes.md`); switch from `browser` mode to
  `document` mode and back; rename `notes.md` → `notes-renamed.md`; move to
  subdirectory `archive/`; delete; restore from trash within same session.
  (Codex r2 should-fix #4: was 'across two workbench modes' without
  specifying which.)"
- **Must prove**: "Tree state and selection persist across each mode switch;
  no stale watcher event or duplicate node; restore returns file to original
  path."

## 1. Detailed reproduction steps

1. **Fixture prep** (one-shot before recording starts):
   - `mkdir -p /tmp/ready-y0-5-fixture/`
   - `printf '# Y0.5 fixture\n\nbaseline note for surface 1.\n' > /tmp/ready-y0-5-fixture/notes.md`
   - `rm -rf /tmp/ready-y0-5-fixture/archive` (ensure clean state)
2. Launch the app (`npm run dev` or a built binary). Capture build commit per §9.2.1.
3. In the file manager panel, point the workspace root at `/tmp/ready-y0-5-fixture/`. Confirm `notes.md` appears in the tree.
4. Click `notes.md` to select it; note the selection highlight.
5. Switch workbench mode `browser → document` via the mode switcher. Observe the file tree state.
6. Switch back `document → browser`. Observe the file tree state again.
7. Right-click `notes.md` → Rename → `notes-renamed.md`. Press Enter.
8. Drag (or via context menu Move) `notes-renamed.md` into a newly-created `archive/` subdirectory under `/tmp/ready-y0-5-fixture/`.
9. Right-click `archive/notes-renamed.md` → Delete (Move to Trash).
10. Open the in-app trash panel (or trash affordance) in the same session and trigger Restore on `notes-renamed.md`.
11. Confirm the file is back at `/tmp/ready-y0-5-fixture/archive/notes-renamed.md`.
12. Stop the recording. Capture `ready-tools.log` tail covering the reproduction window.

## 2. Expected result decomposition (test cases)

| # | Invariant | Observable signal |
| ---: | --- | --- |
| 1.1 | Selection persists across mode switches | `notes.md` remains highlighted after each switch in step 5–6 |
| 1.2 | No duplicate node after rename | After step 7, exactly one row exists for `notes-renamed.md`, no orphan `notes.md` row |
| 1.3 | Move operation reflected without watcher echo | After step 8, the file appears under `archive/` exactly once, no flicker creating a phantom node at root |
| 1.4 | Delete moves file out of tree | After step 9, no row for `notes-renamed.md` in the visible tree |
| 1.5 | Restore returns to ORIGINAL path | After step 10, file is at `/tmp/ready-y0-5-fixture/archive/notes-renamed.md` (not root) |
| 1.6 | No stale watcher event | `ready-tools.log` shows no `file-watcher: duplicate-event` or equivalent warning during reproduction window |

## 3. Pre-existing automated coverage

Partial coverage exists at the file-tree drag/drop and grid-navigation layer:

- `src/__tests__/file-tree-browser-tab-drop-contract.test.ts`
- `src/__tests__/file-tree-browser-tab-drop-target.test.ts`
- `src/__tests__/file-tree-external-drop-dispatch.test.ts`
- `src/__tests__/file-tree-grid-navigation.test.ts`

None of the above exercise the rename → move → delete → restore cycle across
mode-switch boundaries with a real fixture directory; this surface adds the
live invariant proof that watcher-echo and selection-persistence behave per
the §9.1 must-prove list. No automated coverage for selection-persistence
across mode switches at Y0.5 entry.

## 4. Operator class

`agent-only` — per §9.4 row "1, 4, 5, 8, 14, 15": pure interaction, no
W3.3-specific behavior. Agent on CI-class hardware can sign status=pass
without 白 spot-check.

## 5. Evidence file path

`docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/surface-01-file-manager.md`

Manifest: `audits/2026-05-23-stage-y-closeout/dogfood/evidence/surface-01-file-manager-manifest.json`

## 6. Acceptance

### Per §9.1 "Must prove"

- Tree state and selection persist across each mode switch (tests 1.1).
- No stale watcher event or duplicate node (tests 1.2, 1.3, 1.6).
- Restore returns file to original path (test 1.5).

### Per-test-case checks

- All 6 invariants in §2 observable in the screencap and/or log tail.
- `status: pass` requires every test-case row visibly confirmed in the
  evidence file's `## Observed result` section.

### Operator-class enforcement (per §9.4)

- `operator_class: agent-only` in frontmatter.
- `bai_spotcheck` block is NOT required; lint rule §9.2.3 enforces this.

### Evidence schema compliance

- Per §9.2, manifest must include head-capture, screencap, and log tail.
- Per §9.2.1, head-capture.txt must show `git_status_porcelain=0`.
- Per §9.2.2, log tail timestamps must strictly overlap the reproduction window ± 30s.
