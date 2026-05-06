# Stage 6 — Task fact ledger consolidation (Plan v8)

> Predecessor: `plan-v7.md`. v8 = patch-and-reroll after Codex round-7.
> v8 only restates the L6 `isTaskCardRef` recursion; everything else by-reference v1..v7.

## What changed vs v7

Round-7 returned 1 fresh blocker: array/container casts bypass the rule.
- `raw as TaskCardRun[]` (verified present today at `ChatPanel.tsx:2281`)
- `raw as Array<TaskCardRun>` / `as ReadonlyArray<TaskCardRun>` (theoretical but easy to write)

Both patterns need to be caught.

---

## §1.2 L6 (rewritten v8) — `isTaskCardRef` recurses

The single helper `isTaskCardRef(typeNode)` is updated to recurse through the four common container shapes, plus the existing direct/namespace/import-type cases. All other rule machinery (import tracking, type-alias tracking, `TSAsExpression`/`TSTypeAssertion` handlers) stays as in v7.

```js
function isTaskCardRef(typeNode) {
  if (!typeNode) return false

  // Container: T[]
  if (typeNode.type === 'TSArrayType') {
    return isTaskCardRef(typeNode.elementType)
  }

  // Container: Array<T> / ReadonlyArray<T> (and Set/Map for completeness)
  if (typeNode.type === 'TSTypeReference') {
    const tn = typeNode.typeName
    if (tn?.type === 'Identifier') {
      // Direct or aliased name
      if (taskCardNames.has(tn.name)) return true
      // Generic container with TaskCardRun-typed args
      if (['Array', 'ReadonlyArray', 'Set', 'ReadonlySet', 'Map', 'ReadonlyMap'].includes(tn.name)) {
        const args = typeNode.typeArguments?.params || typeNode.typeParameters?.params || []
        return args.some(isTaskCardRef)
      }
    }
    // Namespace: Card.TaskCardRun
    if (tn?.type === 'TSQualifiedName' && tn.right?.name === 'TaskCardRun') return true
  }

  // Inline import type
  if (typeNode.type === 'TSImportType') {
    const q = typeNode.qualifier
    if (q?.type === 'Identifier' && q.name === 'TaskCardRun') return true
    if (q?.type === 'TSQualifiedName' && q.right?.name === 'TaskCardRun') return true
  }

  // Tuple: [TaskCardRun, ...]
  if (typeNode.type === 'TSTupleType') {
    return (typeNode.elementTypes || []).some(isTaskCardRef)
  }

  return false
}
```

**Coverage now (additive vs v7)**:

| Pattern | Caught by |
|---|---|
| `as TaskCardRun[]` | `TSArrayType` recursion |
| `as Array<TaskCardRun>` | `TSTypeReference` Array generic |
| `as ReadonlyArray<TaskCardRun>` | same |
| `as Set<TaskCardRun>` / `Map<string, TaskCardRun>` | same |
| `as [TaskCardRun, OtherType]` | `TSTupleType` recursion |
| All v7 patterns | unchanged |

**Acknowledged remaining gaps** (deliberate laundering, not accidental):
- `as TaskCardRun & {}` — intersection
- `as TaskCardRun | null` then narrowing — union
- `as Pick<TaskCardRun, 'taskId'>` — utility type
- `as Promise<TaskCardRun>` — generic non-container

These were explicitly flagged in v7's gap list; v8 does not expand to cover them. They are exotic, easily caught in code review, and require active intent to bypass the rule.

**Tests** (additive):
- Invalid: `const x = raw as TaskCardRun[]`
- Invalid: `const x = raw as Array<TaskCardRun>`
- Invalid: `const x = raw as ReadonlyArray<TaskCardRun>`
- Invalid: `const x = raw as [TaskCardRun]`
- Invalid: `const x = raw as Map<string, TaskCardRun>`
- Valid: `const x: TaskCardRun[] = []` (annotation, not cast — empty array literal cannot be a stolen TaskCardRun)
- Valid: `const x: Array<TaskCardRun>` (annotation)

> Annotations (variable type annotations, return type annotations) are intentionally NOT caught. They merely declare what the value should be; the brand symbol still prevents construction. Only cast expressions (`as`, `<X>foo`) bypass the brand and need rule coverage.

---

## §6 (revised v8) — Carry-forward

Closed by v8: round-7 #3 (array/container cast bypass).

Remaining open:
- Intersection / union / utility-type / Promise generic transitive escapes — deliberate laundering, acceptable v8 gap.
- Process-discipline items unchanged (archive size warn, sub-task split).

If round-8 finds anything, expectation is exotic transitive escape; we acknowledge that risk and keep the bar at "common accidental cast paths fully covered".

End of v8.
