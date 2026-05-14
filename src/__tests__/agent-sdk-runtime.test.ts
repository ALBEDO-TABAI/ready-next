import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isReadyAgentSdkRuntimeEnabled,
  resolveReadyAgentRuntimeKind,
} from '../main/modules/agent-control/agent-sdk-feature-flag'
import {
  AgentSdkRuntime,
  canUseReadyAgentSdkForConfig,
  type AgentSdkRuntimeDeps,
} from '../main/modules/agent-control/agent-sdk-runtime'
import type { ToolDefinition } from '../main/modules/agent-control/tool-definition'
import { createToolExecutionOutput } from '../main/modules/agent-control/tool-result-types'
import {
  authorizeMcpToolForScope,
  registerMcpServer,
  __resetMcpRegistryForTests,
} from '../main/modules/mcp/registry'
import {
  setCachedMcpOAuthToken,
  __resetMcpOAuthForTests,
} from '../main/modules/mcp/oauth'
import {
  clearLastReferenceSkill,
  rememberLastReferenceSkill,
} from '../main/modules/agent-control/skill-reference-hints'
import { __setSkillActionToolDefsForTests } from '../main/modules/tools/skills-tools'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const fakeConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-test',
} as const

test('agent sdk runtime declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'agent-sdk-runtime transitive sqlite load')
})

function createRuntime(deps: Partial<AgentSdkRuntimeDeps>): AgentSdkRuntime {
  return new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    domainAdapters: [],
    ...deps,
  })
}

function createToolDefinition(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'web_search',
    groupId: 'general_research',
    domain: 'general_research',
    kind: 'read',
    concurrency: 'parallel_read_safe',
    interruptBehavior: 'abort_signal',
    timeoutProfile: 'default',
    supportsTextBridge: true,
    projectionHint: { emitsProjectionPatch: true },
    description: 'Test tool',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    executionVisibility: 'model',
    resultShape: 'json',
    ...overrides,
  }
}

test('agent sdk runtime defaults to SDK and keeps direct as an explicit escape hatch', () => {
  assert.equal(resolveReadyAgentRuntimeKind({}), 'sdk')
  assert.equal(resolveReadyAgentRuntimeKind({ READY_AGENT_SDK_RUNTIME: '1' }), 'sdk')
  assert.equal(resolveReadyAgentRuntimeKind({ READY_AGENT_SDK_RUNTIME: 'off' }), 'direct')
  assert.equal(resolveReadyAgentRuntimeKind({ READY_AGENT_RUNTIME: 'sdk' }), 'sdk')
  assert.equal(resolveReadyAgentRuntimeKind({ READY_AGENT_RUNTIME: 'direct', READY_AGENT_SDK_RUNTIME: '1' }), 'direct')
  assert.equal(isReadyAgentSdkRuntimeEnabled({ READY_AGENT_SDK_RUNTIME: 'true' }), true)
})

test('agent sdk runtime claims OpenAI and Anthropic protocol provider configs', () => {
  assert.equal(canUseReadyAgentSdkForConfig(fakeConfig), true)
  assert.equal(canUseReadyAgentSdkForConfig({
    ...fakeConfig,
    provider: 'openai-compatible',
    baseUrl: 'https://custom.example/v1',
    agentProtocol: 'openai',
  }), true)
  assert.equal(canUseReadyAgentSdkForConfig({
    ...fakeConfig,
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    agentProtocol: 'anthropic',
  }), true)
  assert.equal(canUseReadyAgentSdkForConfig({
    ...fakeConfig,
    provider: 'openai-compatible',
    baseUrl: 'https://custom.example/v1/messages',
    agentProtocol: 'anthropic',
  }), true)
  assert.equal(canUseReadyAgentSdkForConfig(null), false)
})

test('agent sdk runtime streams text and closes with terminal reason', async () => {
  const events: Array<Record<string, unknown>> = []
  const runtime = createRuntime({
    runAgent: async ({ onTextDelta }) => {
      onTextDelta('你好')
      onTextDelta('，已完成')
      return { finalText: '你好，已完成' }
    },
  })
  runtime.on('output', (event) => events.push({ channel: 'output', ...event }))
  runtime.on('status', (event) => events.push({ channel: 'status', ...event }))
  runtime.newSession('butler::scope-1', 'system prompt')

  const result = await runtime.sendMessage('butler::scope-1', '打个招呼', 'run-1', {
    publicSessionId: 'scope-1',
    taskId: 'task-1',
  })

  assert.equal(result.success, true)
  assert.equal(result.finalText, '你好，已完成')
  assert.equal(result.terminalReason, 'done')
  assert.deepEqual(
    events
      .filter((event) => event.channel === 'output')
      .map((event) => [event.type, event.chunk]),
    [
      ['text', '你好'],
      ['text', '，已完成'],
      ['done', ''],
    ],
  )
  assert.deepEqual(
    events
      .filter((event) => event.channel === 'status')
      .map((event) => [event.status, event.terminalReason]),
    [
      ['working', undefined],
      ['done', 'done'],
    ],
  )
})

