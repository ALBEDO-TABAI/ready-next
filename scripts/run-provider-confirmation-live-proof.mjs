#!/usr/bin/env node

import { spawn, execFileSync } from 'node:child_process'
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
const dailyProfile = resolve(homedir(), 'Library/Application Support/Ready')
if (seedProfile === dailyProfile) throw new Error('daily Ready profile is forbidden for provider confirmation proof')
if (!existsSync(join(seedProfile, 'ready.db'))) throw new Error('dedicated acceptance profile has no ready.db provider seed')

const embeddedManifestPath = resolve(root, 'build/browser-live-proof/source-manifest.json')
const skipBuild = process.env.READY_LIVE_SKIP_BUILD === '1'
const sourceManifest = skipBuild
  ? JSON.parse(readFileSync(embeddedManifestPath, 'utf8'))
  : buildSourceManifest(root)
if (!skipBuild) {
  mkdirSync(dirname(embeddedManifestPath), { recursive: true })
  writeFileSync(embeddedManifestPath, `${JSON.stringify(sourceManifest, null, 2)}\n`)
}
const proofId = randomBytes(20).toString('hex')
const runRoot = resolve(root, 'outputs/provider-confirmation-live-proof', proofId)
const profilePath = resolve(runRoot, 'profile')
const tempPath = resolve(runRoot, 'tmp')
mkdirSync(runRoot, { recursive: true })
cpSync(seedProfile, profilePath, { recursive: true, force: true })
mkdirSync(tempPath, { recursive: true })
const databasePath = resolve(profilePath, 'ready.db')
const reportPath = resolve(runRoot, 'provider-confirmation-report.json')

if (!skipBuild) {
  await run('npm', ['run', 'build:dir'])
}
const executablePath = findExecutable()
const fixture = await startFixtureServer()
const firstNonce = randomBytes(24).toString('hex')
const first = await launchReady(firstNonce, 9500 + Number.parseInt(proofId.slice(0, 3), 16) % 250)
let deny
let allow
let pending
try {
  deny = await evaluate(first.client, scenarioExpression(fixture.url, 'deny'))
  assertScenario(deny, 'deny')
  allow = await evaluate(first.client, scenarioExpression(fixture.url, 'allow'), 240_000)
  assertScenario(allow, 'allow')
  pending = await evaluate(first.client, scenarioExpression(fixture.url, 'pending'))
  assertScenario(pending, 'pending')
} finally {
  await first.close()
}

const projection = sqlRows(`SELECT task_id, scope_id, run_id, waiting_for, blocked_reason,
  continuation_ref_json, checkpoint_refs_json FROM task_projections
  WHERE scope_id = ${sqlQuote(pending.scopeId)} AND parent_task_id IS NULL LIMIT 1`)[0]
if (!projection) throw new Error('pending confirmation projection missing')
const continuation = JSON.parse(projection.continuation_ref_json || '{}')
const canonicalRow = sqlRows(`SELECT id, conversation_id, content, timestamp, meta_json FROM chat_messages
  WHERE conversation_id = ${sqlQuote(projection.scope_id)} AND role = 'assistant'
    AND id LIKE 'assistant:%' ORDER BY timestamp DESC LIMIT 1`)[0]
const doneEvent = [...(pending.directStreamEvents || [])].reverse().find((event) => event.type === 'done')
if (!canonicalRow || !doneEvent?.canonicalMessageDigest || doneEvent.canonicalMessageId !== canonicalRow.id) {
  throw new Error('pending confirmation canonical message was not carried by Main done')
}
const metricsPath = first.rawHandshake.metricsPath
if (!metricsPath || !existsSync(metricsPath)) throw new Error(`runtime metrics file missing: ${metricsPath || '<empty>'}`)
const metricSummary = readTargetMetrics(metricsPath, projection.run_id)

