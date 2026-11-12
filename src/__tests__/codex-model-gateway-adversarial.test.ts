import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import test from 'node:test'

import {
  classifyCodexModelGatewayRequest,
  createCodexUpstreamProfileSnapshot,
  currentTurnReadyAdditionalContext,
  digestCanonicalJson,
  currentTurnReadyResourceReferences,
  digestReadyAdditionalContext,
  digestReadyResourceReferences,
  instructionTranscriptDigest,
  latestReadyResourceReferences,
  responsesToolArgumentValidators,
  type CodexUpstreamProfileSnapshot,
} from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import {
  ReadySettingsModelGatewayCredentialStore,
} from '../main/modules/agent-control/codex-runtime/codex-model-gateway-authority'
import { responsesRequestToChat } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-chat'
import { parseMetadata, validateBinding } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-request'
import { streamChatAsResponses } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-chat-stream'
import {
  CodexModelGateway,
  CodexModelGatewayError,
  type CodexModelGatewayBinding,
  type CodexModelGatewayToolResponseCall,
} from '../main/modules/agent-control/codex-runtime/codex-model-gateway'

type JsonObject = Record<string, unknown>

function nativeUsage(): JsonObject {
  return {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  }
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

function requestBody(toolNames: string[] = []): JsonObject {
  const tools = toolNames.map((name) => ({
    type: 'function', name, description: name,
    parameters: { type: 'object' },
  }))
  return {
    model: 'ready-e0-model',
    instructions: 'fixed instructions',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    tools,
    tool_choice: 'auto',
    parallel_tool_calls: true,
    reasoning: { summary: 'auto' },
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: 'thread-1',
    store: false,
    stream: true,
    client_metadata: {
      'x-codex-installation-id': 'installation-adversarial',
      session_id: 'thread-1',
      'x-codex-window-id': 'thread-1:0',
      turn_id: 'turn-1',
      thread_id: 'thread-1',
      root_turn_id: 'turn-1',
      'x-codex-turn-metadata': JSON.stringify({
        installation_id: 'installation-adversarial', session_id: 'thread-1',
        thread_id: 'thread-1', turn_id: 'turn-1', window_id: 'thread-1:0',
        root_turn_id: 'turn-1', agent_name: '/root', request_kind: 'turn',
        sandbox: 'seatbelt', sandbox_mode: 'read-only', auto_review_enabled: false,
        node_repl_auto_review_required: false, node_repl_disabled: false,
        turn_started_at_unix_ms: 1, window_number: 0, context_window_id: 'context-window-1',
        analytics_enabled: false, model: 'ready-e0-model',
        readyRunId: 'run-1',
        toolSurfaceDigest: digestCanonicalJson(tools), turnContractDigest: 'turn-contract-1',
        upstreamProfileSnapshotDigest: 'pending',
      }),
    },
  }
}

function bindRequest(request: JsonObject, snapshot: CodexUpstreamProfileSnapshot): CodexModelGatewayBinding {
  const metadata = JSON.parse(
    (request.client_metadata as Record<string, string>)['x-codex-turn-metadata'],
  ) as JsonObject
  metadata.upstreamProfileSnapshotDigest = digestCanonicalJson(snapshot)
  ;(request.client_metadata as Record<string, string>)['x-codex-turn-metadata'] = JSON.stringify(metadata)
  return {
    kind: 'product', codexModel: 'ready-e0-model', snapshot,
    snapshotDigest: digestCanonicalJson(snapshot),
    toolSurfaceDigest: metadata.toolSurfaceDigest as string,
    requestToolsDigest: metadata.toolSurfaceDigest as string,
    turnContractDigest: 'turn-contract-1',
    instructionContractDigest: instructionTranscriptDigest(request.instructions, request.input),
    additionalContextDigest: digestCanonicalJson([]),
    deliveredUserTail: [],
    forceToolFreeFinalization: false,
    allowedToolNames: Array.isArray(request.tools)
      ? [...new Set(request.tools.flatMap((tool) => (
          tool && typeof tool === 'object' && typeof (tool as JsonObject).name === 'string'
            ? [(tool as JsonObject).name as string]
            : []
        )))].sort()
      : [],
  }
}

// 2026-10-07: under 0.160.1 a thread frozen by 0.149 sends its dynamic tools with minItems, so the wire no longer
// hashes to the frozen surface identity. The wire is checked against the derived request tools, the turn metadata
// against the identity.
test('request tools are checked against the derived wire while metadata keeps the frozen surface identity', () => {
  const request = requestBody()
  const binding = bindRequest(request, createCodexUpstreamProfileSnapshot({
    profileId: 'profile-lineage', maxRetries: 0,
    config: {
      provider: 'openai-compatible', baseUrl: 'https://provider.example/v1', apiKey: 'secret',
      model: 'qwen-model', agentProtocol: 'openai', wireApi: 'chat/completions', toolUseMode: 'on',
    },
  }).snapshot)
  const lineage = digestCanonicalJson({ fixture: 'surface-frozen-under-0.149' })
  const outer = request.client_metadata as Record<string, string>
  const raw = JSON.parse(outer['x-codex-turn-metadata']) as JsonObject
  raw.toolSurfaceDigest = lineage
  outer['x-codex-turn-metadata'] = JSON.stringify(raw)
  const metadata = parseMetadata(request)
  const lineageBinding = { ...binding, toolSurfaceDigest: lineage, requestToolsDigest: digestCanonicalJson(request.tools) }
  assert.doesNotThrow(() => validateBinding({ body: request, metadata, binding: lineageBinding }))
  assert.throws(() => validateBinding({ body: request, metadata, binding: { ...lineageBinding, requestToolsDigest: lineage } }),
    /gateway_tool_surface_mismatch/, 'the wire never matches the frozen identity once the serialization changed')
  assert.throws(() => validateBinding({
    body: request, metadata, binding: { ...lineageBinding, toolSurfaceDigest: digestCanonicalJson(request.tools) },
  }), /gateway_product_metadata_mismatch/, 'the turn metadata still carries the frozen identity')
})

test('fork metadata preserves the exact direct parent for product and both compaction shapes', async (t) => {
  const contract = JSON.parse(readFileSync('assets/codex-runtime/contracts/runtime-contracts.json', 'utf8'))
    .modelGatewayContract.request
  assert.deepEqual(contract.metadataOptionalNativeLineageKeys, ['forked_from_thread_id', 'forked_from_ordinal_exclusive'])
  for (const kind of ['product', 'automatic_compaction', 'manual_compaction'] as const) {
    await t.test(kind, async () => {
      const seen: JsonObject[] = []
      const gateway = new CodexModelGateway({
        bearerToken: 'fork-metadata-token',
        authority: { async resolve(input) {
          seen.push(input.metadata.raw)
          throw new CodexModelGatewayError('fork_metadata_reached_authority', 409)
        } },
        credentials: { resolve() { throw new Error('metadata_probe_must_not_request_credentials') } },
      })
      const address = await gateway.start()
      try {
        const body = requestBody()
        const outer = body.client_metadata as JsonObject
        const raw = JSON.parse(String(outer['x-codex-turn-metadata'])) as JsonObject
        assert.deepEqual(Object.keys(raw).filter((key) => (
          !contract.productMetadataKeys.includes(key) && !contract.productNativeMetadataKeys.includes(key)
        )).sort(), [...contract.metadataBaseInnerExactKeys].sort())
        raw.forked_from_thread_id = 'direct-parent-not-root'
        if (kind !== 'product') {
          // Pinned 0.160.1 sends the model only on product requests.
          delete raw.model
          raw.request_kind = 'compaction'
          raw.compaction = {
            trigger: kind === 'manual_compaction' ? 'manual' : 'auto',
            reason: kind === 'manual_compaction' ? 'user_requested' : 'context_limit',
            implementation: 'responses',
            phase: kind === 'manual_compaction' ? 'standalone_turn' : 'pre_turn',
            strategy: 'memento',
          }
        }
        if (kind === 'manual_compaction') {
          for (const key of ['readyRunId', 'toolSurfaceDigest', 'turnContractDigest', 'upstreamProfileSnapshotDigest']) {
            delete raw[key]
          }
        }
        const send = async (metadata: JsonObject) => {
          outer['x-codex-turn-metadata'] = JSON.stringify(metadata)
          const response = await fetch(`${address.url}/v1/responses`, {
            method: 'POST', headers: { authorization: 'Bearer fork-metadata-token', 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          return { status: response.status, text: await response.text() }
        }
        const accepted = await send(raw)
        assert.equal(accepted.status, 409)
        assert.match(accepted.text, /fork_metadata_reached_authority/)
        assert.equal(seen[0].forked_from_thread_id, 'direct-parent-not-root')
        const ordinalFork = { ...raw, forked_from_ordinal_exclusive: 12 }
        assert.match((await send(ordinalFork)).text, /fork_metadata_reached_authority/)
        assert.equal(seen[1].forked_from_ordinal_exclusive, 12)
        for (const invalid of [null, -1, 1.5, '12', true, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
          assert.equal((await send({ ...ordinalFork, forked_from_ordinal_exclusive: invalid })).status, 400)
        }
        const orphanOrdinal = { ...ordinalFork } as JsonObject
        delete orphanOrdinal.forked_from_thread_id
        assert.equal((await send(orphanOrdinal)).status, 400)
        for (const invalid of [null, '', '   ', 5, {}]) {
          const rejected = await send({ ...raw, forked_from_thread_id: invalid })
          assert.equal(rejected.status, 400)
        }
        assert.equal((await send({ ...raw, unknown_lineage: 'forged' })).status, 400)
        delete outer.root_turn_id
        assert.equal((await send(raw)).status, 400, 'every request kind requires the captured outer root turn identity')
        assert.equal(seen.length, 2, 'invalid or unknown fields must not reach authority')
      } finally {
        await gateway.stop()
      }
    })
  }
})

test('ordinal-fork product requests pass the gateway metadata and frozen binding validation', () => {
  const request = requestBody()
  const binding = bindRequest(request, createCodexUpstreamProfileSnapshot({
    profileId: 'ordinal-fork', maxRetries: 0,
    config: {
      provider: 'openai-compatible', baseUrl: 'https://provider.example/v1', apiKey: 'fixture',
      model: 'qwen-model', agentProtocol: 'openai', wireApi: 'chat/completions', toolUseMode: 'on',
    },
  }).snapshot)
  const outer = request.client_metadata as Record<string, string>
  const raw = JSON.parse(outer['x-codex-turn-metadata']) as JsonObject
  for (const ordinal of [0, 12, Number.MAX_SAFE_INTEGER]) {
    outer['x-codex-turn-metadata'] = JSON.stringify({
      ...raw, forked_from_thread_id: 'direct-parent', forked_from_ordinal_exclusive: ordinal,
    })
    const metadata = parseMetadata(request)
    assert.equal(metadata.threadId, 'thread-1')
    assert.equal(metadata.raw.forked_from_ordinal_exclusive, ordinal)
    assert.doesNotThrow(() => validateBinding({ body: request, metadata, binding }))
  }
  for (const kind of ['product', 'automatic_compaction', 'manual_compaction']) {
    const metadata = { ...raw }
    if (kind !== 'product') {
      delete metadata.model
      metadata.request_kind = 'compaction'
      metadata.compaction = {
        trigger: kind === 'manual_compaction' ? 'manual' : 'auto',
        reason: kind === 'manual_compaction' ? 'user_requested' : 'context_limit',
        implementation: 'responses', phase: kind === 'manual_compaction' ? 'standalone_turn' : 'pre_turn', strategy: 'memento',
      }
    }
    if (kind === 'manual_compaction') {
      for (const key of ['readyRunId', 'toolSurfaceDigest', 'turnContractDigest', 'upstreamProfileSnapshotDigest']) delete metadata[key]
    }
    const parse = (lineage: JsonObject) => {
      outer['x-codex-turn-metadata'] = JSON.stringify({ ...metadata, ...lineage })
      return parseMetadata(request)
    }
    assert.equal(parse({ forked_from_thread_id: 'direct-parent', forked_from_ordinal_exclusive: 0 }).raw.forked_from_ordinal_exclusive, 0)
    assert.throws(() => parse({ forked_from_ordinal_exclusive: 0 }), /gateway_forked_from_ordinal_exclusive_invalid/)
    for (const invalid of [null, -1, 1.5, '12', true, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => parse({ forked_from_thread_id: 'direct-parent', forked_from_ordinal_exclusive: invalid }),
        /gateway_forked_from_ordinal_exclusive_invalid/)
    }
    assert.throws(() => parse({ forked_from_thread_id: 'direct-parent', unknown_lineage: 0 }), /gateway_turn_metadata_shape_invalid/)
  }
})

function chatStream(blocks: JsonObject[], model: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const block of blocks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ model, ...block })}\n\n`))
      }
      if (!blocks.some((block) => block.usage !== undefined)) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          model,
          choices: [],
          usage: {
            prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
            prompt_tokens_details: { cached_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 0 },
          },
        })}\n\n`))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
}

function toolArgumentValidators(
  names: readonly string[],
  parameters: JsonObject = { type: 'object' },
) {
  return responsesToolArgumentValidators(names.map((name) => ({
    type: 'function' as const,
    name,
    parameters,
  })))
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (value: string) => boolean,
  initial = '',
): Promise<string> {
  const decoder = new TextDecoder()
  let output = initial
  while (!predicate(output)) {
    let timeout: ReturnType<typeof setTimeout> | null = null
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('stream_read_timeout')), 1_000)
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout)
    })
    if (next.done) break
    output += decoder.decode(next.value, { stream: true })
  }
  return output
}

async function convertChat(
  blocks: JsonObject[],
  allowed = ['ready_read_probe'],
  parameters: JsonObject = { type: 'object' },
  snapshot = createCodexUpstreamProfileSnapshot({
    profileId: 'chat-fixture',
    config: {
      provider: 'openai-compatible', baseUrl: 'https://provider.example/v1', apiKey: 'secret',
      model: 'qwen-model', agentProtocol: 'openai', wireApi: 'chat/completions', toolUseMode: 'on',
    },
    maxRetries: 0,
  }).snapshot,
  admitToolResponse: (
    calls: readonly CodexModelGatewayToolResponseCall[],
  ) => Promise<void> = async () => {},
): Promise<string> {
  let output = ''
  await streamChatAsResponses({
    body: chatStream(blocks, snapshot.model),
    write(chunk) { output += chunk },
    allowedToolNames: new Set(allowed),
    toolArgumentValidators: toolArgumentValidators(allowed, parameters),
    snapshot,
    credential: 'secret',
    abort() {},
    admitToolResponse,
  })
  return output
}

test('compaction classification accepts only the captured exact signatures', () => {
  assert.equal(classifyCodexModelGatewayRequest({ request_kind: 'turn' }), 'product')
  // 2026-10-06: a long tool loop filled the context and Codex 0.149 compacted mid-turn; the gateway rejected it.
  for (const phase of ['pre_turn', 'mid_turn']) {
    assert.equal(classifyCodexModelGatewayRequest({
      request_kind: 'compaction',
      compaction: {
        trigger: 'auto', reason: 'context_limit', implementation: 'responses',
        phase, strategy: 'memento',
      },
    }), 'automatic_compaction', phase)
  }
  assert.equal(classifyCodexModelGatewayRequest({
    request_kind: 'compaction',
    compaction: {
      trigger: 'manual', reason: 'user_requested', implementation: 'responses',
      phase: 'standalone_turn', strategy: 'memento',
    },
  }), 'manual_compaction')
  for (const compaction of [
    { trigger: 'future' },
    {
      trigger: 'auto', reason: 'context_limit', implementation: 'responses',
      phase: 'pre_turn', strategy: 'memento', extra: true,
    },
    {
      trigger: 'manual', reason: 'user_requested', implementation: 'responses',
      phase: 'pre_turn', strategy: 'memento',
    },
    {
      trigger: 'auto', reason: 'context_limit', implementation: 'responses',
      phase: 'post_turn', strategy: 'memento',
    },
    {
      trigger: 'auto', reason: 'model_downshift', implementation: 'responses',
      phase: 'mid_turn', strategy: 'memento',
    },
  ]) {
    assert.throws(
      () => classifyCodexModelGatewayRequest({ request_kind: 'compaction', compaction }),
      /gateway_request_unclassified/,
    )
  }
})

test('instruction transcript binds complete ordered developer messages and rejects system injection', () => {
  const input = [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'policy' }] },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'second' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'request' }] },
  ]
  const digest = instructionTranscriptDigest('native base', input)
  assert.notEqual(instructionTranscriptDigest('native base', [input[1], input[0], input[2]]), digest)
  assert.throws(() => instructionTranscriptDigest('native base', [{
    type: 'message', role: 'developer',
    content: [
      { type: 'input_text', text: 'policy' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
    ],
  }]), /gateway_developer_message_invalid/)
  assert.throws(() => instructionTranscriptDigest('native base', [{
    type: 'message', role: 'system', content: [{ type: 'input_text', text: 'injected' }],
  }]), /gateway_system_message_unsupported/)
})

