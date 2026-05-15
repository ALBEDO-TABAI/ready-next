import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  AgentSdkRuntime,
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

test('agent sdk runtime buffers native text before recovering XML tool calls', async () => {
  const toolDefinition = createToolDefinition({ description: 'Search the web' })
  const outputEvents: Array<Record<string, unknown>> = []
  const calls: Array<Record<string, unknown>> = []
  let runCount = 0
  const runtime = createRuntime({
    loadAIConfig: () => ({
      ok: true,
      reason: 'present',
      config: {
        ...fakeConfig,
        provider: 'openai-compatible',
        baseUrl: 'https://token-plan-sgp.xiaomimimo.com/anthropic',
        model: 'mimo-v2.5',
        agentProtocol: 'anthropic',
      },
    }),
    listToolDefinitions: () => [toolDefinition],
    executeToolCall: async (_toolName, args) => {
      calls.push(args)
      return createToolExecutionOutput('found result', {
        shape: 'json',
        data: { ok: true },
      })
    },
    runAgent: async ({ onTextDelta }) => {
      runCount += 1
      if (runCount === 1) {
        const leaked = [
          'Now I will search.',
          '<tool_call>',
          '<function=web_search>',
          '<parameter=query>OpenAI Agents SDK</parameter>',
          '</function>',
          '</tool_call>',
        ].join('\n')
        onTextDelta(leaked)
        return { finalText: leaked }
      }
      onTextDelta('研究完成')
      return { finalText: '研究完成' }
    },
  })
  runtime.on('output', (event) => outputEvents.push(event))
  runtime.newSession('butler::scope-xml-buffer', 'system prompt')

  const result = await runtime.sendMessage('butler::scope-xml-buffer', '查一下资料', 'run-xml-buffer', {
    publicSessionId: 'scope-xml-buffer',
    taskId: 'task-xml-buffer',
  })

  assert.equal(result.success, true)
  assert.equal(runCount, 2)
  assert.deepEqual(calls, [{ query: 'OpenAI Agents SDK' }])
  const visibleText = outputEvents
    .filter((event) => event.type === 'text')
    .map((event) => String(event.chunk || ''))
    .join('\n')
  assert.doesNotMatch(visibleText, /<tool_call>|<function=|<parameter=/)
  assert.doesNotMatch(visibleText, /Now I will search/)
  assert.match(visibleText, /研究完成/)
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

test('agent sdk runtime carries anthropic thinking blocks across tool turns', async () => {
  const toolDefinition = createToolDefinition({
    name: 'file_locate',
    groupId: 'file',
    domain: 'file',
    kind: 'read',
    description: 'Locate a referenced file',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
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
        agentProtocol: 'anthropic',
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
          id: 'msg-mimo-anthropic-1',
          role: 'assistant',
          type: 'message',
          content: [
            {
              type: 'thinking',
              thinking: '需要先定位文件中的第 2、3 章。',
              signature: 'thinking-signature-1',
            },
            {
              type: 'tool_use',
              id: 'call-mimo-anthropic-1',
              name: 'file_locate',
              input: { path: '白痴.md' },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 4 },
        }), { status: 200 })
      }
      const body = requests[1].body as { messages?: Array<Record<string, unknown>> }
      const assistantTurn = body.messages?.find((message) => (
        message.role === 'assistant' && Array.isArray(message.content)
      ))
      const content = assistantTurn?.content as Array<Record<string, unknown>> | undefined
      assert.equal(content?.[0]?.type, 'thinking')
      assert.equal(content?.[0]?.thinking, '需要先定位文件中的第 2、3 章。')
      assert.equal(content?.[0]?.signature, 'thinking-signature-1')
      assert.equal(content?.[1]?.type, 'tool_use')
      assert.equal(content?.[1]?.id, 'call-mimo-anthropic-1')
      return new Response(JSON.stringify({
        id: 'msg-mimo-anthropic-2',
        role: 'assistant',
        type: 'message',
        content: [{ type: 'text', text: '我没找到该文件，请重新选择附件。' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 6 },
      }), { status: 200 })
    },
  })
  runtime.newSession('butler::scope-mimo-anthropic', 'system prompt')

  const result = await runtime.sendMessage('butler::scope-mimo-anthropic', '读取白痴.md', 'run-mimo-anthropic', {
    publicSessionId: 'scope-mimo-anthropic',
    taskId: 'task-mimo-anthropic',
  })

  assert.equal(result.success, true)
  assert.equal(result.finalText, '我没找到该文件，请重新选择附件。')
  assert.deepEqual(result.usedTools, ['file_locate'])
  assert.equal(requests.length, 2)
})

test('agent sdk runtime keeps browser tools hidden for local document attachment tasks', async () => {
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
        agentProtocol: 'anthropic',
        toolUseMode: 'on',
      },
    }),
    executeToolCall: async (name) => createToolExecutionOutput(
      name === 'file_read_excerpt' ? '已读取章节正文' : 'ok',
      { shape: 'json', data: { ok: true } },
    ),
    fetchWithTimeout: async (url, init) => {
      const body = JSON.parse(String(init.body || '{}')) as Record<string, unknown>
      requests.push({ url, body })
      const toolNames = Array.isArray(body.tools)
        ? body.tools.map((item) => (item as { name?: string }).name)
        : []
      assert.equal(toolNames.includes('browser_navigate'), false)
      assert.equal(toolNames.includes('browser_click'), false)
      assert.equal(toolNames.includes('web_fetch'), false)
      assert.equal(toolNames.includes('web_search'), false)
      assert.equal(toolNames.includes('present_file'), false)
      assert.ok(
        toolNames.includes('file_locate') ||
          toolNames.some((name) => typeof name === 'string' && name.startsWith('document_')),
      )
      assert.equal(toolNames.includes('file_read_excerpt'), true)
      assert.match(String(body.system || ''), /必须先调用 file_read_excerpt/)
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          id: 'msg-doc-tools-1',
          role: 'assistant',
          type: 'message',
          content: [{
            type: 'tool_use',
            id: 'call-read-excerpt',
            name: 'file_read_excerpt',
            input: { path: '/tmp/白痴.md', anchor: '一' },
          }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 4 },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({
        id: 'msg-doc-tools-2',
        role: 'assistant',
        type: 'message',
        content: [{ type: 'text', text: '我会按文档处理。' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 4 },
      }), { status: 200 })
    },
  })
  runtime.newSession('butler::scope-doc-no-browser', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-doc-no-browser',
    [
      '根据@[白痴.md]前 3 章的内容梳理人物关系',
      '',
      '--- 测试模式附件路径 ---',
      '以下路径来自测试 harness 注入，附件正文里的 https://example.com 或 浏览器 字样不能污染主指令路由。',
      '- 白痴.md: /tmp/白痴.md',
      '- 新文档.md: /tmp/新文档.md',
    ].join('\n'),
    'run-doc-no-browser',
    {
      publicSessionId: 'scope-doc-no-browser',
      taskId: 'task-doc-no-browser',
    },
  )

  assert.equal(result.success, true)
  assert.equal(result.finalText, '我会按文档处理。')
  assert.equal(requests.length, 2)
})

