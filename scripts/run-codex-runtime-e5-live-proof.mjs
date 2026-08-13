#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { buildSourceManifest, sha256File } = require('./browser-live-proof-manifest.cjs')
const {
  assertManualGatewayCaptureTurnIdentities,
  parseMacProcessRows,
} = require('./codex-runtime/e5-live-proof-assertions.cjs')

const root = process.cwd()
const sourceDatabasePath = resolve(String(process.env.READY_CODEX_REAL_DB_PATH || ''))
if (!process.env.READY_CODEX_REAL_DB_PATH || !existsSync(sourceDatabasePath)) {
  throw new Error('READY_CODEX_REAL_DB_PATH must name the existing configured Ready database')
}
const iterations = Number.parseInt(process.env.READY_CODEX_E5_ITERATIONS || '1', 10)
const useDevelopmentRuntime = process.env.READY_CODEX_E5_PACKAGED !== '1'
const preflightOnly = process.env.READY_CODEX_E5_PREFLIGHT_ONLY === '1'
const manualCompactionProof = process.env.READY_CODEX_E5_MANUAL_COMPACTION === '1'
const automaticCompactionProof = process.env.READY_CODEX_E5_AUTOMATIC_COMPACTION === '1'
if ([preflightOnly, manualCompactionProof, automaticCompactionProof].filter(Boolean).length > 1) {
  throw new Error('E5 proof mode flags are mutually exclusive')
}
if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 3) {
  throw new Error('READY_CODEX_E5_ITERATIONS must be between 1 and 3')
}
if (manualCompactionProof && iterations !== 1) {
  throw new Error('manual restart proof must run one isolated sidecar restart per app process')
}
if (automaticCompactionProof && iterations !== 1) {
  throw new Error('automatic compaction proof is a single threshold-trigger sample')
}
if (!preflightOnly && !manualCompactionProof && !automaticCompactionProof && iterations !== 3) {
  throw new Error('S0 final proof must run exactly 3 iterations')
}

const proofId = randomBytes(20).toString('hex')
const runRoot = resolve(root, 'outputs/codex-runtime-e5', proofId)
const profilePath = resolve(runRoot, 'profile')
const tempPath = resolve(runRoot, 'tmp')
const databasePath = resolve(profilePath, 'ready.db')
const evidenceDatabasePath = resolve(runRoot, 'e5-evidence.db')
const gatewayCapturePath = resolve(profilePath, 'e5-gateway-capture.ndjson')
const reportPath = resolve(runRoot, 'e5-live-proof-report.json')
const completionMarkerPath = resolve(runRoot, 'e5-runtime-completion.json')
mkdirSync(profilePath, { recursive: true })
mkdirSync(tempPath, { recursive: true })

const sourceDatabaseShaBefore = sha256File(sourceDatabasePath)
const sourceDatabaseContentFingerprintBefore = databaseContentFingerprint(sourceDatabasePath)
seedProviderSettings({ sourceDatabasePath, databasePath })
const sourceDatabaseShaAfterSeed = sha256File(sourceDatabasePath)
const sourceDatabaseContentFingerprintAfterSeed = databaseContentFingerprint(sourceDatabasePath)
if (sourceDatabaseShaAfterSeed !== sourceDatabaseShaBefore
  || JSON.stringify(sourceDatabaseContentFingerprintAfterSeed)
    !== JSON.stringify(sourceDatabaseContentFingerprintBefore)) {
  throw new Error('source Ready database changed while seeding the isolated proof')
}

const embeddedManifestPath = resolve(root, 'build/browser-live-proof/source-manifest.json')
const skipBuild = process.env.READY_LIVE_SKIP_BUILD === '1'
const sourceManifest = skipBuild
  ? JSON.parse(readFileSync(embeddedManifestPath, 'utf8'))
  : buildSourceManifest(root)
if (!skipBuild) {
  mkdirSync(dirname(embeddedManifestPath), { recursive: true })
  writeFileSync(embeddedManifestPath, `${JSON.stringify(sourceManifest, null, 2)}\n`)
  await run('npm', ['run', useDevelopmentRuntime ? 'build' : 'build:dir'])
}

