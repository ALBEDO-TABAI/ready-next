---
name: W-ready-stabilization-roadmap
stage: W
date: 2026-05-22
status: roadmap-draft
enforce: false
predecessor_review: docs/superpowers/audits/2026-05-22-ready-recent-change-review-and-next-roadmap.md
---

# Stage W - Ready stabilization roadmap after Stage V

## 0. Why this is a roadmap first

Stage V moved the codebase forward structurally, but the remaining work is not one implementation batch. The current risks cut across lint debt, Workbench shell architecture, `useAgent` state ownership, live-app verification, and release-gate meaning.

A single "fix everything" plan would be too broad to review safely. Stage W therefore starts as a roadmap. Each accepted phase should later get its own smaller implementation plan with exact files, tests, and pass/fail criteria.

## 1. Current truth

Evidence from the predecessor review:

- The branch is `codex/readyguy`.
- Typecheck, native ABI, silent-catch, IPC contract, move-only no-op, and unit tests pass as separately run checks.
- `npm run lint:check` fails with 25 errors / 769 warnings.
- `check-eslint-baseline` fails with 19 new entries and 16 stale entries.
- `ChatPanel.tsx` is down to 981 LOC, but `useAgent.ts` is 2,570 LOC.
- IPC contract gate is green, but IPC allowlists remain and need expiry review.
- Workbench shell problems are architectural, not a small polish pass.

## 2. Stage W success criteria

Stage W is complete when **all** the following are true and verifiable from one place:

1. The release-facing verification path is green and its meaning is documented.
2. Lint has zero errors (`npm run lint:check` exit 0 on rule errors), and remaining warnings are a tracked debt ledger rather than an accidental pile.
3. Workbench shell has an accepted architecture plan before code changes.
4. `useAgent` has an ownership plan before more multi-session behavior is added, and V3.3b.3-5 deferred migrations are either landed under W4 or explicitly re-deferred with rationale.
5. A live Ready dogfood checklist has been run and its failure inventory is either fixed or promoted to explicit roadmap entries (not silently swallowed).
6. Stage U / Stage V / Stage W docs agree on what is done, deferred, and release-blocking. The Stage V plan is referenced only via the May 22 closeout.

### 2.1 Stage W release-ready cross-cutting contract

Beyond per-phase Done, Stage W close requires one consolidated evidence bundle in `docs/superpowers/audits/2026-05-22-stage-w-closeout/` with these 5 specific artifacts and verification commands:

All commands below assume `cwd` = repo root.

| Artifact | Path | Verification |
| --- | --- | --- |
| Merge-gate raw stdout | `closeout/merge-gates/{typecheck,lint-check,baseline,native,silent-catch,ipc-contract,test}.out` | Run `bash docs/superpowers/audits/2026-05-22-stage-w-closeout/verify-bundle.sh` (script created in W0) which (a) checks each `.out` file is non-empty, (b) reruns each command and asserts the exit code matches the file's recorded exit code. |
| W5 dogfood report | `closeout/dogfood/REPORT.md` + `closeout/dogfood/items/<id>/` | `REPORT.md` lists every § 8 checklist item; each row uses the format `<id>  Pass/Fail  <evidence-link>`. A reviewer can spot-open each linked evidence file. |
| `package.json` scripts diff | `closeout/w6-scripts-diff.md` | Shows `git diff main..HEAD -- package.json` filtered to the `scripts:` block, plus a per-row taxonomy bucket from W6. |
| Deferred-work ledger | `closeout/deferred-work-ledger.md` | Each row has columns: `item`, `source-stage`, `reason`, `successor-stage`, `tracking-link`. `source-stage` ∈ {`V`,`W0`,`W1`,`W2`,`W3`,`W4`,`W5`,`W6`}. `successor-stage` is either a real future plan file path or the literal string `closed`. |
| No-drift statement | `closeout/no-drift.md` | The file must include the last 3 lines of `npm run lint:check` (showing zero rule errors) and the last 3 lines of `node scripts/check-eslint-baseline.cjs` (showing baseline green), each prefixed with the timestamp of capture (within 24h of Stage W close). |