test('agent sdk runtime does not require source excerpts when the only local document is the target', async () => {
  const openDefinition = createToolDefinition({
    name: 'document_open_tab',
    groupId: 'document',
    domain: 'document',
    kind: 'read',
    description: 'Open document',
    schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  })
  const setContentDefinition = createToolDefinition({
    name: 'document_set_content',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Set document content',
    schema: {
      type: 'object',
      properties: { content: { type: 'string' } },
      required: ['content'],
      additionalProperties: false,
    },
  })
  const saveDefinition = createToolDefinition({
    name: 'document_save_tab',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Save document',
    schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  })
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const runtime = createRuntime({
    listToolDefinitions: () => [setContentDefinition, openDefinition, saveDefinition],
    executeToolCall: async (name, args) => {
      calls.push({ name, args })
      return createToolExecutionOutput(
        name === 'document_open_tab'
          ? 'opened target'
          : name === 'document_save_tab'
            ? 'saved target'
            : 'updated target',
        { shape: 'json', data: { ok: true } },
      )
    },
    runAgent: async ({ tools, onTextDelta }) => {
      const setContentTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
      await setContentTool.invoke({}, JSON.stringify({ content: '# B1 渠道销售图表\n\n老客复购最高，线下活动最低。' }))
      onTextDelta('已根据内联数据生成图表文档。')
      return { finalText: '已根据内联数据生成图表文档。' }
    },
  })
  runtime.newSession('butler::scope-target-only-inline-data', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-target-only-inline-data',
    [
      '根据下面这组渠道销售数据，在@[B1-渠道销售图表.md]里做一个清楚的图表，并写一段结论。',
      '搜索广告 128，社交广告 96，内容种草 74，自然流量 112，老客复购 153，线下活动 41。',
      '',
      '--- 附件: B1-渠道销售图表.md ---',
      '- 路径: /tmp/B1-渠道销售图表.md',
    ].join('\n'),
    'run-target-only-inline-data',
    {
      publicSessionId: 'scope-target-only-inline-data',
      taskId: 'task-target-only-inline-data',
      requestEnvelope: {
        primaryInstruction: '根据下面这组渠道销售数据，在@[B1-渠道销售图表.md]里做一个清楚的图表，并写一段结论。',
        resources: [
          { name: 'B1-渠道销售图表.md', path: '/tmp/B1-渠道销售图表.md' },
        ],
      },
    },
  )

  assert.equal(result.success, true)
  assert.deepEqual(calls, [
    { name: 'document_open_tab', args: { path: '/tmp/B1-渠道销售图表.md' } },
    { name: 'document_set_content', args: { content: '# B1 渠道销售图表\n\n老客复购最高，线下活动最低。' } },
    { name: 'document_save_tab', args: {} },
  ])
})

test('agent sdk runtime allows rewrite tasks that preserve meaning without preserving exact old lines', async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'ready-agent-sdk-meaning-'))
  const targetPath = join(tmpRoot, 'E2-提案草稿.md')
  await writeFile(targetPath, '# 草稿\n\n这个方案挺好的，但是有点乱。这个目标要重复说一下，目标是提高报名。\n', 'utf-8')
  try {
    const openDefinition = createToolDefinition({
      name: 'document_open_tab',
      groupId: 'document',
      domain: 'document',
      kind: 'read',
      description: 'Open document',
      schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    })
    const setContentDefinition = createToolDefinition({
      name: 'document_set_content',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Set document content',
      schema: {
        type: 'object',
        properties: { content: { type: 'string' } },
        required: ['content'],
        additionalProperties: false,
      },
    })
    const saveDefinition = createToolDefinition({
      name: 'document_save_tab',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Save document',
      schema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    })
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const runtime = createRuntime({
      listToolDefinitions: () => [setContentDefinition, openDefinition, saveDefinition],
      executeToolCall: async (name, args) => {
        calls.push({ name, args })
        if (name === 'document_set_content') {
          await writeFile(targetPath, String(args.content || ''), 'utf-8')
        }
        return createToolExecutionOutput(
          name === 'document_open_tab'
            ? 'opened target'
            : name === 'document_save_tab'
              ? 'saved target'
              : 'updated target',
          { shape: 'json', data: { ok: true } },
        )
      },
      runAgent: async ({ tools, onTextDelta }) => {
        const setContentTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
        await setContentTool.invoke({}, JSON.stringify({
          content: '# 正式提案\n\n## 目标\n\n通过更清晰的活动方案提升报名转化。',
        }))
        onTextDelta('已改写为正式提案。')
        return { finalText: '已改写为正式提案。' }
      },
    })
    runtime.newSession('butler::scope-doc-preserve-meaning', 'system prompt')

    const result = await runtime.sendMessage(
      'butler::scope-doc-preserve-meaning',
      [
        '把@[E2-提案草稿.md]改得更像正式提案，保留原意，删掉重复内容。',
        '',
        '--- 附件: E2-提案草稿.md ---',
        `- 路径: ${targetPath}`,
      ].join('\n'),
      'run-doc-preserve-meaning',
      {
        publicSessionId: 'scope-doc-preserve-meaning',
        taskId: 'task-doc-preserve-meaning',
        requestEnvelope: {
          primaryInstruction: '把@[E2-提案草稿.md]改得更像正式提案，保留原意，删掉重复内容。',
          resources: [
            { name: 'E2-提案草稿.md', path: targetPath },
          ],
        },
      },
    )

    assert.equal(result.success, true)
    assert.deepEqual(calls.map((call) => call.name), [
      'document_open_tab',
      'document_set_content',
      'document_save_tab',
    ])
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('agent sdk runtime repairs new document turns that mutate without saving', async () => {
  const newTabDefinition = createToolDefinition({
    name: 'document_new_tab',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Create document',
    schema: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    },
  })
  const insertWidgetDefinition = createToolDefinition({
    name: 'document_insert_widget',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Insert widget',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        position: { type: 'string' },
        widgetCode: { type: 'string' },
      },
      required: ['title', 'widgetCode'],
      additionalProperties: false,
    },
  })
  const saveDefinition = createToolDefinition({
    name: 'document_save_tab',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Save document',
    schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  })
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const runInputs: unknown[] = []
  let runCount = 0
  const runtime = createRuntime({
    listToolDefinitions: () => [newTabDefinition, insertWidgetDefinition, saveDefinition],
    executeToolCall: async (name, args) => {
      calls.push({ name, args })
      return createToolExecutionOutput(
        name === 'document_save_tab'
          ? '已另存文档：/tmp/A1-人物关系图.md'
          : name === 'document_new_tab'
            ? '已创建文档标签：A1-人物关系图'
            : '已在文档尾部插入 widget（人物关系图）',
        { shape: 'json', data: { ok: true } },
      )
    },
    runAgent: async ({ tools, input, onTextDelta }) => {
      runInputs.push(input)
      runCount += 1
      const byName = new Map(tools.map((tool) => [tool.name, tool as { invoke: (context: unknown, input: string) => Promise<string> }]))
      if (runCount === 1) {
        await byName.get('document_new_tab')?.invoke({}, JSON.stringify({ title: 'A1-人物关系图' }))
        await byName.get('document_insert_widget')?.invoke({}, JSON.stringify({
          title: '人物关系图',
          position: 'end',
          widgetCode: '{"type":"relationship-map"}',
        }))
        return { finalText: '' }
      }
      assert.match(String(input), /还没有调用 document_save_tab 保存/)
      onTextDelta('我会保存当前文档。')
      return { finalText: '我会保存当前文档。' }
    },
  })
  runtime.newSession('butler::scope-new-doc-save-repair', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-new-doc-save-repair',
    '新建一份《白痴》前 3 章人物关系图文档',
    'run-new-doc-save-repair',
    {
      publicSessionId: 'scope-new-doc-save-repair',
      taskId: 'task-new-doc-save-repair',
    },
  )

  assert.equal(result.success, true)
  assert.equal(runCount, 2)
  assert.match(result.finalText, /已另存文档/)
  assert.match(result.finalText, /我会保存当前文档/)
  assert.deepEqual(calls, [
    { name: 'document_new_tab', args: { title: 'A1-人物关系图' } },
    {
      name: 'document_insert_widget',
      args: { title: '人物关系图', position: 'end', widgetCode: '{"type":"relationship-map"}' },
    },
    { name: 'document_save_tab', args: {} },
  ])
})

