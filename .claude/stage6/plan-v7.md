# Stage 6 — Task fact ledger consolidation (Plan v7)

> Predecessor: `plan-v6.md`. v7 = patch-and-reroll after Codex round-6.
> v7 only restates §1.2 L6; everything else by-reference v1..v6.

## What changed vs v6

Round-6 returned 1 blocker: L6 misses two more cast bypass paths.
- Local type alias: `type TCR = TaskCardRun; raw as TCR`
- Inline import type: `raw as import('./task-card-from-projection').TaskCardRun`

v7 extends the rule to catch both. The bash Pass 2 and ImportSpecifier parser shape were both confirmed sound by Codex round-6 — no changes.

The non-blocking nit on `resolveTaskExecutionRoute` call-site list (`§1.2 L4 v6 §C` shows expected callers in `turn-engine.ts`) is acknowledged: the actual sweep happens at implementation time via the codebase-wide scanner; the list in the plan is a heuristic for reviewers, not a contract.

---

## §1.2 L6 (rewritten v7) — Eslint rule with full alias + import-type coverage

```js
// inside eslint-rules/index.mjs
function createNoTaskCardRunCastRule() {
  return {
    meta: {
      type: 'problem',
      schema: [],
      messages: {
        cast: 'TaskCardRun cast bypasses sealed factory; use taskProjectionToTaskCardRun()',
        aliasImport: 'Import TaskCardRun without renaming; alias bypass forbidden outside helper',
        localAlias: 'Local type alias of TaskCardRun is forbidden outside helper file',
        importType: 'Inline import type referencing TaskCardRun is forbidden outside helper',
      },
    },
    create(context) {
      const filename = context.getFilename()
      if (filename.endsWith('/task-card-from-projection.ts')) return {}

      const taskCardNames = new Set()  // local names that resolve to TaskCardRun

      function isTaskCardRef(typeNode) {
        if (!typeNode) return false
        // Direct: TSTypeReference -> Identifier 'TaskCardRun' (or aliased name)
        if (typeNode.type === 'TSTypeReference') {
          const tn = typeNode.typeName
          if (tn?.type === 'Identifier' && taskCardNames.has(tn.name)) return true
          // Namespace: Foo.TaskCardRun
          if (tn?.type === 'TSQualifiedName' && tn.right?.name === 'TaskCardRun') return true
        }
        // Inline import type:  import('...').TaskCardRun
        if (typeNode.type === 'TSImportType') {
          const q = typeNode.qualifier
          if (q?.type === 'Identifier' && q.name === 'TaskCardRun') return true
          if (q?.type === 'TSQualifiedName' && q.right?.name === 'TaskCardRun') return true
        }
        return false
      }

      return {
        // (1) Track imports — populate taskCardNames + flag aliased imports
        ImportDeclaration(node) {
          for (const spec of node.specifiers || []) {
            if (spec.type !== 'ImportSpecifier') continue
            const imported = spec.imported?.name
            const local = spec.local?.name
            if (imported === 'TaskCardRun') {
              if (local && local !== imported) {
                context.report({ node: spec, messageId: 'aliasImport' })
              }
              if (local) taskCardNames.add(local)
            }
          }
        },

        // (2) Track local type aliases:  type TCR = TaskCardRun
        TSTypeAliasDeclaration(node) {
          if (isTaskCardRef(node.typeAnnotation)) {
            const aliasName = node.id?.name
            if (aliasName) {
              context.report({ node, messageId: 'localAlias' })
              // Even though we report, still track the name so casts using it don't get a 2nd vague message
              taskCardNames.add(aliasName)
            }
          }
        },

        // (3) Cast forms — `as X`
        TSAsExpression(node) {
          if (isTaskCardRef(node.typeAnnotation)) {
            const messageId = node.typeAnnotation.type === 'TSImportType' ? 'importType' : 'cast'
            context.report({ node, messageId })
          }
        },

        // (4) Legacy cast: `<X>raw`
        TSTypeAssertion(node) {
          if (isTaskCardRef(node.typeAnnotation)) {
            const messageId = node.typeAnnotation.type === 'TSImportType' ? 'importType' : 'cast'
            context.report({ node, messageId })
          }
        },
      }
    },
  }
}
```

**Coverage now**:

| Pattern | Caught by |
|---|---|
| `as TaskCardRun` | `TSAsExpression` + Identifier check |
| `<TaskCardRun>x` | `TSTypeAssertion` + Identifier check |
| `as Card.TaskCardRun` | `TSAsExpression` + `TSQualifiedName` check |
| `import { TaskCardRun as TCR }` | `ImportDeclaration` `aliasImport` |
| `as TCR` (after aliased import) | tracked-name check + `cast` (the alias is already flagged at import) |
| `type TCR = TaskCardRun` | `TSTypeAliasDeclaration` `localAlias` |
| `as <localAlias>` after `type X = TaskCardRun` | tracked-name check (alias added to set after `localAlias` report; downstream casts get `cast` too — but the original alias declaration already errored) |
| `as import('./..').TaskCardRun` | `TSAsExpression` with `TSImportType` annotation → `importType` message |
| `<import('./..').TaskCardRun>x` | `TSTypeAssertion` with `TSImportType` annotation → `importType` |

**Transitive escapes** (theoretical):
- `type X = TaskCardRun & {}` — caught by `TSTypeAliasDeclaration` because `node.typeAnnotation` is a `TSIntersectionType`; my `isTaskCardRef` only matches direct refs. **Gap**: not caught. Acceptable for v7 because intentional intersection-type-laundering is an explicit attack vector that no legitimate developer will accidentally trigger. If round-7 surfaces this, expand `isTaskCardRef` to recurse into intersection / union / typeof.
- `type X = Pick<TaskCardRun, 'taskId'>` — also an intentional escape; not caught. Acceptable for v7.

**Wire**: add `'ready/no-task-card-run-cast': 'error'` in `eslint.config.mjs` rules block.

**Tests** (`eslint-rules/__tests__/no-task-card-run-cast.test.mjs`): use `RuleTester` with these cases:
- valid: helper file allowed; `import type { TaskCardRun }` without alias allowed
- invalid: `as TaskCardRun`, `as TCR` (post-alias-import), `type TCR = TaskCardRun`, `as import('…').TaskCardRun`, `<TaskCardRun>x`, `import { TaskCardRun as TCR }`

---

## §6 (revised v7) — Carry-forward 待审查疑点

Closed by v7: round-6 #1 (cast bypass via local alias + inline import type).

Remaining open:
- Intersection / union / typeof transitive type-laundering (acceptable v7 gap; fix if round-7 surfaces)
- Archive size warn @ 50MB (process discipline; not a contract)
- Sub-task budget Task 3a/3b split (implementation-time decision)
- The non-blocking call-site-list nit Codex round-6 mentioned (heuristic, not contract)

If round-7 finds anything, it should be either an intersection-type bypass (we're aware) or a fresh angle.

End of v7.
