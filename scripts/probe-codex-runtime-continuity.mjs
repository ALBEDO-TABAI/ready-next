// Run with tsx: it imports Ready's production config writer, developer instructions and instruction digest.
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'

import {
  digestCanonicalJson,
  instructionTranscriptDigest,
} from '../src/main/modules/agent-control/codex-runtime/codex-model-gateway-contract.ts'
import {
  activateCodexGatewaySpawnConfig,
  prepareCodexRuntimeState,
} from '../src/main/modules/agent-control/codex-runtime/codex-runtime-host.ts'
import { CODEX_HOST_OVERLAY } from '../src/main/modules/agent-control/codex-runtime/codex-thread-instructions.ts'
import { codexRequestToolsDigest } from '../src/main/modules/agent-control/codex-runtime/codex-tool-surface.ts'
import { projectCodexUserInputReadback } from '../src/main/modules/agent-control/codex-runtime/codex-user-input.ts'

const sourceDigests = process.argv.slice(2)
const databasePath = process.env.READY_CONTINUITY_DB_PATH
const sourceCodexHome = process.env.READY_CONTINUITY_CODEX_HOME
const binaryPath = process.env.READY_CONTINUITY_CODEX_BINARY
  || join(process.cwd(), 'build/codex/aarch64-apple-darwin/codex')

if (!databasePath || !sourceCodexHome || sourceDigests.length === 0) {
  throw new Error('usage: READY_CONTINUITY_DB_PATH=... READY_CONTINUITY_CODEX_HOME=... npx tsx scripts/probe-codex-runtime-continuity.mjs <source-manifest>...')
}
if (!existsSync(binaryPath)) throw new Error('continuity_probe_binary_missing')
if (!sourceDigests.every((digest) => /^[a-f0-9]{64}$/.test(digest))) {
  throw new Error('continuity_probe_source_digest_invalid')
}

const contracts = JSON.parse(readFileSync(join(process.cwd(), 'assets/codex-runtime/contracts/runtime-contracts.json'), 'utf8'))
const nativeCapture = JSON.parse(readFileSync(join(process.cwd(), 'assets/codex-runtime/fixtures/native-protocol-capture.json'), 'utf8'))
const developerMessage = { type: 'message', role: 'developer', content: [{ type: 'input_text', text: CODEX_HOST_OVERLAY }] }
// The contract a thread's requests must carry under the pinned runtime: its native base plus Ready's instructions.
const currentInstructionContractDigest = instructionTranscriptDigest(
  nativeCapture.provider.requests[0].request.instructions,
  [developerMessage],
)

const root = mkdtempSync(join(tmpdir(), 'ready-runtime-continuity-probe-'))
const workRoot = join(root, 'work')
mkdirSync(workRoot, { recursive: true, mode: 0o700 })
let state = null

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

function copyRuntimeHistory(codexHome) {
  for (const directory of ['sessions', 'archived_sessions']) {
    const source = join(sourceCodexHome, directory)
    if (existsSync(source)) cpSync(source, join(codexHome, directory), { recursive: true })
  }
  for (const file of ['state_5.sqlite', 'installation_id', '.sandbox_migration']) {
    const source = join(sourceCodexHome, file)
    if (existsSync(source)) cpSync(source, join(codexHome, file))
  }
  const copiedState = new DatabaseSync(join(codexHome, 'state_5.sqlite'))
  try {
    // Stored paths may differ in case from the given home (the volume is case-insensitive); rewrite by prefix and
    // refuse to run while any path still leaves the isolated copy.
    const sourcePrefix = sourceCodexHome.replace(/\/+$/, '').toLowerCase()
    for (const row of copiedState.prepare('SELECT id, rollout_path FROM threads').all()) {
      const path = String(row.rollout_path)
      if (path.toLowerCase().startsWith(`${sourcePrefix}/`)) {
        copiedState.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?')
          .run(`${codexHome}${path.slice(sourcePrefix.length)}`, row.id)
      }
    }
    const leaked = copiedState.prepare('SELECT rollout_path FROM threads').all()
      .filter((row) => !String(row.rollout_path).startsWith(`${codexHome}/`))
    if (leaked.length > 0) throw new Error('continuity_probe_rollout_path_not_isolated')
  } finally {
    copiedState.close()
  }
}

