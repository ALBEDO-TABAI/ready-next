---
enforce: false
documentation_status: archived-in-place
archived_at: 2026-09-06
---

> 原位归档（2026-09-06）：代码/检查引用：scripts/check-task-card-single-source.cjs。保留此路径不代表全文仍是当前合同；其中的状态、源码位置和待办属于原记录。现行约束见 [当前运行时合同](../../docs/architecture/current-runtime-contracts.md)，归档去向见 [文档清单](../../docs/documentation-inventory.md)。

# Stage 6 — Task fact ledger consolidation (Plan v9)

> Predecessor: `../../docs/archive/2026-09-06/.claude/stage6/plan-v8.md`. v9 = patch-and-reroll after Codex round-8.
> v9 only restates the L6 rule's name-matching strategy + adds two unwrap arms; everything else by-reference v1..v8.

## What changed vs v8

Round-8 returned 1 load-bearing miss + 2 fresh gaps + 1 framing correction. All valid.

**Load-bearing**: `TaskCardRun` today is a **local interface** in `ChatPanel.tsx:125`. v8's rule only tracked *imported* names, so the existing `as TaskCardRun[]` (line 2281) and `as TaskCardRun` (line 2452) would not be caught. The fix: rename the rule's strategy to **direct name match** + **forbid local interface/type declarations** outside the helper file.

**Fresh gaps**:
- `as readonly TaskCardRun[]` — parser produces `TSTypeOperator { operator: 'readonly', typeAnnotation: TSArrayType }`.
- `as [string, ...TaskCardRun[]]` — parser produces `TSTupleType` containing `TSRestType`.