test('agent sdk runtime preempts old run and cancels pending renderer actions', async () => {
  let cancelCount = 0
  let firstSignal: AbortSignal | null = null
  const runAgentQueue: NonNullable<AgentSdkRuntimeDeps['runAgent']>[] = [
    ({ signal }) => {
      firstSignal = signal
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('process_restarted')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    },
    async ({ onTextDelta }) => {
      onTextDelta('第二轮完成')
      return { finalText: '第二轮完成' }
    },
  ]
  const runtime = createRuntime({
    runAgent: (params) => {
      const next = runAgentQueue.shift()
      assert.ok(next)
      return next(params)
    },
  })
  runtime.setCancelPendingToolActions(() => {
    cancelCount += 1
  })
  runtime.newSession('butler::scope-2', 'system prompt')

  const first = runtime.sendMessage('butler::scope-2', '第一轮', 'run-old', {
    publicSessionId: 'scope-2',
    taskId: 'task-old',
  })
  const second = await runtime.sendMessage('butler::scope-2', '第二轮', 'run-new', {
    publicSessionId: 'scope-2',
    taskId: 'task-new',
  })
  const firstResult = await first

  assert.equal(firstSignal?.aborted, true)
  assert.equal(cancelCount, 1)
  assert.equal(firstResult.cancelled, true)
  assert.equal(second.success, true)
  assert.equal(second.finalText, '第二轮完成')
})

test('agent sdk runtime exposes Ready tool definitions and preserves structured patches', async () => {
  const toolDefinition = createToolDefinition({ description: 'Search the web' })
  let receivedArgs: Record<string, unknown> | null = null
  const runtime = createRuntime({
    listToolDefinitions: () => [toolDefinition],
    executeToolCall: async (_toolName, args) => {
      receivedArgs = args
      return createToolExecutionOutput('found result', {
        shape: 'json',
        data: { ok: true },
        projectionPatch: {
          taskTitle: 'Research',
          taskSummary: 'Search done',
        },
      })
    },
    runAgent: async ({ tools, onTextDelta }) => {
      assert.equal(tools.length, 1)
      const sdkTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
      const toolOutput = await sdkTool.invoke({}, JSON.stringify({ query: 'OpenAI Agents SDK' }))
      assert.match(toolOutput, /"projectionPatch"/)
      onTextDelta('研究完成')
      return { finalText: '研究完成' }
    },
  })
  runtime.newSession('butler::scope-3', 'system prompt')

  const result = await runtime.sendMessage('butler::scope-3', '查一下最新资料', 'run-tool', {
    publicSessionId: 'scope-3',
    taskId: 'task-tool',
  })

  assert.deepEqual(receivedArgs, { query: 'OpenAI Agents SDK' })
  assert.deepEqual(result.usedTools, ['web_search'])
  assert.equal(result.taskType, 'research')
  assert.deepEqual(result.projectionTruth?.projectionPatch, {
    taskTitle: 'Research',
    taskSummary: 'Search done',
  })
})

test('agent sdk runtime emits tool trace truth and registers run cleanup', async () => {
  const toolDefinition = createToolDefinition({ description: 'Search the web' })
  const outputEvents: Array<Record<string, unknown>> = []
  const scopeEvents: Array<Record<string, unknown>> = []
  const cleanups: Array<{ runId: string; cleanup: () => void | Promise<void> }> = []
  const runtime = createRuntime({
    listToolDefinitions: () => [toolDefinition],
    executeToolCall: async (_toolName, _args, context) => {
      context.registerRunCleanup?.(() => undefined)
      return createToolExecutionOutput('found result', {
        shape: 'json',
        data: { ok: true },
        projectionPatch: {
          taskTitle: 'Research',
          taskSummary: 'Search done',
        },
      })
    },
    runAgent: async ({ tools, onTextDelta }) => {
      const sdkTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
      await sdkTool.invoke({}, JSON.stringify({ query: 'Agents SDK' }))
      onTextDelta('研究完成')
      return { finalText: '研究完成' }
    },
  })
  runtime.setRunCleanupRegistry({
    registerRunCleanup: (runId, cleanup) => {
      cleanups.push({ runId, cleanup })
    },
  })
  runtime.setRuntime({
    getConversationScope: () => null,
    publishScopeRunEvent: (payload: unknown, projectionTruth?: unknown) => {
      scopeEvents.push({ payload, projectionTruth })
    },
  } as never)
  runtime.on('output', (event) => outputEvents.push(event))
  runtime.newSession('butler::scope-host', 'system prompt')

  const result = await runtime.sendMessage('butler::scope-host', '查一下资料', 'run-host', {
    publicSessionId: 'scope-host',
    taskId: 'task-host',
  })

  assert.equal(result.success, true)
  assert.equal(result.finalText, '研究完成')
  assert.deepEqual(result.usedTools, ['web_search'])
  assert.equal(result.terminalReason, 'done')
  assert.equal(cleanups.length, 1)
  assert.equal(cleanups[0].runId, 'run-host')
  assert.deepEqual(result.projectionTruth?.projectionPatch, {
    taskTitle: 'Research',
    taskSummary: 'Search done',
  })
  assert.deepEqual(
    outputEvents
      .filter((entry) => entry.type === 'tool_use' || entry.type === 'tool_result')
      .map((entry) => entry.type),
    ['tool_use', 'tool_result'],
  )
  assert.deepEqual(
    scopeEvents.map((entry) => (entry.payload as { phase?: string; toolEvent?: { kind?: string } }).toolEvent?.kind),
    ['call', 'result'],
  )
  assert.deepEqual(
    scopeEvents.map((entry) => (entry.payload as { phase?: string }).phase),
    ['tool_running', 'responding'],
  )
})

