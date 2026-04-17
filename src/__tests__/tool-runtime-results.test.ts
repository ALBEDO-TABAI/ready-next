import assert from 'node:assert/strict'
import test from 'node:test'

import { ToolRuntime } from '../main/modules/agent-control/tool-runtime'
import { createToolExecutionOutput } from '../main/modules/agent-control/tool-result-types'

test('ToolRuntime wraps legacy string results into structured outputs while preserving order', async () => {
  const runtime = new ToolRuntime({ log: () => {} })
  const starts: string[] = []
  const finishes: string[] = []

  const result = await runtime.executeBatch({
    toolCalls: [
      { id: '1', name: 'memory_search', input: { q: 'first' } },
      { id: '2', name: 'document_list_widgets', input: { tabId: 'tab-1' } },
      { id: '3', name: 'rss_capture_session', input: { limit: 5 } },
    ],
    executeTool: async (toolCall) => {
      starts.push(toolCall.id)
      await new Promise((resolve) => setTimeout(resolve, toolCall.id === '1' ? 30 : toolCall.id === '2' ? 10 : 5))
      finishes.push(toolCall.id)
      return `${toolCall.name}:ok`
    },
  })

  assert.deepEqual(starts, ['1', '2', '3'])
  assert.deepEqual(finishes, ['3', '2', '1'])
  assert.deepEqual(result.results.map((item) => item.id), ['1', '2', '3'])
  assert.deepEqual(result.results.map((item) => item.result.text), [
    'memory_search:ok',
    'document_list_widgets:ok',
    'rss_capture_session:ok',
  ])
  assert.deepEqual(result.results.map((item) => item.result.shape), ['text', 'text', 'text'])
})

test('ToolRuntime converts runtime-recoverable tool failures into structured outputs', async () => {
  const runtime = new ToolRuntime({ log: () => {} })

  const result = await runtime.executeBatch({
    toolCalls: [
      { id: '1', name: 'skill_video_expert_ai_analyze', input: {} },
      { id: '2', name: 'memory_search', input: {} },
    ],
    executeTool: async (toolCall) => {
      if (toolCall.id === '1') {
        throw new Error('Tool execution timed out after 120000ms (skill_video_expert_ai_analyze)')
      }
      return createToolExecutionOutput('memory_search:ok')
    },
  })

  assert.equal(result.budgetLimited, false)
  assert.equal(result.results[0]?.result.shape, 'json')
  assert.match(result.results[0]?.result.text || '', /timed out/i)
  assert.equal(result.results[0]?.result.data?.errorKind, 'timeout_tool')
  assert.equal(result.results[1]?.result.text, 'memory_search:ok')
  assert.deepEqual(result.recoveryHistory.map((item) => item.kind), ['timeout_tool'])
})

test('ToolRuntime lets custom executors handle non-registered tools', async () => {
  const runtime = new ToolRuntime({ log: () => {} })

  const result = await runtime.executeBatch({
    toolCalls: [
      { id: 'custom-1', name: 'custom_probe', input: { q: 'ready' } },
    ],
    executeTool: async (toolCall) => `custom:${toolCall.name}`,
  })

  assert.equal(result.results[0]?.result.text, 'custom:custom_probe')
  assert.equal(result.results[0]?.result.shape, 'text')
})
