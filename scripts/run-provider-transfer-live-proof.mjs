#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'

const require = createRequire(import.meta.url)
const { buildSourceManifest, sha256File } = require('./browser-live-proof-manifest.cjs')
const root = process.cwd()
const suppliedProfile = process.env.READY_BROWSER_LIVE_ACCEPTANCE_PROFILE?.trim()
if (!suppliedProfile) throw new Error('READY_BROWSER_LIVE_ACCEPTANCE_PROFILE is required')
const seedProfile = realpathSync(resolve(suppliedProfile))
if (seedProfile === resolve(homedir(), 'Library/Application Support/Ready')) {
  throw new Error('daily Ready profile is forbidden for provider transfer proof')
}
if (!existsSync(join(seedProfile, 'ready.db'))) throw new Error('dedicated acceptance profile has no ready.db')

const skipBuild = process.env.READY_LIVE_SKIP_BUILD === '1'
const embeddedManifestPath = resolve(root, 'build/browser-live-proof/source-manifest.json')
const sourceManifest = skipBuild
  ? JSON.parse(readFileSync(embeddedManifestPath, 'utf8'))
  : buildSourceManifest(root)
if (!skipBuild) {
  mkdirSync(dirname(embeddedManifestPath), { recursive: true })
  writeFileSync(embeddedManifestPath, `${JSON.stringify(sourceManifest, null, 2)}\n`)
  await run('npm', ['run', 'build:dir'])
}

const proofId = randomBytes(20).toString('hex')
const runRoot = resolve(root, 'outputs/provider-transfer-live-proof', proofId)
const profilePath = resolve(runRoot, 'profile')
const tempPath = resolve(runRoot, 'tmp')
mkdirSync(runRoot, { recursive: true })
cpSync(seedProfile, profilePath, { recursive: true, force: true })
mkdirSync(tempPath, { recursive: true })
const databasePath = resolve(profilePath, 'ready.db')
const reportPath = resolve(runRoot, 'provider-transfer-report.json')
const fixture = await startFixtureServer()
configureProvider(fixture.baseUrl)

const executablePath = findExecutable()
const nonce = randomBytes(24).toString('hex')
const runtime = await launchReady(nonce, 9650 + Number.parseInt(proofId.slice(0, 3), 16) % 250)
let live
try {
  live = await evaluate(runtime.client, scenarioExpression(fixture.pageUrl), 180_000)
} finally {
  await runtime.close()
  fixture.server.close()
}
if (!live?.scopeId || !live?.taskId || !live?.runId) throw new Error(`provider transfer scenario did not bind a target run: ${JSON.stringify(live)}`)

const projection = sqlRows(`SELECT task_id, scope_id, run_id, status, interaction_state, waiting_for,
  blocked_reason, continuation_ref_json, checkpoint_refs_json FROM task_projections
  WHERE task_id = ${sqlQuote(live.taskId)} LIMIT 1`)[0]
const runMeta = sqlRows(`SELECT run_id, task_id, scope_id, status, terminal_reason, continuation_ref_json,
  provider_diagnostics_json FROM run_meta WHERE run_id = ${sqlQuote(live.runId)} LIMIT 1`)[0]
const canonical = sqlRows(`SELECT id, conversation_id, content, timestamp, meta_json FROM chat_messages
  WHERE conversation_id = ${sqlQuote(live.scopeId)} AND role = 'assistant'
  ORDER BY timestamp DESC LIMIT 1`)[0]
const doneEvent = [...(live.streamEvents || [])].reverse().find((event) => event.type === 'done')
const metricsPath = runtime.rawHandshake.metricsPath
if (!metricsPath || !existsSync(metricsPath)) throw new Error('runtime metrics file missing')
const metrics = readTargetMetrics(metricsPath, live.runId)
const visibleCanonical = (live.visibleMessages || []).filter((message) => message.id === canonical?.id)
const report = {
  ok: true,
  generatedAt: new Date().toISOString(),
  sourceManifest,
  handshake: normalizeHandshake(runtime.rawHandshake, nonce),
  paths: { runRoot, profilePath, databasePath, tempPath, reportPath },
  fixture: { endpoint: fixture.redactedEndpoint, toolBoundaryDelivered: fixture.toolBoundaryDelivered(),
    requestCount: fixture.requests.length, requests: fixture.requests },
  scopeId: live.scopeId,
  runId: live.runId,
  taskId: live.taskId,
  sendResult: live.sendResult,
  projection,
  runMeta,
  canonical: canonical ? { ...canonical, doneMessageId: doneEvent?.canonicalMessageId || null, doneDigest: doneEvent?.canonicalMessageDigest || null } : null,
  visibleCanonical,
  taskCards: live.taskCards,
  metrics: { sourcePath: metricsPath, ...metrics },
  live: { ok: live.ok === true, streamEvents: live.streamEvents, events: live.events },
}
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
const validation = await run(process.execPath, ['scripts/check-provider-transfer-live-proof-report.cjs', reportPath], true)
process.stdout.write(`${JSON.stringify({ ok: true, reportPath, validation }, null, 2)}\n`)