test('agent sdk runtime uses Ready Anthropic model adapter with SDK tool loop', async () => {
  const toolDefinition = createToolDefinition({ description: 'Search the web' })
  const requests: Array<Record<string, unknown>> = []
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({
      ok: true,
      reason: 'present',
      config: {
        ...fakeConfig,
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-haiku-3-5-20241022',
        agentProtocol: 'anthropic',
      },
    }),
    listToolDefinitions: () => [toolDefinition],
    executeToolCall: async () => createToolExecutionOutput('found result', {
      shape: 'json',
      data: { ok: true },
      projectionPatch: { taskTitle: 'Research' },
    }),
    fetchWithTimeout: async (url, init) => {
      requests.push({
        url,
        body: JSON.parse(String(init.body || '{}')) as Record<string, unknown>,
      })
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          id: 'msg-1',
          content: [{
            type: 'tool_use',
            id: 'toolu-1',
            name: 'web_search',
            input: { query: 'Agents SDK' },
          }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 3 },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({
        id: 'msg-2',
        content: [{ type: 'text', text: '研究完成' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 4 },
      }), { status: 200 })
    },
  })
  runtime.newSession('butler::scope-anthropic', 'system prompt')

  const result = await runtime.sendMessage('butler::scope-anthropic', '查一下资料', 'run-anthropic', {
    publicSessionId: 'scope-anthropic',
    taskId: 'task-anthropic',
  })

  assert.equal(result.success, true)
  assert.equal(result.finalText, '研究完成')
  assert.deepEqual(result.usedTools, ['web_search'])
  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, 'https://api.anthropic.com/v1/messages')
  assert.ok(Array.isArray((requests[0].body as { tools?: unknown[] }).tools))
  assert.match(JSON.stringify((requests[1].body as { messages?: unknown[] }).messages), /function_call_result|tool_result|found result/)
  assert.deepEqual(result.projectionTruth?.projectionPatch, { taskTitle: 'Research' })
})

