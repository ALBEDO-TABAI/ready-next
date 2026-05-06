# Stage 6 — Task fact ledger consolidation (Plan v3)

> Predecessor: `plan-v2.md`. v3 = patch-and-reroll after Codex round-2 review.
> v3 only restates sections that changed; everything else is by-reference v1/v2.

## What changed vs v2

Codex round-2 returned 3 critical + 3 patch findings. All valid. The corrections require non-trivial design changes (not just text fixes), so each is laid out fully below.

---

## §0.3 (rewritten again) — Stale Claude worktree locks

The v2 dirty-state archive was incomplete: `git diff --binary HEAD` does not include untracked files, the one-liner had an undefined `${name}`, and `/tmp` is not a durable archive location. Corrected procedure:

```bash
mkdir -p .claude/worktrees/stale-archives
TOMBSTONE=.claude/worktrees/STALE-WORKTREES-20260506.md
: > "$TOMBSTONE"

for d in .claude/worktrees/agent-*; do
  name=$(basename "$d")
  echo "=== $name ===" >> "$TOMBSTONE"
  git -C "$d" rev-parse HEAD >> "$TOMBSTONE"
  git -C "$d" log -1 --pretty=%s >> "$TOMBSTONE"
  echo "--- status ---" >> "$TOMBSTONE"
  git -C "$d" status --porcelain --untracked-files=all >> "$TOMBSTONE"
  echo "--- diff stats ---" >> "$TOMBSTONE"
  git -C "$d" diff --stat >> "$TOMBSTONE"
  git -C "$d" diff --staged --stat >> "$TOMBSTONE"

  # If dirty (tracked or untracked), archive both
  if [ -n "$(git -C "$d" status --porcelain --untracked-files=all)" ]; then
    git -C "$d" diff --binary HEAD > ".claude/worktrees/stale-archives/${name}-tracked.patch"
    # Untracked files: archive each preserving relative paths
    git -C "$d" ls-files --others --exclude-standard -z \
      | xargs -0 -I {} tar -rf ".claude/worktrees/stale-archives/${name}-untracked.tar" -C "$d" {} || true
    echo "--- archives ---" >> "$TOMBSTONE"
    echo ".claude/worktrees/stale-archives/${name}-tracked.patch" >> "$TOMBSTONE"
    echo ".claude/worktrees/stale-archives/${name}-untracked.tar" >> "$TOMBSTONE"
  else
    echo "(tree clean — no archive needed)" >> "$TOMBSTONE"
  fi
  echo "" >> "$TOMBSTONE"
done

# Only after all archives exist, unlock
for d in .claude/worktrees/agent-*; do
  git worktree unlock "$d"
done
```

The archives sit under `.claude/worktrees/stale-archives/` (durable, in-repo though .gitignored — see acceptance line H below). Sized for ≤ a few MB total per the worktrees' shape.

### Acceptance line (revised)

