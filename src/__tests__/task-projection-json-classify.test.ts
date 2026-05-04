import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyJsonReadError,
  classifyJsonReadValue,
} from '../main/modules/agent-control/task-projection-reconciler'

/**
 * Stage 3 W2 — pure helper tests. The reconciler-level e2e tests (in
 * task-projection-reconciler.test.ts) cover the file-to-metric path; here
 * we only feed synthetic errors / parsed values, so EACCES coverage does
 * not depend on chmod (unstable on macOS / CI) and array vs. object
 * distinction is explicit.
 */

test('classifyJsonReadError maps ENOENT to missing', () => {
  const e = Object.assign(new Error('not found'), { code: 'ENOENT' })
  assert.equal(classifyJsonReadError(e), 'missing')
})

test('classifyJsonReadError maps ENOTDIR to missing', () => {
  const e = Object.assign(new Error('not a dir'), { code: 'ENOTDIR' })
  assert.equal(classifyJsonReadError(e), 'missing')
})

test('classifyJsonReadError maps EACCES to denied', () => {
  const e = Object.assign(new Error('permission denied'), { code: 'EACCES' })
  assert.equal(classifyJsonReadError(e), 'denied')
})

test('classifyJsonReadError maps EPERM to denied', () => {
  const e = Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
  assert.equal(classifyJsonReadError(e), 'denied')
})

test('classifyJsonReadError maps unknown error to corrupt', () => {
  for (const e of [
    new Error('boom'),
    Object.assign(new Error('something'), { code: 'EOTHER' }),
    'string error',
    42,
    null,
    undefined,
  ]) {
    assert.equal(classifyJsonReadError(e), 'corrupt', `error=${String(e)}`)
  }
})

test('classifyJsonReadValue rejects array as not_object', () => {
  const result = classifyJsonReadValue([1, 2, 3])
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'not_object')
})

test('classifyJsonReadValue rejects null as not_object', () => {
  const result = classifyJsonReadValue(null)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'not_object')
})

test('classifyJsonReadValue rejects primitives as not_object', () => {
  for (const v of ['string', 42, true, false]) {
    const result = classifyJsonReadValue(v)
    assert.equal(result.ok, false, `value=${JSON.stringify(v)}`)
    if (!result.ok) assert.equal(result.reason, 'not_object')
  }
})

test('classifyJsonReadValue accepts plain object', () => {
  const obj = { a: 1, b: { c: 2 } }
  const result = classifyJsonReadValue(obj)
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.value, obj)
})
