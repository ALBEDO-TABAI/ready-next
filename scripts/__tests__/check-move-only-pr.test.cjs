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

test('U5.0 multi-line import trailing path line classifies as import (dogfood fix)', () => {
  // Caught by U5.1a1 dogfooding: `} from '...'` on its own line (closing
  // a multi-line `import { ... } from '...'`) was treated as behavior change.
  assert.equal(classifyLine('+} from \'../foo\''), 'import')
  assert.equal(classifyLine('-} from \'../foo\''), 'import')
  assert.equal(classifyLine('+from \'../foo\''), 'import')
})