test('native ready-resource history is excluded from instructions and resolves only the latest thin reference', () => {
  const policy = {
    type: 'message', role: 'developer',
    content: [{ type: 'input_text', text: 'policy' }],
  }
  const reference = (version: 'v1' | 'v2', policyEpoch: number) => ({
    logicalResourceId: 'ready-current-document:scope-1:doc-1',
    currentVersion: version,
    currentDigest: `digest-${version}`,
    supersedesVersion: version === 'v1' ? null : 'v1',
    policyEpoch,
  })
  const tagged = (value: ReturnType<typeof reference>) => ({
    type: 'message', role: 'developer',
    content: [{
      type: 'input_text',
      text: `<ready-resource:${value.logicalResourceId}>${JSON.stringify(value)}</ready-resource:${value.logicalResourceId}>`,
    }],
  })
  const v1 = reference('v1', 1)
  const v2 = reference('v2', 2)
  const input = [policy, tagged(v1), tagged(v2), {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'request' }],
  }]
  assert.equal(
    instructionTranscriptDigest('native base', input),
    instructionTranscriptDigest('native base', [policy, input[3]]),
  )
  assert.deepEqual(latestReadyResourceReferences(input), [v2])
  assert.throws(() => latestReadyResourceReferences([{
    type: 'message', role: 'developer', content: [{
      type: 'input_text',
      text: `<ready-resource:${v1.logicalResourceId}>${JSON.stringify({ ...v1, body: 'SECRET' })}</ready-resource:${v1.logicalResourceId}>`,
    }],
  }]), /gateway_resource_reference_invalid/)
})

test('native application additionalContext uses ready_resources developer tags', () => {
  const reference = {
    logicalResourceId: 'local-directory:folder-1',
    currentVersion: 'v1',
    currentDigest: 'digest-folder-1',
    supersedesVersion: null,
    policyEpoch: 1,
  }
  const input = [{
    type: 'message',
    role: 'developer',
    content: [{
      type: 'input_text',
      text: `<ready_resources>${JSON.stringify(reference)}</ready_resources>`,
    }],
  }, {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'write into the folder' }],
  }]
  assert.deepEqual(latestReadyResourceReferences(input), [reference])
  assert.equal(
    digestCanonicalJson(latestReadyResourceReferences(input)),
    digestCanonicalJson([reference]),
  )
  assert.equal(
    instructionTranscriptDigest('native base', input),
    instructionTranscriptDigest('native base', [input[1]]),
  )
})

test('additionalContext digest ignores admission vs native emit order for multiple thin refs', () => {
  const skill = {
    logicalResourceId: 'skill:412ed9b2aa91fc0bddd9a842b87e6e74',
    currentVersion: 'sha256:48024336f41b8bc9930eb747e652e0697ceda60e1e16ef4101e0d6de9959ea21',
    currentDigest: '48024336f41b8bc9930eb747e652e0697ceda60e1e16ef4101e0d6de9959ea21',
    supersedesVersion: null,
    policyEpoch: 1,
  }
  const folder = {
    logicalResourceId: 'local-directory:0990e072e69d96c50d49a94eafbc8105',
    currentVersion: 'sha256:7ef187e21e7d1b001629d2893bda1afd6a9174e85543394574d1f9abb59a4533',
    currentDigest: '7ef187e21e7d1b001629d2893bda1afd6a9174e85543394574d1f9abb59a4533',
    supersedesVersion: null,
    policyEpoch: 1,
  }
  const tagged = (value: typeof skill) => ({
    type: 'message',
    role: 'developer',
    content: [{
      type: 'input_text',
      text: `<ready-resource:${value.logicalResourceId}>${JSON.stringify(value)}</ready-resource:${value.logicalResourceId}>`,
    }],
  })
  const admissionOrder = [skill, folder]
  const nativeEmitInput = [tagged(folder), tagged(skill), {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'use the skill on this folder' }],
  }]
  assert.equal(
    digestCanonicalJson(admissionOrder),
    '8200ac121e9ab70894c3a40396c7bf15566312f6acd6afeee5f46ea1d9d054c6',
  )
  assert.notEqual(
    digestCanonicalJson(admissionOrder),
    digestCanonicalJson(latestReadyResourceReferences(nativeEmitInput)),
  )
  assert.equal(
    digestReadyResourceReferences(admissionOrder),
    digestReadyResourceReferences(latestReadyResourceReferences(nativeEmitInput)),
  )
  assert.equal(
    digestReadyResourceReferences(admissionOrder),
    digestReadyResourceReferences([folder, skill]),
  )
  assert.equal(digestReadyResourceReferences([]), digestCanonicalJson([]))
})

test('run-owned resource snapshots pass the gateway while changed or stale snapshots never reach upstream', async () => {
  let upstreamCalls = 0
  const upstream = createServer((_request, response) => {
    upstreamCalls += 1
    response.writeHead(500).end()
  })
  const port = await listen(upstream)
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-resource-order',
    config: {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'secret',
      model: 'native-model', agentProtocol: 'openai', wireApi: 'responses', toolUseMode: 'on',
    },
    maxRetries: 0,
  })
  const skill = {
    logicalResourceId: 'skill:412ed9b2aa91fc0bddd9a842b87e6e74',
    currentVersion: 'sha256:48024336f41b8bc9930eb747e652e0697ceda60e1e16ef4101e0d6de9959ea21',
    currentDigest: '48024336f41b8bc9930eb747e652e0697ceda60e1e16ef4101e0d6de9959ea21',
    supersedesVersion: null,
    policyEpoch: 1,
  }
  const folder = {
    logicalResourceId: 'local-directory:0990e072e69d96c50d49a94eafbc8105',
    currentVersion: 'sha256:7ef187e21e7d1b001629d2893bda1afd6a9174e85543394574d1f9abb59a4533',
    currentDigest: '7ef187e21e7d1b001629d2893bda1afd6a9174e85543394574d1f9abb59a4533',
    supersedesVersion: null,
    policyEpoch: 1,
  }
  const snapshot = (references: typeof skill[], readyRunId = 'run-1') => ({
    type: 'message', role: 'developer', content: [{ type: 'input_text',
      text: `<ready-resource-context>${JSON.stringify({ contract: 'ready_resource_context_v1', readyRunId, references })}</ready-resource-context>` }],
  })
  const request = requestBody()
  request.input = [snapshot([folder, skill]),
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'use the skill on this folder' }] }]
  const binding = bindRequest(request, created.snapshot)
  binding.additionalContextDigest = digestCanonicalJson([skill, folder])
  const gateway = new CodexModelGateway({
    bearerToken: 'local-token',
    authority: { async resolve(input) { input.validate(binding); return binding } },
    credentials: { resolve() { return 'secret' } },
  })
  const address = await gateway.start()
  try {
    const mismatched = await fetch(`${address.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    assert.equal(mismatched.status, 409)
    assert.match(await mismatched.text(), /gateway_additional_context_mismatch/)
    assert.equal(upstreamCalls, 0)

    binding.additionalContextDigest = digestReadyResourceReferences([skill, folder])
    const accepted = await fetch(`${address.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    assert.notEqual(accepted.status, 409)
    assert.equal(upstreamCalls, 1)
    for (const invalid of [snapshot([folder, skill], 'older-run'), snapshot([folder])]) {
      request.input[0] = invalid
      const rejected = await fetch(`${address.url}/v1/responses`, {
        method: 'POST', headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
      assert.equal(rejected.status, 409)
      assert.match(await rejected.text(), /gateway_additional_context_mismatch/)
      assert.equal(upstreamCalls, 1)
    }
  } finally {
    await gateway.stop()
    await close(upstream)
  }
})

// 2026-10-06: after a mid-turn compaction Codex rebuilds the request from its summary and drops the turn's Ready
// context; the gateway rejected every later request of the 37-tool turn.
test('only a turn that already compacted may send a request whose Ready context was dropped entirely', async () => {
  let upstreamCalls = 0
  const upstream = createServer((_request, response) => {
    upstreamCalls += 1
    response.writeHead(500).end()
  })
  const port = await listen(upstream)
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-dropped-context',
    config: {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'secret',
      model: 'native-model', agentProtocol: 'openai', wireApi: 'responses', toolUseMode: 'on',
    },
    maxRetries: 0,
  })
  const document = {
    logicalResourceId: 'ready-current-document:scope:doc-1',
    currentVersion: `sha256:${'c'.repeat(64)}`,
    currentDigest: 'c'.repeat(64),
    supersedesVersion: null,
    policyEpoch: 1,
  }
  const other = { ...document, logicalResourceId: 'local-file:other', currentDigest: 'd'.repeat(64),
    currentVersion: `sha256:${'d'.repeat(64)}` }
  const snapshot = (references: typeof document[]) => ({
    type: 'message', role: 'developer', content: [{ type: 'input_text',
      text: `<ready-resource-context>${JSON.stringify({ contract: 'ready_resource_context_v1', readyRunId: 'run-1', references })}</ready-resource-context>` }],
  })
  const task = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'turn the quotes into cards' }] }
  const summary = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Another language model started to solve this problem and produced a summary.' }] }
  const request = requestBody()
  request.input = [task, summary]
  const binding = bindRequest(request, created.snapshot)
  binding.additionalContextDigest = digestReadyResourceReferences([document, other])
  const gateway = new CodexModelGateway({
    bearerToken: 'local-token',
    authority: { async resolve(input) { input.validate(binding); return binding } },
    credentials: { resolve() { return 'secret' } },
  })
  const address = await gateway.start()
  const send = () => fetch(`${address.url}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  try {
    const beforeCompaction = await send()
    assert.equal(beforeCompaction.status, 409)
    assert.match(await beforeCompaction.text(), /gateway_additional_context_mismatch/)
    assert.equal(upstreamCalls, 0)

    binding.compactedEarlierInTurn = true
    const afterCompaction = await send()
    assert.notEqual(afterCompaction.status, 409)
    assert.equal(upstreamCalls, 1)

    const legacyTag = { type: 'message', role: 'developer', content: [{ type: 'input_text',
      text: `<ready-resource:${other.logicalResourceId}>${JSON.stringify(other)}</ready-resource:${other.logicalResourceId}>` }] }
    request.input = [legacyTag, task, summary]
    const legacyHistory = await send()
    assert.notEqual(legacyHistory.status, 409, 'legacy resource tags are history, not this run’s context')
    assert.equal(upstreamCalls, 2)

    request.input = [snapshot([document]), task, summary]
    const partial = await send()
    assert.equal(partial.status, 409, 'a partial or altered context is never accepted')
    assert.match(await partial.text(), /gateway_additional_context_mismatch/)
    assert.equal(upstreamCalls, 2)

    request.input = [summary, snapshot([document, other]), task]
    const intact = await send()
    assert.notEqual(intact.status, 409, 'a context re-injected after a compaction still passes exact checks')
    assert.equal(upstreamCalls, 3)
  } finally {
    await gateway.stop()
    await close(upstream)
  }
})

test('follow-up turn additionalContext digest ignores leftover historical resource tags', () => {
  const folder = {
    logicalResourceId: 'local-directory:0990e072e69d96c50d49a94eafbc8105',
    currentVersion: 'sha256:7ef187e21e7d1b001629d2893bda1afd6a9174e85543394574d1f9abb59a4533',
    currentDigest: '7ef187e21e7d1b001629d2893bda1afd6a9174e85543394574d1f9abb59a4533',
    supersedesVersion: null,
    policyEpoch: 1,
  }
  const tagged = {
    type: 'message',
    role: 'developer',
    content: [{
      type: 'input_text',
      text: `<ready-resource:${folder.logicalResourceId}>${JSON.stringify(folder)}</ready-resource:${folder.logicalResourceId}>`,
    }],
  }
  const input = [
    tagged,
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '输出到这里' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '再试一次' }] },
  ]
  assert.deepEqual(latestReadyResourceReferences(input), [folder])
  assert.deepEqual(currentTurnReadyResourceReferences(input), [])
  assert.equal(
    digestReadyResourceReferences(currentTurnReadyResourceReferences(input)),
    digestCanonicalJson([]),
  )
})

test('explicit retry metadata is bound application context rather than developer instruction', () => {
  const retry = {
    predecessorRunId: 'run-0',
    historyParityEvidenceDigest: 'parity-digest',
    currentThreadReadEvidenceDigest: 'readback-digest',
    continuationContractDigest: 'continuation-digest',
    artifactSources: [],
  }
  const overlay = {
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text: 'Ready host overlay' }],
  }
  const retryItem = {
    type: 'message',
    role: 'developer',
    content: [{
      type: 'input_text',
      text: `<ready-explicit-retry>${JSON.stringify(retry)}</ready-explicit-retry>`,
    }],
  }
  const user = {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: '再试一次' }],
  }
  assert.equal(
    instructionTranscriptDigest('fixed instructions', [overlay, retryItem, user]),
    instructionTranscriptDigest('fixed instructions', [overlay]),
  )
  assert.deepEqual(currentTurnReadyAdditionalContext([overlay, retryItem, user], [], 'run-1'), {
    resourceReferences: [],
    explicitRetry: retry,
    readyMemory: null,
    documentWidgetGuidance: null,
    currentUserIndex: 2,
    readyMemoryIndex: null,
  })
  assert.notEqual(
    digestReadyAdditionalContext({ resourceReferences: [], explicitRetry: retry }),
    digestReadyAdditionalContext({
      resourceReferences: [],
      explicitRetry: { ...retry, predecessorRunId: 'forged-run' },
    }),
  )
})

test('empty follow-up after a folder turn does not 409 on leftover native resource tags', async () => {
  let upstreamCalls = 0
  const upstream = createServer((_request, response) => {
    upstreamCalls += 1
    response.writeHead(500).end()
  })
  const port = await listen(upstream)
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-followup-empty',
    config: {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'secret',
      model: 'native-model', agentProtocol: 'openai', wireApi: 'responses', toolUseMode: 'on',
    },
    maxRetries: 0,
  })
  const folder = {
    logicalResourceId: 'local-directory:0990e072e69d96c50d49a94eafbc8105',
    currentVersion: 'sha256:7ef187e21e7d1b001629d2893bda1afd6a9174e85543394574d1f9abb59a4533',
    currentDigest: '7ef187e21e7d1b001629d2893bda1afd6a9174e85543394574d1f9abb59a4533',
    supersedesVersion: null,
    policyEpoch: 1,
  }
  const request = requestBody()
  request.input = [
    {
      type: 'message',
      role: 'developer',
      content: [{
        type: 'input_text',
        text: `<ready-resource:${folder.logicalResourceId}>${JSON.stringify(folder)}</ready-resource:${folder.logicalResourceId}>`,
      }],
    },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '输出到这里' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'write tools missing' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '再试一次' }] },
  ]
  const binding = bindRequest(request, created.snapshot)
  binding.additionalContextDigest = digestCanonicalJson([])
  const gateway = new CodexModelGateway({
    bearerToken: 'local-token',
    authority: { async resolve(input) { input.validate(binding); return binding } },
    credentials: { resolve() { return 'secret' } },
  })
  const address = await gateway.start()
  try {
    const accepted = await fetch(`${address.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    assert.notEqual(accepted.status, 409)
    assert.equal(upstreamCalls, 1)
  } finally {
    await gateway.stop()
    await close(upstream)
  }
})

test('credential lookup permits key rotation only while the nonsecret route snapshot is unchanged', () => {
  const originalConfig = {
    provider: 'openai-compatible' as const,
    baseUrl: 'https://provider.example/v1',
    apiKey: 'old-secret',
    model: 'qwen-model',
    agentProtocol: 'openai' as const,
    wireApi: 'chat/completions' as const,
    toolUseMode: 'on' as const,
  }
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-1', config: originalConfig, maxRetries: 1,
  })
  let currentConfig = { ...originalConfig, apiKey: 'rotated-secret' }
  const store = new ReadySettingsModelGatewayCredentialStore({
    getAIWorkspace() {
      return { activeProfileId: 'profile-1', profiles: [{ id: 'profile-1', config: currentConfig }] } as never
    },
  })
  assert.equal(store.resolve({
    credentialReferenceId: created.snapshot.credentialReferenceId,
    snapshot: created.snapshot,
  }), 'rotated-secret')

  currentConfig = { ...currentConfig, baseUrl: 'https://attacker.example/v1' }
  assert.throws(() => store.resolve({
    credentialReferenceId: created.snapshot.credentialReferenceId,
    snapshot: created.snapshot,
  }), /gateway_credential_route_drift/)
  currentConfig = { ...currentConfig, baseUrl: originalConfig.baseUrl, model: 'different-model' }
  assert.throws(() => store.resolve({
    credentialReferenceId: created.snapshot.credentialReferenceId,
    snapshot: created.snapshot,
  }), /gateway_credential_route_drift/)
})

