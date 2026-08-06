const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')
const { spawn } = require('node:child_process')
const {
  assert,
  assetRoot,
  digestJson,
  readJson,
  repoRoot,
  sha256
} = require('./contract-lib.cjs')

const gatewayToken = 'e0-short-lived-gateway-token'
const applicationContextFixture = process.argv.includes('--application-context')
const resourceContextKind = applicationContextFixture ? 'application' : 'untrusted'
const thinOverlay = [
  'Ready provides the dynamic product tools declared for this thread.',
  'Treat successful tool responses as the authority for external effects.',
  'Never claim an external effect without a successful tool response.'
].join(' ')

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address()))
  })
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve))
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function sse(events) {
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('')
}

function responseCreated(responseId) {
  return { type: 'response.created', response: { id: responseId } }
}

function responseCompleted(responseId) {
  return {
    type: 'response.completed',
    response: {
      id: responseId,
      usage: {
        input_tokens: 12,
        input_tokens_details: null,
        output_tokens: 4,
        output_tokens_details: null,
        total_tokens: 16
      }
    }
  }
}

function messageEvents(responseId, messageId, text, options = {}) {
  const phase = options.phase ?? 'final_answer'
  const deltaCut = Math.max(1, Math.floor(text.length / 2))
  const deltas = [text.slice(0, deltaCut), text.slice(deltaCut)].filter(Boolean)
  return [
    responseCreated(responseId),
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        type: 'message',
        role: 'assistant',
        id: messageId,
        phase,
        content: []
      }
    },
    ...deltas.map((delta) => ({
      type: 'response.output_text.delta',
      output_index: 0,
      content_index: 0,
      item_id: messageId,
      delta
    })),
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        role: 'assistant',
        id: messageId,
        phase,
        content: [{ type: 'output_text', text }]
      }
    },
    responseCompleted(responseId)
  ]
}

function commentaryAndFinalEvents(responseId, sequence) {
  return [
    responseCreated(responseId),
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        role: 'assistant',
        id: `commentary-${sequence}`,
        phase: 'commentary',
        content: [{ type: 'output_text', text: `working-${sequence}` }]
      }
    },
    ...messageEvents(responseId, `final-${sequence}`, `answer-${sequence}`).slice(1, -1),
    responseCompleted(responseId)
  ]
}

function functionCallEvents(responseId, callId) {
  return [
    responseCreated(responseId),
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'function_call',
        call_id: callId,
        name: 'ready_read_probe',
        arguments: JSON.stringify({ query: 'contract' })
      }
    },
    responseCompleted(responseId)
  ]
}

function flattenText(value, output = []) {
  if (typeof value === 'string') output.push(value)
  else if (Array.isArray(value)) value.forEach((entry) => flattenText(entry, output))
  else if (value && typeof value === 'object') Object.values(value).forEach((entry) => flattenText(entry, output))
  return output
}

function requestSummary(body) {
  const text = flattenText(body).join('\n')
  const tools = Array.isArray(body.tools) ? body.tools : []
  const occurrences = (value) => text.split(value).length - 1
  return {
    rawBodySha256: digestJson(body),
    keys: Object.keys(body).sort(),
    model: body.model ?? null,
    instructionsSha256: typeof body.instructions === 'string' ? sha256(body.instructions) : null,
    instructionsLength: typeof body.instructions === 'string' ? body.instructions.length : null,
    instructionsPrefix: typeof body.instructions === 'string' ? body.instructions.slice(0, 160) : null,
    toolNames: tools.map((tool) => tool.name || tool.type || null),
    toolDefinitionsSha256: digestJson(tools),
    inputSha256: digestJson(body.input ?? null),
    inputContains: {
      firstUser: text.includes('FIRST_USER_TOKEN'),
      secondUser: text.includes('SECOND_USER_TOKEN'),
      resourceV1: text.includes('RESOURCE_V1'),
      resourceV2: text.includes('RESOURCE_V2'),
      callTool: text.includes('CALL_TOOL_TOKEN'),
      toolResult: text.includes('READY_TOOL_RESULT'),
      emptySuccessorContext: text.includes('EMPTY_SUCCESSOR_CONTEXT'),
      concurrentA: text.includes('CONCURRENT_A'),
      concurrentB: text.includes('CONCURRENT_B')
    },
    inputOccurrenceCounts: {
      firstUser: occurrences('FIRST_USER_TOKEN'),
      secondUser: occurrences('SECOND_USER_TOKEN'),
      resourceV1: occurrences('RESOURCE_V1'),
      resourceV2: occurrences('RESOURCE_V2')
    },
    clientMetadata: body.client_metadata ?? null,
    store: body.store ?? null,
    stream: body.stream ?? null
  }
}

