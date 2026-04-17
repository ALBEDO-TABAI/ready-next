import assert from 'node:assert/strict'
import test from 'node:test'

import { ExecutionLoopOrchestrator } from '../main/modules/agent-control/execution-loop-orchestrator'
import {
  getToolResourceTag,
  groupParallelSafeToolCalls,
  isParallelSafeTool,
} from '../main/modules/agent-control/tool-parallelism-policy'

test('tool parallelism policy classifies tools into coarse resource tags', () => {
  assert.deepEqual(getToolResourceTag('document_list_widgets'), {
    domain: 'document',
    accessMode: 'read',
  })
  assert.deepEqual(getToolResourceTag('document_update_widget'), {
    domain: 'document',
    accessMode: 'write',
  })
  assert.deepEqual(getToolResourceTag('browser_click'), {
    domain: 'browser',
    accessMode: 'interactive',
  })
  assert.deepEqual(getToolResourceTag('memory_search'), {
    domain: 'memory',
    accessMode: 'read',
  })
  assert.deepEqual(getToolResourceTag('feishu_doc_update'), {
    domain: 'feishu',
    accessMode: 'write',
  })
})

test('tool parallelism policy only treats non-interactive read tools as parallel-safe', () => {
  assert.equal(isParallelSafeTool('document_list_widgets'), true)
  assert.equal(isParallelSafeTool('memory_search'), true)
  assert.equal(isParallelSafeTool('skill_rss_status'), true)
  assert.equal(isParallelSafeTool('browser_click'), false)
  assert.equal(isParallelSafeTool('document_update_widget'), false)
  assert.equal(isParallelSafeTool('system_run_openclaw'), false)
})