function configureProvider(baseUrl) {
  const config = JSON.parse(sqlValue("SELECT value FROM settings WHERE key = 'ai_model_config'"))
  const saved = JSON.parse(sqlValue("SELECT value FROM settings WHERE key = 'ai_saved_configs'"))
  const fixtureConfig = {
    ...config,
    provider: 'openai-compatible',
    baseUrl,
    apiKey: 'ready-provider-transfer-proof',
    model: 'ready-502-model',
    agentProtocol: 'openai',
    toolUseMode: 'on',
    capabilityModes: { ...(config.capabilityModes || {}), browser_interaction: 'on' },
  }
  saved['openai-compatible'] = fixtureConfig
  sqlExec(`UPDATE settings SET value = ${sqlQuote(JSON.stringify(fixtureConfig))}, updated_at = ${sqlQuote(new Date().toISOString())} WHERE key = 'ai_model_config'`)
  sqlExec(`UPDATE settings SET value = ${sqlQuote(JSON.stringify(saved))}, updated_at = ${sqlQuote(new Date().toISOString())} WHERE key = 'ai_saved_configs'`)
}

function scenarioExpression(pageUrl) {
  const prompt = '请使用当前浏览器页面读取标题和正文，并告诉我页面中的验收标记。必须通过 Browser 工具完成，不要改用通用网页搜索。'
  return `(async () => {
    const agent = window.electronAPI?.agent
    const browser = window.electronAPI?.browser
    const waitFor = async (read, timeoutMs = 150000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const value = await read()
        if (value) return value
        await new Promise((resolveWait) => setTimeout(resolveWait, 200))
      }
      return null
    }
    const harness = await waitFor(() => window.__READY_AGENT_TEST__?.submit ? window.__READY_AGENT_TEST__ : null, 10000)
    if (!agent || !browser?.createTab || !harness) return { ok: false, error: 'live APIs unavailable' }
    document.querySelector('button[data-mode="browser"]')?.click()
    await new Promise((resolveWait) => setTimeout(resolveWait, 400))
    document.querySelector('button[title="展开聊天面板"]')?.click()
    const tab = await browser.createTab(${JSON.stringify(pageUrl)}, { background: true })
    await browser.switchTab(tab.tabId)
    if (!harness.sessionSummary().activeSessionId) await harness.createVisibleSession()
    else await harness.newSession()
    harness.clearEvents()
    const streamEvents = []
    const off = agent.onStream((event) => streamEvents.push({
      type: event.type, runId: event.runId || null, sessionId: event.sessionId || null,
      canonicalMessageId: event.canonicalMessage?.id || null,
      canonicalMessageDigest: event.canonicalMessageDigest || null,
    }))
    const result = await harness.submit(${JSON.stringify(prompt)}, {
      mode: 'dom', allowStoreFallback: false, timeoutMs: 150000, pollMs: 250,
    })
    const snapshot = await harness.snapshot()
    const scopeId = snapshot.currentScopeId
    const projectionsResult = scopeId ? await agent.listTaskProjections(scopeId) : null
    const projections = projectionsResult?.success ? projectionsResult.data : []
    const projection = projections.find((item) => !item.parentTaskId) || projections[0] || null
    const settled = await waitFor(async () => {
      const current = projection?.taskId ? await agent.getTaskProjection(projection.taskId) : null
      const data = current?.success ? current.data : null
      return data?.blockedReason === 'browser_provider_transfer_checkpoint' ? data : null
    }, 30000)
    const after = await harness.snapshot()
    off()
    return {
      ok: Boolean(settled && scopeId && projection?.taskId && projection?.runId),
      scopeId, taskId: projection?.taskId || null, runId: projection?.runId || snapshot.run?.requestId || null,
      sendResult: result.sendResult || { observed: true, inputMode: result.inputMode,
        canonicalDoneObserved: streamEvents.some((event) => event.type === 'done' && event.canonicalMessageId) },
      visibleMessages: after.messages, taskCards: after.taskCards,
      streamEvents, events: harness.events(), settled,
    }
  })()`
}

