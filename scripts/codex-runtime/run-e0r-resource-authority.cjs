const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const {
  ResourceAuthorityHost,
  V1_BODY,
  V2_BODY,
  closeServer,
  collectNativeChildTurn,
  finalAgentText,
  flattenText,
  functionCallEvents,
  listen,
  messageEvents,
  readBody,
  readJsonLines,
  reconcileMcpReadBindings,
  requestSummary,
  sha256,
  spawnAppServer,
  sse,
  startTurn
} = require('./e0r-harness-lib.cjs')
const { assetRoot, readJson, repoRoot } = require('./contract-lib.cjs')

const gatewayToken = 'e0r-local-fixture-token'
const fixturePath = path.join(assetRoot, 'fixtures', 'e0r-resource-authority-capture.json')

function tomlString(value) {
  return JSON.stringify(value)
}

function buildConfig(baseUrl, authorityPath, mcpAuditPath) {
  const mcpScript = path.join(repoRoot, 'scripts/codex-runtime/e0r-mcp-resource-server.cjs')
  return [
    'model = "ready-e0r-model"',
    'model_provider = "ready_gateway"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'web_search = "disabled"',
    'include_permissions_instructions = false',
    'include_apps_instructions = false',
    'include_collaboration_mode_instructions = false',
    'include_environment_context = false',
    'check_for_update_on_startup = false',
    'model_auto_compact_token_limit = 1000',
    '',
    '[analytics]',
    'enabled = false',
    '',
    '[model_providers.ready_gateway]',
    'name = "Ready E0-R Gateway"',
    `base_url = ${tomlString(baseUrl)}`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    `experimental_bearer_token = ${tomlString(gatewayToken)}`,
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
    'enabled = true',
    '',
    '[skills]',
    'include_instructions = false',
    '',
    '[orchestrator.skills]',
    'enabled = false',
    '',
    '[features]',
    'multi_agent = true',
    'multi_agent_v2 = true',
    'goals = false',
    'apps = false',
    'plugins = false',
    'skill_search = false',
    '',
    '[mcp_servers.ready_resource]',
    `command = ${tomlString(process.execPath)}`,
    `args = [${tomlString(mcpScript)}]`,
    `env = { E0R_RESOURCE_AUTHORITY_FILE = ${tomlString(authorityPath)}, E0R_MCP_AUDIT_FILE = ${tomlString(mcpAuditPath)} }`,
    'enabled = true',
    'required = true',
    'startup_timeout_sec = 10.0',
    'tool_timeout_sec = 10.0',
    ''
  ].join('\n')
}

function dynamicTools() {
  const versionedInput = {
    type: 'object',
    properties: {
      logicalResourceId: { type: 'string' },
      version: { type: 'string' }
    },
    required: ['logicalResourceId', 'version'],
    additionalProperties: false
  }
  return [
    {
      type: 'function',
      name: 'ready_resource_read',
      description: 'Read a Ready resource only when this exact version is currently authorized.',
      inputSchema: versionedInput
    },
    {
      type: 'function',
      name: 'ready_resource_write_probe',
      description: 'Probe mutation authorization for an exact Ready resource version.',
      inputSchema: {
        ...versionedInput,
        properties: { ...versionedInput.properties, value: { type: 'string' } },
        required: [...versionedInput.required, 'value']
      }
    }
  ]
}

function headersObject(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)])
  )
}

function markerFromText(text) {
  const matches = text.match(/E0R_(?:CASE|CHILD)_[A-Z0-9_]+/g) || []
  return matches.at(-1) || 'E0R_CASE_GENERIC'
}

function hasTool(body, namespace, name) {
  return (body.tools || []).some((tool) => {
    if (namespace === null) return tool.type !== 'namespace' && tool.name === name
    if (tool.type === 'namespace' && tool.name === namespace) {
      return (tool.tools || []).some((nestedTool) => nestedTool.name === name)
    }
    return tool.namespace === namespace && tool.name === name
  })
}

function toolCall(responseId, callId, name, args, namespace = null) {
  return {
    kind: 'tool_call',
    call: { callId, name, namespace, arguments: args },
    events: functionCallEvents(responseId, callId, name, args, namespace)
  }
}

const CHILD_NONE_STALE_NONCE = 'e0r-child-none-stale-read-v1'
const CHILD_NONE_CURRENT_NONCE = 'e0r-child-none-current-read-v2'

