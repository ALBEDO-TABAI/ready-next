# Stage 6 — Task fact ledger consolidation (Plan v6)

> Predecessor: `plan-v5.md`. v6 = patch-and-reroll after Codex round-5 review.
> v6 only restates sections that changed; everything else by-reference v1..v5.

## What changed vs v5

Round-5 returned 4 narrow new findings. All valid. v6 fixes each.

---

## §0.3 (rewritten v6) — Archive script Pass 2 with `while read`

The v5 Pass 2 used `grep | cut | while` to walk the tombstone for archive paths. Under `set -euo pipefail`, an all-clean run produces no `tracked_archive=` / `untracked_archive=` lines, `grep` exits non-zero, and the pipeline aborts before unlock. v6 replaces it with `while read … case`:

```bash
# (Pass 1 unchanged from v5)

# Pass 2 — verify (no grep pipeline; safe under set -e on empty matches)
while IFS= read -r line; do
  case "$line" in
    tracked_archive=*|untracked_archive=*)
      p="${line#*=}"
      [ -s "$p" ] || { echo "FATAL: missing/empty $p"; exit 1; }
      ;;
  esac
done < "$TOMBSTONE"

# Pass 3 — unlock (unchanged)
```

`while read` does not inherit the no-match exit-code surprise. The `case` arms only fire on archive lines; everything else is silently passed.

---

## §1.2 L4 (rewritten v6) — Both functions gated, declarations + call sites

v5's text only sketched the `restoreContinuationTaskBudgetRuntime` half. v6 explicitly carries forward v4's `resolveTaskExecutionRoute` half too. Single gate, two functions:

```
scripts/check-continuation-context-shape.cjs (v6)
```

Checks:

**A. Declarations**:
- `resolveTaskExecutionRoute` declaration in `task-execution-router.ts` includes named field `continuationContext`. The field type is required (no `?`).
- `restoreContinuationTaskBudgetRuntime` declaration in `run-budget-policy.ts` includes named fields `projectionBudget` and `projectionBudgetRuntime`. Both required.

**B. Call sites** (paren-aware token scanner, depth-1 key extraction):
- Every call to `resolveTaskExecutionRoute(` in the codebase contains a top-level `continuationContext:` key.
- Every call to `restoreContinuationTaskBudgetRuntime(` contains a top-level `projectionBudget:` key.
- "Top-level" = depth-1 in the immediately-following object literal; nested keys do not satisfy.

**C. Full call-site sweep** (verified May 2026):

| Function | Call sites |
|---|---|
| `resolveTaskExecutionRoute` | (sweep at implementation time; expected callers in `turn-engine.ts` 1345, 1467, 1533, 1555, 2102) |
| `restoreContinuationTaskBudgetRuntime` | `runtime.ts:1121`, `task-execution-router.ts:123`, `direct-chat.ts:1459, 1483, 1539, 1560` |

Hard gate. Unit tests (4 fixtures): valid call → pass; missing key → fail; nested-only key → fail; multiline call → pass.

---

## §1.2 L6 (rewritten v6) — Eslint rule packaged in existing plugin shape, alias-aware

Two corrections vs v5:

**Packaging**: the project is `"type": "module"` and existing eslint rules live in `eslint-rules/index.mjs` exported as `{ rules }`. v6 adds the new rule **inside that file** as `createNoTaskCardRunCastRule()` factory. No separate `.js` file. No `module.exports` / `require`.

