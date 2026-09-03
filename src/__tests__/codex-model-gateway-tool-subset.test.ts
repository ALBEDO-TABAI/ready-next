import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import test from 'node:test'

import {
  createCodexUpstreamProfileSnapshot,
  digestCanonicalJson,
  instructionTranscriptDigest,
  type CodexUpstreamProfileSnapshot,
} from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import {
  CodexModelGateway,
  type CodexModelGatewayBinding,
} from '../main/modules/agent-control/codex-runtime/codex-model-gateway'

type JsonObject = Record<string, unknown>

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

function requestBody(): JsonObject {
  const tools = ['allowed_probe', 'blocked_probe'].map((name) => ({
    type: 'function',
    name,
    description: name,
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
      'x-codex-installation-id': 'installation-subset',
      session_id: 'thread-1',
      'x-codex-window-id': 'thread-1:0',
      turn_id: 'turn-1',
      thread_id: 'thread-1',
      root_turn_id: 'turn-1',
      'x-codex-turn-metadata': JSON.stringify({
        installation_id: 'installation-subset',
        session_id: 'thread-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        root_turn_id: 'turn-1',
        window_id: 'thread-1:0',
        agent_name: '/root',
        auto_review_enabled: false,
        node_repl_auto_review_required: false,
        node_repl_disabled: false,
        request_kind: 'turn',
        sandbox: 'seatbelt',
        sandbox_mode: 'read-only',
        turn_started_at_unix_ms: 1,
        readyRunId: 'run-1',
        toolSurfaceDigest: digestCanonicalJson(tools),
        turnContractDigest: 'turn-contract-1',
        upstreamProfileSnapshotDigest: 'pending',
      }),
    },
  }
}

function bindRequest(
  request: JsonObject,
  snapshot: CodexUpstreamProfileSnapshot,
  allowedToolNames: readonly string[],
): CodexModelGatewayBinding & { allowedToolNames: readonly string[] } {
  const metadata = JSON.parse(
    (request.client_metadata as Record<string, string>)['x-codex-turn-metadata'],
  ) as JsonObject
  metadata.upstreamProfileSnapshotDigest = digestCanonicalJson(snapshot)
  ;(request.client_metadata as Record<string, string>)['x-codex-turn-metadata'] = JSON.stringify(metadata)
  return {
    kind: 'product',
    codexModel: 'ready-e0-model',
    snapshot,
    snapshotDigest: digestCanonicalJson(snapshot),
    toolSurfaceDigest: metadata.toolSurfaceDigest as string,
    turnContractDigest: 'turn-contract-1',
    instructionContractDigest: instructionTranscriptDigest(request.instructions, request.input),
    additionalContextDigest: digestCanonicalJson([]),
    deliveredUserTail: [],
    forceToolFreeFinalization: false,
    allowedToolNames,
  }
}

test('Gateway validates the root surface then forwards only the authorized turn subset', async () => {
  const captured: JsonObject[] = []
  const upstream = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      captured.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonObject)
      response.writeHead(502, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'fixture' } }))
    })
  })
  const port = await listen(upstream)
  const snapshot = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-tool-subset',
    config: {
      provider: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'secret',
      model: 'native-model',
      agentProtocol: 'openai',
      wireApi: 'responses',
      toolUseMode: 'on',
    },
    maxRetries: 0,
  }).snapshot
  const firstRequest = requestBody()
  let binding = bindRequest(firstRequest, snapshot, ['allowed_probe'])
  let credentialCalls = 0
  const gateway = new CodexModelGateway({
    bearerToken: 'local-token',
    authority: { async resolve(input) { input.validate(binding); return binding } },
    credentials: { resolve() { credentialCalls += 1; return 'secret' } },
  })
  const address = await gateway.start()
  const send = async (request: JsonObject) => fetch(`${address.url}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  try {
    const firstResponse = await send(firstRequest)
    assert.equal(captured.length, 1, await firstResponse.text())
    assert.deepEqual((captured[0].tools as JsonObject[]).map((tool) => tool.name), ['allowed_probe'])
    assert.equal(captured[0].tool_choice, 'auto')
    assert.equal(captured[0].parallel_tool_calls, true)

    const emptyRequest = requestBody()
    binding = bindRequest(emptyRequest, snapshot, [])
    await send(emptyRequest)
    assert.deepEqual(captured[1].tools, [])
    assert.equal(captured[1].tool_choice, 'none')
    assert.equal(captured[1].parallel_tool_calls, false)

    const blockedChoice = requestBody()
    blockedChoice.tool_choice = { type: 'function', name: 'blocked_probe' }
    binding = bindRequest(blockedChoice, snapshot, ['allowed_probe'])
    const response = await send(blockedChoice)
    assert.equal(response.status, 409)
    assert.match(await response.text(), /gateway_tool_choice_not_authorized/)
    assert.equal(captured.length, 2)
    assert.equal(credentialCalls, 2)
  } finally {
    await gateway.stop()
    await close(upstream)
  }
})