const restartNonce = randomBytes(24).toString('hex')
const restartRuntime = await launchReady(restartNonce, first.port + 1)
let restartDom
try {
  restartDom = await evaluate(restartRuntime.client, restartExpression({
    scopeId: projection.scope_id,
    taskId: projection.task_id,
    requestId: pending.confirmationCard.requestId,
  }))
} finally {
  await restartRuntime.close()
  fixture.server.close()
}
const restartProjection = sqlRows(`SELECT waiting_for, blocked_reason, degradation_reason,
  continuation_ref_json FROM task_projections WHERE task_id = ${sqlQuote(projection.task_id)} LIMIT 1`)[0]
const restartContinuation = JSON.parse(restartProjection?.continuation_ref_json || '{}')
const restart = {
  handshake: normalizeHandshake(restartRuntime.rawHandshake, restartNonce),
  expired: restartProjection?.waiting_for === 'none'
    && restartProjection?.blocked_reason === 'browser_confirmation_expired_checkpoint',
  pendingRequestCleared: !restartContinuation.suspensionRequest,
  oldButtonUnableToRelease: restartDom?.oldCardVisible === false
    && restartDom?.responseResult?.success === false,
  dom: restartDom,
  projection: restartProjection,
  logs: restartRuntime.logs,
}
const visibleMessages = (pending.visibleMessages || []).filter((message) => message.id === canonicalRow.id)
const report = {
  ok: true,
  generatedAt: new Date().toISOString(),
  sourceManifest,
  handshake: {
    ...normalizeHandshake(first.rawHandshake, firstNonce),
    metricsFilePresent: existsSync(metricsPath),
  },
  scopeId: projection.scope_id,
  runId: projection.run_id,
  taskId: projection.task_id,
  sendResult: pending.sendResult,
  canonical: { id: canonicalRow.id, digest: doneEvent.canonicalMessageDigest, row: canonicalRow },
  visibleMessages,
  confirmationCard: pending.confirmationCard,
  decisions: {
    deny: { accepted: deny.decisionAccepted === true, scopeId: deny.scopeId, runId: deny.runId },
    allow: { accepted: allow.decisionAccepted === true, scopeId: allow.scopeId, runId: allow.runId },
  },
  metrics: { runId: projection.run_id, sourcePath: metricsPath, ...metricSummary },
  restart,
  live: {
    ok: pending.ok === true,
    toolCalled: pending.toolCalled,
    target: continuation?.suspensionRequest?.target || null,
    taskCards: pending.taskCards,
    events: pending.events,
  },
  paths: { runRoot, profilePath, databasePath, tempPath, reportPath },
}
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
const validation = await run(process.execPath, ['scripts/check-provider-confirmation-live-proof-report.cjs', reportPath], true)
if (!restart.expired || !restart.pendingRequestCleared || !restart.oldButtonUnableToRelease) {
  throw new Error(`restart confirmation proof failed: ${JSON.stringify(restart)}`)
}
process.stdout.write(`${JSON.stringify({ ok: true, reportPath, validation }, null, 2)}\n`)