test('agent sdk runtime anchors explicit target document instead of exposing new-tab writes', async () => {
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
        agentProtocol: 'anthropic',
        toolUseMode: 'on',
      },
    }),
    fetchWithTimeout: async (url, init) => {
      const body = JSON.parse(String(init.body || '{}')) as Record<string, unknown>
      requests.push({ url, body })
      const toolNames = Array.isArray(body.tools)
        ? body.tools.map((item) => (item as { name?: string }).name)
        : []
      assert.equal(toolNames.includes('document_new_tab'), false)
      assert.equal(toolNames.includes('document_open_tab'), true)
      assert.equal(toolNames.includes('document_save_tab'), true)
      assert.equal(toolNames.includes('web_fetch'), false)
      assert.equal(toolNames.includes('web_search'), false)
      assert.match(String(body.system || ''), /\/tmp\/新文档\.md/)
      assert.match(String(body.system || ''), /不要新建临时文档/)
      return new Response(JSON.stringify({
        id: 'msg-doc-target-1',
        role: 'assistant',
        type: 'message',
        content: [{ type: 'text', text: '会写入目标文档。' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 4 },
      }), { status: 200 })
    },
  })
  runtime.newSession('butler::scope-doc-target', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-doc-target',
    [
      '在@[新文档.md]里写入一段人物关系图占位内容',
      '',
      '--- 附件: 新文档.md ---',
      '- 路径: /tmp/新文档.md',
    ].join('\n'),
    'run-doc-target',
    {
      publicSessionId: 'scope-doc-target',
      taskId: 'task-doc-target',
    },
  )

  assert.equal(result.success, false)
  assert.equal(result.terminalReason, 'blocked_tool_error')
  assert.match(result.error || '', /目标文档/)
  assert.equal(requests.length, 2)
})

test('agent sdk runtime opens explicit target document before the first mutation', async () => {
  const openDefinition = createToolDefinition({
    name: 'document_open_tab',
    groupId: 'document',
    domain: 'document',
    kind: 'read',
    description: 'Open document',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  })
  const setContentDefinition = createToolDefinition({
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
        content: { type: 'string' },
      },
      required: ['content'],
      additionalProperties: false,
    },
  })
  const saveDefinition = createToolDefinition({
    name: 'document_save_tab',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Save document',
    schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  })
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const runtime = createRuntime({
    listToolDefinitions: () => [setContentDefinition, openDefinition, saveDefinition],
    executeToolCall: async (name, args) => {
      calls.push({ name, args })
      return createToolExecutionOutput(
        name === 'document_open_tab'
          ? 'opened target'
          : name === 'document_save_tab'
            ? 'saved target'
            : 'updated target',
        {
        shape: 'json',
        data: { ok: true },
        },
      )
    },
    runAgent: async ({ tools, onTextDelta }) => {
      const setContentTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
      await setContentTool.invoke({}, JSON.stringify({ content: '人物关系图内容', tabId: 'draft-tab' }))
      onTextDelta('已写入目标文档')
      return { finalText: '已写入目标文档' }
    },
  })
  runtime.newSession('butler::scope-doc-auto-open', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-doc-auto-open',
    [
      '在@[新文档.md]里写入一段人物关系图占位内容',
      '',
      '--- 附件: 新文档.md ---',
      '- 路径: /tmp/新文档.md',
    ].join('\n'),
    'run-doc-auto-open',
    {
      publicSessionId: 'scope-doc-auto-open',
      taskId: 'task-doc-auto-open',
      requestEnvelope: {
        primaryInstruction: '在@[新文档.md]里写入一段人物关系图占位内容',
        resources: [
          { name: '新文档.md', path: '/tmp/新文档.md' },
        ],
      },
    },
  )

  assert.equal(result.success, true)
  assert.deepEqual(calls, [
    { name: 'document_open_tab', args: { path: '/tmp/新文档.md' } },
    { name: 'document_set_content', args: { content: '人物关系图内容' } },
    { name: 'document_save_tab', args: {} },
  ])
})

test('agent sdk runtime repairs explicit target turns that finish before writing', async () => {
  const openDefinition = createToolDefinition({
    name: 'document_open_tab',
    groupId: 'document',
    domain: 'document',
    kind: 'read',
    description: 'Open document',
    schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  })
  const setContentDefinition = createToolDefinition({
    name: 'document_set_content',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Set document content',
    schema: {
      type: 'object',
      properties: { content: { type: 'string' } },
      required: ['content'],
      additionalProperties: false,
    },
  })
  const saveDefinition = createToolDefinition({
    name: 'document_save_tab',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Save document',
    schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  })
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const runInputs: unknown[] = []
  let runCount = 0
  const runtime = createRuntime({
    listToolDefinitions: () => [setContentDefinition, openDefinition, saveDefinition],
    executeToolCall: async (name, args) => {
      calls.push({ name, args })
      return createToolExecutionOutput(
        name === 'document_open_tab'
          ? 'opened target'
          : name === 'document_save_tab'
            ? 'saved target'
            : 'updated target',
        { shape: 'json', data: { ok: true } },
      )
    },
    runAgent: async ({ tools, input, onTextDelta }) => {
      runInputs.push(input)
      runCount += 1
      if (runCount === 1) {
        onTextDelta('我准备写入。')
        return { finalText: '我准备写入。' }
      }
      const setContentTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
      await setContentTool.invoke({}, JSON.stringify({ content: '补救写入的人物关系图' }))
      onTextDelta('已写入目标文档。')
      return { finalText: '已写入目标文档。' }
    },
  })
  runtime.newSession('butler::scope-doc-repair-write', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-doc-repair-write',
    [
      '在@[新文档.md]里写入一段人物关系图占位内容',
      '',
      '--- 附件: 新文档.md ---',
      '- 路径: /tmp/新文档.md',
    ].join('\n'),
    'run-doc-repair-write',
    {
      publicSessionId: 'scope-doc-repair-write',
      taskId: 'task-doc-repair-write',
      requestEnvelope: {
        primaryInstruction: '在@[新文档.md]里写入一段人物关系图占位内容',
        resources: [
          { name: '新文档.md', path: '/tmp/新文档.md' },
        ],
      },
    },
  )

  assert.equal(result.success, true)
  assert.equal(runCount, 2)
  assert.match(String(runInputs[1]), /目标文档尚未发生实际写入/)
  assert.deepEqual(calls, [
    { name: 'document_open_tab', args: { path: '/tmp/新文档.md' } },
    { name: 'document_set_content', args: { content: '补救写入的人物关系图' } },
    { name: 'document_save_tab', args: {} },
  ])
})