test('agent sdk runtime uses Ready OpenAI-compatible adapter and provider patchers', async () => {
  const toolDefinition = createToolDefinition({ description: 'Search the web' })
  const requests: Array<Record<string, unknown>> = []
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({
      ok: true,
      reason: 'present',
      config: {
        ...fakeConfig,
        provider: 'openai-compatible',
        baseUrl: 'https://compat.example/v1',
        model: 'compat-chat',
        agentProtocol: 'openai',
        wireApi: 'chat/completions',
        toolUseMode: 'on',
      },
    }),
    listToolDefinitions: () => [toolDefinition],
    executeToolCall: async () => createToolExecutionOutput('found result', {
      shape: 'json',
      data: { ok: true },
      projectionPatch: { taskTitle: 'Compatible research' },
    }),
    fetchWithTimeout: async (url, init) => {
      requests.push({
        url,
        body: JSON.parse(String(init.body || '{}')) as Record<string, unknown>,
      })
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          id: 'chatcmpl-1',
          choices: [{
            message: {
              tool_calls: [{
                id: 'call-compat-1',
                type: 'function',
                function: {
                  name: 'web_search',
                  arguments: JSON.stringify({ query: 'Agents SDK' }),
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({
        id: 'chatcmpl-2',
        choices: [{
          message: { content: '兼容端完成' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      }), { status: 200 })
    },
  })
  runtime.newSession('butler::scope-compatible', 'system prompt')

  const result = await runtime.sendMessage('butler::scope-compatible', '查一下资料', 'run-compatible', {
    publicSessionId: 'scope-compatible',
    taskId: 'task-compatible',
  })

  assert.equal(result.success, true)
  assert.equal(result.finalText, '兼容端完成')
  assert.deepEqual(result.usedTools, ['web_search'])
  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, 'https://compat.example/v1/chat/completions')
  assert.equal((requests[0].body as { stream_usage?: boolean }).stream_usage, true)
  assert.deepEqual((requests[0].body as { stream_options?: Record<string, unknown> }).stream_options, {
    include_usage: true,
  })
  assert.match(JSON.stringify((requests[1].body as { messages?: unknown[] }).messages), /function_call_result|found result|tool/)
  assert.deepEqual(result.projectionTruth?.projectionPatch, { taskTitle: 'Compatible research' })
})

test('agent sdk runtime carries compatible reasoning content across tool turns', async () => {
  const toolDefinition = createToolDefinition({
    name: 'file_locate',
    groupId: 'file',
    domain: 'file',
    kind: 'read',
    description: 'Locate a referenced file',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  })
  const requests: Array<Record<string, unknown>> = []
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({
      ok: true,
      reason: 'present',
      config: {
        ...fakeConfig,
        provider: 'openai-compatible',
        baseUrl: 'https://token-plan-sgp.xiaomimimo.com/anthropic',
        model: 'mimo-v2.5',
        agentProtocol: 'openai',
        wireApi: 'chat/completions',
        toolUseMode: 'on',
        thinkingMode: 'on',
      },
    }),
    listToolDefinitions: () => [toolDefinition],
    executeToolCall: async () => createToolExecutionOutput('定位失败：path_missing', {
      shape: 'json',
      data: { ok: false, error: 'path_missing' },
    }),
    fetchWithTimeout: async (url, init) => {
      requests.push({
        url,
        body: JSON.parse(String(init.body || '{}')) as Record<string, unknown>,
      })
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          id: 'chatcmpl-mimo-1',
          choices: [{
            message: {
              content: '',
              reasoning_content: '需要先定位文件中的第 2、3 章。',
              tool_calls: [{
                id: 'call-mimo-1',
                type: 'function',
                function: {
                  name: 'file_locate',
                  arguments: JSON.stringify({ query: '白痴.md' }),
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }), { status: 200 })
      }
      const body = requests[1].body as { messages?: Array<Record<string, unknown>> }
      const toolTurn = body.messages?.find((message) => (
        message.role === 'assistant' && Array.isArray(message.tool_calls)
      ))
      assert.equal(toolTurn?.reasoning_content, '需要先定位文件中的第 2、3 章。')
      return new Response(JSON.stringify({
        id: 'chatcmpl-mimo-2',
        choices: [{
          message: { content: '我没找到该文件，请重新选择附件。' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
      }), { status: 200 })
    },
  })
  runtime.newSession('butler::scope-mimo', 'system prompt')

  const result = await runtime.sendMessage('butler::scope-mimo', '读取白痴.md', 'run-mimo', {
    publicSessionId: 'scope-mimo',
    taskId: 'task-mimo',
  })

  assert.equal(result.success, true)
  assert.equal(result.finalText, '我没找到该文件，请重新选择附件。')
  assert.deepEqual(result.usedTools, ['file_locate'])
  assert.equal(requests.length, 2)
})

test('agent sdk runtime honors Ready OpenAI-compatible responses wire API', async () => {
  const requests: Array<Record<string, unknown>> = []
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({
      ok: true,
      reason: 'present',
      config: {
        ...fakeConfig,
        provider: 'fox',
        baseUrl: 'https://code.newcli.com/codex/v1',
        model: 'gpt-5.4',
        agentProtocol: 'openai',
        wireApi: 'responses',
      },
    }),
    fetchWithTimeout: async (url, init) => {
      requests.push({
        url,
        body: JSON.parse(String(init.body || '{}')) as Record<string, unknown>,
      })
      return new Response(JSON.stringify({
        id: 'resp-1',
        status: 'completed',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'responses 完成' }],
        }],
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      }), { status: 200 })
    },
  })
  runtime.newSession('butler::scope-responses', 'system prompt')

  const result = await runtime.sendMessage('butler::scope-responses', '你好', 'run-responses', {
    publicSessionId: 'scope-responses',
    taskId: 'task-responses',
  })

  assert.equal(result.success, true)
  assert.equal(result.finalText, 'responses 完成')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://code.newcli.com/codex/v1/responses')
  assert.equal((requests[0].body as { stream?: boolean }).stream, false)
})

test('agent sdk runtime forwards renderer-mediated tool requests', async () => {
  const toolDefinition = createToolDefinition({
    name: 'document_set_content',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Set document content',
    schema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['tabId', 'content'],
      additionalProperties: false,
    },
  })
  const rendererRequests: Array<Record<string, unknown>> = []
  const runtime = createRuntime({
    listToolDefinitions: () => [toolDefinition],
    executeToolCall: async (_toolName, args, context) => {
      const requestModuleToolAction = (
        context as {
          requestModuleToolAction?: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
        }
      ).requestModuleToolAction
      assert.ok(requestModuleToolAction)
      const rendererResult = await requestModuleToolAction('document_set_content', args)
      return createToolExecutionOutput('document updated', {
        shape: 'json',
        data: rendererResult,
        projectionPatch: { taskTitle: 'Document update' },
      })
    },
    runAgent: async ({ tools, onTextDelta }) => {
      const sdkTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
      const toolOutput = await sdkTool.invoke({}, JSON.stringify({
        tabId: 'tab-1',
        content: 'hello',
      }))
      assert.match(toolOutput, /"rendererOk":true/)
      onTextDelta('文档已更新')
      return { finalText: '文档已更新' }
    },
  })
  runtime.setRendererToolActionRequester(async (payload) => {
    rendererRequests.push(payload)
    return { rendererOk: true }
  })
  runtime.newSession('butler::scope-renderer', 'system prompt')

  const result = await runtime.sendMessage('butler::scope-renderer', '更新文档', 'run-renderer', {
    publicSessionId: 'scope-renderer',
    taskId: 'task-renderer',
  })

  assert.equal(result.success, true)
  assert.equal(result.taskType, 'multi_step_task')
  assert.deepEqual(rendererRequests, [{
    agent: 'butler::scope-renderer',
    sessionId: 'scope-renderer',
    runId: 'run-renderer',
    tool: 'document_set_content',
    args: {
      tabId: 'tab-1',
      content: 'hello',
    },
  }])
  assert.deepEqual(result.projectionTruth?.projectionPatch, { taskTitle: 'Document update' })
})

test('agent sdk runtime preserves structured tool validation errors', async () => {
  const toolDefinition = createToolDefinition({
    name: 'rss_fetch_updates',
    groupId: 'rss',
    domain: 'rss',
    description: 'Fetch RSS updates',
  })
  let toolOutput = ''
  const runtime = createRuntime({
    listToolDefinitions: () => [toolDefinition],
    executeToolCall: async () => createToolExecutionOutput('输入参数不完整', {
      shape: 'json',
      data: {
        errorKind: 'input_validation',
        detail: 'query is required',
      },
    }),
    runAgent: async ({ tools, onTextDelta }) => {
      const sdkTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
      toolOutput = await sdkTool.invoke({}, JSON.stringify({}))
      onTextDelta('需要补充参数')
      return { finalText: '需要补充参数' }
    },
  })
  runtime.newSession('butler::scope-validation', 'system prompt')

  const result = await runtime.sendMessage('butler::scope-validation', '更新 RSS', 'run-validation', {
    publicSessionId: 'scope-validation',
    taskId: 'task-validation',
  })

  assert.equal(result.success, true)
  assert.deepEqual(result.usedTools, ['rss_fetch_updates'])
  assert.match(toolOutput, /"errorKind":"input_validation"/)
  assert.match(toolOutput, /"detail":"query is required"/)
})

test('agent sdk runtime executes representative domain tools without losing projection truth', async () => {
  const cases: Array<{
    label: string
    tool: Partial<ToolDefinition> & { name: string }
    expectedTaskType: 'multi_step_task' | 'research'
  }> = [
    {
      label: 'browser',
      tool: { name: 'browser_read_page', groupId: 'browser_interaction', domain: 'browser', kind: 'read' },
      expectedTaskType: 'multi_step_task',
    },
    {
      label: 'rss',
      tool: { name: 'rss_analyze_item', groupId: 'rss', domain: 'rss', kind: 'read' },
      expectedTaskType: 'multi_step_task',
    },
    {
      label: 'calendar',
      tool: { name: 'calendar_create_event', groupId: 'calendar', domain: 'calendar', kind: 'write' },
      expectedTaskType: 'multi_step_task',
    },
    {
      label: 'feishu',
      tool: { name: 'feishu_message_reply', groupId: 'channel_feishu', domain: 'feishu', kind: 'write' },
      expectedTaskType: 'multi_step_task',
    },
    {
      label: 'pet',
      tool: { name: 'pet_show_sticky_note', groupId: 'pet', domain: 'pet', kind: 'write' },
      expectedTaskType: 'multi_step_task',
    },
    {
      label: 'file',
      tool: { name: 'file_search', groupId: 'file_management', domain: 'file', kind: 'read' },
      expectedTaskType: 'multi_step_task',
    },
    {
      label: 'research',
      tool: { name: 'web_fetch', groupId: 'general_research', domain: 'general_research', kind: 'read' },
      expectedTaskType: 'research',
    },
  ]

  for (const item of cases) {
    const toolDefinition = createToolDefinition({
      description: `${item.label} tool`,
      ...item.tool,
    })
    const runtime = createRuntime({
      listToolDefinitions: () => [toolDefinition],
      executeToolCall: async () => createToolExecutionOutput(`${item.label} done`, {
        shape: 'json',
        projectionPatch: {
          taskTitle: `${item.label} task`,
          taskSummary: `${item.label} finished`,
        },
      }),
      runAgent: async ({ tools, onTextDelta }) => {
        const sdkTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
        await sdkTool.invoke({}, JSON.stringify({ id: item.label }))
        onTextDelta(`${item.label} 完成`)
        return { finalText: `${item.label} 完成` }
      },
    })
    runtime.newSession(`butler::scope-${item.label}`, 'system prompt')

    const result = await runtime.sendMessage(`butler::scope-${item.label}`, `${item.label} task`, `run-${item.label}`, {
      publicSessionId: `scope-${item.label}`,
      taskId: `task-${item.label}`,
    })

    assert.equal(result.success, true, `${item.label} should succeed`)
    assert.deepEqual(result.usedTools, [item.tool.name], `${item.label} used tool`)
    assert.equal(result.taskType, item.expectedTaskType, `${item.label} task type`)
    assert.deepEqual(result.projectionTruth?.projectionPatch, {
      taskTitle: `${item.label} task`,
      taskSummary: `${item.label} finished`,
    })
  }
})

test('agent sdk runtime uses Ready text bridge for non-native tool transports', async () => {
  const toolDefinition = createToolDefinition({ description: 'Search the web' })
  const outputEvents: Array<Record<string, unknown>> = []
  const runInputs: unknown[] = []
  let runCount = 0
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({
      ok: true,
      reason: 'present',
      config: {
        ...fakeConfig,
        provider: 'openai-compatible',
        baseUrl: 'https://code.newcli.com/codex/v1',
        agentProtocol: 'openai',
        wireApi: 'chat/completions',
      },
    }),
    listToolDefinitions: () => [toolDefinition],
    executeToolCall: async (_toolName, args) => createToolExecutionOutput('found result', {
      shape: 'json',
      data: { args },
      projectionPatch: { taskTitle: 'Text bridge research' },
    }),
    runAgent: async ({ tools, instructions, input }) => {
      runCount += 1
      runInputs.push(input)
      assert.equal(tools.length, 0)
      assert.match(instructions, /文本工具桥接/)
      assert.match(instructions, /web_search/)
      if (runCount === 1) {
        return {
          finalText: [
            ':::tool_call',
            '{"tool":"web_search","args":{"query":"Agents SDK"}}',
            ':::',
          ].join('\n'),
        }
      }
      assert.match(String(input), /tool_result/)
      assert.match(String(input), /found result/)
      return { finalText: '研究完成' }
    },
  })
  runtime.on('output', (event) => outputEvents.push(event))
  runtime.newSession('butler::scope-text-bridge', 'system prompt')

  const result = await runtime.sendMessage('butler::scope-text-bridge', '查一下 Agents SDK', 'run-text-bridge', {
    publicSessionId: 'scope-text-bridge',
    taskId: 'task-text-bridge',
  })

  assert.equal(result.success, true)
  assert.equal(result.taskType, 'research')
  assert.equal(result.finalText, '研究完成')
  assert.equal(runInputs.length, 2)
  assert.deepEqual(result.usedTools, ['web_search'])
  assert.deepEqual(result.projectionTruth?.projectionPatch, { taskTitle: 'Text bridge research' })
  assert.equal(
    outputEvents.some((event) => event.type === 'text' && /:::tool_call/.test(String(event.chunk || ''))),
    false,
  )
})

