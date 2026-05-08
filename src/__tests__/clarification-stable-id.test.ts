/**
 * Stage S W6.2 — Stable clarification message ID behavior test.
 *
 * Asserts:
 *   - same toolCallId yields the same message ID
 *   - different toolCallId yields different message IDs
 *   - missing toolCallId falls back to a sha256-derived ID that is stable
 *     for identical fallbackText and differs for differing fallbackText
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildClarificationMessageId } from '../main/modules/agent-control/clarification-message-id'

test('same toolCallId yields the same ID', () => {
  const a = buildClarificationMessageId('tool-call-abc')
  const b = buildClarificationMessageId('tool-call-abc')
  assert.equal(a, b)
  assert.equal(a, 'clarification:tool-call-abc')
})

test('different toolCallId yields different IDs', () => {
  const a = buildClarificationMessageId('tool-call-abc')
  const b = buildClarificationMessageId('tool-call-xyz')
  assert.notEqual(a, b)
})

test('null/undefined toolCallId falls back to sha256(fallbackText) prefix', () => {
  const a = buildClarificationMessageId(null, 'who is this for?')
  const b = buildClarificationMessageId(undefined, 'who is this for?')
  assert.equal(a, b, 'null and undefined toolCallId must be treated equally')
  assert.match(a, /^clarification:[0-9a-f]{16}$/)
})

test('fallback IDs differ for differing fallbackText', () => {
  const a = buildClarificationMessageId(null, 'question one')
  const b = buildClarificationMessageId(null, 'question two')
  assert.notEqual(a, b)
})

test('toolCallId takes precedence over fallbackText', () => {
  const a = buildClarificationMessageId('tool-call-abc', 'question one')
  const b = buildClarificationMessageId('tool-call-abc', 'question two')
  assert.equal(a, b)
})
