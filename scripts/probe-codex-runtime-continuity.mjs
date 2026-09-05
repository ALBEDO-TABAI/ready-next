import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'

const sourceDigests = process.argv.slice(2)
const databasePath = process.env.READY_CONTINUITY_DB_PATH
const sourceCodexHome = process.env.READY_CONTINUITY_CODEX_HOME
const binaryPath = process.env.READY_CONTINUITY_CODEX_BINARY
  || join(process.cwd(), 'build/codex/aarch64-apple-darwin/codex')

if (!databasePath || !sourceCodexHome || sourceDigests.length === 0) {
  throw new Error('usage: READY_CONTINUITY_DB_PATH=... READY_CONTINUITY_CODEX_HOME=... node scripts/probe-codex-runtime-continuity.mjs <source-manifest>...')
}
if (!existsSync(binaryPath)) throw new Error('continuity_probe_binary_missing')
if (!sourceDigests.every((digest) => /^[a-f0-9]{64}$/.test(digest))) {
  throw new Error('continuity_probe_source_digest_invalid')
}

const root = mkdtempSync(join(tmpdir(), 'ready-runtime-continuity-probe-'))
const codexHome = join(root, 'codex-home')
const workRoot = join(root, 'work')
mkdirSync(codexHome, { recursive: true, mode: 0o700 })
mkdirSync(workRoot, { recursive: true, mode: 0o700 })

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function usage(inputTokens) {
  return {
    input_tokens: inputTokens,
    output_tokens: 4,
    total_tokens: inputTokens + 4,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  }
}

