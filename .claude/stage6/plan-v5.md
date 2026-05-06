# Stage 6 — Task fact ledger consolidation (Plan v5)

> Predecessor: `plan-v4.md`. v5 = patch-and-reroll after Codex round-4 review.
> v5 only restates sections that changed; everything else by-reference v1..v4.

## What changed vs v4

Round-4 returned 4 narrow findings. All valid. v5 fixes each.

---

## §0.3 (rewritten v5) — Archive script with content-aware fail-safe

The v4 script required tracked patch to be non-empty even when a worktree had only untracked changes. v5 makes the requirement **content-conditional**: a patch is only required to be non-empty if `git diff HEAD --quiet` returns non-zero (i.e. tracked diff exists). Likewise the tar requirement only kicks in when untracked files exist. The `git status … || true` is removed entirely (a clean exit code is reliable).

```bash
set -euo pipefail
mkdir -p .claude/worktrees/stale-archives
TOMBSTONE=.claude/worktrees/STALE-WORKTREES-20260506.md
: > "$TOMBSTONE"

archive_failed=0

# Pass 1 — archive
for d in .claude/worktrees/agent-*; do
  name=$(basename "$d")
  echo "=== $name ===" >> "$TOMBSTONE"
  git -C "$d" rev-parse HEAD >> "$TOMBSTONE"
  git -C "$d" log -1 --pretty=%s >> "$TOMBSTONE"

  # Has tracked changes?
  tracked_dirty=0
  if ! git -C "$d" diff --quiet HEAD; then tracked_dirty=1; fi
  if ! git -C "$d" diff --staged --quiet; then tracked_dirty=1; fi

  # Has untracked files?
  untracked_dirty=0
  if [ -n "$(git -C "$d" ls-files --others --exclude-standard)" ]; then untracked_dirty=1; fi

  echo "--- status ---" >> "$TOMBSTONE"
  echo "tracked_dirty=$tracked_dirty untracked_dirty=$untracked_dirty" >> "$TOMBSTONE"
  git -C "$d" status --porcelain --untracked-files=all >> "$TOMBSTONE"

  if [ "$tracked_dirty" = "1" ]; then
    tracked="${PWD}/.claude/worktrees/stale-archives/${name}-tracked.patch"
    git -C "$d" diff --binary HEAD > "$tracked"
    if [ ! -s "$tracked" ]; then echo "FATAL: $tracked empty despite tracked dirty"; archive_failed=1; fi
    echo "tracked_archive=$tracked" >> "$TOMBSTONE"
  fi

  if [ "$untracked_dirty" = "1" ]; then
    untracked="${PWD}/.claude/worktrees/stale-archives/${name}-untracked.tar"
    : > "$untracked"
    while IFS= read -r -d '' f; do
      tar -rf "$untracked" -C "$d" "$f"
    done < <(git -C "$d" ls-files --others --exclude-standard -z)
    if [ ! -s "$untracked" ]; then echo "FATAL: $untracked empty despite untracked dirty"; archive_failed=1; fi
    echo "untracked_archive=$untracked" >> "$TOMBSTONE"
  fi

  if [ "$tracked_dirty" = "0" ] && [ "$untracked_dirty" = "0" ]; then
    echo "(tree clean — no archive needed)" >> "$TOMBSTONE"
  fi
  echo "" >> "$TOMBSTONE"
done

[ "$archive_failed" = "0" ] || { echo "Aborting: archives failed; not unlocking"; exit 1; }

# Pass 2 — verify (re-read tombstone for promised paths and assert their content size)
grep -E "^(tracked_archive|untracked_archive)=" "$TOMBSTONE" | cut -d= -f2 | while read -r p; do
  [ -s "$p" ] || { echo "FATAL: missing/empty $p"; exit 1; }
done

# Pass 3 — unlock
for d in .claude/worktrees/agent-*; do
  git worktree unlock "$d"
done
```

The script is strict (`set -euo pipefail`), no `|| true`, content-conditional non-empty checks, three-pass shape preserved.

---

## §1.2 L4 (rewritten v5) — Full call-site coverage + top-level key extraction

Round-4 correctly observed two `restoreContinuationTaskBudgetRuntime` callers I missed. The full set (verified May 2026):

| File | Line(s) | Call style |
|---|---|---|
| `run-budget-policy.ts` | 323 | declaration |
| `runtime.ts` | 1121-1124 | passes `budget` only |
| `task-execution-router.ts` | 123-130 | passes `continuationState` |
| `direct-chat.ts` | 1459-1462, 1483, 1539, 1560 | passes `continuationState` (4 sites) |

**Total: 7 call sites + 1 declaration.** All 7 callers must pass `projectionBudget` (and `projectionBudgetRuntime` where available) after Stage 6.

**Where projection comes from at each site**:

| Site | Projection source |
|---|---|
| `runtime.ts:1121` | already has `target.projection` in scope (line 1122 reads `target.projection?.taskType`); add `projectionBudget: target.projection?.budget ?? null` |
| `task-execution-router.ts:123` | gets `continuationContext.projection.budget ?? null` from the new `continuationContext` param |
| `direct-chat.ts:1459, 1483, 1539, 1560` | each site already has a `projection` variable in scope (verified — `projection.updatedAt` is read nearby); plumb `projectionBudget: projection?.budget ?? null` |

**L4 gate logic** (paren-aware token scanner; same shape as Stage 5 K-gate):

```js
// scripts/check-continuation-context-shape.cjs (sketch)
const CALL_RE = /\brestoreContinuationTaskBudgetRuntime\s*\(/g
// For each match, walk forward with paren+brace tracking until matching ')'.
// Inside the call body, find the outermost object literal. Walk its top-level keys.
// Required keys present: 'projectionBudget' (depth-1 only — nested objects don't count).
// If missing → violation.
```

The "depth-1 only" requirement avoids the round-4 #3 false-pass: a nested `{ projectionBudget: ... }` inside a different sub-key would satisfy a naive `.includes` check.

A unit test under `scripts/__tests__/check-continuation-context-shape.test.cjs` exercises:
- (1) call with top-level `projectionBudget:` → pass
- (2) call without it → fail
- (3) call with nested `someKey: { projectionBudget: ... }` only → fail (false-pass guard)
- (4) multiline call across 5 lines → pass when top-level key is present

---

## §1.2 L6 (rewritten v5) — Brand + lint rule + AST cast forbid

Round-4 correctly observed that `return { taskId, scopeId } as TaskCardRun` bypasses the brand. The fix: pair the type-level brand with an **eslint custom rule** that forbids `as TaskCardRun` (and `<TaskCardRun>x` legacy cast syntax) outside the helper file.

**New eslint rule**: `eslint-rules/no-task-card-run-cast.js`

```js
module.exports = {
  meta: { type: 'problem', schema: [], messages: { cast: 'TaskCardRun cast bypasses sealed factory; use taskProjectionToTaskCardRun()' } },
  create(context) {
    const filename = context.getFilename()
    const isHelperFile = filename.endsWith('/task-card-from-projection.ts')
    if (isHelperFile) return {}  // helper file is allowed
    return {
      TSAsExpression(node) {
        if (node.typeAnnotation?.typeName?.name === 'TaskCardRun') {
          context.report({ node, messageId: 'cast' })
        }
      },
      TSTypeAssertion(node) {
        if (node.typeAnnotation?.typeName?.name === 'TaskCardRun') {
          context.report({ node, messageId: 'cast' })
        }
      },
    }
  },
}
```

Wire it in `eslint.config.mjs`. Combined with the existing brand symbol, the only legal way to obtain a `TaskCardRun` is to call `taskProjectionToTaskCardRun()` or `buildPlaceholderProjectionFromActiveChildRun()`. Casts are blocked; spread cannot inject the brand symbol; `satisfies` doesn't bypass the type either (the brand field is structurally required).

**L6 script gate** is reduced to structural assertions (no longer typecheck-as-test):

```
scripts/check-task-card-single-source.cjs (rewritten v5)
```

Checks:
- (a) The constant name `TASK_CARD_BRAND` appears in exactly one file: `task-card-from-projection.ts`.
- (b) Renderer files outside `task-card-from-projection.ts` and `active-child-run-debug.ts` may not import `ActiveChildRunSummaryData` from preload types.
- (c) `activeChildRunToTaskRun` symbol does not exist anywhere (renamed).

The custom eslint rule handles the cast bypass; the script gate handles structural shape; together they form the L6 contract. **No tsconfig juggle needed.**

Unit test `eslint-rules/__tests__/no-task-card-run-cast.test.mjs`: invokes the rule on synthetic AST and asserts violation/non-violation per fixture.

---

## §6 (revised v5) — Carry-forward 待审查疑点

Closed by v5: round-4 #1 (archive content-conditional), #2 (cast forbid via eslint rule), #3 (top-level key extraction + full call-site sweep), #4 (typecheck-as-test dropped in favor of eslint rule + script gate).

Remaining open from v4 §6:

A. Archive size warn @ 50MB — process discipline, not contract; confirmed deferred.
B. L4 paren-aware regex robustness — confirmed feasible (Stage 5 proven pattern + depth-1 enforcement).
C. Sub-task budget — 7 call sites + 1 decl + eslint rule + 4 gates + 5 production-code tasks → ~12–14 files touched across Stage 6 sub-PRs. Within the "≤10 files per task" guidance if Task 3 (continuation plumbing) is split into Task 3a (router/runtime) + Task 3b (direct-chat 4 sites).

D. **(new in v5)** ESLint rule depends on `@typescript-eslint/parser` AST shape; verified this project uses it (`eslint.config.mjs` references `typescript-eslint`). Rule will work as-is. Add a verification step in v5's pre-flight: `node -e "require('./eslint-rules/no-task-card-run-cast').meta.messages.cast"` returns the expected message string.

If round-5 finds anything, it should be a fresh angle — no carry-forward issues remain.

End of v5.