function selectHeads() {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    db.exec('PRAGMA query_only=ON')
    return sourceDigests.map((sourceManifestDigest) => {
      const row = db.prepare(`
        SELECT codex_thread_id, isolated_thread_cwd, instruction_contract_digest, tool_surface_json
          FROM codex_thread_bindings
         WHERE codex_thread_id IS NOT NULL AND runtime_manifest_digest = ?
         ORDER BY CASE WHEN retired_at IS NULL THEN 0 ELSE 1 END,
                  alias_generation DESC LIMIT 1
      `).get(sourceManifestDigest)
      if (!row?.codex_thread_id || !row.isolated_thread_cwd || !row.instruction_contract_digest
        || !row.tool_surface_json) {
        throw new Error(`continuity_probe_active_head_missing:${sourceManifestDigest}`)
      }
      return {
        sourceManifestDigest,
        threadId: row.codex_thread_id,
        cwd: row.isolated_thread_cwd,
        lineageInstructionContractDigest: row.instruction_contract_digest,
        // What the pinned runtime must send for the thread's frozen dynamic tools; Ready's gateway checks this.
        expectedRequestToolsDigest: codexRequestToolsDigest(JSON.parse(row.tool_surface_json)),
      }
    })
  } finally {
    db.close()
  }
}

function childEnvironment() {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TMPDIR: state.tmpDir,
    HOME: state.homeDir,
    CODEX_HOME: state.codexHome,
  }
}

function unarchiveProbeHeads(heads) {
  const copiedState = new DatabaseSync(join(state.codexHome, 'state_5.sqlite'), { readOnly: true })
  const archived = new Set(copiedState.prepare('SELECT id FROM threads WHERE archived = 1').all().map((row) => row.id))
  copiedState.close()
  // 0.160.1 refuses to unarchive a thread that is not archived.
  for (const head of heads.filter((candidate) => archived.has(candidate.threadId))) {
    execFileSync(binaryPath, ['unarchive', head.threadId], { cwd: workRoot, env: childEnvironment(), stdio: 'ignore' })
  }
}