async function startFixtureServer() {
  const requests = []
  let deliveredToolBoundary = false
  const server = createServer((request, response) => {
    if (request.url === '/page') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><title>Provider Transfer Proof</title><main data-proof="provider-transfer">controlled page</main>')
      return
    }
    const path = String(request.url || '').replace(/\?.*$/, '')
    if (!deliveredToolBoundary && path.endsWith('/chat/completions')) {
      deliveredToolBoundary = true
      requests.push({ method: request.method, path, status: 200, kind: 'browser_tool_boundary' })
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
      const chunks = [
        { id: 'chatcmpl-provider-transfer-proof', choices: [{ delta: { tool_calls: [{ index: 0,
          id: 'call-provider-transfer-browser-read', type: 'function',
          function: { name: 'browser_read', arguments: '{}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
      ]
      for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`)
      response.end('data: [DONE]\n\n')
      return
    }
    requests.push({ method: request.method, path, status: 502, kind: 'controlled_upstream_failure' })
    response.writeHead(502, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'controlled upstream unavailable', type: 'upstream_error' } }))
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('provider fixture unavailable')
  const origin = `http://127.0.0.1:${address.port}`
  return { server, requests, toolBoundaryDelivered: () => deliveredToolBoundary,
    baseUrl: `${origin}/v1`, pageUrl: `${origin}/page`, redactedEndpoint: 'http://127.0.0.1:<ephemeral>/v1' }
}

async function launchReady(proofNonce, port) {
  const logs = []
  const child = spawn(executablePath, [`--remote-debugging-port=${port}`], {
    cwd: root,
    env: { ...process.env, TMPDIR: tempPath, READY_BROWSER_LIVE_PROOF_NONCE: proofNonce,
      READY_DB_PATH: databasePath, READY_REMOTE_DEBUGGING_PORT: String(port), READY_USER_DATA_DIR: profilePath },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => pushLogs(logs, chunk))
  child.stderr.on('data', (chunk) => pushLogs(logs, chunk))
  try {
    const target = await waitForRendererTarget(port, 90000)
    const client = await connect(target.webSocketDebuggerUrl)
    const rawHandshake = await evaluate(client, `window.electronAPI.app.browserLiveProofHandshake(${JSON.stringify(proofNonce)})`)
    assertHandshake(rawHandshake, proofNonce)
    await enableHarness(client)
    return { child, client, rawHandshake, logs, close: async () => {
      client.close(); child.kill('SIGTERM'); await waitForExit(child, 10000)
    } }
  } catch (error) {
    child.kill('SIGTERM'); await waitForExit(child, 10000)
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs.slice(-80).join('\n')}`)
  }
}

function normalizeHandshake(handshake, proofNonce) {
  return { ok: handshake?.success === true, nonce: proofNonce, executablePath: handshake?.execPath,
    executableSha256: handshake?.execSha256, asarPath: handshake?.asarPath, asarSha256: handshake?.asarSha256,
    manifestDigest: handshake?.sourceManifestDigest, profilePath: handshake?.userDataPath,
    databasePath: handshake?.databasePath, metricsPath: handshake?.metricsPath,
    bootIncarnationId: handshake?.bootIncarnationId, appVersion: handshake?.appVersion }
}

function assertHandshake(handshake, proofNonce) {
  if (!handshake?.success || handshake.proofNonce !== proofNonce) throw new Error('runtime handshake failed')
  if (!skipBuild && handshake.sourceManifestDigest !== sourceManifest.digest) throw new Error('embedded source manifest mismatch')
  if (handshake.execPath !== executablePath || handshake.execSha256 !== sha256File(executablePath)) throw new Error('runtime executable mismatch')
  if (!handshake.asarPath || handshake.asarSha256 !== sha256File(handshake.asarPath)) throw new Error('runtime asar mismatch')
  if (handshake.userDataPath !== profilePath || handshake.databasePath !== databasePath) throw new Error('runtime data path mismatch')
  if (handshake.metricsPath !== join(tempPath, 'ready-agent-metrics.log')) throw new Error('runtime metric path mismatch')
}

function readTargetMetrics(path, runId) {
  const target = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean).filter((event) => event.requestId === runId || event.runId === runId)
  const names = ['owner_local_runner_session_rebased', 'owner_local_session_source_cursor_mismatch',
    'renderer_done_without_canonical_terminal', 'renderer_send_success_without_canonical_terminal']
  return { matchedLines: target, counts: Object.fromEntries(names.map((name) => [name, target.filter((event) => event.metric === name).length])) }
}

function sqlRows(sql) {
  const raw = execFileSync('/usr/bin/sqlite3', ['-json', databasePath, sql], { encoding: 'utf8' }).trim()
  return raw ? JSON.parse(raw) : []
}
function sqlValue(sql) { return execFileSync('/usr/bin/sqlite3', [databasePath, sql], { encoding: 'utf8' }).trim() }
function sqlExec(sql) { execFileSync('/usr/bin/sqlite3', [databasePath, sql]) }
function sqlQuote(value) { return `'${String(value).replaceAll("'", "''")}'` }

function findExecutable() {
  const candidates = [resolve(root, 'exports/mac-arm64/Ready.app/Contents/MacOS/Ready'), resolve(root, 'exports/mac/Ready.app/Contents/MacOS/Ready')]
  const found = candidates.find(existsSync)
  if (!found) throw new Error(`packaged Ready executable not found: ${candidates.join(', ')}`)
  return found
}

async function enableHarness(client) {
  await evaluate(client, `(() => { localStorage.setItem('ready.agentPanelTest', '1'); return true })()`)
  await client.send('Page.reload', { ignoreCache: false })
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try { if (await evaluate(client, `Boolean(window.__READY_AGENT_TEST__?.submit && window.electronAPI?.agent)`)) return } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error('packaged agent harness did not initialize')
}

async function waitForRendererTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = response.ok ? await response.json() : []
      const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl
        && /\/index\.html(?:[?#].*)?$/.test(String(item.url || '')) && !/overlay/.test(String(item.url || '')))
      if (target) return target
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  }
  throw new Error('Ready renderer target unavailable')
}

async function connect(url) {
  const socket = new WebSocket(url)
  const pending = new Map(); let nextId = 0
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data); const item = pending.get(message.id)
    if (!item) return; pending.delete(message.id)
    if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result)
  })
  await new Promise((resolveOpen, rejectOpen) => { socket.addEventListener('open', resolveOpen, { once: true }); socket.addEventListener('error', rejectOpen, { once: true }) })
  return { send(method, params = {}) { return new Promise((resolveSend, rejectSend) => {
    const id = ++nextId; pending.set(id, { resolve: resolveSend, reject: rejectSend }); socket.send(JSON.stringify({ id, method, params }))
  }) }, close: () => socket.close() }
}

async function evaluate(client, expression, timeoutMs = 60000) {
  let timer
  try {
    const response = await Promise.race([client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Runtime.evaluate timed out')), timeoutMs) })])
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
    return response.result?.value
  } finally { if (timer) clearTimeout(timer) }
}

async function run(command, args, capture = false) {
  return new Promise((resolveRun, rejectRun) => {
    const output = []; const proc = spawn(command, args, { cwd: root, env: process.env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' })
    if (capture) { proc.stdout.on('data', (chunk) => output.push(String(chunk))); proc.stderr.on('data', (chunk) => output.push(String(chunk))) }
    proc.once('error', rejectRun)
    proc.once('exit', (code, signal) => code === 0 ? resolveRun(output.join('').trim())
      : rejectRun(new Error(`${command} ${args.join(' ')} failed code=${code} signal=${signal}\n${output.join('')}`)))
  })
}
function pushLogs(target, chunk) { target.push(...String(chunk).split(/\r?\n/).filter(Boolean)); if (target.length > 500) target.splice(0, target.length - 500) }
async function waitForExit(proc, timeoutMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  await new Promise((resolveWait) => { const timer = setTimeout(resolveWait, timeoutMs); proc.once('exit', () => { clearTimeout(timer); resolveWait() }) })
}