test('agent sdk runtime exposes authorized skill tools for explicit skill turns', async () => {
  const seenToolNames: string[] = []
  let remembered = false
  __setSkillActionToolDefsForTests(() => [
    {
      name: 'skill_video_expert_pipeline',
      description: 'Run VEA pipeline',
      kind: 'skill_action',
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      visibility: 'public',
      params: [],
    },
    {
      name: 'skill_rss_update',
      description: 'Update RSS',
      kind: 'skill_action',
      skillId: 'lets-go-rss',
      action: 'rss_update',
      visibility: 'public',
      params: [],
    },
  ])
  const runtime = createRuntime({
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: () => [{ id: 'video-expert-analyzer', name: 'Video Expert Analyzer' }],
      buildPreferredSkillToolNames: () => ['skill_video_expert_pipeline'],
      rememberExplicitReferenceSkillHint: () => {
        remembered = true
        rememberLastReferenceSkill('scope-skill-tools', {
          id: 'video-expert-analyzer',
          name: 'Video Expert Analyzer',
        })
        return true
      },
    },
    runAgent: async ({ tools, onTextDelta }) => {
      seenToolNames.push(...tools.map((item) => item.name))
      onTextDelta('技能工具面已加载')
      return { finalText: '技能工具面已加载' }
    },
  })
  runtime.newSession('butler::scope-skill-tools', 'system prompt')

  try {
    const result = await runtime.sendMessage('butler::scope-skill-tools', '使用 video expert analyzer 分析视频', 'run-skill-tools', {
      publicSessionId: 'scope-skill-tools',
      taskId: 'task-skill-tools',
    })

    assert.equal(result.success, true)
    assert.equal(remembered, true)
    assert.equal(seenToolNames.includes('skill_video_expert_pipeline'), true)
    assert.equal(seenToolNames.includes('skill_run_shell'), true)
    assert.equal(seenToolNames.includes('skill_inspect_run_state'), true)
    assert.equal(seenToolNames.includes('skill_rss_update'), false)
  } finally {
    __setSkillActionToolDefsForTests(null)
    clearLastReferenceSkill('scope-skill-tools')
  }
})

