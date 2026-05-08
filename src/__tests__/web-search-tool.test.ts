/**
 * Stage R W1.1 — web_search tool smoke test.
 *
 * Asserts the Zod schema rejects empty queries (the most common silent-fail
 * vector) and accepts well-formed args. End-to-end Tavily/DDG fallback is
 * covered separately in the gate fixture.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { webSearchSchema } from '../main/modules/tools/builtins/web-search'

test('webSearchSchema rejects empty query', () => {
  const result = webSearchSchema.safeParse({ query: '' })
  assert.equal(result.success, false)
})

test('webSearchSchema accepts valid query and applies topK default', () => {
  const result = webSearchSchema.safeParse({ query: 'deerflow research' })
  assert.equal(result.success, true)
  if (result.success) {
    assert.equal(result.data.query, 'deerflow research')
    // topK default = 5 per webSearchSchema
    assert.equal(result.data.topK, 5)
  }
})

test('webSearchSchema rejects topK out of range', () => {
  const r1 = webSearchSchema.safeParse({ query: 'x', topK: 0 })
  const r2 = webSearchSchema.safeParse({ query: 'x', topK: 999 })
  assert.equal(r1.success, false)
  assert.equal(r2.success, false)
})