function v2ThinReference() {
  return {
    logicalResourceId: 'resource-a',
    currentVersion: 'v2',
    currentDigest: sha256(V2_BODY),
    supersedesVersion: 'v1',
    policyEpoch: 2
  }
}

function routeProviderRequest(body, headers, state, rootThreadIds) {
  const text = flattenText(body).join('\n')
  const turnMetadata = (() => {
    try {
      return JSON.parse(headers['x-codex-turn-metadata'] || '{}')
    } catch {
      return {}
    }
  })()
  const responseId = `e0r-response-${state.sequence}`
  if (turnMetadata.request_kind === 'compaction') {
    return {
      marker: 'E0R_NATIVE_COMPACTION',
      step: 0,
      kind: `compaction_${turnMetadata.compaction?.trigger || 'unknown'}`,
      events: messageEvents(responseId, `e0r-compact-${state.sequence}`, 'E0R_NATIVE_COMPACT_SUMMARY', 200)
    }
  }

  const threadId = headers['thread-id'] || 'unknown-thread'
  const isRoot = rootThreadIds.has(threadId)
  const marker = isRoot
    ? body.client_metadata?.readyCase || markerFromText(text)
    : markerFromText(text)
  const stateKey = `${threadId}:${turnMetadata.turn_id || marker}`
  const step = state.steps.get(stateKey) || 0
  state.steps.set(stateKey, step + 1)

  if (marker.startsWith('E0R_CHILD_NONE_TASK')) {
    const hasMcp = hasTool(body, 'mcp__ready_resource', 'read_current_resource')
    if (step === 0 && hasMcp) {
      return {
        marker,
        step,
        ...toolCall(
          responseId,
          'call-child-none-mcp-stale-read-v1',
          'read_current_resource',
          {
            logicalResourceId: 'resource-a',
            version: 'v1',
            requestNonce: CHILD_NONE_STALE_NONCE
          },
          'mcp__ready_resource'
        )
      }
    }
    if (step === 1 && hasMcp) {
      return {
        marker,
        step,
        ...toolCall(
          responseId,
          'call-child-none-mcp-current-read-v2',
          'read_current_resource',
          {
            logicalResourceId: 'resource-a',
            version: 'v2',
            requestNonce: CHILD_NONE_CURRENT_NONCE
          },
          'mcp__ready_resource'
        )
      }
    }
    return {
      marker,
      step,
      kind: step === 0 ? 'child_no_resource_tool' : 'child_final',
      events: messageEvents(
        responseId,
        `e0r-child-none-final-${state.sequence}`,
        step === 0 ? 'E0R_CHILD_NONE_NO_RESOURCE_TOOL' : V2_BODY
      )
    }
  }

  if (marker.startsWith('E0R_CHILD_ALL_TASK')) {
    const hasDynamic = hasTool(body, null, 'ready_resource_read')
    const hasMcp = hasTool(body, 'mcp__ready_resource', 'read_current_resource')
    if (!hasDynamic && step === 0 && hasMcp) {
      return {
        marker,
        step,
        ...toolCall(
          responseId,
          'call-child-all-mcp-read-v2',
          'read_current_resource',
          { logicalResourceId: 'resource-a', version: 'v2' },
          'mcp__ready_resource'
        )
      }
    }
    if (hasDynamic && step === 0) {
      return {
        marker,
        step,
        ...toolCall(responseId, 'call-child-all-stale-read-v1', 'ready_resource_read', {
          logicalResourceId: 'resource-a',
          version: 'v1'
        })
      }
    }
    if (hasDynamic && step === 1) {
      return {
        marker,
        step,
        ...toolCall(responseId, 'call-child-all-stale-write-v1', 'ready_resource_write_probe', {
          logicalResourceId: 'resource-a',
          version: 'v1',
          value: 'forbidden-child-effect'
        })
      }
    }
    if (hasDynamic && step === 2) {
      return {
        marker,
        step,
        ...toolCall(responseId, 'call-child-all-current-read-v2', 'ready_resource_read', {
          logicalResourceId: 'resource-a',
          version: 'v2'
        })
      }
    }
    if (step === 0 && !hasDynamic && !hasMcp) {
      return {
        marker,
        step,
        kind: 'child_no_resource_tool',
        events: messageEvents(
          responseId,
          `e0r-child-all-no-tool-${state.sequence}`,
          'E0R_CHILD_ALL_NO_RESOURCE_TOOL'
        )
      }
    }
    return {
      marker,
      step,
      kind: 'child_final',
      events: messageEvents(responseId, `e0r-child-all-final-${state.sequence}`, V2_BODY)
    }
  }

  if (marker === 'E0R_CASE_SPAWN_NONE' || marker === 'E0R_CASE_SPAWN_ALL') {
    if (step === 0) {
      const all = marker.endsWith('_ALL')
      return {
        marker,
        step,
        ...toolCall(
          responseId,
          `call-spawn-${all ? 'all' : 'none'}`,
          'spawn_agent',
          {
            message: `${all ? 'E0R_CHILD_ALL_TASK' : 'E0R_CHILD_NONE_TASK'}: verify current resource authority from READY_RESOURCE_REF=${JSON.stringify(v2ThinReference())}.${all ? '' : ` READY_READ_NONCES={"stale":"${CHILD_NONE_STALE_NONCE}","current":"${CHILD_NONE_CURRENT_NONCE}"}.`}`,
            task_name: all ? 'e0r_history' : 'e0r_default',
            fork_turns: all ? 'all' : 'none'
          },
          'collaboration'
        )
      }
    }
    return {
      marker,
      step,
      kind: 'parent_final',
      events: messageEvents(responseId, `e0r-parent-final-${state.sequence}`, 'E0R_SUBAGENT_DISPATCHED')
    }
  }

  if (marker === 'E0R_CASE_AUTO_SEED') {
    return {
      marker,
      step,
      kind: 'auto_seed',
      events: messageEvents(responseId, `e0r-auto-seed-${state.sequence}`, 'E0R_AUTO_SEED_DONE', 330000)
    }
  }

  if (marker === 'E0R_CASE_MISSING_RECEIPT') {
    return {
      marker,
      step,
      kind: 'final_without_read',
      events: messageEvents(responseId, `e0r-missing-receipt-${state.sequence}`, V2_BODY)
    }
  }

  if (marker === 'E0R_CASE_ROOT_V2') {
    if (step === 0) {
      return {
        marker,
        step,
        ...toolCall(responseId, 'call-root-stale-read-v1', 'ready_resource_read', {
          logicalResourceId: 'resource-a',
          version: 'v1'
        })
      }
    }
    if (step === 1) {
      return {
        marker,
        step,
        ...toolCall(responseId, 'call-root-stale-write-v1', 'ready_resource_write_probe', {
          logicalResourceId: 'resource-a',
          version: 'v1',
          value: 'forbidden-root-effect'
        })
      }
    }
    if (step === 2) {
      return {
        marker,
        step,
        ...toolCall(responseId, 'call-root-current-read-v2', 'ready_resource_read', {
          logicalResourceId: 'resource-a',
          version: 'v2'
        })
      }
    }
    return {
      marker,
      step,
      kind: 'root_v2_final',
      events: messageEvents(responseId, `e0r-root-v2-final-${state.sequence}`, V2_BODY)
    }
  }

  const version = marker.endsWith('_V1') ? 'v1' : 'v2'
  if (step === 0) {
    return {
      marker,
      step,
      ...toolCall(responseId, `call-${marker.toLowerCase()}-read-${version}`, 'ready_resource_read', {
        logicalResourceId: 'resource-a',
        version
      })
    }
  }
  return {
    marker,
    step,
    kind: 'resource_final',
    events: messageEvents(
      responseId,
      `e0r-resource-final-${state.sequence}`,
      version === 'v1' ? V1_BODY : V2_BODY
    )
  }
}

