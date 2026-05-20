import assert from 'node:assert/strict'
import test from 'node:test'

import { ToolRuntime } from '../main/modules/agent-control/tool-runtime'
import {
  buildExplicitNoSkillAuthorization,
  buildSelectedSkillToolAuthorization,
} from '../main/modules/agent-control/skills/skill-tool-authorization'
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
      // Use larger gaps to keep the ordering deterministic under
      // concurrency/scheduler jitter (the original 30/10/5ms gaps were
      // flaky on busy CI runs and during full-suite runs where the
      // event loop is contended).
      await new Promise((resolve) => setTimeout(resolve, toolCall.id === '1' ? 200 : toolCall.id === '2' ? 80 : 20))
      finishes.push(toolCall.id)
      return `${toolCall.name}:ok`
    },
  })

  assert.deepEqual(starts, ['1', '2', '3'])
  assert.equal(finishes.length, 3)
  assert.equal(finishes[2], '1')
  assert.deepEqual(new Set(finishes), new Set(['1', '2', '3']))
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
    context: {
      allowedToolNames: new Set(['skill_video_expert_ai_analyze', 'memory_search']),
      authorization: buildSelectedSkillToolAuthorization({
        skillId: 'video-expert-analyzer',
        allowedTypedActions: ['skill_video_expert_ai_analyze'],
        allowedPrimitives: [
          'skill_ask_user',
          'skill_run_shell',
          'skill_write_artifact',
          'skill_read_artifact',
          'skill_patch_config',
          'skill_start_detached',
          'skill_inspect_detached',
          'skill_cancel_detached',
          'skill_inspect_run_state',
        ],
        source: 'explicit',
        reason: 'test_setup',
      }),
    },
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

test('ToolRuntime uses timeout profiles on the default execution path', async () => {
  const runtime = new ToolRuntime({
    log: () => {},
    executeToolCall: async () => await new Promise<string>(() => {}),
    resolveTimeoutMs: () => 5,
  } as any)

  const result = await runtime.executeBatch({
    toolCalls: [
      { id: '1', name: 'document_update_widget', input: {} },
    ],
    context: {
      authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    },
  })

  assert.equal(result.results.length, 1)
  assert.equal(result.results[0]?.result.shape, 'json')
  assert.equal(result.results[0]?.result.data?.errorKind, 'timeout_tool')
  assert.match(result.results[0]?.result.text || '', /timed out/i)
})

test('ToolRuntime retries transient tool failures before succeeding and serializes later groups after recovery', async () => {
  const delays: number[] = []
  const runtime = new ToolRuntime({
    log: () => {},
    sleep: async (delayMs) => {
      delays.push(delayMs)
    },
  })
  const attempts = new Map<string, number>()
  const groupModes: string[] = []

  const result = await runtime.executeBatch({
    toolCalls: [
      { id: '1', name: 'memory_search', input: { q: 'recover' } },
      { id: '2', name: 'document_list_widgets', input: { tabId: 'tab-1' } },
      { id: '3', name: 'browser_click', input: { selector: '#go' } },
    ],
    onGroupStart: (group) => {
      groupModes.push(group.mode)
    },
    executeTool: async (toolCall) => {
      const nextAttempt = (attempts.get(toolCall.id) || 0) + 1
      attempts.set(toolCall.id, nextAttempt)
      if (toolCall.id === '1' && nextAttempt === 1) {
        throw new Error('HTTP 503 upstream unavailable')
      }
      return `${toolCall.name}:ok:${nextAttempt}`
    },
  })

  assert.equal(result.results.length, 3)
  assert.deepEqual(groupModes, ['parallel', 'serial'])
  assert.equal(result.results[0]?.result.text, 'memory_search:ok:2')
  assert.equal(result.results[1]?.result.text, 'document_list_widgets:ok:1')
  assert.equal(result.results[2]?.result.text, 'browser_click:ok:1')
  assert.deepEqual(result.recoveryHistory.map((item) => item.kind), ['transient'])
  assert.equal(delays.length, 1)
  assert.ok((delays[0] || 0) >= 375)
  assert.ok((delays[0] || 0) <= 500)
})

test('ToolRuntime converts context-overflow tool failures into structured outputs without retrying', async () => {
  const runtime = new ToolRuntime({ log: () => {} })
  let attempts = 0

  const result = await runtime.executeBatch({
    toolCalls: [
      { id: '1', name: 'memory_search', input: { q: 'overflow' } },
    ],
    executeTool: async () => {
      attempts += 1
      throw new Error('maximum context length exceeded')
    },
  })

  assert.equal(attempts, 1)
  assert.equal(result.results[0]?.result.shape, 'json')
  assert.equal(result.results[0]?.result.data?.errorKind, 'context_overflow')
  assert.deepEqual(result.recoveryHistory.map((item) => item.kind), ['context_overflow'])
})