test('route drift fails before an old thread can contact its snapshotted upstream', async () => {
  let upstreamCalls = 0
  const upstream = createServer((_request, response) => {
    upstreamCalls += 1
    response.writeHead(500).end()
  })
  const port = await listen(upstream)
  const originalConfig = {
    provider: 'openai-compatible' as const,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'old-secret',
    model: 'native-model',
    agentProtocol: 'openai' as const,
    wireApi: 'responses' as const,
    toolUseMode: 'on' as const,
  }
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-drift', config: originalConfig, maxRetries: 0,
  })
  const request = requestBody()
  const binding = bindRequest(request, created.snapshot)
  const credentials = new ReadySettingsModelGatewayCredentialStore({
    getAIWorkspace() {
      return {
        activeProfileId: 'profile-drift',
        profiles: [{
          id: 'profile-drift',
          config: { ...originalConfig, baseUrl: 'https://new-service.example/v1', apiKey: 'new-secret' },
        }],
      } as never
    },
  })
  const gateway = new CodexModelGateway({
    bearerToken: 'local-token', credentials,
    authority: { async resolve(input) { input.validate(binding); return binding } },
  })
  const address = await gateway.start()
  try {
    const response = await fetch(`${address.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    assert.equal(response.status, 409)
    assert.match(await response.text(), /gateway_credential_route_drift/)
    assert.equal(upstreamCalls, 0)
  } finally {
    await gateway.stop()
    await close(upstream)
  }
})

test('upstream redirects fail closed without contacting the redirect target', async () => {
  let redirectCalls = 0
  let targetCalls = 0
  const target = createServer((_request, response) => {
    targetCalls += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' }).end()
  })
  const targetPort = await listen(target)
  const redirector = createServer((_request, response) => {
    redirectCalls += 1
    response.writeHead(307, {
      location: `http://127.0.0.1:${targetPort}/mock`,
    }).end()
  })
  const redirectPort = await listen(redirector)
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-redirect',
    config: {
      provider: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${redirectPort}/v1`,
      apiKey: 'secret',
      model: 'native-model',
      agentProtocol: 'openai',
      wireApi: 'responses',
      toolUseMode: 'on',
    },
    maxRetries: 0,
  })
  const request = requestBody()
  const binding = bindRequest(request, created.snapshot)
  const gateway = new CodexModelGateway({
    bearerToken: 'local-token',
    authority: { async resolve(input) { input.validate(binding); return binding } },
    credentials: { resolve() { return 'secret' } },
  })
  const address = await gateway.start()
  try {
    const response = await fetch(`${address.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    assert.notEqual(response.status, 200)
    assert.equal(redirectCalls, 1)
    assert.equal(targetCalls, 0)
  } finally {
    await gateway.stop()
    await close(redirector)
    await close(target)
  }
})

