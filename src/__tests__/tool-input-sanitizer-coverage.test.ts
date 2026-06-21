/**
 * Stage R W2.2 — sanitizer coverage minimal smoke.
 *
 * Asserts that an assistant message with a tool_call whose tool name is NOT
 * in the validToolNames set has the dangling tool_call dropped. This is the
 * core invariant that protects model history from referencing retired or
 * unregistered tools.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { sanitizeOpenAICompatibleMessageHistory } from '../main/modules/claude-bridge/openai-history-sanitization'

test('sanitizer drops dangling tool_call referencing unknown tool', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: 'thinking…',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'unknown_tool', arguments: '{}' } },
      ],
    },
  ]
  const sanitized = sanitizeOpenAICompatibleMessageHistory(
    messages as never,
    { validToolNames: new Set(['web_search']) },
  )
  // The assistant message either drops the tool_calls entry or is dropped
  // entirely if its content was empty.
  for (const msg of sanitized) {
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
        const fn = tc.function && typeof tc.function === 'object'
          ? (tc.function as { name?: unknown }).name
          : null
        assert.notEqual(fn, 'unknown_tool', 'unknown_tool tool_call must be dropped')
      }
    }
  }
})

test('sanitizer leaves clean history untouched', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ]
  const sanitized = sanitizeOpenAICompatibleMessageHistory(messages as never)
  assert.equal(sanitized.length, 2)
})

test('sanitizer redacts host paths when flattening Anthropic tool_result history', () => {
  const sanitized = sanitizeOpenAICompatibleMessageHistory([
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu-path',
          content: 'run state: /Users/alice/Ready/run_state.json',
        },
      ],
    },
  ] as never)

  const content = String(sanitized[0]?.content || '')
  assert.doesNotMatch(content, /\/Users\/alice/)
  assert.match(content, /\/Users\/<redacted>\/Ready\/run_state\.json/)
})

test('sanitizer redacts host paths in OpenAI tool-role history content', () => {
  const sanitized = sanitizeOpenAICompatibleMessageHistory([
    {
      role: 'tool',
      tool_call_id: 'call-path',
      content: 'saved output to C:\\Users\\alice\\Ready\\out.txt',
    },
  ] as never)

  const content = String(sanitized[0]?.content || '')
  assert.doesNotMatch(content, /C:\\Users\\alice/)
  assert.match(content, /C:\\Users\\<redacted>\\Ready\\out\.txt/)
})