const executablePath = useDevelopmentRuntime ? findDevelopmentExecutable() : findExecutable()
const port = 9800 + Number.parseInt(proofId.slice(0, 3), 16) % 180
const proofNonce = randomBytes(24).toString('hex')
const automaticProofSentinel = `E5_S05_AUTOMATIC_${proofId.slice(0, 8)}_1`
const manualProofSentinel = `E5_S05_MANUAL_${proofId.slice(0, 8)}_1`
const manualPostSentinel = `E5_S05_POST_${randomBytes(12).toString('hex')}`
const gatewayCaptureEnabled = automaticCompactionProof || manualCompactionProof
const logs = []
const child = spawn(executablePath, [
  ...(useDevelopmentRuntime ? [root] : []),
  `--remote-debugging-port=${port}`,
], {
  cwd: root,
  env: {
    ...process.env,
    TMPDIR: tempPath,
    READY_BROWSER_LIVE_PROOF_NONCE: proofNonce,
    ...(gatewayCaptureEnabled ? {
      READY_CODEX_E5_GATEWAY_CAPTURE: '1',
      READY_CODEX_E5_PROOF_SENTINEL: automaticCompactionProof
        ? automaticProofSentinel
        : manualProofSentinel,
      READY_CODEX_E5_PROOF_SENTINELS_JSON: JSON.stringify(manualCompactionProof
        ? [manualProofSentinel, manualPostSentinel]
        : [automaticProofSentinel]),
    } : {}),
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
const s0 = []
const s05Manual = []
const s05Automatic = []
let runFailure = null
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
  assertHandshake(handshake)
  client = await enableHarness(client, port)
  for (let index = 0; index < (preflightOnly ? 0 : iterations); index += 1) {
    const label = automaticCompactionProof ? 'S05_AUTOMATIC' : manualCompactionProof ? 'S05_MANUAL' : 'S0'
    const sentinel = `E5_${label}_${proofId.slice(0, 8)}_${index + 1}`
    let result
    if (manualCompactionProof) {
      const postSentinel = manualPostSentinel
      const beforeRestart = await evaluate(
        client,
        s05ManualBeforeRestartExpression(sentinel, postSentinel, index > 0),
        720_000,
      )
      if (!beforeRestart?.ok) {
        throw new Error(`${label} iteration ${index + 1} pre-restart failed: ${JSON.stringify(beforeRestart)}`)
      }
      const restart = await restartIsolatedSidecar(databasePath, child.pid, profilePath)
      const afterRestart = await evaluate(
        client,
        s05ManualAfterRestartExpression({
          scopeId: beforeRestart.scopeId,
          sentinel,
          postSentinel: beforeRestart.postSentinel,
        }),
        360_000,
      )
      result = combineManualRestartEvidence(beforeRestart, restart, afterRestart)
    } else {
      result = await evaluate(
        client,
        automaticCompactionProof
          ? s05AutomaticExpression(sentinel, index > 0)
          : s0Expression(sentinel, index > 0),
        automaticCompactionProof ? 900_000 : 360_000,
      )
    }
    if (!result?.ok) throw new Error(`${label} iteration ${index + 1} failed: ${JSON.stringify(result)}`)
    ;(automaticCompactionProof ? s05Automatic : manualCompactionProof ? s05Manual : s0).push(result)
  }
} catch (error) {
  runFailure = `${error instanceof Error ? error.message : String(error)}\n${logs.slice(-100).join('\n')}`
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
  throw new Error([
    runFailure,
    `shutdown=${JSON.stringify(shutdown)}`,
  ].filter(Boolean).join('\n'))
}
const sourceDatabaseShaAfterRun = sha256File(sourceDatabasePath)
const sourceDatabaseContentFingerprintAfterRun = databaseContentFingerprint(sourceDatabasePath)
if (sourceDatabaseShaAfterRun !== sourceDatabaseShaBefore
  || JSON.stringify(sourceDatabaseContentFingerprintAfterRun)
    !== JSON.stringify(sourceDatabaseContentFingerprintBefore)) {
  throw new Error('source Ready database changed during isolated proof')
}
const proofRows = automaticCompactionProof ? s05Automatic : manualCompactionProof ? s05Manual : s0
createStableDatabaseSnapshot(databasePath, evidenceDatabasePath)
const completionMarker = {
  schemaVersion: 1,
  proofId,
  completedAt: new Date().toISOString(),
  proofMode: preflightOnly
    ? 'preflight'
    : automaticCompactionProof
      ? 's0.5-automatic'
      : manualCompactionProof ? 's0.5-manual-restart' : 's0',
  sourceManifestDigest: sourceManifest.digest,
  handshake: normalizeHandshake(handshake),
  isolation: {
    sourceDatabaseShaBefore,
    sourceDatabaseShaAfterSeed,
    sourceDatabaseShaAfterRun,
    sourceDatabaseContentFingerprintBefore,
    sourceDatabaseContentFingerprintAfterSeed,
    sourceDatabaseContentFingerprintAfterRun,
    evidenceDatabasePath,
    evidenceDatabaseSha256: sha256File(evidenceDatabasePath),
    gatewayCapturePath: gatewayCaptureEnabled ? gatewayCapturePath : null,
    gatewayCaptureSha256: gatewayCaptureEnabled ? sha256File(gatewayCapturePath) : null,
  },
  shutdown,
  resultCount: proofRows.length,
  resultDigest: sha256Json(proofRows),
  scopeIds: proofRows.map((item) => item.scopeId),
}
writeFileSync(completionMarkerPath, `${JSON.stringify(completionMarker, null, 2)}\n`)
const completionMarkerSha256 = sha256File(completionMarkerPath)
const databaseEvidence = readDatabaseEvidence(evidenceDatabasePath, proofRows.map((item) => item.scopeId))
const gatewayCapture = gatewayCaptureEnabled ? readGatewayCapture(gatewayCapturePath) : []
if (automaticCompactionProof) {
  assertAutomaticCompactionEvidence(s05Automatic, databaseEvidence, gatewayCapture)
}
else if (manualCompactionProof) {
  assertManualCompactionEvidence(s05Manual, databaseEvidence, gatewayCapture)
}
else if (!preflightOnly) assertS0Evidence(s0, databaseEvidence)
if (sha256File(evidenceDatabasePath) !== completionMarker.isolation.evidenceDatabaseSha256
  || (gatewayCaptureEnabled
    && sha256File(gatewayCapturePath) !== completionMarker.isolation.gatewayCaptureSha256)
  || sha256File(completionMarkerPath) !== completionMarkerSha256
  || sha256Json(proofRows) !== completionMarker.resultDigest) {
  throw new Error('E5 evidence changed during offline verification')
}
const report = {
  ok: true,
  phase: 'E5',
  proofMode: preflightOnly
    ? 'preflight'
    : automaticCompactionProof
      ? 's0.5-automatic'
      : manualCompactionProof ? 's0.5-manual-restart' : 's0',
  runtimeMode: useDevelopmentRuntime ? 'built-development-app' : 'packaged-app',
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
  s0,
  s05Manual,
  s05Automatic,
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
  passes: proofRows.length,
}, null, 2)}\n`)

function seedProviderSettings(input) {
  const sql = `
    PRAGMA journal_mode = DELETE;
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    ATTACH DATABASE ${sqlQuote(input.sourceDatabasePath)} AS source_db;
    INSERT INTO settings (key, value, updated_at)
      SELECT key, value, updated_at FROM source_db.settings
       WHERE key IN ('ai_provider_workspace', 'ai_model_config', 'ai_saved_configs');
    DETACH DATABASE source_db;
  `
  execFileSync('sqlite3', [input.databasePath, sql], { stdio: ['ignore', 'pipe', 'pipe'] })
  const count = Number(execFileSync('sqlite3', [input.databasePath, 'SELECT COUNT(*) FROM settings;'], {
    encoding: 'utf8',
  }).trim())
  if (count < 1 || count > 3) throw new Error(`isolated provider seed count invalid: ${count}`)
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function sha256CanonicalJson(value) {
  const canonicalize = (item) => {
    if (Array.isArray(item)) return item.map(canonicalize)
    if (!item || typeof item !== 'object') return item
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonicalize(item[key])]))
  }
  return sha256Json(canonicalize(value))
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
  if (!existsSync(targetPath)) throw new Error('E5 stable evidence database was not created')
}

function s0Expression(sentinel, createFreshSession) {
  return `(async () => {
    const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
    let stage = 'bootstrap'
    let offIngress = () => {}
    let offStream = () => {}
    let offStatus = () => {}
    let offTool = () => {}
    let offScopeRun = () => {}
    try {
      const harness = window.__READY_AGENT_TEST__
      const agent = window.electronAPI?.agent
      if (!harness?.submit || !agent?.onIngressAdmitted) return { ok: false, error: 'agent harness unavailable' }
      stage = 'open_chat'
      document.querySelector('button[title="展开聊天面板"]')?.click()
      await delay(400)
      stage = 'create_session'
      const activeSessionId = harness.sessionSummary().activeSessionId
      const created = ${createFreshSession}
        ? await harness.createVisibleSession()
        : activeSessionId
          ? { ok: true, id: activeSessionId, reused: true }
          : await harness.createVisibleSession()
      if (!created.ok) return { ok: false, error: created.error || 'session create failed', created }
      harness.clearEvents()
      const ingress = []
      const stream = []
      const status = []
      const toolActions = []
      const scopeRunEvents = []
      const scopeId = harness.sessionSummary().currentScopeId
      stage = 'subscribe'
      offIngress = agent.onIngressAdmitted((event) => ingress.push(event))
      offStream = agent.onStream((event) => stream.push({
        type: event.type, runId: event.runId || null, sessionId: event.sessionId || null,
        chunk: String(event.chunk || '').slice(0, 300),
        canonicalMessageId: event.canonicalMessage?.id || null,
        canonicalMessageDigest: event.canonicalMessageDigest || null,
      }))
      offStatus = agent.onStatusChange((event) => status.push(event))
      offTool = agent.onToolAction((event) => toolActions.push({
        tool: event.tool, runId: event.runId || null, sessionId: event.sessionId || null,
      }))
      offScopeRun = agent.onScopeRunEvent((event) => scopeRunEvents.push({
        type: event.type || null,
        phase: event.phase || null,
        scopeId: event.scopeId || event.sessionId || null,
        runId: event.runId || null,
        latestText: String(event.latestText || '').slice(0, 300),
        terminalReason: event.terminalReason || null,
      }))
      stage = 'first_turn'
      const first = await harness.submit(
        '这是连续会话验收。请记住代号 ${sentinel}，只回复：已记住。不要调用任何工具。',
        { mode: 'dom', allowStoreFallback: true, requireAssistantMessage: true, timeoutMs: 300000, pollMs: 200 },
      )
      const firstMessages = first.after.messages.map((message) => ({
        id: message.id, type: message.type, content: String(message.content || '').slice(0, 800),
      }))
      stage = 'second_turn'
      const second = await harness.submit(
        '上一轮要求你记住的代号是什么？只回复那个代号，不要调用任何工具。',
        { mode: 'dom', allowStoreFallback: true, requireAssistantMessage: true, timeoutMs: 300000, pollMs: 200 },
      )
      const assistant = second.after.messages.filter((message) => message.type !== 'user')
      const finalText = String(assistant.at(-1)?.content || '')
      const observedTools = Array.from(new Set(second.after.toolTrace
        .filter((entry) => entry.kind === 'call')
        .map((entry) => String(entry.text || '').match(/^([a-zA-Z0-9_:-]+)/)?.[1])
        .filter(Boolean)))
      const diagnostics = [...first.diagnostics, ...second.diagnostics]
        .filter((item) => item.severity === 'error')
        .map((item) => item.id)
      const scopedEvents = scopeRunEvents.filter((event) => event.scopeId === scopeId)
      const finishedEvents = scopedEvents.filter((event) => event.type === 'finished' && event.phase === 'done')
      const respondingEvents = scopedEvents.filter((event) => event.type === 'updated'
        && event.phase === 'responding' && event.latestText)
      const admittedRunIds = new Set(ingress.map((event) => event.requestId))
      const streamedRunIds = new Set(respondingEvents.map((event) => event.runId))
      return {
        ok: first.ok && second.ok && diagnostics.length === 0
          && finalText.includes('${sentinel}') && observedTools.length === 0
          && ingress.length === 2 && respondingEvents.length >= 2
          && admittedRunIds.size === 2
          && [...admittedRunIds].every((runId) => streamedRunIds.has(runId)),
        sentinel: '${sentinel}',
        visibleSessionId: created.id,
        scopeId,
        first: { ok: first.ok, inputMode: first.inputMode, messages: firstMessages },
        second: { ok: second.ok, inputMode: second.inputMode, finalText: finalText.slice(0, 800) },
        diagnostics,
        observedTools,
        ingress,
        finishedEvents,
        respondingEvents,
        legacyStreamEvents: stream,
        status,
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
      offIngress(); offStream(); offStatus(); offTool(); offScopeRun()
    }
  })()`
}

function s05ManualBeforeRestartExpression(sentinel, postSentinel, createFreshSession) {
  return `(async () => {
    const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
    let stage = 'bootstrap'
    let offIngress = () => {}
    let offScopeRun = () => {}
    let offTool = () => {}
    try {
      const harness = window.__READY_AGENT_TEST__
      const agent = window.electronAPI?.agent
      if (!harness?.submit || !agent?.compactSession || !agent?.onScopeRunEvent) {
        return { ok: false, error: 'manual compaction harness unavailable' }
      }
      document.querySelector('button[title="展开聊天面板"]')?.click()
      await delay(400)
      stage = 'create_session'
      const activeSessionId = harness.sessionSummary().activeSessionId
      const created = ${createFreshSession}
        ? await harness.createVisibleSession()
        : activeSessionId
          ? { ok: true, id: activeSessionId, reused: true }
          : await harness.createVisibleSession()
      if (!created.ok) return { ok: false, stage, created }
      harness.clearEvents()
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
        latestText: String(event.latestText || '').slice(0, 300),
      }))
      offTool = agent.onToolAction((event) => toolActions.push({
        tool: event.tool, runId: event.runId || null, sessionId: event.sessionId || null,
      }))
      stage = 'active_turn_compaction_rejection'
      const beforePromise = harness.submit(
        '请记住压缩前代号 ${sentinel}，只回复：已记住。不要调用任何工具。',
        { mode: 'dom', allowStoreFallback: true, requireAssistantMessage: true, timeoutMs: 300000, pollMs: 200 },
      )
      const activeDeadline = Date.now() + 30000
      while (Date.now() < activeDeadline && !scopeRunEvents.some((event) => (
        event.scopeId === scopeId && event.type === 'started' && event.phase === 'planning'
      ))) await delay(10)
      if (!scopeRunEvents.some((event) => (
        event.scopeId === scopeId && event.type === 'started' && event.phase === 'planning'
      ))) return { ok: false, stage, error: 'active product turn was not observed' }
      const activeCompact = await agent.compactSession({ aliasId: scopeId, aliasGeneration: 1 })
      const before = await beforePromise
      const beforeAssistant = before.after.messages.filter((message) => message.type !== 'user')
      const beforeFinalText = String(beforeAssistant.at(-1)?.content || '')
      if (activeCompact?.ok || activeCompact?.action !== 'manual_compact'
        || activeCompact?.code !== 'thread_busy' || activeCompact?.preserveUi !== true
        || !String(activeCompact?.evidenceDigest || '').trim()) {
        return { ok: false, stage, activeCompact, before: { ok: before.ok } }
      }
      stage = 'manual_compaction'
      const compact = await agent.compactSession({ aliasId: scopeId, aliasGeneration: 1 })
      if (!compact?.ok || compact.action !== 'manual_compact') {
        return { ok: false, stage, compact, before: { ok: before.ok } }
      }
      stage = 'post_compaction_turn'
      const post = await harness.submit(
        '请再记住压缩后代号 ${postSentinel}，只回复：已记住。不要调用任何工具。',
        { mode: 'dom', allowStoreFallback: true, requireAssistantMessage: true, timeoutMs: 300000, pollMs: 200 },
      )
      const postAssistant = post.after.messages.filter((message) => message.type !== 'user')
      const postFinalText = String(postAssistant.at(-1)?.content || '')
      const observedTools = Array.from(new Set([...before.after.toolTrace, ...post.after.toolTrace]
        .filter((entry) => entry.kind === 'call')
        .map((entry) => String(entry.text || '').match(/^([a-zA-Z0-9_:-]+)/)?.[1])
        .filter(Boolean)))
      const diagnostics = [...before.diagnostics, ...post.diagnostics]
        .filter((item) => item.severity === 'error')
        .map((item) => item.id)
      const scopedEvents = scopeRunEvents.filter((event) => event.scopeId === scopeId)
      const respondingEvents = scopedEvents.filter((event) => event.type === 'updated'
        && event.phase === 'responding' && event.latestText)
      const admittedRunIds = new Set(ingress.map((event) => event.requestId))
      const streamedRunIds = new Set(respondingEvents.map((event) => event.runId))
      return {
        ok: before.ok && post.ok && diagnostics.length === 0 && observedTools.length === 0
          && ingress.length === 2 && admittedRunIds.size === 2
          && [...admittedRunIds].every((runId) => streamedRunIds.has(runId))
          && toolActions.length === 0,
        sentinel: '${sentinel}',
        postSentinel: '${postSentinel}',
        visibleSessionId: created.id,
        scopeId,
        before: {
          ok: before.ok,
          finalText: beforeFinalText,
          messageEvidence: before.after.messages.map((message) => ({
            id: message.id,
            type: message.type,
            contentLength: message.content.length,
            metaKeys: message.metaKeys,
          })),
        },
        activeCompact,
        compact,
        post: {
          ok: post.ok,
          finalText: postFinalText,
          messageEvidence: post.after.messages.map((message) => ({
            id: message.id,
            type: message.type,
            contentLength: message.content.length,
            metaKeys: message.metaKeys,
          })),
        },
        diagnostics,
        observedTools,
        ingress,
        respondingEvents,
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

function s05ManualAfterRestartExpression({ scopeId, sentinel, postSentinel }) {
  return `(async () => {
    let offIngress = () => {}
    let offScopeRun = () => {}
    let offTool = () => {}
    try {
      const harness = window.__READY_AGENT_TEST__
      const agent = window.electronAPI?.agent
      if (!harness?.submit || !agent?.onScopeRunEvent) {
        return { ok: false, error: 'manual restart recall harness unavailable' }
      }
      if (harness.sessionSummary().currentScopeId !== '${scopeId}') {
        return { ok: false, error: 'manual restart changed the active scope' }
      }
      harness.clearEvents()
      const ingress = []
      const scopeRunEvents = []
      const toolActions = []
      offIngress = agent.onIngressAdmitted((event) => ingress.push(event))
      offScopeRun = agent.onScopeRunEvent((event) => scopeRunEvents.push({
        type: event.type || null,
        phase: event.phase || null,
        scopeId: event.scopeId || event.sessionId || null,
        runId: event.runId || null,
        latestText: String(event.latestText || '').slice(0, 300),
      }))
      offTool = agent.onToolAction((event) => toolActions.push({
        tool: event.tool, runId: event.runId || null, sessionId: event.sessionId || null,
      }))
      const recall = await harness.submit(
        '刚才压缩前和压缩后要求你分别记住了两个代号。只按“压缩前代号|压缩后代号”的顺序回复两个完整代号，不要解释，也不要调用任何工具。',
        { mode: 'dom', allowStoreFallback: true, requireAssistantMessage: true, timeoutMs: 300000, pollMs: 200 },
      )
      const assistant = recall.after.messages.filter((message) => message.type !== 'user')
      const finalText = String(assistant.at(-1)?.content || '')
      const observedTools = Array.from(new Set(recall.after.toolTrace
        .filter((entry) => entry.kind === 'call')
        .map((entry) => String(entry.text || '').match(/^([a-zA-Z0-9_:-]+)/)?.[1])
        .filter(Boolean)))
      const diagnostics = recall.diagnostics
        .filter((item) => item.severity === 'error')
        .map((item) => item.id)
      const scopedEvents = scopeRunEvents.filter((event) => event.scopeId === '${scopeId}')
      const respondingEvents = scopedEvents.filter((event) => event.type === 'updated'
        && event.phase === 'responding' && event.latestText)
      return {
        ok: recall.ok && finalText === '${sentinel}|${postSentinel}'
          && diagnostics.length === 0 && observedTools.length === 0
          && ingress.length === 1 && respondingEvents.some((event) => event.runId === ingress[0]?.requestId)
          && toolActions.length === 0,
        scopeId: '${scopeId}',
        recall: { ok: recall.ok, finalText },
        diagnostics,
        observedTools,
        ingress,
        respondingEvents,
        toolActions,
        harnessEvents: harness.events(),
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? String(error.stack || '') : '',
      }
    } finally {
      offIngress(); offScopeRun(); offTool()
    }
  })()`
}

function combineManualRestartEvidence(before, restart, after) {
  return {
    ...before,
    ok: before?.ok === true && after?.ok === true,
    restart,
    recall: after?.recall,
    diagnostics: [...(before?.diagnostics || []), ...(after?.diagnostics || [])],
    observedTools: [...new Set([...(before?.observedTools || []), ...(after?.observedTools || [])])],
    ingress: [...(before?.ingress || []), ...(after?.ingress || [])],
    respondingEvents: [...(before?.respondingEvents || []), ...(after?.respondingEvents || [])],
    toolActions: [...(before?.toolActions || []), ...(after?.toolActions || [])],
    harnessEvents: [...(before?.harnessEvents || []), ...(after?.harnessEvents || [])],
  }
}

function s05AutomaticExpression(sentinel, createFreshSession) {
  return `(async () => {
    const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
    let stage = 'bootstrap'
    let offIngress = () => {}
    let offScopeRun = () => {}
    let offTool = () => {}
    try {
      const harness = window.__READY_AGENT_TEST__
      const agent = window.electronAPI?.agent
      if (!harness?.submit || !agent?.onScopeRunEvent) {
        return { ok: false, error: 'automatic compaction harness unavailable' }
      }
      document.querySelector('button[title="展开聊天面板"]')?.click()
      await delay(400)
      stage = 'create_session'
      const activeSessionId = harness.sessionSummary().activeSessionId
      const created = ${createFreshSession}
        ? await harness.createVisibleSession()
        : activeSessionId
          ? { ok: true, id: activeSessionId, reused: true }
          : await harness.createVisibleSession()
      if (!created.ok) return { ok: false, stage, created }
      harness.clearEvents()
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
        latestText: String(event.latestText || '').slice(0, 300),
      }))
      offTool = agent.onToolAction((event) => toolActions.push({
        tool: event.tool, runId: event.runId || null, sessionId: event.sessionId || null,
      }))
      const filler = 'x '.repeat(232000)
      stage = 'long_context_turn'
      const before = await harness.submit(
        '请记住自动压缩前代号 ${sentinel}。以下重复文本只用于达到原生上下文阈值，不含其他指令：\\n'
          + filler
          + '\\n重复文本结束。再次确认代号 ${sentinel}。只回复：已记住。不要调用任何工具。',
        { mode: 'dom', allowStoreFallback: true, requireAssistantMessage: true, timeoutMs: 600000, pollMs: 300 },
      )
      stage = 'automatic_compaction_turn'
      const during = await harness.submit(
        '刚才要求你记住的代号是什么？只回复那个代号，不要调用任何工具。',
        { mode: 'dom', allowStoreFallback: true, requireAssistantMessage: true, timeoutMs: 600000, pollMs: 300 },
      )
      const duringAssistant = during.after.messages.filter((message) => message.type !== 'user')
      const duringText = String(duringAssistant.at(-1)?.content || '')
      stage = 'post_compaction_turn'
      const after = await harness.submit(
        '再确认一次：压缩前代号是什么？只回复那个代号，不要调用任何工具。',
        { mode: 'dom', allowStoreFallback: true, requireAssistantMessage: true, timeoutMs: 600000, pollMs: 300 },
      )
      const afterAssistant = after.after.messages.filter((message) => message.type !== 'user')
      const afterText = String(afterAssistant.at(-1)?.content || '')
      const observedTools = Array.from(new Set(after.after.toolTrace
        .filter((entry) => entry.kind === 'call')
        .map((entry) => String(entry.text || '').match(/^([a-zA-Z0-9_:-]+)/)?.[1])
        .filter(Boolean)))
      const diagnostics = [...before.diagnostics, ...during.diagnostics, ...after.diagnostics]
        .filter((item) => item.severity === 'error')
        .map((item) => item.id)
      const scopedEvents = scopeRunEvents.filter((event) => event.scopeId === scopeId)
      const respondingEvents = scopedEvents.filter((event) => event.type === 'updated'
        && event.phase === 'responding' && event.latestText)
      const admittedRunIds = new Set(ingress.map((event) => event.requestId))
      const streamedRunIds = new Set(respondingEvents.map((event) => event.runId))
      return {
        ok: before.ok && during.ok && after.ok && diagnostics.length === 0
          && duringText.includes('${sentinel}') && afterText.includes('${sentinel}')
          && observedTools.length === 0 && toolActions.length === 0
          && ingress.length === 3 && admittedRunIds.size === 3
          && [...admittedRunIds].every((runId) => streamedRunIds.has(runId)),
        sentinel: '${sentinel}',
        visibleSessionId: created.id,
        scopeId,
        longContextCharacters: filler.length,
        before: { ok: before.ok },
        during: { ok: during.ok, finalText: duringText.slice(0, 800) },
        after: { ok: after.ok, finalText: afterText.slice(0, 800) },
        diagnostics,
        observedTools,
        ingress,
        respondingEvents,
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
  const sql = `
    SELECT json_object(
      'scopeId', t.ready_conversation_alias,
      'aliasGeneration', t.alias_generation,
      'threadBindingId', t.thread_binding_id,
      'codexThreadId', t.codex_thread_id,
      'codexSessionId', t.codex_session_id,
      'toolSurfaceDigest', t.tool_surface_digest,
      'toolSurfaceJson', json(t.tool_surface_json),
      'runtimeManifestDigest', t.runtime_manifest_digest,
      'protocolSchemaDigest', t.protocol_schema_digest,
      'canonicalUserMessageCount', (
        SELECT COUNT(*) FROM chat_messages message
         WHERE message.conversation_id = t.ready_conversation_alias AND message.role = 'user'
      ),
      'canonicalAssistantMessageCount', (
        SELECT COUNT(*) FROM chat_messages message
         WHERE message.conversation_id = t.ready_conversation_alias AND message.role = 'assistant'
      ),
      'remainingFenceCount', (
        SELECT COUNT(*) FROM codex_thread_dispatch_fences fence
         WHERE fence.thread_binding_id = t.thread_binding_id
      ),
      'turns', (
        SELECT json_group_array(json_object(
          'readyRunId', r.ready_run_id,
          'codexTurnId', r.codex_turn_id,
          'createdAt', r.created_at,
          'turnStartConnectionEpoch', r.turn_start_rpc_connection_epoch,
          'turnContractDigest', r.turn_contract_digest,
          'additionalContextDigest', r.additional_context_digest,
          'engineTerminalStatus', r.engine_terminal_status,
          'candidateText', json_extract(r.engine_terminal_candidate_json, '$.candidateText'),
          'canonicalMessageCount', (
            SELECT COUNT(*) FROM chat_messages message
             WHERE message.conversation_id = t.ready_conversation_alias
               AND message.role = 'assistant'
               AND json_extract(message.meta_json, '$.runId') = r.ready_run_id
          ),
          'canonicalMessageText', (
            SELECT message.content FROM chat_messages message
             WHERE message.conversation_id = t.ready_conversation_alias
               AND message.role = 'assistant'
               AND json_extract(message.meta_json, '$.runId') = r.ready_run_id
             LIMIT 1
          ),
          'automaticCompactionExchanges', json_extract(
            r.engine_terminal_candidate_json,
            '$.contextState.automaticCompactionExchanges'
          ),
          'productTerminalDigest', r.product_terminal_digest,
          'publicationReceiptDigest', r.publication_receipt_digest,
          'fenceReleaseRevision', r.fence_release_revision,
          'gatewayRequestCount', (
            SELECT COUNT(*) FROM ready_model_gateway_request_receipts g
             WHERE g.ready_run_id = r.ready_run_id AND g.request_kind = 'product'
          ),
          'automaticCompactionGatewayRequestCount', (
            SELECT COUNT(*) FROM ready_model_gateway_request_receipts g
             WHERE g.ready_run_id = r.ready_run_id AND g.request_kind = 'automatic_compaction'
          )
        )) FROM codex_turn_bindings r WHERE r.thread_binding_id = t.thread_binding_id
      )
    ) FROM codex_thread_bindings t ORDER BY t.created_at;
  `
  const rows = execFileSync('sqlite3', ['-noheader', path, sql], { encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  const expectedScopes = new Set(scopeIds)
  const threads = rows.filter((row) => expectedScopes.has(row.scopeId))
  const ignoredThreads = rows.filter((row) => !expectedScopes.has(row.scopeId))
  if (ignoredThreads.some((row) => row.codexThreadId || row.codexSessionId || row.turns?.length)) {
    throw new Error('unexpected started thread exists outside the S0 evidence scope')
  }
  const manualCompactions = execFileSync('sqlite3', ['-json', path, `
    SELECT
      thread.ready_conversation_alias AS scopeId,
      manual.manual_compaction_id AS manualCompactionId,
      manual.codex_thread_id AS codexThreadId,
      manual.codex_compaction_turn_id AS codexCompactionTurnId,
      manual.expected_tools_digest AS expectedToolsDigest,
      manual.pre_dispatch_thread_read_digest AS preDispatchThreadReadDigest,
      manual.pre_dispatch_turn_ids_json AS preDispatchTurnIdsJson,
      manual.pre_dispatch_turn_ids_digest AS preDispatchTurnIdsDigest,
      manual.notification_context_compaction_item_id AS notificationContextCompactionItemId,
      manual.context_compaction_item_id AS contextCompactionItemId,
      manual.terminal_status AS terminalStatus,
      manual.terminal_evidence_digest AS terminalEvidenceDigest,
      manual.thread_read_digest AS threadReadDigest,
      manual.gateway_request_receipt_id AS gatewayRequestReceiptId,
      manual.gateway_request_evidence_digest AS gatewayRequestEvidenceDigest,
      manual.gateway_response_evidence_digest AS gatewayResponseEvidenceDigest,
      manual.consumed_at AS consumedAt,
      manual.consume_evidence_digest AS consumeEvidenceDigest,
      manual.abandoned_at AS abandonedAt,
      manual.unknown_at AS unknownAt,
      manual.unknown_reason AS unknownReason,
      attempt.attempt_id AS attemptId,
      attempt.connection_epoch AS connectionEpoch,
      attempt.rpc_id AS rpcId,
      attempt.request_digest AS requestDigest,
      attempt.dispatch_intent_at AS dispatchIntentAt,
      attempt.child_write_attempted_at AS childWriteAttemptedAt,
      attempt.child_write_confirmed_at AS childWriteConfirmedAt,
      attempt.child_write_digest AS childWriteDigest,
      attempt.unresolved_at AS unresolvedAt,
      attempt.unresolved_reason AS unresolvedReason,
      attempt.response_kind AS responseKind,
      attempt.response_digest AS responseDigest,
      attempt.response_at AS responseAt,
      attempt.proven_absent_at AS provenAbsentAt,
      attempt.proven_absent_reason AS provenAbsentReason,
      attempt.proven_absent_evidence_digest AS provenAbsentEvidenceDigest,
      (SELECT COUNT(*) FROM codex_manual_compaction_dispatch_attempts all_attempts
        WHERE all_attempts.manual_compaction_id = manual.manual_compaction_id) AS attemptCount,
      (SELECT COUNT(*) FROM ready_model_gateway_request_receipts receipt
        WHERE receipt.manual_compaction_id = manual.manual_compaction_id
          AND receipt.request_kind = 'manual_compaction') AS gatewayRequestCount,
      (SELECT COUNT(*) FROM codex_thread_dispatch_fences fence
        WHERE fence.thread_binding_id = manual.thread_binding_id) AS remainingFenceCount
      FROM codex_manual_compaction_bindings manual
      JOIN codex_thread_bindings thread ON thread.thread_binding_id = manual.thread_binding_id
      LEFT JOIN codex_manual_compaction_dispatch_attempts attempt
        ON attempt.manual_compaction_id = manual.manual_compaction_id
      ORDER BY manual.created_at;
  `], { encoding: 'utf8' }).trim()
  const parsedManualCompactions = manualCompactions ? JSON.parse(manualCompactions) : []
  const automaticReceipts = execFileSync('sqlite3', ['-json', path, `
    SELECT
      COALESCE(product_thread.ready_conversation_alias,
        manual_thread.ready_conversation_alias) AS scopeId,
      receipt.request_kind AS requestKind,
      receipt.receipt_id AS receiptId,
      receipt.ready_run_id AS readyRunId,
      receipt.codex_thread_id AS codexThreadId,
      receipt.codex_turn_id AS codexTurnId,
      receipt.upstream_profile_snapshot_digest AS upstreamProfileSnapshotDigest,
      receipt.request_digest AS requestDigest,
      request_event.event_sequence AS requestSequence,
      request_event.input_digest AS inputDigest,
      request_event.input_total_string_characters AS inputTotalStringCharacters,
      request_event.evidence_digest AS requestEvidenceDigest,
      response_event.event_sequence AS responseSequence,
      response_event.evidence_digest AS responseEvidenceDigest,
      response_event.response_id AS responseId,
      response_event.terminal_digest AS responseTerminalDigest,
      response_event.output_digest AS responseOutputDigest,
      response_event.usage_digest AS responseUsageDigest,
      request_event.tool_count AS toolCount,
      request_event.tools_digest AS toolsDigest
      FROM ready_model_gateway_request_receipts receipt
      LEFT JOIN codex_turn_bindings turn_row ON turn_row.ready_run_id = receipt.ready_run_id
      LEFT JOIN codex_thread_bindings product_thread
        ON product_thread.thread_binding_id = turn_row.thread_binding_id
      LEFT JOIN codex_manual_compaction_bindings manual
        ON manual.manual_compaction_id = receipt.manual_compaction_id
      LEFT JOIN codex_thread_bindings manual_thread
        ON manual_thread.thread_binding_id = manual.thread_binding_id
      JOIN ready_model_gateway_exchange_events request_event
        ON request_event.gateway_request_receipt_id = receipt.receipt_id
       AND request_event.event_kind = 'request_admitted'
      LEFT JOIN ready_model_gateway_exchange_events response_event
        ON response_event.gateway_request_receipt_id = receipt.receipt_id
       AND response_event.event_kind = 'response_completed'
     WHERE receipt.request_kind IN ('automatic_compaction', 'manual_compaction', 'product')
     ORDER BY request_event.event_sequence;
  `], { encoding: 'utf8' }).trim()
  const parsedAutomaticReceipts = automaticReceipts ? JSON.parse(automaticReceipts) : []
  const processLeases = readSidecarProcessLeases(path)
  const resumeEvidence = execFileSync('sqlite3', ['-json', path, `
    SELECT thread.ready_conversation_alias AS scopeId,
      resume.resume_evidence_id AS resumeEvidenceId,
      resume.thread_binding_id AS threadBindingId,
      resume.codex_thread_id AS codexThreadId,
      resume.connection_epoch AS connectionEpoch,
      resume.pre_resume_thread_read_digest AS preResumeThreadReadDigest,
      resume.resumed_thread_digest AS resumedThreadDigest,
      resume.evidence_digest AS evidenceDigest,
      resume.recorded_at AS recordedAt
      FROM codex_thread_resume_evidence resume
      JOIN codex_thread_bindings thread ON thread.thread_binding_id = resume.thread_binding_id
     ORDER BY resume.recorded_at;
  `], { encoding: 'utf8' }).trim()
  const parsedResumeEvidence = resumeEvidence ? JSON.parse(resumeEvidence) : []
  return {
    threads,
    manualCompactions: parsedManualCompactions.filter((row) => expectedScopes.has(row.scopeId)),
    gatewayExchanges: parsedAutomaticReceipts
      .filter((row) => expectedScopes.has(row.scopeId)),
    resumeEvidence: parsedResumeEvidence.filter((row) => expectedScopes.has(row.scopeId)),
    processLeases,
    ignoredUnstartedThreadCount: ignoredThreads.length,
  }
}

function assertS0Evidence(s0, evidence, expectedTurns = 2) {
  if (evidence.threads.length !== s0.length) throw new Error('S0 thread count mismatch')
  if (new Set(s0.map((item) => item.scopeId)).size !== s0.length) {
    throw new Error('S0 iterations must use independent conversation aliases')
  }
  const liveByScope = new Map(s0.map((item) => [item.scopeId, item]))
  const surfaceDigests = new Set(evidence.threads.map((item) => item.toolSurfaceDigest))
  const runtimeDigests = new Set(evidence.threads.map((item) => item.runtimeManifestDigest))
  const protocolDigests = new Set(evidence.threads.map((item) => item.protocolSchemaDigest))
  if (surfaceDigests.size !== 1 || runtimeDigests.size !== 1 || protocolDigests.size !== 1) {
    throw new Error('S0 build or frozen-surface identity drifted between iterations')
  }
  for (const item of evidence.threads) {
    const live = liveByScope.get(item.scopeId)
    if (!live) throw new Error('S0 evidence scope mismatch')
    if (!item.codexThreadId || item.codexThreadId !== item.codexSessionId) {
      throw new Error('S0 native root thread identity missing')
    }
    if (item.canonicalUserMessageCount !== expectedTurns
      || item.canonicalAssistantMessageCount !== expectedTurns
      || item.remainingFenceCount !== 0) {
      throw new Error('S0 canonical history count or thread fence mismatch')
    }
    if (!item.toolSurfaceJson || !Array.isArray(item.toolSurfaceJson.entries)
      || !Array.isArray(item.toolSurfaceJson.responsesTools)
      || item.toolSurfaceJson.entries.length < 1 || item.toolSurfaceJson.responsesTools.length < 1) {
      throw new Error('S0 live tool surface must be non-empty')
    }
    if (!Array.isArray(item.turns) || item.turns.length !== expectedTurns) {
      throw new Error(`S0 requires ${expectedTurns} turns per thread`)
    }
    const admittedRunIds = new Set(live.ingress.map((event) => event.requestId))
    if (item.turns.some((turn) => !admittedRunIds.has(turn.readyRunId))) {
      throw new Error('S0 durable turn does not match admitted Renderer run')
    }
    if (new Set(item.turns.map((turn) => turn.codexTurnId)).size !== expectedTurns) {
      throw new Error('S0 turn identities repeated')
    }
    if (item.turns.some((turn) => turn.engineTerminalStatus !== 'completed'
      || !turn.productTerminalDigest || !turn.publicationReceiptDigest
      || !turn.fenceReleaseRevision || turn.gatewayRequestCount !== 1
      || turn.canonicalMessageCount !== 1
      || typeof turn.candidateText !== 'string'
      || turn.canonicalMessageText !== turn.candidateText)) {
      throw new Error('S0 durable closeout or gateway receipt incomplete')
    }
  }
}

function assertAutomaticCompactionEvidence(results, evidence, gatewayCapture) {
  assertS0Evidence(results, evidence, 3)
  if (evidence.manualCompactions.length !== 0) {
    throw new Error('automatic compaction must not create a manual binding')
  }
  for (const item of evidence.threads) {
    const live = results.find((result) => result.scopeId === item.scopeId)
    if (!live || live.longContextCharacters !== 464000) {
      throw new Error('automatic compaction long-context fixture mismatch')
    }
    if (item.canonicalUserMessageCount !== 3
      || item.canonicalAssistantMessageCount !== 3
      || item.remainingFenceCount !== 0) {
      throw new Error('automatic compaction changed canonical history or left a fence')
    }
    const observedTurns = item.turns.filter((turn) => (
      Array.isArray(turn.automaticCompactionExchanges) && turn.automaticCompactionExchanges.length > 0
    ))
    if (observedTurns.length !== 1) {
      throw new Error('automatic compaction must be observed in exactly one product turn')
    }
    const observed = observedTurns[0]
    if (observed.automaticCompactionGatewayRequestCount !== 1
      || observed.automaticCompactionExchanges.length !== 1) {
      throw new Error('automatic compaction gateway exchange evidence mismatch')
    }
    const compaction = observed.automaticCompactionExchanges[0]
    if (compaction.threadId !== item.codexThreadId
      || compaction.turnId !== observed.codexTurnId
      || !compaction.threadReadDigest
      || !compaction.automaticRequestReceiptId
      || !compaction.automaticResponseEvidenceDigest
      || !compaction.successorProductRequestReceiptId
      || !compaction.successorProductResponseEvidenceDigest) {
      throw new Error('automatic compaction readback identity incomplete')
    }
    if (item.turns.some((turn) => turn !== observed
      && (turn.automaticCompactionGatewayRequestCount !== 0
        || (turn.automaticCompactionExchanges?.length || 0) !== 0))) {
      throw new Error('automatic compaction evidence leaked into another turn')
    }
    const exchanges = evidence.gatewayExchanges
      .filter((receipt) => receipt.scopeId === item.scopeId)
    const automatic = exchanges.find((entry) => (
      entry.receiptId === compaction.automaticRequestReceiptId
    ))
    const successor = exchanges.find((entry) => (
      entry.receiptId === compaction.successorProductRequestReceiptId
    ))
    if (!automatic || !successor
      || automatic.requestKind !== 'automatic_compaction'
      || successor.requestKind !== 'product'
      || automatic.readyRunId !== observed.readyRunId
      || successor.readyRunId !== observed.readyRunId
      || automatic.codexThreadId !== item.codexThreadId
      || successor.codexThreadId !== item.codexThreadId
      || automatic.codexTurnId !== observed.codexTurnId
      || successor.codexTurnId !== observed.codexTurnId
      || automatic.requestSequence !== compaction.automaticRequestSequence
      || automatic.responseSequence !== compaction.automaticResponseSequence
      || successor.requestSequence !== compaction.successorProductRequestSequence
      || successor.responseSequence !== compaction.successorProductResponseSequence
      || automatic.requestEvidenceDigest !== compaction.automaticRequestEvidenceDigest
      || automatic.responseEvidenceDigest !== compaction.automaticResponseEvidenceDigest
      || successor.requestEvidenceDigest !== compaction.successorProductRequestEvidenceDigest
      || successor.responseEvidenceDigest !== compaction.successorProductResponseEvidenceDigest
      || !(automatic.requestSequence < automatic.responseSequence
        && automatic.responseSequence < successor.requestSequence
        && successor.requestSequence < successor.responseSequence)
      || successor.inputTotalStringCharacters >= automatic.inputTotalStringCharacters) {
      throw new Error('automatic compaction durable exchange identity mismatch')
    }
  }
  if (!Array.isArray(gatewayCapture) || gatewayCapture.length !== 4) {
    throw new Error('automatic compaction requires three product captures and one compact capture')
  }
  const products = gatewayCapture.filter((entry) => entry.requestKind === 'product')
  const compactions = gatewayCapture.filter((entry) => entry.requestKind === 'automatic_compaction')
  if (products.length !== 3 || compactions.length !== 1
    || gatewayCapture.some((entry) => entry.requestKind === 'manual_compaction')) {
    throw new Error('automatic compaction gateway capture kind mismatch')
  }
  const threadIds = new Set(gatewayCapture.map((entry) => entry.threadId))
  if (threadIds.size !== 1 || compactions[0].toolCount !== 0 || compactions[0].toolNames.length !== 0
    || products.some((entry) => entry.toolCount < 1 || entry.readyResourceReferenceCount !== 0)) {
    throw new Error('automatic compaction gateway capture routing or tool surface mismatch')
  }
  const maxInputCharacters = (entry) => Math.max(
    0, ...entry.inputItems.map((item) => item.maxStringCharacters),
  )
  if (maxInputCharacters(products[0]) < 460000
    || maxInputCharacters(compactions[0]) < 460000
    || maxInputCharacters(products[1]) >= 100000
    || maxInputCharacters(products[2]) >= 100000) {
    throw new Error('automatic compaction did not replace the original long context')
  }
  if (gatewayCapture.some((entry) => entry.proofSentinelDigest !== gatewayCapture[0].proofSentinelDigest)
    || products[0].proofSentinelOccurrences < 2
    || compactions[0].proofSentinelOccurrences < 2
    || products[1].proofSentinelOccurrences < 1
    || products[2].proofSentinelOccurrences < 1) {
    throw new Error('automatic compaction sentinel continuity capture mismatch')
  }
}

function readGatewayCapture(path) {
  if (!existsSync(path)) throw new Error('automatic compaction gateway capture missing')
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
}

function assertManualCompactionEvidence(results, evidence, gatewayCapture) {
  assertS0Evidence(results, evidence, 3)
  if (results.length !== 1) {
    throw new Error('manual restart proof requires one isolated app process per case')
  }
  if (!Array.isArray(evidence.manualCompactions)
    || evidence.manualCompactions.length !== results.length) {
    throw new Error('manual compaction evidence count mismatch')
  }
  const liveByScope = new Map(results.map((item) => [item.scopeId, item]))
  for (const item of evidence.manualCompactions) {
    const live = liveByScope.get(item.scopeId)
    if (!live
      || live.activeCompact?.ok !== false
      || live.activeCompact?.action !== 'manual_compact'
      || live.activeCompact?.code !== 'thread_busy'
      || live.activeCompact?.preserveUi !== true
      || !String(live.activeCompact?.evidenceDigest || '').trim()
      || live.compact.manualCompactionId !== item.manualCompactionId
      || live.compact.codexTurnId !== item.codexCompactionTurnId
      || live.compact.contextCompactionItemId !== item.contextCompactionItemId
      || live.compact.threadReadDigest !== item.threadReadDigest
      || live.post?.ok !== true
      || live.recall?.ok !== true
      || live.recall.finalText !== `${live.sentinel}|${live.postSentinel}`
      || item.expectedToolsDigest !== sha256Json([])
      || !item.preDispatchThreadReadDigest
      || !item.preDispatchTurnIdsDigest
      || !item.notificationContextCompactionItemId
      || item.terminalStatus !== 'completed'
      || !item.gatewayRequestReceiptId
      || !item.gatewayRequestEvidenceDigest
      || !item.gatewayResponseEvidenceDigest
      || !item.consumedAt
      || !item.consumeEvidenceDigest
      || item.abandonedAt
      || item.unknownAt
      || item.attemptCount !== 1
      || !item.attemptId
      || !item.rpcId
      || !item.requestDigest
      || !item.dispatchIntentAt
      || !item.childWriteAttemptedAt
      || !item.childWriteConfirmedAt
      || !item.childWriteDigest
      || item.unresolvedAt
      || item.unresolvedReason
      || item.responseKind !== 'accepted'
      || !item.responseDigest
      || !item.responseAt
      || item.provenAbsentAt
      || item.provenAbsentReason
      || item.provenAbsentEvidenceDigest
      || item.gatewayRequestCount !== 1
      || item.remainingFenceCount !== 0) {
      throw new Error('manual compaction durable evidence incomplete')
    }
    const preDispatchTurnIds = JSON.parse(item.preDispatchTurnIdsJson || 'null')
    if (!Array.isArray(preDispatchTurnIds) || preDispatchTurnIds.length !== 1
      || sha256Json(preDispatchTurnIds) !== item.preDispatchTurnIdsDigest) {
      throw new Error('manual compaction pre-dispatch readback identity incomplete')
    }
    const thread = evidence.threads.find((candidate) => candidate.scopeId === item.scopeId)
    const turns = [...(thread?.turns || [])].sort((left, right) => (
      String(left.createdAt).localeCompare(String(right.createdAt))
    ))
    const oldLease = evidence.processLeases.find((lease) => (
      lease.processLeaseId === live.restart?.oldProcessLeaseId
    ))
    const newLease = evidence.processLeases.find((lease) => (
      lease.processLeaseId === live.restart?.newProcessLeaseId
    ))
    const resumes = evidence.resumeEvidence.filter((resume) => resume.scopeId === item.scopeId)
    if (!thread || thread.codexThreadId !== item.codexThreadId
      || turns.length !== 3
      || turns[0].turnStartConnectionEpoch !== live.restart?.oldConnectionEpoch
      || turns[1].turnStartConnectionEpoch !== live.restart?.oldConnectionEpoch
      || turns[2].turnStartConnectionEpoch !== live.restart?.newConnectionEpoch
      || item.connectionEpoch !== live.restart?.oldConnectionEpoch
      || !oldLease?.closedAt || !oldLease.treeZeroAt || !oldLease.treeZeroEvidenceDigest
      || oldLease.pid !== live.restart?.oldPid
      || oldLease.processGroupId !== live.restart?.oldProcessGroupId
      || oldLease.processStartIdentity !== live.restart?.oldProcessStartIdentity
      || oldLease.binarySha256 !== live.restart?.oldBinarySha256
      || oldLease.executablePath !== live.restart?.oldExecutablePath
      || oldLease.sidecarSpawnInstanceId !== live.restart?.oldSidecarSpawnInstanceId
      || newLease?.pid !== live.restart?.newPid
      || newLease?.processGroupId !== live.restart?.newProcessGroupId
      || newLease?.processStartIdentity !== live.restart?.newProcessStartIdentity
      || newLease?.binarySha256 !== live.restart?.newBinarySha256
      || newLease?.executablePath !== live.restart?.newExecutablePath
      || newLease?.connectionEpoch !== live.restart?.newConnectionEpoch
      || newLease?.sidecarSpawnInstanceId !== live.restart?.newSidecarSpawnInstanceId
      || !newLease?.connectionOpenedAt
      || resumes.length !== 1
      || resumes[0].threadBindingId !== thread.threadBindingId
      || resumes[0].codexThreadId !== thread.codexThreadId
      || resumes[0].connectionEpoch !== live.restart?.newConnectionEpoch
      || !resumes[0].preResumeThreadReadDigest
      || !resumes[0].resumedThreadDigest
      || !resumes[0].evidenceDigest
      || !resumes[0].recordedAt
      || oldLease.processLeaseId === newLease.processLeaseId
      || oldLease.connectionEpoch === newLease.connectionEpoch) {
      throw new Error('manual compaction restart/resume evidence incomplete')
    }
    const liveFinals = [live.before?.finalText, live.post?.finalText, live.recall?.finalText]
    if (live.ingress.length !== 3
      || liveFinals.some((value) => typeof value !== 'string')
      || turns.some((turn, index) => (
        turn.readyRunId !== live.ingress[index]?.requestId
        || turn.candidateText !== liveFinals[index]
        || turn.canonicalMessageText !== liveFinals[index]
      ))
      || turns[2].candidateText !== `${live.sentinel}|${live.postSentinel}`
      || preDispatchTurnIds[0] !== turns[0].codexTurnId) {
      throw new Error('manual compaction live final or turn identity mismatch')
    }
    const expectedResponsesTools = thread.toolSurfaceJson.responsesTools
    const expectedToolNames = expectedResponsesTools.map((tool) => tool.name)
    const expectedToolsDigest = sha256CanonicalJson(expectedResponsesTools)
    if (thread.toolSurfaceDigest !== expectedToolsDigest) {
      throw new Error('manual compaction frozen tool surface digest mismatch')
    }
    const exchanges = evidence.gatewayExchanges.filter((entry) => entry.scopeId === item.scopeId)
    const manual = exchanges.find((entry) => entry.requestKind === 'manual_compaction')
    const productExchanges = exchanges.filter((entry) => entry.requestKind === 'product')
    if (exchanges.length !== 4
      || exchanges.map((entry) => entry.requestKind).join(',')
        !== 'product,manual_compaction,product,product'
      || exchanges.some((entry) => !entry.requestEvidenceDigest
        || !entry.responseEvidenceDigest
        || !entry.responseId
        || !entry.responseTerminalDigest
        || !entry.responseOutputDigest
        || !entry.responseUsageDigest
        || !(entry.requestSequence < entry.responseSequence))
      || new Set(exchanges.map((entry) => entry.codexThreadId)).size !== 1
      || new Set(exchanges.map((entry) => entry.upstreamProfileSnapshotDigest)).size !== 1
      || manual?.receiptId !== item.gatewayRequestReceiptId
      || manual.codexTurnId !== item.codexCompactionTurnId
      || manual.requestEvidenceDigest !== item.gatewayRequestEvidenceDigest
      || manual.responseEvidenceDigest !== item.gatewayResponseEvidenceDigest
      || manual.toolCount !== 0
      || manual.toolsDigest !== sha256Json([])
      || productExchanges.length !== 3
      || productExchanges.some((entry, index) => (
        entry.readyRunId !== turns[index].readyRunId
        || entry.codexTurnId !== turns[index].codexTurnId
        || entry.toolsDigest !== expectedToolsDigest
        || entry.toolCount !== expectedResponsesTools.length
      ))
      || exchanges.slice(0, -1).some((entry, index) => (
        entry.responseSequence >= exchanges[index + 1].requestSequence
      ))) {
      throw new Error('manual compaction Gateway request/response evidence mismatch')
    }
    if (!Array.isArray(gatewayCapture) || gatewayCapture.length !== 4
      || gatewayCapture.map((entry) => entry.requestKind).join(',')
        !== 'product,manual_compaction,product,product'
      || gatewayCapture.some((entry, index) => (
        entry.threadId !== thread.codexThreadId
        || entry.requestDigest !== exchanges[index].requestDigest
        || entry.inputDigest !== exchanges[index].inputDigest
      ))
      || gatewayCapture[1].toolCount !== 0
      || gatewayCapture[1].toolNames.length !== 0
      || gatewayCapture[1].toolsDigest !== sha256Json([])) {
      throw new Error('manual compaction Gateway capture mismatch')
    }
    const productCaptures = gatewayCapture.filter((entry) => entry.requestKind === 'product')
    assertManualGatewayCaptureTurnIdentities({
      gatewayCapture,
      productTurns: turns,
      manualCompactionTurnId: item.codexCompactionTurnId,
    })
    if (productCaptures.length !== 3 || productCaptures.some((entry, index) => (
      entry.readyRunId !== turns[index].readyRunId
      || entry.toolsDigest !== expectedToolsDigest
      || entry.toolCount !== expectedResponsesTools.length
      || JSON.stringify(entry.toolNames) !== JSON.stringify(expectedToolNames)
    ))) {
      throw new Error('manual compaction exact product tool or turn capture mismatch')
    }
    const sentinelDigests = [sha256Json(live.sentinel), sha256Json(live.postSentinel)]
    const occurrences = (entry, digest) => entry.proofSentinels
      .find((sentinel) => sentinel.digest === digest)?.occurrences ?? -1
    if (gatewayCapture.some((entry) => (
      !Array.isArray(entry.proofSentinels)
      || entry.proofSentinels.length !== 2
      || entry.proofSentinels.some((sentinel, index) => sentinel.digest !== sentinelDigests[index])
    ))
      || occurrences(gatewayCapture[0], sentinelDigests[0]) < 1
      || occurrences(gatewayCapture[0], sentinelDigests[1]) !== 0
      || occurrences(gatewayCapture[1], sentinelDigests[0]) < 1
      || occurrences(gatewayCapture[1], sentinelDigests[1]) !== 0
      || occurrences(gatewayCapture[2], sentinelDigests[0]) < 1
      || occurrences(gatewayCapture[2], sentinelDigests[1]) < 1
      || occurrences(gatewayCapture[3], sentinelDigests[0]) < 1
      || occurrences(gatewayCapture[3], sentinelDigests[1]) < 1) {
      throw new Error('manual compaction two-sentinel provider transcript mismatch')
    }
  }
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

function assertHandshake(value) {
  if (!value?.success || value.proofNonce !== proofNonce) throw new Error('runtime handshake failed')
  if (value.sourceManifestDigest !== sourceManifest.digest) throw new Error('embedded source manifest mismatch')
  if (value.execPath !== executablePath || value.execSha256 !== sha256File(executablePath)) {
    throw new Error('runtime executable identity mismatch')
  }
  if (!useDevelopmentRuntime) {
    if (!value.asarPath || value.asarSha256 !== sha256File(value.asarPath)) {
      throw new Error('runtime asar identity mismatch')
    }
  } else if (value.asarPath || value.asarSha256) {
    throw new Error('development runtime unexpectedly reported a packaged asar')
  }
  if (value.userDataPath !== profilePath || value.databasePath !== databasePath) {
    throw new Error('runtime isolation path mismatch')
  }
}

async function enableHarness(cdp, remotePort) {
  const stableDeadline = Date.now() + 30_000
  while (Date.now() < stableDeadline) {
    try {
      if (await evaluate(cdp, `document.readyState === 'complete' && Boolean(window.electronAPI)`, 2_000)) break
    } catch {}
    await delay(250)
  }
  await delay(1_000)
  await evaluate(cdp, `(() => { localStorage.setItem('ready.agentPanelTest', '1'); return true })()`)
  await cdp.send('Page.reload', { ignoreCache: false })
  const deadline = Date.now() + 30_000
  let active = cdp
  while (Date.now() < deadline) {
    try {
      if (await evaluate(active, `Boolean(window.__READY_AGENT_TEST__?.submit && window.electronAPI?.agent)`, 2_000)) {
        return active
      }
    } catch {
      active.close()
      const target = await waitForRendererTarget(remotePort, 10_000)
      active = await connect(target.webSocketDebuggerUrl)
    }
    await delay(250)
  }
  throw new Error('packaged agent harness unavailable')
}

function findExecutable() {
  const candidates = [
    resolve(root, 'exports/mac-arm64/Ready.app/Contents/MacOS/Ready'),
    resolve(root, 'exports/mac/Ready.app/Contents/MacOS/Ready'),
  ]
  const found = candidates.find(existsSync)
  if (!found) throw new Error(`packaged Ready executable not found: ${candidates.join(', ')}`)
  return found
}

function findDevelopmentExecutable() {
  const candidate = resolve(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  if (!existsSync(candidate)) throw new Error(`development Electron executable not found: ${candidate}`)
  return candidate
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
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Runtime.evaluate timed out')), timeoutMs) }),
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

function readSidecarProcessLeases(path) {
  const raw = execFileSync('sqlite3', ['-json', path, `
    SELECT process_lease_id AS processLeaseId,
      owner_main_pid AS ownerMainPid,
      sidecar_spawn_instance_id AS sidecarSpawnInstanceId,
      connection_epoch AS connectionEpoch,
      binary_sha256 AS binarySha256,
      pid,
      process_group_id AS processGroupId,
      process_start_identity AS processStartIdentity,
      executable_path AS executablePath,
      isolated_state_dir AS isolatedStateDir,
      connection_opened_at AS connectionOpenedAt,
      closed_at AS closedAt,
      tree_zero_at AS treeZeroAt,
      tree_zero_evidence_digest AS treeZeroEvidenceDigest
      FROM codex_sidecar_process_leases
     ORDER BY spawn_intent_at;
  `], { encoding: 'utf8' }).trim()
  return raw ? JSON.parse(raw) : []
}

function processMarkerValue(command, key) {
  const prefix = `${key}=`
  const start = command.indexOf(prefix)
  if (start < 0) return null
  const rest = command.slice(start + prefix.length)
  const boundary = /\s[A-Z_][A-Z0-9_]*=/.exec(rest)
  return (boundary ? rest.slice(0, boundary.index) : rest).trim() || null
}

function readCurrentProcesses() {
  const output = execFileSync('/bin/ps', [
    'axeww',
    '-o',
    'pid=,ppid=,pgid=,lstart=,command=',
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return parseMacProcessRows(output).map((entry) => ({
    ...entry,
    markers: {
      processLeaseId: processMarkerValue(entry.command, 'READY_CODEX_PROCESS_LEASE_ID'),
      sidecarSpawnInstanceId: processMarkerValue(entry.command, 'READY_CODEX_SIDECAR_SPAWN_INSTANCE_ID'),
      connectionEpoch: processMarkerValue(entry.command, 'READY_CODEX_CONNECTION_EPOCH'),
      stateDir: processMarkerValue(entry.command, 'READY_CODEX_STATE_DIR'),
    },
  }))
}

function verifyOwnedSidecarProcess(lease, ownerMainPid, userDataPath) {
  const processes = readCurrentProcesses()
  const runner = processes.find((entry) => entry.pid === process.pid)
  const ownerMain = processes.find((entry) => entry.pid === ownerMainPid)
  if (!runner || !ownerMain) throw new Error('manual restart owner process identity unavailable')
  const candidates = processes.filter((entry) => (
    entry.markers.processLeaseId === lease.processLeaseId
  ))
  if (candidates.length !== 1) {
    throw new Error('manual restart owned sidecar process is not unique')
  }
  const processRow = candidates[0]
  const expectedStateDir = resolve(userDataPath, 'codex-runtime')
  if (lease.ownerMainPid !== ownerMainPid
    || lease.isolatedStateDir !== expectedStateDir
    || !Number.isSafeInteger(lease.pid) || lease.pid <= 1
    || lease.pid !== processRow.pid
    || lease.processGroupId !== processRow.processGroupId
    || lease.processStartIdentity !== processRow.processStartIdentity
    || lease.executablePath !== processRow.executablePath
    || lease.binarySha256 !== sha256File(processRow.executablePath)
    || processRow.parentPid !== ownerMainPid
    || processRow.pid !== processRow.processGroupId
    || processRow.pid === process.pid
    || processRow.pid === ownerMainPid
    || processRow.processGroupId === runner.processGroupId
    || processRow.processGroupId === ownerMain.processGroupId
    || processRow.markers.sidecarSpawnInstanceId !== lease.sidecarSpawnInstanceId
    || processRow.markers.connectionEpoch !== lease.connectionEpoch
    || processRow.markers.stateDir !== expectedStateDir
    || !String(lease.connectionOpenedAt || '').trim()) {
    throw new Error('manual restart live sidecar OS identity mismatch')
  }
  return processRow
}

async function restartIsolatedSidecar(path, ownerMainPid, userDataPath) {
  const beforeRows = readSidecarProcessLeases(path)
  const before = beforeRows.filter((row) => !row.treeZeroAt)
  if (before.length !== 1) throw new Error('manual restart requires exactly one live sidecar lease')
  const old = before[0]
  const ownedOldProcess = verifyOwnedSidecarProcess(old, ownerMainPid, userDataPath)
  try {
    process.kill(-ownedOldProcess.processGroupId, 'SIGKILL')
  } catch (error) {
    throw new Error(`manual restart sidecar kill failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const rows = readSidecarProcessLeases(path)
    const settledOld = rows.find((row) => row.processLeaseId === old.processLeaseId)
    const live = rows.filter((row) => !row.treeZeroAt)
    if (settledOld?.closedAt && settledOld.treeZeroAt && settledOld.treeZeroEvidenceDigest
      && live.length === 1 && live[0].processLeaseId !== old.processLeaseId
      && live[0].ownerMainPid === ownerMainPid
      && live[0].isolatedStateDir === old.isolatedStateDir
      && live[0].executablePath === old.executablePath
      && live[0].pid !== old.pid && live[0].processGroupId === live[0].pid
      && live[0].connectionEpoch !== old.connectionEpoch
      && live[0].sidecarSpawnInstanceId !== old.sidecarSpawnInstanceId
      && String(live[0].connectionOpenedAt || '').trim()) {
      const ownedNewProcess = verifyOwnedSidecarProcess(live[0], ownerMainPid, userDataPath)
      await delay(3_000)
      return {
        oldProcessLeaseId: old.processLeaseId,
        oldSidecarSpawnInstanceId: old.sidecarSpawnInstanceId,
        oldConnectionEpoch: old.connectionEpoch,
        oldPid: old.pid,
        oldProcessGroupId: old.processGroupId,
        oldProcessStartIdentity: ownedOldProcess.processStartIdentity,
        oldExecutablePath: ownedOldProcess.executablePath,
        oldBinarySha256: sha256File(ownedOldProcess.executablePath),
        oldClosedAt: settledOld.closedAt,
        oldTreeZeroAt: settledOld.treeZeroAt,
        oldTreeZeroEvidenceDigest: settledOld.treeZeroEvidenceDigest,
        newProcessLeaseId: live[0].processLeaseId,
        newSidecarSpawnInstanceId: live[0].sidecarSpawnInstanceId,
        newConnectionEpoch: live[0].connectionEpoch,
        newPid: live[0].pid,
        newProcessGroupId: live[0].processGroupId,
        newProcessStartIdentity: ownedNewProcess.processStartIdentity,
        newExecutablePath: ownedNewProcess.executablePath,
        newBinarySha256: sha256File(ownedNewProcess.executablePath),
        newConnectionOpenedAt: live[0].connectionOpenedAt,
      }
    }
    await delay(250)
  }
  throw new Error('manual restart sidecar did not recover with a fresh lease')
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
