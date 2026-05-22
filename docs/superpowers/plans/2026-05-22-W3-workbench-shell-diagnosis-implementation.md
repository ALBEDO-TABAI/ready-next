---
name: W3-workbench-shell-diagnosis-implementation
stage: W3
date: 2026-05-22
status: implementation-draft
enforce: false
parent_roadmap: docs/superpowers/plans/2026-05-22-W-ready-stabilization-roadmap.md
predecessor_phase: docs/superpowers/plans/2026-05-22-W1-lint-errors-and-baseline-drift-implementation.md
---

# W3 — Workbench shell diagnosis implementation plan

## 0. Scope

W3 is a **diagnosis-only** phase. It produces 5 artifacts that any future shell-rework PR series will depend on. **No layout-model rewrite is permitted in W3.**

In scope: commit inventory, BrowserView phase map, reflow cost measurement, failure mode enumeration, existing test coverage map. After all 5 are landed, a chosen layout model (grid-track / width-transition / hybrid) is justified against the failure modes in a final design note.

Out of scope: any change to `WorkbenchMode.tsx`, `useBrowserViewBounds.ts`, `tab-shell-service.ts`, or any other shell-related production file. Test changes only if a coverage gap is exposed and a non-shell-touching test can be added to baseline existing behavior.

## 1. Preconditions

- W1 closed: lint clean baseline.
- W0 verification snapshot present.
- May run in parallel with W4 (no shared files).

## 2. Success criteria

5 artifacts under `docs/superpowers/audits/2026-05-22-w3-workbench-shell-diagnosis/`:

1. `commit-inventory.md` — symptom-grouped past fixes.
2. `browserview-phase-map.md` — state diagram tying renderer mode × overlay × resize to BrowserView events.
3. `reflow-measurements.md` — baseline timings for sidebar toggle / chat resize / mode switch / split drag.
4. `failure-modes.md` — 6 enumerated failure modes with reproduction notes.
5. `existing-test-coverage.md` — every workbench/browser-resize/browser-view test labeled `behavior` / `source-grep` / `snapshot`.

Plus one final design note `chosen-layout-model.md` proposing one of {grid-track, width-transition, hybrid} with one line per failure mode explaining how the chosen model prevents it.

## 3. Step-by-step

### W3.1 — Commit inventory

Use the exact command from roadmap § 6 step 1 (paths mirrored from audit § G3):

```bash
git log --oneline --no-decorate -- \
  src/renderer/pages/WorkbenchMode*.tsx \
  src/renderer/modules/browser/useBrowserViewBounds.ts \
  src/renderer/modules/browser/useBrowserResizeFreeze.ts \
  src/renderer/modules/browser/useBrowserRuntimeEffects.ts \
  src/renderer/modules/browser/useBrowserPanelData.ts \
  src/main/modules/browser-engine/tab-shell-service.ts \
  src/main/modules/browser-engine/tab-lifecycle-service.ts \
  src/main/modules/browser-engine/host-layout-service.ts \
  src/main/modules/browser-engine/window-open-service.ts \
  > w3-raw-log.txt
```

For each commit, classify into one of: `flicker / desync / mode-transition / split-pane / RSS overlay / rapid-switch / other`. Write `commit-inventory.md` as a table: `hash | date | subject | symptom-bucket`.

### W3.2 — BrowserView phase map

Read the 9 files above and produce a state diagram (mermaid or ASCII) in `browserview-phase-map.md` covering:

- Renderer modes: `browser` / `document` / `rss` / `calendar`.
- Overlay states: `none` / `dom-modal` / `dom-overlay`.
- Resize states: `idle` / `dragging` / `freeze-active`.

For each cell, name which BrowserView events fire: `attach / detach / show / hide / setBounds`.

### W3.3 — Reflow cost measurement

With Ready running in dev (`npm run dev`), use React Profiler + browser `performance.measure` to capture timings for:

- Sidebar toggle (open + close).
- Chat panel resize (drag from 200px to 600px).
- Mode switch (browser → document → browser).
- Split-pane drag.

Each measurement: median + p95 over 5 runs. Record in `reflow-measurements.md`. Equipment, OS, build info captured once at the top.

### W3.4 — Failure mode enumeration

From audit § G3, enumerate the 6 failure modes; for each, attempt to reproduce in dev and record:

- Reproduction steps.
- Observed symptom (with screenshot if possible).
- Affected files (from commit inventory).
- Severity (release-blocking / latent / cosmetic).

Write `failure-modes.md` as one section per failure mode.

### W3.5 — Existing test coverage map

```bash
find src/__tests__ -name "*workbench*" -o -name "*browser-resize*" -o -name "*browser-view*" -o -name "*browser-window*" | sort
```

For each file:

- Open and label as `behavior` / `source-grep` / `snapshot` (look for `readFileSync` to detect source-grep).
- Tag which failure mode (from W3.4) it covers, or `none`.

Write `existing-test-coverage.md` as a table.

### W3.6 — Chosen layout model

After W3.1-W3.5 are committed, write `chosen-layout-model.md`:

- Proposed model: one of {grid-track, width-transition, hybrid}.
- Justification per failure mode (one line each from W3.4 list).
- Electron 34 / Chromium support check (cite specific CSS / API the model relies on).
- BrowserView ownership boundary clarification (which side owns attach/detach decisions).
- First 3 PRs of the future implementation phase (named only, not implemented).

## 4. Final verification

```bash
ls docs/superpowers/audits/2026-05-22-w3-workbench-shell-diagnosis/
# must list: commit-inventory.md, browserview-phase-map.md, reflow-measurements.md,
#           failure-modes.md, existing-test-coverage.md, chosen-layout-model.md
```

Plus a manual check: every failure mode in W3.4 is referenced by W3.6's per-failure-mode line.

## 5. Codex review

Per roadmap § 2.2:

- Plan review before W3.1.
- After each of W3.1-W3.5: optional spot review (not required, but recommended for W3.3/W3.4 because they involve manual measurement and observation).
- W3 exit review after `chosen-layout-model.md` is in, focused on whether the proposed layout model is defensible against every enumerated failure mode.

W3 closes when exit review returns 0-异议 per roadmap § 2.2.