test('tool parallelism policy groups read-only tools across domains but isolates writes and interactive tools', () => {
  const groups = groupParallelSafeToolCalls([
    { id: '1', name: 'memory_search', input: {} },
    { id: '2', name: 'document_list_widgets', input: {} },
    { id: '3', name: 'rss_capture_session', input: {} },
    { id: '4', name: 'document_update_widget', input: {} },
    { id: '5', name: 'browser_click', input: {} },
    { id: '6', name: 'skill_rss_status', input: {} },
    { id: '7', name: 'feishu_doc_list', input: {} },
  ])

  assert.deepEqual(groups.map((group) => ({
    mode: group.mode,
    ids: group.toolCalls.map((toolCall) => toolCall.id),
  })), [
    { mode: 'parallel', ids: ['1', '2', '3'] },
    { mode: 'serial', ids: ['4'] },
    { mode: 'serial', ids: ['5'] },
    { mode: 'parallel', ids: ['6', '7'] },
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
  assert.equal(finishes.length, 3)
  assert.deepEqual(new Set(finishes), new Set(['1', '2', '3']))
  assert.deepEqual(result.results.map((item) => item.id), ['1', '2', '3'])
  assert.deepEqual(result.results.map((item) => item.result.text), ['memory_search:ok', 'document_list_widgets:ok', 'rss_capture_session:ok'])
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

test('ExecutionLoopOrchestrator caps actual concurrent tool execution per parallel batch', async () => {
  const orchestrator = new ExecutionLoopOrchestrator({ log: () => {} })
  let active = 0
  let maxActive = 0

  const result = await orchestrator.executeToolCalls({
    toolCalls: Array.from({ length: 7 }, (_, index) => ({
      id: `${index + 1}`,
      name: 'memory_search',
      input: { q: `item-${index + 1}` },
    })),
    budget: {
      maxIterations: 24,
      maxToolCalls: 24,
      maxParallelToolGroups: 5,
      reservedToolCalls: 0,
    },
    budgetState: {
      iterationsUsed: 0,
      toolCallsUsed: 0,
      parallelToolGroupsUsed: 0,
    },
    executeTool: async (toolCall) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
      return `${toolCall.name}:ok`
    },
  })

  assert.equal(maxActive, 5)
  assert.equal(result.results.length, 7)
})

test('ExecutionLoopOrchestrator uses ToolRuntime default execution with context and lifecycle hooks on the production batch path', async () => {
  const starts: string[] = []
  const executed: string[] = []
  const orchestrator = new ExecutionLoopOrchestrator({
    log: () => {},
    executeToolCall: async (toolName: string, _args: Record<string, unknown>) => {
      executed.push(toolName)
      return `${toolName}:ok`
    },
  } as any)

  const result = await orchestrator.executeToolCalls({
    toolCalls: [
      { id: '1', name: 'memory_search', input: { q: 'ready' } },
      { id: '2', name: 'document_list_widgets', input: { tabId: 'tab-1' } },
    ],
    context: {},
    hooks: {
      onToolStart: ({ toolCall }) => {
        starts.push(toolCall.name)
      },
    },
  })

  assert.deepEqual(starts, ['memory_search', 'document_list_widgets'])
  assert.deepEqual(executed, ['memory_search', 'document_list_widgets'])
  assert.deepEqual(result.results.map((item) => item.result.text), [
    'memory_search:ok',
    'document_list_widgets:ok',
  ])
})

test('ExecutionLoopOrchestrator retries model requests for runtime-recoverable rate limits before applying fallback logic', async () => {
  const delays: number[] = []
  const orchestrator = new ExecutionLoopOrchestrator({
    log: () => {},
    sleep: async (delayMs) => {
      delays.push(delayMs)
    },
  })
  let attempts = 0

  const response = await orchestrator.requestToolLoopResponse({
    useAnthropicProtocol: false,
    hasVideoInputs: false,
    session: {},
    config: {},
    baseUrl: 'https://api.openai.com/v1',
    provider: {},
    signal: new AbortController().signal,
    callAnthropicWithTools: async () => {
      throw new Error('unused')
    },
    callOpenAIWithTools: async () => {
      attempts += 1
      if (attempts === 1) {
        const error = new Error('429 rate limit exceeded')
        ;(error as Error & { status?: number }).status = 429
        throw error
      }
      return {
        text: 'ok',
        toolCalls: [],
        stopReason: 'stop',
      }
    },
    buildVideoFrameFallbackMessages: async () => [],
    assignFallbackMessages: () => {},
  })

  assert.equal(attempts, 2)
  assert.deepEqual(delays, [350])
  assert.equal(response.text, 'ok')
})

test('ExecutionLoopOrchestrator still applies transport fallback when runtime recovery does not handle the failure', async () => {
  let fallbackAssigned = false
  const orchestrator = new ExecutionLoopOrchestrator({ log: () => {} })
  let attempts = 0

  const response = await orchestrator.requestToolLoopResponse({
    useAnthropicProtocol: false,
    hasVideoInputs: true,
    session: {},
    config: {},
    baseUrl: 'https://api.openai.com/v1',
    provider: {},
    signal: new AbortController().signal,
    callAnthropicWithTools: async () => {
      throw new Error('unused')
    },
    callOpenAIWithTools: async () => {
      attempts += 1
      if (attempts === 1) {
        throw new Error('video blocks are not supported')
      }
      return {
        text: 'fallback-ok',
        toolCalls: [],
        stopReason: 'stop',
      }
    },
    buildVideoFrameFallbackMessages: async () => [{ role: 'user', content: 'frames' }],
    assignFallbackMessages: () => {
      fallbackAssigned = true
    },
  })

  assert.equal(attempts, 2)
  assert.equal(fallbackAssigned, true)
  assert.equal(response.fallback?.kind, 'video_frames')
  assert.equal(response.text, 'fallback-ok')
})

test('ExecutionLoopOrchestrator retries once after context compression when the model request overflows context', async () => {
  const orchestrator = new ExecutionLoopOrchestrator({ log: () => {} })
  let attempts = 0
  let compressed = 0

  const response = await orchestrator.requestToolLoopResponse({
    useAnthropicProtocol: false,
    hasVideoInputs: false,
    session: {},
    config: {},
    baseUrl: 'https://api.openai.com/v1',
    provider: {},
    signal: new AbortController().signal,
    callAnthropicWithTools: async () => {
      throw new Error('unused')
    },
    callOpenAIWithTools: async () => {
      attempts += 1
      if (attempts === 1) {
        throw new Error('maximum context length exceeded')
      }
      return {
        text: 'compressed-ok',
        toolCalls: [],
        stopReason: 'stop',
      }
    },
    compressContext: async () => {
      compressed += 1
      return true
    },
    buildVideoFrameFallbackMessages: async () => [],
    assignFallbackMessages: () => {},
  })

  assert.equal(attempts, 2)
  assert.equal(compressed, 1)
  assert.equal(response.text, 'compressed-ok')
})

test('ExecutionLoopOrchestrator notifies the caller before retrying a model timeout', async () => {
  const orchestrator = new ExecutionLoopOrchestrator({
    log: () => {},
    sleep: async () => {},
  })
  let attempts = 0
  const retrySignals: string[] = []

  const response = await orchestrator.requestToolLoopResponse({
    useAnthropicProtocol: false,
    hasVideoInputs: false,
    session: {},
    config: {},
    baseUrl: 'https://api.openai.com/v1',
    provider: {},
    signal: new AbortController().signal,
    callAnthropicWithTools: async () => {
      throw new Error('unused')
    },
    callOpenAIWithTools: async () => {
      attempts += 1
      if (attempts === 1) {
        throw new Error('openai tools 请求超时（>45s）')
      }
      return {
        text: 'timeout-recovered',
        toolCalls: [],
        stopReason: 'stop',
      }
    },
    onBeforeRetry: async (result, attempt) => {
      retrySignals.push(`${result.kind}:${attempt}`)
    },
    buildVideoFrameFallbackMessages: async () => [],
    assignFallbackMessages: () => {},
  })

  assert.equal(attempts, 2)
  assert.deepEqual(retrySignals, ['timeout_model:1'])
  assert.equal(response.text, 'timeout-recovered')
})

test('ExecutionLoopOrchestrator converts tool timeouts into tool results instead of aborting the whole batch', async () => {
  const orchestrator = new ExecutionLoopOrchestrator({ log: () => {} })

  const result = await orchestrator.executeToolCalls({
    toolCalls: [
      { id: '1', name: 'skill_video_expert_ai_analyze', input: {} },
      { id: '2', name: 'memory_search', input: {} },
    ],
    executeTool: async (toolCall) => {
      if (toolCall.id === '1') {
        throw new Error('Tool execution timed out after 120000ms (skill_video_expert_ai_analyze)')
      }
      return 'memory_search:ok'
    },
  })

  assert.equal(result.budgetLimited, false)
  assert.deepEqual(result.results.map((item) => item.id), ['1', '2'])
  assert.equal(result.results[0].result.shape, 'json')
  assert.match(result.results[0].result.text, /timed out/i)
  assert.equal(result.results[0].result.data?.errorKind, 'timeout_tool')
  assert.equal(result.results[1].result.text, 'memory_search:ok')
})
