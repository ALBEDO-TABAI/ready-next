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

test('oversized tool results are truncated without breaking their call/result pair (under real pressure)', async () => {
  const result = await compactAgentInputItems([
    functionCall('big-call'),
    functionResult('big-call', 'x'.repeat(2_000)),
  ], {
    // 2026-07-03 R1 合同修正：截断只在超过软线后发生 —— 这里把窗口压小到
    // 让 2000 字符结果真实越线，截断语义（保 call/result 对）保持不变。
    windowTokens: 600,
    maxToolResultTokens: 100,
  })

  assert.equal(result.compacted, true)
  assert.equal(result.report.truncatedToolResults, 1)
  assert.deepEqual(itemTypes(result.items), ['function_call', 'function_call_result'])
  assert.match(String((result.items[1] as { output?: unknown }).output), /tool-result-truncated/)
})

test('R1 回归：低于软线时超限工具结果原样保留（动作后的读回执不得被无压力截断）', async () => {
  const bigMapResult = 'x'.repeat(2_000)
  const result = await compactAgentInputItems([
    functionCall('map-read'),
    functionResult('map-read', bigMapResult),
  ], {
    // 2000 字符 ≈ 数百 token，远低于 100k 窗口的 0.8 软线 —— 必须原样通过。
    windowTokens: 100_000,
    maxToolResultTokens: 100,
  })

  assert.equal(result.compacted, false)
  assert.equal(result.report.truncatedToolResults, 0)
  assert.equal(String((result.items[1] as { output?: unknown }).output), bigMapResult)
})

test('compactAgentInputItems keeps the latest user request with retained tail context', async () => {
  const latestRequest = 'LATEST_USER_REQUEST_KEEP_ME'
  const result = await compactAgentInputItems([
    userMessage('system seed'),
    userMessage('older context '.repeat(500)),
    functionCall('tail-call'),
    functionResult('tail-call', 'tail result'),
    userMessage(latestRequest),
  ], {
    windowTokens: 80,
    keepHeadCount: 1,
    keepTailCount: 3,
  })

  assert.equal(result.compacted, true)
  assert.ok(JSON.stringify(result.items).includes(latestRequest))
  assert.deepEqual(itemTypes(result.items).slice(-3), ['function_call', 'function_call_result', 'message'])
})

test('normalizeSessionSnapshotForSeed preserves retained request text while dropping orphan tool items', () => {
  const latestRequest = 'RESTORED_LATEST_USER_REQUEST'
  const normalized = normalizeSessionSnapshotForSeed([
    userMessage('head'),
    functionCall('complete'),
    functionResult('complete', 'ok'),
    functionCall('orphan'),
    userMessage(latestRequest),
  ])

  assert.deepEqual(itemTypes(normalized), ['message', 'function_call', 'function_call_result', 'message'])
  assert.ok(JSON.stringify(normalized).includes(latestRequest))
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