test('agent sdk runtime does not count no-op section rewrites as target writes', async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'ready-agent-sdk-noop-rewrite-'))
  const targetPath = join(tmpRoot, '人物关系.md')
  await writeFile(targetPath, '# 一、背景\n\n原文。', 'utf-8')
  try {
    const openDefinition = createToolDefinition({
      name: 'document_open_tab',
      groupId: 'document',
      domain: 'document',
      kind: 'read',
      description: 'Open document',
      schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    })
    const rewriteDefinition = createToolDefinition({
      name: 'document_rewrite_section',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Rewrite section',
      schema: {
        type: 'object',
        properties: {
          sectionTitle: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['sectionTitle', 'content'],
        additionalProperties: false,
      },
    })
    const setContentDefinition = createToolDefinition({
      name: 'document_set_content',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Set document content',
      schema: {
        type: 'object',
        properties: { content: { type: 'string' } },
        required: ['content'],
        additionalProperties: false,
      },
    })
    const saveDefinition = createToolDefinition({
      name: 'document_save_tab',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Save document',
      schema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    })
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const runInputs: unknown[] = []
    let runCount = 0
    const runtime = createRuntime({
      listToolDefinitions: () => [rewriteDefinition, setContentDefinition, openDefinition, saveDefinition],
      executeToolCall: async (name, args) => {
        calls.push({ name, args })
        if (name === 'document_set_content') {
          await writeFile(targetPath, String(args.content || ''), 'utf-8')
        }
        return createToolExecutionOutput(
          name === 'document_open_tab'
            ? 'opened target'
            : name === 'document_save_tab'
              ? 'saved target'
              : name === 'document_rewrite_section'
                ? '未找到章节“二、人物关系图”，未做改动'
                : 'updated target',
          { shape: 'json', data: { ok: true } },
        )
      },
      runAgent: async ({ tools, input, onTextDelta }) => {
        runInputs.push(input)
        runCount += 1
        const rewriteTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
        const setContentTool = tools[1] as { invoke: (context: unknown, input: string) => Promise<string> }
        if (runCount === 1) {
          await rewriteTool.invoke({}, JSON.stringify({
            sectionTitle: '二、人物关系图',
            content: '修复后的人物关系图',
          }))
          onTextDelta('已完成。')
          return { finalText: '已完成。' }
        }
        await setContentTool.invoke({}, JSON.stringify({ content: '# 二、人物关系图\n\n修复后的人物关系图' }))
        onTextDelta('已真正写入目标文档。')
        return { finalText: '已真正写入目标文档。' }
      },
    })
    runtime.newSession('butler::scope-doc-noop-rewrite', 'system prompt')

    const result = await runtime.sendMessage(
      'butler::scope-doc-noop-rewrite',
      [
        '把@[人物关系.md]里的 Mermaid 段落改成可渲染版本',
        '',
        '--- 附件: 人物关系.md ---',
        `- 路径: ${targetPath}`,
      ].join('\n'),
      'run-doc-noop-rewrite',
      {
        publicSessionId: 'scope-doc-noop-rewrite',
        taskId: 'task-doc-noop-rewrite',
        requestEnvelope: {
          primaryInstruction: '把@[人物关系.md]里的 Mermaid 段落改成可渲染版本',
          resources: [
            { name: '人物关系.md', path: targetPath },
          ],
        },
      },
    )

    assert.equal(result.success, true)
    assert.equal(runCount, 2)
    assert.match(String(runInputs[1]), /目标文档尚未发生实际写入/)
    assert.deepEqual(calls.map((call) => call.name), [
      'document_open_tab',
      'document_rewrite_section',
      'document_set_content',
      'document_save_tab',
    ])
    assert.match(await readFile(targetPath, 'utf-8'), /修复后的人物关系图/)
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('agent sdk runtime blocks explicit target replacements that drop preserved content', async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'ready-agent-sdk-preserve-'))
  const targetPath = join(tmpRoot, 'A2-读书笔记.md')
  const initialContent = [
    '# 《白痴》读书笔记',
    '',
    '## 阅读目标',
    '',
    '这是一份原有笔记，请保留这一段。',
    '',
    '## 人物关系',
    '',
    '> 这里是原有占位说明，不要删除。',
    '',
    '## 主题观察',
    '',
    '原有主题观察：公爵返俄后的处境值得继续记录。',
    '',
  ].join('\n')
  await writeFile(targetPath, initialContent, 'utf-8')
  try {
    const openDefinition = createToolDefinition({
      name: 'document_open_tab',
      groupId: 'document',
      domain: 'document',
      kind: 'read',
      description: 'Open document',
      schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    })
    const fileReadDefinition = createToolDefinition({
      name: 'file_read_excerpt',
      groupId: 'file_management',
      domain: 'file',
      kind: 'read',
      description: 'Read excerpt',
      schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    })
    const replaceDefinition = createToolDefinition({
      name: 'document_replace_exact',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Replace exact text',
      schema: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          replacement: { type: 'string' },
        },
        required: ['target', 'replacement'],
        additionalProperties: false,
      },
    })
    const saveDefinition = createToolDefinition({
      name: 'document_save_tab',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Save document',
      schema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    })
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const runtime = createRuntime({
      listToolDefinitions: () => [fileReadDefinition, replaceDefinition, openDefinition, saveDefinition],
      executeToolCall: async (name, args) => {
        calls.push({ name, args })
        if (name === 'document_replace_exact') {
          const current = await readFile(targetPath, 'utf-8')
          await writeFile(
            targetPath,
            current.replace(String(args.target || ''), String(args.replacement || '')),
            'utf-8',
          )
        }
        if (name === 'file_read_excerpt') {
          return createToolExecutionOutput(await readFile(targetPath, 'utf-8'), {
            shape: 'json',
            data: { ok: true },
          })
        }
        return createToolExecutionOutput(
          name === 'document_open_tab'
            ? 'opened target'
            : name === 'document_save_tab'
              ? 'saved target'
              : 'updated target',
          { shape: 'json', data: { ok: true } },
        )
      },
      runAgent: async ({ tools, onTextDelta }) => {
        const fileReadTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
        const replaceTool = tools[1] as { invoke: (context: unknown, input: string) => Promise<string> }
        await fileReadTool.invoke({}, JSON.stringify({ path: targetPath }))
        const unsafe = await replaceTool.invoke({}, JSON.stringify({
          target: '> 这里是原有占位说明，不要删除。',
          replacement: '> 以下人物关系基于前三章整理。',
        }))
        assert.match(unsafe, /原有内容/)
        await replaceTool.invoke({}, JSON.stringify({
          target: '> 这里是原有占位说明，不要删除。',
          replacement: [
            '> 这里是原有占位说明，不要删除。',
            '',
            '> 以下人物关系基于前三章整理。',
          ].join('\n'),
        }))
        onTextDelta('已保留原文并补充内容。')
        return { finalText: '已保留原文并补充内容。' }
      },
    })
    runtime.newSession('butler::scope-doc-preserve-replace', 'system prompt')

    const result = await runtime.sendMessage(
      'butler::scope-doc-preserve-replace',
      [
        '把人物关系整理到@[A2-读书笔记.md]的“人物关系”这一节下面，保留原有笔记内容，不要覆盖其他章节。',
        '',
        '--- 附件: A2-读书笔记.md ---',
        `- 路径: ${targetPath}`,
      ].join('\n'),
      'run-doc-preserve-replace',
      {
        publicSessionId: 'scope-doc-preserve-replace',
        taskId: 'task-doc-preserve-replace',
        requestEnvelope: {
          primaryInstruction: '把人物关系整理到@[A2-读书笔记.md]的“人物关系”这一节下面，保留原有笔记内容，不要覆盖其他章节。',
          resources: [
            { name: 'A2-读书笔记.md', path: targetPath },
          ],
        },
      },
    )

    const finalContent = await readFile(targetPath, 'utf-8')
    assert.equal(result.success, true)
    assert.equal(finalContent.includes('这是一份原有笔记，请保留这一段。'), true)
    assert.equal(finalContent.includes('> 这里是原有占位说明，不要删除。'), true)
    assert.equal(finalContent.includes('原有主题观察：公爵返俄后的处境值得继续记录。'), true)
    assert.deepEqual(calls.map((call) => call.name), [
      'file_read_excerpt',
      'document_open_tab',
      'document_replace_exact',
      'document_save_tab',
    ])
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('agent sdk runtime continues explicit target turns that admit the document is incomplete', async () => {
  const openDefinition = createToolDefinition({
    name: 'document_open_tab',
    groupId: 'document',
    domain: 'document',
    kind: 'read',
    description: 'Open document',
    schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  })
  const setContentDefinition = createToolDefinition({
    name: 'document_set_content',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Set document content',
    schema: {
      type: 'object',
      properties: { content: { type: 'string' } },
      required: ['content'],
      additionalProperties: false,
    },
  })
  const saveDefinition = createToolDefinition({
    name: 'document_save_tab',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Save document',
    schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  })
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const runInputs: unknown[] = []
  let runCount = 0
  const runtime = createRuntime({
    listToolDefinitions: () => [setContentDefinition, openDefinition, saveDefinition],
    executeToolCall: async (name, args) => {
      calls.push({ name, args })
      return createToolExecutionOutput(
        name === 'document_open_tab'
          ? 'opened target'
          : name === 'document_save_tab'
            ? 'saved target'
            : 'updated target',
        { shape: 'json', data: { ok: true } },
      )
    },
    runAgent: async ({ tools, input, onTextDelta }) => {
      runInputs.push(input)
      runCount += 1
      const setContentTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
      if (runCount === 1) {
        await setContentTool.invoke({}, JSON.stringify({ content: '未完成内容 ——' }))
        onTextDelta('内容被截断了，我来补完末尾部分。')
        return { finalText: '内容被截断了，我来补完末尾部分。' }
      }
      await setContentTool.invoke({}, JSON.stringify({ content: '完整内容。' }))
      onTextDelta('已补完并保存。')
      return { finalText: '已补完并保存。' }
    },
  })
  runtime.newSession('butler::scope-doc-incomplete-continue', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-doc-incomplete-continue',
    [
      '在@[新文档.md]里写入一段人物关系图占位内容',
      '',
      '--- 附件: 新文档.md ---',
      '- 路径: /tmp/新文档.md',
    ].join('\n'),
    'run-doc-incomplete-continue',
    {
      publicSessionId: 'scope-doc-incomplete-continue',
      taskId: 'task-doc-incomplete-continue',
      requestEnvelope: {
        primaryInstruction: '在@[新文档.md]里写入一段人物关系图占位内容',
        resources: [
          { name: '新文档.md', path: '/tmp/新文档.md' },
        ],
      },
    },
  )

  assert.equal(result.success, true)
  assert.equal(runCount, 2)
  assert.match(String(runInputs[1]), /还没补完/)
  assert.deepEqual(calls, [
    { name: 'document_open_tab', args: { path: '/tmp/新文档.md' } },
    { name: 'document_set_content', args: { content: '未完成内容 ——' } },
    { name: 'document_save_tab', args: {} },
    { name: 'document_set_content', args: { content: '完整内容。' } },
    { name: 'document_save_tab', args: {} },
  ])
})