```js
// added inside eslint-rules/index.mjs
function createNoTaskCardRunCastRule() {
  return {
    meta: {
      type: 'problem',
      schema: [],
      messages: {
        cast: 'TaskCardRun cast bypasses the sealed factory; use taskProjectionToTaskCardRun()',
        aliasImport: 'Import TaskCardRun without alias (no `as X` rename allowed outside the helper file)',
      },
    },
    create(context) {
      const filename = context.getFilename()
      const isHelperFile = filename.endsWith('/task-card-from-projection.ts')
      if (isHelperFile) return {}

      // Track local names that resolve to TaskCardRun (direct or aliased imports).
      const localTaskCardRunNames = new Set()

      return {
        ImportDeclaration(node) {
          for (const spec of node.specifiers || []) {
            if (spec.type !== 'ImportSpecifier') continue
            const importedName = spec.imported?.name
            const localName = spec.local?.name
            if (importedName === 'TaskCardRun') {
              if (localName !== importedName) {
                // alias import — forbidden outside helper file
                context.report({ node: spec, messageId: 'aliasImport' })
              }
              if (localName) localTaskCardRunNames.add(localName)
            }
          }
        },
        TSAsExpression(node) {
          const t = node.typeAnnotation
          // Direct: `as TaskCardRun`
          if (t?.type === 'TSTypeReference' && t.typeName?.type === 'Identifier'
              && localTaskCardRunNames.has(t.typeName.name)) {
            context.report({ node, messageId: 'cast' })
            return
          }
          // Namespace: `as Card.TaskCardRun` — also forbidden
          if (t?.type === 'TSTypeReference' && t.typeName?.type === 'TSQualifiedName'
              && t.typeName.right?.name === 'TaskCardRun') {
            context.report({ node, messageId: 'cast' })
          }
        },
        TSTypeAssertion(node) {
          const t = node.typeAnnotation
          if (t?.type === 'TSTypeReference' && t.typeName?.type === 'Identifier'
              && localTaskCardRunNames.has(t.typeName.name)) {
            context.report({ node, messageId: 'cast' })
            return
          }
          if (t?.type === 'TSTypeReference' && t.typeName?.type === 'TSQualifiedName'
              && t.typeName.right?.name === 'TaskCardRun') {
            context.report({ node, messageId: 'cast' })
          }
        },
      }
    },
  }
}

// in `rules`:
//   'no-task-card-run-cast': createNoTaskCardRunCastRule(),
```

**Alias coverage**: by tracking imports with `localTaskCardRunNames`, the rule catches `as TCR` when `TCR` was imported as `TaskCardRun as TCR` — but the alias import itself is also flagged (`aliasImport` message). So the only legal way to type-mention `TaskCardRun` outside the helper is `import type { TaskCardRun }` *without* alias. Namespace imports like `as Card.TaskCardRun` are caught by walking `TSQualifiedName.right`.

**Wire**: add `'ready/no-task-card-run-cast': 'error'` to `eslint.config.mjs` rules. Test under `eslint-rules/__tests__/no-task-card-run-cast.test.mjs` (existing test pattern; uses `RuleTester` from `eslint`).

**L6 script gate** (`scripts/check-task-card-single-source.cjs`) is unchanged from v5: structural assertions for symbol layout (`TASK_CARD_BRAND` location, `ActiveChildRunSummaryData` import scope, `activeChildRunToTaskRun` removal). The eslint rule covers the cast-bypass surface; the script gate covers the structural surface. Together they form the L6 contract.

---

## §6 (revised v6) — Carry-forward 待审查疑点

Closed by v6:
- round-5 #1 (Pass 2 grep no-match): replaced with `while read … case`
- round-5 #2 (alias bypass): rule now tracks `localTaskCardRunNames` from imports and forbids `as <alias>` plus aliased imports
- round-5 #3 (rule packaging): rule lives inside `eslint-rules/index.mjs`, ESM, factory pattern, wired in `eslint.config.mjs`
- round-5 #4 (L4 carry-forward): both functions gated explicitly; declarations + call sites

Remaining open: same as v5 §6 — archive size warn @ 50MB (process discipline), sub-task budget split (Task 3a/3b). No new contract holes.

If round-6 finds anything, expectation is a fresh angle. The plan body is now fully consistent with the codebase's existing eslint/script gate patterns.

End of v6.