function waitUntil(predicate, description, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const value = predicate()
      if (value) {
        clearInterval(timer)
        resolve(value)
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer)
        reject(new Error(`Timed out waiting for ${description}`))
      }
    }, 25)
  })
}

function publicationDecision(turnResult, authority, receipts) {
  const receipt = receipts.find(
    (entry) =>
      entry.threadId === turnResult.threadId &&
      entry.turnId === turnResult.turnId &&
      entry.logicalResourceId === authority.logicalResourceId &&
      entry.version === authority.currentVersion &&
      entry.digest === authority.currentDigest &&
      entry.policyEpoch === authority.policyEpoch
  )
  const containsCurrent = turnResult.finalText?.includes(V2_BODY) === true
  const containsSuperseded = turnResult.finalText?.includes(V1_BODY) === true
  const allowed = Boolean(receipt) && containsCurrent && !containsSuperseded
  return {
    allowed,
    receiptId: receipt?.receiptId || null,
    containsCurrent,
    containsSuperseded,
    canonicalBody: allowed ? turnResult.finalText : null,
    reason: receipt ? (containsCurrent && !containsSuperseded ? 'current_receipt_and_body' : 'candidate_body_invalid') : 'current_receipt_missing'
  }
}

async function initialize(client, name) {
  const result = await client.request('initialize', {
    clientInfo: { name, title: 'Ready Codex E0-R Experiment', version: '0.0.1' },
    capabilities: { experimentalApi: true, requestAttestation: false }
  })
  client.notify('initialized')
  return result
}