function messageEvents(text) {
  const identity = randomUUID().replaceAll('-', '')
  const item = {
    type: 'message',
    id: `message-${identity}`,
    role: 'assistant',
    phase: 'final_answer',
    content: [{ type: 'output_text', text }],
  }
  const responseId = `response-${identity}`
  return [
    { type: 'response.created', response: { id: responseId, model: 'ready-e0-model', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: text },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: item.id, text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: {
      id: responseId, model: 'ready-e0-model', status: 'completed', output: [item], usage: usage(12),
    } },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

async function startProvider() {
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(messageEvents('READY_RUNTIME_CONTINUITY_OK'))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function copyRuntimeHistory() {
  for (const directory of ['sessions', 'archived_sessions']) {
    const source = join(sourceCodexHome, directory)
    if (existsSync(source)) cpSync(source, join(codexHome, directory), { recursive: true })
  }
  for (const file of ['state_5.sqlite', 'installation_id', '.sandbox_migration']) {
    const source = join(sourceCodexHome, file)
    if (existsSync(source)) cpSync(source, join(codexHome, file))
  }
  const copiedState = join(codexHome, 'state_5.sqlite')
  const state = new DatabaseSync(copiedState)
  try {
    state.prepare(`UPDATE threads SET rollout_path = replace(rollout_path, ?, ?)`)
      .run(sourceCodexHome, codexHome)
    const escapedSource = sourceCodexHome.replaceAll('\\', '\\\\')
      .replaceAll('%', '\\%').replaceAll('_', '\\_')
    const leaked = state.prepare(`
      SELECT 1 AS present FROM threads
       WHERE rollout_path LIKE ? ESCAPE '\\' LIMIT 1
    `).get(`${escapedSource}%`)
    if (leaked) throw new Error('continuity_probe_rollout_path_not_isolated')
  } finally {
    state.close()
  }
}

function writeConfig(baseUrl) {
  writeFileSync(join(codexHome, 'config.toml'), [
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
    'name = "Ready Model Gateway"',
    `base_url = "${baseUrl}"`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'experimental_bearer_token = "continuity-probe"',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    'supports_websockets = false',
    '',
    '[features]',
    'multi_agent = false',
    'multi_agent_v2 = false',
    'goals = false',
    'apps = false',
    'plugins = false',
    'skill_search = false',
    'memories = false',
    '',
    '[memories]',
    'generate_memories = false',
    'use_memories = false',
    '',
  ].join('\n'), { mode: 0o600 })
}

function selectHeads() {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    db.exec('PRAGMA query_only=ON')
    return sourceDigests.map((sourceManifestDigest) => {
      const row = db.prepare(`
        SELECT codex_thread_id, isolated_thread_cwd
          FROM codex_thread_bindings
         WHERE codex_thread_id IS NOT NULL AND runtime_manifest_digest = ?
         ORDER BY CASE WHEN retired_at IS NULL THEN 0 ELSE 1 END,
                  alias_generation DESC LIMIT 1
      `).get(sourceManifestDigest)
      if (!row?.codex_thread_id || !row.isolated_thread_cwd) {
        throw new Error(`continuity_probe_active_head_missing:${sourceManifestDigest}`)
      }
      return {
        sourceManifestDigest,
        threadId: row.codex_thread_id,
        cwd: row.isolated_thread_cwd,
      }
    })
  } finally {
    db.close()
  }
}

function unarchiveProbeHeads(heads) {
  for (const head of heads) {
    execFileSync(binaryPath, ['unarchive', head.threadId], {
      cwd: workRoot,
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        TMPDIR: root,
        HOME: root,
        CODEX_HOME: codexHome,
      },
      stdio: 'ignore',
    })
  }
}

function startClient() {
  const child = spawn(binaryPath, ['app-server', '--stdio', '--strict-config'], {
    cwd: workRoot,
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TMPDIR: root,
      HOME: root,
      CODEX_HOME: codexHome,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stderr = []
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
  const pending = new Map()
  const notifications = []
  const waiters = new Set()
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    const frame = JSON.parse(line)
    if (typeof frame.id === 'number') {
      const waiter = pending.get(frame.id)
      if (!waiter) return
      pending.delete(frame.id)
      if (frame.error) waiter.reject(new Error(JSON.stringify(frame.error)))
      else waiter.resolve(frame.result)
      return
    }
    notifications.push(frame)
    for (const wake of waiters) wake()
    waiters.clear()
  })
  let nextId = 0
  const request = (method, params) => {
    nextId += 1
    return new Promise((resolve, reject) => {
      pending.set(nextId, { resolve, reject })
      child.stdin.write(`${JSON.stringify({ method, id: nextId, params })}\n`)
    })
  }
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ method, params })}\n`)
  const waitFor = async (predicate, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs
    while (true) {
      const found = notifications.find(predicate)
      if (found) return found
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`continuity_probe_notification_timeout:${stderr.join('')}`)
      await new Promise((resolve, reject) => {
        const wake = () => { clearTimeout(timer); waiters.delete(wake); resolve() }
        const timer = setTimeout(() => { waiters.delete(wake); reject(new Error('continuity_probe_notification_timeout')) }, remaining)
        waiters.add(wake)
      })
    }
  }
  return {
    child,
    request,
    notify,
    waitFor,
    close: async () => {
      lines.close()
      child.kill('SIGTERM')
      await new Promise((resolve) => child.once('exit', resolve))
    },
  }
}

function lastHistoricalUserText(turns) {
  for (const turn of [...turns].reverse()) {
    for (const item of [...(turn.items || [])].reverse()) {
      if (item.type !== 'userMessage') continue
      const text = (item.content || []).filter((entry) => entry.type === 'text')
        .map((entry) => entry.text).join('\n').trim()
      if (text) return text
    }
  }
  return null
}

async function startAndCompleteTurn(client, input) {
  const started = await client.request('turn/start', {
    threadId: input.threadId,
    clientUserMessageId: `message-${input.readyRunId}`,
    collaborationMode: {
      mode: 'default',
      settings: { model: 'ready-e0-model', reasoning_effort: null, developer_instructions: null },
    },
    environments: [],
    input: [{ type: 'text', text: input.marker, text_elements: [] }],
    additionalContext: input.additionalContext || {},
    responsesapiClientMetadata: {
      readyRunId: input.readyRunId,
      toolSurfaceDigest: createHash('sha256').update('[]').digest('hex'),
      turnContractDigest: createHash('sha256').update(input.readyRunId).digest('hex'),
      upstreamProfileSnapshotDigest: createHash('sha256').update('continuity-profile').digest('hex'),
    },
  })
  const turnId = started?.turn?.id
  if (!turnId) throw new Error('continuity_probe_turn_not_accepted')
  await client.waitFor((frame) => frame.method === 'turn/completed'
    && frame.params?.threadId === input.threadId
    && frame.params?.turn?.id === turnId)
  return turnId
}

async function initializeClient(client) {
  await client.request('initialize', {
    clientInfo: { name: 'ready_runtime_continuity_probe', title: 'Ready Runtime Continuity Probe', version: '1' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  })
  client.notify('initialized')
}

async function probeHead(client, provider, head, ordinal) {
  const before = await client.request('thread/read', { threadId: head.threadId, includeTurns: true })
  const beforeTurns = before?.thread?.turns
  if (!Array.isArray(beforeTurns) || beforeTurns.length === 0) throw new Error('continuity_probe_history_missing')
  const priorUserText = lastHistoricalUserText(beforeTurns)
  if (!priorUserText) throw new Error('continuity_probe_historical_user_input_missing')
  const resumed = await client.request('thread/resume', { threadId: head.threadId })
  if (resumed?.thread?.id !== head.threadId) throw new Error('continuity_probe_resume_identity_mismatch')
  const marker = `READY_RUNTIME_CONTINUITY_${ordinal}_${randomUUID()}`
  const readyRunId = `continuity-probe-${ordinal}-${randomUUID()}`
  const requestOffset = provider.requests.length
  await startAndCompleteTurn(client, { threadId: head.threadId, marker, readyRunId })
  const ordinaryRequest = provider.requests[requestOffset]
  if (!JSON.stringify(ordinaryRequest?.input || null).includes(priorUserText)) {
    throw new Error('continuity_probe_prior_context_missing')
  }
  const after = await client.request('thread/read', { threadId: head.threadId, includeTurns: true })
  const afterTurns = after?.thread?.turns
  if (!Array.isArray(afterTurns) || afterTurns.length !== beforeTurns.length + 1) {
    throw new Error('continuity_probe_turn_readback_mismatch')
  }
  const markerCount = JSON.stringify(afterTurns.at(-1)).split(marker).length - 1
  if (markerCount !== 1) throw new Error('continuity_probe_input_cardinality_mismatch')

  const lastTurnId = beforeTurns.at(-1)?.id
  const forked = await client.request('thread/fork', {
    threadId: head.threadId,
    lastTurnId,
    cwd: head.cwd,
    model: 'ready-e0-model',
    modelProvider: 'ready_gateway',
    approvalPolicy: 'never',
    sandbox: 'read-only',
  })
  if (!forked?.thread?.id || forked.thread.id === head.threadId
    || forked.thread.forkedFromId !== head.threadId
    || forked.thread.turns?.at(-1)?.id !== lastTurnId) {
    throw new Error('continuity_probe_fork_readback_mismatch')
  }
  const reseedCwd = join(workRoot, `reseed-${ordinal}`)
  mkdirSync(reseedCwd, { recursive: true, mode: 0o700 })
  const reseeded = await client.request('thread/start', {
    model: 'ready-e0-model',
    modelProvider: 'ready_gateway',
    allowProviderModelFallback: false,
    cwd: reseedCwd,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    runtimeWorkspaceRoots: [],
    environments: [],
    config: { model_context_window: 272000 },
    dynamicTools: [],
    developerInstructions: 'Runtime continuity reseed probe.',
  })
  const reseedThreadId = reseeded?.thread?.id
  if (!reseedThreadId || reseeded.thread.turns?.length !== 0) {
    throw new Error('continuity_probe_reseed_root_mismatch')
  }
  const reseedMarker = `READY_RUNTIME_RESEED_CURRENT_${ordinal}_${randomUUID()}`
  const reseedTailMarker = `READY_RUNTIME_RESEED_TAIL_${ordinal}_${randomUUID()}`
  const reseedTail = {
    contract: 'ready_uncommitted_user_tail_v1',
    originUserMessageId: `continuity-reseed-tail-${ordinal}`,
    input: [{ type: 'text', text: reseedTailMarker, text_elements: [] }],
    inputDigest: createHash('sha256').update(reseedTailMarker).digest('hex'),
  }
  const reseedRequestOffset = provider.requests.length
  await startAndCompleteTurn(client, {
    threadId: reseedThreadId,
    marker: reseedMarker,
    readyRunId: `continuity-reseed-${ordinal}-${randomUUID()}`,
    additionalContext: {
      'ready-uncommitted-user-tail:0': {
        kind: 'untrusted',
        value: JSON.stringify(reseedTail),
      },
    },
  })
  const reseedProviderRequest = JSON.stringify(provider.requests[reseedRequestOffset] || null)
  const reseedTailProviderCardinality = reseedProviderRequest.split(reseedTailMarker).length - 1
  const reseedCurrentInputProviderCardinality = reseedProviderRequest.split(reseedMarker).length - 1
  if (reseedTailProviderCardinality !== 1 || reseedCurrentInputProviderCardinality !== 1) {
    throw new Error('continuity_probe_reseed_provider_cardinality_mismatch')
  }
  const reseedReadback = await client.request('thread/read', {
    threadId: reseedThreadId,
    includeTurns: true,
  })
  const reseedHistory = JSON.stringify(reseedReadback?.thread?.turns || [])
  const reseedMarkerCount = reseedHistory.split(reseedMarker).length - 1
  if (reseedMarkerCount !== 1) {
    throw new Error('continuity_probe_reseed_readback_cardinality_mismatch')
  }
  await client.close()
  const restartedClient = startClient()
  await initializeClient(restartedClient)
  const restartedRead = await restartedClient.request('thread/read', {
    threadId: reseedThreadId,
    includeTurns: true,
  })
  if (restartedRead?.thread?.id !== reseedThreadId) {
    throw new Error('continuity_probe_reseed_restart_read_mismatch')
  }
  const restartedResume = await restartedClient.request('thread/resume', { threadId: reseedThreadId })
  if (restartedResume?.thread?.id !== reseedThreadId) {
    throw new Error('continuity_probe_reseed_restart_resume_mismatch')
  }
  const reseedSecondMarker = `READY_RUNTIME_RESEED_SECOND_${ordinal}_${randomUUID()}`
  const secondRequestOffset = provider.requests.length
  await startAndCompleteTurn(restartedClient, {
    threadId: reseedThreadId,
    marker: reseedSecondMarker,
    readyRunId: `continuity-reseed-second-${ordinal}-${randomUUID()}`,
  })
  const secondProviderRequest = JSON.stringify(provider.requests[secondRequestOffset] || null)
  const reseedTailAfterRestartCardinality = secondProviderRequest.split(reseedTailMarker).length - 1
  const reseedFirstInputAfterRestartCardinality = secondProviderRequest.split(reseedMarker).length - 1
  const reseedSecondInputCardinality = secondProviderRequest.split(reseedSecondMarker).length - 1
  if (reseedTailAfterRestartCardinality !== 1
    || reseedFirstInputAfterRestartCardinality !== 1
    || reseedSecondInputCardinality !== 1) {
    throw new Error('continuity_probe_reseed_restart_context_mismatch')
  }
  return { client: restartedClient, result: {
    sourceManifestDigest: head.sourceManifestDigest,
    historyTurnCountBefore: beforeTurns.length,
    historyTurnCountAfter: afterTurns.length,
    ordinaryContinuationAccepted: true,
    priorNativeContextObservedByProvider: true,
    ordinaryContinuationInputCardinality: markerCount,
    forkFromAcceptedPrefixAccepted: true,
    reseedUncommittedTailAccepted: true,
    reseedInputCardinality: reseedMarkerCount,
    reseedTailProviderCardinality,
    reseedCurrentInputProviderCardinality,
    reseedRestartPassed: true,
    reseedTailAfterRestartCardinality,
    reseedFirstInputAfterRestartCardinality,
    reseedSecondInputCardinality,
  } }
}

const provider = await startProvider()
let client
try {
  copyRuntimeHistory()
  writeConfig(provider.baseUrl)
  const heads = selectHeads()
  unarchiveProbeHeads(heads)
  client = startClient()
  await initializeClient(client)
  const results = []
  for (const [index, head] of heads.entries()) {
    const probed = await probeHead(client, provider, head, index + 1)
    client = probed.client
    results.push(probed.result)
  }
  if (provider.requests.length !== heads.length * 3) {
    throw new Error('continuity_probe_provider_request_count_mismatch')
  }
  const version = await new Promise((resolve, reject) => {
    const child = spawn(binaryPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    child.stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    child.once('error', reject)
    child.once('exit', (code) => code === 0
      ? resolve(Buffer.concat(chunks).toString('utf8').trim())
      : reject(new Error('continuity_probe_version_failed')))
  })
  process.stdout.write(`${JSON.stringify({
    contract: 'ready_runtime_continuity_native_probe_v1',
    targetBinarySha256: sha256File(binaryPath),
    targetRuntimeVersion: version,
    isolatedCopy: true,
    __breaksInvariants: ['selected native histories are unarchived only in the isolated copy'],
    providerKind: 'local_fixture',
    results,
  }, null, 2)}\n`)
} finally {
  if (client) await client.close()
  await provider.close()
  rmSync(root, { recursive: true, force: true })
}
