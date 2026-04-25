/**
 * B Phase 4 cleanup — recalled OpenAI-shape sessions may still carry
 * `tool_calls[]` referencing the 6 retired execution-control tools (e.g.
 * `skill_submit_input`). Without filtering, the model sees a phantom tool it
 * can't actually call, and either retries or fabricates `executionId: 'new'`.
 *
 * Verifies that `sanitizeOpenAICompatibleMessageHistory` drops both sides of
 * the pair (assistant tool_calls entry + matching `role: 'tool'` follow-up)
 * when the tool name is absent from the supplied `validToolNames` set, while
 * legitimate current tool calls (e.g. `skill_run_shell`) survive untouched.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { sanitizeOpenAICompatibleMessageHistory } from '../main/modules/claude-bridge/openai-history-sanitization'

const VALID_TOOL_NAMES = new Set<string>([
  'skill_run_shell',
  'skill_ask_user',
  'skill_write_artifact',
  'skill_read_artifact',
  'skill_video_copy_analyze',
])

test('drops assistant tool_calls referencing retired skill_submit_input AND its tool follow-up', () => {
  const messages = sanitizeOpenAICompatibleMessageHistory(
    [
      { role: 'user', content: '继续执行 skill' },
      {
        role: 'assistant',
        content: '让我提交输入。',
        tool_calls: [
          {
            id: 'call_retired_1',
            type: 'function',
            function: {
              name: 'skill_submit_input',
              arguments: JSON.stringify({ executionId: 'exec-1', input: 'foo' }),
            },
          },
        ],
      } as any,
      {
        role: 'tool',
        tool_call_id: 'call_retired_1',
        content: 'execution not found',
      } as any,
      { role: 'user', content: '继续' },
    ],
    { validToolNames: VALID_TOOL_NAMES },
  )

  // Assistant's text payload survives, but tool_calls[] is empty.
  const assistant = messages.find((m) => m.role === 'assistant')
  assert.ok(assistant, 'assistant message survives')
  assert.equal(
    Array.isArray(assistant?.tool_calls) ? (assistant.tool_calls as unknown[]).length : 0,
    0,
    'retired tool_call dropped from assistant.tool_calls[]',
  )

  // The matching role: 'tool' follow-up must be gone too.
  const toolFollowup = messages.find(
    (m) => m.role === 'tool' && (m as any).tool_call_id === 'call_retired_1',
  )
  assert.equal(toolFollowup, undefined, 'role:tool follow-up for retired call dropped')
})

test('keeps legitimate skill_run_shell tool_calls and their follow-ups intact', () => {
  const messages = sanitizeOpenAICompatibleMessageHistory(
    [
      { role: 'user', content: '运行脚本' },
      {
        role: 'assistant',
        content: '执行命令。',
        tool_calls: [
          {
            id: 'call_legit_1',
            type: 'function',
            function: {
              name: 'skill_run_shell',
              arguments: JSON.stringify({ command: 'echo hi' }),
            },
          },
        ],
      } as any,
      {
        role: 'tool',
        tool_call_id: 'call_legit_1',
        content: 'hi',
      } as any,
    ],
    { validToolNames: VALID_TOOL_NAMES },
  )

  const assistant = messages.find((m) => m.role === 'assistant')
  assert.ok(assistant, 'assistant message survives')
  const calls = (assistant?.tool_calls as Array<Record<string, unknown>>) || []
  assert.equal(calls.length, 1, 'legit skill_run_shell tool_call retained')
  const fn = (calls[0] as any).function
  assert.equal(fn?.name, 'skill_run_shell')

  const toolFollowup = messages.find(
    (m) => m.role === 'tool' && (m as any).tool_call_id === 'call_legit_1',
  )
  assert.ok(toolFollowup, 'role:tool follow-up for legit call retained')
})

test('mixed retired + legit tool_calls in one assistant message: drop only the retired entry', () => {
  const messages = sanitizeOpenAICompatibleMessageHistory(
    [
      {
        role: 'assistant',
        content: '混合调用。',
        tool_calls: [
          {
            id: 'call_legit_2',
            type: 'function',
            function: { name: 'skill_run_shell', arguments: '{}' },
          },
          {
            id: 'call_retired_2',
            type: 'function',
            function: { name: 'skill_cancel_execution', arguments: '{}' },
          },
        ],
      } as any,
      { role: 'tool', tool_call_id: 'call_legit_2', content: 'ok' } as any,
      { role: 'tool', tool_call_id: 'call_retired_2', content: 'fail' } as any,
    ],
    { validToolNames: VALID_TOOL_NAMES },
  )

  const assistant = messages.find((m) => m.role === 'assistant')
  const calls = (assistant?.tool_calls as Array<Record<string, unknown>>) || []
  assert.equal(calls.length, 1, 'one legit call retained, one retired call dropped')
  assert.equal((calls[0] as any).function?.name, 'skill_run_shell')

  // Legit follow-up survives, retired follow-up is gone.
  const legitFollowup = messages.find(
    (m) => m.role === 'tool' && (m as any).tool_call_id === 'call_legit_2',
  )
  assert.ok(legitFollowup, 'legit follow-up retained')
  const retiredFollowup = messages.find(
    (m) => m.role === 'tool' && (m as any).tool_call_id === 'call_retired_2',
  )
  assert.equal(retiredFollowup, undefined, 'retired follow-up dropped')
})

test('assistant message with ONLY retired tool_calls and empty content is dropped entirely', () => {
  const messages = sanitizeOpenAICompatibleMessageHistory(
    [
      { role: 'user', content: 'kick off' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_retired_3',
            type: 'function',
            function: { name: 'skill_submit_confirmation', arguments: '{}' },
          },
        ],
      } as any,
      { role: 'tool', tool_call_id: 'call_retired_3', content: 'fail' } as any,
      { role: 'user', content: 'continue' },
    ],
    { validToolNames: VALID_TOOL_NAMES },
  )

  const assistant = messages.find((m) => m.role === 'assistant')
  assert.equal(assistant, undefined, 'assistant message with only retired tool_calls dropped')

  // Both user messages should still be present.
  const userMessages = messages.filter((m) => m.role === 'user')
  assert.equal(userMessages.length, 2, 'both user messages retained')
})

test('skip filter when validToolNames is omitted (back-compat)', () => {
  const messages = sanitizeOpenAICompatibleMessageHistory([
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_retired_4',
          type: 'function',
          function: { name: 'skill_submit_input', arguments: '{}' },
        },
      ],
    } as any,
    { role: 'tool', tool_call_id: 'call_retired_4', content: 'whatever' } as any,
  ])

  // Without validToolNames, only the structural pass runs — both messages
  // form a complete pair (id matched), so they survive untouched.
  const assistant = messages.find((m) => m.role === 'assistant')
  const calls = (assistant?.tool_calls as Array<Record<string, unknown>>) || []
  assert.equal(calls.length, 1, 'tool_call retained when validToolNames omitted')
  assert.equal((calls[0] as any).function?.name, 'skill_submit_input')
})