function scenarioExpression(fixtureUrl, decision) {
  const prompt = [
    '这是 Ready 内部确认链路验收。',
    '你必须在当前页面调用 browser_eval，',
    'purpose 填“设置确认验收标记”，code 填 document.body.dataset.readyConfirmationProof = "requested"; "requested"。',
    '不要改用其他工具，不要解释；发起调用后等待用户确认。',
  ].join('')
  return `(async () => {
    const api = window.electronAPI?.browser
    const agent = window.electronAPI?.agent
    const waitFor = async (read, timeoutMs = 120000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const value = await read()
        if (value) return value
        await new Promise((resolveWait) => setTimeout(resolveWait, 150))
      }
      return null
    }
    const harness = await waitFor(() => window.__READY_AGENT_TEST__?.submit ? window.__READY_AGENT_TEST__ : null, 10000)
    if (!api?.createTab || !agent?.listTaskProjections || !harness) return { ok: false, error: 'live APIs unavailable' }
    document.querySelector('button[data-mode="browser"]')?.click()
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    document.querySelector('button[title="展开聊天面板"]')?.click()
    const created = await api.createTab(${JSON.stringify(fixtureUrl)} + '?scenario=' + ${JSON.stringify(decision)}, { background: true })
    if (!created?.tabId) return { ok: false, error: 'fixture tab not created' }
    await api.switchTab(created.tabId)
    if (!harness.sessionSummary().activeSessionId) await harness.createVisibleSession()
    else await harness.newSession()
    harness.clearEvents()
    const directStreamEvents = []
    const off = agent.onStream((event) => directStreamEvents.push({
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
    const card = await waitFor(() => document.querySelector('[data-ready-browser-confirmation-card]'), 15000)
    const requestId = card?.getAttribute('data-ready-browser-confirmation-request-id') || null
    const findDecisionButton = (action) => {
      if (!requestId) return null
      const matches = document.querySelectorAll('button[data-ready-browser-confirmation-action="' + action + '"][data-ready-browser-confirmation-request-id="' + CSS.escape(requestId) + '"]')
      return matches.item(matches.length - 1)
    }
    const allowButton = await waitFor(() => findDecisionButton('allow'))
    const denyButton = await waitFor(() => findDecisionButton('deny'))
    const continuation = projection?.continuationRef || projection?.taskContinuation || null
    const target = continuation?.suspensionRequest?.target?.tabId || created.tabId
    const interactionCalls = []
    let decisionAccepted = null
    if (${JSON.stringify(decision)} === 'allow' || ${JSON.stringify(decision)} === 'deny') {
      const chosen = await waitFor(() => findDecisionButton(${JSON.stringify(decision)}))
      const interactionPayload = {
        scopeId,
        taskId: projection?.taskId || undefined,
        requestId,
        responseText: ${JSON.stringify(decision)} === 'allow' ? '确认继续。' : '暂不继续，请先停止。',
        confirmed: ${JSON.stringify(decision)} === 'allow',
      }
      const interactionResponse = chosen
        ? await agent.respondToInteraction(interactionPayload)
        : { success: false, error: 'visible decision button missing' }
      interactionCalls.push({ payload: interactionPayload, response: interactionResponse })
      decisionAccepted = Boolean(await waitFor(async () => {
        const next = await agent.listTaskProjections(scopeId)
        const root = next?.success ? next.data.find((item) => !item.parentTaskId) || next.data[0] : null
        return root && root.waitingFor !== 'confirmation' ? true : null
      }, 120000))
    }
    const after = await harness.snapshot()
    off()
    return {
      ok: Boolean(scopeId && projection?.runId && projection?.taskId && card && allowButton && denyButton),
      scopeId, runId: projection?.runId || snapshot.run?.requestId || null,
      taskId: projection?.taskId || snapshot.run?.taskId || null,
      sendResult: result.sendResult || {
        observed: true,
        inputMode: result.inputMode,
        canonicalDoneObserved: directStreamEvents.some((event) => event.type === 'done' && event.canonicalMessageId),
      },
      visibleMessages: after.messages,
      taskCards: after.taskCards,
      events: harness.events(), directStreamEvents,
      toolCalled: (snapshot.toolTrace || []).some((entry) => entry.kind === 'call' && String(entry.text || '').startsWith('browser_eval')),
      confirmationCard: { requestId, buttons: [allowButton && 'allow', denyButton && 'deny'].filter(Boolean), target },
      interactionCalls,
      domDiagnostics: {
        taskCardCount: document.querySelectorAll('[data-ready-task-card]').length,
        taskCards: Array.from(document.querySelectorAll('[data-ready-task-card]')).map((item) => ({
          scopeId: item.getAttribute('data-ready-task-scope-id'),
          taskId: item.getAttribute('data-ready-task-id'),
          text: String(item.textContent || '').slice(0, 500),
        })),
        chatPanelPresent: Boolean(document.querySelector('[data-liquid-shell="chat-panel"]')),
        collapsedControlPresent: Boolean(document.querySelector('button[title="展开聊天面板"]')),
      },
      decisionAccepted,
    }
  })()`
}

