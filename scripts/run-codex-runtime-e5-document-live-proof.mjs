#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { buildSourceManifest, sha256File } = require('./browser-live-proof-manifest.cjs')
const expectedDocumentSurfaceToolCount = 51
const expectedDocumentSurfaceDigest = 'c808cc11da1d0c8a4a9ecef09bdef0ab9ed54eede68445ed5dd0fa30bee126b3'

const root = process.cwd()
const sourceDatabasePath = resolve(String(process.env.READY_CODEX_REAL_DB_PATH || ''))
if (!process.env.READY_CODEX_REAL_DB_PATH || !existsSync(sourceDatabasePath)) {
  throw new Error('READY_CODEX_REAL_DB_PATH must name the existing configured Ready database')
}
const iterations = Number.parseInt(process.env.READY_CODEX_E5_ITERATIONS || '3', 10)
if (iterations !== 3) {
  throw new Error('READY_CODEX_E5_ITERATIONS must be exactly 3')
}

const proofId = randomBytes(20).toString('hex')
const runRoot = resolve(root, 'outputs/codex-runtime-e5', proofId)
const profilePath = resolve(runRoot, 'profile')
const tempPath = resolve(runRoot, 'tmp')
const databasePath = resolve(profilePath, 'ready.db')
const evidenceDatabasePath = resolve(runRoot, 'e5-evidence.db')
const gatewayCapturePath = resolve(profilePath, 'e5-gateway-capture.ndjson')
const reportPath = resolve(runRoot, 'e5-document-live-proof-report.json')
const completionMarkerPath = resolve(runRoot, 'e5-document-runtime-completion.json')
const v2Sentinel = `E5_S1_CURRENT_${proofId.slice(0, 12)}`
mkdirSync(profilePath, { recursive: true })
mkdirSync(tempPath, { recursive: true })

const sourceDatabaseShaBefore = sha256File(sourceDatabasePath)
const sourceDatabaseContentFingerprintBefore = databaseContentFingerprint(sourceDatabasePath)
seedProviderSettings(sourceDatabasePath, databasePath)
const sourceDatabaseShaAfterSeed = sha256File(sourceDatabasePath)
const sourceDatabaseContentFingerprintAfterSeed = databaseContentFingerprint(sourceDatabasePath)
if (sourceDatabaseShaAfterSeed !== sourceDatabaseShaBefore
  || JSON.stringify(sourceDatabaseContentFingerprintAfterSeed)
    !== JSON.stringify(sourceDatabaseContentFingerprintBefore)) {
  throw new Error('source Ready database changed while seeding the isolated proof')
}

const sourceManifest = buildSourceManifest(root)
const embeddedManifestPath = resolve(root, 'build/browser-live-proof/source-manifest.json')
mkdirSync(dirname(embeddedManifestPath), { recursive: true })
writeFileSync(embeddedManifestPath, `${JSON.stringify(sourceManifest, null, 2)}\n`)
if (process.env.READY_LIVE_SKIP_BUILD !== '1') await run('npm', ['run', 'build'])