function startClient() {
  const child = spawn(binaryPath, contracts.nativeIsolationConfigContract.launchArgv, {
    cwd: workRoot,
    env: childEnvironment(),
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

// A user message's text in order. Turns recorded by 0.149 read back as one joined text; 0.160.1 keeps the items,
// so a message is identified by its joined text either way.
function lastHistoricalUserText(turns) {
  for (const turn of [...turns].reverse()) {
    for (const item of [...(turn.items || [])].reverse()) {
      if (item.type !== 'userMessage') continue
      const text = (item.content || []).filter((entry) => entry.type === 'text').map((entry) => entry.text).join('')
      if (text.trim()) return text
    }
  }
  return null
}

function requestCarriesUserMessage(request, joinedText) {
  return (request?.input || []).some((item) => item.role === 'user'
    && (item.content || []).map((part) => (typeof part.text === 'string' ? part.text : '')).join('') === joinedText)
}

function turnInput(input) {
  return [{ type: 'text', text: input.marker, text_elements: [] }, ...(input.resources || [])]
}

// A Ready turn carries resources next to the current text; their readback shape depends on the thread's history mode.
function resourceInput(cwd) {
  return [
    { type: 'text', text: 'READY_RUNTIME_RESOURCE_TEXT', text_elements: [] },
    { type: 'mention', name: 'project', path: cwd },
  ]
}

/** The turn's user item must read back as the pinned runtime projects it for this thread's history mode. */
function assertUserInputReadback(thread, turn, input, step) {
  const historyMode = thread.historyMode ?? 'legacy'
  const users = (turn?.items || []).filter((item) => item.type === 'userMessage')
  const expected = projectCodexUserInputReadback(turnInput(input), historyMode)
  if (users.length !== 1 || digestCanonicalJson(users[0].content) !== digestCanonicalJson(expected)) {
    throw new Error(`continuity_probe_user_input_readback_mismatch:${step}:${historyMode}`)
  }
  return historyMode
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
    input: turnInput(input),
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

/** The request tools must be the current runtime's serialization of the thread's frozen dynamic tools. */
function assertRequestTools(request, head, step) {
  if (digestCanonicalJson(request?.tools ?? null) !== head.expectedRequestToolsDigest) {
    throw new Error(`continuity_probe_request_tools_mismatch:${step}`)
  }
}

/** Every request Ready's gateway would see must carry exactly the current instruction contract. */
function assertInstructionContract(request, step) {
  const digest = instructionTranscriptDigest(request?.instructions, request?.input)
  if (digest !== currentInstructionContractDigest) {
    throw new Error(`continuity_probe_instruction_contract_mismatch:${step}`)
  }
}

function markerCount(value, marker) {
  // Compare in JSON form: user text with newlines or quotes is escaped inside the serialized request.
  return JSON.stringify(value ?? null).split(JSON.stringify(marker).slice(1, -1)).length - 1
}

function requestKind(request) {
  return JSON.parse(request?.client_metadata?.['x-codex-turn-metadata'] || '{}').request_kind
}

async function probeHead(client, provider, head, ordinal) {
  const before = await client.request('thread/read', { threadId: head.threadId, includeTurns: true })
  const beforeTurns = before?.thread?.turns
  if (!Array.isArray(beforeTurns) || beforeTurns.length === 0) throw new Error('continuity_probe_history_missing')
  const priorUserText = lastHistoricalUserText(beforeTurns)
  if (!priorUserText) throw new Error('continuity_probe_historical_user_input_missing')

  // ordinary_continuation: resume the way Ready does, with the thread's instructions re-declared.
  const resumed = await client.request('thread/resume', { threadId: head.threadId, developerInstructions: CODEX_HOST_OVERLAY })
  if (resumed?.thread?.id !== head.threadId) throw new Error('continuity_probe_resume_identity_mismatch')
  const marker = `READY_RUNTIME_CONTINUITY_${ordinal}_${randomUUID()}`
  const ordinaryOffset = provider.requests.length
  const ordinaryInput = { threadId: head.threadId, marker, readyRunId: `continuity-probe-${ordinal}-${randomUUID()}`,
    resources: resourceInput(head.cwd) }
  await startAndCompleteTurn(client, ordinaryInput)
  const ordinaryRequest = provider.requests[ordinaryOffset]
  if (requestKind(ordinaryRequest) !== 'turn') throw new Error(`continuity_probe_ordinary_request_kind:${requestKind(ordinaryRequest)}`)
  if (!requestCarriesUserMessage(ordinaryRequest, priorUserText)) throw new Error('continuity_probe_prior_context_missing')
  assertInstructionContract(ordinaryRequest, 'ordinary_continuation')
  assertRequestTools(ordinaryRequest, head, 'ordinary_continuation')
  const after = await client.request('thread/read', { threadId: head.threadId, includeTurns: true })
  const afterTurns = after?.thread?.turns
  if (!Array.isArray(afterTurns) || afterTurns.length !== beforeTurns.length + 1) {
    throw new Error('continuity_probe_turn_readback_mismatch')
  }
  const ordinaryInputCardinality = markerCount(afterTurns.at(-1), marker)
  if (ordinaryInputCardinality !== 1) throw new Error('continuity_probe_input_cardinality_mismatch')
  const historyMode = assertUserInputReadback(after.thread, afterTurns.at(-1), ordinaryInput, 'ordinary_continuation')

  // fork_from_accepted_prefix: fork through the last historical turn, then run a turn on the successor.
  const lastTurnId = beforeTurns.at(-1)?.id
  const forked = await client.request('thread/fork', {
    threadId: head.threadId,
    lastTurnId,
    cwd: head.cwd,
    model: 'ready-e0-model',
    modelProvider: 'ready_gateway',
    approvalPolicy: 'never',
    sandbox: 'read-only',
    developerInstructions: CODEX_HOST_OVERLAY,
  })
  const forkThreadId = forked?.thread?.id
  if (!forkThreadId || forkThreadId === head.threadId
    || forked.thread.forkedFromId !== head.threadId
    || forked.thread.turns?.at(-1)?.id !== lastTurnId) {
    throw new Error('continuity_probe_fork_readback_mismatch')
  }
  const forkMarker = `READY_RUNTIME_FORK_${ordinal}_${randomUUID()}`
  const forkOffset = provider.requests.length
  const forkInput = { threadId: forkThreadId, marker: forkMarker, readyRunId: `continuity-fork-${ordinal}-${randomUUID()}`,
    resources: resourceInput(head.cwd) }
  await startAndCompleteTurn(client, forkInput)
  const forkRead = await client.request('thread/read', { threadId: forkThreadId, includeTurns: true })
  const forkHistoryMode = assertUserInputReadback(forkRead.thread, forkRead.thread.turns.at(-1), forkInput,
    'fork_from_accepted_prefix')
  const forkRequest = provider.requests[forkOffset]
  if (!requestCarriesUserMessage(forkRequest, priorUserText)) throw new Error('continuity_probe_fork_prior_context_missing')
  if (markerCount(forkRequest?.input, marker) !== 0) throw new Error('continuity_probe_fork_leaked_post_prefix_turn')
  assertInstructionContract(forkRequest, 'fork_from_accepted_prefix')
  assertRequestTools(forkRequest, head, 'fork_from_accepted_prefix')
  const forkInputCardinality = markerCount(forkRequest?.input, forkMarker)
  if (forkInputCardinality !== 1) throw new Error('continuity_probe_fork_input_cardinality_mismatch')

  // reseed_uncommitted_tail: a fresh root carrying an untrusted tail, then a restart and a second turn.
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
    developerInstructions: CODEX_HOST_OVERLAY,
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
  const reseedProviderRequest = provider.requests[reseedRequestOffset]
  const reseedTailProviderCardinality = markerCount(reseedProviderRequest, reseedTailMarker)
  const reseedCurrentInputProviderCardinality = markerCount(reseedProviderRequest, reseedMarker)
  if (reseedTailProviderCardinality !== 1 || reseedCurrentInputProviderCardinality !== 1) {
    throw new Error('continuity_probe_reseed_provider_cardinality_mismatch')
  }
  assertInstructionContract(reseedProviderRequest, 'reseed_uncommitted_tail')
  const reseedReadback = await client.request('thread/read', { threadId: reseedThreadId, includeTurns: true })
  const reseedInputCardinality = markerCount(reseedReadback?.thread?.turns || [], reseedMarker)
  if (reseedInputCardinality !== 1) throw new Error('continuity_probe_reseed_readback_cardinality_mismatch')
  await client.close()
  let restartedClient = startClient()
  await initializeClient(restartedClient)
  const restartedRead = await restartedClient.request('thread/read', { threadId: reseedThreadId, includeTurns: true })
  if (restartedRead?.thread?.id !== reseedThreadId) throw new Error('continuity_probe_reseed_restart_read_mismatch')
  const restartedResume = await restartedClient.request('thread/resume', {
    threadId: reseedThreadId,
    developerInstructions: CODEX_HOST_OVERLAY,
  })
  if (restartedResume?.thread?.id !== reseedThreadId) throw new Error('continuity_probe_reseed_restart_resume_mismatch')
  const reseedSecondMarker = `READY_RUNTIME_RESEED_SECOND_${ordinal}_${randomUUID()}`
  const secondRequestOffset = provider.requests.length
  await startAndCompleteTurn(restartedClient, {
    threadId: reseedThreadId,
    marker: reseedSecondMarker,
    readyRunId: `continuity-reseed-second-${ordinal}-${randomUUID()}`,
  })
  const secondProviderRequest = provider.requests[secondRequestOffset]
  const reseedTailAfterRestartCardinality = markerCount(secondProviderRequest, reseedTailMarker)
  const reseedFirstInputAfterRestartCardinality = markerCount(secondProviderRequest, reseedMarker)
  const reseedSecondInputCardinality = markerCount(secondProviderRequest, reseedSecondMarker)
  if (reseedTailAfterRestartCardinality !== 1
    || reseedFirstInputAfterRestartCardinality !== 1
    || reseedSecondInputCardinality !== 1) {
    throw new Error('continuity_probe_reseed_restart_context_mismatch')
  }
  assertInstructionContract(secondProviderRequest, 'reseed_uncommitted_tail_after_restart')

  // manual_compaction: after a restart the source thread is not loaded; resume it the way Ready does, compact it,
  // then continue it so the instructions survive the compacted history.
  const compactResume = await restartedClient.request('thread/resume', { threadId: head.threadId, developerInstructions: CODEX_HOST_OVERLAY })
  if (compactResume?.thread?.id !== head.threadId) throw new Error('continuity_probe_compaction_resume_mismatch')
  const compactionOffset = provider.requests.length
  await restartedClient.request('thread/compact/start', { threadId: head.threadId })
  const compacted = await restartedClient.waitFor((frame) => frame.method === 'turn/completed'
    && frame.params?.threadId === head.threadId
    && provider.requests.length > compactionOffset)
  if (compacted.params?.turn?.status !== 'completed') throw new Error('continuity_probe_compaction_not_completed')
  const compactionRequest = provider.requests[compactionOffset]
  const compactionMetadata = JSON.parse(compactionRequest?.client_metadata?.['x-codex-turn-metadata'] || '{}')
  if (compactionMetadata.request_kind !== 'compaction' || compactionMetadata.compaction?.trigger !== 'manual') {
    throw new Error('continuity_probe_compaction_request_missing')
  }
  assertInstructionContract(compactionRequest, 'manual_compaction')
  const compactedRead = await restartedClient.request('thread/read', { threadId: head.threadId, includeTurns: true })
  const compactionTurn = compactedRead?.thread?.turns?.find((turn) => turn.id === compacted.params.turn.id)
  const compactionItemCount = (compactionTurn?.items || []).filter((item) => item.type === 'contextCompaction').length
  if (compactionItemCount !== 1) throw new Error('continuity_probe_compaction_item_mismatch')
  const postCompactionMarker = `READY_RUNTIME_POST_COMPACTION_${ordinal}_${randomUUID()}`
  const postCompactionOffset = provider.requests.length
  await startAndCompleteTurn(restartedClient, {
    threadId: head.threadId,
    marker: postCompactionMarker,
    readyRunId: `continuity-post-compaction-${ordinal}-${randomUUID()}`,
  })
  const postCompactionRequest = provider.requests[postCompactionOffset]
  assertInstructionContract(postCompactionRequest, 'manual_compaction_successor_turn')
  assertRequestTools(postCompactionRequest, head, 'manual_compaction_successor_turn')
  const postCompactionInputCardinality = markerCount(postCompactionRequest?.input, postCompactionMarker)
  if (postCompactionInputCardinality !== 1) throw new Error('continuity_probe_post_compaction_input_mismatch')

  return { client: restartedClient, result: {
    sourceManifestDigest: head.sourceManifestDigest,
    instructionContract: {
      sourceDigest: head.lineageInstructionContractDigest,
      targetDigest: currentInstructionContractDigest,
    },
    requestToolsDerivedFromFrozenSurface: true,
    userInputReadbackHistoryMode: historyMode,
    forkUserInputReadbackHistoryMode: forkHistoryMode,
    historyTurnCountBefore: beforeTurns.length,
    historyTurnCountAfter: afterTurns.length,
    ordinaryContinuationAccepted: true,
    priorNativeContextObservedByProvider: true,
    ordinaryContinuationInputCardinality: ordinaryInputCardinality,
    forkFromAcceptedPrefixAccepted: true,
    forkPriorContextObservedByProvider: true,
    forkInputCardinality,
    reseedUncommittedTailAccepted: true,
    reseedInputCardinality,
    reseedTailProviderCardinality,
    reseedCurrentInputProviderCardinality,
    reseedRestartPassed: true,
    reseedTailAfterRestartCardinality,
    reseedFirstInputAfterRestartCardinality,
    reseedSecondInputCardinality,
    manualCompactionAccepted: true,
    manualCompactionItemCount: compactionItemCount,
    postCompactionTurnInputCardinality: postCompactionInputCardinality,
  } }
}

const provider = await startProvider()
let client
try {
  state = prepareCodexRuntimeState({ userDataPath: root, gatewayUrl: provider.baseUrl, contracts })
  copyRuntimeHistory(state.codexHome)
  activateCodexGatewaySpawnConfig({
    state,
    sidecarSpawnInstanceId: 'continuity-probe',
    gatewayUrl: provider.baseUrl,
    gatewayToken: 'continuity-probe-token',
    contracts,
  })
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
  // Per head: ordinary, fork turn, reseed, reseed after restart, manual compaction, post-compaction turn.
  if (provider.requests.length !== heads.length * 6) {
    throw new Error('continuity_probe_provider_request_count_mismatch')
  }
  const version = execFileSync(binaryPath, ['--version'], { encoding: 'utf8' }).trim()
  process.stdout.write(`${JSON.stringify({
    contract: 'ready_runtime_continuity_native_probe_v2',
    targetBinarySha256: sha256File(binaryPath),
    targetRuntimeVersion: version,
    isolatedCopy: true,
    __breaksInvariants: ['selected native histories are unarchived only in the isolated copy'],
    providerKind: 'local_fixture',
    currentInstructionContractDigest,
    results,
  }, null, 2)}\n`)
} finally {
  if (client) await client.close()
  await provider.close()
  rmSync(root, { recursive: true, force: true })
}