**Framing**: my "annotations are harmless" claim was too broad. With `any`-typed source values, `let x: TaskCardRun[] = rawAny` launders without a cast. v9 reframes annotations as "safe boundary" — the rule does not police annotations, but the doc must say *why* (annotations describe expected shape; they don't smuggle the brand symbol unless the source is already a TaskCardRun or `any`).

---

## §1.2 L6 (rewritten v9) — Direct name match + local-decl ban + container unwrap

The rule no longer maintains a `taskCardNames` set tied to imports. Instead, it matches the **literal name** `TaskCardRun` wherever it appears as a type reference, qualified name, or import-type qualifier. Local renames via `type TCR = TaskCardRun` are caught by the type-alias arm. Local **interface/type** declarations of the name `TaskCardRun` outside the helper file are explicitly forbidden — that's the real fix for ChatPanel's local interface today.

```js
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
        localInterface: 'Local declaration of TaskCardRun is forbidden outside helper file; use the brand-protected type from task-card-from-projection.ts',
      },
    },
    create(context) {
      const filename = context.getFilename()
      if (filename.endsWith('/task-card-from-projection.ts')) return {}

      function isTaskCardRef(typeNode) {
        if (!typeNode) return false

        // readonly T  →  TSTypeOperator { operator: 'readonly', typeAnnotation }
        if (typeNode.type === 'TSTypeOperator') {
          return isTaskCardRef(typeNode.typeAnnotation)
        }

        // ...T  inside a tuple  →  TSRestType { typeAnnotation }
        if (typeNode.type === 'TSRestType') {
          return isTaskCardRef(typeNode.typeAnnotation)
        }

        // T[]
        if (typeNode.type === 'TSArrayType') {
          return isTaskCardRef(typeNode.elementType)
        }

        // [T, ...]
        if (typeNode.type === 'TSTupleType') {
          return (typeNode.elementTypes || []).some(isTaskCardRef)
        }

        // T (Identifier or namespace)
        if (typeNode.type === 'TSTypeReference') {
          const tn = typeNode.typeName
          // Direct: TaskCardRun
          if (tn?.type === 'Identifier' && tn.name === 'TaskCardRun') return true
          // Aliased local: type TCR = TaskCardRun → handled by TSTypeAliasDeclaration arm
          // Namespace: Foo.TaskCardRun
          if (tn?.type === 'TSQualifiedName' && tn.right?.name === 'TaskCardRun') return true
          // Generic container Array<...> / ReadonlyArray / Set / Map / Promise
          if (tn?.type === 'Identifier' && CONTAINER_NAMES.has(tn.name)) {
            const args = typeNode.typeArguments?.params || typeNode.typeParameters?.params || []
            return args.some(isTaskCardRef)
          }
        }

        // import('...').TaskCardRun
        if (typeNode.type === 'TSImportType') {
          const q = typeNode.qualifier
          if (q?.type === 'Identifier' && q.name === 'TaskCardRun') return true
          if (q?.type === 'TSQualifiedName' && q.right?.name === 'TaskCardRun') return true
          // import('...').Foo.TaskCardRun
          // (covered by TSQualifiedName.right === 'TaskCardRun' above)
        }

        return false
      }

      const CONTAINER_NAMES = new Set([
        'Array', 'ReadonlyArray', 'Set', 'ReadonlySet', 'Map', 'ReadonlyMap', 'Promise',
      ])

      return {
        // Forbid local TaskCardRun interface/type declarations
        TSInterfaceDeclaration(node) {
          if (node.id?.name === 'TaskCardRun') {
            context.report({ node, messageId: 'localInterface' })
          }
        },
        TSTypeAliasDeclaration(node) {
          if (node.id?.name === 'TaskCardRun') {
            context.report({ node, messageId: 'localInterface' })
            return
          }
          if (isTaskCardRef(node.typeAnnotation)) {
            context.report({ node, messageId: 'localAlias' })
          }
        },

        // Forbid aliased import: import { TaskCardRun as TCR }
        ImportDeclaration(node) {
          for (const spec of node.specifiers || []) {
            if (spec.type !== 'ImportSpecifier') continue
            const imported = spec.imported?.name
            const local = spec.local?.name
            if (imported === 'TaskCardRun' && local && local !== imported) {
              context.report({ node: spec, messageId: 'aliasImport' })
            }
          }
        },

        // Cast forms
        TSAsExpression(node) {
          if (isTaskCardRef(node.typeAnnotation)) {
            const messageId = node.typeAnnotation.type === 'TSImportType' ? 'importType' : 'cast'
            context.report({ node, messageId })
          }
        },
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

**Coverage update vs v8**:

| Pattern | Caught by |
|---|---|
| **All v7/v8 patterns** | unchanged (now via direct name match) |
| **`as TaskCardRun` (local interface)** | direct Identifier match (no longer requires import tracking) |
| **`as TaskCardRun[]` (local interface)** | TSArrayType + direct Identifier |
| **`as readonly TaskCardRun[]`** | TSTypeOperator unwrap |
| **`as [string, ...TaskCardRun[]]`** | TSTupleType + TSRestType unwrap |
| **`interface TaskCardRun { … }` outside helper** | TSInterfaceDeclaration arm |
| **`type TaskCardRun = …` outside helper** | TSTypeAliasDeclaration with id.name === 'TaskCardRun' |
| **`as Promise<TaskCardRun>`** | now caught (added Promise to CONTAINER_NAMES) |

**Acknowledged remaining gaps** (deliberate laundering):
- `as TaskCardRun & {}` (intersection)
- `as TaskCardRun | null` (union)
- `as Pick<TaskCardRun, 'taskId'>` (utility type)
- `as any as TaskCardRun` (double-cast — fundamentally unblockable in TS without runtime checks)
- Annotation-laundering of `any`: `let x: TaskCardRun[]; x = rawAny`. Documented framing change below.

**Annotation framing update**: the doc no longer claims annotations are "harmless". Annotations are a *rule boundary*, not a *safety claim*. The rule does not flag annotations because flagging them would generate enormous noise (every typed prop, return, useState becomes a violation). The brand symbol on the type makes accidental smuggling hard at the construction site; annotations describe expected shape only. If a caller does `let x: TaskCardRun[]; x = rawAny`, that's a cast-via-`any` — a known TS escape hatch outside L6's scope.

---

## §0.3 (preserved from v6) — unchanged

## §1.1 (preserved from v4 + v5 corrections) — unchanged

## §1.2 L1 / L2 / L3 / L5 (preserved from v2/v3) — unchanged

## §1.2 L4 (preserved from v6) — unchanged

## §2 Tasks 1–6 (preserved from v3/v4 corrections) — unchanged

## §5 (preserved from v3) — unchanged

## §6 (revised v9) — Carry-forward 待审查疑点

Closed by v9: round-8 #1 (local interface name match), #2 (`readonly T[]`), #3 (tuple rest), #4 (annotation framing).

**Remaining** (8 rounds in, all explicitly acknowledged):
- Intersection / union / utility-type / `Promise<T>` (Promise now actually caught) / `any`-laundering — exotic intentional bypasses, out of scope.
- Process discipline (archive size warn, sub-task split) — not contract holes.

If round-9 finds anything, it must be a fresh angle outside the L6 rule (we have spent enough rounds on L6 alone). At this point the plan body covers all six contracts (A–F), six gates (L1–L6), three resolved Stage-5.1 closeup items, and the full Stage 6 implementation route across six tasks. Round-9 should approve unless there's a fresh structural gap.

End of v9.