- `.claude/worktrees/STALE-WORKTREES-20260506.md` exists with status, diff-stat, and (if dirty) archive-path entries for each of the 3 worktrees.
- For any dirty worktree, `${name}-tracked.patch` and `${name}-untracked.tar` exist under `.claude/worktrees/stale-archives/`.
- `git worktree list --porcelain` shows zero `locked` markers.
- `.claude/worktrees/stale-archives/` is added to `.gitignore` (large binary patches don't belong in git history; the tombstone references them by relative path).

---

## §1.1 D (rewritten) — Continuation-as-handle reframed via API shape

The v2 plan said "callers must remember to look up projection first". Codex round-2 correctly observed that this is *aspirational* — a discipline note, not an enforced contract. Rewritten with **"make-impossible-to-misuse via API shape"**:

`resolveTaskExecutionRoute(...)` is reshaped to require both inputs together:

```ts
// Old (current): one input, callers can pass continuationState alone
export function resolveTaskExecutionRoute(params: {
  continuationState: ContinuationState | null
  // ...
}): TaskExecutionRouteResolution

// New (Stage 6):
export function resolveTaskExecutionRoute(params: {
  continuationContext: {
    state: ContinuationState
    projection: TaskProjectionRecord | null  // null only if explicitly proven absent
  } | null
  // ...
}): TaskExecutionRouteResolution
```

Callers that today pass `{ continuationState }` alone will fail to compile after this rename — a TypeScript-enforced contract. They must either fetch `taskProjectionRepository.get(state.taskId)` (and pass `null` if the row genuinely doesn't exist), or pass `null` for `continuationContext` (no continuation at all).

Similarly, `restoreContinuationTaskBudgetRuntime(...)` (`run-budget-policy.ts:340-342`) gets the priority swap Codex requested:

```ts
// Old: continuationState wins
const budget = continuationState?.budget || params.budget
const runtimeBudget = continuationState?.budgetRuntime || null

// New: explicit projection wins
const projectionBudget = params.projectionBudget || null
const budget = projectionBudget || params.budget || continuationState?.budget
const runtimeBudget = params.projectionBudgetRuntime || continuationState?.budgetRuntime || null
```

`projectionBudget` and `projectionBudgetRuntime` are new explicit params. `TaskProjectionRecord` has only `budget` (`run-contracts.ts:332`), not `budgetRuntime` — so `projectionBudgetRuntime` is supplied by the caller from a separate lookup (e.g. `taskBudgetRuntimeRepository.get(taskId)` if/when it exists; otherwise just `null`).

> Correction over v2: v2 said "swap priority to projection > continuation". The corrected priority is **explicit-projection-input > params.budget > continuationState** — with `projectionBudget` being a *new explicit input*, not the implicit `params.budget`. `TaskProjectionRecord.budget` flows in via `projectionBudget`; legacy `params.budget` (the seed) flows in unchanged.

### Why this fixes Codex's #2 critical

Codex's concern: today `continuationState.budget` wins over `params.budget` even if the caller has fresher truth. After the swap, **explicit projection inputs** (named `projectionBudget` / `projectionBudgetRuntime`) win over both. The TypeScript signature change makes the new inputs visible at every call site, forcing reviewers to think about which truth they're passing.

---

## §1.2 (rewritten gates) — L4 / L6 reshape

L4 and L6 in v2 were regex-based with vague predicates. Reshaped to be **API-shape-enforced + lightweight regex**:

| # | Script | Proves |
|---|---|---|
| L4 | `scripts/check-continuation-context-shape.cjs` | (a) `resolveTaskExecutionRoute(...)` callers pass `continuationContext: { state, projection } | null`. The signature itself is policed by TS; the gate just confirms that the function declaration includes `continuationContext` and that no caller passes the legacy `continuationState:` keyword to it (regex catches the rename slip). (b) `restoreContinuationTaskBudgetRuntime(...)` declaration includes `projectionBudget` and `projectionBudgetRuntime` named params; otherwise gate fails. **Hard gate. No L4-ack escape comments.** (Removes v2's "soft fence" wording.) |
| L6 | `scripts/check-task-card-single-source.cjs` | (a) `TaskCardRun` object literals (`{ taskId, scopeId, ... } as TaskCardRun` or direct `TaskCardRun = {...}`) appear in only one renderer file: `src/renderer/components/agent/task-card-from-projection.ts` (new, see §2 Task 6). (b) `activeChildRunToTaskRun` symbol does not exist outside `src/renderer/components/agent/active-child-run-debug.ts`. **Hard gate.** |

L1, L2, L3, L5 unchanged from v2.

---

## §2 Task 1 (rewritten again) — Sealed close-event factory invariants

Verified production pairs by sweeping `skill-child-runner.ts`, `skill-child-sub-agent.ts`, `skill-child-sub-agent-close-mapping.ts`, `skill-child-state-machine.ts`. The **canonical invariant table**:

| status | allowed terminalReasons (each verified at file:line) |
|---|---|
| `completed` | `'completed'` (runner:597-598) |
| `failed` | `'tool_not_registered'` (runner:294-295, 1060-1061), `'nested_child_run_not_supported'` (runner:310-311), `'host_unavailable'` (runner:383-384), `'persistence_failed'` (runner:443-444, 704-705; sub-agent-close-mapping:81-86), `'resume_launch_failed'` (runner:481-482, 492-493), `'failed_skill'` (sub-agent:74-75, 142-143, 301-302), `'child_process_crashed'` (runner:1123-1124, 1169-1170), `'launch_stuck'` (runner:1203-1204; sub-agent:231-232, sub-agent-close-mapping:65-69), `'input_validation'` (allowed by spec; verify production usage during implementation) |
| `killed` | `'cancelled_user'` (runner:766-767; sub-agent:231-232 mapping), `'process_restarted'` (sub-agent-close-mapping:71-78 when `isParentSessionAbort`) |
| `recoverable_paused` | `'queued_global_concurrency'` (runner:398-399), `'process_restarted'` (runner:1003-1004), `'checkpoint_background'` (default mapping in runner:2918-2935) |
| `budget_paused` | `'checkpoint_budget'` (runner:2929; sub-agent:91-92; sub-agent-close-mapping:89-94) |
| `blocked` | `'blocked_external'` (runner:328-329, 1403-1404, 1449-1450; sub-agent:291-292), `'blocked_config'` (allowed by spec; verify production usage during implementation) |

Pairs that are **explicitly forbidden** by this table (and therefore catchable by `validateCloseInvariant`): `failed × process_restarted`, `failed × cancelled_user`, `killed × failed_skill`, `recoverable_paused × cancelled_user`, etc. These pairs do not appear in current production code; the validator catches new accidental combinations.

`recoverable_paused × checkpoint_budget` is **allowed** because `defaultTerminalReasonForStatus` (runner:2929) returns `checkpoint_budget` for `budget_paused` and tests will rely on the legacy mapping while migration completes. Specifically, the `budget_paused` close events get reclassified via the mapping but during state-machine reconciliation the row may transiently store `recoverable_paused × checkpoint_budget`. After migration this can be tightened in Stage 7. v3 invariant table includes it under `recoverable_paused` for safety; remove in Stage 7 if production logs confirm zero hits.

**Validator implementation**:

```ts
// skill-child-close-event-freeze.ts
const ALLOWED_PAIRS: Record<MutableSkillChildCloseEvent['status'], Set<SkillChildRunTerminalReason>> = {
  completed: new Set(['completed']),
  failed: new Set([
    'tool_not_registered', 'nested_child_run_not_supported', 'host_unavailable',
    'persistence_failed', 'resume_launch_failed', 'failed_skill',
    'child_process_crashed', 'launch_stuck', 'input_validation',
  ]),
  killed: new Set(['cancelled_user', 'process_restarted']),
  recoverable_paused: new Set([
    'queued_global_concurrency', 'process_restarted', 'checkpoint_background',
    'checkpoint_budget',
  ]),
  budget_paused: new Set(['checkpoint_budget']),
  blocked: new Set(['blocked_external', 'blocked_config']),
}

class InvalidCloseEventError extends Error {
  constructor(public readonly status: string, public readonly terminalReason: string) {
    super(`Invalid close event: status=${status} terminalReason=${terminalReason}`)
  }
}

function validateCloseInvariant(
  status: MutableSkillChildCloseEvent['status'],
  terminalReason: SkillChildRunTerminalReason,
): void {
  const allowed = ALLOWED_PAIRS[status]
  if (!allowed?.has(terminalReason)) {
    throw new InvalidCloseEventError(status, terminalReason)
  }
}

export function freezeSkillChildCloseEvent(close: MutableSkillChildCloseEvent): SkillChildCloseEvent {
  validateCloseInvariant(close.status, close.terminalReason)
  return deepFreeze(close)
}
```

**Replay test** (`src/__tests__/skill-child-close-event-invariant.test.ts`): synthesize one close event for every (status, terminalReason) pair in the table above and assert `freezeSkillChildCloseEvent` accepts. Also assert each forbidden pair (a complement set) throws `InvalidCloseEventError`.

---

## §2 Task 3 (rewritten again) — Continuation-context plumbing

Per the §1.1 D rewrite above, the design is now API-shape-enforced. Concrete edits:

1. `src/main/modules/agent-control/continuation-state.ts`:
   - No interface change to `ContinuationState`.
   - **Add** type `ContinuationContext = { state: ContinuationState; projection: TaskProjectionRecord | null }`.
   - Helpers stay pure (no I/O).

2. `src/main/modules/agent-control/turn-engine.ts:1345`:
   - When `request.continuationState` is non-null, also call `await taskProjectionRepository.get(state.taskId)` and assemble `continuationContext = { state, projection }`. Pass `continuationContext` (not `continuationState`) into all downstream calls.
   - Lines 1467, 1533, 1555, 2102 — same update.

3. `src/main/modules/agent-control/task-execution-router.ts:135-144`:
   - Signature changes to accept `continuationContext` (per §1.1 D).
   - Body: read `continuationContext?.projection?.budget` first; fall back to `continuationContext?.state.budget`; final fallback `params.budget`.

4. `src/main/modules/agent-control/run-budget-policy.ts:340-342`:
   - Add new params `projectionBudget?: TaskBudget | null`, `projectionBudgetRuntime?: TaskBudgetRuntime | null`.
   - Priority swap as in §1.1 D.

5. Continuation reads outside this priority chain (`continuationState.steps` / `.budgetRuntime` reads in unrelated modules) are **left alone** — they're not on the routing path. The L4 gate only polices `resolveTaskExecutionRoute` and `restoreContinuationTaskBudgetRuntime` signature shape; broader continuation-state reads are not in Stage 6 scope.

**Tests flipping green** (same as v2): `turn-engine-projection.test.ts`, `turn-engine-skill-detection-inputs.test.ts`, `phase-4-tool-gating-expansion.test.ts`, `phase-5-diagnostics.test.ts`. Plus a new test `task-execution-route-continuation-context.test.ts` that asserts the new signature shape.

---

## §2 Task 6 (rewritten again) — Task-card single-source with refresh path

Codex round-2 #4 correctly observed: removing `activeChildRunToTaskRun` *without* adding a real-time projection refresh path means the user-visible task card lags by up to 2s (the active-child-run poll interval). v2's "loading placeholder during sub-second backfill" is wishful thinking — the renderer has no `taskProjectionsChanged` IPC event today.

**Design**:

1. **Add IPC event `agent:taskProjectionsChanged`** in main process. Emitted by `task-projection-repository.ts` on every `create` / `update` / `delete`. Carries `{ scopeId, taskId, action }` payload — not the record itself, only an invalidation signal.

2. **Renderer subscribes** in ChatPanel (a new `useEffect` parallel to the existing `agent:listActiveChildRuns` polling). On event, call `refreshPersistedTaskProjections()` for the matching `scopeId`. The poll for `activeChildRuns` continues to exist but is **not** used for task-card construction.

3. **Single TaskCardRun construction helper** at `src/renderer/components/agent/task-card-from-projection.ts`:
   ```ts
   export function taskProjectionToTaskCardRun(
     projection: TaskProjectionRecordData,
     run: PersistedScopeRunData | null,
   ): TaskCardRun
   ```
   This is the **only** place a `TaskCardRun` object literal is constructed in the renderer. Gate L6 enforces the constraint.

4. **Move `activeChildRunToTaskRun`** to `src/renderer/components/agent/active-child-run-debug.ts` and **rename** to `activeChildRunDebugRow`. Used only by a developer-facing inspector panel (gated behind `__READY_DEBUG__`-style flag) — not by the user-visible task card.

5. **Fallback for "live child run, no projection yet"**: the renderer renders a transient placeholder card built from a *minimal* projection-shape stub (also via `taskProjectionToTaskCardRun` — the helper accepts `projection` + optional `run`). The stub originates from `activeChildRuns` only when the scope has a matching record but no projection; this is the one allowed bridge, gated behind a named function `buildPlaceholderProjectionFromActiveChildRun`. The L6 gate whitelists this single function call site explicitly by file path + name.

This addresses both Codex's concerns:
- **#4** real-time refresh: `agent:taskProjectionsChanged` event closes the gap.
- **#5 L6 gate**: the gate now polices object-literal construction in one file (cleanly enforceable), not a vague "preceded by variable binding" predicate.

---

## §6 (revised) — v3 待审查疑点

1. **`agent:taskProjectionsChanged` event ordering**: when main process burst-emits the event (e.g. during projection-resync at boot), the renderer can re-fetch many times. Mitigation: debounce to 100ms in the ChatPanel handler. Acceptable trade for not-going-stale; no correctness issue.

2. **Untracked-file archive size in §0.3**: tarballs for the three worktrees are unbounded in principle (could include node_modules subdirs if the worktrees compiled). Mitigation: pre-scan and warn if any `${name}-untracked.tar` would exceed 50 MB; let user decide whether to include or exclude. Add a manual confirmation step.

3. **`recoverable_paused × checkpoint_budget` allowance in Task 1**: kept for migration safety. Should we add a metric `close_event_invariant_legacy_pair` that fires when this pair is observed in production, so we can confidently remove it in Stage 7? Recommended yes — minimal cost, valuable signal.

4. **Replacement `continuationContext` plumbing breadth**: turn-engine has 5 call sites (lines 1345, 1467, 1533, 1555, 2102). Plus `task-execution-router.ts:135-144`. Plus `run-budget-policy.ts`. Total ~8 changed call expressions. Within Stage 6's "≤10 files per task" guidance. Confirm during implementation.

5. **`buildPlaceholderProjectionFromActiveChildRun` is a named exception in L6**: it imports `ActiveChildRunSummaryData` to build a placeholder. Codex round-2's concern was that ChatPanel could synthesize task-card data from active-child-run feed. Allowing a named placeholder-builder is technically a controlled bridge; gate test must verify it's the **only** consumer of `ActiveChildRunSummaryData` in `src/renderer/components/agent/`. Soft risk: if a developer adds a second consumer later, they'd need to also update the gate's allowlist.

6. **Plan size**: v3 is ~5K words across 3 plan files. Codex review iteration cost is rising. If round-3 returns more than 1 critical, reconsider whether to bundle some Stage 6 sub-tasks into a separate Stage 7 (specifically: §2 Task 6 + L6 might be worth a dedicated stage given the renderer-side breadth).

End of v3.
