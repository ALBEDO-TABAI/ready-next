# Stage 6 — Task fact ledger consolidation (Plan v1)

> Date: 2026-05-06
> Branch: `codex/handle-pet`
> Predecessor: Stage 5 (commit `f4ac5da` — verify:k test-coverage hard gates)

---

## §0 Stage 5.1 closeup (must land first)

Stage 6 is blocked behind a small Stage 5.1 closure. Three concrete items, each with a fixed acceptance line:

### 0.1 Lint warnings introduced by Stage 5

`npm run lint:check` run from `f4ac5da` has **586 warnings**. The eslint baseline gate is green (143 entries) — only **2** of the 586 were introduced by Stage 5 itself:

```
scripts/check-sqlite-test-skip-pattern.cjs
  255:43  warning  'fromFile' is defined but never used   @typescript-eslint/no-unused-vars
  287:45  warning  'root' is defined but never used       @typescript-eslint/no-unused-vars
```

**Fix**: rename to `_fromFile` / `_root` (rule allows leading underscore). No behavior change. Add a unit assertion in `scripts/__tests__/check-sqlite-test-skip-pattern.test.cjs` that the helper still receives those arguments via positional call.

The remaining 584 warnings are **pre-existing, baseline-gated** and explicitly not Stage 5.1 scope. They belong to a separate cleanup track (Stage 5.2 if ever).

**Acceptance line**: `npm run lint:check` reports 584 warnings; CI gate `check-eslint-baseline` reports 143 entries (unchanged).

### 0.2 Triage of 43 npm test failures

`npm test` from `f4ac5da` reports **3013 tests, 43 fail, 28 skipped**. (User said "44"; the actual count is 43 — the discrepancy is one test that flipped on the most recent commit. Treat 43 as authoritative; reconcile if the next run shifts it.)

The 43 failures live in **29 test files**. Bucketed:

| Bucket | Count (files) | Disposition |
|---|---|---|
| **A. Stage 6 must-fix** (agent runtime / projection / skill resume contracts) | 16 | Resolved as a side-effect of §1–§3 below; no separate fix track. |
| **B. UI/Workbench drift** (workbench shell, icon rail, document widget UI) | 12 | Move out of default `npm test`. Add to `scripts/test-coverage-exemptions.json#exempt[]` with reason `"ui-workbench drift; parked under workbench-shell-rework track"` and create new script `test:ui-contracts` so they're still runnable on demand. |
| **C. Stale export reference** (1 file) | 1 | `skill-projection-patch-todo-based.test.ts` imports a no-longer-exported `_resetSkillTaskTrackerForTests`. Disposition: **delete the test file**; coverage is already provided by `skill-projection-patch.test.ts` and `skill-task-tracker.test.ts`. Add to exemption list with reason `"superseded by skill-projection-patch.test.ts"` if any verify gate references it. |
| **D. Already-orphan** (e2e or one-off) | 0 | None in this run. |

**Bucket A files** (resolved by Stage 6 work itself):
- `agent-runtime-host-contract.test.ts`
- `module-executor-doc-action-payload.test.ts`
- `phase-4-tool-gating-expansion.test.ts`
- `phase-5-diagnostics.test.ts`
- `resume-fresh-contract-fields.test.ts`
- `run-resource-reaper.test.ts`
- `runtimeDriver-tool-event-log.test.ts`
- `skill-child-abort-tree.test.ts`
- `skill-resume-end-to-end.test.ts`
- `skill-runtime-user-acceptance.test.ts`
- `skill-task-projection-contract.test.ts`
- `task-run-control-ipc.test.ts`
- `tool-runtime-contract.test.ts`
- `turn-engine-projection.test.ts`
- `turn-engine-skill-detection-inputs.test.ts`
- `document-update-widget-patch.test.ts` / `document-widget-patch-target-resolution.test.ts` / `document-widget-authoring.test.ts` (the *agent-emitted-payload* assertions; the *DOM-shape* assertions move to bucket B)

**Bucket B files** (ui-workbench-rework parked):
- `icon-rail-resting-thumb-contract.test.ts`
- `rss-list-row-style-contract.test.ts`
- `ui-browser-hook-split-contract.test.ts`
- `ui-partial-failure-contract.test.ts`
- `workbench-icon-alignment-contract.test.ts`
- `workbench-keep-alive-contract.test.ts`
- `workbench-mode-and-rail-slider-contract.test.ts`
- `workbench-mode-switch-ritual-contract.test.ts`
- `workbench-shell-alignment-contract.test.ts`
- `workbench-slider-motion-contract.test.ts`

