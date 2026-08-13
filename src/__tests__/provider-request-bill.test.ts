/**
 * R-CTX (P2) — provider_request_bill section attribution. Instrumentation-only:
 * these assert the pure classifier partitions a provider request's tokens into
 * disjoint sections so the 565–633K bloat can be diagnosed (e.g. is the same
 * image re-sent every turn?). No behavior change is under test here.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Agent, MemorySession, tool } from '@openai/agents'

import {
  billProviderRequestSections,
  estimateImageDataTokens,
  estimateInputItemTokens,
  estimateTextTokens,
  IMAGE_EST_TOKENS
} from '../shared/context-budget-types'
import {
  emitProviderEstimateReconciliation,
  recordProviderRequestBills
} from '../main/modules/agent-control/runtime-core/agent-sdk-provider-request-instrumentation'
import {
  resolveEnabledSdkToolsForRequest,
  runWithOpenAIAgentsSdk,
  usageFromModelResponses,
} from '../main/modules/agent-control/runtime-core/agent-sdk-provider-runner'
import { ReadyOpenAICompatibleModel } from '../main/modules/agent-control/runtime-core/agent-sdk-provider'
import {
  __setMetricSinkForTests,
  type AgentMetricEvent
} from '../main/modules/agent-control/metrics'

// REAL @openai/agents InputImage shape emitted by toSdkInput: the key is `image`
// (a data-URL string), NOT `url`/`image_url`. Fixtures must match what the app sends.
const bigBase64 = 'A'.repeat(80_000)
const imageItem = () => ({
  role: 'user',
  content: [{ type: 'input_image', image: `data:image/webp;base64,${bigBase64}`, detail: 'auto' }]
})
const screenshotResult = () => ({
  type: 'computer_call_result',
  callId: 'c9',
  output: { type: 'computer_screenshot', data: `data:image/png;base64,${bigBase64}` }
})

test('vision: the REAL {type:input_image, image:data-url} shape uses the text-protocol safety estimate', () => {
  const bill = billProviderRequestSections([
    imageItem(),
    { role: 'user', content: '一段历史文本' }
  ] as never)
  assert.equal(bill.sections.vision, estimateInputItemTokens([imageItem()] as never))
  assert.equal(bill.visionItems, 1)
  assert.ok(bill.sections.history > 0)
  assert.equal(bill.sections.tool_results, 0)
})

test('vision: a computer_screenshot result uses the text-protocol safety estimate, not tool_results', () => {
  const bill = billProviderRequestSections([screenshotResult()] as never)
  assert.equal(bill.sections.vision, estimateInputItemTokens([screenshotResult()] as never))
  assert.equal(bill.visionItems, 1)
  assert.equal(bill.sections.tool_results, 0)
})

test('tool_results: tool call + result items are attributed to tool_results, not vision', () => {
  const bill = billProviderRequestSections([
    { type: 'function_call', callId: 'c1', name: 'x', arguments: '{}' },
    { type: 'function_call_result', callId: 'c1', output: 'some tool output text' }
  ] as never)
  assert.ok(bill.sections.tool_results > 0)
  assert.equal(bill.sections.vision, 0)
})

test('reminders: system role and <system-reminder> content are attributed to reminders', () => {
  const bill = billProviderRequestSections([
    { role: 'system', content: 'you are ready' },
    { role: 'user', content: '<system-reminder>budget low</system-reminder>' }
  ] as never)
  assert.ok(bill.sections.reminders > 0)
  assert.equal(bill.sections.history, 0)
})

test('partition: sections sum EXACTLY to totalTokens (disjoint, no double-count / no gap)', () => {
  const bill = billProviderRequestSections([
    imageItem(),
    { type: 'function_call_result', callId: 'c1', output: 'r' },
    { role: 'user', content: 'hello' },
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'SKILL.md 内联方法论' }
  ] as never)
  const sum = Object.values(bill.sections).reduce((a, b) => a + b, 0)
  assert.equal(sum, bill.totalTokens)
  assert.equal(bill.itemCount, 5)
})

test('diagnosis question: a re-sent image reads as the SAME vision cost each turn (re-send, not one-time)', () => {
  const image = imageItem()
  const turn1 = billProviderRequestSections([image] as never)
  const turn2 = billProviderRequestSections([image, { role: 'assistant', content: 'ok' }] as never)
  assert.equal(
    turn1.sections.vision,
    turn2.sections.vision,
    'vision cost persists across turns → image re-sent'
  )
})

test('empty request bills to zero everywhere', () => {
  const bill = billProviderRequestSections([] as never)
  assert.equal(bill.totalTokens, 0)
  assert.equal(bill.itemCount, 0)
  assert.equal(bill.visionItems, 0)
})

test('total-safe: a null/garbage item never throws (the emit hot path has no try/catch)', () => {
  // A throw here would reject callModelInputFilter and break the provider call.
  assert.doesNotThrow(() =>
    billProviderRequestSections([
      null,
      undefined,
      42,
      'x',
      { role: 'user', content: 'ok' }
    ] as never)
  )
  const bill = billProviderRequestSections([
    null,
    undefined,
    { role: 'user', content: 'ok' }
  ] as never)
  assert.equal(bill.itemCount, 3)
})

test('partition still holds with the real image shape (sections sum to total)', () => {
  const bill = billProviderRequestSections([
    imageItem(),
    screenshotResult(),
    { role: 'user', content: 'hi' }
  ] as never)
  const sum = Object.values(bill.sections).reduce((a, b) => a + b, 0)
  assert.equal(sum, bill.totalTokens)
})

test('image estimate scales data URLs for text protocols while opaque refs keep the tile floor', () => {
  const small = { type: 'input_image', image: `data:image/png;base64,${'A'.repeat(1_000)}` }
  const large = { type: 'input_image', image: `data:image/png;base64,${'A'.repeat(500_000)}` }
  const opaque = { type: 'input_image', image: { id: 'image-1' } }
  const screenshot = {
    type: 'computer_screenshot',
    data: `data:image/png;base64,${'A'.repeat(500_000)}`
  }
  assert.equal(estimateInputItemTokens([small] as never), IMAGE_EST_TOKENS)
  assert.equal(
    estimateInputItemTokens([large] as never),
    estimateImageDataTokens(String(large.image).length),
  )
  assert.equal(estimateInputItemTokens([opaque] as never), IMAGE_EST_TOKENS)
  assert.equal(
    estimateInputItemTokens([screenshot] as never),
    estimateImageDataTokens(String(screenshot.data).length),
  )
})

test('three large data URLs safely cross the 0.8 x 200K text-protocol compaction threshold', () => {
  const dataUrl = `data:image/webp;base64,${'A'.repeat(500_000)}`
  const items = [
    { role: 'user', content: [{ type: 'input_image', image: dataUrl }] },
    { role: 'user', content: [{ type: 'input_image', image: dataUrl }] },
    { role: 'user', content: [{ type: 'input_image', image: dataUrl }] },
    { role: 'user', content: '请比较三张图并写一份完整分析' }
  ]
  assert.ok(
    dataUrl.length * 3 > 200_000 * 0.8,
    'legacy byte-like estimate crossed the soft threshold'
  )
  assert.ok(estimateInputItemTokens(items as never) >= 200_000 * 0.8)
})

test('plain-text estimation remains unchanged by image calibration', () => {
  const text = 'hello 世界'
  assert.equal(estimateInputItemTokens([{ role: 'user', content: text }] as never), 14)
  assert.equal(estimateTextTokens(text), 4)
})

test('provider usage emits estimate reconciliation with ratio and vision count', () => {
  const metrics: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => metrics.push(event))
  try {
    emitProviderEstimateReconciliation({
      agentName: 'butler',
      sessionId: 'scope-1',
      runId: 'run-1',
      taskId: 'task-1',
      requestIndex: 0,
      estimatedTokens: 4800,
      actualInputTokens: 3200,
      visionItems: 3
    })
    const metric = metrics.find((event) => event.metric === 'provider_estimate_reconciliation')
    assert.ok(metric)
    assert.equal(metric.estimatedTokens, 4800)
    assert.equal(metric.actualInputTokens, 3200)
    assert.equal(metric.ratio, 1.5)
    assert.equal(metric.visionItems, 3)
    assert.equal(metric.runId, 'run-1')
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('SDK run usage counts every provider request around tool execution', () => {
  const usage = usageFromModelResponses([
    { usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } },
    { usage: { inputTokens: 140, outputTokens: 20, totalTokens: 160 } },
  ] as never)
  assert.deepEqual(usage, {
    inputTokens: 240,
    outputTokens: 30,
    totalTokens: 270,
    lastRequestInputTokens: 140,
  })
  assert.equal(usageFromModelResponses([]), undefined)
})

test('compacted requests reconcile provider usage against the wire bill, not the diagnostic pre-compaction bill', () => {
  const metrics: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => metrics.push(event))
  try {
    const bills = recordProviderRequestBills({
      agentName: 'butler',
      sessionId: 'scope-1',
      runId: 'run-compact',
      taskId: 'task-compact',
      contextWindowTokens: 200_000,
      beforeInput: [imageItem(), { role: 'user', content: 'history '.repeat(10_000) }] as never,
      wireInput: [{ role: 'user', content: 'compacted summary' }] as never,
      compacted: true
    })
    assert.ok(bills.diagnostic.totalTokens > bills.wire.totalTokens)
    emitProviderEstimateReconciliation({
      agentName: 'butler',
      sessionId: 'scope-1',
      runId: 'run-compact',
      taskId: 'task-compact',
      requestIndex: 0,
      estimatedTokens: bills.wire.totalTokens,
      actualInputTokens: bills.wire.totalTokens,
      visionItems: bills.wire.visionItems
    })
    const diagnostic = metrics.find((event) => event.metric === 'provider_request_bill')
    const wire = metrics.find((event) => event.metric === 'provider_wire_request_bill')
    const reconciliation = metrics.find(
      (event) => event.metric === 'provider_estimate_reconciliation'
    )
    assert.equal(diagnostic?.totalTokens, bills.diagnostic.totalTokens)
    assert.equal(wire?.totalTokens, bills.wire.totalTokens)
    assert.equal(wire?.compacted, true)
    assert.equal(wire?.savedTokens, bills.diagnostic.totalTokens - bills.wire.totalTokens)
    assert.equal(reconciliation?.estimatedTokens, bills.wire.totalTokens)
    assert.equal(reconciliation?.ratio, 1)
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('wire bill includes system instructions and tool schemas', () => {
  const metrics: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => metrics.push(event))
  try {
    const short = recordProviderRequestBills({
      agentName: 'butler',
      sessionId: 'scope-instructions',
      runId: 'run-short',
      taskId: 'task-short',
      contextWindowTokens: 200_000,
      beforeInput: [{ role: 'user', content: 'same input' }] as never,
      wireInput: [{ role: 'user', content: 'same input' }] as never,
      instructions: 'short',
      tools: [{ name: 'short_tool', description: 'short', parameters: { type: 'object' } }],
      compacted: false
    })
    const long = recordProviderRequestBills({
      agentName: 'butler',
      sessionId: 'scope-instructions',
      runId: 'run-long',
      taskId: 'task-long',
      contextWindowTokens: 200_000,
      beforeInput: [{ role: 'user', content: 'same input' }] as never,
      wireInput: [{ role: 'user', content: 'same input' }] as never,
      instructions: 'long system instruction '.repeat(100),
      tools: [
        {
          name: 'long_tool',
          description: 'long tool description '.repeat(100),
          parameters: {
            type: 'object',
            properties: { value: { type: 'string', description: 'long field '.repeat(100) } }
          }
        }
      ],
      compacted: false
    })
    assert.ok(long.wire.totalTokens > short.wire.totalTokens)
    assert.ok(long.wire.sections.tool_schema > short.wire.sections.tool_schema)
    assert.equal(long.wire.toolSchemaCount, 1)
    const wireMetric = metrics.find(
      (event) => event.metric === 'provider_wire_request_bill' && event.runId === 'run-long'
    )
    assert.equal(wireMetric?.estimatedCoverage, 'instructions_input_and_tool_schemas')
    assert.deepEqual(wireMetric?.omittedSections, [])
    assert.equal(wireMetric?.toolSchemaCount, 1)
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('provider bills count the SDK-enabled snapshot, not latent registered tools', async () => {
  const registeredTools = Array.from({ length: 18 }, (_, index) => tool({
    name: `tool_${index}`,
    description: `tool ${index}`,
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    } as never,
    strict: false,
    isEnabled: async () => index === 0,
    execute: async () => 'ok',
  }))
  const agent = new Agent({
    name: 'billing-agent',
    instructions: 'system',
    model: 'test-model',
    tools: registeredTools,
  })
  const enabledTools = await resolveEnabledSdkToolsForRequest(agent, undefined)
  assert.equal(enabledTools.length, 1)
  assert.equal(enabledTools[0].type, 'function')
  assert.equal(enabledTools[0].name, 'tool_0')

  const metrics: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => metrics.push(event))
  try {
    const bills = recordProviderRequestBills({
      agentName: 'billing-agent',
      sessionId: 'scope-billing',
      runId: 'run-billing',
      taskId: 'task-billing',
      contextWindowTokens: 200_000,
      beforeInput: [{ role: 'user', content: 'hello' }] as never,
      wireInput: [{ role: 'user', content: 'hello' }] as never,
      tools: enabledTools,
      configuredToolSchemaCount: registeredTools.length,
      compacted: false,
    })
    assert.equal(bills.diagnostic.toolSchemaCount, 1)
    assert.equal(bills.wire.toolSchemaCount, 1)
    const wire = metrics.find((event) => event.metric === 'provider_wire_request_bill')
    assert.equal(wire?.toolSchemaCount, 1)
    assert.equal(wire?.configuredToolSchemaCount, 18)
    assert.equal(wire?.disabledToolSchemaCount, 17)
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('provider request body and wire bill share the same enabled-tool snapshot', async () => {
  let alternatingToolChecks = 0
  const registeredTools = Array.from({ length: 18 }, (_, index) => tool({
    name: `wire_tool_${index}`,
    description: `wire tool ${index}`,
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    } as never,
    strict: false,
    isEnabled: async () => {
      if (index !== 0) return false
      alternatingToolChecks += 1
      return alternatingToolChecks === 1
    },
    execute: async () => 'ok',
  }))
  const requestBodies: Array<Record<string, unknown>> = []
  const config = {
    provider: 'openai-compatible' as const,
    baseUrl: 'https://compatible.example/v1',
    apiKey: 'test-key',
    model: 'custom-model',
    toolUseMode: 'on' as const,
  }
  const model = new ReadyOpenAICompatibleModel({
    config,
    baseUrl: config.baseUrl,
    fetchWithTimeout: (async (_url, init) => {
      requestBodies.push(JSON.parse(String(init.body || '{}')) as Record<string, unknown>)
      return new Response(JSON.stringify({
        id: 'response-enabled-tools',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as never,
  })
  const metrics: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => metrics.push(event))
  try {
    await runWithOpenAIAgentsSdk({
      agentName: 'billing-agent',
      sessionId: 'scope-wire-billing',
      runId: 'run-wire-billing',
      taskId: 'task-wire-billing',
      input: 'hello',
      instructions: 'system',
      model: config.model,
      provider: { getModel: () => model },
      session: new MemorySession(),
      tools: registeredTools,
      signal: new AbortController().signal,
      maxTurns: 1,
      contextWindowTokens: 200_000,
      maxOutputTokens: 1024,
      onTextDelta: () => undefined,
    })

    assert.equal(requestBodies.length, 1)
    const wireTools = requestBodies[0].tools as Array<{
      function?: { name?: string }
    }>
    assert.equal(wireTools.length, 1)
    assert.equal(wireTools[0].function?.name, 'wire_tool_0')
    assert.equal(
      alternatingToolChecks,
      1,
      'billing must reuse ModelRequest.tools without re-running isEnabled',
    )
    const wireBill = metrics.find(
      (event) => event.metric === 'provider_wire_request_bill'
        && event.runId === 'run-wire-billing'
    )
    assert.equal(wireBill?.toolSchemaCount, wireTools.length)
    assert.equal(wireBill?.configuredToolSchemaCount, 18)
    assert.equal(wireBill?.disabledToolSchemaCount, 17)
  } finally {
    __setMetricSinkForTests(null)
  }
})