test('agent sdk runtime threads selected skill authorization into tool execution', async () => {
  const skillDefinition = createToolDefinition({
    name: 'skill_video_expert_pipeline',
    groupId: 'skills',
    domain: 'skill',
    kind: 'job',
    description: 'Run VEA pipeline',
  })
  let listAuthorizationMode: string | null = null
  let executionAuthorization: Record<string, unknown> | null = null
  const runtime = createRuntime({
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: () => [{ id: 'video-expert-analyzer', name: 'Video Expert Analyzer' }],
      buildPreferredSkillToolNames: () => ['skill_video_expert_pipeline'],
    },
    listToolDefinitions: ({ authorization }) => {
      listAuthorizationMode = authorization.mode
      return [skillDefinition]
    },
    executeToolCall: async (_toolName, _args, context) => {
      executionAuthorization = (context as unknown as { authorization?: Record<string, unknown> }).authorization || null
      return createToolExecutionOutput('skill launched', {
        shape: 'json',
        projectionPatch: { taskTitle: 'VEA' },
      })
    },
    runAgent: async ({ tools, onTextDelta }) => {
      const sdkTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
      await sdkTool.invoke({}, JSON.stringify({ input: 'video.mp4' }))
      onTextDelta('技能已启动')
      return { finalText: '技能已启动' }
    },
  })
  runtime.newSession('butler::scope-skill-auth', 'system prompt')

  const result = await runtime.sendMessage('butler::scope-skill-auth', '使用 video expert analyzer', 'run-skill-auth', {
    publicSessionId: 'scope-skill-auth',
    taskId: 'task-skill-auth',
  })

  assert.equal(result.success, true)
  assert.equal(result.taskType, 'multi_step_task')
  assert.equal(listAuthorizationMode, 'selected')
  assert.equal(executionAuthorization?.mode, 'selected')
  assert.equal(executionAuthorization?.skillId, 'video-expert-analyzer')
  assert.deepEqual(result.usedTools, ['skill_video_expert_pipeline'])
  assert.deepEqual(result.projectionTruth?.projectionPatch, { taskTitle: 'VEA' })
})