const executablePath = resolve(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
if (!existsSync(executablePath)) throw new Error(`development Electron executable not found: ${executablePath}`)
const port = 9980 + Number.parseInt(proofId.slice(0, 3), 16) % 160
const proofNonce = randomBytes(24).toString('hex')
const logs = []
const child = spawn(executablePath, [root, `--remote-debugging-port=${port}`], {
  cwd: root,
  env: {
    ...process.env,
    TMPDIR: tempPath,
    READY_BROWSER_LIVE_PROOF_NONCE: proofNonce,
    READY_CODEX_E5_GATEWAY_CAPTURE: '1',
    READY_CODEX_E5_PROOF_SENTINEL: v2Sentinel,
    READY_DB_PATH: databasePath,
    READY_REMOTE_DEBUGGING_PORT: String(port),
    READY_USER_DATA_DIR: profilePath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (chunk) => pushLogs(logs, chunk))
child.stderr.on('data', (chunk) => pushLogs(logs, chunk))

let client
let handshake
let runFailure = null
const results = []
const shutdown = {
  gracefulQuitAccepted: false,
  forcedMainShutdown: false,
  isolatedProcessTreeZero: false,
}
try {
  const target = await waitForRendererTarget(port, 90_000)
  client = await connect(target.webSocketDebuggerUrl)
  handshake = await evaluate(
    client,
    `window.electronAPI.app.browserLiveProofHandshake(${JSON.stringify(proofNonce)})`,
  )
  assertHandshake(handshake, sourceManifest, executablePath)
  client = await enableHarness(client, port)
  for (let index = 0; index < iterations; index += 1) {
    const v1Sentinel = `E5_S1_REVOKED_${proofId.slice(0, 12)}_${index + 1}`
    const result = await evaluate(
      client,
      documentProofExpression({ index, v1Sentinel, v2Sentinel }),
      720_000,
    )
    if (!result?.ok) {
      throw new Error(`S1 iteration ${index + 1} failed: ${JSON.stringify(result)}`)
    }
    results.push(result)
  }
} catch (error) {
  runFailure = `${error instanceof Error ? error.message : String(error)}\n${logs.slice(-120).join('\n')}`
} finally {
  if (client && child.exitCode === null && child.signalCode === null) {
    try {
      const result = await evaluate(
        client,
        `window.electronAPI.app.browserLiveProofQuit(${JSON.stringify(proofNonce)})`,
        5_000,
      )
      shutdown.gracefulQuitAccepted = result?.success === true
    } catch {}
  }
  client?.close()
  if (!shutdown.gracefulQuitAccepted && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
  }
  shutdown.forcedMainShutdown = await waitForExit(child, 30_000)
  shutdown.isolatedProcessTreeZero = await waitForRunTreeZero(runRoot, 15_000)
  if (!shutdown.isolatedProcessTreeZero) await cleanupRunProcesses(runRoot)
}

if (runFailure || !shutdown.gracefulQuitAccepted
  || shutdown.forcedMainShutdown || !shutdown.isolatedProcessTreeZero) {
  throw new Error([runFailure, `shutdown=${JSON.stringify(shutdown)}`].filter(Boolean).join('\n'))
}
const sourceDatabaseShaAfterRun = sha256File(sourceDatabasePath)
const sourceDatabaseContentFingerprintAfterRun = databaseContentFingerprint(sourceDatabasePath)
if (sourceDatabaseShaAfterRun !== sourceDatabaseShaBefore
  || JSON.stringify(sourceDatabaseContentFingerprintAfterRun)
    !== JSON.stringify(sourceDatabaseContentFingerprintBefore)) {
  throw new Error('source Ready database changed during the isolated proof')
}
createStableDatabaseSnapshot(databasePath, evidenceDatabasePath)
const completionMarker = {
  schemaVersion: 1,
  proofId,
  completedAt: new Date().toISOString(),
  sourceManifestDigest: sourceManifest.digest,
  handshake: normalizeHandshake(handshake),
  isolation: {
    sourceDatabaseShaBefore,
    sourceDatabaseShaAfterSeed,
    sourceDatabaseShaAfterRun,
    sourceDatabaseContentFingerprintBefore,
    sourceDatabaseContentFingerprintAfterSeed,
    sourceDatabaseContentFingerprintAfterRun,
    runtimeDatabasePath: databasePath,
    evidenceDatabasePath,
    evidenceDatabaseSha256: sha256File(evidenceDatabasePath),
    gatewayCapturePath,
    gatewayCaptureSha256: sha256File(gatewayCapturePath),
  },
  shutdown,
  resultCount: results.length,
  scopeIds: results.map((item) => item.scopeId),
}
writeFileSync(completionMarkerPath, `${JSON.stringify(completionMarker, null, 2)}\n`)
const completionMarkerSha256 = sha256File(completionMarkerPath)
const databaseEvidence = readDatabaseEvidence(evidenceDatabasePath, results.map((item) => item.scopeId))
const gatewayCapture = readGatewayCapture(gatewayCapturePath)
assertDocumentEvidence(results, databaseEvidence, gatewayCapture, v2Sentinel, iterations)
if (sha256File(evidenceDatabasePath) !== completionMarker.isolation.evidenceDatabaseSha256
  || sha256File(gatewayCapturePath) !== completionMarker.isolation.gatewayCaptureSha256
  || sha256File(completionMarkerPath) !== completionMarkerSha256) {
  throw new Error('S1 evidence changed during offline verification')
}

const report = {
  ok: true,
  phase: 'E5',
  proofMode: 's1-current-document',
  runtimeMode: 'built-development-app',
  generatedAt: new Date().toISOString(),
  proofId,
  sourceManifest,
  handshake: normalizeHandshake(handshake),
  isolation: {
    sourceDatabaseReadOnly: true,
    copiedSettingKeys: ['ai_provider_workspace', 'ai_model_config', 'ai_saved_configs'],
    sourceDatabaseShaBefore,
    sourceDatabaseShaAfterSeed,
    sourceDatabaseShaAfterRun,
    sourceDatabaseContentFingerprintBefore,
    sourceDatabaseContentFingerprintAfterSeed,
    sourceDatabaseContentFingerprintAfterRun,
    profilePath,
    databasePath,
    evidenceDatabasePath,
    tempPath,
  },
  shutdown,
  results,
  databaseEvidence,
  gatewayCapture,
  completionMarkerSha256,
  paths: { runRoot, reportPath, completionMarkerPath },
}
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({
  ok: true,
  reportPath,
  proofMode: report.proofMode,
  passes: results.length,
}, null, 2)}\n`)

function documentProofExpression({ index, v1Sentinel, v2Sentinel }) {
  return `(async () => {
    const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
    let stage = 'bootstrap'
    let offIngress = () => {}
    let offScopeRun = () => {}
    let offTool = () => {}
    try {
      const harness = window.__READY_AGENT_TEST__
      const agent = window.electronAPI?.agent
      if (!harness?.submit || !harness?.setDocumentFixture || !agent?.onIngressAdmitted) {
        return { ok: false, error: 'agent document harness unavailable' }
      }
      document.querySelector('button[title="展开聊天面板"]')?.click()
      await delay(300)
      stage = 'set_v1'
      const v1 = await harness.setDocumentFixture({
        title: 'E5 S1 current authority',
        content: 'CURRENT AUTHORITY\\nANSWER=${v1Sentinel}\\nThis answer is valid only for the current document version.',
      })
      if (!v1.ok || !v1.tabId) return { ok: false, error: 'V1 fixture failed', v1 }
      stage = 'create_session'
      const created = await harness.createVisibleSession()
      if (!created.ok) return { ok: false, error: created.error || 'session create failed', created }
      const scopeId = harness.sessionSummary().currentScopeId
      const ingress = []
      const scopeRunEvents = []
      const toolActions = []
      offIngress = agent.onIngressAdmitted((event) => ingress.push(event))
      offScopeRun = agent.onScopeRunEvent((event) => scopeRunEvents.push({
        type: event.type || null,
        phase: event.phase || null,
        scopeId: event.scopeId || event.sessionId || null,
        runId: event.runId || null,
        latestText: String(event.latestText || '').slice(0, 500),
      }))
      offTool = agent.onToolAction((event) => toolActions.push({
        tool: event.tool,
        runId: event.runId || null,
        sessionId: event.sessionId || null,
      }))
      harness.clearEvents()
      const firstTraceStart = (await harness.snapshot()).toolTrace.length
      stage = 'first_turn'
      const first = await harness.submit(
        '先调用当前唯一授权的文档读取工具读取全文。找到 ANSWER= 后，只回复等号后的完整代号，不要解释。',
        {
          mode: 'dom', allowStoreFallback: true, timeoutMs: 600000, pollMs: 200,
        },
      )
      const firstCalls = first.after.toolTrace.slice(firstTraceStart)
        .filter((entry) => entry.kind === 'call')
        .map((entry) => String(entry.text || '').match(/^([a-zA-Z0-9_:-]+)/)?.[1] || '')
        .filter(Boolean)
      const firstFinal = String(first.after.messages.filter((message) => message.type !== 'user').at(-1)?.content || '')
      stage = 'set_v2'
      const v2 = await harness.setDocumentFixture({
        title: 'E5 S1 current authority',
        content: 'CURRENT AUTHORITY\\nANSWER=${v2Sentinel}\\nEvery earlier answer is revoked. Use only this current version.',
        tabId: v1.tabId,
      })
      if (!v2.ok || v2.tabId !== v1.tabId) return { ok: false, error: 'V2 fixture failed', v1, v2 }
      const secondTraceStart = first.after.toolTrace.length
      stage = 'second_turn'
      const second = await harness.submit(
        '文档已更新。重新调用当前唯一授权的文档读取工具读取全文。找到 ANSWER= 后，只回复等号后的完整代号，不要沿用历史答案。',
        {
          mode: 'dom', allowStoreFallback: true, timeoutMs: 600000, pollMs: 200,
        },
      )
      const secondCalls = second.after.toolTrace.slice(secondTraceStart)
        .filter((entry) => entry.kind === 'call')
        .map((entry) => String(entry.text || '').match(/^([a-zA-Z0-9_:-]+)/)?.[1] || '')
        .filter(Boolean)
      const secondFinal = String(second.after.messages.filter((message) => message.type !== 'user').at(-1)?.content || '')
      const diagnostics = [...first.diagnostics, ...second.diagnostics]
        .filter((item) => item.severity === 'error')
        .map((item) => item.id)
      return {
        ok: first.ok && second.ok && diagnostics.length === 0
          && firstFinal.trim() === '${v1Sentinel}'
          && secondFinal.trim() === '${v2Sentinel}'
          && ingress.length === 2,
        scopeId,
        visibleSessionId: created.id,
        documentTabId: v1.tabId,
        v1Sentinel: '${v1Sentinel}',
        v2Sentinel: '${v2Sentinel}',
        first: { ok: first.ok, finalText: firstFinal.slice(0, 500), toolCalls: firstCalls },
        second: { ok: second.ok, finalText: secondFinal.slice(0, 500), toolCalls: secondCalls },
        diagnostics,
        ingress,
        scopeRunEvents: scopeRunEvents.filter((event) => event.scopeId === scopeId),
        toolActions,
        harnessEvents: harness.events(),
      }
    } catch (error) {
      return {
        ok: false,
        stage,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? String(error.stack || '') : '',
      }
    } finally {
      offIngress(); offScopeRun(); offTool()
    }
  })()`
}

function readDatabaseEvidence(path, scopeIds) {
  const expectedScopes = new Set(scopeIds)
  const threads = sqliteJson(path, `
    SELECT ready_conversation_alias AS scopeId, thread_binding_id AS threadBindingId,
           codex_thread_id AS codexThreadId, codex_session_id AS codexSessionId,
           tool_surface_digest AS toolSurfaceDigest, tool_surface_json AS toolSurfaceJson,
           runtime_manifest_digest AS runtimeManifestDigest,
           protocol_schema_digest AS protocolSchemaDigest
      FROM codex_thread_bindings ORDER BY created_at;
  `).map((row) => ({
    ...row,
    toolSurfaceJson: JSON.parse(row.toolSurfaceJson),
  }))
  const ignored = threads.filter((row) => !expectedScopes.has(row.scopeId))
  if (ignored.some((row) => row.codexThreadId || row.codexSessionId)) {
    throw new Error('unexpected started thread exists outside S1 scopes')
  }
  const turns = sqliteJson(path, `
    SELECT thread.ready_conversation_alias AS scopeId, turn.ready_run_id AS readyRunId,
           turn.codex_thread_id AS codexThreadId, turn.codex_turn_id AS codexTurnId,
           turn.ingress_json AS ingressJson,
           turn.authorization_snapshot_json AS authorizationJson,
           turn.engine_terminal_status AS engineTerminalStatus,
           json_extract(turn.engine_terminal_candidate_json, '$.candidateText') AS candidateText,
           (SELECT COUNT(*) FROM chat_messages message
             WHERE message.conversation_id = thread.ready_conversation_alias
               AND message.role = 'assistant'
               AND json_extract(message.meta_json, '$.runId') = turn.ready_run_id) AS canonicalMessageCount,
           (SELECT message.content FROM chat_messages message
             WHERE message.conversation_id = thread.ready_conversation_alias
               AND message.role = 'assistant'
               AND json_extract(message.meta_json, '$.runId') = turn.ready_run_id
             LIMIT 1) AS canonicalMessageText,
           turn.product_terminal_digest AS productTerminalDigest,
           turn.publication_receipt_refs_json AS publicationReceiptRefsJson,
           turn.publication_receipt_digest AS publicationReceiptDigest,
           turn.fence_release_revision AS fenceReleaseRevision,
           (SELECT COUNT(*) FROM ready_model_gateway_request_receipts receipt
             WHERE receipt.ready_run_id = turn.ready_run_id
               AND receipt.request_kind = 'product') AS gatewayRequestCount,
           turn.created_at AS createdAt
      FROM codex_turn_bindings turn
      JOIN codex_thread_bindings thread ON thread.thread_binding_id = turn.thread_binding_id
     ORDER BY turn.created_at;
  `).filter((row) => expectedScopes.has(row.scopeId)).map((row) => ({
    ...row,
    ingress: JSON.parse(row.ingressJson),
    authorization: JSON.parse(row.authorizationJson),
    publicationReceiptRefs: JSON.parse(row.publicationReceiptRefsJson || '[]'),
  }))
  const calls = sqliteJson(path, `
    SELECT turn.ready_conversation_alias AS scopeId, admission.ready_run_id AS readyRunId,
           admission.codex_thread_id AS codexThreadId,
           admission.codex_turn_id AS codexTurnId,
           admission.codex_call_id AS codexCallId, admission.tool_name AS toolName,
           binding.ready_action_id AS readyActionId,
           binding.receipt_id AS bindingReceiptId,
           binding.result_digest AS bindingResultDigest,
           action.action_identity_digest AS actionIdentityDigest,
           action.state AS actionState, action.receipt_id AS actionReceiptId,
           action.result_digest AS actionResultDigest, action.result_json AS actionResultJson
      FROM codex_tool_call_admissions admission
      JOIN codex_thread_bindings turn ON turn.codex_thread_id = admission.codex_thread_id
      LEFT JOIN codex_tool_call_bindings binding
        ON binding.ready_run_id = admission.ready_run_id
       AND binding.codex_thread_id = admission.codex_thread_id
       AND binding.codex_turn_id = admission.codex_turn_id
       AND binding.codex_call_id = admission.codex_call_id
      LEFT JOIN ready_tool_action_receipts action
        ON action.ready_action_id = binding.ready_action_id
     ORDER BY admission.ready_run_id, admission.codex_call_id;
  `).filter((row) => expectedScopes.has(row.scopeId)).map((row) => ({
    ...row,
    actionResult: JSON.parse(row.actionResultJson || 'null'),
  }))
  return {
    threads: threads.filter((row) => expectedScopes.has(row.scopeId)),
    turns,
    calls,
    ignoredUnstartedThreadCount: ignored.length,
  }
}

function assertDocumentEvidence(results, evidence, capture, v2Sentinel, expectedIterations) {
  if (results.length !== expectedIterations || evidence.threads.length !== expectedIterations) {
    throw new Error('S1 live pass count mismatch')
  }
  if (new Set(results.map((item) => item.scopeId)).size !== results.length) {
    throw new Error('S1 aliases are not independent')
  }
  for (const result of results) {
    const thread = evidence.threads.find((item) => item.scopeId === result.scopeId)
    const turns = evidence.turns.filter((item) => item.scopeId === result.scopeId)
    const calls = evidence.calls.filter((item) => item.scopeId === result.scopeId)
    if (!thread?.codexThreadId || thread.codexThreadId !== thread.codexSessionId || turns.length !== 2) {
      throw new Error('S1 native thread continuity mismatch')
    }
    if (thread.toolSurfaceDigest !== expectedDocumentSurfaceDigest
      || thread.toolSurfaceJson.toolNames.length !== expectedDocumentSurfaceToolCount
      || !thread.toolSurfaceJson.toolNames.includes('document_read_section')) {
      throw new Error('S1 frozen tool surface lost document reading')
    }
    const anchors = turns.map((turn) => turn.ingress.prepared?.ingress?.currentDocumentAnchor)
    const refs = turns.map((turn) => turn.ingress.prepared?.ingress?.resourceAdditionalContext)
    if (anchors.some((anchor) => !anchor) || refs.some((items) => !Array.isArray(items) || items.length !== 1)) {
      throw new Error('S1 durable current-document anchor or reference missing')
    }
    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index]
      const anchor = anchors[index]
      const reference = refs[index][0]
      if (turn.codexThreadId !== thread.codexThreadId
        || turn.engineTerminalStatus !== 'completed'
        || turn.candidateText !== (index === 0 ? result.v1Sentinel : result.v2Sentinel)
        || turn.canonicalMessageCount !== 1
        || turn.canonicalMessageText !== turn.candidateText
        || !turn.productTerminalDigest || !turn.publicationReceiptDigest
        || !turn.fenceReleaseRevision || turn.gatewayRequestCount < 2
        || JSON.stringify(turn.ingress).includes(result.v1Sentinel)
        || JSON.stringify(turn.ingress).includes(result.v2Sentinel)
        || Object.keys(reference).sort().join(',')
          !== 'currentDigest,currentVersion,logicalResourceId,policyEpoch,supersedesVersion'
        || reference.logicalResourceId !== anchor.logicalResourceId
        || reference.currentVersion !== anchor.currentVersion
        || reference.currentDigest !== anchor.currentDigest
        || reference.policyEpoch !== anchor.policyEpoch
        || turn.authorization.allowedToolNames.length !== 1
        || turn.authorization.allowedToolNames[0] !== 'document_read_section') {
        throw new Error('S1 body-free ingress, authorization, or closeout mismatch')
      }
    }
    if (anchors[0].logicalResourceId !== anchors[1].logicalResourceId
      || anchors[0].tabId !== anchors[1].tabId
      || anchors[0].incarnationKey !== anchors[1].incarnationKey
      || anchors[0].currentVersion === anchors[1].currentVersion
      || anchors[1].supersedesVersion !== anchors[0].currentVersion
      || anchors[1].policyEpoch <= anchors[0].policyEpoch) {
      throw new Error('S1 V1-to-V2 authority rotation mismatch')
    }
    if (calls.length !== 2 || calls.some((call) => call.toolName !== 'document_read_section'
      || call.actionState !== 'confirmed'
      || !call.bindingReceiptId
      || call.bindingReceiptId !== call.actionReceiptId
      || call.bindingResultDigest !== call.actionResultDigest)) {
      throw new Error('S1 exact document read receipts mismatch')
    }
    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index]
      const anchor = anchors[index]
      const call = calls.find((candidate) => candidate.readyRunId === turn.readyRunId)
      const expectedSentinel = index === 0 ? result.v1Sentinel : result.v2Sentinel
      const forbiddenSentinel = index === 0 ? result.v2Sentinel : result.v1Sentinel
      const text = call?.actionResult?.text
      const receipt = call?.actionResult?.data?.resourceReadReceipt
      if (!call || typeof text !== 'string' || !text.includes(expectedSentinel)
        || text.includes(forbiddenSentinel) || !receipt
        || receipt.readyRunId !== turn.readyRunId
        || receipt.codexThreadId !== turn.codexThreadId
        || receipt.codexTurnId !== turn.codexTurnId
        || receipt.codexCallId !== call.codexCallId
        || receipt.readyActionId !== call.readyActionId
        || receipt.actionIdentityDigest !== call.actionIdentityDigest
        || receipt.logicalResourceId !== anchor.logicalResourceId
        || receipt.currentVersion !== anchor.currentVersion
        || receipt.currentDigest !== anchor.currentDigest
        || receipt.policyEpoch !== anchor.policyEpoch
        || receipt.tabId !== anchor.tabId
        || receipt.pane !== anchor.pane
        || receipt.pathDigest !== anchor.pathDigest
        || receipt.incarnationKey !== anchor.incarnationKey
        || receipt.summaryDigest !== sha256Text(text)
        || receipt.bodyBytes !== Buffer.byteLength(text)
        || turn.publicationReceiptRefs.length !== 1
        || turn.publicationReceiptRefs[0] !== call.bindingReceiptId) {
        throw new Error('S1 model-visible text is not bound to the exact current-version receipt')
      }
    }
  }
  const expectedThreadIds = new Set(evidence.threads.map((item) => item.codexThreadId))
  const relevantCapture = capture.filter((item) => expectedThreadIds.has(item.threadId))
  if (relevantCapture.length !== expectedIterations * 4 || relevantCapture.some((item) => (
    item.requestKind !== 'product'
      || item.readyResourceReferenceCount !== 1
      || item.toolCount !== expectedDocumentSurfaceToolCount
      || item.toolCount !== item.toolNames.length
      || item.toolsDigest !== expectedDocumentSurfaceDigest
      || new Set(item.toolNames).size !== item.toolNames.length
      || !item.toolNames.includes('document_read_section')
  ))) throw new Error('S1 provider request surface or resource reference mismatch')
  for (const result of results) {
    const thread = evidence.threads.find((item) => item.scopeId === result.scopeId)
    const turns = evidence.turns.filter((item) => item.scopeId === result.scopeId)
    const first = relevantCapture.filter((item) => item.turnId === turns[0].codexTurnId)
    const second = relevantCapture.filter((item) => item.turnId === turns[1].codexTurnId)
    const expectedToolNames = [...(thread?.toolSurfaceJson.toolNames || [])].sort()
    if ([...first, ...second].some((item) => (
      JSON.stringify([...item.toolNames].sort()) !== JSON.stringify(expectedToolNames)
    )) || first.length !== 2 || first.some((item) => item.proofSentinelOccurrences !== 0)
      || second.length !== 2 || second[0].proofSentinelOccurrences !== 0
      || !second.some((item) => item.proofSentinelOccurrences > 0)) {
      throw new Error('S1 V2 body reached the provider before the authorized read')
    }
  }
  if (capture.some((item) => item.proofSentinelDigest !== capture[0].proofSentinelDigest)
    || !v2Sentinel.startsWith('E5_S1_CURRENT_')) {
    throw new Error('S1 gateway capture sentinel identity mismatch')
  }
}

function sqliteJson(path, sql) {
  const raw = execFileSync('sqlite3', ['-json', path, sql], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  }).trim()
  return raw ? JSON.parse(raw) : []
}

function databaseContentFingerprint(path) {
  return ['main', 'wal'].map((kind) => {
    const filePath = kind === 'main' ? path : `${path}-wal`
    return existsSync(filePath)
      ? { kind, bytes: statSync(filePath).size, sha256: sha256File(filePath) }
      : { kind, bytes: 0, sha256: null }
  })
}

function createStableDatabaseSnapshot(sourcePath, targetPath) {
  execFileSync('sqlite3', [sourcePath, `VACUUM INTO ${sqlQuote(targetPath)};`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  })
  if (!existsSync(targetPath)) throw new Error('S1 stable evidence database was not created')
}

function readGatewayCapture(path) {
  if (!existsSync(path)) throw new Error('S1 gateway capture missing')
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
}

function seedProviderSettings(sourcePath, targetPath) {
  const sql = `
    PRAGMA journal_mode = DELETE;
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    ATTACH DATABASE ${sqlQuote(sourcePath)} AS source_db;
    INSERT INTO settings (key, value, updated_at)
      SELECT key, value, updated_at FROM source_db.settings
       WHERE key IN ('ai_provider_workspace', 'ai_model_config', 'ai_saved_configs');
    DETACH DATABASE source_db;
  `
  execFileSync('sqlite3', [targetPath, sql], { stdio: ['ignore', 'pipe', 'pipe'] })
  const count = Number(execFileSync('sqlite3', [targetPath, 'SELECT COUNT(*) FROM settings;'], {
    encoding: 'utf8',
  }).trim())
  if (count < 1 || count > 3) throw new Error(`isolated provider seed count invalid: ${count}`)
}

function normalizeHandshake(value) {
  return {
    ok: value?.success === true,
    proofNonce: value?.proofNonce,
    execPath: value?.execPath,
    execSha256: value?.execSha256,
    asarPath: value?.asarPath,
    asarSha256: value?.asarSha256,
    sourceManifestDigest: value?.sourceManifestDigest,
    userDataPath: value?.userDataPath,
    databasePath: value?.databasePath,
    appVersion: value?.appVersion,
  }
}

function assertHandshake(value, sourceManifest, executablePath) {
  if (!value?.success || value.proofNonce !== proofNonce) throw new Error('runtime handshake failed')
  if (value.sourceManifestDigest !== sourceManifest.digest) throw new Error('embedded source manifest mismatch')
  if (value.execPath !== executablePath || value.execSha256 !== sha256File(executablePath)) {
    throw new Error('runtime executable identity mismatch')
  }
  if (value.asarPath || value.asarSha256) throw new Error('development runtime reported packaged asar')
  if (value.userDataPath !== profilePath || value.databasePath !== databasePath) {
    throw new Error('runtime isolation path mismatch')
  }
}

async function enableHarness(cdp, remotePort) {
  await evaluate(cdp, `(() => { localStorage.setItem('ready.agentPanelTest', '1'); return true })()`)
  await cdp.send('Page.reload', { ignoreCache: false })
  const deadline = Date.now() + 30_000
  let active = cdp
  while (Date.now() < deadline) {
    try {
      if (await evaluate(active, `Boolean(window.__READY_AGENT_TEST__?.setDocumentFixture && window.electronAPI?.agent)`, 2_000)) {
        return active
      }
    } catch {
      active.close()
      const target = await waitForRendererTarget(remotePort, 10_000)
      active = await connect(target.webSocketDebuggerUrl)
    }
    await delay(250)
  }
  throw new Error('agent document harness unavailable')
}

async function waitForRendererTarget(remotePort, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${remotePort}/json/list`, {
        signal: AbortSignal.timeout(2_000),
      })
      const targets = response.ok ? await response.json() : []
      const target = targets.find((item) => item.type === 'page'
        && item.webSocketDebuggerUrl
        && /\/index\.html(?:[?#].*)?$/.test(String(item.url || ''))
        && !/overlay/.test(String(item.url || '')))
      if (target) return target
    } catch {}
    await delay(500)
  }
  throw new Error('Ready renderer target unavailable')
}