function restartExpression({ scopeId, taskId, requestId }) {
  return `(async () => {
    const oldCardVisible = Boolean(document.querySelector('[data-ready-browser-confirmation-request-id=${JSON.stringify(requestId)}]'))
    const projectionBeforeResponse = await window.electronAPI.agent.getTaskProjection(${JSON.stringify(taskId)})
    let responseResult
    try {
      responseResult = await window.electronAPI.agent.respondToInteraction({
        scopeId: ${JSON.stringify(scopeId)}, taskId: ${JSON.stringify(taskId)},
        requestId: ${JSON.stringify(requestId)},
        responseText: '确认继续。', confirmed: true,
      })
    } catch (error) {
      responseResult = { success: false, error: error instanceof Error ? error.message : String(error) }
    }
    const projectionAfterResponse = await window.electronAPI.agent.getTaskProjection(${JSON.stringify(taskId)})
    return { oldCardVisible, projectionBeforeResponse, responseResult, projectionAfterResponse }
  })()`
}

function assertScenario(scenario, name) {
  if (!scenario?.ok || !scenario.scopeId || !scenario.runId || !scenario.taskId
    || !scenario.sendResult || !scenario.confirmationCard?.requestId
    || scenario.confirmationCard?.buttons?.length !== 2 || !scenario.confirmationCard.target) {
    throw new Error(`${name} confirmation scenario failed: ${JSON.stringify(scenario)}`)
  }
  if (name !== 'pending' && scenario.decisionAccepted !== true) {
    throw new Error(`${name} confirmation decision was not accepted`)
  }
}