test('instruction-only message mutation is rejected before upstream contact', async () => {
  let upstreamCalls = 0
  const upstream = createServer((_request, response) => {
    upstreamCalls += 1
    response.writeHead(500).end()
  })
  const port = await listen(upstream)
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-instruction-binding',
    config: {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'secret',
      model: 'native-model', agentProtocol: 'openai', wireApi: 'responses', toolUseMode: 'on',
    },
    maxRetries: 0,
  })
  const request = requestBody()
  ;(request.input as unknown[]).unshift({
    type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'bound policy' }],
  })
  const binding = bindRequest(request, created.snapshot)
  const gateway = new CodexModelGateway({
    bearerToken: 'local-token',
    authority: { async resolve(input) { input.validate(binding); return binding } },
    credentials: { resolve() { return 'secret' } },
  })
  const address = await gateway.start()
  try {
    const mutated = structuredClone(request)
    ;((mutated.input as JsonObject[])[0].content as unknown[]).push({
      type: 'input_image', image_url: 'data:image/png;base64,AAAA',
    })
    const response = await fetch(`${address.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
      body: JSON.stringify(mutated),
    })
    assert.equal(response.status, 409)
    assert.match(await response.text(), /gateway_instruction_transcript_invalid/)
    assert.equal(upstreamCalls, 0)
  } finally {
    await gateway.stop()
    await close(upstream)
  }
})

test('malformed signed Chat tool controls fail before upstream contact', async () => {
  let upstreamCalls = 0
  let credentialCalls = 0
  const upstream = createServer((_request, response) => {
    upstreamCalls += 1
    response.writeHead(500).end()
  })
  const port = await listen(upstream)
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-tool-shape',
    config: {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'secret',
      model: 'chat-model', agentProtocol: 'openai', wireApi: 'chat/completions', toolUseMode: 'on',
    },
    maxRetries: 0,
  })
  let binding: CodexModelGatewayBinding | null = null
  const gateway = new CodexModelGateway({
    bearerToken: 'local-token',
    authority: {
      async resolve(input) {
        if (!binding) throw new Error('missing_binding')
        input.validate(binding)
        return binding
      },
    },
    credentials: { resolve() { credentialCalls += 1; return 'secret' } },
  })
  const address = await gateway.start()
  const call = async (mutate: (request: JsonObject) => void) => {
    const request = requestBody(['ready_read_probe'])
    mutate(request)
    const metadata = JSON.parse(
      (request.client_metadata as Record<string, string>)['x-codex-turn-metadata'],
    ) as JsonObject
    metadata.toolSurfaceDigest = digestCanonicalJson(request.tools)
    ;(request.client_metadata as Record<string, string>)['x-codex-turn-metadata'] = JSON.stringify(metadata)
    binding = bindRequest(request, created.snapshot)
    const response = await fetch(`${address.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    return { status: response.status, body: await response.text() }
  }
  try {
    for (const mutate of [
      (request: JsonObject) => { (request.tools as JsonObject[])[0].parameters = [] },
      (request: JsonObject) => { delete (request.tools as JsonObject[])[0].parameters },
      (request: JsonObject) => { (request.tools as JsonObject[])[0].description = 7 },
      (request: JsonObject) => { (request.tools as JsonObject[])[0].strict = 'true' },
      (request: JsonObject) => { (request.tools as JsonObject[])[0].unknown = true },
    ]) {
      const result = await call(mutate)
      assert.equal(result.status, 400)
      assert.match(result.body, /gateway_tool_schema_invalid/)
    }
    const parallel = await call((request) => { request.parallel_tool_calls = 'true' })
    assert.match(parallel.body, /gateway_parallel_tool_calls_invalid/)
    const choice = await call((request) => {
      request.tool_choice = { type: 'function', name: 'not_authorized' }
    })
    assert.match(choice.body, /gateway_tool_choice_invalid/)
    const choiceExtra = await call((request) => {
      request.tool_choice = { type: 'function', name: 'ready_read_probe', unknown: true }
    })
    assert.match(choiceExtra.body, /gateway_tool_choice_invalid/)
    for (const include of [[], 'reasoning.encrypted_content', [
      'reasoning.encrypted_content', 'reasoning.encrypted_content',
    ], ['reasoning.encrypted_content', 'unexpected']] as unknown[]) {
      const result = await call((request) => { request.include = include })
      assert.match(result.body, /gateway_include_shape_invalid/)
    }
    const outerExtra = await call((request) => {
      ;(request.client_metadata as JsonObject).private_secret = 'must-not-cross'
    })
    assert.match(outerExtra.body, /gateway_client_metadata_shape_invalid/)
    assert.doesNotMatch(outerExtra.body, /must-not-cross/)
    const innerExtra = await call((request) => {
      const clientMetadata = request.client_metadata as Record<string, string>
      const inner = JSON.parse(clientMetadata['x-codex-turn-metadata']) as JsonObject
      inner.history = 'must-not-cross'
      clientMetadata['x-codex-turn-metadata'] = JSON.stringify(inner)
    })
    assert.match(innerExtra.body, /gateway_turn_metadata_shape_invalid/)
    assert.doesNotMatch(innerExtra.body, /must-not-cross/)
    const identityMismatch = await call((request) => {
      ;(request.client_metadata as JsonObject).thread_id = 'forged-thread'
    })
    assert.match(identityMismatch.body, /gateway_metadata_identity_mismatch/)
    const turnMismatch = await call((request) => {
      ;(request.client_metadata as JsonObject).turn_id = 'forged-turn'
    })
    assert.match(turnMismatch.body, /gateway_metadata_identity_mismatch/)
    const rootTurnMismatch = await call((request) => {
      ;(request.client_metadata as JsonObject).root_turn_id = 'forged-root-turn'
    })
    assert.match(rootTurnMismatch.body, /gateway_root_turn_identity_mismatch/)
    const cacheMismatch = await call((request) => { request.prompt_cache_key = 'forged-thread' })
    assert.match(cacheMismatch.body, /gateway_root_prompt_cache_thread_mismatch/)
    const sessionMismatch = await call((request) => {
      const clientMetadata = request.client_metadata as Record<string, string>
      clientMetadata.session_id = 'forged-session'
      clientMetadata['x-codex-window-id'] = 'forged-session:0'
      const inner = JSON.parse(clientMetadata['x-codex-turn-metadata']) as JsonObject
      inner.session_id = 'forged-session'
      inner.window_id = 'forged-session:0'
      clientMetadata['x-codex-turn-metadata'] = JSON.stringify(inner)
    })
    assert.match(sessionMismatch.body, /gateway_root_session_thread_mismatch/)
    const windowMismatch = await call((request) => {
      const clientMetadata = request.client_metadata as Record<string, string>
      clientMetadata['x-codex-window-id'] = 'thread-1:forged'
      const inner = JSON.parse(clientMetadata['x-codex-turn-metadata']) as JsonObject
      inner.window_id = 'thread-1:forged'
      clientMetadata['x-codex-turn-metadata'] = JSON.stringify(inner)
    })
    assert.match(windowMismatch.body, /gateway_root_window_thread_mismatch/)

    const invalidUtf8Request = requestBody()
    binding = bindRequest(invalidUtf8Request, created.snapshot)
    const serialized = JSON.stringify(invalidUtf8Request)
    const instructionAt = serialized.indexOf('fixed instructions')
    assert.ok(instructionAt > 0)
    const invalidUtf8Body = Buffer.concat([
      Buffer.from(serialized.slice(0, instructionAt + 5)),
      Buffer.from([0xff]),
      Buffer.from(serialized.slice(instructionAt + 5)),
    ])
    const invalidUtf8 = await fetch(`${address.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
      body: invalidUtf8Body,
    })
    assert.equal(invalidUtf8.status, 400)
    assert.match(await invalidUtf8.text(), /gateway_body_utf8_invalid/)
    assert.equal(credentialCalls, 0)
    assert.equal(upstreamCalls, 0)
  } finally {
    await gateway.stop()
    await close(upstream)
  }
})

test('snapshot capability and reasoning drift fail before upstream contact', async () => {
  let upstreamCalls = 0
  let credentialCalls = 0
  const upstream = createServer((_request, response) => {
    upstreamCalls += 1
    response.writeHead(500).end()
  })
  const port = await listen(upstream)
  const base = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-capability',
    config: {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'secret',
      model: 'native-model', agentProtocol: 'openai', wireApi: 'responses', toolUseMode: 'on',
    },
    maxRetries: 0,
  }).snapshot
  const call = async (
    request: JsonObject,
    snapshot: CodexUpstreamProfileSnapshot,
  ): Promise<string> => {
    const metadata = JSON.parse(
      (request.client_metadata as Record<string, string>)['x-codex-turn-metadata'],
    ) as JsonObject
    metadata.toolSurfaceDigest = digestCanonicalJson(request.tools)
    ;(request.client_metadata as Record<string, string>)['x-codex-turn-metadata'] = JSON.stringify(metadata)
    const binding = bindRequest(request, snapshot)
    const gateway = new CodexModelGateway({
      bearerToken: 'local-token',
      authority: { async resolve(input) { input.validate(binding); return binding } },
      credentials: { resolve() { credentialCalls += 1; return 'secret' } },
    })
    const address = await gateway.start()
    try {
      const response = await fetch(`${address.url}/v1/responses`, {
        method: 'POST',
        headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
      return response.text()
    } finally {
      await gateway.stop()
    }
  }
  try {
    const toolRequest = requestBody(['ready_read_probe'])
    assert.match(await call(toolRequest, {
      ...base, supportsToolCalls: false, supportsNativeToolCalls: false,
    }), /gateway_tool_capability_unsupported/)
    assert.match(await call(toolRequest, {
      ...base, supportsNativeToolCalls: false,
    }), /gateway_tool_capability_unsupported/)

    const imageRequest = requestBody()
    ;((imageRequest.input as JsonObject[])[0].content as JsonObject[]).push({
      type: 'input_image', image_url: 'data:image/png;base64,AAAA',
    })
    assert.match(await call(imageRequest, { ...base, supportsVision: false }),
      /gateway_vision_capability_unsupported/)

    const audioRequest = requestBody()
    ;((audioRequest.input as JsonObject[])[0].content as JsonObject[]).push({
      type: 'input_audio', audio_url: 'data:audio/wav;base64,UklGRg==',
    })
    assert.match(await call(audioRequest, { ...base, supportsVision: true }),
      /gateway_audio_capability_unsupported/)

    const imageToolOutput = requestBody()
    ;(imageToolOutput.input as JsonObject[]).push(
      { type: 'function_call', call_id: 'call-image', name: 'ready_read_probe', arguments: '{}' },
      {
        type: 'function_call_output', call_id: 'call-image',
        output: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }],
      },
    )
    assert.match(await call(imageToolOutput, { ...base, supportsVision: false }),
      /gateway_vision_capability_unsupported/)

    const audioToolOutput = requestBody()
    ;(audioToolOutput.input as JsonObject[]).push(
      { type: 'function_call', call_id: 'call-audio', name: 'ready_read_probe', arguments: '{}' },
      {
        type: 'function_call_output', call_id: 'call-audio',
        output: [{ type: 'input_audio', audio_url: 'data:audio/wav;base64,UklGRg==' }],
      },
    )
    assert.match(await call(audioToolOutput, { ...base, supportsVision: true }),
      /gateway_audio_capability_unsupported/)

    const drift = requestBody()
    drift.reasoning = { summary: 'auto', effort: 'high' }
    assert.match(await call(drift, base), /gateway_reasoning_effort_mismatch/)
    assert.match(await call(drift, {
      ...base, reasoningEffort: 'high', supportsThinking: false,
    }), /gateway_reasoning_capability_unsupported/)
    assert.equal(credentialCalls, 0)
    assert.equal(upstreamCalls, 0)
  } finally {
    await close(upstream)
  }
})

test('Chat request conversion preserves summaries, parallel calls, strict tools, tool results and provider patches', () => {
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-vllm',
    config: {
      provider: 'openai-compatible', baseUrl: 'https://provider.example/v1', apiKey: 'secret',
      model: 'qwen-model', agentProtocol: 'openai', wireApi: 'chat/completions', toolUseMode: 'on',
    },
    maxRetries: 0,
  })
  const converted = responsesRequestToChat({
    snapshot: created.snapshot,
    request: {
      instructions: 'developer',
      input: [
        {
          type: 'message', role: 'user',
          content: [
            { type: 'input_text', text: 'inspect' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' },
            { type: 'input_audio', audio_url: 'data:audio/wav;base64,UklGRg==' },
          ],
        },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'safe summary' }] },
        { type: 'function_call', call_id: 'call-1', name: 'tool_a', arguments: '{"a":1}' },
        { type: 'function_call', call_id: 'call-2', name: 'tool_b', arguments: '{"b":2}' },
        { type: 'function_call_output', call_id: 'call-1', output: 'one' },
        {
          type: 'function_call_output', call_id: 'call-2',
          output: [
            { type: 'input_text', text: 'two-' },
            { type: 'input_text', text: 'parts' },
          ],
        },
      ],
      tools: [{
        type: 'function', name: 'tool_a', description: 'a', strict: true,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      }],
      tool_choice: { type: 'function', name: 'tool_a' },
      parallel_tool_calls: true,
    },
  })
  const serialized = JSON.stringify(converted)
  const messages = converted.messages as JsonObject[]
  const parallel = messages.find((message) => Array.isArray(message.tool_calls))
  assert.equal((parallel?.tool_calls as unknown[]).length, 2)
  assert.equal(parallel?.reasoning_summary, 'safe summary')
  assert.equal(parallel?.reasoning_content, undefined)
  assert.deepEqual(messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id), [
    'call-1', 'call-2',
  ])
  assert.equal((((converted.tools as JsonObject[])[0].function as JsonObject).strict), true)
  assert.deepEqual(converted.tool_choice, { type: 'function', function: { name: 'tool_a' } })
  assert.equal(converted.stream_usage, true)
  assert.match(serialized, /"input_audio":\{"data":"UklGRg==","format":"wav"\}/)
  assert.doesNotMatch(serialized, /data:audio\/wav/)
  const secondToolOutput = messages.find((message) => message.tool_call_id === 'call-2')
  assert.deepEqual(secondToolOutput?.content, [
    { type: 'text', text: 'two-' },
    { type: 'text', text: 'parts' },
  ])

  const convertInput = (input: unknown[]) => responsesRequestToChat({
    snapshot: created.snapshot,
    request: {
      instructions: 'developer', input, tools: [], tool_choice: 'auto', parallel_tool_calls: false,
    },
  })
  for (const input of [
    [{ type: 'function_call', call_id: 'call-1', name: 'tool_a', arguments: { unsafe: true } }],
    [{ type: 'function_call', call_id: 'call-1', name: 'tool_a', arguments: '{bad' }],
    [{ type: 'function_call', call_id: 'call-1', name: 'tool_a', arguments: '[]' }],
    [{ type: 'function_call_output', call_id: 'missing', output: 'orphan' }],
    [
      { type: 'function_call', call_id: 'call-1', name: 'tool_a', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call-1', output: { unsafe: true } },
    ],
    [
      { type: 'function_call', call_id: 'call-1', name: 'tool_a', arguments: '{}' },
      {
        type: 'function_call_output', call_id: 'call-1',
        output: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }],
      },
    ],
    [
      { type: 'function_call', call_id: 'call-1', name: 'tool_a', arguments: '{}' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'out of order' }] },
      { type: 'function_call_output', call_id: 'call-1', output: 'one' },
    ],
    [
      { type: 'function_call', call_id: 'call-1', name: 'tool_a', arguments: '{}' },
      { type: 'function_call', call_id: 'call-1', name: 'tool_a', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call-1', output: 'one' },
    ],
    [
      { type: 'function_call', call_id: 'call-1', name: 'tool_a', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call-1', output: 'one' },
      { type: 'function_call_output', call_id: 'call-1', output: 'two' },
    ],
  ]) assert.throws(() => convertInput(input), /gateway_chat_function/)
  assert.throws(() => convertInput([{
    type: 'message', role: 'user',
    content: [{ type: 'input_audio', audio_url: 'https://provider.example/audio.mp3' }],
  }]), /gateway_chat_audio_url_unsupported/)
  assert.throws(() => convertInput([{
    type: 'message', role: 'assistant',
    content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }],
  }]), /gateway_chat_role_content_unsupported/)
  assert.throws(() => convertInput([{
    type: 'reasoning', summary: [{ type: 'summary_text', text: 'summary' }],
    encrypted_content: 'opaque-unmapped',
  }]), /gateway_chat_reasoning_history_unsupported/)
})

test('Chat streaming rejects missing or mutated tool identity and emits every argument fragment once', async () => {
  const malformedDelta = await convertChat([
    { choices: [{ index: 0, delta: 'not-an-object', finish_reason: 'stop' }] },
  ])
  assert.match(malformedDelta, /gateway_chat_delta_invalid/)
  assert.doesNotMatch(malformedDelta, /response\.completed/)

  const malformedUsage = await convertChat([{
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: -1, completion_tokens: 1, total_tokens: 0 },
  }])
  assert.match(malformedUsage, /gateway_chat_usage_invalid/)
  assert.doesNotMatch(malformedUsage, /response\.completed/)

  const inflatedUsageDetails = await convertChat([{
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 1, completion_tokens: 1, total_tokens: 2,
      prompt_tokens_details: { cached_tokens: 2 },
      completion_tokens_details: { reasoning_tokens: 2 },
    },
  }])
  assert.match(inflatedUsageDetails, /gateway_chat_usage_invalid/)
  assert.doesNotMatch(inflatedUsageDetails, /response\.completed/)

  const standardNullLogprobs = await convertChat([{
    choices: [{ index: 0, delta: { content: 'answer' }, logprobs: null, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 2, completion_tokens: 2, total_tokens: 4,
      prompt_tokens_details: { cached_tokens: 1, audio_tokens: 0 },
      completion_tokens_details: {
        reasoning_tokens: 1, audio_tokens: 0,
        accepted_prediction_tokens: 0, rejected_prediction_tokens: 0,
      },
    },
  }])
  assert.match(standardNullLogprobs, /response\.completed/)
  const intermediateNullUsage = await convertChat([
    {
      choices: [{ index: 0, delta: { content: 'answer' }, logprobs: null }],
      usage: null,
    },
    {
      choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 2, completion_tokens: 1, total_tokens: 3,
        prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
        completion_tokens_details: {
          reasoning_tokens: 0, audio_tokens: 0,
          accepted_prediction_tokens: 0, rejected_prediction_tokens: 0,
        },
      },
    },
  ])
  assert.match(intermediateNullUsage, /response\.completed/)
  assert.doesNotMatch(intermediateNullUsage, /gateway_chat_usage_invalid/)
  const duplicateUsage = await convertChat([
    {
      choices: [{ index: 0, delta: { content: 'answer' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
    {
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ])
  assert.match(duplicateUsage, /gateway_chat_usage_duplicate/)
  assert.doesNotMatch(duplicateUsage, /response\.completed/)
  const requestedLogprobs = await convertChat([{
    choices: [{ index: 0, delta: {}, logprobs: { content: [] }, finish_reason: 'stop' }],
  }])
  assert.match(requestedLogprobs, /gateway_chat_logprobs_unsupported/)
  assert.doesNotMatch(requestedLogprobs, /response\.completed/)

  let missingUsage = ''
  const missingUsageEncoder = new TextEncoder()
  await streamChatAsResponses({
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(missingUsageEncoder.encode(`data: ${JSON.stringify({
          model: 'qwen-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\ndata: [DONE]\n\n`))
        controller.close()
      },
    }),
    write(chunk) { missingUsage += chunk },
    allowedToolNames: new Set(),
    toolArgumentValidators: toolArgumentValidators([]),
    snapshot: createCodexUpstreamProfileSnapshot({
      profileId: 'chat-missing-usage-fixture',
      config: {
        provider: 'openai-compatible', baseUrl: 'https://provider.example/v1', apiKey: 'secret',
        model: 'qwen-model', agentProtocol: 'openai', wireApi: 'chat/completions', toolUseMode: 'on',
      },
      maxRetries: 0,
    }).snapshot,
    credential: 'secret',
    abort() {},
  })
  assert.match(missingUsage, /gateway_chat_usage_missing/)
  assert.doesNotMatch(missingUsage, /response\.completed/)

  let safeStreamError = ''
  const encoder = new TextEncoder()
  await streamChatAsResponses({
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          error: { code: 'rate_limited', type: 'provider_error', message: 'safe retry later' },
        })}\n\n`))
        controller.close()
      },
    }),
    write(chunk) { safeStreamError += chunk },
    allowedToolNames: new Set(),
    toolArgumentValidators: toolArgumentValidators([]),
    snapshot: createCodexUpstreamProfileSnapshot({
      profileId: 'chat-error-fixture',
      config: {
        provider: 'openai-compatible', baseUrl: 'https://provider.example/v1', apiKey: 'secret',
        model: 'qwen-model', agentProtocol: 'openai', wireApi: 'chat/completions', toolUseMode: 'on',
      },
      maxRetries: 0,
    }).snapshot,
    credential: 'secret',
    abort() {},
  })
  assert.match(safeStreamError, /rate_limited|safe retry later/)
  assert.doesNotMatch(safeStreamError, /response\.completed/)

  const mixedStreamError = await convertChat([{
    error: { code: 'rate_limited', type: 'provider_error', message: 'mixed' },
  }])
  assert.match(mixedStreamError, /gateway_chat_stream_error_mixed/)

  for (const malformed of [
    { error: 'provider failed', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { usage: 'not-an-object', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { status: 'failed', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]) {
    const output = await convertChat([malformed])
    assert.match(output, /gateway_chat_(stream_error_invalid|usage_invalid|status_unsupported)/)
    assert.doesNotMatch(output, /response\.completed/)
  }

  const afterFinish = await convertChat([
    { choices: [{ index: 0, delta: { content: 'before' }, finish_reason: 'stop' }] },
    { choices: [{ index: 0, delta: { content: 'AFTER_TERMINAL' } }] },
  ])
  assert.match(afterFinish, /gateway_chat_choice_after_finish/)
  assert.doesNotMatch(afterFinish, /response\.completed|AFTER_TERMINAL/)

  const changedResponseId = await convertChat([
    { id: 'chat-a', choices: [{ index: 0, delta: { content: 'A' } }] },
    { id: 'chat-b', choices: [{ index: 0, delta: { content: 'B' } }] },
    { id: 'chat-b', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ])
  assert.match(changedResponseId, /gateway_chat_response_id_changed/)
  assert.doesNotMatch(changedResponseId, /response\.completed|"delta":"B"/)

  const bearerResponseId = await convertChat([
    { id: 'Bearer other-token', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ])
  assert.match(bearerResponseId, /gateway_provider_credential_in_identity/)
  assert.doesNotMatch(bearerResponseId, /response\.completed|Bearer other-token/)

  for (const unsupportedDelta of [
    { function_call: { name: 'danger', arguments: '{}' } },
    { refusal: 'provider refusal' },
    { audio: { id: 'audio-1' } },
  ]) {
    const output = await convertChat([
      { choices: [{ index: 0, delta: unsupportedDelta }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ])
    assert.match(output, /gateway_chat_(legacy_function_call|refusal|audio_output)_unsupported/)
    assert.doesNotMatch(output, /response\.completed/)
  }

  for (const actionField of [
    'shell_call', 'file_search_call', 'web_search_call',
    'computer_call', 'mcp_call', 'unknown_action',
  ]) {
    const output = await convertChat([
      { choices: [{ index: 0, delta: { [actionField]: { id: 'must-not-forward' } } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ])
    assert.match(output, /gateway_chat_delta_field_not_allowed/)
    assert.doesNotMatch(output, /response\.completed|must-not-forward/)
  }

  for (const malformed of [
    { tool_calls: { index: 0 } },
    { tool_calls: [null] },
    { tool_calls: [{ index: 0, type: 'shell', function: { name: 'ready_read_probe', arguments: '{}' } }] },
  ]) {
    const output = await convertChat([
      { choices: [{ index: 0, delta: malformed }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ])
    assert.match(output, /gateway_chat_tool_(calls|call|call_type)_invalid/)
    assert.doesNotMatch(output, /response\.completed/)
  }
  const missingCalls = await convertChat([
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ])
  assert.match(missingCalls, /gateway_chat_tool_calls_missing/)
  assert.doesNotMatch(missingCalls, /response\.completed/)

  const duplicateCallId = await convertChat([
    { choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: 'duplicate', function: { name: 'ready_read_probe', arguments: '{}' } },
      { index: 1, id: 'duplicate', function: { name: 'ready_read_probe', arguments: '{}' } },
    ] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ])
  assert.match(duplicateCallId, /gateway_tool_call_identity_duplicate/)

  const bearerCallId = await convertChat([
    { choices: [{ index: 0, delta: { tool_calls: [{
      index: 0, id: 'Bearer other-token',
      function: { name: 'ready_read_probe', arguments: '{}' },
    }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ])
  assert.match(bearerCallId, /gateway_provider_credential_in_identity/)
  assert.doesNotMatch(bearerCallId, /response\.completed|Bearer other-token/)

  for (const sparseIndex of [7, 1]) {
    const output = await convertChat([
      { choices: [{ index: 0, delta: { tool_calls: [{
        index: sparseIndex, id: `call-${sparseIndex}`,
        function: { name: 'ready_read_probe', arguments: '{}' },
      }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ])
    assert.match(output, /gateway_chat_tool_call_index_sequence_invalid/)
    assert.doesNotMatch(output, /response\.completed/)
  }

  const missingName = await convertChat([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', function: { arguments: '{}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ])
  assert.match(missingName, /gateway_response_tool_name_missing/)
  assert.doesNotMatch(missingName, /response\.completed/)

  const truncatedAllowedPrefix = await convertChat([
    { choices: [{ index: 0, delta: { tool_calls: [{
      index: 0, id: 'call-prefix', function: { name: 'ready_read', arguments: '{}' },
    }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ])
  assert.match(truncatedAllowedPrefix, /gateway_response_tool_not_authorized/)
  assert.doesNotMatch(
    truncatedAllowedPrefix,
    /response\.completed|"id":"call-prefix"[^\n]*response\.output_item\.done/,
  )

  for (const malformedArguments of ['not-json', '[]']) {
    const output = await convertChat([
      { choices: [{ index: 0, delta: { tool_calls: [{
        index: 0, id: 'call-json',
        function: { name: 'ready_read_probe', arguments: malformedArguments },
      }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ])
    assert.match(output, /gateway_chat_tool_arguments_json_invalid/)
    assert.doesNotMatch(output, /response\.completed/)
  }

  const schemaInvalidArguments = await convertChat([
    { choices: [{ index: 0, delta: { tool_calls: [{
      index: 0, id: 'call-schema',
      function: { name: 'ready_read_probe', arguments: '{"query":1,"extra":true}' },
    }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ], ['ready_read_probe'], {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  })
  assert.match(schemaInvalidArguments, /gateway_tool_arguments_schema_invalid/)
  assert.doesNotMatch(
    schemaInvalidArguments,
    /response\.(output_item\.added|function_call_arguments\.(delta|done)|completed)/,
  )

  const changedId = await convertChat([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'ready_read_probe', arguments: '' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-2', function: { arguments: '{}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ])
  assert.match(changedId, /gateway_tool_call_identity_changed/)

  const authorizedPrefixMutation = await convertChat([
    { choices: [{ index: 0, delta: { tool_calls: [{
      index: 0, id: 'call-prefix-mutation',
      function: { name: 'ready_read_probe', arguments: '{"q":' },
    }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{
      index: 0, function: { name: '_evil', arguments: '"ok"}' },
    }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ])
  assert.match(authorizedPrefixMutation, /gateway_tool_call_name_changed/)
  assert.doesNotMatch(
    authorizedPrefixMutation,
    /response\.(output_item\.added|function_call_arguments\.(delta|done))/,
  )

  for (const malformedFragment of [
    { index: 0, id: 42, function: { arguments: '{}' } },
    { index: 0, function: { name: 42, arguments: '{}' } },
    { index: 0, function: { arguments: 42 } },
  ]) {
    const output = await convertChat([
      { choices: [{ index: 0, delta: { tool_calls: [{
        index: 0, id: 'call-1', function: { name: 'ready_read_probe', arguments: '{}' },
      }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [malformedFragment] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ])
    assert.match(output, /gateway_chat_tool_(call_id|name|arguments)_invalid/)
    assert.doesNotMatch(output, /response\.completed/)
  }

  const incremental = await convertChat([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'ready_read_probe', arguments: '' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"ok"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ])
  const deltas = incremental.split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as JsonObject)
    .filter((item) => item.type === 'response.function_call_arguments.delta')
    .map((item) => item.delta)
  assert.deepEqual(deltas, ['{"q":"ok"}'])
  const incrementalEvents = incremental.split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as JsonObject)
  assert.equal(incrementalEvents.filter((item) => item.type === 'response.output_item.added').length, 1)
  assert.match(incremental, /response\.completed/)

  let rejectedCalls: readonly CodexModelGatewayToolResponseCall[] = []
  const rejected = await convertChat([
    { choices: [{ index: 0, delta: { tool_calls: [{
      index: 0, id: 'call-rejected',
      function: { name: 'ready_read_probe', arguments: '{"q":"blocked"}' },
    }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ], ['ready_read_probe'], { type: 'object' }, undefined, async (calls) => {
    rejectedCalls = calls
    throw new Error('gateway_parallel_tool_group_budget_exhausted')
  })
  assert.deepEqual(rejectedCalls, [{
    codexCallId: 'call-rejected',
    toolName: 'ready_read_probe',
    argsDigest: digestCanonicalJson({ q: 'blocked' }),
  }])
  assert.match(rejected, /gateway_parallel_tool_group_budget_exhausted/)
  assert.doesNotMatch(
    rejected,
    /response\.(output_item\.added|function_call_arguments\.(delta|done)|completed)/,
  )

  const parallel = await convertChat([
    { choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: 'call-1', function: { name: 'tool_a', arguments: '{}' } },
      { index: 1, id: 'call-2', function: { name: 'tool_b', arguments: '{}' } },
    ] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ], ['tool_a', 'tool_b'])
  const parallelEvents = parallel.split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as JsonObject)
  assert.equal(parallelEvents.filter((item) => item.type === 'response.output_item.added').length, 2)
  assert.match(parallel, /response\.completed/)
})

test('Chat streaming maps explicit summaries but rejects raw reasoning fields', async () => {
  const rerouted = await convertChat([
    { model: 'wrong-model', choices: [{ index: 0, delta: { content: 'must-not-pass' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ])
  assert.match(rerouted, /gateway_upstream_model_mismatch/)
  assert.doesNotMatch(rerouted, /response\.completed|must-not-pass/)

  const direct = await convertChat([
    { choices: [{ index: 0, delta: { reasoning_summary: 'visible-summary' } }] },
    { choices: [{ index: 0, delta: { content: 'answer' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ])
  assert.match(direct, /response\.reasoning_summary_text\.delta/)
  assert.match(direct, /visible-summary/)

  const hidden = await convertChat([
    { choices: [{ index: 0, delta: { reasoning_content: 'hidden-reasoning' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ])
  assert.match(hidden, /gateway_chat_raw_reasoning_unsupported/)
  assert.doesNotMatch(hidden, /response\.completed|hidden-reasoning/)

  const minimax = createCodexUpstreamProfileSnapshot({
    profileId: 'minimax-fixture',
    config: {
      provider: 'openai-compatible', baseUrl: 'https://api.minimax.chat/v1', apiKey: 'secret',
      model: 'MiniMax-M2.1', agentProtocol: 'openai', wireApi: 'chat/completions', toolUseMode: 'on',
    },
    maxRetries: 0,
  }).snapshot
  const patched = await convertChat([
    { choices: [{ index: 0, message: { reasoning_details: [{ text: 'patched-reasoning' }] } }] },
    { choices: [{ index: 0, delta: { content: 'answer' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ], ['ready_read_probe'], { type: 'object' }, minimax)
  assert.match(patched, /gateway_chat_raw_reasoning_unsupported/)
  assert.doesNotMatch(patched, /response\.completed|patched-reasoning/)

  const leakedCredential = await convertChat([
    { choices: [{ index: 0, delta: { content: 'secret' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ])
  assert.match(leakedCredential, /\[REDACTED\]/)
  assert.doesNotMatch(leakedCredential, /secret/)

  const splitBearerMessage = await convertChat([
    { choices: [{ index: 0, delta: { content: 'Bearer ' } }] },
    { choices: [{ index: 0, delta: { content: '"other-token"' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ])
  assert.match(splitBearerMessage, /Bearer (?:"\[REDACTED\]"|\[REDACTED\])/)
  assert.doesNotMatch(splitBearerMessage, /other-token/)

  const quotedBearerMessage = await convertChat([
    { choices: [{ index: 0, delta: { content: "Bearer 'other-token'" } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ])
  assert.match(quotedBearerMessage, /Bearer (?:'\[REDACTED\]'|\[REDACTED\])/)
  assert.doesNotMatch(quotedBearerMessage, /other-token/)

  const splitBearerReasoning = await convertChat([
    { choices: [{ index: 0, delta: { reasoning_summary: 'Bearer ' } }] },
    { choices: [{ index: 0, delta: { reasoning_summary: '"other-token"' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ])
  assert.match(splitBearerReasoning, /Bearer \[REDACTED\]/)
  assert.doesNotMatch(splitBearerReasoning, /other-token/)

  const splitBearerArguments = await convertChat([
    { choices: [{ index: 0, delta: { tool_calls: [{
      index: 0, id: 'call-safe',
      function: { name: 'ready_read_probe', arguments: "{\"token\":\"Bearer '" },
    }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{
      index: 0, function: { arguments: "other-token'\"}" },
    }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ])
  assert.match(splitBearerArguments, /gateway_tool_arguments_secret_detected/)
  assert.doesNotMatch(splitBearerArguments, /other-token/)
  const argumentEvents = splitBearerArguments.split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as JsonObject)
  assert.equal(argumentEvents.filter((item) => (
    item.type === 'response.output_item.added'
    || String(item.type).startsWith('response.function_call_arguments.')
  )).length, 0)
})

test('native Responses rejects changed identities, invalid schemas and incomplete action items', async () => {
  let mode: 'arguments' | 'call_id' | 'invalid_json' | 'schema' | 'incomplete_status'
    | 'failed_terminal' | 'incomplete_terminal' | 'error_terminal' | 'admission'
    = 'arguments'
  let admissionAttempts = 0
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const finalArguments = mode === 'invalid_json'
      ? '{"query":'
      : mode === 'schema'
        ? '{"query":1,"extra":true}'
        : '{"query":"ok"}'
    const doneItem = {
      type: 'function_call', id: 'item-1', call_id: mode === 'call_id' ? 'call-2' : 'call-1',
      name: 'ready_read_probe', arguments: finalArguments,
      ...(mode === 'incomplete_status' ? { status: 'incomplete' } : {}),
    }
    const terminalEvent = mode === 'failed_terminal'
      ? {
          type: 'response.failed',
          response: {
            id: 'response-1', model: 'native-model', status: 'failed', output: [doneItem],
            error: { code: 'upstream_failed', message: 'upstream failed', type: 'upstream_error', param: null },
          },
        }
      : mode === 'incomplete_terminal'
        ? {
            type: 'response.incomplete',
            response: {
              id: 'response-1', model: 'native-model', status: 'incomplete', output: [doneItem],
              incomplete_details: { reason: 'max_output_tokens' }, usage: nativeUsage(),
            },
          }
        : {
            type: 'response.completed',
            response: {
              id: 'response-1', model: 'native-model', status: 'completed', output: [doneItem],
              usage: nativeUsage(),
            },
          }
    const events = [
      {
        type: 'response.created',
        response: { id: 'response-1', model: 'native-model', status: 'in_progress' },
      },
      {
        type: 'response.output_item.added', output_index: 0,
        item: { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'ready_read_probe', arguments: '' },
      },
      {
        type: 'response.function_call_arguments.delta', output_index: 0,
        item_id: 'item-1', delta: '{"query":',
      },
      ...(mode === 'invalid_json' ? [] : [{
        type: 'response.function_call_arguments.delta', output_index: 0,
        item_id: 'item-1', delta: mode === 'schema' ? '1,"extra":true}' : '"ok"}',
      }]),
      ...(mode === 'error_terminal' ? [{
        type: 'error', code: 'upstream_error', message: 'upstream failed',
        param: null, sequence_number: 4,
      }] : [
        {
          type: 'response.function_call_arguments.done', output_index: 0,
          item_id: 'item-1',
          arguments: mode === 'arguments' ? '{"query":"mutated"}' : finalArguments,
        },
        {
          type: 'response.output_item.done', output_index: 0,
          item: doneItem,
        },
        terminalEvent,
      ]),
    ]
    response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
  })
  const port = await listen(upstream)
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-native',
    config: {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'secret',
      model: 'native-model', agentProtocol: 'openai', wireApi: 'responses', toolUseMode: 'on',
    },
    maxRetries: 0,
  })
  const request = requestBody(['ready_read_probe'])
  ;((request.tools as JsonObject[])[0]).parameters = {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  }
  const requestMetadata = JSON.parse(
    (request.client_metadata as Record<string, string>)['x-codex-turn-metadata'],
  ) as JsonObject
  requestMetadata.toolSurfaceDigest = digestCanonicalJson(request.tools)
  ;(request.client_metadata as Record<string, string>)['x-codex-turn-metadata'] = JSON.stringify(
    requestMetadata,
  )
  const binding = bindRequest(request, created.snapshot)
  const gateway = new CodexModelGateway({
    bearerToken: 'local-token',
    authority: {
      async resolve(input) { input.validate(binding); return binding },
      async admitToolResponse(input) {
        admissionAttempts += 1
        assert.deepEqual(input.calls, [{
          codexCallId: 'call-1',
          toolName: 'ready_read_probe',
          argsDigest: digestCanonicalJson({ query: 'ok' }),
        }])
        throw new CodexModelGatewayError('gateway_tool_call_budget_exhausted', 409)
      },
    },
    credentials: { resolve() { return 'secret' } },
  })
  const address = await gateway.start()
  const call = () => fetch(`${address.url}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  try {
    const changedArguments = await call()
    const changedArgumentsText = await changedArguments.text()
    assert.match(changedArgumentsText, /gateway_response_tool_arguments_changed/)
    assert.doesNotMatch(
      changedArgumentsText,
      /response\.(output_item\.added|function_call_arguments\.(delta|done))/,
    )
    mode = 'call_id'
    const changedCallId = await call()
    const changedCallIdText = await changedCallId.text()
    assert.match(changedCallIdText, /gateway_response_item_identity_changed/)
    assert.doesNotMatch(
      changedCallIdText,
      /response\.(output_item\.added|function_call_arguments\.(delta|done))/,
    )
    mode = 'invalid_json'
    const invalidJson = await call()
    const invalidJsonText = await invalidJson.text()
    assert.match(invalidJsonText, /gateway_response_tool_arguments_json_invalid/)
    assert.doesNotMatch(
      invalidJsonText,
      /response\.(output_item\.added|function_call_arguments\.(delta|done))/,
    )
    mode = 'schema'
    const invalidSchemaText = await (await call()).text()
    assert.match(invalidSchemaText, /gateway_tool_arguments_schema_invalid/)
    assert.doesNotMatch(
      invalidSchemaText,
      /response\.(output_item\.added|function_call_arguments\.(delta|done))/,
    )
    mode = 'incomplete_status'
    const incompleteStatusText = await (await call()).text()
    assert.match(incompleteStatusText, /gateway_response_item_terminal_status_invalid/)
    assert.doesNotMatch(
      incompleteStatusText,
      /response\.(output_item\.added|function_call_arguments\.(delta|done)|completed)/,
    )
    for (const terminalMode of [
      'failed_terminal', 'incomplete_terminal', 'error_terminal',
    ] as const) {
      mode = terminalMode
      const failedTerminalText = await (await call()).text()
      assert.doesNotMatch(
        failedTerminalText,
        /response\.(output_item\.added|function_call_arguments\.(delta|done)|completed)/,
      )
      assert.doesNotMatch(failedTerminalText, /ready_read_probe|call-1|"query"/)
      assert.equal(admissionAttempts, 0)
    }
    mode = 'admission'
    const rejectedAdmissionText = await (await call()).text()
    assert.match(rejectedAdmissionText, /gateway_tool_call_budget_exhausted/)
    assert.doesNotMatch(
      rejectedAdmissionText,
      /response\.(output_item\.added|function_call_arguments\.(delta|done)|completed)/,
    )
    assert.equal(admissionAttempts, 1)
  } finally {
    await gateway.stop()
    await close(upstream)
  }
})

