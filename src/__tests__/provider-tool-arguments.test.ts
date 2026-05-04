import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildChatCompletionsToolCalls,
  buildResponsesToolCalls,
  parseProviderToolArguments,
} from '../main/modules/claude-bridge/provider-tool-arguments'

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

/**
 * Stage 2.1a follow-up — dispatch helper contracts.
 *
 * These tests pin the wiring at each provider route's dispatch boundary.
 * If a future commit forgets to call the helper (or routes a new branch
 * around it), these contracts break and the parser-only tests would NOT
 * catch the regression.
 */

test('buildChatCompletionsToolCalls keeps valid calls and reports corrupt ones', () => {
  const result = buildChatCompletionsToolCalls([
    { id: 'call_1', function: { name: 'browse_page', arguments: '{"url":"https://x"}' } },
    { id: 'call_2', function: { name: 'shell', arguments: '{not json' } },
    { id: 'call_3', function: { name: 'noop', arguments: '' } }, // legitimately empty
    { id: 'call_4', function: { name: 'wrong_shape', arguments: '[1,2]' } },
  ])

  // valid + empty calls are preserved
  assert.equal(result.toolCalls.length, 2)
  assert.deepEqual(result.toolCalls[0], {
    id: 'call_1',
    name: 'browse_page',
    input: { url: 'https://x' },
  })
  assert.deepEqual(result.toolCalls[1], { id: 'call_3', name: 'noop', input: {} })

  // corrupt calls are dropped + reported with toolName / callId / rawSample
  assert.equal(result.failures.length, 2)
  assert.deepEqual(
    result.failures.map((f) => ({ toolName: f.toolName, callId: f.callId })),
    [
      { toolName: 'shell', callId: 'call_2' },
      { toolName: 'wrong_shape', callId: 'call_4' },
    ],
  )
  assert.equal(result.failures[0].rawSample, '{not json')
  assert.equal(result.failures[1].rawSample, '[1,2]')
})

test('buildChatCompletionsToolCalls normalizes empty toolName / callId to null on failure', () => {
  const result = buildChatCompletionsToolCalls([
    { id: '', function: { name: '', arguments: '{not json' } },
    { function: { arguments: 'still corrupt' } },
  ])
  assert.equal(result.toolCalls.length, 0)
  assert.equal(result.failures.length, 2)
  for (const f of result.failures) {
    assert.equal(f.toolName, null)
    assert.equal(f.callId, null)
  }
})

test('buildChatCompletionsToolCalls handles null/undefined raw input', () => {
  for (const raw of [null, undefined, []]) {
    const result = buildChatCompletionsToolCalls(raw as null)
    assert.deepEqual(result, { toolCalls: [], failures: [] })
  }
})

test('buildResponsesToolCalls keeps valid calls, drops corrupt, uses fallback id when call_id missing', () => {
  let fallbackCounter = 0
  const generateFallbackId = () => `respfc_fallback_${++fallbackCounter}`

  const result = buildResponsesToolCalls(
    [
      { type: 'function_call', call_id: 'rc_1', name: 'browse_page', arguments: '{"url":"https://x"}' },
      { type: 'function_call', call_id: 'rc_2', name: 'shell', arguments: '{not json' },
      { type: 'function_call', name: 'no_id', arguments: '{"a":1}' }, // missing call_id
      { type: 'reasoning', content: [] }, // non-function_call ignored
      { type: 'function_call', call_id: 'rc_3', name: 'arr_arg', arguments: '[1,2,3]' },
    ],
    generateFallbackId,
  )

  assert.equal(result.toolCalls.length, 2)
  assert.deepEqual(result.toolCalls[0], {
    id: 'rc_1',
    name: 'browse_page',
    input: { url: 'https://x' },
  })
  assert.deepEqual(result.toolCalls[1], {
    id: 'respfc_fallback_1',
    name: 'no_id',
    input: { a: 1 },
  })

  assert.equal(result.failures.length, 2)
  assert.deepEqual(
    result.failures.map((f) => ({ toolName: f.toolName, callId: f.callId })),
    [
      { toolName: 'shell', callId: 'rc_2' },
      { toolName: 'arr_arg', callId: 'rc_3' },
    ],
  )
  assert.equal(result.failures[0].rawSample, '{not json')
  assert.equal(result.failures[1].rawSample, '[1,2,3]')
})

test('buildResponsesToolCalls treats missing arguments string as empty (no metric)', () => {
  const result = buildResponsesToolCalls(
    [
      { type: 'function_call', call_id: 'rc_1', name: 'noop' }, // no arguments key
      { type: 'function_call', call_id: 'rc_2', name: 'noop2', arguments: 42 }, // non-string arguments
    ],
    () => 'fallback',
  )
  assert.equal(result.toolCalls.length, 2)
  assert.equal(result.failures.length, 0)
  for (const c of result.toolCalls) {
    assert.deepEqual(c.input, {})
  }
})

test('buildResponsesToolCalls handles null/undefined raw input', () => {
  for (const raw of [null, undefined, []]) {
    const result = buildResponsesToolCalls(raw as null, () => 'fallback')
    assert.deepEqual(result, { toolCalls: [], failures: [] })
  }
})
