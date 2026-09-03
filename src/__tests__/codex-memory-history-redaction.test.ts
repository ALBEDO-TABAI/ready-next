import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import test from 'node:test'

import {
  createCodexUpstreamProfileSnapshot,
  currentTurnReadyAdditionalContext,
  digestCanonicalJson,
  digestReadyAdditionalContext,
  instructionTranscriptDigest,
} from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import { redactPriorReadyMemoryHistory } from '../main/modules/agent-control/codex-runtime/codex-memory-history-redaction'
import {
  CodexModelGateway,
  type CodexModelGatewayBinding,
  type CodexModelGatewayValidatedRequestCapture,
} from '../main/modules/agent-control/codex-runtime/codex-model-gateway'
import {
  readyMemoryPromptText,
  type ReadyMemoryPromptPayload,
} from '../main/modules/agent-control/ready-memory/ready-memory-contract'

// Direct redactor tests supply the same validated scanner result that Gateway owns.
// Invalid input deliberately supplies no current context, exercising fail-closed removal.
function redactHistory(input: Omit<Parameters<typeof redactPriorReadyMemoryHistory>[0], 'currentTurnContext'>) {
  let currentTurnContext: ReturnType<typeof currentTurnReadyAdditionalContext> | null = null
  if (input.requestKind === 'product') {
    try { currentTurnContext = currentTurnReadyAdditionalContext(input.input, []) } catch { /* invalid boundary */ }
  }
  return redactPriorReadyMemoryHistory({ ...input, currentTurnContext })
}

function message(role: 'assistant' | 'developer' | 'user', text: string) {
  return { type: 'message', role, content: [{ type: 'input_text', text }] }
}

function memoryPayload(summary: string): ReadyMemoryPromptPayload {
  return {
    contract: 'ready-memory:v1',
    snapshotDigest: digestCanonicalJson({ summary }),
    stateRevision: 1,
    revocationRevision: 0,
    frozenAt: '2026-08-20T00:00:00.000Z',
    summary,
    summaryEntryIds: [],
    truncated: false,
    priority: 'current_user_over_memory',
  }
}

function memoryMarker(summary: string) {
  const snapshot = memoryPayload(summary)
  return {
    item: message('developer', readyMemoryPromptText(snapshot)),
    snapshot,
  }
}

function memoryCall(callId: string, args = '{"query":"ready"}') {
  return { type: 'function_call', call_id: callId, name: 'ready_memory_search', arguments: args }
}

function toolOutput(callId: string, output: unknown = 'result') {
  return { type: 'function_call_output', call_id: callId, output }
}

function readyResource(logicalResourceId: string) {
  const reference = {
    logicalResourceId,
    currentVersion: 'v1',
    currentDigest: `digest-${logicalResourceId}`,
    supersedesVersion: null,
    policyEpoch: 1,
  }
  return message('developer', `<ready_resources>${JSON.stringify(reference)}</ready_resources>`)
}

