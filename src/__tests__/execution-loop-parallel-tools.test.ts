import assert from 'node:assert/strict'
import test from 'node:test'

import { ExecutionLoopOrchestrator } from '../main/modules/agent-control/execution-loop-orchestrator'
import { groupParallelSafeToolCalls, isParallelSafeTool } from '../main/modules/agent-control/tool-parallelism-policy'

test('tool parallelism policy only allows explicit read-only tools', () => {
  assert.equal(isParallelSafeTool('document_list_widgets'), true)
  assert.equal(isParallelSafeTool('memory_search'), true)
  assert.equal(isParallelSafeTool('skill_rss_status'), true)
  assert.equal(isParallelSafeTool('browser_click'), false)
  assert.equal(isParallelSafeTool('document_update_widget'), false)
  assert.equal(isParallelSafeTool('system_run_openclaw'), false)
})

test('tool parallelism policy groups consecutive read-only tools into one parallel batch', () => {
  const groups = groupParallelSafeToolCalls([
    { id: '1', name: 'memory_search', input: {} },
    { id: '2', name: 'document_list_widgets', input: {} },
    { id: '3', name: 'browser_click', input: {} },
    { id: '4', name: 'skill_rss_status', input: {} },
  ])

  assert.deepEqual(groups.map((group) => ({
    mode: group.mode,
    ids: group.toolCalls.map((toolCall) => toolCall.id),
  })), [
    { mode: 'parallel', ids: ['1', '2'] },
    { mode: 'serial', ids: ['3'] },
    { mode: 'serial', ids: ['4'] },
  ])
})

test('ExecutionLoopOrchestrator executes a parallel-safe batch concurrently but preserves result order', async () => {
  const orchestrator = new ExecutionLoopOrchestrator({ log: () => {} })
  const starts: string[] = []
  const finishes: string[] = []

  const result = await orchestrator.executeToolCalls({
    toolCalls: [
      { id: '1', name: 'memory_search', input: { q: 'first' } },
      { id: '2', name: 'document_list_widgets', input: { tabId: 'tab-1' } },
    ],
    executeTool: async (toolCall) => {
      starts.push(toolCall.id)
      await new Promise((resolve) => setTimeout(resolve, toolCall.id === '1' ? 30 : 5))
      finishes.push(toolCall.id)
      return `${toolCall.name}:ok`
    },
  })

  assert.deepEqual(starts, ['1', '2'])
  assert.deepEqual(finishes, ['2', '1'])
  assert.deepEqual(result.results.map((item) => item.id), ['1', '2'])
  assert.deepEqual(result.results.map((item) => item.result), ['memory_search:ok', 'document_list_widgets:ok'])
  assert.equal(result.budgetLimited, false)
})

test('ExecutionLoopOrchestrator degrades parallel groups and truncates calls when budget is exhausted', async () => {
  const orchestrator = new ExecutionLoopOrchestrator({ log: () => {} })
  const starts: string[] = []

  const result = await orchestrator.executeToolCalls({
    toolCalls: [
      { id: '1', name: 'memory_search', input: {} },
      { id: '2', name: 'document_list_widgets', input: {} },
      { id: '3', name: 'skill_rss_status', input: {} },
    ],
    budget: {
      maxIterations: 24,
      maxToolCalls: 2,
      maxParallelToolGroups: 0,
    },
    budgetState: {
      iterationsUsed: 0,
      toolCallsUsed: 0,
      parallelToolGroupsUsed: 0,
    },
    executeTool: async (toolCall) => {
      starts.push(toolCall.id)
      return `${toolCall.name}:ok`
    },
  })

  assert.deepEqual(starts, ['1', '2'])
  assert.equal(result.budgetLimited, true)
  assert.deepEqual(result.results.map((item) => item.id), ['1', '2'])
})