test('agent sdk runtime reports provider quota failures as external blockers', async () => {
  const errors: Array<Record<string, unknown>> = []
  const statuses: Array<Record<string, unknown>> = []
  const runtime = createRuntime({
    runAgent: async () => {
      throw new Error('429 You exceeded your current quota')
    },
  })
  runtime.on('error', (event) => errors.push(event))
  runtime.on('status', (event) => statuses.push(event))
  runtime.newSession('butler::scope-provider-error', 'system prompt')

  const result = await runtime.sendMessage('butler::scope-provider-error', '你好', 'run-provider-error', {
    publicSessionId: 'scope-provider-error',
    taskId: 'task-provider-error',
  })

  assert.equal(result.success, false)
  assert.equal(result.terminalReason, 'blocked_external')
  assert.equal(errors[0]?.errorKind, 'blocked_external')
  assert.deepEqual(
    statuses.map((event) => [event.status, event.terminalReason]),
    [
      ['working', undefined],
      ['error', 'blocked_external'],
    ],
  )
})

test('agent sdk runtime inherits Ready model-visible tool surface', async () => {
  const seenToolNames: string[] = []
  const runtime = createRuntime({
    runAgent: async ({ tools, onTextDelta }) => {
      seenToolNames.push(...tools.map((item) => item.name))
      onTextDelta('工具面已加载')
      return { finalText: '工具面已加载' }
    },
  })
  runtime.newSession('butler::scope-tools', 'system prompt')

  const result = await runtime.sendMessage('butler::scope-tools', '整理这篇文档并查一下资料', 'run-tools', {
    publicSessionId: 'scope-tools',
    taskId: 'task-tools',
  })

  assert.equal(result.success, true)
  assert.ok(seenToolNames.includes('document_set_content'))
  assert.ok(seenToolNames.includes('rss_fetch_updates'))
  assert.ok(seenToolNames.includes('calendar_list_window'))
  assert.ok(seenToolNames.includes('web_search'))
  assert.equal(seenToolNames.some((name) => name.startsWith('browser_')), false)
})

test('agent sdk runtime exposes browser, feishu, file, pet, and research tools when runtime is available', async () => {
  const seenToolNames: string[] = []
  const runtime = createRuntime({
    runAgent: async ({ tools, onTextDelta }) => {
      seenToolNames.push(...tools.map((item) => item.name))
      onTextDelta('工具面已加载')
      return { finalText: '工具面已加载' }
    },
  })
  runtime.setBrowserController({} as never)
  runtime.setRuntime({
    isChannelTypeAvailable: (channelType: string) => channelType === 'feishu-app',
    getConversationScope: () => null,
  } as never)
  runtime.newSession('butler::scope-domain-tools', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-domain-tools',
    '打开网页搜索资料，点击并输入内容，同时回复飞书，找文件，给宠物贴一条提醒',
    'run-domain-tools',
    {
      publicSessionId: 'scope-domain-tools',
      taskId: 'task-domain-tools',
    },
  )

  assert.equal(result.success, true)
  for (const expected of [
    'browser_navigate',
    'browser_read_page',
    'browser_click',
    'browser_type',
    'browser_start_task',
    'feishu_message_reply',
    'file_search',
    'pet_show_sticky_note',
    'web_search',
    'web_fetch',
    'present_file',
  ]) {
    assert.ok(seenToolNames.includes(expected), `${expected} should be SDK-visible`)
  }
})

