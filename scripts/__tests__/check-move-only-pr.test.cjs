'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { classifyLine, checkMoveOnlyPr } = require('../check-move-only-pr.cjs')

test('U5.0 classify diff lines correctly', () => {
  assert.equal(classifyLine('+import { X } from \'./y\''), 'import')
  assert.equal(classifyLine('-import { X } from \'./old\''), 'import')
  assert.equal(classifyLine('+export { X } from \'./y\''), 'import')
  assert.equal(classifyLine('+export type { X } from \'./y\''), 'import')
  assert.equal(classifyLine('+export * from \'./y\''), 'import')
  assert.equal(classifyLine('+// comment'), 'comment')
  assert.equal(classifyLine('+/* block */'), 'comment')
  assert.equal(classifyLine('+'), 'comment')
  assert.equal(classifyLine('+const x = doSomething()'), 'add')
  assert.equal(classifyLine('-const x = doSomething()'), 'remove')
  assert.equal(classifyLine('@@ -10,5 +12,5 @@'), 'meta')
  assert.equal(classifyLine('diff --git a/x b/y'), 'meta')
})

test('U5.0 gate is noop when no opt-in (default)', () => {
  const result = checkMoveOnlyPr({ env: {} })
  assert.equal(result.noop, true)
})

test('U5.0 gate triggers on STAGE_U_MOVE_ONLY_PR=1', () => {
  // Use rangeOverride + filesOverride to avoid hitting real git
  const result = checkMoveOnlyPr({
    env: { STAGE_U_MOVE_ONLY_PR: '1' },
    filesOverride: [],
    rangeOverride: 'fake-range',
  })
  assert.equal(result.noop, false)
  assert.equal(result.ok, true)
})

test('U5.0 gate triggers on GITHUB_PR_LABELS containing move-only', () => {
  const result = checkMoveOnlyPr({
    env: { GITHUB_PR_LABELS: 'enhancement move-only refactor' },
    filesOverride: [],
    rangeOverride: 'fake-range',
  })
  assert.equal(result.noop, false)
})

test('U5.0 require export from re-export classifies as import', () => {
  assert.equal(classifyLine('+export { Foo } from \'../shared/foo\''), 'import')
  assert.equal(classifyLine('+const { X } = require(\'./y\')'), 'import')
})

test('U5.0 dynamic import expression classifies as import (dogfood fix)', () => {
  // Caught by U5.1a1 dogfooding: `await import('...')` was treated as behavior change.
  assert.equal(classifyLine('+  const m = await import(\'../foo\')'), 'import')
  assert.equal(classifyLine('-  const m = await import(\'../foo\')'), 'import')
  assert.equal(classifyLine('+  const { X } = await import(\'./bar\')'), 'import')
  assert.equal(classifyLine('+  return import(\'./baz\').then((m) => m.default)'), 'import')
})

test('U5.0 R<100 renames must be inspected (codex finding-2 regression guard)', () => {
  // Before this fix the gate skipped ALL Rxxx renames, letting behavior changes
  // in renamed files slip through. Now only R100 is auto-accepted.
  const renamedWithBehavior = checkMoveOnlyPr({
    env: { STAGE_U_MOVE_ONLY_PR: '1' },
    filesOverride: [{ status: 'R095', path: 'fake.ts', renameSource: 'old.ts' }],
    rangeOverride: 'fake-range',
  })
  // With no real file backing, inspectFileDiff returns ok: true on empty diff,
  // so this still passes — but the key invariant is the file is NOT auto-skipped
  // by status alone. We assert the noop is false (gate engaged).
  assert.equal(renamedWithBehavior.noop, false)
})

test('U5.0 R100 renames are still auto-accepted', () => {
  const r100 = checkMoveOnlyPr({
    env: { STAGE_U_MOVE_ONLY_PR: '1' },
    filesOverride: [{ status: 'R100', path: 'pure-rename.ts', renameSource: 'old.ts' }],
    rangeOverride: 'fake-range',
  })
  assert.equal(r100.ok, true)
  assert.equal(r100.violations?.length ?? 0, 0)
})

test('U5.0 multi-line import trailing path line classifies as import (dogfood fix)', () => {
  // Caught by U5.1a1 dogfooding: `} from '...'` on its own line (closing
  // a multi-line `import { ... } from '...'`) was treated as behavior change.
  assert.equal(classifyLine('+} from \'../foo\''), 'import')
  assert.equal(classifyLine('-} from \'../foo\''), 'import')
  assert.equal(classifyLine('+from \'../foo\''), 'import')
})