Stage W is **not closed** until this bundle is reviewed by Codex and acknowledged by 白.

### 2.2 Codex review cadence

- **Every roadmap revision** (this doc) is reviewed by Codex before phase plans start.
- **Each phase plan** (`W{n}-...-implementation.md`) is reviewed by Codex before its first PR is dispatched.
- **Each phase's exit** runs a Codex review on the diff + verification evidence before the next phase starts. Cross-phase parallel work (W3/W4) means each gets its own exit review.
- **Stage W close** (§ 2.1) gets a final Codex review covering the whole bundle.

Fixed review checklist (must be answered every Codex review to prevent rubber-stamp):

1. Does the change match its declared scope, or has scope drifted?
2. Are all new artifacts (files, tests, ledger rows) actually present?
3. Do verification commands listed in the plan actually exist in `package.json` / `scripts/`, **and** when the plan asserts the command succeeds, does it pass when rerun? Codex must rerun each cited command and report exit code 0 or paste the failure. **Exception**: W0 deliberately captures snapshots of currently failing commands (`lint:check`, `check-eslint-baseline`) as the W1 starting baseline; for W0, Codex confirms the captured `.exit` file matches the rerun exit code, not that exit code is 0.
4. Is any in-scope success criterion left untouched?
5. Is any out-of-scope work silently merged in (e.g., warning cleanup inside W1)?

"0-异议" definition:

- Codex returns no `严重问题` (severe) and no `需改` (needs-fix) items two rounds in a row, **and** the second round explicitly answers the fixed checklist above with all five questions = pass; **or**
- All remaining items are explicitly accepted as out-of-scope by 白 with a one-line rationale recorded in the plan or PR description.

Hard cap to prevent infinite loops: a phase plan that hits 5 Codex review rounds without convergence is escalated to 白 for manual scope decision before round 6.

## 3. Phase W0 - Current-truth freeze

Goal: make the present branch state unambiguous before more work starts.

Inputs:

- `docs/superpowers/audits/2026-05-22-ready-recent-change-review-and-next-roadmap.md`
- `package.json`
- current `git status`, `git log main..HEAD`, and latest verification outputs

Deliverables:

1. A one-page Stage V closeout note or changelog row.
2. A clear statement that the locked Stage V plan is historical implementation guidance, while the May 22 closeout review is the current planning entry point.
3. A **gate taxonomy v0**: a single table naming each `verify:*` script as `merge` / `manual-deep` / `release-only` / `debt-dashboard`. This is the seed W6 will formalize, but **W0 must publish v0** so W1's "lint green" definition is unambiguous.
4. A `docs/superpowers/audits/2026-05-22-verification-snapshot/` directory (or appendix) holding raw stdout/stderr of `npm run typecheck`, `npm run lint:check`, `node scripts/check-eslint-baseline.cjs`, `npm run verify:native`, `node scripts/check-silent-catch.cjs`, `npm run verify:ipc-contract`, `npm run test` from this exact branch HEAD, so reviewers can independently audit § 3 of the closeout.
5. An explicit **gate semantics for W1**: "lint:check zero errors" = `npm run lint:check` exits with no rule-level errors; warning count is out of scope for W1.

Done when:

- A reviewer can tell which checks must pass before merge without reading old Stage A-T plan history.
- The gate taxonomy v0 table exists and is referenced by the W1 success criteria.
- Raw verification snapshots are committed and linkable from the closeout.

W0 executor handoff (concrete steps so W1 can start immediately after).

**All commands below run with `cwd` = repo root.** Redirect output into the snapshot directory; do not `cd` into it before running.