test('native Responses binds message, reasoning, item and call identities through the terminal event', async () => {
  let mode: 'message' | 'reasoning' | 'terminal' | 'item_id' | 'call_id'
    | 'message_missing_text_done' | 'message_missing_part_done'
    | 'reasoning_missing_text_done' | 'reasoning_missing_part_done' = 'message'
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const created = {
      type: 'response.created',
      response: { id: 'response-exact', model: 'native-model', status: 'in_progress', output: [] },
    }
    let events: JsonObject[]
    if (
      mode === 'reasoning'
      || mode === 'reasoning_missing_text_done'
      || mode === 'reasoning_missing_part_done'
    ) {
      const explicitPart = mode === 'reasoning_missing_part_done'
      const doneText = mode === 'reasoning' ? 'mutated' : 'verified'
      events = [
        created,
        {
          type: 'response.output_item.added', output_index: 0,
          item: { type: 'reasoning', id: 'reasoning-1', summary: [] },
        },
        ...(explicitPart ? [{
          type: 'response.reasoning_summary_part.added', output_index: 0,
          summary_index: 0, item_id: 'reasoning-1', part: { type: 'summary_text', text: '' },
        }] : []),
        {
          type: 'response.reasoning_summary_text.delta', output_index: 0,
          summary_index: 0, item_id: 'reasoning-1', delta: 'verified',
        },
        ...(mode === 'reasoning_missing_text_done' || mode === 'reasoning' ? [] : [{
          type: 'response.reasoning_summary_text.done', output_index: 0,
          summary_index: 0, item_id: 'reasoning-1', text: 'verified',
        }]),
        {
          type: 'response.output_item.done', output_index: 0,
          item: {
            type: 'reasoning', id: 'reasoning-1',
            summary: [{ type: 'summary_text', text: doneText }],
          },
        },
      ]
    } else if (mode === 'item_id') {
      events = [
        created,
        {
          type: 'response.output_item.added', output_index: 0,
          item: { type: 'message', id: 'duplicate-1', role: 'assistant', content: [] },
        },
        {
          type: 'response.output_item.done', output_index: 0,
          item: { type: 'message', id: 'duplicate-1', role: 'assistant', content: [] },
        },
        {
          type: 'response.output_item.added', output_index: 1,
          item: { type: 'reasoning', id: 'duplicate-1', summary: [] },
        },
      ]
    } else if (mode === 'call_id') {
      events = [
        created,
        {
          type: 'response.output_item.added', output_index: 0,
          item: { type: 'function_call', id: 'tool-1', call_id: 'duplicate-call', name: 'ready_read_probe', arguments: '' },
        },
        {
          type: 'response.function_call_arguments.delta', output_index: 0,
          item_id: 'tool-1', delta: '{}',
        },
        {
          type: 'response.function_call_arguments.done', output_index: 0,
          item_id: 'tool-1', arguments: '{}',
        },
        {
          type: 'response.output_item.done', output_index: 0,
          item: { type: 'function_call', id: 'tool-1', call_id: 'duplicate-call', name: 'ready_read_probe', arguments: '{}' },
        },
        {
          type: 'response.output_item.added', output_index: 1,
          item: { type: 'function_call', id: 'tool-2', call_id: 'duplicate-call', name: 'ready_read_probe', arguments: '' },
        },
      ]
    } else {
      const doneText = mode === 'message' ? 'mutated' : 'verified'
      const terminalText = mode === 'terminal' ? 'mutated' : doneText
      const explicitPart = mode === 'message_missing_part_done'
      const doneItem = {
        type: 'message', id: 'message-1', role: 'assistant',
        content: [{ type: 'output_text', text: doneText }],
      }
      events = [
        created,
        {
          type: 'response.output_item.added', output_index: 0,
          item: { type: 'message', id: 'message-1', role: 'assistant', content: [] },
        },
        ...(explicitPart ? [{
          type: 'response.content_part.added', output_index: 0, content_index: 0,
          item_id: 'message-1', part: { type: 'output_text', text: '' },
        }] : []),
        {
          type: 'response.output_text.delta', output_index: 0, content_index: 0,
          item_id: 'message-1', delta: 'verified',
        },
        ...(mode === 'message_missing_text_done' ? [] : [{
          type: 'response.output_text.done', output_index: 0, content_index: 0,
          item_id: 'message-1', text: 'verified',
        }]),
        { type: 'response.output_item.done', output_index: 0, item: doneItem },
        {
          type: 'response.completed',
          response: {
            id: 'response-exact', model: 'native-model', status: 'completed',
            output: [{
              type: 'message', id: 'message-1', role: 'assistant',
              content: [{ type: 'output_text', text: terminalText }],
            }],
            usage: nativeUsage(),
          },
        },
      ]
    }
    response.end(events.map((item) => `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`).join(''))
  })
  const port = await listen(upstream)
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-native-exact',
    config: {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'secret',
      model: 'native-model', agentProtocol: 'openai', wireApi: 'responses', toolUseMode: 'on',
    },
    maxRetries: 0,
  })
  const request = requestBody(['ready_read_probe'])
  const binding = bindRequest(request, created.snapshot)
  const gateway = new CodexModelGateway({
    bearerToken: 'local-token',
    authority: { async resolve(input) { input.validate(binding); return binding } },
    credentials: { resolve() { return 'secret' } },
  })
  const address = await gateway.start()
  const call = async () => {
    const response = await fetch(`${address.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    return response.text()
  }
  try {
    assert.match(await call(), /gateway_response_message_content_changed/)
    mode = 'reasoning'
    assert.match(await call(), /gateway_response_reasoning_summary_changed/)
    mode = 'terminal'
    assert.match(await call(), /gateway_response_output_mismatch/)
    mode = 'item_id'
    assert.match(await call(), /gateway_response_item_identity_duplicate/)
    mode = 'call_id'
    assert.match(await call(), /gateway_response_item_identity_duplicate/)
    mode = 'message_missing_text_done'
    assert.match(await call(), /gateway_response_message_lifecycle_incomplete/)
    mode = 'message_missing_part_done'
    assert.match(await call(), /gateway_response_message_lifecycle_incomplete/)
    mode = 'reasoning_missing_text_done'
    assert.match(await call(), /gateway_response_reasoning_lifecycle_incomplete/)
    mode = 'reasoning_missing_part_done'
    assert.match(await call(), /gateway_response_reasoning_lifecycle_incomplete/)
  } finally {
    await gateway.stop()
    await close(upstream)
  }
})

test('native Responses keeps in-progress and content-part lifecycle monotonic', async () => {
  let mode: 'in_progress_output' | 'in_progress_duplicate' | 'in_progress_late'
    | 'message_after_part_done' | 'reasoning_after_part_done' = 'in_progress_output'
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const created = {
      type: 'response.created',
      response: { id: 'monotonic-1', model: 'native-model', status: 'in_progress', output: [] },
    }
    const inProgress = {
      type: 'response.in_progress',
      response: { id: 'monotonic-1', model: 'native-model', status: 'in_progress', output: [] },
    }
    let events: JsonObject[]
    if (mode === 'in_progress_output') {
      events = [created, {
        type: 'response.in_progress',
        response: {
          id: 'monotonic-1', model: 'native-model', status: 'in_progress',
          output: [{
            type: 'message', id: 'unbound-message', role: 'assistant',
            content: [{ type: 'output_text', text: 'UNBOUND_CONTENT' }],
          }],
        },
      }]
    } else if (mode === 'in_progress_duplicate') {
      events = [created, inProgress, inProgress]
    } else if (mode === 'in_progress_late') {
      events = [created, {
        type: 'response.output_item.added', output_index: 0,
        item: { type: 'message', id: 'message-late', role: 'assistant', content: [] },
      }, inProgress]
    } else if (mode === 'message_after_part_done') {
      const part = { type: 'output_text', text: '' }
      events = [
        created,
        {
          type: 'response.output_item.added', output_index: 0,
          item: { type: 'message', id: 'message-part', role: 'assistant', content: [] },
        },
        {
          type: 'response.content_part.added', output_index: 0, content_index: 0,
          item_id: 'message-part', part,
        },
        {
          type: 'response.content_part.done', output_index: 0, content_index: 0,
          item_id: 'message-part', part,
        },
        {
          type: 'response.output_text.delta', output_index: 0, content_index: 0,
          item_id: 'message-part', delta: 'LATE_MESSAGE',
        },
      ]
    } else {
      const part = { type: 'summary_text', text: '' }
      events = [
        created,
        {
          type: 'response.output_item.added', output_index: 0,
          item: { type: 'reasoning', id: 'reasoning-part', summary: [] },
        },
        {
          type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 0,
          item_id: 'reasoning-part', part,
        },
        {
          type: 'response.reasoning_summary_part.done', output_index: 0, summary_index: 0,
          item_id: 'reasoning-part', part,
        },
        {
          type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0,
          item_id: 'reasoning-part', delta: 'LATE_REASONING',
        },
      ]
    }
    response.end(events.map((item) => (
      `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`
    )).join(''))
  })
  const port = await listen(upstream)
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-native-monotonic',
    config: {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'secret',
      model: 'native-model', agentProtocol: 'openai', wireApi: 'responses', toolUseMode: 'on',
    },
    maxRetries: 0,
  })
  const request = requestBody()
  const binding = bindRequest(request, created.snapshot)
  const gateway = new CodexModelGateway({
    bearerToken: 'local-token',
    authority: { async resolve(input) { input.validate(binding); return binding } },
    credentials: { resolve() { return 'secret' } },
  })
  const address = await gateway.start()
  const call = async () => {
    const response = await fetch(`${address.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    return response.text()
  }
  try {
    const unbound = await call()
    assert.match(unbound, /gateway_response_in_progress_output_not_empty/)
    assert.doesNotMatch(unbound, /response\.completed|UNBOUND_CONTENT/)

    mode = 'in_progress_duplicate'
    assert.match(await call(), /gateway_response_in_progress_order_invalid/)
    mode = 'in_progress_late'
    assert.match(await call(), /gateway_response_in_progress_order_invalid/)
    mode = 'message_after_part_done'
    const lateMessage = await call()
    assert.match(lateMessage, /gateway_response_content_part_changed/)
    assert.doesNotMatch(lateMessage, /response\.completed|LATE_MESSAGE/)
    mode = 'reasoning_after_part_done'
    const lateReasoning = await call()
    assert.match(lateReasoning, /gateway_response_reasoning_summary_changed/)
    assert.doesNotMatch(lateReasoning, /response\.completed|LATE_REASONING/)
  } finally {
    await gateway.stop()
    await close(upstream)
  }
})

