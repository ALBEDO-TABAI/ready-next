import assert from 'node:assert/strict'
import test from 'node:test'

import { OpenAIExecutionClient } from '../main/modules/claude-bridge/openai-execution-client'
import type { AIModelConfig } from '../shared/ai-providers'

function createConfig(overrides: Partial<AIModelConfig> = {}): AIModelConfig {
  return {
    provider: 'openai-compatible',
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    model: 'gpt-test',
    ...overrides,
  }
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
