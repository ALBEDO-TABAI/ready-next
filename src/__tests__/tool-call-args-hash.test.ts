/**
 * Stage R W2.1 — stable tool-call args hash.
 *
 * Asserts that hashToolCallArgs returns the same hash for objects with
 * the same key/value pairs regardless of declaration order. This is the
 * core invariant for loop-detection: two semantically identical tool
 * calls must collide in the recent-call window.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  hashToolCallArgs,
  stableToolKey,
} from '../main/modules/agent-control/tools-runtime/tool-call-args-hash'

test('hashToolCallArgs is order-independent for object keys', () => {
  const hashA = hashToolCallArgs({ a: 1, b: 2 })
  const hashB = hashToolCallArgs({ b: 2, a: 1 })
  assert.equal(hashA, hashB)
})

test('hashToolCallArgs differs when values differ', () => {
  const hashA = hashToolCallArgs({ a: 1, b: 2 })
  const hashB = hashToolCallArgs({ a: 1, b: 3 })
  assert.notEqual(hashA, hashB)
})

test('stableToolKey combines name with stable arg hash', () => {
  const k1 = stableToolKey('web_search', { query: 'foo' })
  const k2 = stableToolKey('web_search', { query: 'foo' })
  const k3 = stableToolKey('web_fetch', { query: 'foo' })
  assert.equal(k1, k2)
  assert.notEqual(k1, k3)
})
