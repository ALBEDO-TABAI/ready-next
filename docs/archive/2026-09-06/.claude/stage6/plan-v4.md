---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../documentation-inventory.md)。

# Stage 6 — Task fact ledger consolidation (Plan v4)

> Predecessor: `plan-v3.md`. v4 = patch-and-reroll after Codex round-3 review.
> v4 only restates sections that changed; everything else is by-reference v1/v2/v3.

## What changed vs v3

Codex round-3 returned 5 findings (no severity tags but 3 are blockers per Codex's own roll-up). All valid. Each correction below.

---

## §0.3 (rewritten v4) — Worktree closure with strict fail-safe

The v3 script swallowed archive failures (`|| true` on `tar`, no error check on `git diff --binary`, unconditional unlock at the end). v4 makes every step `set -euo pipefail`-strict and refuses to unlock unless every required archive exists on disk and is non-empty.

```bash
set -euo pipefail
mkdir -p .claude/worktrees/stale-archives
TOMBSTONE=.claude/worktrees/STALE-WORKTREES-20260506.md
: > "$TOMBSTONE"

# Pass 1 — archive every dirty worktree. Fail loud if any archive write fails.
for d in .claude/worktrees/agent-*; do
  name=$(basename "$d")
  echo "=== $name ===" >> "$TOMBSTONE"
  git -C "$d" rev-parse HEAD >> "$TOMBSTONE"
  git -C "$d" log -1 --pretty=%s >> "$TOMBSTONE"
  echo "--- status ---" >> "$TOMBSTONE"
  git -C "$d" status --porcelain --untracked-files=all >> "$TOMBSTONE" || true

  if [ -n "$(git -C "$d" status --porcelain --untracked-files=all)" ]; then
    tracked="${PWD}/.claude/worktrees/stale-archives/${name}-tracked.patch"
    untracked="${PWD}/.claude/worktrees/stale-archives/${name}-untracked.tar"

    # tracked patch — fail if write fails or output is empty
    git -C "$d" diff --binary HEAD > "$tracked"
    [ -s "$tracked" ] || { echo "FATAL: $tracked is empty"; exit 1; }

    # untracked tar — fail if any single tar add fails
    : > "$untracked"
    while IFS= read -r -d '' f; do
      tar -rf "$untracked" -C "$d" "$f"
    done < <(git -C "$d" ls-files --others --exclude-standard -z)
    # An empty tar is acceptable only if there were no untracked files
    if [ -n "$(git -C "$d" ls-files --others --exclude-standard)" ]; then
      [ -s "$untracked" ] || { echo "FATAL: $untracked empty but untracked files exist"; exit 1; }
    fi

    echo "--- archives ---" >> "$TOMBSTONE"
    echo "$tracked" >> "$TOMBSTONE"
    echo "$untracked" >> "$TOMBSTONE"
  else
    echo "(tree clean — no archive needed)" >> "$TOMBSTONE"
  fi
  echo "" >> "$TOMBSTONE"
done

# Pass 2 — verify every promised archive exists; only then unlock
for d in .claude/worktrees/agent-*; do
  name=$(basename "$d")
  if [ -n "$(git -C "$d" status --porcelain --untracked-files=all)" ]; then
    [ -s "${PWD}/.claude/worktrees/stale-archives/${name}-tracked.patch" ] || { echo "FATAL: missing tracked archive for $name"; exit 1; }
  fi
done

# Pass 3 — unlock now that archives are durable
for d in .claude/worktrees/agent-*; do
  git worktree unlock "$d"
done
```

Three-pass shape: archive → verify → unlock. Any failure in pass 1 or pass 2 stops execution before any unlock.

### Acceptance line (v4)

- Tombstone exists with all 3 worktree status blocks.
- For each dirty worktree, `${name}-tracked.patch` (non-empty) and `${name}-untracked.tar` (non-empty if untracked files existed) are present under `.claude/worktrees/stale-archives/`.
- `git worktree list --porcelain` shows 0 `locked` markers.
- The script exits with non-zero if any archive failed to write.

---

## §1.1 D (rewritten v4) — Continuation context, with **unified priority**

> v3 had `projection > params > state` in §1.1 D and `projection > state > params` in §2 Task 3. v4 picks **`projection > params > state`** as the canonical order and overrides Task 3.

Reasoning:
- `projection.budget` = freshest persisted ledger truth.
- `params.budget` = caller's explicit current-request seed (planner-supplied).
- `state.budget` = prior continuation's saved budget — by definition older than projection.

Final priority (applied in `restoreContinuationTaskBudgetRuntime`):

```ts
const budget =
  params.projectionBudget          // freshest, just-fetched projection
  ?? params.budget                 // caller's explicit seed for this turn
  ?? params.continuationContext?.state.budget  // legacy fallback
  ?? null
const runtimeBudget =
  params.projectionBudgetRuntime
  ?? params.continuationContext?.state.budgetRuntime
  ?? null
```

`projectionBudget` and `projectionBudgetRuntime` are **required** params (`TaskBudget | null` and `TaskBudgetRuntime | null` — no `?` modifier). Callers are TS-forced to pass them; null is the explicit "I have no projection truth" answer.

### L4 (rewritten v4) — call-site enforcement

```
scripts/check-continuation-context-shape.cjs
```

Checks **both**:
- (a) `restoreContinuationTaskBudgetRuntime` and `resolveTaskExecutionRoute` declarations include `projectionBudget` (or `continuationContext`) as a non-optional named field.
- (b) **Every call site** of `restoreContinuationTaskBudgetRuntime(` and `resolveTaskExecutionRoute(` includes a `projectionBudget:` key (or for the route helper, `continuationContext:` with both subfields). Implementation: paren-aware token scanner (same style as Stage 5's `check-sqlite-test-skip-pattern.cjs`) that walks each call expression and verifies the key set.

Hard gate. Unit test: a fixture call site missing `projectionBudget:` fails the gate.

---

## §2 Task 1 (rewritten v4) — Invariant table corrected

Verified pair sweep (re-checked May 2026 against actual `freezeSkillChildCloseEvent` / `makeCloseEvent` / `makeMappedClose` callers):

| status | allowed terminalReasons | source |
|---|---|---|
| `completed` | `'completed'` | runner:597-598 |
| `failed` | `'tool_not_registered'`, `'nested_child_run_not_supported'`, `'host_unavailable'`, `'persistence_failed'`, `'resume_launch_failed'`, `'failed_skill'`, `'child_process_crashed'`, `'launch_stuck'`, `'input_validation'` | runner: many; sub-agent:74,142,301; mapping:81 |
| `killed` | `'cancelled_user'`, `'process_restarted'` | runner:766-767; mapping:71-78 |
| `recoverable_paused` | `'queued_global_concurrency'`, `'process_restarted'`, `'checkpoint_background'` | runner:399, 1004; default mapping at 2933 |
| `budget_paused` | `'checkpoint_budget'`, `'checkpoint_background'` | sub-agent:91-92; mapping:89-94, 96-101 |
| `blocked` | `'blocked_external'`, `'blocked_config'` | runner:328-329, 1403-1404, 1449-1450; sub-agent:291-292 |

**Changes from v3**:
- **Removed** `recoverable_paused × checkpoint_budget` (not a production pair; was speculative migration safety).
- **Added** `budget_paused × checkpoint_background` (verified at `sub-agent-close-mapping.ts:96-101` — the `state === 'blocked' && terminalReason === 'checkpoint_background'` branch).
- All other rows unchanged from v3 (their evidence held up under re-sweep).

Validator implementation (same as v3):

```ts
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
  ]),
  budget_paused: new Set(['checkpoint_budget', 'checkpoint_background']),
  blocked: new Set(['blocked_external', 'blocked_config']),
}
```

**No** `close_event_invariant_legacy_pair` metric — that suggestion is dropped because the table is now believed authoritative. If a forbidden pair fires in production after Stage 6, that's a real bug, not a legacy sweep.

---

## §1.2 L6 (rewritten v4) — Sealed type via brand

v3's regex/AST debate is resolved by **moving the constraint into the type system**. After Stage 6, `TaskCardRun` carries an opaque brand symbol private to the helper module; non-helper modules cannot construct one even with `satisfies` / spread / typed return.

Concretely:

```ts
// src/renderer/components/agent/task-card-from-projection.ts (new file)
const TASK_CARD_BRAND: unique symbol = Symbol('TaskCardRun')
type TaskCardBrand = typeof TASK_CARD_BRAND

export interface TaskCardRun {
  readonly __brand: TaskCardBrand   // private — no other module can write this
  taskId: string
  scopeId: string
  // ...other fields
}

export function taskProjectionToTaskCardRun(
  projection: TaskProjectionRecordData,
  run: PersistedScopeRunData | null,
): TaskCardRun {
  return {
    __brand: TASK_CARD_BRAND,
    taskId: projection.taskId,
    // ...
  }
}

export function buildPlaceholderProjectionFromActiveChildRun(
  row: ActiveChildRunSummaryData,
  fallbackScopeId: string | null,
): TaskCardRun | null {
  // Single allowed bridge from ActiveChildRunSummaryData → TaskCardRun.
  return /* ... built via taskProjectionToTaskCardRun internals ... */
}
```

The brand symbol is **module-private** (not exported). The only way to obtain a `TaskCardRun` value is to call one of the two exported functions. `satisfies TaskCardRun`, spread literals, typed returns, and typed `useMemo` all fail to typecheck — they cannot produce the `__brand` field because they don't have access to the symbol.

This converts L6 from a regex gate to a **type-system invariant**. A small remaining script gate exists only to enforce the structural rules:

```
scripts/check-task-card-single-source.cjs (rewritten v4)
```

Checks:
- (a) `import type { TaskCardRun }` is allowed from any renderer file (consumers need to type their props/state).
- (b) `import { taskProjectionToTaskCardRun, buildPlaceholderProjectionFromActiveChildRun }` (the two value imports) is allowed from anywhere — but the gate verifies that **no other file** exports a function returning `TaskCardRun`.
- (c) The string `__brand: TASK_CARD_BRAND` appears in exactly one file: `task-card-from-projection.ts`.
- (d) `activeChildRunToTaskRun` symbol does not exist in any renderer file (renamed to debug-only `activeChildRunDebugRow`).

The gate is now a **structural guard** on the module layout, not on object-literal shapes — bypass-resistant.

Unit test: a fixture file that re-exports a function `function foo(): TaskCardRun` (with synthetic `__brand`) does NOT compile in TS — the gate's test simply asserts that a `tsc` run on the fixture fails. (This makes the unit test a typecheck assertion, not a regex assertion.)

---

## §2 Task 6 (rewritten v4) — `agent:taskProjectionsChanged` debounce locked into acceptance

v3 had the 100ms debounce as a "v3 自查疑点". v4 promotes it to acceptance criterion:

### Acceptance line (Task 6 v4)

- IPC channel `agent:taskProjectionsChanged` is emitted by `task-projection-repository.ts` from `create` / `update` / `delete` write paths.
- ChatPanel subscribes and calls `refreshPersistedTaskProjections()` debounced at 100ms (use existing `useDebouncedCallback` helper if it exists, else add one).
- Debounce is asserted by a unit test (fake event burst → single refresh call within 150ms window).

The debounce is now a Stage-6-blocking unit test, not a follow-up.

---

## §6 (revised v4) — Carry-forward 待审查疑点

Closed by v4: 1 (archive fail-safe), 2 (table correctness), 3 (priority unification + L4 call-site check), 5 (L6 sealed brand), 6 (debounce promoted to acceptance).

Remaining open:

A. **§0.3 archive size**: still possible for an untracked tar to grow large (e.g., a worktree containing built artifacts or `.npm` caches). Mitigation already in v3 §6: pre-scan and warn at >50MB. Not a blocker — this is process discipline, not a contract.

B. **L4 paren-aware regex robustness**: same proven pattern as Stage 5 K-gate. Confirmed feasible.

C. **L6 typecheck-as-test cost**: running `tsc` on the L6 fixture adds ~2–5s to `verify:l`. Acceptable given the gate's strength.

D. **Call-site count for `continuationContext` plumbing**: 5 sites in `turn-engine.ts` + 1 in `task-execution-router.ts` + 1 in `run-budget-policy.ts`. Plus tests. ≤ 10 files total — within Stage 6 sub-task budget.

These are all discipline / cost trade-offs, not contract holes. v4 should be APPROVED-AS-IS unless round-4 finds a new structural issue.

End of v4.