test('native Responses validates usage, redacts display text, and rejects secrets in action arguments', async () => {
  let mode: 'usage' | 'refusal' | 'output_text' | 'reasoning' | 'refusal_bearer'
    | 'arguments' | 'developer_role' | 'bad_incomplete' | 'bad_failed'
    | 'bad_completed' | 'reasoning_encrypted' | 'bad_reasoning_encrypted'
    | 'bad_reasoning_content' | 'incomplete_length' | 'incomplete_filter' = 'usage'
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const created = {
      type: 'response.created',
      response: { id: 'native-shape-1', model: 'native-model', status: 'in_progress', output: [] },
    }
    let events: JsonObject[]
    if (mode === 'usage') {
      events = [created, {
        type: 'response.completed',
        response: {
          id: 'native-shape-1', model: 'native-model', status: 'completed', output: [],
          usage: {
            input_tokens: -1, output_tokens: 2, total_tokens: 999,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      }]
    } else if (mode === 'developer_role') {
      events = [created, {
        type: 'response.output_item.added', output_index: 0,
        item: { type: 'message', id: 'injected-role', role: 'developer', content: [] },
      }]
    } else if (mode === 'incomplete_length' || mode === 'incomplete_filter') {
      events = [created, {
        type: 'response.incomplete',
        response: {
          id: 'native-shape-1', model: 'native-model', status: 'incomplete', output: [],
          incomplete_details: {
            reason: mode === 'incomplete_length' ? 'max_output_tokens' : 'content_filter',
          },
          usage: nativeUsage(),
        },
      }]
    } else if (mode === 'bad_incomplete') {
      events = [created, {
        type: 'response.incomplete',
        response: {
          id: 'native-shape-1', model: 'native-model', status: 'incomplete', output: [],
          incomplete_details: { reason: 'length' },
          usage: nativeUsage(),
        },
      }]
    } else if (mode === 'bad_failed') {
      events = [created, {
        type: 'response.failed',
        response: { id: 'native-shape-1', model: 'native-model', status: 'failed', output: [] },
      }]
    } else if (mode === 'bad_completed') {
      events = [created, {
        type: 'response.completed',
        response: {
          id: 'native-shape-1', model: 'native-model', status: 'completed', output: [],
          error: { code: 'server_error', message: 'conflict' },
          usage: nativeUsage(),
        },
      }]
    } else if (mode === 'refusal') {
      const refusal = { type: 'refusal', refusal: 'request refused' }
      events = [
        created,
        {
          type: 'response.output_item.added', output_index: 0,
          item: { type: 'message', id: 'refusal-1', role: 'assistant', content: [] },
        },
        {
          type: 'response.content_part.added', output_index: 0, content_index: 0,
          item_id: 'refusal-1', part: { type: 'refusal', refusal: '' },
        },
        {
          type: 'response.refusal.delta', output_index: 0, content_index: 0,
          item_id: 'refusal-1', delta: 'request refused',
        },
        {
          type: 'response.refusal.done', output_index: 0, content_index: 0,
          item_id: 'refusal-1', refusal: 'request refused',
        },
        {
          type: 'response.content_part.done', output_index: 0, content_index: 0,
          item_id: 'refusal-1', part: refusal,
        },
        {
          type: 'response.output_item.done', output_index: 0,
          item: { type: 'message', id: 'refusal-1', role: 'assistant', content: [refusal] },
        },
        {
          type: 'response.completed',
          response: {
            id: 'native-shape-1', model: 'native-model', status: 'completed',
            output: [{ type: 'message', id: 'refusal-1', role: 'assistant', content: [refusal] }],
            usage: nativeUsage(),
          },
        },
      ]
    } else if (
      mode === 'reasoning_encrypted'
      || mode === 'bad_reasoning_encrypted'
      || mode === 'bad_reasoning_content'
    ) {
      const item = {
        type: 'reasoning', id: 'reasoning-opaque',
        summary: [{ type: 'summary_text', text: 'safe summary' }],
        content: mode === 'bad_reasoning_content'
          ? [{ type: 'reasoning_text', text: 7 }]
          : [{ type: 'reasoning_text', text: 'raw private reasoning' }],
        encrypted_content: mode === 'bad_reasoning_encrypted' ? { invalid: true } : 'opaque-ciphertext',
      }
      events = [
        created,
        {
          type: 'response.output_item.added', output_index: 0,
          item: {
            type: 'reasoning', id: 'reasoning-opaque', summary: [],
            content: null, encrypted_content: null,
          },
        },
        {
          type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0,
          item_id: 'reasoning-opaque', delta: 'safe summary',
        },
        {
          type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0,
          item_id: 'reasoning-opaque', text: 'safe summary',
        },
        { type: 'response.output_item.done', output_index: 0, item },
        {
          type: 'response.completed',
          response: {
            id: 'native-shape-1', model: 'native-model', status: 'completed', output: [item],
            usage: nativeUsage(),
          },
        },
      ]
    } else if (mode === 'reasoning') {
      const item = {
        type: 'reasoning', id: 'reasoning-safe',
        summary: [{ type: 'summary_text', text: "Bearer 'other-token'" }],
      }
      events = [
        created,
        {
          type: 'response.output_item.added', output_index: 0,
          item: { type: 'reasoning', id: 'reasoning-safe', summary: [] },
        },
        {
          type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0,
          item_id: 'reasoning-safe', delta: "Bearer '",
        },
        {
          type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0,
          item_id: 'reasoning-safe', delta: "other-token'",
        },
        {
          type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0,
          item_id: 'reasoning-safe', text: "Bearer 'other-token'",
        },
        { type: 'response.output_item.done', output_index: 0, item },
        {
          type: 'response.completed',
          response: {
            id: 'native-shape-1', model: 'native-model', status: 'completed', output: [item],
            usage: nativeUsage(),
          },
        },
      ]
    } else if (mode === 'arguments') {
      const item = {
        type: 'function_call', id: 'argument-safe', call_id: 'call-safe',
        name: 'ready_read_probe', arguments: '{"token":"Bearer \'other-token\'"}',
      }
      events = [
        created,
        {
          type: 'response.output_item.added', output_index: 0,
          item: { ...item, arguments: '' },
        },
        {
          type: 'response.function_call_arguments.delta', output_index: 0,
          item_id: 'argument-safe', delta: '{"token":"Bearer \'',
        },
        {
          type: 'response.function_call_arguments.delta', output_index: 0,
          item_id: 'argument-safe', delta: 'other-token\'"}',
        },
        {
          type: 'response.function_call_arguments.done', output_index: 0,
          item_id: 'argument-safe', arguments: '{"token":"Bearer \'other-token\'"}',
        },
        { type: 'response.output_item.done', output_index: 0, item },
        {
          type: 'response.completed',
          response: {
            id: 'native-shape-1', model: 'native-model', status: 'completed', output: [item],
            usage: nativeUsage(),
          },
        },
      ]
    } else if (mode === 'refusal_bearer') {
      const item = {
        type: 'message', id: 'refusal-safe', role: 'assistant',
        content: [{ type: 'refusal', refusal: "Bearer 'other-token'" }],
      }
      events = [
        created,
        {
          type: 'response.output_item.added', output_index: 0,
          item: { type: 'message', id: 'refusal-safe', role: 'assistant', content: [] },
        },
        {
          type: 'response.refusal.delta', output_index: 0, content_index: 0,
          item_id: 'refusal-safe', delta: "Bearer '",
        },
        {
          type: 'response.refusal.delta', output_index: 0, content_index: 0,
          item_id: 'refusal-safe', delta: "other-token'",
        },
        {
          type: 'response.refusal.done', output_index: 0, content_index: 0,
          item_id: 'refusal-safe', refusal: "Bearer 'other-token'",
        },
        { type: 'response.output_item.done', output_index: 0, item },
        {
          type: 'response.completed',
          response: {
            id: 'native-shape-1', model: 'native-model', status: 'completed', output: [item],
            usage: nativeUsage(),
          },
        },
      ]
    } else {
      const item = {
        type: 'message', id: 'message-safe', role: 'assistant',
        content: [{ type: 'output_text', text: "Bearer 'other-token'" }],
      }
      events = [
        created,
        {
          type: 'response.output_item.added', output_index: 0,
          item: { type: 'message', id: 'message-safe', role: 'assistant', content: [] },
        },
        {
          type: 'response.output_text.delta', output_index: 0, content_index: 0,
          item_id: 'message-safe', delta: "Bearer '",
        },
        {
          type: 'response.output_text.delta', output_index: 0, content_index: 0,
          item_id: 'message-safe', delta: "other-token'",
        },
        {
          type: 'response.output_text.done', output_index: 0, content_index: 0,
          item_id: 'message-safe', text: "Bearer 'other-token'",
        },
        { type: 'response.output_item.done', output_index: 0, item },
        {
          type: 'response.completed',
          response: {
            id: 'native-shape-1', model: 'native-model', status: 'completed', output: [item],
            usage: nativeUsage(),
          },
        },
      ]
    }
    response.end(events.map((item) => (
      `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`
    )).join(''))
  })
  const port = await listen(upstream)
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-native-shapes',
    config: {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'secret',
      model: 'native-model', agentProtocol: 'openai', wireApi: 'responses', toolUseMode: 'on',
    },
    maxRetries: 0,
  })
  const request = requestBody(['ready_read_probe'])
  const binding = bindRequest(request, created.snapshot)
  const gateway = new CodexModelGateway({
    bearerToken: 'local-token',
    authority: { async resolve(input) { input.validate(binding); return binding } },
    credentials: { resolve() { return 'secret' } },
  })
  const address = await gateway.start()
  const call = async () => {
    const response = await fetch(`${address.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    return response.text()
  }
  try {
    const invalidUsage = await call()
    assert.match(invalidUsage, /gateway_response_usage_invalid/)
    assert.doesNotMatch(invalidUsage, /response\.completed/)

    mode = 'developer_role'
    const injectedRole = await call()
    assert.match(injectedRole, /gateway_response_message_role_invalid/)
    assert.doesNotMatch(injectedRole, /response\.completed|"role":"developer"/)

    for (const [terminalMode, code] of [
      ['bad_incomplete', 'gateway_response_incomplete_details_invalid'],
      ['bad_failed', 'gateway_response_failure_error_invalid'],
      ['bad_completed', 'gateway_response_completed_state_invalid'],
    ] as const) {
      mode = terminalMode
      const output = await call()
      assert.match(output, new RegExp(code))
      assert.doesNotMatch(output, /event: response\.(completed|incomplete)/)
    }

    for (const [terminalMode, code] of [
      ['incomplete_length', 'gateway_upstream_output_truncated'],
      ['incomplete_filter', 'gateway_upstream_output_filtered'],
    ] as const) {
      mode = terminalMode
      const output = await call()
      assert.match(output, /event: response\.failed/)
      assert.match(output, new RegExp(code))
      assert.doesNotMatch(output, /event: response\.(completed|incomplete)/)
    }

    mode = 'refusal'
    const refusal = await call()
    assert.match(refusal, /response\.completed/)
    assert.match(refusal, /request refused/)
    assert.doesNotMatch(refusal, /response\.failed/)

    mode = 'reasoning_encrypted'
    const opaqueReasoning = await call()
    assert.match(opaqueReasoning, /response\.completed/)
    assert.match(opaqueReasoning, /safe summary|raw private reasoning|opaque-ciphertext/)
    for (const [invalidMode, code] of [
      ['bad_reasoning_encrypted', 'gateway_response_reasoning_encrypted_content_invalid'],
      ['bad_reasoning_content', 'gateway_response_reasoning_content_invalid'],
    ] as const) {
      mode = invalidMode
      const invalid = await call()
      assert.match(invalid, new RegExp(code))
      assert.doesNotMatch(invalid, /response\.completed/)
    }

    for (const splitMode of ['output_text', 'reasoning', 'refusal_bearer'] as const) {
      mode = splitMode
      const output = await call()
      assert.match(output, /response\.completed/)
      assert.match(output, /Bearer (?:'\[REDACTED\]'|\[REDACTED\])/)
      assert.doesNotMatch(output, /response\.failed|other-token/)
      const events = output.split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)) as JsonObject)
      const family = splitMode === 'reasoning'
          ? 'reasoning_summary_text'
          : splitMode === 'refusal_bearer' ? 'refusal' : 'output_text'
      const aggregate = events
        .filter((item) => item.type === `response.${family}.delta`)
        .map((item) => String(item.delta))
        .join('')
      const doneEvent = events.find((item) => item.type === `response.${family}.done`) as JsonObject
      const itemDone = events.find((item) => item.type === 'response.output_item.done')?.item as JsonObject
      const terminalResponse = events.find((item) => item.type === 'response.completed')?.response as JsonObject
      const terminalItem = (terminalResponse.output as JsonObject[])[0]
      const readValue = (item: JsonObject): string => {
        if (splitMode === 'reasoning') return String(((item.summary as JsonObject[])[0]).text)
        const part = (item.content as JsonObject[])[0]
        return String(splitMode === 'refusal_bearer' ? part.refusal : part.text)
      }
      const doneValue = String(
        splitMode === 'reasoning'
            ? doneEvent.text
            : splitMode === 'refusal_bearer' ? doneEvent.refusal : doneEvent.text,
      )
      assert.equal(aggregate, doneValue)
      assert.equal(doneValue, readValue(itemDone))
      assert.equal(readValue(itemDone), readValue(terminalItem))
    }

    mode = 'arguments'
    const secretArguments = await call()
    assert.match(secretArguments, /gateway_tool_arguments_secret_detected/)
    assert.doesNotMatch(secretArguments, /response\.completed|other-token/)
    assert.doesNotMatch(
      secretArguments,
      /response\.(output_item\.added|function_call_arguments\.(delta|done))/,
    )
  } finally {
    await gateway.stop()
    await close(upstream)
  }
})

test('native Responses rejects model/status reroutes, redacts secrets and withholds premature terminal events', async () => {
  let mode: 'model' | 'status' | 'secret' | 'failed-secret' | 'header-secret'
    | 'created-secret' | 'terminal-secret' | 'unknown-extension' | 'trailing' = 'model'
  const upstream = createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-request-id': mode === 'header-secret' ? 'upstream-secret' : 'request-safe',
    })
    const events = mode === 'secret'
      ? [{
          type: 'error',
          code: 'provider_error',
          message: 'Bearer upstream-secret and upstream-secret must not cross',
          param: 'upstream-secret',
          sequence_number: 0,
        }]
      : mode === 'failed-secret'
        ? [
            {
              type: 'response.created',
              response: { id: 'response-safe', model: 'native-model', status: 'in_progress' },
            },
            {
              type: 'response.failed',
              response: {
                id: 'response-safe', model: 'native-model', status: 'failed', output: [],
                error: {
                  code: 'provider_failed', type: 'upstream_error',
                  message: 'Bearer upstream-secret and upstream-secret must not cross',
                },
              },
            },
          ]
      : [
          {
            type: 'response.created',
            response: {
              id: 'response-safe', model: mode === 'model' ? 'wrong-model' : 'native-model',
              status: 'in_progress',
              ...(mode === 'created-secret' ? {
                metadata: { leak: 'upstream-secret', 'upstream-secret': 'leak-in-key' },
              } : mode === 'unknown-extension' ? {
                command: 'benign-but-unverified',
              } : {}),
            },
          },
          {
            type: 'response.completed',
            response: {
              id: 'response-safe', model: mode === 'model' ? 'wrong-model' : 'native-model',
              status: mode === 'status' ? 'failed' : 'completed', output: [],
              usage: nativeUsage(),
              ...(mode === 'terminal-secret' ? { metadata: { leak: 'Bearer upstream-secret' } } : {}),
            },
          },
          ...(mode === 'trailing'
            ? [{ type: 'response.shell_call', command: 'touch forbidden' }]
            : []),
        ]
    response.end(events.map((item) => `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`).join(''))
  })
  const port = await listen(upstream)
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-native-safety',
    config: {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'upstream-secret', model: 'native-model', agentProtocol: 'openai',
      wireApi: 'responses', toolUseMode: 'on',
    },
    maxRetries: 0,
  })
  const request = requestBody()
  const binding = bindRequest(request, created.snapshot)
  const gateway = new CodexModelGateway({
    bearerToken: 'local-token',
    authority: { async resolve(input) { input.validate(binding); return binding } },
    credentials: { resolve() { return 'upstream-secret' } },
  })
  const address = await gateway.start()
  const call = async () => {
    const response = await fetch(`${address.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    return {
      body: await response.text(),
      upstreamRequestId: response.headers.get('x-ready-upstream-request-id'),
    }
  }
  try {
    const wrongModel = await call()
    assert.match(wrongModel.body, /gateway_upstream_model_mismatch/)
    assert.doesNotMatch(wrongModel.body, /response\.completed/)

    mode = 'status'
    const wrongStatus = await call()
    assert.match(wrongStatus.body, /gateway_response_status_mismatch/)
    assert.doesNotMatch(wrongStatus.body, /response\.completed/)

    mode = 'secret'
    const secret = await call()
    assert.match(secret.body, /\[REDACTED\]/)
    assert.doesNotMatch(secret.body, /upstream-secret|must-not-cross/)

    mode = 'failed-secret'
    const failedSecret = await call()
    assert.match(failedSecret.body, /response\.failed/)
    assert.match(failedSecret.body, /\[REDACTED\]/)
    assert.doesNotMatch(failedSecret.body, /upstream-secret|must-not-cross|ignored/)

    mode = 'header-secret'
    const headerSecret = await call()
    assert.match(headerSecret.body, /response\.completed/)
    assert.equal(headerSecret.upstreamRequestId, null)

    for (const secretMode of ['created-secret', 'terminal-secret'] as const) {
      mode = secretMode
      const unknownSecret = await call()
      assert.match(unknownSecret.body, /gateway_response_shape_invalid/)
      assert.doesNotMatch(unknownSecret.body, /response\.completed|upstream-secret/)
    }

    mode = 'unknown-extension'
    const unknownExtension = await call()
    assert.match(unknownExtension.body, /gateway_response_shape_invalid/)
    assert.doesNotMatch(unknownExtension.body, /response\.completed|benign-but-unverified/)

    mode = 'trailing'
    const trailing = await call()
    assert.match(trailing.body, /gateway_response_event_not_allowed/)
    assert.doesNotMatch(trailing.body, /response\.completed|touch forbidden/)
  } finally {
    await gateway.stop()
    await close(upstream)
  }
})