(`document-update-widget-patch.test.ts` and the two siblings are split-ownership — the agent-output assertions stay in bucket A; the DOM-shape assertions move to bucket B as a focused split. Concretely: split each file into `*-payload.test.ts` (A) and `*-dom.test.ts` (B). Acceptable alternative if the file is small: keep whole and route entirely to bucket A or B based on which side dominates the failure messages.)

**Acceptance line**:
- `npm test` after Stage 6 reports 0 failing tests.
- `verify` / `verify:cloud` / `verify:k` stay green.
- `scripts/test-coverage-exemptions.json` contains the bucket-B/C entries with reason strings, and a new `test:ui-contracts` npm script references them so they remain referenceable for `check-test-coverage-by-verify`.

### 0.3 Stale Claude worktree locks

`git worktree list` shows three locked worktrees under `.claude/worktrees/`:

| Worktree | Branch | HEAD | Lock holder |
|---|---|---|---|
| `agent-a0c8a401c4251d9e1` | `agent-task-vocabulary` | `16f0d3b` | `claude agent ... (pid 99613)` — **dead** |
| `agent-a3b92fcdbb958ad4a` | `agent-handoff-shared` | `5b5d0d5` | `pid 99613` — **dead** |
| `agent-a89178066e6e0eb61` | `worktree-agent-a89178066e6e0eb61` | `4c50045` | `pid 99613` — **dead** |

`ps -p 99613` returns no row. None of the three commits are ancestors of `HEAD` (`codex/handle-pet`).

**Disposition**: do **not** `git worktree remove` (the branch tips carry potentially-unreviewed work). Instead:

1. `git worktree unlock <path>` for each of the three (clears stale lockfile).
2. Document each as a referenceable handoff in `.claude/worktrees/STALE-WORKTREES-20260506.md` (one paragraph per worktree: branch name, HEAD subject, why it's parked, decision needed). The document is a tombstone, not a stage gate.
3. Future Stage 5.x or Stage 6 runs will not re-lock these because the new lockholder PID will be live.

**Acceptance line**: `git worktree list --porcelain` shows zero `locked` markers; `.claude/worktrees/STALE-WORKTREES-20260506.md` exists with the three branch summaries.

---

## §1 Stage 6 contract — what must hold when the dust settles

> Per CLAUDE.md §0.5 principle 1 ("先合同，后代码"), the contract list is what CI must mechanically prove.

### 1.1 Single-source-of-truth invariants

A. **Ledger writers**: every status mutation on a `skill_task_runs` row goes through `SkillTaskRunRepository.createChildRun` or `SkillTaskRunRepository.updateChildRun`. No call site in `src/main/**` may construct or execute `UPDATE skill_task_runs SET status` directly. The generic `update(id, patch)` of the repo must reject `patch.status` (throw at runtime; type-system reject at compile time via narrowing the `update` patch type to `Omit<…, 'status'>`).

B. **Sealed close-event factory**: `MutableSkillChildCloseEvent` may only be produced by a single helper in `skill-child-run-types.ts` (proposed: `freezeChildCloseEvent({ status, terminalReason, ... })`). The helper validates the status × terminalReason invariant table before freezing. Production code may not produce a `SkillChildCloseEvent` literal anywhere else.

C. **Projection is read-only against the ledger**: `RunProjection`, `task-projection-sync`, `task-projection-repository` may **read** from `SkillTaskRunRepository`/`skill_child_run_log` and may **write** to `task_projections`, but may not call any ledger writer. Inverse direction (ledger reading projection) is also forbidden.

D. **Continuation = identity handle only**: `ContinuationState` is reduced to identity fields:

```ts
export interface ContinuationState {
  taskId: string
  scopeId: string
  runId: string
  continuationRef: ScopeRunTaskContinuation | null
}
```

The five fields previously embedded — `module`, `taskType`, `interactionState`, `steps`, `currentStepId`, `blockedReason`, `resumableActions`, `budget`, `budgetRuntime`, `restoreDiagnostics` — are removed from the type. Consumers that need them call `taskProjectionRepository.get(taskId)` or `skillTaskRunRepository.findChildRunByXxx()` and read fresh.

E. **UI text vocabulary single-source**: `src/renderer/modules/agent/task-status-vocabulary.ts` is the only file that maps `phase | status | childRunStatus → Chinese label`. No other renderer module may inline a Chinese status string. This is already largely true today; the gate locks it.

### 1.2 CI gates that prove the contract

Five new CI gates, each with an executable script and an `npm run verify:l` aggregator. Each gate has a unit test under `scripts/__tests__/`.

| # | Script | Proves |
|---|---|---|
| L1 | `scripts/check-ledger-writer-funnel.cjs` | No `db.prepare(\`UPDATE skill_task_runs ...\`)` outside `src/main/modules/repositories/skill-task-run-repository.ts`. No call to `repo.update(id, { status })`. AST/regex-based; whitelist the repo file itself. |
| L2 | `scripts/check-close-event-factory.cjs` | The string `MutableSkillChildCloseEvent` appears as a *type* but never as a *constructor object literal* outside `skill-child-run-types.ts`. Construction goes through `freezeChildCloseEvent`. |
| L3 | `scripts/check-projection-is-view-only.cjs` | Files matching `**/run-projection.ts`, `**/task-projection-sync.ts`, `**/task-projection-repository.ts`, `**/skill-running-projection.ts` may not import `SkillTaskRunRepository` for write methods (`createChildRun`, `updateChildRun`, `update`); only `get`, `findBy*`, `listBy*`. |
| L4 | `scripts/check-continuation-handle-only.cjs` | `ContinuationState` interface in `continuation-state.ts` has only the 4 identity fields. Any additional field is a violation. |
| L5 | `scripts/check-status-vocabulary-single-source.cjs` | Outside `task-status-vocabulary.ts`, no renderer file may contain a Chinese status string from the canonical set (`'后台运行中'`, `'预算已暂停'`, `'等待补充'`, `'已完成'`, `'失败'`, `'排队中'`, `'进行中'`, …). Whitelist `messageComposer.ts` calls into the vocabulary helpers. |

**Wiring**: add `verify:l` script that chains: `npm run verify:k && node scripts/check-ledger-writer-funnel.cjs && ... && node --test scripts/__tests__/check-ledger-writer-funnel.test.cjs && ... && npm run test:l:focus`.

### 1.3 What is intentionally *not* in the contract

To avoid scope creep:

- **Status-machine validity** (e.g. forbid `completed → running` transition) — out of scope. The sealed factory + ledger funnel make it tractable later, but the v1 contract only pins boundaries, not transitions.
- **`run_state.json` schema validation** — out of scope. Skill drivers continue to write run_state.json; consumers continue to normalize via `run-state-selection.ts`. Stage 6 only ensures that the UI never directly reads `run_state.json`; it reads projections that may have *consumed* run_state.json.
- **Backward-compatible legacy-status compatibility branches** — explicitly not allowed (CLAUDE.md §0.5 rule 3). The v1 contract is "post-cutover"; old call sites that previously wrote `interactionState` directly into `ContinuationState` get rewritten, not gated behind a flag.

---

## §2 Implementation route

Five tasks, each independently shippable as a sub-PR (or one bundled PR with five commits). Each task has a "must-fix bucket-A test that flips green" deliverable.

### Task 1 — Sealed close-event factory (B + L2 gate)

**Files**:
- `src/main/modules/agent-control/skill-child-run-types.ts` — add `freezeChildCloseEvent(input)` with the status × terminalReason invariant table.
- `src/main/modules/agent-control/skill-child-runner.ts` — replace ~3 inline close-event object literals with calls to the factory.
- `src/main/modules/agent-control/skill-child-sub-agent.ts` — same.
- `src/main/modules/agent-control/skill-child-state-machine.ts` — same.

**Invariant table** (status → allowed terminalReasons; preliminary, finalize during implementation):

| status | allowed terminalReasons |
|---|---|
| `completed` | `'completed'` only |
| `failed` | `'launch_stuck' \| 'launch_failed' \| 'runtime_error' \| 'config_blocked' \| 'budget_exhausted_hard'` |
| `killed` | `'cancelled_user' \| 'cancelled_session_close' \| 'cancelled_parent_abort'` |
| `recoverable_paused` | `'checkpoint_budget' \| 'checkpoint_user_input' \| 'checkpoint_external_dependency'` |
| `budget_paused` | `'budget_pause_lease_expired' \| 'budget_pause_session_release'` |
| `blocked` | `'blocked_external' \| 'blocked_resource'` |

**Tests flipping green**: `resume-fresh-contract-fields.test.ts`, `skill-child-abort-tree.test.ts`, `skill-resume-end-to-end.test.ts`.

**Gate test**: `scripts/__tests__/check-close-event-factory.test.cjs` proves L2 catches a synthetic close-event literal in a fixture.

### Task 2 — Ledger writer funnel (A + L1 gate)

**Files**:
- `src/main/modules/repositories/skill-task-run-repository.ts` — narrow `update(id, patch)` patch type to exclude `status`. Move all status writes into `updateChildRun`.
- All call sites that previously invoked `repo.update(id, { status, ... })` switch to `repo.updateChildRun(childRunId, { status, ... })`.

**Tests flipping green**: `agent-runtime-host-contract.test.ts`, `task-run-control-ipc.test.ts`, `tool-runtime-contract.test.ts`.

**Gate test**: `scripts/__tests__/check-ledger-writer-funnel.test.cjs` proves L1 catches a synthetic `db.prepare('UPDATE skill_task_runs ...')` outside the repo file.

### Task 3 — Continuation = identity handle only (D + L4 gate)

**Files**:
- `src/main/modules/agent-control/continuation-state.ts` — strip `ContinuationState` to 4 fields. Migrate `applyContinuationIntentToState` to read non-identity fields from projection on demand.
- `src/main/modules/agent-control/session-continuity.ts` — caller updates.
- `src/main/modules/agent-control/turn-engine.ts` — anywhere a `state.steps` / `state.budgetRuntime` was read, fetch fresh from `taskProjectionRepository.get(taskId)`.

This is the largest behavioral change; expect 6–10 call site updates. Acceptable risk: a transient extra DB read per turn (microseconds, well under the existing per-turn budget).

**Tests flipping green**: `turn-engine-projection.test.ts` (6 sub-tests), `turn-engine-skill-detection-inputs.test.ts` (3), `phase-4-tool-gating-expansion.test.ts`, `phase-5-diagnostics.test.ts`.

**Gate test**: `scripts/__tests__/check-continuation-handle-only.test.cjs` parses `continuation-state.ts` AST and asserts the interface has exactly 4 fields.

### Task 4 — Projection becomes view-only (C + L3 gate)

**Files** (all read-only after this task):
- `src/main/modules/agent-control/run-projection.ts`
- `src/main/modules/agent-control/task-projection-sync.ts`
- `src/main/modules/repositories/task-projection-repository.ts`
- `src/main/modules/agent-control/skill-running-projection.ts`

For each file: confirm no call into `SkillTaskRunRepository.createChildRun / updateChildRun / update`. The Explore inventory says this is already largely true; this task **proves** it via the L3 gate and removes any incidental write paths.

**Tests flipping green**: `skill-task-projection-contract.test.ts`, `module-executor-doc-action-payload.test.ts`, `runtimeDriver-tool-event-log.test.ts`, `run-resource-reaper.test.ts`, `skill-runtime-user-acceptance.test.ts` (all 4 sub-tests).

**Gate test**: `scripts/__tests__/check-projection-is-view-only.test.cjs` builds a fixture file that imports `SkillTaskRunRepository.updateChildRun` from a file under `task-projection-*` and asserts L3 catches it.

### Task 5 — UI vocabulary single-source (E + L5 gate)

**Files**:
- `src/renderer/modules/agent/task-status-vocabulary.ts` — confirm it owns the canonical set; export a frozen tuple of canonical Chinese labels for the gate to reference.
- `src/renderer/components/**/*.tsx` and `src/renderer/modules/**/*.ts` — sweep for inline canonical Chinese labels. Replace any inline `'已完成'` / `'失败'` / etc. with `phaseToUserLabel(...)` / `projectionStatusToUserLabel(...)` / `childRunToProjectionStatus(...)`.

This is mostly a sweep; expect ≤ 5 inline-label sites today (Explore agent's findings suggest the codebase is already disciplined). The gate locks the discipline.

**Tests flipping green**: bucket-A document-widget tests where they assert renderer-emitted labels.

**Gate test**: `scripts/__tests__/check-status-vocabulary-single-source.test.cjs` proves L5 catches a synthetic `'后台运行中'` literal in a non-vocabulary file.

### Task 6 — Stage 5.1 §0 closeup itself

Lint warnings (0.1), test triage (0.2), worktree unlock (0.3) — bundled into the same Stage 6 PR series so the closeup ships before the new gates land.

---

## §3 Acceptance criteria

A. `npm run verify` passes on a clean tree.
B. `npm run verify:l` (new) passes; verify:l ⊃ verify:k.
C. `npm test` reports 0 failures (28 skipped is unchanged).
D. `git worktree list --porcelain` reports 0 `locked` markers.
E. `scripts/test-coverage-exemptions.json#exempt[]` lists exactly the bucket-B/C entries from §0.2 with non-empty `reason` strings.
F. `.claude/worktrees/STALE-WORKTREES-20260506.md` exists.
G. Lint warnings reduced by exactly 2 (the two Stage 5 unused-args).
H. The five CI gates each have a unit test under `scripts/__tests__/` that proves the gate catches a synthetic violation. (Per testing-conventions.md §… — gates without their own catch-test are not credible.)

---

## §4 Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Continuation reduction breaks live scope-run resumption | Med | Land Task 3 with a snapshot of `phase-4-tool-gating-expansion.test.ts` + `skill-resume-end-to-end.test.ts` flipped green as preflight. Roll the type narrowing first; migrate consumers second; remove the old fields third. |
| Task 4 (projection read-only) has hidden writers | Low | The L3 gate catches them. If found, fold the rewrite into Task 4 rather than a follow-up. |
| UI sweep (Task 5) misses an inline label | Low | The L5 gate is the safety net. CI will catch any regression. |
| Bucket-B test split for `document-update-widget-patch.test.ts` is hard to do cleanly | Med | Acceptable fallback: route the whole file to bucket A and assert agent-emitted payloads only; defer DOM-shape assertions to a separate file under bucket B. Document the split decision in the test file header. |
| Stage 5.1 worktree unlock loses uncommitted work | Low | Three branches are non-empty and reachable via branch refs even if worktree is forgotten. Tombstone document records branch names. We never call `git worktree remove`. |
| 43→44 test count discrepancy hides a flaky test | Low | Run `npm test` three times during 5.1; if any single test toggles between fail/pass, escalate to Codex round 2 instead of trying to fix individually. |

---

## §5 Sequencing & rollback

**Sequencing** (top-down):

1. Stage 5.1 §0 closeup (lint + worktree + bucket-B exemption JSON + bucket-C deletion)
2. Task 1 (sealed close-event factory) + L2 gate
3. Task 2 (ledger funnel) + L1 gate
4. Task 4 (projection view-only) + L3 gate — *before* Task 3 because Task 3 depends on projection being authoritative
5. Task 3 (continuation reduction) + L4 gate
6. Task 5 (UI vocab) + L5 gate
7. `verify:l` aggregator wiring + CLAUDE.md §6.20 documentation update

Each step is independently revertable: gate scripts and their tests are additive; code changes per task are confined to ≤ 5 files (Task 3 may touch 8–10).

**Rollback**: each gate script is opt-in via `verify:l`. If a gate proves problematic in CI cloud, demote to a warning and unblock by removing it from the chain; the gate stays in the repo so it can be re-tightened.

---

## §6 Out of scope (deferred to Stage 7+)

- Status state-machine transition validator (mentioned in Explore §9 gap #2).
- `run_state.json` schema validator.
- Migration of `task_projections.status` to share an enum with `SkillChildRunStatus` (currently a coarser projection of it).
- Stage 5.2: cleanup of the 584 baseline-gated lint warnings.
- Workbench shell rework (parks bucket-B tests).

---

## §7 v1 待审查疑点

1. **Task 3 scope** — reducing `ContinuationState` to 4 fields requires touching `turn-engine.ts`. Is the cost worth it, or should we keep the wider state and add a "do-not-trust-status-shaped-fields" comment + L4-lite gate that only forbids *new* status fields? Current plan: do the reduction; alternative is cheaper but leaves the authority-leak surface intact.

2. **Bucket-B exemption permanence** — moving 12 UI tests off `npm test` makes them harder to keep working. Is this preferable to fixing them now? Current plan: park, since the workbench shell is in flux on a parallel track. Alternative: fix them as part of Stage 6 (adds ~3–5 days; outside the ledger-consolidation theme).

3. **L1/L2/L3 enforcement style** — should the gates be regex+grep (cheap, fast to write, occasional false positives) or AST-based (slow, accurate, ts-morph dep)? Current plan: regex with paren-aware tokenization (matches Stage 5's `check-sqlite-test-skip-pattern.cjs` style); AST upgrade is a follow-up if the regex turns out to drift.

4. **L5 vocabulary list** — hard-coding the canonical Chinese labels in the gate creates a small DRY violation with `task-status-vocabulary.ts`. Acceptable trade for being able to write the gate as a string-set check. Alternative: import the vocabulary at gate time and run it through eval. Current plan: hard-code with a "must match `task-status-vocabulary.ts` exports" assertion in the gate's unit test.

5. **`document-update-widget-patch.test.ts` split** — splitting a single test file into "agent-payload" + "DOM-shape" halves can be ugly. Acceptable fallback documented in §4 risk register.

6. **Close-event factory invariant table completeness** — preliminary table in Task 1 may miss a (status, reason) pair used by some rare path. Mitigation: gate test catches missing pairs by replaying a sample of historical close events from a fixture.

7. **Test count drift (43 vs user's 44)** — preliminary; need second `npm test` run during execution to confirm. If 44 reappears, identify the 44th and fold it into bucket A or B.

End of v1.