function explicitRetry() {
  return message('developer', '<ready-explicit-retry>{"attempt":2}</ready-explicit-retry>')
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') reject(new Error('fixture_address_invalid'))
      else resolve(address.port)
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

test('product history removes only prior Ready-memory items across two turns', () => {
  const oldMarker = memoryMarker('old')
  const currentMarker = memoryMarker('current')
  const unrelatedCall = {
    type: 'function_call', call_id: 'other-old', name: 'browser_read', arguments: '{}',
  }
  const unrelatedOutput = toolOutput('other-old', 'page')
  const currentCall = memoryCall('memory-current')
  const currentOutput = toolOutput('memory-current')
  const input = [
    oldMarker.item,
    message('user', 'first turn'),
    message('assistant', 'first answer'),
    memoryCall('memory-old'),
    toolOutput('memory-old'),
    unrelatedCall,
    unrelatedOutput,
    currentMarker.item,
    message('user', 'second turn'),
    currentCall,
    currentOutput,
    message('assistant', 'current work'),
  ]

  const result = redactHistory({ requestKind: 'product', input })

  assert.deepEqual(result.input, [
    input[1], input[2], unrelatedCall, unrelatedOutput,
    currentMarker.item, input[8], currentCall, currentOutput, input[11],
  ])
  assert.deepEqual({
    redactedItemCount: result.evidence.redactedItemCount,
    messages: result.evidence.redactedReadyMemoryMessageCount,
    calls: result.evidence.redactedReadyMemoryFunctionCallCount,
    outputs: result.evidence.redactedReadyMemoryFunctionCallOutputCount,
  }, { redactedItemCount: 3, messages: 1, calls: 1, outputs: 1 })
  assert.equal(result.evidence.currentTurnMemorySnapshotDigest, currentMarker.snapshot.snapshotDigest)
  assert.equal(result.evidence.failClosed, false)
  assert.equal(result.evidence.providerInputDigest, digestCanonicalJson(result.input))
  assert.equal(
    redactHistory({ requestKind: 'product', input }).evidence.redactionDigest,
    result.evidence.redactionDigest,
  )
})

test('current marker remains valid across resource and retry additionalContext adjacency', () => {
  const oldMarker = memoryMarker('old')
  const currentMarker = memoryMarker('current')
  const resource = readyResource('document-1')
  const retry = explicitRetry()
  const input = [
    oldMarker.item,
    message('user', 'old turn'),
    message('assistant', 'old answer'),
    currentMarker.item,
    resource,
    retry,
    message('user', 'current turn'),
    memoryCall('memory-current'),
    toolOutput('memory-current'),
  ]

  const result = redactHistory({ requestKind: 'product', input })

  assert.deepEqual(result.input, input.slice(1))
  assert.equal(result.evidence.currentTurnMemorySnapshotDigest, currentMarker.snapshot.snapshotDigest)
  assert.equal(result.evidence.failClosed, false)
  assert.equal(result.evidence.redactedItemCount, 1)
})

test('malformed marker contracts and missing user boundaries fail closed without memory', () => {
  const malformedSnapshot = { ...memoryPayload('bad'), snapshotDigest: 'bad' }
  const malformedMarker = message(
    'developer',
    `<ready-memory:v1>${JSON.stringify(malformedSnapshot)}</ready-memory:v1>`,
  )
  const malformedInput = [
    malformedMarker,
    message('user', 'current turn'),
    memoryCall('memory-current'),
    toolOutput('memory-current'),
    message('assistant', 'ordinary'),
  ]
  const malformed = redactHistory({ requestKind: 'product', input: malformedInput })
  assert.deepEqual(malformed.input, [malformedInput[1], malformedInput[4]])
  assert.equal(malformed.evidence.failClosed, true)
  assert.equal(malformed.evidence.currentTurnMemorySnapshotDigest, null)

  const marker = memoryMarker('no user')
  const noUserInput = [marker.item, memoryCall('memory-no-user'), toolOutput('memory-no-user')]
  const noUser = redactHistory({ requestKind: 'product', input: noUserInput })
  assert.deepEqual(noUser.input, [])
  assert.equal(noUser.evidence.failClosed, true)
  assert.equal(noUser.evidence.redactedItemCount, 3)
})

test('a malformed current memory roundtrip is removed as a pair', () => {
  const marker = memoryMarker('current')
  const input = [
    marker.item,
    message('user', 'current turn'),
    memoryCall('memory-current', '[]'),
    toolOutput('memory-current'),
    message('assistant', 'ordinary'),
  ]

  const result = redactHistory({ requestKind: 'product', input })

  assert.deepEqual(result.input, [marker.item, input[1], input[4]])
  assert.equal(result.evidence.redactedReadyMemoryFunctionCallCount, 1)
  assert.equal(result.evidence.redactedReadyMemoryFunctionCallOutputCount, 1)
})

test('unrecognized developer text and malformed unrelated tools remain untouched', () => {
  const marker = memoryMarker('current')
  const ordinaryDeveloper = message(
    'developer',
    'ordinary note containing <ready-memory:v1> but not the reserved envelope',
  )
  const malformedOtherCall = {
    type: 'function_call', call_id: 'other-current', name: 'browser_read', arguments: '[',
  }
  const malformedOtherOutput = toolOutput('other-current')
  const input = [
    ordinaryDeveloper,
    message('user', 'old turn'),
    message('assistant', 'old answer'),
    marker.item,
    message('user', 'current turn'),
    malformedOtherCall,
    malformedOtherOutput,
  ]

  const result = redactHistory({ requestKind: 'product', input })

  assert.deepEqual(result.input, input)
  assert.equal(result.evidence.failClosed, false)
  assert.equal(result.evidence.redactedItemCount, 0)
})

test('automatic and manual compaction remove all Ready-memory markers and tool roundtrips', () => {
  const oldMarker = memoryMarker('old')
  const currentMarker = memoryMarker('current')
  const ordinary = message('assistant', 'keep')
  const input = [
    oldMarker.item,
    message('user', 'old'),
    memoryCall('memory-old'),
    toolOutput('memory-old'),
    currentMarker.item,
    message('user', 'current'),
    memoryCall('memory-current'),
    toolOutput('memory-current'),
    ordinary,
  ]

  for (const requestKind of ['automatic_compaction', 'manual_compaction'] as const) {
    const result = redactHistory({ requestKind, input })
    assert.deepEqual(result.input, [input[1], input[5], ordinary])
    assert.equal(result.evidence.failClosed, true)
    assert.equal(result.evidence.redactedReadyMemoryMessageCount, 2)
    assert.equal(result.evidence.redactedReadyMemoryFunctionCallCount, 2)
    assert.equal(result.evidence.redactedReadyMemoryFunctionCallOutputCount, 2)
  }
})

test('gateway validates original sidecar input but receipts and forwards redacted product and compaction input', async () => {
  const upstreamBodies: Record<string, unknown>[] = []
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end([
      `event: response.created\ndata: ${JSON.stringify({
        type: 'response.created', sequence_number: 0,
        response: { id: 'response-memory', model: 'native-model', status: 'in_progress', output: [] },
      })}`,
      `event: response.completed\ndata: ${JSON.stringify({
        type: 'response.completed', sequence_number: 1,
        response: {
          id: 'response-memory', model: 'native-model', status: 'completed', output: [],
          usage: {
            input_tokens: 0, output_tokens: 0, total_tokens: 0,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      })}`,
      '',
    ].join('\n\n'))
  })
  const upstreamPort = await listen(upstream)
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'memory-redaction-profile',
    config: {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      apiKey: 'upstream-secret', model: 'native-model', agentProtocol: 'openai',
      wireApi: 'responses', toolUseMode: 'on',
    },
    maxRetries: 0,
  })
  const tools = [{
    type: 'function', name: 'ready_memory_search', description: 'memory',
    parameters: { type: 'object' },
  }]
  const oldMarker = memoryMarker('old')
  const currentMarker = memoryMarker('current')
  const earlierInput = [{ type: 'text' as const, text: 'older retained B', text_elements: [] }]
  const tail = { contract: 'ready_uncommitted_user_tail_v1' as const, originUserMessageId: 'older-B',
    input: earlierInput, inputDigest: digestCanonicalJson(earlierInput) }
  const tailMessage = message('user', `<external_ready-uncommitted-user-tail:0>${JSON.stringify(tail)}</external_ready-uncommitted-user-tail:0>`)
  const originalInput = [
    oldMarker.item,
    message('user', 'first turn'),
    message('assistant', 'first answer'),
    memoryCall('memory-old'),
    toolOutput('memory-old'),
    currentMarker.item,
    readyResource('current-document'),
    tailMessage,
    message('user', 'second turn'),
    memoryCall('memory-current'),
    toolOutput('memory-current'),
  ]
  const body: Record<string, unknown> = {
    model: 'ready-e0-model', instructions: 'fixed instructions', input: originalInput,
    tools, tool_choice: 'auto', parallel_tool_calls: false,
    reasoning: { summary: 'auto' }, include: ['reasoning.encrypted_content'],
    prompt_cache_key: 'thread-memory', store: false, stream: true,
    client_metadata: {
      'x-codex-installation-id': 'installation-memory', session_id: 'thread-memory',
      'x-codex-window-id': 'thread-memory:0', turn_id: 'turn-memory', thread_id: 'thread-memory',
      root_turn_id: 'turn-memory',
      'x-codex-turn-metadata': JSON.stringify({
        installation_id: 'installation-memory', session_id: 'thread-memory', request_kind: 'turn',
        thread_id: 'thread-memory', turn_id: 'turn-memory', window_id: 'thread-memory:0',
        root_turn_id: 'turn-memory', agent_name: '/root',
        sandbox: 'seatbelt', sandbox_mode: 'read-only', auto_review_enabled: false,
        node_repl_auto_review_required: false, node_repl_disabled: false,
        turn_started_at_unix_ms: 1, readyRunId: 'run-memory',
        toolSurfaceDigest: digestCanonicalJson(tools), turnContractDigest: 'turn-contract-memory',
        upstreamProfileSnapshotDigest: created.snapshotDigest,
      }),
    },
  }
  const binding: CodexModelGatewayBinding = {
    kind: 'product', codexModel: 'ready-e0-model', snapshot: created.snapshot,
    snapshotDigest: created.snapshotDigest, toolSurfaceDigest: digestCanonicalJson(tools),
    turnContractDigest: 'turn-contract-memory',
    instructionContractDigest: instructionTranscriptDigest(body.instructions, body.input),
    deliveredUserTail: [tail],
    additionalContextDigest: digestReadyAdditionalContext(
      { resourceReferences: [{ logicalResourceId: 'current-document', currentVersion: 'v1',
          currentDigest: 'digest-current-document', supersedesVersion: null, policyEpoch: 1 }],
        explicitRetry: null, readyMemory: currentMarker.snapshot },
    ),
    forceToolFreeFinalization: false, allowedToolNames: ['ready_memory_search'],
  }
  const durableRequests: Array<{
    requestDigest: string
    inputDigest: string
    redactionDigest: string
    redactedCount: number
  }> = []
  const validatedCaptures: CodexModelGatewayValidatedRequestCapture[] = []
  let compactionFixtureBody: Record<string, unknown> | null = null
  const gateway = new CodexModelGateway({
    bearerToken: 'memory-gateway-token',
    authority: {
      async resolve(input) {
        assert.throws(() => input.prepareRequestReceipt(), /gateway_request_prepared_before_validation/)
        if (input.metadata.raw.request_kind === 'compaction' && !compactionFixtureBody) {
          throw new Error('compaction_fixture_missing')
        }
        const resolved = input.metadata.raw.request_kind === 'compaction'
          ? {
              ...binding,
              kind: ((input.metadata.raw.compaction as Record<string, unknown>).trigger === 'manual'
                ? 'manual_compaction' : 'automatic_compaction') as 'automatic_compaction' | 'manual_compaction',
              deliveredUserTail: [],
              toolSurfaceDigest: digestCanonicalJson([]),
              instructionContractDigest: instructionTranscriptDigest(
                compactionFixtureBody?.instructions,
                compactionFixtureBody?.input,
              ),
              allowedToolNames: null,
            }
          : binding
        input.validate(resolved)
        const receipt = input.prepareRequestReceipt()
        durableRequests.push({
          requestDigest: receipt.requestDigest,
          inputDigest: receipt.requestEvidence.inputDigest,
          redactionDigest: receipt.requestEvidence.memoryHistoryRedactionDigest,
          redactedCount: receipt.requestEvidence.memoryHistoryRedactedItemCount,
        })
        return resolved
      },
    },
    credentials: { resolve() { return 'upstream-secret' } },
    onValidatedRequest(capture) { validatedCaptures.push(capture) },
  })
  const address = await gateway.start()
  try {
    const response = await fetch(`${address.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer memory-gateway-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const responseText = await response.text()
    assert.equal(response.status, 200, responseText)
    assert.match(responseText, /response\.completed/)

    const expectedProviderInput = [
      originalInput[1], originalInput[2], currentMarker.item, originalInput[6],
      originalInput[7], originalInput[8], originalInput[9], originalInput[10],
    ]
    const redactedSidecarBody = { ...body, input: expectedProviderInput }
    assert.deepEqual(upstreamBodies[0]?.input, expectedProviderInput)
    assert.equal(durableRequests[0].requestDigest, digestCanonicalJson(redactedSidecarBody))
    assert.equal(durableRequests[0].inputDigest, digestCanonicalJson(expectedProviderInput))
    assert.equal(durableRequests[0].redactedCount, 3)
    assert.match(durableRequests[0].redactionDigest, /^[a-f0-9]{64}$/)
    assert.equal(validatedCaptures[0]?.requestDigest, durableRequests[0].requestDigest)
    assert.equal(validatedCaptures[0]?.inputDigest, durableRequests[0].inputDigest)
    assert.equal(validatedCaptures[0]?.sidecarRequestDigest, digestCanonicalJson(body))
    assert.equal(validatedCaptures[0]?.sidecarInputDigest, digestCanonicalJson(originalInput))

    for (const [compactionIndex, trigger] of ['auto', 'manual'].entries()) {
      const compactionBody = structuredClone(body)
      compactionBody.tools = []
      const compactionMetadata = JSON.parse(
        (compactionBody.client_metadata as Record<string, string>)['x-codex-turn-metadata'],
      ) as Record<string, unknown>
      compactionMetadata.request_kind = 'compaction'
      compactionMetadata.compaction = {
        trigger, reason: trigger === 'manual' ? 'user_requested' : 'context_limit', implementation: 'responses',
        phase: trigger === 'manual' ? 'standalone_turn' : 'pre_turn', strategy: 'memento',
      }
      compactionMetadata.toolSurfaceDigest = digestCanonicalJson([])
      if (trigger === 'manual') {
        delete (compactionBody.client_metadata as Record<string, unknown>).root_turn_id
        for (const key of ['root_turn_id', 'readyRunId', 'toolSurfaceDigest', 'turnContractDigest', 'upstreamProfileSnapshotDigest']) {
          delete compactionMetadata[key]
        }
      }
      ;(compactionBody.client_metadata as Record<string, string>)['x-codex-turn-metadata'] = JSON.stringify(
        compactionMetadata,
      )
      compactionFixtureBody = compactionBody
      const compactionResponse = await fetch(`${address.url}/v1/responses`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer memory-gateway-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(compactionBody),
      })
      const compactionText = await compactionResponse.text()
      assert.equal(compactionResponse.status, 200, compactionText)
      assert.match(compactionText, /response\.completed/)
      const compactionExpectedInput = [
        originalInput[1], originalInput[2], originalInput[6], originalInput[7], originalInput[8],
      ]
      assert.deepEqual(upstreamBodies[compactionIndex + 1]?.input, compactionExpectedInput)
      assert.equal(durableRequests[compactionIndex + 1].inputDigest, digestCanonicalJson(compactionExpectedInput))
      assert.equal(durableRequests[compactionIndex + 1].redactedCount, 6)
    }
  } finally {
    await gateway.stop()
    await close(upstream)
  }
})


test('the shared current-context scanner retains strict current memory shape and uniqueness', () => {
  const marker = memoryMarker('current')
  const current = message('user', 'current C')
  for (const markers of [
    [marker.item, marker.item],
    [{ ...marker.item, role: 'user' }],
    [{ ...marker.item, injected: 'extra' }],
    [{ ...marker.item, content: [{ ...marker.item.content[0], injected: 'extra' }] }],
    [{ ...marker.item, content: [marker.item.content[0], { type: 'input_image', image_url: 'hidden' }] }],
  ]) {
    assert.throws(() => currentTurnReadyAdditionalContext([...markers, current], []), /gateway_memory_context_invalid/)
    assert.equal(redactHistory({ requestKind: 'product', input: [...markers, current] }).evidence.failClosed, true)
  }
})