test('a short credential collision in a native identity fails without rewriting protocol fields', async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end([
      {
        type: 'response.created',
        response: { id: 'safe-response', model: 'native-model', status: 'in_progress', output: [] },
      },
      {
        type: 'response.output_item.added', output_index: 0,
        item: { type: 'message', id: 'tiny', role: 'assistant', content: [] },
      },
    ].map((item) => `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`).join(''))
  })
  const port = await listen(upstream)
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-short-secret',
    config: {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'tiny',
      model: 'native-model', agentProtocol: 'openai', wireApi: 'responses', toolUseMode: 'on',
    },
    maxRetries: 0,
  })
  const request = requestBody()
  const binding = bindRequest(request, created.snapshot)
  const gateway = new CodexModelGateway({
    bearerToken: 'local-token',
    authority: { async resolve(input) { input.validate(binding); return binding } },
    credentials: { resolve() { return 'tiny' } },
  })
  const address = await gateway.start()
  try {
    const response = await fetch(`${address.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    const output = await response.text()
    assert.match(output, /event: response\.created/)
    assert.match(output, /event: response\.failed/)
    assert.match(output, /gateway_provider_credential_in_identity/)
    assert.doesNotMatch(output, /"id":"tiny"/)
  } finally {
    await gateway.stop()
    await close(upstream)
  }
})

test('native and Chat streams enforce pre-terminal bounds without waiting for EOF after terminal', async () => {
  let mode: 'event' | 'bytes' | 'open_after_terminal' = 'event'
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const created = {
      type: 'response.created',
      response: { id: 'bounded-1', model: 'native-model', status: 'in_progress', output: [] },
    }
    const completed = {
      type: 'response.completed',
      response: {
        id: 'bounded-1', model: 'native-model', status: 'completed', output: [],
        usage: nativeUsage(),
      },
    }
    response.write(`event: response.created\ndata: ${JSON.stringify(created)}\n\n`)
    if (mode === 'event') {
      response.write(`event: response.in_progress\ndata: ${JSON.stringify({
        type: 'response.in_progress',
        response: {
          id: 'bounded-1', model: 'native-model', status: 'in_progress', output: [],
        },
      })}\n\n`)
    }
    if (mode === 'bytes') {
      response.write(`event: response.in_progress\ndata: ${JSON.stringify({
        type: 'response.in_progress',
        response: {
          id: 'bounded-1', model: 'native-model', status: 'in_progress',
          output: [], padding: 'x'.repeat(512),
        },
      })}\n\n`)
    }
    response.write(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`)
    if (mode !== 'open_after_terminal') response.end()
  })
  const port = await listen(upstream)
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-native-bounds',
    config: {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'secret',
      model: 'native-model', agentProtocol: 'openai', wireApi: 'responses', toolUseMode: 'on',
    },
    maxRetries: 0,
  })
  const request = requestBody()
  const binding = bindRequest(request, created.snapshot)
  const call = async (options: {
    nativeMaxBytes?: number
    nativeMaxEvents?: number
    eventIdleMs?: number
  }) => {
    const gateway = new CodexModelGateway({
      bearerToken: 'local-token',
      ...options,
      authority: { async resolve(input) { input.validate(binding); return binding } },
      credentials: { resolve() { return 'secret' } },
    })
    const address = await gateway.start()
    try {
      const response = await fetch(`${address.url}/v1/responses`, {
        method: 'POST',
        headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
      return await response.text()
    } finally {
      await gateway.stop()
    }
  }
  try {
    assert.match(await call({ nativeMaxEvents: 1 }), /gateway_native_event_limit_exceeded/)
    mode = 'bytes'
    assert.match(await call({ nativeMaxBytes: 256 }), /gateway_native_stream_too_large/)
    mode = 'open_after_terminal'
    const postTerminal = await call({ eventIdleMs: 1_000 })
    assert.match(postTerminal, /event: response\.completed/)
    assert.doesNotMatch(postTerminal, /gateway_native_post_terminal_timeout/)

    const encoder = new TextEncoder()
    const hangingChat = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          model: 'qwen-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\ndata: ${JSON.stringify({
          model: 'qwen-model', choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })}\n\ndata: [DONE]\n\n`))
      },
    })
    const chatSnapshot = createCodexUpstreamProfileSnapshot({
      profileId: 'chat-bounds',
      config: {
        provider: 'openai-compatible', baseUrl: 'https://provider.example/v1', apiKey: 'secret',
        model: 'qwen-model', agentProtocol: 'openai', wireApi: 'chat/completions', toolUseMode: 'on',
      },
      maxRetries: 0,
    }).snapshot
    let chatOutput = ''
    await streamChatAsResponses({
      body: hangingChat,
      write(chunk) { chatOutput += chunk },
      allowedToolNames: new Set(),
      toolArgumentValidators: toolArgumentValidators([]),
      snapshot: chatSnapshot,
      credential: 'secret',
      abort() {},
      eventIdleMs: 1_000,
    })
    assert.match(chatOutput, /event: response\.completed/)
    assert.doesNotMatch(chatOutput, /gateway_chat_post_terminal_timeout/)

    let truncatedChatOutput = ''
    await streamChatAsResponses({
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.of(0xe2))
          controller.close()
        },
      }),
      write(chunk) { truncatedChatOutput += chunk },
      allowedToolNames: new Set(),
      toolArgumentValidators: toolArgumentValidators([]),
      snapshot: chatSnapshot,
      credential: 'secret',
      abort() {},
    })
    assert.match(truncatedChatOutput, /gateway_chat_sse_utf8_invalid/)
    assert.doesNotMatch(truncatedChatOutput, /event: response\.completed/)

    let deadlineOutput = ''
    await streamChatAsResponses({
      body: new ReadableStream<Uint8Array>({ start() {} }),
      write(chunk) { deadlineOutput += chunk },
      allowedToolNames: new Set(),
      toolArgumentValidators: toolArgumentValidators([]),
      snapshot: chatSnapshot,
      credential: 'secret',
      abort() {},
      eventIdleMs: 20,
    })
    assert.match(deadlineOutput, /gateway_chat_event_idle_timeout/)
  } finally {
    await close(upstream)
  }
})

test('long native text deltas do not trip the structural event cap', async () => {
  const text = '字'.repeat(5_000)
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const created = {
      type: 'response.created',
      response: { id: 'long-1', model: 'native-model', status: 'in_progress', output: [] },
    }
    const events: JsonObject[] = [
      created,
      {
        type: 'response.output_item.added', output_index: 0,
        item: { type: 'message', id: 'long-message', role: 'assistant', content: [] },
      },
    ]
    for (let index = 0; index < 5_000; index += 1) {
      events.push({
        type: 'response.output_text.delta', output_index: 0, content_index: 0,
        item_id: 'long-message', delta: '字',
      })
    }
    events.push(
      {
        type: 'response.output_text.done', output_index: 0, content_index: 0,
        item_id: 'long-message', text,
      },
      {
        type: 'response.output_item.done', output_index: 0,
        item: {
          type: 'message', id: 'long-message', role: 'assistant',
          content: [{ type: 'output_text', text }],
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'long-1', model: 'native-model', status: 'completed',
          output: [{
            type: 'message', id: 'long-message', role: 'assistant',
            content: [{ type: 'output_text', text }],
          }],
          usage: nativeUsage(),
        },
      },
    )
    response.end(events.map((item) => `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`).join(''))
  })
  const port = await listen(upstream)
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-long-delta',
    config: {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'secret',
      model: 'native-model', agentProtocol: 'openai', wireApi: 'responses', toolUseMode: 'on',
    },
    maxRetries: 0,
  })
  const request = requestBody()
  const binding = bindRequest(request, created.snapshot)
  const gateway = new CodexModelGateway({
    bearerToken: 'local-token',
    nativeMaxEvents: 16,
    authority: { async resolve(input) { input.validate(binding); return binding } },
    credentials: { resolve() { return 'secret' } },
  })
  const address = await gateway.start()
  try {
    const response = await fetch(`${address.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    const body = await response.text()
    assert.doesNotMatch(body, /gateway_native_event_limit_exceeded/)
    assert.match(body, /event: response\.completed/)
  } finally {
    await gateway.stop()
    await close(upstream)
  }
})