function buildConfig(baseUrl) {
  return [
    'model = "ready-e0-model"',
    'model_provider = "ready_gateway"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'web_search = "disabled"',
    'include_permissions_instructions = false',
    'include_apps_instructions = false',
    'include_collaboration_mode_instructions = false',
    'include_environment_context = false',
    'check_for_update_on_startup = false',
    '',
    '[analytics]',
    'enabled = false',
    '',
    '[model_providers.ready_gateway]',
    'name = "Ready E0 Gateway"',
    `base_url = "${baseUrl}"`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    `experimental_bearer_token = "${gatewayToken}"`,
    'request_max_retries = 0',
    'stream_max_retries = 0',
    'supports_websockets = false',
    '',
    '[tools.experimental_request_user_input]',
    'enabled = false',
    '',
    '[tools.update_plan]',
    'enabled = false',
    '',
    '[agents]',
    'enabled = false',
    '',
    '[skills]',
    'include_instructions = false',
    '',
    '[orchestrator.skills]',
    'enabled = false',
    '',
    '[features]',
    'multi_agent = false',
    'multi_agent_v2 = false',
    'goals = false',
    'apps = false',
    'plugins = false',
    'skill_search = false',
    ''
  ].join('\n')
}

class JsonLineClient {
  constructor(child) {
    this.child = child
    this.frames = []
    this.waiters = []
    this.nextId = 1
    this.stderr = []
    this.serverRequests = []
    const lines = readline.createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        this._rejectAll(new Error(`Non-JSON stdout: ${line}`))
        return
      }
      this.frames.push(frame)
      if (frame.method === 'item/tool/call' && frame.id !== undefined) {
        this.serverRequests.push(frame)
        this.write({
          id: frame.id,
          result: {
            contentItems: [{ type: 'inputText', text: 'READY_TOOL_RESULT' }],
            success: true
          }
        })
      }
      this._resolveWaiters(frame)
    })
    child.stderr.on('data', (chunk) => this.stderr.push(String(chunk)))
    child.on('exit', (code, signal) => {
      if (code !== 0 && signal !== 'SIGTERM') {
        this._rejectAll(new Error(`app-server exited code=${code} signal=${signal}: ${this.stderr.join('')}`))
      }
    })
  }

  write(frame) {
    this.child.stdin.write(`${JSON.stringify(frame)}\n`)
  }

  request(method, params, timeoutMs = 15000) {
    const id = this.nextId
    this.nextId += 1
    const response = this.waitFor((frame) => frame.id === id, timeoutMs)
    this.write({ method, id, params })
    return response.then((frame) => {
      if (frame.error) throw new Error(`${method} failed: ${JSON.stringify(frame.error)}`)
      return frame.result
    })
  }

  notify(method, params) {
    this.write(params === undefined ? { method } : { method, params })
  }

  waitFor(predicate, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error(`Timed out waiting for app-server frame. stderr=${this.stderr.join('')}`))
      }, timeoutMs)
      this.waiters.push({
        predicate,
        resolve: (frame) => {
          clearTimeout(timeout)
          resolve(frame)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        }
      })
    })
  }

  _resolveWaiters(frame) {
    const ready = this.waiters.filter((waiter) => waiter.predicate(frame))
    this.waiters = this.waiters.filter((waiter) => !ready.includes(waiter))
    ready.forEach((waiter) => waiter.resolve(frame))
  }

  _rejectAll(error) {
    const waiters = this.waiters.splice(0)
    waiters.forEach((waiter) => waiter.reject(error))
  }
}

function turnCompleted(frame, turnId) {
  return frame.method === 'turn/completed' && frame.params?.turn?.id === turnId
}

async function startTurn(client, params) {
  const result = await client.request('turn/start', params)
  const terminal = await client.waitFor((frame) => turnCompleted(frame, result.turn.id), 20000)
  return { start: result, terminal }
}