test('agent sdk runtime exposes upload browser tools for upload workflow intent', async () => {
  const seenToolNames: string[] = []
  const runtime = createRuntime({
    runAgent: async ({ tools, onTextDelta }) => {
      seenToolNames.push(...tools.map((item) => item.name))
      onTextDelta('上传工具面已加载')
      return { finalText: '上传工具面已加载' }
    },
  })
  runtime.setBrowserController({} as never)
  runtime.newSession('butler::scope-upload-tools', 'system prompt')

  const result = await runtime.sendMessage('butler::scope-upload-tools', '把这个附件上传到当前网页并提交', 'run-upload-tools', {
    publicSessionId: 'scope-upload-tools',
    taskId: 'task-upload-tools',
  })

  assert.equal(result.success, true)
  assert.ok(seenToolNames.includes('browser_list_upload_targets'))
  assert.ok(seenToolNames.includes('browser_upload_scope_attachment'))
  assert.equal(seenToolNames.includes('browser_start_task'), false)
})

test('agent sdk runtime keeps MCP tools scoped to explicit OAuth authorization', async () => {
  __resetMcpRegistryForTests()
  __resetMcpOAuthForTests()
  registerMcpServer({
    serverId: 'sdk-scope',
    toolNames: ['mcp_sdk_scope_action'],
    requiresAuthorization: true,
  })
  setCachedMcpOAuthToken('sdk-scope', {
    accessToken: 'tok-sdk',
    expiresAt: Date.now() + 60_000,
    scopes: ['read'],
  })
  authorizeMcpToolForScope('sdk-scope', 'mcp_sdk_scope_action', 'scope-allowed', 'scope-allowed')

  const seenByScope = new Map<string, string[]>()
  const runtime = createRuntime({
    runAgent: async ({ tools, onTextDelta, sessionId }) => {
      seenByScope.set(sessionId || '', tools.map((item) => item.name))
      onTextDelta('MCP 工具面已加载')
      return { finalText: 'MCP 工具面已加载' }
    },
  })

  runtime.newSession('butler::scope-allowed', 'system prompt')
  const allowed = await runtime.sendMessage('butler::scope-allowed', '使用已授权的 MCP 工具', 'run-mcp-allowed', {
    publicSessionId: 'scope-allowed',
    taskId: 'task-mcp-allowed',
  })
  runtime.newSession('butler::scope-denied', 'system prompt')
  const denied = await runtime.sendMessage('butler::scope-denied', '使用未授权的 MCP 工具', 'run-mcp-denied', {
    publicSessionId: 'scope-denied',
    taskId: 'task-mcp-denied',
  })

  assert.equal(allowed.success, true)
  assert.equal(denied.success, true)
  assert.equal(seenByScope.get('scope-allowed')?.includes('mcp_sdk_scope_action'), true)
  assert.equal(seenByScope.get('scope-denied')?.includes('mcp_sdk_scope_action'), false)

  __resetMcpRegistryForTests()
  __resetMcpOAuthForTests()
})

test('agent sdk runtime gates vision tools with resolved provider capability', async () => {
  __resetMcpRegistryForTests()
  registerMcpServer({
    serverId: 'sdk-vision',
    toolNames: ['view_image', 'mcp_plain_text_action'],
    requiresAuthorization: false,
  })

  const seenToolNames: string[] = []
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({
      ok: true,
      reason: 'present',
      config: {
        ...fakeConfig,
        model: 'o3-mini',
        visionMode: 'off',
      },
    }),
    runAgent: async ({ tools, onTextDelta }) => {
      seenToolNames.push(...tools.map((item) => item.name))
      onTextDelta('视觉工具检查完成')
      return { finalText: '视觉工具检查完成' }
    },
  })
  runtime.newSession('butler::scope-vision-gate', 'system prompt')

  try {
    const result = await runtime.sendMessage('butler::scope-vision-gate', '看一下图片并总结', 'run-vision-gate', {
      publicSessionId: 'scope-vision-gate',
      taskId: 'task-vision-gate',
    })

    assert.equal(result.success, true)
    assert.equal(seenToolNames.includes('mcp_plain_text_action'), true)
    assert.equal(seenToolNames.includes('view_image'), false)
  } finally {
    __resetMcpRegistryForTests()
  }
})

test('agent sdk runtime does not leak host-only or unauthorized skill tools by default', async () => {
  const seenToolNames: string[] = []
  const runtime = createRuntime({
    runAgent: async ({ tools, onTextDelta }) => {
      seenToolNames.push(...tools.map((item) => item.name))
      onTextDelta('工具检查完成')
      return { finalText: '工具检查完成' }
    },
  })
  runtime.newSession('butler::scope-internal-tools', 'system prompt')

  const result = await runtime.sendMessage('butler::scope-internal-tools', '看看可用能力', 'run-internal-tools', {
    publicSessionId: 'scope-internal-tools',
    taskId: 'task-internal-tools',
  })

  assert.equal(result.success, true)
  assert.equal(seenToolNames.includes('system_run_openclaw'), false)
  assert.equal(seenToolNames.includes('system_run_embedded_python'), false)
  assert.equal(seenToolNames.includes('skill_run_shell'), false)
  assert.equal(seenToolNames.includes('skill_patch_config'), false)
})