1. `mkdir -p docs/superpowers/audits/2026-05-22-verification-snapshot` then from repo root run each command using **bash** (not zsh — `set -o pipefail` and `PIPESTATUS` semantics differ). For each command, capture the command's own exit code (not `tee`'s):

   ```bash
   SNAP=docs/superpowers/audits/2026-05-22-verification-snapshot
   set -o pipefail
   npm run typecheck 2>&1 | tee "$SNAP/typecheck.out"; echo "${PIPESTATUS[0]}" > "$SNAP/typecheck.exit"
   npm run lint:check 2>&1 | tee "$SNAP/lint-check.out"; echo "${PIPESTATUS[0]}" > "$SNAP/lint-check.exit"
   node scripts/check-eslint-baseline.cjs 2>&1 | tee "$SNAP/baseline.out"; echo "${PIPESTATUS[0]}" > "$SNAP/baseline.exit"
   npm run verify:native 2>&1 | tee "$SNAP/verify-native.out"; echo "${PIPESTATUS[0]}" > "$SNAP/verify-native.exit"
   node scripts/check-silent-catch.cjs 2>&1 | tee "$SNAP/silent-catch.out"; echo "${PIPESTATUS[0]}" > "$SNAP/silent-catch.exit"
   npm run verify:ipc-contract 2>&1 | tee "$SNAP/verify-ipc-contract.out"; echo "${PIPESTATUS[0]}" > "$SNAP/verify-ipc-contract.exit"
   npm run test 2>&1 | tee "$SNAP/test.out"; echo "${PIPESTATUS[0]}" > "$SNAP/test.exit"
   ```

   `${PIPESTATUS[0]}` captures the upstream command's exit code, not `tee`'s. If running under zsh, prepend `setopt pipefail` and use `${pipestatus[1]}` instead (zsh arrays are 1-indexed).
2. Write `docs/superpowers/audits/2026-05-22-stage-v-closeout-note.md` (≤1 page) summarizing which Stage V items landed, which deferred to Stage W, and the link to this roadmap.
3. Write `docs/superpowers/operations/verify-gate-taxonomy-v0.md` with one table row per current `package.json` `verify:*` script, columns: `script`, `bucket` (`merge`/`manual-deep`/`release-only`/`debt-dashboard`/`archive`), `rationale`.
4. Write `docs/superpowers/operations/w1-lint-gate-semantic.md` stating: "W1 'lint green' = `npm run lint:check` exits with no rule-level errors; warning count is W2 scope, not W1."
5. Create `docs/superpowers/audits/2026-05-22-stage-w-closeout/verify-bundle.sh` (executable). The script (a) for each `<name>` in {typecheck, lint-check, baseline, ...} checks the `.out` file is non-empty, (b) reruns the matching command and asserts exit code equals the stored `.exit`. This is the verification script § 2.1 references.
6. Commit all of the above in one W0 PR; PR description links to the roadmap § 3 deliverables and notes "W0 complete, W1 unblocked."

A W1 executor reading this section can stop here, run the 5 steps, and W0 is done. No further design or scoping decisions needed for W0.

## 4. Phase W1 - Lint errors and baseline drift

Goal: clear the blocking lint surface without hiding debt.

Current measured blockers:

- `npm run lint:check`: 25 errors / 769 warnings.
- `ready/no-source-grep-test`: 18 current errors.
- `ready/no-subagent-leak`: 5 current errors.
- `ready/no-legacy-backdoor`: 1 current error.
- `no-control-regex`: 1 current error.
- `check-eslint-baseline`: 19 new entries / 16 stale entries.

Implementation plan should split into four batches:

1. Source-grep error replacement: convert the 18 failing assertions into behavior tests or explicitly reviewed hard-contract exemptions.
2. Sub-agent import boundary: resolve the 5 imports by either moving ownership or adding a reviewed boundary contract. Do not silence the rule.
3. Legacy/backdoor and control-regex: fix the single-file errors directly with focused tests.
4. Baseline drift: remove stale entries and only update hashes after replacement decisions are made.