async function run() {
  const sourceLock = readJson(path.join(assetRoot, 'source-lock.json'))
  const runtimeManifest = readJson(path.join(assetRoot, 'runtime-manifest.json'))
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-codex-e0-native-'))
  const home = path.join(tempRoot, 'home')
  const codexHome = path.join(tempRoot, 'codex-home')
  const stateDir = path.join(tempRoot, 'state')
  const threadCwdA = path.join(stateDir, 'threads', 'binding-a')
  const threadCwdB = path.join(stateDir, 'threads', 'binding-b')
  for (const directory of [home, codexHome, stateDir, threadCwdA, threadCwdB]) {
    fs.mkdirSync(directory, { recursive: true })
  }

  const captures = []
  let activeProviderRequests = 0
  let maxConcurrentProviderRequests = 0
  let sequence = 0
  const server = http.createServer(async (request, response) => {
    const startedAt = Date.now()
    activeProviderRequests += 1
    maxConcurrentProviderRequests = Math.max(maxConcurrentProviderRequests, activeProviderRequests)
    try {
      const raw = await readBody(request)
      const body = JSON.parse(raw)
      sequence += 1
      const text = flattenText(body).join('\n')
      const containsToolOutput = text.includes('READY_TOOL_RESULT')
      const capture = {
        sequence,
        method: request.method,
        path: request.url,
        authorizationPresent: typeof request.headers.authorization === 'string',
        authorizationValueStored: false,
        request: body,
        summary: requestSummary(body),
        startedAtMs: startedAt,
        completedAtMs: null
      }
      captures.push(capture)

      let events
      if (text.includes('CALL_TOOL_TOKEN') && !containsToolOutput) {
        events = functionCallEvents(`resp-${sequence}`, 'call-ready-probe')
      } else if (sequence === 1) {
        events = commentaryAndFinalEvents(`resp-${sequence}`, sequence)
      } else {
        events = messageEvents(`resp-${sequence}`, `final-${sequence}`, `answer-${sequence}`)
      }
      if (text.includes('CONCURRENT_A') || text.includes('CONCURRENT_B')) {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'x-request-id': `fixture-request-${sequence}`
      })
      response.end(sse(events))
      capture.completedAtMs = Date.now()
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: String(error) }))
    } finally {
      activeProviderRequests -= 1
    }
  })

  const address = await listen(server)
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  fs.writeFileSync(path.join(codexHome, 'config.toml'), buildConfig(baseUrl))

  const binary = path.join(repoRoot, 'build/codex', sourceLock.targetTriple, 'codex')
  const childEnv = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TMPDIR: tempRoot,
    HOME: home,
    CODEX_HOME: codexHome,
    READY_CODEX_GATEWAY_URL: baseUrl,
    READY_CODEX_GATEWAY_TOKEN: gatewayToken,
    READY_CODEX_PROCESS_LEASE_ID: 'e0-lease-1',
    READY_CODEX_SIDECAR_SPAWN_INSTANCE_ID: 'e0-spawn-1',
    READY_CODEX_CONNECTION_EPOCH: '1',
    READY_CODEX_STATE_DIR: stateDir
  }
  const child = spawn(binary, ['app-server', '--stdio', '--strict-config'], {
    cwd: threadCwdA,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const client = new JsonLineClient(child)
  try {
    const initialize = await client.request('initialize', {
      clientInfo: {
        name: 'ready_codex_experiment',
        title: 'Ready Codex E0 Experiment',
        version: '0.0.1'
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false
      }
    })
    client.notify('initialized')

    const dynamicTools = [
      {
        type: 'function',
        name: 'ready_read_probe',
        description: 'Read one deterministic Ready E0 fixture value.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false
        }
      }
    ]
    const threadStartParams = (cwd) => ({
      model: 'ready-e0-model',
      modelProvider: 'ready_gateway',
      allowProviderModelFallback: false,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      cwd,
      runtimeWorkspaceRoots: [],
      environments: [],
      dynamicTools,
      developerInstructions: thinOverlay
    })
    const threadA = await client.request('thread/start', threadStartParams(threadCwdA))
    const threadB = await client.request('thread/start', threadStartParams(threadCwdB))

    const metadata = (run) => ({
      readyRunId: run,
      toolSurfaceDigest: 'e0-tool-surface',
      turnContractDigest: 'e0-turn-contract',
      upstreamProfileSnapshotDigest: 'e0-upstream-profile'
    })
    const first = await startTurn(client, {
      threadId: threadA.thread.id,
      clientUserMessageId: 'ready-message-first',
      input: [{ type: 'text', text: 'FIRST_USER_TOKEN' }],
      additionalContext: {
        ready_resources: { kind: resourceContextKind, value: 'RESOURCE_V1' }
      },
      responsesapiClientMetadata: metadata('ready-run-first')
    })
    const readAfterFirst = await client.request('thread/read', {
      threadId: threadA.thread.id,
      includeTurns: true
    })

    const second = await startTurn(client, {
      threadId: threadA.thread.id,
      clientUserMessageId: 'ready-message-second',
      input: [{ type: 'text', text: 'SECOND_USER_TOKEN' }],
      additionalContext: {
        ready_resources: { kind: resourceContextKind, value: 'RESOURCE_V2' }
      },
      responsesapiClientMetadata: metadata('ready-run-second')
    })
    const readAfterSecond = await client.request('thread/read', {
      threadId: threadA.thread.id,
      includeTurns: true
    })

    let emptySuccessor
    try {
      emptySuccessor = await startTurn(client, {
        threadId: threadA.thread.id,
        clientUserMessageId: 'ready-message-empty-successor',
        input: [],
        additionalContext: {
          ready_continuation: { kind: 'application', value: 'EMPTY_SUCCESSOR_CONTEXT' }
        },
        responsesapiClientMetadata: metadata('ready-run-empty-successor')
      })
    } catch (error) {
      emptySuccessor = { error: String(error) }
    }
    const readAfterEmptySuccessor = await client.request('thread/read', {
      threadId: threadA.thread.id,
      includeTurns: true
    })

    const toolTurn = await startTurn(client, {
      threadId: threadA.thread.id,
      clientUserMessageId: 'ready-message-tool',
      input: [{ type: 'text', text: 'CALL_TOOL_TOKEN' }],
      additionalContext: {},
      responsesapiClientMetadata: metadata('ready-run-tool')
    })

    const concurrentA = startTurn(client, {
      threadId: threadA.thread.id,
      clientUserMessageId: 'ready-message-concurrent-a',
      input: [{ type: 'text', text: 'CONCURRENT_A' }],
      additionalContext: {},
      responsesapiClientMetadata: metadata('ready-run-concurrent-a')
    })
    const concurrentB = startTurn(client, {
      threadId: threadB.thread.id,
      clientUserMessageId: 'ready-message-concurrent-b',
      input: [{ type: 'text', text: 'CONCURRENT_B' }],
      additionalContext: {},
      responsesapiClientMetadata: metadata('ready-run-concurrent-b')
    })
    const concurrencyResults = await Promise.all([concurrentA, concurrentB])

    const compactionItemPromise = client.waitFor(
      (frame) => frame.method === 'item/completed' && frame.params?.item?.type === 'contextCompaction',
      20000
    )
    const compactionTerminalPromise = client.waitFor(
      (frame) => frame.method === 'turn/completed' && frame.params?.threadId === threadA.thread.id,
      20000
    )
    const manualCompactResponse = await client.request('thread/compact/start', {
      threadId: threadA.thread.id
    })
    const manualCompactionItem = await compactionItemPromise
    const manualCompactionTerminal = await compactionTerminalPromise
    const readAfterManualCompaction = await client.request('thread/read', {
      threadId: threadA.thread.id,
      includeTurns: true
    })
    const threadList = await client.request('thread/list', {
      limit: 20,
      cwd: threadCwdA,
      sourceKinds: ['vscode']
    })
    const resume = await client.request('thread/resume', { threadId: threadA.thread.id })

    const allUserClientIds = readAfterEmptySuccessor.thread.turns
      .flatMap((turn) => turn.items)
      .filter((item) => item.type === 'userMessage')
      .map((item) => item.clientId)
    const secondResourceRequest = captures.find(
      (capture) =>
        capture.summary.inputContains.secondUser && capture.summary.inputContains.resourceV2
    )
    const secondResourceMessages = (secondResourceRequest?.request.input || [])
      .filter((item) => {
        const text = JSON.stringify(item)
        return text.includes('RESOURCE_V1') || text.includes('RESOURCE_V2')
      })
      .map((item) => ({ role: item.role, text: flattenText(item).join('\n') }))
    const protocolEvidence = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      runtime: {
        releaseTag: runtimeManifest.releaseTag,
        gitCommit: runtimeManifest.gitCommit,
        codexVersion: runtimeManifest.codexVersion,
        binarySha256: runtimeManifest.binarySha256,
        experimentalSchemaSha256: runtimeManifest.experimentalSchemaSha256,
        resourceContextKind
      },
      initialize: {
        result: initialize,
        clientInfoName: 'ready_codex_experiment'
      },
      childEnvironment: {
        keys: Object.keys(childEnv),
        hostCanaryPresent: false,
        ownershipMarkers: {
          processLeaseId: childEnv.READY_CODEX_PROCESS_LEASE_ID,
          spawnInstanceId: childEnv.READY_CODEX_SIDECAR_SPAWN_INSTANCE_ID,
          connectionEpoch: childEnv.READY_CODEX_CONNECTION_EPOCH,
          stateDir: childEnv.READY_CODEX_STATE_DIR
        }
      },
      threads: {
        first: threadA.thread,
        second: threadB.thread,
        instructionSourcesEmpty: (threadA.instructionSources || []).length === 0,
        rootMetadataValid:
          threadA.thread.sessionId === threadA.thread.id &&
          threadA.thread.parentThreadId == null &&
          threadA.thread.forkedFromId == null,
        list: threadList,
        resume
      },
      turns: {
        first,
        second,
        emptySuccessor,
        toolTurn,
        concurrencyResults,
        userClientIds: allUserClientIds,
        firstClientIdReadback: allUserClientIds.includes('ready-message-first'),
        secondClientIdReadback: allUserClientIds.includes('ready-message-second'),
        emptySuccessorClientIdReadback: allUserClientIds.includes('ready-message-empty-successor')
      },
      resourceReplacement: {
        contextKind: resourceContextKind,
        secondTurnRequestSequence: secondResourceRequest?.sequence ?? null,
        secondTurnMessages: secondResourceMessages,
        oldValuePresent: secondResourceRequest?.summary.inputContains.resourceV1 ?? false,
        newValuePresent: secondResourceRequest?.summary.inputContains.resourceV2 ?? false
      },
      manualCompaction: {
        response: manualCompactResponse,
        item: manualCompactionItem,
        terminal: manualCompactionTerminal,
        readback: readAfterManualCompaction
      },
      provider: {
        requestCount: captures.length,
        maxConcurrentRequests: maxConcurrentProviderRequests,
        requests: captures,
        retryOwnerDecision: {
          pinnedDefaultRequestMaxRetries: 4,
          experimentConfiguredRequestMaxRetries: 0,
          gatewayOwnsRetries: true
        }
      },
      appServer: {
        frames: client.frames,
        dynamicToolServerRequests: client.serverRequests,
        stderrSha256: sha256(client.stderr.join('')),
        stderrContainsGatewayToken: client.stderr.join('').includes(gatewayToken)
      },
      invariants: {
        providerAuthorizationPresent: captures.every((capture) => capture.authorizationPresent),
        providerAuthorizationValueNotStored: captures.every((capture) => !capture.authorizationValueStored),
        appServerStderrDoesNotContainGatewayToken: !client.stderr.join('').includes(gatewayToken),
        nativeBaseInstructionsPresent: captures.every((capture) => capture.summary.instructionsLength > 0),
        secondRequestContainsFirstAndSecondUser:
          secondResourceRequest?.summary.inputOccurrenceCounts.firstUser === 1 &&
          secondResourceRequest?.summary.inputOccurrenceCounts.secondUser === 1,
        resourceV2DoesNotRetainResourceV1InCurrentContext:
          secondResourceRequest?.summary.inputOccurrenceCounts.resourceV2 === 1 &&
          secondResourceRequest?.summary.inputOccurrenceCounts.resourceV1 === 0,
        userClientIdReadback: allUserClientIds.includes('ready-message-first') && allUserClientIds.includes('ready-message-second'),
        nonUserSuccessorIdentitySupported: allUserClientIds.includes('ready-message-empty-successor'),
        dynamicToolRoundTripCount: client.serverRequests.length,
        trueRootConcurrency: maxConcurrentProviderRequests >= 2,
        manualCompactionObserved: manualCompactionItem.params?.item?.type === 'contextCompaction'
      }
    }

    const outputPath = path.join(
      assetRoot,
      applicationContextFixture
        ? 'fixtures/native-protocol-capture-application-context.json'
        : 'fixtures/native-protocol-capture.json'
    )
    if (process.argv.includes('--write')) {
      fs.writeFileSync(outputPath, `${JSON.stringify(protocolEvidence, null, 2)}\n`)
      console.log(outputPath)
    } else {
      console.log(JSON.stringify(protocolEvidence.invariants, null, 2))
    }
    return protocolEvidence
  } finally {
    child.kill('SIGTERM')
    await closeServer(server)
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error.stack || String(error))
  process.exitCode = 1
})