async function connect(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let nextId = 0
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const item = pending.get(message.id)
    if (!item) return
    pending.delete(message.id)
    if (message.error) item.reject(new Error(message.error.message))
    else item.resolve(message.result)
  })
  socket.addEventListener('close', () => {
    for (const item of pending.values()) item.reject(new Error('CDP target closed'))
    pending.clear()
  })
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true })
    socket.addEventListener('error', rejectOpen, { once: true })
  })
  return {
    send(method, params = {}) {
      return new Promise((resolveSend, rejectSend) => {
        const id = ++nextId
        pending.set(id, { resolve: resolveSend, reject: rejectSend })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    close() { socket.close() },
  }
}

async function evaluate(cdp, expression, timeoutMs = 60_000) {
  let timer
  try {
    const response = await Promise.race([
      cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: true,
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Runtime.evaluate timed out')), timeoutMs)
      }),
    ])
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
    }
    return response.result?.value
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function run(command, args) {
  await new Promise((resolveRun, rejectRun) => {
    const childProcess = spawn(command, args, { cwd: root, env: process.env, stdio: 'inherit' })
    childProcess.once('error', rejectRun)
    childProcess.once('exit', (code, signal) => code === 0
      ? resolveRun()
      : rejectRun(new Error(`${command} failed with code=${code} signal=${signal || 'none'}`)))
  })
}

function sha256Text(value) {
  const { createHash } = require('node:crypto')
  return createHash('sha256').update(value).digest('hex')
}

function sqlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function pushLogs(target, chunk) {
  target.push(...String(chunk).split(/\r?\n/).filter(Boolean))
  if (target.length > 500) target.splice(0, target.length - 500)
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

async function waitForExit(childProcess, timeoutMs) {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) return false
  const timedOut = await Promise.race([
    new Promise((resolveExit) => childProcess.once('exit', () => resolveExit(false))),
    delay(timeoutMs).then(() => true),
  ])
  if (!timedOut) return false
  childProcess.kill('SIGKILL')
  await new Promise((resolveExit) => childProcess.once('exit', resolveExit))
  return true
}

function listRunProcessIds(runPath) {
  try {
    return execFileSync('pgrep', ['-f', runPath], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isSafeInteger(value) && value > 1 && value !== process.pid)
  } catch {
    return []
  }
}

async function waitForRunTreeZero(runPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (listRunProcessIds(runPath).length === 0) return true
    await delay(250)
  }
  return listRunProcessIds(runPath).length === 0
}

async function cleanupRunProcesses(runPath) {
  for (const pid of listRunProcessIds(runPath)) {
    try { process.kill(pid, 'SIGTERM') } catch {}
  }
  if (await waitForRunTreeZero(runPath, 5_000)) return
  for (const pid of listRunProcessIds(runPath)) {
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
  await waitForRunTreeZero(runPath, 5_000)
}