Done when:

- `npm run lint:check` has zero errors.
- `node scripts/check-eslint-baseline.cjs` is green.
- No broad warning cleanup is mixed into this phase.

## 5. Phase W2 - Lint warning debt ledger

Goal: turn the large warning backlog into tracked debt.

Current warning shape:

- 769 warnings total.
- `@typescript-eslint/no-explicit-any`: 551.
- `@typescript-eslint/no-unused-vars`: 180.
- `react-hooks/exhaustive-deps`: 18.
- `react-refresh/only-export-components`: 17.
- Areas: tests 441, main 156, renderer 111, shared 65, scripts 21.

Open decision:

- The user-facing shorthand "584 lint debt" does not match the current run. W2 must decide whether "584" referred to a narrower historical scope, a previous warning count, or a desired target after excluding current red errors.

Deliverables:

1. A lint-debt ledger with rule family, count, target, and owner.
2. A policy decision for `any` in tests.
3. A threshold script or dashboard that can fail only when debt grows, not while it is being intentionally paid down.

Done when:

- Warning debt has an agreed baseline and cannot silently grow.

## 6. Phase W3 - Workbench shell architecture roadmap

Goal: choose the shell model before implementation.

Why separate:

- Workbench shell spans DOM layout, native BrowserView ownership, side/chat panel width, mode transitions, split panes, RSS preview, document layout freeze, and live visual polish.
- `src/renderer/pages/WorkbenchMode.tsx` still owns too many layout and runtime responsibilities.
- Existing tests lock symptoms, but the shell still lacks one clear layout contract.

Required current-state diagnosis (must precede any layout-model choice):