test('agent sdk runtime repairs damaged show-widget content before completing target document turns', async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'ready-agent-sdk-widget-'))
  const targetPath = join(tmpRoot, '新文档.md')
  await writeFile(targetPath, '\n', 'utf-8')
  try {
    const openDefinition = createToolDefinition({
      name: 'document_open_tab',
      groupId: 'document',
      domain: 'document',
      kind: 'read',
      description: 'Open document',
      schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    })
    const setContentDefinition = createToolDefinition({
      name: 'document_set_content',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Set document content',
      schema: {
        type: 'object',
        properties: { content: { type: 'string' } },
        required: ['content'],
        additionalProperties: false,
      },
    })
    const saveDefinition = createToolDefinition({
      name: 'document_save_tab',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Save document',
      schema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    })
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const runInputs: unknown[] = []
    let runCount = 0
    const runtime = createRuntime({
      listToolDefinitions: () => [setContentDefinition, openDefinition, saveDefinition],
      executeToolCall: async (name, args) => {
        calls.push({ name, args })
        if (name === 'document_set_content') {
          await writeFile(targetPath, String(args.content || ''), 'utf-8')
        }
        return createToolExecutionOutput(
          name === 'document_open_tab'
            ? 'opened target'
            : name === 'document_save_tab'
              ? 'saved target'
              : 'updated target',
          { shape: 'json', data: { ok: true } },
        )
      },
      runAgent: async ({ tools, input, onTextDelta }) => {
        runInputs.push(input)
        runCount += 1
        const setContentTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
        if (runCount === 1) {
          await setContentTool.invoke({}, JSON.stringify({
            content: [
              '# 人物关系图',
              '',
              '```show-widget',
              JSON.stringify({ id: 'broken', widget_code: '<svg><line x1="1"' }),
              '```',
            ].join('\n'),
          }))
          onTextDelta('已完成。')
          return { finalText: '已完成。' }
        }
        await setContentTool.invoke({}, JSON.stringify({ content: '# 人物关系图\n\n文本版关系图。' }))
        onTextDelta('已改成稳定版本并保存。')
        return { finalText: '已改成稳定版本并保存。' }
      },
    })
    runtime.newSession('butler::scope-doc-widget-repair', 'system prompt')

    const result = await runtime.sendMessage(
      'butler::scope-doc-widget-repair',
      [
        '在@[新文档.md]里写入一段人物关系图占位内容',
        '',
        '--- 附件: 新文档.md ---',
        `- 路径: ${targetPath}`,
      ].join('\n'),
      'run-doc-widget-repair',
      {
        publicSessionId: 'scope-doc-widget-repair',
        taskId: 'task-doc-widget-repair',
        requestEnvelope: {
          primaryInstruction: '在@[新文档.md]里写入一段人物关系图占位内容',
          resources: [
            { name: '新文档.md', path: targetPath },
          ],
        },
      },
    )

    assert.equal(result.success, true)
    assert.equal(runCount, 2)
    assert.match(String(runInputs[1]), /show-widget/)
    assert.deepEqual(calls.map((call) => call.name), [
      'document_open_tab',
      'document_set_content',
      'document_save_tab',
      'document_set_content',
      'document_save_tab',
    ])
    assert.equal((await readFile(targetPath, 'utf-8')).includes('show-widget'), false)
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('agent sdk runtime repairs exposed Mermaid source before completing target document turns', async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'ready-agent-sdk-mermaid-'))
  const targetPath = join(tmpRoot, '新文档.md')
  await writeFile(targetPath, '\n', 'utf-8')
  try {
    const openDefinition = createToolDefinition({
      name: 'document_open_tab',
      groupId: 'document',
      domain: 'document',
      kind: 'read',
      description: 'Open document',
      schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    })
    const setContentDefinition = createToolDefinition({
      name: 'document_set_content',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Set document content',
      schema: {
        type: 'object',
        properties: { content: { type: 'string' } },
        required: ['content'],
        additionalProperties: false,
      },
    })
    const saveDefinition = createToolDefinition({
      name: 'document_save_tab',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Save document',
      schema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    })
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const runInputs: unknown[] = []
    let runCount = 0
    const runtime = createRuntime({
      listToolDefinitions: () => [setContentDefinition, openDefinition, saveDefinition],
      executeToolCall: async (name, args) => {
        calls.push({ name, args })
        if (name === 'document_set_content') {
          await writeFile(targetPath, String(args.content || ''), 'utf-8')
        }
        return createToolExecutionOutput(
          name === 'document_open_tab'
            ? 'opened target'
            : name === 'document_save_tab'
              ? 'saved target'
              : 'updated target',
          { shape: 'json', data: { ok: true } },
        )
      },
      runAgent: async ({ tools, input, onTextDelta }) => {
        runInputs.push(input)
        runCount += 1
        const setContentTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
        if (runCount === 1) {
          await setContentTool.invoke({}, JSON.stringify({
            content: [
              '# 人物关系图',
              '',
              '```mermaid',
              'graph LR',
              '公爵["梅诗金公爵"]',
              '娜斯塔霞["娜斯塔霞"]',
              '```',
              '',
              '公爵 --- "一见钟情" --> 娜斯塔霞',
              '%% 叶班钦家族',
              '将军["叶班钦将军"] --- "父女" --> 大姐["亚历山德拉"]',
            ].join('\n'),
          }))
          onTextDelta('已完成。')
          return { finalText: '已完成。' }
        }
        await setContentTool.invoke({}, JSON.stringify({
          content: [
            '# 人物关系图',
            '',
            '```mermaid',
            'graph LR',
            '公爵["梅诗金公爵"] --> 娜斯塔霞["娜斯塔霞"]',
            '将军["叶班钦将军"] --> 大姐["亚历山德拉"]',
            '```',
          ].join('\n'),
        }))
        onTextDelta('已改成完整 Mermaid 图并保存。')
        return { finalText: '已改成完整 Mermaid 图并保存。' }
      },
    })
    runtime.newSession('butler::scope-doc-mermaid-repair', 'system prompt')

    const result = await runtime.sendMessage(
      'butler::scope-doc-mermaid-repair',
      [
        '在@[新文档.md]里写入一段人物关系图占位内容',
        '',
        '--- 附件: 新文档.md ---',
        `- 路径: ${targetPath}`,
      ].join('\n'),
      'run-doc-mermaid-repair',
      {
        publicSessionId: 'scope-doc-mermaid-repair',
        taskId: 'task-doc-mermaid-repair',
        requestEnvelope: {
          primaryInstruction: '在@[新文档.md]里写入一段人物关系图占位内容',
          resources: [
            { name: '新文档.md', path: targetPath },
          ],
        },
      },
    )

    assert.equal(result.success, true)
    assert.equal(runCount, 2)
    assert.match(String(runInputs[1]), /Mermaid\/关系图源码裸露/)
    assert.deepEqual(calls.map((call) => call.name), [
      'document_open_tab',
      'document_set_content',
      'document_save_tab',
      'document_set_content',
      'document_save_tab',
    ])
    const saved = await readFile(targetPath, 'utf-8')
    assert.match(saved, /```mermaid/)
    assert.doesNotMatch(saved, /\n公爵 --- "一见钟情"/)
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('agent sdk runtime treats a single selected document as target for section repair turns', async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'ready-agent-sdk-selected-target-'))
  const targetPath = join(tmpRoot, '白痴-笔记.md')
  await writeFile(targetPath, '# 二、人物关系图\n\n旧内容。', 'utf-8')
  try {
    const openDefinition = createToolDefinition({
      name: 'document_open_tab',
      groupId: 'document',
      domain: 'document',
      kind: 'read',
      description: 'Open document',
      schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    })
    const setContentDefinition = createToolDefinition({
      name: 'document_set_content',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Set document content',
      schema: {
        type: 'object',
        properties: { content: { type: 'string' } },
        required: ['content'],
        additionalProperties: false,
      },
    })
    const saveDefinition = createToolDefinition({
      name: 'document_save_tab',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Save document',
      schema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    })
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const runInputs: unknown[] = []
    let runCount = 0
    const runtime = createRuntime({
      listToolDefinitions: () => [setContentDefinition, openDefinition, saveDefinition],
      executeToolCall: async (name, args) => {
        calls.push({ name, args })
        if (name === 'document_set_content') {
          await writeFile(targetPath, String(args.content || ''), 'utf-8')
        }
        return createToolExecutionOutput(
          name === 'document_open_tab'
            ? 'opened target'
            : name === 'document_save_tab'
              ? 'saved target'
              : 'updated target',
          { shape: 'json', data: { ok: true } },
        )
      },
      runAgent: async ({ tools, input, onTextDelta }) => {
        runInputs.push(input)
        runCount += 1
        const setContentTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
        if (runCount === 1) {
          await setContentTool.invoke({}, JSON.stringify({
            content: [
              '# 二、人物关系图',
              '',
              '```mermaid',
              'graph TD',
              'duke -- "一见钟情" --- nastasya',
              '%% 叶班钦家族',
              'epanchin["叶班钦将军"]',
              '```',
            ].join('\n'),
          }))
          onTextDelta('已修复并保存。')
          return { finalText: '已修复并保存。' }
        }
        await setContentTool.invoke({}, JSON.stringify({
          content: [
            '# 二、人物关系图',
            '',
            '| 人物 | 关系 | 对象 |',
            '| --- | --- | --- |',
            '| 梅诗金公爵 | 一见钟情 | 娜斯塔霞 |',
          ].join('\n'),
        }))
        onTextDelta('已改成表格并保存。')
        return { finalText: '已改成表格并保存。' }
      },
    })
    runtime.newSession('butler::scope-doc-selected-target', 'system prompt')

    const result = await runtime.sendMessage(
      'butler::scope-doc-selected-target',
      [
        '修复一下这段 mermaid',
        '',
        '--- 附件: 白痴-笔记.md ---',
        `- 路径: ${targetPath}`,
      ].join('\n'),
      'run-doc-selected-target',
      {
        publicSessionId: 'scope-doc-selected-target',
        taskId: 'task-doc-selected-target',
        requestEnvelope: {
          primaryInstruction: '修复一下这段 mermaid',
          resources: [
            { name: '白痴-笔记.md', path: targetPath },
          ],
        },
      },
    )

    assert.equal(result.success, true)
    assert.equal(runCount, 2)
    assert.match(String(runInputs[1]), /Mermaid/)
    assert.match(String(runInputs[1]), /边标签/)
    assert.deepEqual(calls.map((call) => call.name), [
      'document_open_tab',
      'document_set_content',
      'document_save_tab',
      'document_set_content',
      'document_save_tab',
    ])
    const saved = await readFile(targetPath, 'utf-8')
    assert.match(saved, /\| 人物 \| 关系 \| 对象 \|/)
    assert.doesNotMatch(saved, /duke --/)
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('agent sdk runtime treats max-turn exhaustion after a valid saved target document as complete', async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'ready-agent-sdk-max-turn-'))
  const targetPath = join(tmpRoot, 'B2-运营数据多图表报告.md')
  await writeFile(targetPath, '# B2 运营数据多图表报告\n\n', 'utf-8')
  try {
    const openDefinition = createToolDefinition({
      name: 'document_open_tab',
      groupId: 'document',
      domain: 'document',
      kind: 'read',
      description: 'Open document',
      schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    })
    const setContentDefinition = createToolDefinition({
      name: 'document_set_content',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Set document content',
      schema: {
        type: 'object',
        properties: { content: { type: 'string' } },
        required: ['content'],
        additionalProperties: false,
      },
    })
    const saveDefinition = createToolDefinition({
      name: 'document_save_tab',
      groupId: 'document',
      domain: 'document',
      kind: 'write',
      concurrency: 'serialized',
      timeoutProfile: 'document_write',
      description: 'Save document',
      schema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    })
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const runtime = createRuntime({
      listToolDefinitions: () => [setContentDefinition, openDefinition, saveDefinition],
      executeToolCall: async (name, args) => {
        calls.push({ name, args })
        if (name === 'document_set_content') {
          await writeFile(targetPath, String(args.content || ''), 'utf-8')
        }
        return createToolExecutionOutput(
          name === 'document_open_tab'
            ? 'opened target'
            : name === 'document_save_tab'
              ? 'saved target'
              : 'updated target',
          { shape: 'json', data: { ok: true } },
        )
      },
      runAgent: async ({ tools }) => {
        const setContentTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
        await setContentTool.invoke({}, JSON.stringify({
          content: '# B2 运营数据多图表报告\n\n已生成 4 个图表，并保存关键结论。',
        }))
        throw new Error('Max turns (16) exceeded')
      },
    })
    runtime.newSession('butler::scope-doc-max-turn-complete', 'system prompt')

    const result = await runtime.sendMessage(
      'butler::scope-doc-max-turn-complete',
      [
        '把多组运营数据整理到@[B2-运营数据多图表报告.md]里。',
        '',
        '--- 附件: B2-运营数据多图表报告.md ---',
        `- 路径: ${targetPath}`,
      ].join('\n'),
      'run-doc-max-turn-complete',
      {
        publicSessionId: 'scope-doc-max-turn-complete',
        taskId: 'task-doc-max-turn-complete',
        requestEnvelope: {
          primaryInstruction: '把多组运营数据整理到@[B2-运营数据多图表报告.md]里。',
          resources: [
            { name: 'B2-运营数据多图表报告.md', path: targetPath },
          ],
        },
      },
    )

    assert.equal(result.success, true)
    assert.equal(result.terminalReason, 'done')
    assert.match(result.finalText, /已完成并保存/)
    assert.deepEqual(calls.map((call) => call.name), [
      'document_open_tab',
      'document_set_content',
      'document_save_tab',
    ])
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('agent sdk runtime checkpoints max-turn target document turns with no effective mutation', async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'ready-agent-sdk-max-turn-empty-'))
  const targetPath = join(tmpRoot, '空文档.md')
  await writeFile(targetPath, '\n', 'utf-8')
  try {
    const statuses: Array<Record<string, unknown>> = []
    const errors: Array<Record<string, unknown>> = []
    const runtime = createRuntime({
      runAgent: async () => {
        throw new Error('Max turns (16) exceeded')
      },
    })
    runtime.on('status', (event) => statuses.push(event as Record<string, unknown>))
    runtime.on('error', (event) => errors.push(event as Record<string, unknown>))
    runtime.newSession('butler::scope-doc-max-turn-no-mutation', 'system prompt')

    const result = await runtime.sendMessage(
      'butler::scope-doc-max-turn-no-mutation',
      [
        '修复@[空文档.md]里的信息卡。',
        '',
        '--- 附件: 空文档.md ---',
        `- 路径: ${targetPath}`,
      ].join('\n'),
      'run-doc-max-turn-no-mutation',
      {
        publicSessionId: 'scope-doc-max-turn-no-mutation',
        taskId: 'task-doc-max-turn-no-mutation',
        requestEnvelope: {
          primaryInstruction: '修复@[空文档.md]里的信息卡。',
          resources: [
            { name: '空文档.md', path: targetPath },
          ],
        },
      },
    )

    assert.equal(result.success, true)
    assert.equal(result.terminalReason, 'checkpoint_budget')
    assert.match(result.finalText, /还没有发生有效写入/)
    assert.equal(errors.length, 0)
    assert.equal(statuses.some((event) => event.status === 'checkpoint' && event.terminalReason === 'checkpoint_budget'), true)
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('agent sdk runtime recovers loose XML tool calls leaked as native model text', async () => {
  const openDefinition = createToolDefinition({
    name: 'document_open_tab',
    groupId: 'document',
    domain: 'document',
    kind: 'read',
    description: 'Open document',
    schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  })
  const setContentDefinition = createToolDefinition({
    name: 'document_set_content',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Set document content',
    schema: {
      type: 'object',
      properties: { content: { type: 'string' } },
      required: ['content'],
      additionalProperties: false,
    },
  })
  const saveDefinition = createToolDefinition({
    name: 'document_save_tab',
    groupId: 'document',
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'document_write',
    description: 'Save document',
    schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  })
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  let runCount = 0
  const runtime = createRuntime({
    listToolDefinitions: () => [setContentDefinition, openDefinition, saveDefinition],
    executeToolCall: async (name, args) => {
      calls.push({ name, args })
      return createToolExecutionOutput(
        name === 'document_open_tab'
          ? 'opened target'
          : name === 'document_save_tab'
            ? 'saved target'
            : 'updated target',
        { shape: 'json', data: { ok: true } },
      )
    },
    runAgent: async ({ onTextDelta }) => {
      runCount += 1
      if (runCount === 1) {
        const leaked = [
          '现在写入目标文档：',
          '<tool_call>',
          '<function=document_set_content>',
          '<parameter=content>XML 恢复写入的人物关系图',
        ].join('\n')
        onTextDelta(leaked)
        return { finalText: leaked }
      }
      onTextDelta('已写入并保存。')
      return { finalText: '已写入并保存。' }
    },
  })
  runtime.newSession('butler::scope-doc-xml-recovery', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-doc-xml-recovery',
    [
      '在@[新文档.md]里写入一段人物关系图占位内容',
      '',
      '--- 附件: 新文档.md ---',
      '- 路径: /tmp/新文档.md',
    ].join('\n'),
    'run-doc-xml-recovery',
    {
      publicSessionId: 'scope-doc-xml-recovery',
      taskId: 'task-doc-xml-recovery',
      requestEnvelope: {
        primaryInstruction: '在@[新文档.md]里写入一段人物关系图占位内容',
        resources: [
          { name: '新文档.md', path: '/tmp/新文档.md' },
        ],
      },
    },
  )

  assert.equal(result.success, true)
  assert.equal(runCount, 2)
  assert.deepEqual(calls, [
    { name: 'document_open_tab', args: { path: '/tmp/新文档.md' } },
    { name: 'document_set_content', args: { content: 'XML 恢复写入的人物关系图' } },
    { name: 'document_save_tab', args: {} },
  ])
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
      ;(context as { emitToolAction?: (tool: string, args: Record<string, unknown>) => void }).emitToolAction?.(
        'document.setContent',
        args,
      )
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
    assert.equal(seenToolNames.includes('skill_run_shell'), false)
    assert.equal(seenToolNames.includes('skill_inspect_run_state'), true)
    assert.equal(seenToolNames.includes('skill_start_detached'), false)
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

test('agent sdk runtime carries skill contextModifier active roots into later SDK tool calls', async () => {
  const outputDir = join(tmpdir(), 'ready-agent-sdk-active-root')
  const pipelineDefinition = createToolDefinition({
    name: 'skill_video_expert_pipeline',
    groupId: 'skills',
    domain: 'skill',
    kind: 'job',
    description: 'Run VEA pipeline',
  })
  const readArtifactDefinition = createToolDefinition({
    name: 'skill_read_artifact',
    groupId: 'skills',
    domain: 'skill',
    kind: 'read',
    description: 'Read skill artifact',
  })
  let observedRoots: string[] = []
  const runtime = createRuntime({
    listToolDefinitions: () => [pipelineDefinition, readArtifactDefinition],
    executeToolCall: async (name, _args, context) => {
      if (name === 'skill_video_expert_pipeline') {
        return createToolExecutionOutput(JSON.stringify({
          status: 'child_launched',
          childRunId: 'child-active-root',
          skillId: 'video-expert-analyzer',
          action: 'video_expert_pipeline',
          outputDir,
          runStatePath: join(outputDir, 'run_state.json'),
          parentNextHint: 'wait_for_close_event',
        }), {
          shape: 'json',
          data: {
            status: 'child_launched',
            childRunId: 'child-active-root',
            skillId: 'video-expert-analyzer',
            action: 'video_expert_pipeline',
            outputDir,
            runStatePath: join(outputDir, 'run_state.json'),
            parentNextHint: 'wait_for_close_event',
          },
          contextModifier: {
            activeFrame: {
              activeArtifactRoots: [outputDir],
            },
          },
        })
      }
      observedRoots = [...((context as { activeFrame?: { activeArtifactRoots?: string[] } }).activeFrame?.activeArtifactRoots || [])]
      return createToolExecutionOutput('artifact read', { shape: 'json', data: { ok: true } })
    },
    runAgent: async ({ tools }) => {
      const pipelineTool = tools.find((item) => item.name === 'skill_video_expert_pipeline') as { invoke: (context: unknown, input: string) => Promise<string> }
      const readTool = tools.find((item) => item.name === 'skill_read_artifact') as { invoke: (context: unknown, input: string) => Promise<string> }
      await pipelineTool.invoke({}, JSON.stringify({ url: 'fixture.mp4', outputDir }))
      await readTool.invoke({}, JSON.stringify({ relativePath: 'scene_scores.json' }))
      return { finalText: '已读取产物' }
    },
  })
  runtime.newSession('butler::scope-skill-active-root', 'system prompt')

  const result = await runtime.sendMessage('butler::scope-skill-active-root', '使用 VEA 分析视频', 'run-skill-active-root', {
    publicSessionId: 'scope-skill-active-root',
    taskId: 'task-skill-active-root',
  })

  assert.equal(result.success, true)
  assert.ok(observedRoots.includes(outputDir))
})

test('agent sdk runtime recovers max-turn after long skill checkpoint instead of surfacing send failure', async () => {
  const outputDir = join(tmpdir(), 'ready-agent-sdk-long-skill-checkpoint')
  const statuses: Array<Record<string, unknown>> = []
  const pipelineDefinition = createToolDefinition({
    name: 'skill_video_expert_pipeline',
    groupId: 'skills',
    domain: 'skill',
    kind: 'job',
    description: 'Run VEA pipeline',
  })
  const runtime = createRuntime({
    listToolDefinitions: () => [pipelineDefinition],
    executeToolCall: async () => createToolExecutionOutput(JSON.stringify({
      status: 'child_launched',
      childRunId: 'child-checkpoint',
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      outputDir,
      runStatePath: join(outputDir, 'run_state.json'),
      parentNextHint: 'wait_for_close_event',
    }), {
      shape: 'json',
      data: {
        status: 'child_launched',
        childRunId: 'child-checkpoint',
        skillId: 'video-expert-analyzer',
        action: 'video_expert_pipeline',
        outputDir,
        runStatePath: join(outputDir, 'run_state.json'),
        parentNextHint: 'wait_for_close_event',
      },
    }),
    runAgent: async ({ tools }) => {
      const pipelineTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
      await pipelineTool.invoke({}, JSON.stringify({ url: 'fixture.mp4', outputDir }))
      throw new Error('Max turns (16) exceeded')
    },
  })
  runtime.on('status', (event) => statuses.push(event as Record<string, unknown>))
  runtime.newSession('butler::scope-long-skill-checkpoint', 'system prompt')

  const result = await runtime.sendMessage('butler::scope-long-skill-checkpoint', '使用 VEA 分析视频', 'run-long-skill-checkpoint', {
    publicSessionId: 'scope-long-skill-checkpoint',
    taskId: 'task-long-skill-checkpoint',
  })

  assert.equal(result.success, true)
  assert.equal(result.terminalReason, 'checkpoint_background')
  assert.match(result.finalText, /技能任务已启动/)
  assert.equal(statuses.some((event) => event.status === 'error'), false)
  assert.equal(statuses.some((event) => event.status === 'checkpoint' && event.terminalReason === 'checkpoint_background'), true)
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