async function run() {
  const sourceLock = readJson(path.join(assetRoot, 'source-lock.json'))
  const runtimeManifest = readJson(path.join(assetRoot, 'runtime-manifest.json'))
  const contract = readJson(path.join(assetRoot, 'contracts/e0r-resource-authority-contract.json'))
  const oldReportPath = path.join(
    repoRoot,
    'docs/superpowers/audits/2026-08-06-codex-runtime-e0-failure-report.json'
  )
  const oldReportDigestBefore = sha256(fs.readFileSync(oldReportPath))
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-codex-e0r-'))
  const home = path.join(tempRoot, 'home')
  const codexHome = path.join(tempRoot, 'codex-home')
  const stateDir = path.join(tempRoot, 'state')
  const cwd = path.join(stateDir, 'workspace')
  const authorityPath = path.join(tempRoot, 'resource-authority.json')
  const mcpAuditPath = path.join(tempRoot, 'mcp-audit.ndjson')
  for (const directory of [home, codexHome, stateDir, cwd]) {
    fs.mkdirSync(directory, { recursive: true })
  }
  fs.writeFileSync(mcpAuditPath, '')
  const authority = new ResourceAuthorityHost(authorityPath)

  const captures = []
  const providerState = { sequence: 0, steps: new Map() }
  const rootThreadIds = new Set()
  const provider = http.createServer(async (request, response) => {
    try {
      const body = JSON.parse(await readBody(request))
      providerState.sequence += 1
      const headers = headersObject(request.headers)
      const route = routeProviderRequest(body, headers, providerState, rootThreadIds)
      const capture = {
        sequence: providerState.sequence,
        method: request.method,
        path: request.url,
        authorizationPresent: Boolean(request.headers.authorization),
        summary: requestSummary(body, headers),
        marker: route.marker,
        step: route.step,
        responseKind: route.kind,
        responseToolCall: route.call || null,
        responseText: flattenText(route.events)
          .filter((value) => value.includes('E0R_'))
          .at(-1) || null
      }
      captures.push(capture)
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'x-request-id': `e0r-fixture-${providerState.sequence}`
      })
      response.end(sse(route.events))
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: String(error) }))
    }
  })
  const address = await listen(provider)
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  const configText = buildConfig(baseUrl, authorityPath, mcpAuditPath)
  fs.writeFileSync(path.join(codexHome, 'config.toml'), configText)

  const binary = path.join(repoRoot, 'build/codex', sourceLock.targetTriple, 'codex.exe')
  const baseEnv = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TMPDIR: tempRoot,
    HOME: home,
    CODEX_HOME: codexHome,
    READY_CODEX_GATEWAY_URL: baseUrl,
    READY_CODEX_GATEWAY_TOKEN: gatewayToken,
    READY_CODEX_STATE_DIR: stateDir
  }
  const spawnEnv = (epoch) => ({
    ...baseEnv,
    READY_CODEX_PROCESS_LEASE_ID: `e0r-lease-${epoch}`,
    READY_CODEX_SIDECAR_SPAWN_INSTANCE_ID: `e0r-spawn-${epoch}`,
    READY_CODEX_CONNECTION_EPOCH: String(epoch)
  })
  const starts = (client, epoch) =>
    spawnAppServer(binary, cwd, spawnEnv(epoch), (frame) => authority.handleDynamic(frame))

  let client = starts(null, 1)
  const initializeFirst = await initialize(client, 'ready_codex_e0r_first')
  const threadParams = {
    model: 'ready-e0r-model',
    modelProvider: 'ready_gateway',
    allowProviderModelFallback: false,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    cwd,
    runtimeWorkspaceRoots: [],
    environments: [],
    dynamicTools: dynamicTools(),
    developerInstructions: 'Use only the currently authorized Ready resource read result. Never treat stale history as authority.'
  }
  const threads = {}
  for (const name of ['root', 'resume', 'manual', 'automatic', 'restart', 'hardOld', 'missing']) {
    const started = await client.request('thread/start', threadParams)
    threads[name] = started.thread.id
    rootThreadIds.add(started.thread.id)
  }

  const dispatches = []
  const turnResults = []
  async function dispatch(caseId, threadId, options = {}) {
    const ref = authority.thinRef(options.supersedesVersion || null)
    const additionalContext = options.omitRef
      ? {}
      : { ready_resource_ref: { kind: 'application', value: JSON.stringify(ref) } }
    const metadata = {
      readyCase: caseId,
      readyRunId: `run-${caseId.toLowerCase()}`,
      readyHistoryInjectionCount: '0',
      readyCompactionCount: '0',
      readyModelConversionLayerCount: '1'
    }
    const inputText = `${caseId}: ${options.input || 'read the current resource and answer from it.'}`
    dispatches.push({ caseId, threadId, inputText, additionalContext, metadata })
    const turn = await startTurn(client, {
      threadId,
      clientUserMessageId: `message-${caseId.toLowerCase()}`,
      input: [{ type: 'text', text: inputText }],
      additionalContext,
      responsesapiClientMetadata: metadata
    })
    const read = await client.request('thread/read', { threadId, includeTurns: true })
    const result = {
      caseId,
      threadId,
      turnId: turn.start.turn.id,
      terminalStatus: turn.terminal.params?.turn?.status || null,
      finalText: finalAgentText(read, turn.start.turn.id)
    }
    turnResults.push(result)
    return result
  }

  const v1Cases = [
    ['E0R_CASE_ROOT_V1', 'root'],
    ['E0R_CASE_RESUME_V1', 'resume'],
    ['E0R_CASE_MANUAL_V1', 'manual'],
    ['E0R_CASE_AUTOMATIC_V1', 'automatic'],
    ['E0R_CASE_RESTART_V1', 'restart'],
    ['E0R_CASE_HARD_OLD_V1', 'hardOld']
  ]
  for (const [caseId, name] of v1Cases) await dispatch(caseId, threads[name])
  await dispatch('E0R_CASE_AUTO_SEED', threads.automatic, { omitRef: true })

  authority.setVersion('v2')
  const rootV2 = await dispatch('E0R_CASE_ROOT_V2', threads.root, { supersedesVersion: 'v1' })

  const resumeRead = await client.request('thread/read', {
    threadId: threads.resume,
    includeTurns: true
  })
  const resumeResponse = await client.request('thread/resume', { threadId: threads.resume })
  const resumeV2 = await dispatch('E0R_CASE_RESUME_V2', threads.resume, {
    supersedesVersion: 'v1'
  })

  const manualStartedIndex = client.frames.length
  const manualItem = client.waitFor(
    (frame) =>
      frame.method === 'item/completed' &&
      frame.params?.threadId === threads.manual &&
      frame.params?.item?.type === 'contextCompaction',
    60000
  )
  const manualTerminal = client.waitFor(
    (frame) =>
      frame.method === 'turn/completed' && frame.params?.threadId === threads.manual,
    60000
  )
  const manualResponse = await client.request('thread/compact/start', { threadId: threads.manual })
  const manualCompactionItem = await manualItem
  const manualCompactionTerminal = await manualTerminal
  const manualRead = await client.request('thread/read', {
    threadId: threads.manual,
    includeTurns: true
  })
  const manualV2 = await dispatch('E0R_CASE_MANUAL_V2', threads.manual, {
    supersedesVersion: 'v1'
  })

  const automaticItem = client.waitFor(
    (frame) =>
      frame.method === 'item/completed' &&
      frame.params?.threadId === threads.automatic &&
      frame.params?.item?.type === 'contextCompaction',
    60000
  )
  const automaticV2 = await dispatch('E0R_CASE_AUTOMATIC_V2', threads.automatic, {
    supersedesVersion: 'v1'
  })
  const automaticCompactionItem = await automaticItem
  const automaticRead = await client.request('thread/read', {
    threadId: threads.automatic,
    includeTurns: true
  })

  const missingReceipt = await dispatch('E0R_CASE_MISSING_RECEIPT', threads.missing, {
    supersedesVersion: 'v1'
  })

  const hardNew = await client.request('thread/start', threadParams)
  threads.hardNew = hardNew.thread.id
  rootThreadIds.add(hardNew.thread.id)
  const hardNewV2 = await dispatch('E0R_CASE_HARD_NEW_V2', threads.hardNew, {
    supersedesVersion: 'v1'
  })
  const hardOldRead = await client.request('thread/read', {
    threadId: threads.hardOld,
    includeTurns: true
  })

  await dispatch('E0R_CASE_SPAWN_NONE', threads.root, { supersedesVersion: 'v1' })
  const childNoneFinal = await waitUntil(
    () => captures.find(
      (capture) =>
        capture.marker.startsWith('E0R_CHILD_NONE_TASK') &&
        ['child_final', 'child_no_resource_tool'].includes(capture.responseKind)
    ),
    'no-history child terminal response'
  )
  const childNoneNative = await collectNativeChildTurn(
    client,
    childNoneFinal,
    'E0R_CHILD_NONE_NATIVE'
  )
  turnResults.push({
    caseId: childNoneNative.caseId,
    threadId: childNoneNative.threadId,
    turnId: childNoneNative.turnId,
    terminalStatus: childNoneNative.terminalStatus,
    finalText: childNoneNative.finalText
  })
  await dispatch('E0R_CASE_SPAWN_ALL', threads.root, { supersedesVersion: 'v1' })
  const childAllFinal = await waitUntil(
    () => captures.find(
      (capture) =>
        capture.marker.startsWith('E0R_CHILD_ALL_TASK') &&
        ['child_final', 'child_no_resource_tool'].includes(capture.responseKind)
    ),
    'history child terminal response'
  )
  const childAllNative = await collectNativeChildTurn(
    client,
    childAllFinal,
    'E0R_CHILD_ALL_NATIVE'
  )
  turnResults.push({
    caseId: childAllNative.caseId,
    threadId: childAllNative.threadId,
    turnId: childAllNative.turnId,
    terminalStatus: childAllNative.terminalStatus,
    finalText: childAllNative.finalText
  })

  const framesBeforeRestart = client.frames.length
  const firstExit = await client.stop()
  client = starts(null, 2)
  const initializeSecond = await initialize(client, 'ready_codex_e0r_restart')
  const restartResume = await client.request('thread/resume', { threadId: threads.restart })
  const restartV2 = await dispatch('E0R_CASE_RESTART_V2', threads.restart, {
    supersedesVersion: 'v1'
  })
  const restartRead = await client.request('thread/read', {
    threadId: threads.restart,
    includeTurns: true
  })
  const secondExit = await client.stop()
  await closeServer(provider)

  const mcpAudit = readJsonLines(mcpAuditPath)
  const mcpBindings = reconcileMcpReadBindings(
    mcpAudit,
    childNoneNative,
    captures,
    authority.current
  )
  const mcpReceipts = mcpBindings.map((entry) => entry.receipt).filter(Boolean)
  const receipts = [...authority.receipts, ...mcpReceipts]
  const decisions = Object.fromEntries(
    [rootV2, resumeV2, manualV2, automaticV2, restartV2, hardNewV2, missingReceipt].map(
      (turn) => [turn.caseId, publicationDecision(turn, authority.current, receipts)]
    )
  )
  const rootV2Requests = captures.filter((capture) => capture.marker === 'E0R_CASE_ROOT_V2')
  const hardNewRequests = captures.filter((capture) => capture.marker === 'E0R_CASE_HARD_NEW_V2')
  const childNoneRequests = captures.filter((capture) => capture.marker.startsWith('E0R_CHILD_NONE_TASK'))
  const childAllRequests = captures.filter((capture) => capture.marker.startsWith('E0R_CHILD_ALL_TASK'))
  const childNoneCandidate = {
    threadId: childNoneNative.threadId,
    turnId: childNoneNative.turnId,
    finalText: childNoneNative.finalText
  }
  const childAllCandidate = {
    threadId: childAllNative.threadId,
    turnId: childAllNative.turnId,
    finalText: childAllNative.finalText
  }
  const rolloutFiles = fs
    .readdirSync(path.join(codexHome, 'sessions'), { recursive: true })
    .filter((entry) => String(entry).endsWith('.jsonl'))
    .map(String)
    .sort()
  const hardOldRolloutFiles = rolloutFiles.filter((entry) => entry.includes(threads.hardOld))
  const hardNewRolloutFiles = rolloutFiles.filter((entry) => entry.includes(threads.hardNew))
  const oldReportDigestAfter = sha256(fs.readFileSync(oldReportPath))
  const evidence = {
    schemaVersion: 1,
    phase: 'E0-R',
    capturedAt: new Date().toISOString(),
    runtime: {
      releaseTag: runtimeManifest.releaseTag,
      gitCommit: runtimeManifest.gitCommit,
      codexVersion: runtimeManifest.codexVersion,
      binarySha256: runtimeManifest.binarySha256,
      targetTriple: sourceLock.targetTriple
    },
    experimentBoundary: {
      productCodeChangesAllowed: false,
      costBearingExternalCalls: 0,
      providerEndpointIsLoopback: baseUrl.startsWith('http://127.0.0.1:'),
      readyHistoryInjectionCount: 0,
      readyCompactionCount: 0,
      modelConversionLayerCount: 1,
      compactPromptOverrideCount: (configText.match(/^compact_prompt\s*=/gm) || []).length,
      deterministicProviderLimitation: 'The local provider proves protocol and publication gates, not general model judgment.'
    },
    contract: {
      path: 'assets/codex-runtime/contracts/e0r-resource-authority-contract.json',
      sha256: sha256(JSON.stringify(contract)),
      immutableE0ReportSha256Before: oldReportDigestBefore,
      immutableE0ReportSha256After: oldReportDigestAfter
    },
    initialize: { first: initializeFirst, afterRestart: initializeSecond },
    authority: {
      final: authority.current,
      dynamicAudit: authority.audit,
      effects: authority.effects,
      receipts,
      mcpAudit,
      mcpBindings
    },
    dispatches,
    turnResults,
    publicationDecisions: decisions,
    provider: {
      requestCount: captures.length,
      captures,
      rootV2Visibility: {
        requestCount: rootV2Requests.length,
        priorV1BodyVisible: rootV2Requests.some((entry) => entry.summary.inputContains.v1Body),
        currentV2BodyVisibleAfterRead: rootV2Requests.some((entry) => entry.summary.inputContains.v2Body),
        candidateContainsOnlyV2: rootV2.finalText === V2_BODY
      }
    },
    continuity: {
      sameThread: { threadId: threads.root, v1Case: 'E0R_CASE_ROOT_V1', v2Case: rootV2.caseId },
      readThenResume: {
        threadId: threads.resume,
        readThreadId: resumeRead.thread.id,
        resumedThreadId: resumeResponse.thread.id,
        v2TurnId: resumeV2.turnId
      },
      manualCompaction: {
        requestFrameIndex: manualStartedIndex,
        threadId: threads.manual,
        response: manualResponse,
        notification: manualCompactionItem.params,
        item: manualCompactionItem.params?.item,
        terminalStatus: manualCompactionTerminal.params?.turn?.status || null,
        providerRequests: captures.filter(
          (entry) =>
            entry.responseKind === 'compaction_manual' &&
            entry.summary.threadId === threads.manual &&
            entry.summary.turnMetadata?.turn_id ===
              manualCompactionItem.params?.turnId
        ),
        readbackThreadId: manualRead.thread.id,
        readbackTurn: manualRead.thread.turns
          .filter((turn) => turn.id === manualCompactionItem.params?.turnId)
          .map((turn) => ({
            id: turn.id,
            status: turn.status,
            itemTypes: turn.items.map((item) => item.type)
          }))[0] || null,
        v2TurnId: manualV2.turnId
      },
      automaticCompaction: {
        threadId: threads.automatic,
        notification: automaticCompactionItem.params,
        item: automaticCompactionItem.params?.item,
        providerRequests: captures.filter(
          (entry) =>
            entry.responseKind === 'compaction_auto' &&
            entry.summary.threadId === threads.automatic &&
            entry.summary.turnMetadata?.turn_id === automaticV2.turnId
        ),
        readbackThreadId: automaticRead.thread.id,
        readbackTurn: automaticRead.thread.turns
          .filter((turn) => turn.id === automaticV2.turnId)
          .map((turn) => ({
            id: turn.id,
            status: turn.status,
            itemIds: turn.items.map((item) => item.id),
            itemTypes: turn.items.map((item) => item.type)
          }))[0] || null,
        controlledTokenLimit: 1000,
        v2TurnId: automaticV2.turnId
      },
      processRestart: {
        framesBeforeRestart,
        firstExit,
        secondExit,
        originalThreadId: threads.restart,
        resumedThreadId: restartResume.thread.id,
        readbackThreadId: restartRead.thread.id,
        readbackTurn: restartRead.thread.turns
          .filter((turn) => turn.id === restartV2.turnId)
          .map((turn) => ({
            id: turn.id,
            status: turn.status,
            finalText:
              turn.items
                .filter((item) => item.type === 'agentMessage')
                .at(-1)?.text || null
          }))[0] || null,
        v2TurnId: restartV2.turnId
      }
    },
    agents: {
      root: {
        threadId: threads.root,
        dynamicReadAvailable: rootV2Requests.some((entry) =>
          entry.summary.toolSurface.some((tool) => tool.name === 'ready_resource_read')
        ),
        publication: decisions.E0R_CASE_ROOT_V2
      },
      noHistoryChild: {
        threadId: childNoneFinal.summary.threadId,
        dynamicReadAvailable: childNoneRequests.some((entry) =>
          entry.summary.toolSurface.some((tool) => tool.name === 'ready_resource_read')
        ),
        mcpReadAvailable: childNoneRequests.some((entry) =>
          entry.summary.toolSurface.some(
            (tool) => tool.namespace === 'mcp__ready_resource' && tool.name === 'read_current_resource'
          )
        ),
        mutationToolAvailable: childNoneRequests.some((entry) =>
          entry.summary.toolSurface.some((tool) => tool.name === 'ready_resource_write_probe')
        ),
        finalText: childNoneNative.finalText,
        native: childNoneNative,
        publication: publicationDecision(childNoneCandidate, authority.current, receipts)
      },
      historyChild: {
        threadId: childAllFinal.summary.threadId,
        dynamicReadAvailable: childAllRequests.some((entry) =>
          entry.summary.toolSurface.some((tool) => tool.name === 'ready_resource_read')
        ),
        mcpReadAvailable: childAllRequests.some((entry) =>
          entry.summary.toolSurface.some(
            (tool) => tool.namespace === 'mcp__ready_resource' && tool.name === 'read_current_resource'
          )
        ),
        mutationToolAvailable: childAllRequests.some((entry) =>
          entry.summary.toolSurface.some((tool) => tool.name === 'ready_resource_write_probe')
        ),
        finalText: childAllNative.finalText,
        native: childAllNative,
        publication: publicationDecision(childAllCandidate, authority.current, receipts)
      }
    },
    hardIsolation: {
      oldThreadId: threads.hardOld,
      newThreadId: threads.hardNew,
      explicitNewThread: threads.hardOld !== threads.hardNew,
      newThreadProviderSawV1Body: hardNewRequests.some((entry) => entry.summary.inputContains.v1Body),
      oldReadbackThreadId: hardOldRead.thread.id,
      oldReadbackContainsV1: hardOldRead.thread.turns.some((turn) =>
        turn.items.some((item) => item.type === 'agentMessage' && item.text === V1_BODY)
      ),
      oldReadbackTurn: hardOldRead.thread.turns
        .filter(
          (turn) =>
            turn.id ===
            turnResults.find((entry) => entry.caseId === 'E0R_CASE_HARD_OLD_V1')
              ?.turnId
        )
        .map((turn) => ({
          id: turn.id,
          status: turn.status,
          finalText:
            turn.items
              .filter((item) => item.type === 'agentMessage')
              .at(-1)?.text || null
        }))[0] || null,
      oldRolloutFiles: hardOldRolloutFiles,
      newRolloutFiles: hardNewRolloutFiles,
      oldRolloutStillOnDisk: hardOldRolloutFiles.length > 0,
      rolloutFileCount: rolloutFiles.length,
      claim: 'New thread isolates future model context; it does not delete the old rollout.'
    }
  }
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true })
  fs.writeFileSync(fixturePath, `${JSON.stringify(evidence, null, 2)}\n`)
  process.stdout.write(`${fixturePath}\n`)
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exitCode = 1
})