1. **Symptom-fix commit inventory**: snapshot `git log --oneline -- src/renderer/pages/WorkbenchMode*.tsx src/renderer/modules/browser/useBrowserViewBounds.ts src/renderer/modules/browser/useBrowserResizeFreeze.ts src/renderer/modules/browser/useBrowserRuntimeEffects.ts src/renderer/modules/browser/useBrowserPanelData.ts src/main/modules/browser-engine/tab-shell-service.ts src/main/modules/browser-engine/tab-lifecycle-service.ts src/main/modules/browser-engine/host-layout-service.ts src/main/modules/browser-engine/window-open-service.ts` and group commits by symptom (flicker / desync / mode-transition / split-pane / RSS overlay / rapid-switch). Paths verified against current repo on 2026-05-22 and mirrored from audit § G3; if any moves before W3 starts, update both this list and audit § G3 first.
2. **BrowserView phase map**: a state diagram tying renderer mode (`browser` / `document` / `rss` / `calendar`) × overlay visibility × resize-in-progress to BrowserView attach/detach/hide/show/bounds-sync events.
3. **Reflow cost measurement**: with React Profiler + `performance.measure`, capture sidebar toggle, chat-panel resize, mode switch, and split-pane drag baseline timings on a non-empty workspace.
4. **Failure mode enumeration** (from the audit's G3 list): hide/show flicker, bounds desync, DOM modal vs. native overlay z-conflict, split-pane drag mid-animation, RSS preview overlay vs. main BrowserView, rapid mode-switch with loading tab.
5. **Existing test coverage map**: list every `__tests__/*workbench*.test.ts`, `*browser-resize*.test.ts`, `*browser-view*.test.ts` and label each as `behavior` / `source-grep` / `snapshot`.

Options to evaluate (only after § 1-5 are documented):

1. Grid-track shell: centralize rail/sidebar/main/chat tracks with CSS variables.
2. Width-transition shell: keep current structure but make shell width interpolation and bounds sync first-class.
3. Hybrid shell: grid for top-level tracks, measured width-transition for native BrowserView-sensitive panes.

Required proof before implementation:

- Electron 34 / Chromium support check for the chosen layout mechanics.
- BrowserView hide/show ownership boundary.
- Visual acceptance checklist for sidebar/chat open-close, browser mode transitions, document split, RSS preview, and rapid mode switching.

Done when:

- All five diagnosis deliverables exist and are linked from the W3 plan.
- A chosen layout model is justified against the failure-mode enumeration (each mode has a one-line "how this model prevents it").
- A small implementation plan can name the first 3 PRs without touching unrelated agent or lint work.

## 7. Phase W4 - `useAgent` state ownership plan

Goal: prevent the next multi-session work from turning `useAgent.ts` into the new monolith.

Current concern:

- `ChatPanel.tsx` is now below target, but `useAgent.ts` is 2,570 LOC and owns too many concerns.

Required current-state inventory:

1. **Current test coverage**: list every `__tests__/*useAgent*.test.ts`, `*chat-session*.test.ts`, `*multi-session*.test.ts`, `*pending-send*.test.ts`; label each by which ownership area it touches.
2. **Stage V deferred inheritance**: V3.3b.3-5 (streaming / scopeRuns / taskProjections) migrations land **inside** W4 unless explicitly re-deferred with rationale. The W4 implementation plan must call each out by name.
3. **Consumer dependency map**: list every `useAgent.getState()` / `useAgent(...)` call site outside the store; group by which area it reads and whether it currently mutates.

Ownership areas to split conceptually before coding:

1. Session slice state.
2. Runtime event listeners.
3. Pending-send coalescing.
4. Message persistence and replay.
5. Task projection merging.
6. UI selectors consumed by ChatPanel / TaskPanel / MeetingChat.

Falsifiable acceptance contracts (each maps to a named test file the W4 plan must create or extend):

- **Per-area selector test** → `src/__tests__/useAgent-area-selector-contract.test.ts`
  - Each ownership area exposes a typed selector returning a stable narrow slice.
  - Test asserts that calling the selector twice with no state change returns `===` (shallow stability).
  - Consumers must import only the selector, not internal area state. (Verified by importing the area module and asserting only the selector export is `export`-tagged.)
- **Cross-area mutation guard** → `eslint-rules/no-cross-area-mutation.mjs` + `src/__tests__/useAgent-cross-area-mutation-guard.test.ts`
  - Custom ESLint rule (or AST-based check) asserts no consumer outside `useAgent.ts` writes into an ownership area except via that area's declared action exports.
  - Test fixture file deliberately violates the rule and the test asserts the rule fires.
- **Listener routing test** → `src/__tests__/useAgent-listener-routing-contract.test.ts`
  - For each runtime event type (push channels enumerated by V5 IPC contract), simulate event delivery with `sessionId` set, with `sessionId` absent but `conversation` set, with both absent.
  - Assert the 3-level fallback (`sessionId` → `conversation` → `activeSessionId`) resolves in exactly that order; test fails if fallback order changes.
- **V3.3b.3-5 per-field migration tests** → `src/__tests__/useAgent-session-slice-migration.test.ts` (extend the existing pattern from V3.3b.1/V3.3b.2)
  - Three sub-cases: `streaming`, `scopeRuns`, `taskProjections`.
  - Each sub-case: write to `sessions[activeId].slice.<field>`, assert top-level `<field>` reads back the same value (mirror invariant); switch active session, assert top-level reads from the new active session's slice.

Done when:

- All four contract tests above pass.
- `useAgent.ts` LOC has dropped or its ownership areas are extracted into named sub-modules with stable interfaces.
- A reviewer can change one ownership area's internals without touching consumer files (proven by a sample diff).

## 8. Phase W5 - Live Ready dogfood checklist

Goal: prove app-visible behavior after the structural changes.

Minimum checklist:

1. Start Ready with isolated user data.
2. Open Browser, Document, RSS, Calendar, and Agent panel.
3. Create/switch agent sessions, hit the 3-session cap, wait for completion toast, click back into completed session.
4. Toggle sidebar/chat panel and switch modes, including a BrowserView mode transition.
5. Open a real document and verify document split/freeze behavior is not visibly broken.
6. Record any UI issue as either a W3 shell item, W4 agent item, or separate bug.

Evidence format split into run-level metadata (once per dogfood session) and item-level evidence (per checklist item):

**Run-level metadata** (`docs/superpowers/audits/2026-05-22-stage-w-closeout/dogfood/RUN-META.md`, written once):

- **Build info**: Ready version, `git rev-parse HEAD`, OS, Electron / Node from `verify:native` output.
- **User data dir**: explicit path used for isolation, so the run is repeatable.
- **Session start time** and **session end time** (covers the log time-window for all items).
- **Operator** (who ran the dogfood).

**Item-level evidence** (per numbered checklist item, files under `dogfood/items/<item-id>/`):

- **Pass/Fail line**: one line in `dogfood/REPORT.md` per numbered item with explicit outcome.
- **Screenshot or short screencap** (required for Pass and Fail): `dogfood/items/<item-id>/evidence.{png,mov}`.
- **Log path** (required only when the item asserts a runtime event, e.g., session lifecycle, BrowserView mode switch, completion toast): name the canonical log (`/tmp/ready-directchat.log`, `ready-tools.log`, `ready-browser.log`) and the time window within the run.
- **Defect ticket reference** (required only when Fail): link to either a W3 / W4 follow-up item created in this roadmap or a new GitHub-style issue file under `docs/superpowers/audits/2026-05-22-stage-w-closeout/issues/`.

Pass condition for the phase:

- Every checklist item has Pass or Fail logged with the above evidence.
- Every Fail has a tracking reference; **no Fail may exit W5 without a successor**.

Done when:

- The live app either passes the checklist or the failures are promoted to explicit roadmap entries.
- The dogfood report is one self-contained directory linkable from Stage W closeout.

## 9. Phase W6 - Release gate reconciliation

Goal: make verification scripts tell one story.

Note: the **gate taxonomy v0** is published in W0 so W1 can use it; W6 takes v0 and formalizes / reconciles it with the actual `package.json` and any CI artifacts.

Current shape:

- Top-level `npm run verify` is slim and mostly green by component.
- Historical `verify:a0` through `verify:t` still exist and many still include `lint:check`.
- `verify:cloud`, calendar, and phase-smoke checks have different scopes.

Deliverables:

1. Gate taxonomy v1: merge, manual deep, release-only, debt.
2. A cross-reference table under `docs/superpowers/operations/verify-gate-taxonomy.md` mapping every `verify:*` script in current `package.json` to one taxonomy bucket, with a one-line rationale. Any script that does not map gets either renamed, removed, or labeled `archive`.
3. If CI exists for this branch, align labels/env behavior with the taxonomy.
4. A diff of `package.json` `scripts` before/after W6 with rationale per change.

Done when:

- Future agents do not accidentally treat every historical stage verify as a current merge gate (testable: a reviewer can name the bucket of any `verify:*` script in under 10 seconds by reading the cross-reference table).
- W0's v0 taxonomy is either confirmed as v1 or explicitly amended with reason.

## 10. Recommended order

1. W0 first, because it freezes the meaning of the current branch.
2. W1 second, because red lint blocks clean review and hides later regressions.
3. W2 third, because warning debt needs a ledger after errors are gone.
4. W3 and W4 can be planned in parallel after W1 is green.
5. W5 should run after the first W3/W4 implementation batch, or earlier if a visible regression is suspected.
6. W6 can be done alongside W0/W1, but should not churn scripts until W1 is green.

## 11. First implementation plan to write

Write this first:

`2026-05-22-W1-lint-errors-and-baseline-drift-implementation.md`

It should include:

- exact 25 lint errors grouped by rule,
- exact 19 new / 16 stale baseline entries,
- replacement strategy for each source-grep error,
- tests to run after each batch,
- a hard rule that warning cleanup is out of scope.