async function launchReady(nonce, port) {
  const logs = []
  const child = spawn(executablePath, [`--remote-debugging-port=${port}`], {
    cwd: root,
    env: {
      ...process.env,
      TMPDIR: tempPath,
      READY_BROWSER_LIVE_PROOF_NONCE: nonce,
      READY_DB_PATH: databasePath,
      READY_REMOTE_DEBUGGING_PORT: String(port),
      READY_USER_DATA_DIR: profilePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => pushLogs(logs, chunk))
  child.stderr.on('data', (chunk) => pushLogs(logs, chunk))
  try {
    const target = await waitForRendererTarget(port, 90_000)
    const client = await connect(target.webSocketDebuggerUrl)
    const rawHandshake = await evaluate(client, `window.electronAPI.app.browserLiveProofHandshake(${JSON.stringify(nonce)})`)
    assertHandshake(rawHandshake, nonce)
    await enablePackagedHarness(client)
    return {
      child, client, rawHandshake, port, logs,
      close: async () => {
        client.close()
        child.kill('SIGTERM')
        await waitForExit(child, 10_000)
      },
    }
  } catch (error) {
    child.kill('SIGTERM')
    await waitForExit(child, 10_000)
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs.slice(-80).join('\n')}`)
  }
}

async function enablePackagedHarness(client) {
  await evaluate(client, `(() => { localStorage.setItem('ready.agentPanelTest', '1'); return true })()`)
  await client.send('Page.reload', { ignoreCache: false })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const ready = await evaluate(client, `Boolean(window.__READY_AGENT_TEST__?.submit && window.electronAPI?.agent)`)
      if (ready) return
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error('packaged agent harness did not initialize after controlled reload')
}

function normalizeHandshake(handshake, nonce) {
  return {
    ok: handshake?.success === true,
    nonce,
    executablePath: handshake?.execPath,
    executableSha256: handshake?.execSha256,
    asarPath: handshake?.asarPath,
    asarSha256: handshake?.asarSha256,
    manifestDigest: handshake?.sourceManifestDigest,
    profilePath: handshake?.userDataPath,
    databasePath: handshake?.databasePath,
    metricsPath: handshake?.metricsPath,
    bootIncarnationId: handshake?.bootIncarnationId,
    appVersion: handshake?.appVersion,
  }
}

function assertHandshake(handshake, nonce) {
  if (!handshake?.success || handshake.proofNonce !== nonce) throw new Error('runtime handshake failed')
  if (!skipBuild && handshake.sourceManifestDigest !== sourceManifest.digest) throw new Error('embedded source manifest mismatch')
  if (handshake.execPath !== executablePath || handshake.execSha256 !== sha256File(executablePath)) throw new Error('runtime executable mismatch')
  if (!handshake.asarPath || handshake.asarSha256 !== sha256File(handshake.asarPath)) throw new Error('runtime asar mismatch')
  if (handshake.userDataPath !== profilePath || handshake.databasePath !== databasePath) throw new Error('runtime data path mismatch')
  if (handshake.metricsPath !== join(tempPath, 'ready-agent-metrics.log')) throw new Error('runtime metric path mismatch')
}

function readTargetMetrics(path, runId) {
  const events = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean).filter((event) => event.requestId === runId || event.runId === runId)
  return {
    renderer_done_without_canonical_terminal: events.filter((event) => event.metric === 'renderer_done_without_canonical_terminal').length,
    renderer_send_success_without_canonical_terminal: events.filter((event) => event.metric === 'renderer_send_success_without_canonical_terminal').length,
    matchedLines: events,
  }
}

function sqlRows(sql) {
  let lastError
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const raw = execFileSync('/usr/bin/sqlite3', ['-json', databasePath, sql], { encoding: 'utf8' }).trim()
      return raw ? JSON.parse(raw) : []
    } catch (error) {
      lastError = error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
    }
  }
  throw lastError
}

function sqlQuote(value) { return `'${String(value).replaceAll("'", "''")}'` }

function findExecutable() {
  const candidates = [
    resolve(root, 'exports/mac-arm64/Ready.app/Contents/MacOS/Ready'),
    resolve(root, 'exports/mac/Ready.app/Contents/MacOS/Ready'),
  ]
  const found = candidates.find(existsSync)
  if (!found) throw new Error(`packaged Ready executable not found: ${candidates.join(', ')}`)
  return found
}

async function startFixtureServer() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>Ready Confirmation Proof</title><main>confirmation proof page</main>')
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server unavailable')
  return { server, url: `http://127.0.0.1:${address.port}/` }
}

async function run(command, args, capture = false) {
  return new Promise((resolveRun, rejectRun) => {
    const output = []
    const proc = spawn(command, args, { cwd: root, env: process.env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' })
    if (capture) {
      proc.stdout.on('data', (chunk) => output.push(String(chunk)))
      proc.stderr.on('data', (chunk) => output.push(String(chunk)))
    }
    proc.once('error', rejectRun)
    proc.once('exit', (code, signal) => code === 0
      ? resolveRun(output.join('').trim())
      : rejectRun(new Error(`${command} ${args.join(' ')} failed code=${code} signal=${signal}\n${output.join('')}`)))
  })
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
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true })
    socket.addEventListener('error', rejectOpen, { once: true })
  })
  await new Promise((resolveSend, rejectSend) => {
    const id = ++nextId
    pending.set(id, { resolve: resolveSend, reject: rejectSend })
    socket.send(JSON.stringify({ id, method: 'Runtime.enable', params: {} }))
  })
  return {
    send(method, params = {}) {
      return new Promise((resolveSend, rejectSend) => {
        const id = ++nextId
        pending.set(id, { resolve: resolveSend, reject: rejectSend })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    close: () => socket.close(),
  }
}

async function evaluate(client, expression, timeoutMs = 180_000) {
  let timer
  try {
    const response = await Promise.race([
      client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Runtime.evaluate timed out')), timeoutMs) }),
    ])
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
    return response.result?.value
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function pushLogs(target, chunk) {
  target.push(...String(chunk).split(/\r?\n/).filter(Boolean))
  if (target.length > 500) target.splice(0, target.length - 500)
}

async function waitForExit(proc, timeoutMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  await new Promise((resolveWait) => {
    const timer = setTimeout(resolveWait, timeoutMs)
    proc.once('exit', () => { clearTimeout(timer); resolveWait() })
  })
}
