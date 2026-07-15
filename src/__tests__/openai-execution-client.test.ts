import assert from 'node:assert/strict'
import test from 'node:test'

import { OpenAIExecutionClient } from '../main/modules/claude-bridge/openai-execution-client'
import {
  __setMetricSinkForTests,
  type AgentMetricEvent,
} from '../main/modules/agent-control/metrics'
import type { AIModelConfig } from '../shared/ai-providers'

function createConfig(overrides: Partial<AIModelConfig> = {}): AIModelConfig {
  return {
    provider: 'openai-compatible',
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    model: 'gpt-test',
    toolUseMode: 'on',
    ...overrides,
  }
}

function captureMetrics(): { events: AgentMetricEvent[]; restore: () => void } {
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  return { events, restore: () => __setMetricSinkForTests(null) }
}

function createJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  })
}

test('OpenAIExecutionClient only applies text bridge fallback to the current tool request', async () => {
  const requestLabels: string[] = []
  const queuedResponses = [
    createJsonResponse({
      choices: [
        {
          message: {
            content: 'No available tools in this session.',
          },
          finish_reason: 'stop',
        },
      ],
    }),
    createJsonResponse({
      choices: [
        {
          message: {
            content: [
              ':::tool_call',
              '{"tool":"browser_search","args":{"query":"广州天气"}}',
              ':::',
            ].join('\n'),
          },
          finish_reason: 'stop',
        },
      ],
    }),
    createJsonResponse({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                function: {
                  name: 'browser_search',
                  arguments: '{"query":"广州天气"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
  ]

  const client = new OpenAIExecutionClient({
    fetchWithTimeout: async (_url, _init, _signal, label) => {
      requestLabels.push(label)
      const next = queuedResponses.shift()
      assert.ok(next, `unexpected extra request for ${label}`)
      return next
    },
    log: () => {},
  })

  const session = {
    messages: [
      { role: 'user' as const, content: '明天广州天气怎么样' },
    ],
    systemPrompt: 'system',
    preferTextToolBridge: false,
  }

  const first = await client.requestWithTools({
    session,
    config: createConfig(),
    baseUrl: 'https://example.com/v1',
    provider: undefined,
    signal: new AbortController().signal,
  })

  assert.equal(first.toolTransport, 'text')
  assert.equal(first.fallback?.kind, 'text_bridge')
  assert.equal(session.preferTextToolBridge, false)

  const second = await client.requestWithTools({
    session,
    config: createConfig(),
    baseUrl: 'https://example.com/v1',
    provider: undefined,
    signal: new AbortController().signal,
  })

  assert.equal(second.toolTransport, 'native')
  assert.equal(second.toolCalls.length, 1)
  assert.deepEqual(requestLabels, [
    'openai tools',
    'openai text tool bridge',
    'openai tools',
  ])
})

test('OpenAIExecutionClient returns provider-side tool snapshots for request and response', async () => {
  const logs: string[] = []
  const client = new OpenAIExecutionClient({
    fetchWithTimeout: async () => createJsonResponse({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                function: {
                  name: 'browser_search',
                  arguments: '{"query":"广州天气"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
    log: (message) => {
      logs.push(message)
    },
  })

  const result = await client.requestWithTools({
    session: {
      messages: [
        { role: 'user', content: '明天广州天气怎么样' },
      ],
      systemPrompt: 'system',
      preferTextToolBridge: false,
    },
    config: createConfig(),
    baseUrl: 'https://example.com/v1',
    provider: undefined,
    signal: new AbortController().signal,
    toolSnapshotContext: {
      iteration: 1,
      browserDecisionMode: 'free_tool_loop',
      browserHostAvailable: true,
      hasTools: true,
      allowBrowserTools: true,
      visibleCapabilityGroupIds: ['browser_interaction'],
      suppressedCapabilityGroupIds: [],
      requestedTransport: 'native',
      supportsNativeTools: true,
      preferTextToolBridge: false,
      expectedAllowedToolNames: ['browser_search'],
    },
  } as any)

  const toolSnapshots = (result as { toolSnapshots?: Array<Record<string, unknown>> }).toolSnapshots || []
  assert.deepEqual(toolSnapshots.map((snapshot) => snapshot.stage), [
    'provider_request',
    'provider_response',
  ])
  assert.equal(Array.isArray(toolSnapshots[0]?.allowedToolNames), true)
  assert.equal((toolSnapshots[0]?.allowedToolNames as string[]).includes('browser_search'), true)
  assert.equal(toolSnapshots[0]?.mismatch, true)
  assert.equal(toolSnapshots[1]?.toolCallsCount, 1)
  assert.equal(logs.some((entry) => entry.includes('[tool_snapshot]')), true)
})

/**
 * Stage 3 W0 — defend against future commits that bypass the
 * `buildChatCompletionsToolCalls` / `buildResponsesToolCalls` helpers by
 * inlining their own JSON.parse. Helper-level tests pin the parser shape;
 * these client-level tests pin the wiring through the real client entry.
 */

test('OpenAIExecutionClient drops corrupt chat_completions tool_calls.arguments and emits route metric', async () => {
  const { events, restore } = captureMetrics()
  try {
    const client = new OpenAIExecutionClient({
      fetchWithTimeout: async () => createJsonResponse({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_good',
                  function: { name: 'browser_search', arguments: '{"query":"x"}' },
                },
                {
                  id: 'call_bad',
                  function: { name: 'shell', arguments: '{not json' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
      log: () => {},
    })

    const result = await client.requestWithTools({
      session: {
        messages: [{ role: 'user', content: 'q' }],
        systemPrompt: 's',
        preferTextToolBridge: false,
      },
      config: createConfig(),
      baseUrl: 'https://example.com/v1',
      provider: undefined,
      signal: new AbortController().signal,
    } as any)

    assert.equal(result.toolCalls.length, 1, 'corrupt call should be dropped')
    assert.equal(result.toolCalls[0].id, 'call_good')
    assert.deepEqual(result.toolCallParseErrors, [
      {
        route: 'chat_completions',
        toolName: 'shell',
        callId: 'call_bad',
        reason: 'corrupt',
      },
    ])
    assert.equal('rawSample' in (result.toolCallParseErrors?.[0] || {}), false)
    const corruptEvents = events.filter((e) => e.metric === 'provider_arguments_corrupt')
    assert.equal(corruptEvents.length, 1)
    assert.equal(corruptEvents[0].route, 'chat_completions')
    assert.equal(corruptEvents[0].toolName, 'shell')
    assert.equal(corruptEvents[0].callId, 'call_bad')
    assert.equal(corruptEvents[0].rawSample, '{not json')
  } finally {
    restore()
  }
})

test('OpenAIExecutionClient drops corrupt responses output[].arguments and emits route metric', async () => {
  const { events, restore } = captureMetrics()
  try {
    const client = new OpenAIExecutionClient({
      fetchWithTimeout: async () => createJsonResponse({
        id: 'resp_1',
        status: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: 'rc_good',
            name: 'browser_search',
            arguments: '{"query":"x"}',
          },
          {
            type: 'function_call',
            call_id: 'rc_bad',
            name: 'arr_arg',
            arguments: '[1,2,3]',
          },
        ],
      }),
      log: () => {},
    })

    const result = await client.requestWithTools({
      session: {
        messages: [{ role: 'user', content: 'q' }],
        systemPrompt: 's',
        preferTextToolBridge: false,
      },
      config: createConfig({ wireApi: 'responses' }),
      baseUrl: 'https://example.com/v1',
      provider: undefined,
      signal: new AbortController().signal,
    } as any)

    assert.equal(result.toolCalls.length, 1, 'corrupt call should be dropped')
    assert.equal(result.toolCalls[0].id, 'rc_good')
    assert.deepEqual(result.toolCallParseErrors, [
      {
        route: 'responses',
        toolName: 'arr_arg',
        callId: 'rc_bad',
        reason: 'corrupt',
      },
    ])
    assert.equal('rawSample' in (result.toolCallParseErrors?.[0] || {}), false)
    const corruptEvents = events.filter((e) => e.metric === 'provider_arguments_corrupt')
    assert.equal(corruptEvents.length, 1)
    assert.equal(corruptEvents[0].route, 'responses')
    assert.equal(corruptEvents[0].toolName, 'arr_arg')
    assert.equal(corruptEvents[0].callId, 'rc_bad')
    assert.equal(corruptEvents[0].rawSample, '[1,2,3]')
  } finally {
    restore()
  }
})