test('validated native function argument deltas are coalesced before downstream delivery', async () => {
  const argumentsText = JSON.stringify({ query: 'a'.repeat(4_988) })
  assert.equal(argumentsText.length, 5_000)
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const item = {
      type: 'function_call', id: 'long-tool', call_id: 'long-call',
      name: 'ready_read_probe', arguments: argumentsText,
    }
    const events: JsonObject[] = [
      {
        type: 'response.created',
        response: { id: 'long-tool-response', model: 'native-model', status: 'in_progress' },
      },
      {
        type: 'response.output_item.added', output_index: 0,
        item: { ...item, arguments: '' },
      },
      ...[...argumentsText].map((delta) => ({
        type: 'response.function_call_arguments.delta', output_index: 0,
        item_id: 'long-tool', delta,
      })),
      {
        type: 'response.function_call_arguments.done', output_index: 0,
        item_id: 'long-tool', arguments: argumentsText,
      },
      { type: 'response.output_item.done', output_index: 0, item },
      {
        type: 'response.completed',
        response: {
          id: 'long-tool-response', model: 'native-model', status: 'completed',
          output: [item], usage: nativeUsage(),
        },
      },
    ]
    response.end(events.map((event) => (
      `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
    )).join(''))
  })
  const port = await listen(upstream)
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-long-tool-delta',
    config: {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'secret',
      model: 'native-model', agentProtocol: 'openai', wireApi: 'responses', toolUseMode: 'on',
    },
    maxRetries: 0,
  })
  const request = requestBody(['ready_read_probe'])
  const binding = bindRequest(request, created.snapshot)
  let admittedCalls: readonly CodexModelGatewayToolResponseCall[] = []
  const gateway = new CodexModelGateway({
    bearerToken: 'local-token',
    nativeMaxEvents: 16,
    authority: {
      async resolve(input) { input.validate(binding); return binding },
      async admitToolResponse(input) { admittedCalls = input.calls },
    },
    credentials: { resolve() { return 'secret' } },
  })
  const address = await gateway.start()
  try {
    const response = await fetch(`${address.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    const body = await response.text()
    const events = body.split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as JsonObject)
    const deltas = events.filter((event) => (
      event.type === 'response.function_call_arguments.delta'
    ))
    assert.equal(deltas.length, 1)
    assert.equal(deltas[0]?.delta, argumentsText)
    assert.deepEqual(admittedCalls, [{
      codexCallId: 'long-call',
      toolName: 'ready_read_probe',
      argsDigest: digestCanonicalJson({ query: 'a'.repeat(4_988) }),
    }])
    assert.equal(events.filter((event) => event.type === 'response.completed').length, 1)
  } finally {
    await gateway.stop()
    await close(upstream)
  }
})

test('Chat and native lanes deliver a text delta before the upstream terminal event', async () => {
  for (const wireApi of ['chat/completions', 'responses'] as const) {
    let releaseUpstream: (() => void) | null = null
    const released = new Promise<void>((resolve) => { releaseUpstream = resolve })
    let upstreamEnded = false
    const upstream = createServer(async (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (wireApi === 'chat/completions') {
        response.write(`data: ${JSON.stringify({
          model: 'stream-model', choices: [{ index: 0, delta: { content: 'early-delta' } }],
        })}\n\n`)
      } else {
        const earlyEvents = [
          {
            type: 'response.created',
            response: { id: 'stream-native', model: 'stream-model', status: 'in_progress', output: [] },
          },
          {
            type: 'response.output_item.added', output_index: 0,
            item: { type: 'message', id: 'stream-message', role: 'assistant', content: [] },
          },
          {
            type: 'response.output_text.delta', output_index: 0, content_index: 0,
            item_id: 'stream-message', delta: 'early-delta',
          },
        ]
        response.write(earlyEvents.map((item) => (
          `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`
        )).join(''))
      }
      await released
      if (wireApi === 'chat/completions') {
        response.end([
          `data: ${JSON.stringify({
            model: 'stream-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          })}`,
          `data: ${JSON.stringify({
            model: 'stream-model', choices: [],
            usage: {
              prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
              prompt_tokens_details: { cached_tokens: 0 },
              completion_tokens_details: { reasoning_tokens: 0 },
            },
          })}`,
          'data: [DONE]',
          '',
        ].join('\n\n'))
      } else {
        const finalItem = {
          type: 'message', id: 'stream-message', role: 'assistant',
          content: [{ type: 'output_text', text: 'early-delta' }],
        }
        const finalEvents = [
          {
            type: 'response.output_text.done', output_index: 0, content_index: 0,
            item_id: 'stream-message', text: 'early-delta',
          },
          { type: 'response.output_item.done', output_index: 0, item: finalItem },
          {
            type: 'response.completed',
            response: {
              id: 'stream-native', model: 'stream-model', status: 'completed', output: [finalItem],
              usage: nativeUsage(),
            },
          },
        ]
        response.end(finalEvents.map((item) => (
          `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`
        )).join(''))
      }
      upstreamEnded = true
    })
    const port = await listen(upstream)
    const created = createCodexUpstreamProfileSnapshot({
      profileId: `profile-stream-${wireApi}`,
      config: {
        provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'secret',
        model: 'stream-model', agentProtocol: 'openai', wireApi, toolUseMode: 'on',
      },
      maxRetries: 0,
    })
    const request = requestBody()
    const binding = bindRequest(request, created.snapshot)
    const gateway = new CodexModelGateway({
      bearerToken: 'local-token',
      authority: { async resolve(input) { input.validate(binding); return binding } },
      credentials: { resolve() { return 'secret' } },
    })
    const address = await gateway.start()
    try {
      const response = await fetch(`${address.url}/v1/responses`, {
        method: 'POST',
        headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
      assert.equal(response.status, 200)
      assert.ok(response.body)
      const reader = response.body.getReader()
      let output = await readUntil(
        reader,
        (value) => value.includes('response.output_text.delta') && value.includes('early-delta'),
      )
      assert.equal(upstreamEnded, false)
      releaseUpstream?.()
      output = await readUntil(reader, (value) => value.includes('response.completed'), output)
      output = await readUntil(reader, () => false, output)
      assert.equal(upstreamEnded, true)
      assert.equal((output.match(/event: response\.completed/g) || []).length, 1)
    } finally {
      releaseUpstream?.()
      await gateway.stop()
      await close(upstream)
    }
  }
})

test('Chat and native SSE reject invalid UTF-8 without completing', async () => {
  const chatSnapshot = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-chat-utf8',
    config: {
      provider: 'openai-compatible', baseUrl: 'https://provider.example/v1', apiKey: 'secret',
      model: 'chat-model', agentProtocol: 'openai', wireApi: 'chat/completions', toolUseMode: 'on',
    },
    maxRetries: 0,
  }).snapshot
  const chatPrefix = Buffer.from(
    'data: {"model":"chat-model","choices":[{"index":0,"delta":{"content":"',
  )
  const chatSuffix = Buffer.from('"}}]}\n\n')
  let chatOutput = ''
  await streamChatAsResponses({
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.concat([chatPrefix, Buffer.from([0xff]), chatSuffix]))
        controller.close()
      },
    }),
    write(chunk) { chatOutput += chunk },
    allowedToolNames: new Set(),
    toolArgumentValidators: toolArgumentValidators([]),
    snapshot: chatSnapshot,
    credential: 'secret',
    abort() {},
  })
  assert.match(chatOutput, /gateway_chat_sse_utf8_invalid/)
  assert.doesNotMatch(chatOutput, /response\.completed/)

  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const prefix = Buffer.from(
      'event: response.created\ndata: {"type":"response.created","response":{"id":"utf8-native","model":"native-model","status":"in_progress","output":[]}}\n\n'
      + 'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"utf8-message","role":"assistant","content":[{"type":"output_text","text":"',
    )
    response.end(Buffer.concat([prefix, Buffer.from([0xff]), Buffer.from('"}]}}\n\n')]))
  })
  const port = await listen(upstream)
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-native-utf8',
    config: {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'secret',
      model: 'native-model', agentProtocol: 'openai', wireApi: 'responses', toolUseMode: 'on',
    },
    maxRetries: 0,
  })
  const request = requestBody()
  const binding = bindRequest(request, created.snapshot)
  const gateway = new CodexModelGateway({
    bearerToken: 'local-token',
    authority: { async resolve(input) { input.validate(binding); return binding } },
    credentials: { resolve() { return 'secret' } },
  })
  const address = await gateway.start()
  try {
    const response = await fetch(`${address.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    const nativeOutput = await response.text()
    assert.match(nativeOutput, /gateway_native_sse_utf8_invalid/)
    assert.doesNotMatch(nativeOutput, /response\.completed/)
  } finally {
    await gateway.stop()
    await close(upstream)
  }
})

test('upstream headers and error bodies have hard deadlines and do not retry', async () => {
  for (const mode of ['headers', 'error-body'] as const) {
    let calls = 0
    const upstream = createServer((_request, response) => {
      calls += 1
      if (mode === 'error-body') {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.write('{"error":{"message":"partial')
      }
    })
    const port = await listen(upstream)
    const created = createCodexUpstreamProfileSnapshot({
      profileId: `profile-${mode}-deadline`,
      config: {
        provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'secret',
        model: 'native-model', agentProtocol: 'openai', wireApi: 'responses', toolUseMode: 'on',
      },
      maxRetries: 0,
    })
    const request = requestBody()
    const binding = bindRequest(request, created.snapshot)
    const gateway = new CodexModelGateway({
      bearerToken: 'local-token', headersDeadlineMs: 20, firstByteDeadlineMs: 20,
      authority: { async resolve(input) { input.validate(binding); return binding } },
      credentials: { resolve() { return 'secret' } },
    })
    const address = await gateway.start()
    const startedAt = Date.now()
    try {
      const response = await fetch(`${address.url}/v1/responses`, {
        method: 'POST',
        headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
      const body = await response.text()
      assert.equal(response.status, mode === 'headers' ? 504 : 502)
      assert.match(body, new RegExp(
        mode === 'headers'
          ? 'gateway_upstream_headers_deadline'
          : 'gateway_upstream_error_body_deadline',
      ))
      assert.ok(Date.now() - startedAt < 1_000)
      assert.equal(calls, 1)
    } finally {
      await gateway.stop()
      upstream.closeAllConnections()
      await close(upstream)
    }
  }
})

test('provider errors preserve safe diagnostics and retry headers without leaking credentials', async () => {
  let calls = 0
  let leakHeaders = false
  const upstream = createServer((_request, response) => {
    calls += 1
    response.writeHead(422, {
      'content-type': 'application/json',
      'x-request-id': leakHeaders ? 'upstream-secret' : 'request-safe-1',
      'retry-after': leakHeaders ? 'Bearer upstream-secret' : '7',
    })
    response.end(JSON.stringify({
      error: {
        code: 'invalid_parameter', type: 'invalid_request_error',
        message: 'provider rejected Bearer "other-token" and Bearer upstream-secret and upstream-secret',
        ignored: 'must-not-cross',
      },
      secret_extension: 'must-not-cross',
    }))
  })
  const port = await listen(upstream)
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-error',
    config: {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'upstream-secret', model: 'native-model', agentProtocol: 'openai',
      wireApi: 'responses', toolUseMode: 'on',
    },
    maxRetries: 2,
  })
  const request = requestBody()
  const binding = bindRequest(request, created.snapshot)
  const gateway = new CodexModelGateway({
    bearerToken: 'local-token',
    authority: { async resolve(input) { input.validate(binding); return binding } },
    credentials: { resolve() { return 'upstream-secret' } },
  })
  const address = await gateway.start()
  try {
    const result = await fetch(`${address.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    assert.equal(result.status, 422)
    assert.equal(result.headers.get('x-ready-upstream-request-id'), 'request-safe-1')
    assert.equal(result.headers.get('retry-after'), '7')
    const body = await result.text()
    assert.match(body, /invalid_parameter/)
    assert.match(body, /invalid_request_error/)
    assert.match(body, /\[REDACTED\]/)
    assert.doesNotMatch(body, /upstream-secret|other-token|must-not-cross/)

    leakHeaders = true
    const leaked = await fetch(`${address.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    assert.equal(leaked.status, 422)
    assert.equal(leaked.headers.get('x-ready-upstream-request-id'), null)
    assert.equal(leaked.headers.get('retry-after'), null)
    assert.doesNotMatch(await leaked.text(), /upstream-secret|must-not-cross/)
    assert.equal(calls, 2)
  } finally {
    await gateway.stop()
    await close(upstream)
  }
})

test('stopping during credential resolution prevents all later upstream requests and forbids restart', async () => {
  let upstreamCalls = 0
  const upstream = createServer((_request, response) => {
    upstreamCalls += 1
    response.writeHead(500).end()
  })
  const port = await listen(upstream)
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-stop',
    config: {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'secret',
      model: 'native-model', agentProtocol: 'openai', wireApi: 'responses', toolUseMode: 'on',
    },
    maxRetries: 0,
  })
  const request = requestBody()
  const binding = bindRequest(request, created.snapshot)
  let credentialEnteredResolve: (() => void) | null = null
  const credentialEntered = new Promise<void>((resolve) => { credentialEnteredResolve = resolve })
  let releaseCredentialResolve: (() => void) | null = null
  const releaseCredential = new Promise<void>((resolve) => { releaseCredentialResolve = resolve })
  const gateway = new CodexModelGateway({
    bearerToken: 'local-token',
    authority: { async resolve(input) { input.validate(binding); return binding } },
    credentials: {
      async resolve() {
        credentialEnteredResolve?.()
        await releaseCredential
        return 'secret'
      },
    },
  })
  const address = await gateway.start()
  try {
    const pending = fetch(`${address.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    await credentialEntered
    const stopping = gateway.stop()
    releaseCredentialResolve?.()
    await stopping
    await assert.rejects(pending)
    assert.equal(upstreamCalls, 0)
    await assert.rejects(gateway.start(), /gateway_already_started/)
  } finally {
    releaseCredentialResolve?.()
    await gateway.stop()
    await close(upstream)
  }
})

test('start and stop racing cannot resurrect a listener', async () => {
  const gateway = new CodexModelGateway({
    bearerToken: 'local-token',
    authority: { async resolve() { throw new Error('unused') } },
    credentials: { resolve() { return 'unused' } },
  })
  const starting = gateway.start()
  const stopping = gateway.stop()
  await assert.rejects(starting, /gateway_stopped/)
  await stopping
  await assert.rejects(gateway.start(), /gateway_already_started/)
})

// Native 0.149.0 emits application entries before untrusted entries, even when the
// builder inserts the tail first. The latter therefore sits between Retry and B.
const deliveredTailFixture = [0, 1].map((index) => ({
  contract: 'ready_uncommitted_user_tail_v2' as const, readyRunId: 'run-1',
  originUserMessageId: `earlier-${index}`,
  input: [{ type: 'text' as const, text: `earlier user input ${index}`, text_elements: [] }],
  inputDigest: digestCanonicalJson([{ type: 'text', text: `earlier user input ${index}`, text_elements: [] }]),
}))
function nativeTailMessage(index: number, payload = deliveredTailFixture[index]) {
  return { type: 'message', role: 'user', content: [{ type: 'input_text',
    text: `<external_ready-uncommitted-user-tail:${index}>${JSON.stringify(payload)}</external_ready-uncommitted-user-tail:${index}>` }] }
}
const nativeRetryMessage = { type: 'message', role: 'developer', content: [{ type: 'input_text',
  text: '<ready-explicit-retry>{"predecessorRunId":"current-predecessor"}</ready-explicit-retry>' }] }
const nativeCurrentUser = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'current B' }] }

test('current Retry context crosses only its exact frozen delivered user tail', () => {
  const parsed = currentTurnReadyAdditionalContext([
    nativeRetryMessage, ...deliveredTailFixture.map((_, index) => nativeTailMessage(index)), nativeCurrentUser,
  ], deliveredTailFixture, 'run-1')
  assert.deepEqual(parsed, { resourceReferences: [], explicitRetry: { predecessorRunId: 'current-predecessor' }, readyMemory: null, documentWidgetGuidance: null, currentUserIndex: 3, readyMemoryIndex: null })
})

test('current tail rejects changed content, digest, identity, role, key, order, count and mixed messages', () => {
  const first = nativeTailMessage(0)
  const second = nativeTailMessage(1)
  const mutations = [
    [], [first], [first, first, second], [second, first],
    [nativeTailMessage(0, { ...deliveredTailFixture[0], originUserMessageId: 'foreign' }), second],
    [nativeTailMessage(0, { ...deliveredTailFixture[0], readyRunId: 'older-run' }), second],
    [nativeTailMessage(0, { ...deliveredTailFixture[0], inputDigest: 'f'.repeat(64) }), second],
    [nativeTailMessage(0, { ...deliveredTailFixture[0], input: [{ type: 'text', text: 'changed', text_elements: [] }] }), second],
    [{ ...first, role: 'developer' }, second],
    [{ ...first, role: 'assistant' }, second],
    [{ ...first, injected: 'extra' }, second],
    [{ ...first, id: 1 }, second],
    [{ ...first, content: [{ ...first.content[0], injected: 'extra' }] }, second],
    [{ ...first, content: [first.content[0], { type: 'input_image', image_url: 'hidden' }] }, second],
    [first, nativeCurrentUser, second],
    [first, { ...nativeCurrentUser, role: 'assistant' }, second],
    [first, nativeRetryMessage, second],
    [nativeTailMessage(7, deliveredTailFixture[0]), second],
    [{ ...first, content: [...first.content, { type: 'input_text', text: 'extra instructions' }] }, second],
  ]
  for (const tail of mutations) assert.throws(() => currentTurnReadyAdditionalContext([
    nativeRetryMessage, ...tail, nativeCurrentUser,
  ], deliveredTailFixture, 'run-1'), /gateway_uncommitted_user_tail_mismatch/)
  assert.throws(() => currentTurnReadyAdditionalContext([nativeRetryMessage, first, nativeCurrentUser], [], 'run-1'),
    /gateway_uncommitted_user_tail_mismatch/)
})

test('historical tails do not satisfy current expected delivery or resurrect a historical Retry receipt', () => {
  const history = [nativeRetryMessage, nativeTailMessage(0), nativeCurrentUser,
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'old answer' }] }]
  assert.deepEqual(currentTurnReadyAdditionalContext([...history, nativeCurrentUser], [], 'run-1'),
    { resourceReferences: [], explicitRetry: null, readyMemory: null, documentWidgetGuidance: null, currentUserIndex: 4, readyMemoryIndex: null })
  assert.throws(() => currentTurnReadyAdditionalContext([...history, nativeCurrentUser], [deliveredTailFixture[0]], 'run-1'),
    /gateway_uncommitted_user_tail_mismatch/)
})


test('delivered tail cannot occupy the current user slot even when its preceding copy satisfies the tail count', () => {
  const first = nativeTailMessage(0)
  assert.throws(() => currentTurnReadyAdditionalContext([nativeRetryMessage, first, first], [deliveredTailFixture[0]], 'run-1'),
    /gateway_uncommitted_user_tail_mismatch/)
  assert.throws(() => currentTurnReadyAdditionalContext([nativeRetryMessage, first], [], 'run-1'),
    /gateway_uncommitted_user_tail_mismatch/)
  assert.equal(currentTurnReadyAdditionalContext([nativeRetryMessage, { ...first, id: 'native-optional-id' }, nativeCurrentUser],
    [deliveredTailFixture[0]], 'run-1').explicitRetry?.predecessorRunId, 'current-predecessor')
})

test('Gateway forwards exact multi-tail Retry and rejects missing, altered and current-slot tails before receipts or upstream bytes', async () => {
  let upstreamCalls = 0
  let preparedReceipts = 0
  const upstream = createServer((_request, response) => { upstreamCalls += 1; response.writeHead(500).end() })
  const port = await listen(upstream)
  const created = createCodexUpstreamProfileSnapshot({ profileId: 'tail-gateway', config: {
    provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'fixture-secret',
    model: 'native-model', agentProtocol: 'openai', wireApi: 'responses', toolUseMode: 'on',
  }, maxRetries: 0 })
  const request = requestBody()
  request.input = [nativeRetryMessage, nativeTailMessage(0), nativeTailMessage(1), nativeCurrentUser]
  const binding = bindRequest(request, created.snapshot)
  binding.deliveredUserTail = deliveredTailFixture
  binding.additionalContextDigest = digestReadyAdditionalContext({ resourceReferences: [], explicitRetry: { predecessorRunId: 'current-predecessor' } })
  const gateway = new CodexModelGateway({ bearerToken: 'local-token',
    authority: { async resolve(input) { input.validate(binding); input.prepareRequestReceipt(); preparedReceipts += 1; return binding } },
    credentials: { resolve() { return 'fixture-secret' } },
  })
  const address = await gateway.start()
  const send = async (input: unknown[]) => {
    const response = await fetch(`${address.url}/v1/responses`, { method: 'POST',
      headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' }, body: JSON.stringify({ ...request, input }) })
    await response.text()
    return response.status
  }
  try {
    assert.equal(await send(request.input as unknown[]), 500, 'fixture upstream rejects after accepted Gateway handoff')
    assert.equal(upstreamCalls, 1)
    assert.equal(preparedReceipts, 1)
    for (const input of [
      [nativeRetryMessage, nativeCurrentUser],
      [nativeRetryMessage, nativeTailMessage(0, { ...deliveredTailFixture[0], originUserMessageId: 'foreign' }), nativeTailMessage(1), nativeCurrentUser],
      [nativeRetryMessage, nativeTailMessage(0), nativeTailMessage(1), nativeTailMessage(1)],
    ]) {
      assert.equal(await send(input), 409)
      assert.equal(upstreamCalls, 1)
      assert.equal(preparedReceipts, 1)
    }
  } finally { await gateway.stop(); await close(upstream) }
})
