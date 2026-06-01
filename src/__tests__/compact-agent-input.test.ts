import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentInputItem } from '@openai/agents'
import {
  compactAgentInputItems,
  normalizeSessionSnapshotForSeed,
} from '../main/modules/agent-control/compaction/compact-agent-input'

test('compactAgentInputItems keeps complete call/result pairs in the retained tail', async () => {
  const result = await compactAgentInputItems([
    userMessage('start'),
    userMessage('middle '.repeat(400)),
    functionCall('call-a'),
    functionResult('call-a', 'ok'),
    userMessage('tail'),
  ], {
    windowTokens: 100,
    keepHeadCount: 1,
    keepTailCount: 3,
  })

  assert.equal(result.compacted, true)
  assert.equal(result.report.summarized, true)
  assert.deepEqual(itemTypes(result.items), ['message', 'message', 'function_call', 'function_call_result', 'message'])
})

test('compactAgentInputItems drops a reverse orphan result when its call falls outside the retained slice', async () => {
  const result = await compactAgentInputItems([
    userMessage('start'),
    functionCall('call-a'),
    userMessage('middle '.repeat(400)),
    functionResult('call-a', 'ok'),
    userMessage('tail'),
  ], {
    windowTokens: 100,
    keepHeadCount: 1,
    keepTailCount: 2,
  })

  assert.equal(result.compacted, true)
  assert.equal(result.items.some((item) => getType(item) === 'function_call'), false)
  assert.equal(result.items.some((item) => getType(item) === 'function_call_result'), false)
})

test('normalizeSessionSnapshotForSeed keeps tool_search call_id pairs and removes orphan calls/results', () => {
  const normalized = normalizeSessionSnapshotForSeed([
    { type: 'tool_search_call', call_id: 'search-1', arguments: { query: 'docs' } } as AgentInputItem,
    { type: 'tool_search_output', call_id: 'search-1', tools: [{ name: 'read_docs' }] } as AgentInputItem,
    functionCall('orphan-call'),
    functionResult('orphan-result', 'late output'),
    userMessage('after'),
  ])

  assert.deepEqual(itemTypes(normalized), ['tool_search_call', 'tool_search_output', 'message'])
})

test('dropped tool calls remove immediately preceding reasoning items', async () => {
  const result = await compactAgentInputItems([
    { role: 'system', content: 'system' } as AgentInputItem,
    { type: 'reasoning', content: [{ type: 'input_text', text: 'about to call' }] } as AgentInputItem,
    functionCall('lost-call'),
    userMessage('tail '.repeat(200)),
  ], {
    windowTokens: 80,
    keepHeadCount: 2,
    keepTailCount: 1,
  })

  assert.equal(result.compacted, true)
  assert.equal(result.items.some((item) => getType(item) === 'reasoning'), false)
  assert.equal(result.items.some((item) => getType(item) === 'function_call'), false)
})

test('oversized tool results are truncated without breaking their call/result pair', async () => {
  const result = await compactAgentInputItems([
    functionCall('big-call'),
    functionResult('big-call', 'x'.repeat(2_000)),
  ], {
    windowTokens: 100_000,
    maxToolResultTokens: 100,
  })

  assert.equal(result.compacted, true)
  assert.equal(result.report.truncatedToolResults, 1)
  assert.equal(result.report.summarized, false)
  assert.deepEqual(itemTypes(result.items), ['function_call', 'function_call_result'])
  assert.match(String((result.items[1] as { output?: unknown }).output), /tool-result-truncated/)
})

function userMessage(content: string): AgentInputItem {
  return { role: 'user', content } as AgentInputItem
}

function functionCall(callId: string): AgentInputItem {
  return {
    type: 'function_call',
    callId,
    name: 'lookup',
    arguments: '{}',
  } as AgentInputItem
}

function functionResult(callId: string, output: string): AgentInputItem {
  return {
    type: 'function_call_result',
    callId,
    name: 'lookup',
    status: 'completed',
    output,
  } as AgentInputItem
}

function itemTypes(items: AgentInputItem[]): string[] {
  return items.map((item) => getType(item) ?? 'message')
}

function getType(item: AgentInputItem): string | undefined {
  const type = (item as { type?: unknown }).type
  return typeof type === 'string' ? type : undefined
}
