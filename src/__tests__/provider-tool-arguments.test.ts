import assert from 'node:assert/strict'
import test from 'node:test'

import { parseProviderToolArguments } from '../main/modules/claude-bridge/provider-tool-arguments'

/**
 * Stage 2.1a — `parseProviderToolArguments` contract tests.
 *
 * Boundary cases matter: a tool that legitimately takes zero arguments
 * must not be flagged as corrupt, but a model that returns arguments
 * shaped like `[1,2]` or `"hi"` must NOT silently become `{}` and dispatch
 * an empty-args tool call.
 */

test('parseProviderToolArguments treats empty / "{}" / whitespace / nullish as legitimate empty args', () => {
  for (const input of [undefined, null, '', '   ', '{}', ' {}\n']) {
    const result = parseProviderToolArguments(input as string | null | undefined)
    assert.equal(result.ok, true, `input=${JSON.stringify(input)}`)
    if (result.ok) assert.deepEqual(result.input, {})
  }
})

test('parseProviderToolArguments returns parsed object for valid JSON object', () => {
  const result = parseProviderToolArguments('{"query":"hello","page":3}')
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.input, { query: 'hello', page: 3 })
  }
})

test('parseProviderToolArguments flags corrupt JSON as corrupt', () => {
  for (const input of ['{not-json', '{"unterminated":', '}', '"}{', 'undefined']) {
    const result = parseProviderToolArguments(input)
    assert.equal(result.ok, false, `input=${input}`)
    if (!result.ok) {
      assert.equal(result.reason, 'corrupt')
      assert.equal(typeof result.rawSample, 'string')
      assert.ok(result.rawSample.length <= 200)
    }
  }
})

test('parseProviderToolArguments flags non-object JSON values as corrupt', () => {
  for (const input of ['[1,2,3]', '"a string"', '42', 'true', 'false', 'null']) {
    const result = parseProviderToolArguments(input)
    assert.equal(result.ok, false, `input=${input}`)
    if (!result.ok) {
      assert.equal(result.reason, 'corrupt')
      assert.equal(result.rawSample, input)
    }
  }
})

test('parseProviderToolArguments truncates rawSample to 200 chars', () => {
  const huge = `{"oops":"${'x'.repeat(500)}` // unterminated, 500+ chars
  const result = parseProviderToolArguments(huge)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.rawSample.length, 200)
    assert.ok(result.rawSample.startsWith('{"oops":"x'))
  }
})

test('parseProviderToolArguments preserves exact object shape (not deep-cloned)', () => {
  const result = parseProviderToolArguments('{"nested":{"a":1},"arr":[1,2]}')
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.input, { nested: { a: 1 }, arr: [1, 2] })
  }
})
