---
title: Stage Y0.5.04 — Document editor / preview dogfood sub-plan
stage: Y0.5.04
surface_id: 4
date: 2026-05-23
status: draft-for-baseline
parent_plan: 2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md
parent_row: §9.1 row 4
operator_class: agent-only
---

# Surface 04 — Document editor / preview

## 0. §9.1 row reference (verbatim)

- **Minimum scenario**: "Open markdown and editable document; save; preview;
  reopen."
- **Must prove**: "No silent save failure; preview/editor state matches
  disk."

## 1. Detailed reproduction steps

1. **Fixture prep**:
   - `mkdir -p /tmp/ready-y0-5-fixture/docs`
   - `printf '# Y0.5 doc fixture\n\nbaseline body.\n' > /tmp/ready-y0-5-fixture/docs/doc-04.md`
2. Launch app; capture build commit.
3. Switch workbench mode to `document`.
4. Open `/tmp/ready-y0-5-fixture/docs/doc-04.md` in the editor.
5. Type into the editor: append `\n\nedited by surface 4.\n` to the body.
6. Trigger Save (Cmd-S / save button). Observe the save confirmation/state.
7. Switch to Preview mode. Confirm preview reflects the saved content (including the appended line).
8. Reopen the same document (close + reopen, or close pane + open from file tree).
9. Verify editor body matches what was on disk at step 6.
10. Read disk: `cat /tmp/ready-y0-5-fixture/docs/doc-04.md` — confirm content matches.
11. Force a save-failure scenario: change file permission to read-only (`chmod 444 /tmp/ready-y0-5-fixture/docs/doc-04.md`), edit again, trigger Save.
12. Confirm the app surfaces an error toast/banner (not silent green); restore permission (`chmod 644`).
13. Stop recording. Capture `ready-tools.log` and console.

## 2. Expected result decomposition (test cases)

| # | Invariant | Observable signal |
| ---: | --- | --- |
| 4.1 | Save round-trip persists to disk | After step 6, `cat` at step 10 shows appended text |
| 4.2 | Preview matches editor content | Step 7: preview pane shows the appended line |
| 4.3 | Reopen restores from disk | Step 8–9: editor body matches step-10 disk content (no stale buffer) |
| 4.4 | Save failure surfaces visibly | Step 11–12: error toast/banner appears; not silent success |
| 4.5 | No phantom dirty state | After successful save, editor's dirty indicator clears |

## 3. Pre-existing automated coverage

Partial coverage at the document task and pipeline layer:

- `src/__tests__/document-task-pipeline.test.ts`
- `src/__tests__/document-task-pipeline-host-contract.test.ts`
- `src/__tests__/document-task-classifier.test.ts`
- `src/__tests__/document-task-plan.test.ts`
- `src/__tests__/document-task-plan-subtask.test.ts`
- `src/__tests__/document-task-cache-key.test.ts`
- `src/__tests__/document-task-abort-propagation.test.ts`

The pipeline tests cover task planning and classification. Save-failure
surfacing and reopen-from-disk invariants are NOT covered automatically;
this dogfood adds the live invariant proof for 4.1, 4.3, 4.4.

## 4. Operator class

`agent-only` — per §9.4 row "1, 4, 5, 8, 14, 15": pure interaction, no
W3.3-specific behavior. CI-class hardware is sufficient.

## 5. Evidence file path

`docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/surface-04-document-editor-preview.md`

Manifest: `audits/2026-05-23-stage-y-closeout/dogfood/evidence/surface-04-document-editor-preview-manifest.json`

## 6. Acceptance

### Per §9.1 "Must prove"

- No silent save failure (test 4.4).
- Preview/editor state matches disk (tests 4.1, 4.2, 4.3).

### Per-test-case checks

- All 5 invariants observable in screencap and/or log tail + disk verification.

### Operator-class enforcement (per §9.4)

- `operator_class: agent-only`.
- `bai_spotcheck` block NOT required.

### Evidence schema compliance

- Per §9.2, manifest includes head-capture, screencap, log tail.
- Per §9.2.1, `git_status_porcelain=0` at capture.
- Per §9.2.2, log tail strictly overlaps reproduction window ± 30s.
