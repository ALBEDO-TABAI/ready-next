import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentInputItem } from '@openai/agents'
import {
  CONTEXT_SOFT_RATIO,
  DEFAULT_CONTEXT_WINDOW,
  MAX_CONTEXT_WINDOW,
  computeContextBudget,
  estimateInputItemTokens,
  resolveModelContextWindow,
} from '../shared/context-budget-types'

test('context budget includes history usage when deciding the soft phase', () => {
  const budget = computeContextBudget({
    windowTokens: 1_000,
    lastUsageTokens: 790,
    pendingDeltaTokens: 10,
  })

  assert.equal(budget.usedTokens, 790)
  assert.equal(budget.pendingDeltaTokens, 10)
  assert.equal(budget.projectedTokens, 800)
  assert.equal(budget.ratio, CONTEXT_SOFT_RATIO)
  assert.equal(budget.phase, 'soft')
})

test('context window resolves override, model, default, and clamps bounds', () => {
  assert.equal(resolveModelContextWindow({ contextWindowOverride: 123_456 }, { contextWindow: 64_000 }), 123_456)
  assert.equal(resolveModelContextWindow({}, { contextWindow: 64_000 }), 64_000)
  assert.equal(resolveModelContextWindow({}, {}), DEFAULT_CONTEXT_WINDOW)
  assert.equal(resolveModelContextWindow({ contextWindowOverride: MAX_CONTEXT_WINDOW + 1 }), MAX_CONTEXT_WINDOW)
  assert.equal(resolveModelContextWindow({ contextWindowOverride: 0 }), 1)
})

test('CJK text estimates higher than same-length English text', () => {
  const english = estimateInputItemTokens([userMessage('word '.repeat(40))])
  const chinese = estimateInputItemTokens([userMessage('你好世界。'.repeat(40))])

  assert.ok(chinese > english * 2, `expected CJK estimate ${chinese} to be more than double English ${english}`)
})

test('opaque media references are estimated as high-cost objects', () => {
  const imageReference = estimateInputItemTokens([
    {
      role: 'user',
      content: [{ type: 'input_image', image: { id: 'img_123' }, detail: 'auto' }],
    } as AgentInputItem,
  ])
  const fileReference = estimateInputItemTokens([
    {
      role: 'user',
      content: [{ type: 'input_file', file: { url: 'https://example.test/large.pdf' }, filename: 'large.pdf' }],
    } as AgentInputItem,
  ])

  assert.ok(imageReference >= 32_000)
  assert.ok(fileReference >= 64_000)
})

test('representative AgentInputItem union members all receive non-zero estimates', () => {
  const items: AgentInputItem[] = [
    userMessage('hello'),
    { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello' }] } as AgentInputItem,
    { role: 'system', content: 'system prompt' } as AgentInputItem,
    { type: 'tool_search_call', call_id: 'ts1', arguments: { query: 'calendar' } } as AgentInputItem,
    { type: 'tool_search_output', call_id: 'ts1', tools: [{ name: 'calendar_lookup' }] } as AgentInputItem,
    { type: 'hosted_tool_call', name: 'web_search', arguments: '{}', output: 'ok' } as AgentInputItem,
    { type: 'function_call', callId: 'fn1', name: 'lookup', arguments: '{"q":"x"}' } as AgentInputItem,
    { type: 'computer_call', callId: 'pc1', status: 'completed', action: { type: 'screenshot' } } as AgentInputItem,
    { type: 'shell_call', callId: 'sh1', action: { commands: ['pwd'] } } as AgentInputItem,
    { type: 'apply_patch_call', callId: 'ap1', status: 'completed', operation: { type: 'delete_file', path: 'tmp.txt' } } as AgentInputItem,
    { type: 'function_call_result', callId: 'fn1', name: 'lookup', status: 'completed', output: 'done' } as AgentInputItem,
    { type: 'computer_call_result', callId: 'pc1', output: { type: 'computer_screenshot', data: 'abc123' } } as AgentInputItem,
    {
      type: 'shell_call_output',
      callId: 'sh1',
      output: [{ stdout: 'ok', stderr: '', outcome: { type: 'exit', exitCode: 0 } }],
    } as AgentInputItem,
    { type: 'apply_patch_call_output', callId: 'ap1', status: 'completed', output: 'patched' } as AgentInputItem,
    { type: 'reasoning', content: [{ type: 'input_text', text: 'thinking' }] } as AgentInputItem,
    { type: 'compaction', encrypted_content: 'opaque' } as AgentInputItem,
    { type: 'unknown', providerData: { future: 'payload' } } as AgentInputItem,
  ]

  for (const item of items) {
    assert.ok(estimateInputItemTokens([item]) > 0, `expected estimate for ${(item as { type?: string }).type ?? 'message'}`)
  }
})

function userMessage(content: string): AgentInputItem {
  return { role: 'user', content } as AgentInputItem
}
