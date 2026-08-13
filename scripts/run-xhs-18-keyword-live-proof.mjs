#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { buildSourceManifest, sha256File } = require('./browser-live-proof-manifest.cjs')
const root = process.cwd()
const suppliedProfile = process.env.READY_BROWSER_LIVE_ACCEPTANCE_PROFILE?.trim()
if (!suppliedProfile) throw new Error('READY_BROWSER_LIVE_ACCEPTANCE_PROFILE is required')
const seedProfile = realpathSync(resolve(suppliedProfile))
const dailyProfile = resolve(homedir(), 'Library/Application Support/Ready')
if (seedProfile === dailyProfile) throw new Error('daily Ready profile is forbidden for XHS acceptance')
if (!existsSync(join(seedProfile, 'ready.db'))) throw new Error('dedicated acceptance profile has no ready.db')

const keywords = [
  'vlog调色 高级感', '剪映 进阶教程', '自媒体视频 质感提升', 'vlog转场 创意', '短视频 字幕排版 高级',
  '视频拍出来和博主差距大', 'vlog怎么剪才有网感', '剪映调色 没质感', '达芬奇调色 vlog', '商业剪辑师 技巧',
  'AI做视频 教程', 'AI视频制作 博主', 'AI生成视频 自媒体', 'vlog美颜 高级感', '视频画质 美颜 剪辑',
  '博主美颜参数 分享', '视频封面 设计 自媒体', '小红书封面 制作教程',
]
const accountUrl = 'https://www.xiaohongshu.com/user/profile/619d00b3000000002102b02f'
const outputRoot = resolve('/Users/user/实验田/测试/lib-a')
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
const researchPath = resolve(outputRoot, `小红书爆款笔记调研_完整18组_${timestamp}.md`)
const selectionPath = resolve(outputRoot, `麦麦好热气_可做选题筛选_完整18组_${timestamp}.md`)
if (existsSync(researchPath) || existsSync(selectionPath)) throw new Error('fresh XHS acceptance outputs already exist')

const skipBuild = process.env.READY_LIVE_SKIP_BUILD === '1'
const embeddedManifestPath = resolve(root, 'build/browser-live-proof/source-manifest.json')
const sourceManifest = skipBuild ? JSON.parse(readFileSync(embeddedManifestPath, 'utf8')) : buildSourceManifest(root)
if (!skipBuild) {
  mkdirSync(dirname(embeddedManifestPath), { recursive: true })
  writeFileSync(embeddedManifestPath, `${JSON.stringify(sourceManifest, null, 2)}\n`)
  await run('npm', ['run', 'build:dir'])
}

const proofId = randomBytes(20).toString('hex')
const runRoot = resolve(root, 'outputs/xhs-18-keyword-live-proof', proofId)
const profilePath = resolve(runRoot, 'profile')
const tempPath = resolve(runRoot, 'tmp')
mkdirSync(runRoot, { recursive: true })
const seedDatabaseShaBefore = sha256File(join(seedProfile, 'ready.db'))
cpSync(seedProfile, profilePath, { recursive: true, force: true })
mkdirSync(tempPath, { recursive: true })
const databasePath = resolve(profilePath, 'ready.db')
const reportPath = resolve(runRoot, 'xhs-18-keyword-report.json')
const provider = providerIdentity()
if (provider.provider !== 'openai-compatible' || !/novacode/i.test(provider.baseUrl)) {
  throw new Error(`dedicated profile is not configured for novacode: ${JSON.stringify(provider)}`)
}

const prompt = [
  '这是 Ready 真实外部长任务验收。必须使用当前 Ready Browser 中已登录的小红书页面，不得改用通用网页搜索或自己编造内容。',
  `先阅读账号“麦麦好热气🔴”的可见内容（${accountUrl}），再按以下 18 组关键词逐组搜索：`,
  ...keywords.map((keyword, index) => `${index + 1}. ${keyword}`),
  '每一组都必须至少整理 1 篇真实可见笔记，记录关键词、标题、页面可见正文、互动数据和链接；没有正文或互动数据的项不得冒充完成。',
  `将完整 18/18 调研保存为 ${researchPath}。`,
  `结合账号实际内容，把适合该账号的选题、适配理由、建议角度及对应关键词保存为 ${selectionPath}。`,
  '两份文件都必须写完后再独立回读核对，明确写出“18/18”，不得出现“首批 5 个”或未完成说明。不要提前结束；Browser 子任务、两份文件和最终回复全部完成后才能汇报完成。',
].join('\n')

const executablePath = findExecutable()
const nonce = randomBytes(24).toString('hex')
const runtime = await launchReady(nonce, 9900 + Number.parseInt(proofId.slice(0, 3), 16) % 200)
let initial
let finalSnapshot
const observedRunIds = new Set()
const resumeAttempts = []
try {
  initial = await evaluate(runtime.client, startExpression(), 60_000)
  if (!initial?.scopeId || !initial?.taskId || !initial?.runId) throw new Error(`XHS run did not start: ${JSON.stringify(initial)}`)
  observedRunIds.add(initial.runId)
  const deadline = Date.now() + Number(process.env.READY_XHS_ACCEPTANCE_TIMEOUT_MS || 3_600_000)
  let lastResumeAt = 0
  while (Date.now() < deadline) {
    const state = await evaluate(runtime.client, statusExpression(initial.scopeId, initial.taskId), 30_000)
    finalSnapshot = state
    if (state?.runId) observedRunIds.add(state.runId)
    const child = latestBrowserChild(initial.taskId)
    if (state?.projection?.status === 'completed' && child?.status === 'completed') break
    if (state?.projection?.waitingFor === 'confirmation' && state?.confirmation?.requestId) {
      const response = await evaluate(runtime.client, confirmationExpression(initial.scopeId, initial.taskId, state.confirmation.requestId), 30_000)
      resumeAttempts.push({ kind: 'confirmation', at: new Date().toISOString(), response })
    } else if (
      state?.projection?.status === 'recoverable_paused'
      && state?.projection?.waitingFor === 'none'
      && child && child.status !== 'running'
      && Date.now() - lastResumeAt > 15_000
      && resumeAttempts.filter((item) => item.kind === 'resume').length < 6
    ) {
      lastResumeAt = Date.now()
      const response = await evaluate(runtime.client, resumeExpression(initial.scopeId, initial.taskId), 30_000)
      resumeAttempts.push({ kind: 'resume', at: new Date().toISOString(), reason: state.projection.blockedReason, response })
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 5000))
  }
  finalSnapshot = await evaluate(runtime.client, statusExpression(initial.scopeId, initial.taskId), 30_000)
} finally {
  await runtime.close()
}

const projection = sqlRows(`SELECT * FROM task_projections WHERE task_id = ${sqlQuote(initial.taskId)} LIMIT 1`)[0]
const child = latestBrowserChild(initial.taskId)
const finalRunId = projection?.run_id || finalSnapshot?.runId || initial.runId
observedRunIds.add(finalRunId)
const runMeta = sqlRows(`SELECT * FROM run_meta WHERE run_id = ${sqlQuote(finalRunId)} LIMIT 1`)[0]
const canonicalRows = sqlRows(`SELECT id, conversation_id, content, timestamp, meta_json FROM chat_messages
  WHERE conversation_id = ${sqlQuote(initial.scopeId)} AND role = 'assistant'
    AND json_extract(meta_json, '$.runId') = ${sqlQuote(finalRunId)} ORDER BY timestamp ASC`)
const streamEvents = finalSnapshot?.streamEvents || []
const doneEvent = [...streamEvents].reverse().find((event) => event.type === 'done' && event.runId === finalRunId)
const metricsPath = runtime.rawHandshake.metricsPath
if (!metricsPath || !existsSync(metricsPath)) throw new Error('XHS runtime metrics file missing')
const metrics = readMetrics(metricsPath, observedRunIds)
const artifacts = [researchPath, selectionPath].map(readArtifact)
const report = {
  ok: true,
  generatedAt: new Date().toISOString(),
  sourceManifest,
  handshake: normalizeHandshake(runtime.rawHandshake, nonce),
  profilePolicy: { seedProfile: '<dedicated-acceptance-profile>', dailyProfileReads: 0, dailyProfileWrites: 0,
    seedDatabaseShaBefore, seedDatabaseShaAfter: sha256File(join(seedProfile, 'ready.db')) },
  provider,
  prompt: { digest: sha256Text(prompt), keywordCount: keywords.length, keywords, accountUrl,
    outputPaths: [researchPath, selectionPath] },
  scopeId: initial.scopeId, taskId: initial.taskId, initialRunId: initial.runId, finalRunId,
  observedRunIds: [...observedRunIds], resumeAttempts,
  projection, browserChild: child, runMeta,
  canonicalRows,
  doneEvent: doneEvent || null,
  visibleMessages: (finalSnapshot?.messages || []).filter((message) => canonicalRows.some((row) => row.id === message.id)),
  taskCards: finalSnapshot?.taskCards || [],
  artifacts,
  metrics: { sourcePath: metricsPath, ...metrics },
  live: { ok: finalSnapshot?.projection?.status === 'completed' && child?.status === 'completed',
    initial, finalSnapshot, logs: runtime.logs.slice(-200) },
  paths: { runRoot, profilePath, databasePath, tempPath, reportPath },
}
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
const validation = await run(process.execPath, ['scripts/check-xhs-18-keyword-live-proof-report.cjs', reportPath], true)
process.stdout.write(`${JSON.stringify({ ok: true, reportPath, validation }, null, 2)}\n`)

function startExpression() {
  return `(async () => {
    const waitFor = async (read, timeoutMs = 30000) => { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) {
      const value = await read(); if (value) return value; await new Promise((resolveWait) => setTimeout(resolveWait, 200)) } return null }
    const harness = await waitFor(() => window.__READY_AGENT_TEST__?.submit ? window.__READY_AGENT_TEST__ : null, 10000)
    const agent = window.electronAPI?.agent; const browser = window.electronAPI?.browser
    if (!harness || !agent || !browser?.createTab) return { ok: false, error: 'live APIs unavailable' }
    document.querySelector('button[data-mode="browser"]')?.click(); await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    document.querySelector('button[title="展开聊天面板"]')?.click()
    const tab = await browser.createTab(${JSON.stringify(accountUrl)})
    if (!harness.sessionSummary().activeSessionId) await harness.createVisibleSession(); else await harness.newSession()
    harness.clearEvents(); window.__READY_XHS_PROOF_EVENTS__ = []
    window.__READY_XHS_PROOF_OFF__?.(); window.__READY_XHS_PROOF_OFF__ = agent.onStream((event) => window.__READY_XHS_PROOF_EVENTS__.push({
      type: event.type, runId: event.runId || null, sessionId: event.sessionId || null,
      canonicalMessageId: event.canonicalMessage?.id || null, canonicalMessageDigest: event.canonicalMessageDigest || null }))
    const result = await harness.submit(${JSON.stringify(prompt)}, { mode: 'dom', allowStoreFallback: false, waitForIdle: false,
      attachments: [{ path: ${JSON.stringify(outputRoot)}, name: 'lib-a', isDirectory: true }] })
    const bound = await waitFor(async () => { const snapshot = await harness.snapshot(); const scopeId = snapshot.currentScopeId
      const rows = scopeId ? await agent.listTaskProjections(scopeId) : null; const projections = rows?.success ? rows.data : []
      const projection = projections.find((item) => !item.parentTaskId) || projections[0] || null
      return scopeId && projection?.taskId && projection?.runId ? { snapshot, scopeId, projection } : null }, 20000)
    return { ok: Boolean(bound), scopeId: bound?.scopeId || null, taskId: bound?.projection?.taskId || null,
      runId: bound?.projection?.runId || null, sendResult: result.sendResult || { observed: true, inputMode: result.inputMode },
      tabId: tab.tabId }
  })()`
}

function statusExpression(scopeId, taskId) {
  return `(async () => { const harness = window.__READY_AGENT_TEST__; const agent = window.electronAPI.agent
    const snapshot = await harness.snapshot(); const result = await agent.getTaskProjection(${JSON.stringify(taskId)})
    const projection = result?.success ? result.data : null
    const card = document.querySelector('[data-ready-browser-confirmation-card]')
    return { projection, runId: projection?.runId || snapshot.run?.requestId || null, messages: snapshot.messages,
      taskCards: snapshot.taskCards, events: harness.events(), streamEvents: window.__READY_XHS_PROOF_EVENTS__ || [],
      confirmation: card ? { requestId: card.getAttribute('data-ready-browser-confirmation-request-id') } : null,
      scopeId: ${JSON.stringify(scopeId)} }
  })()`
}
function confirmationExpression(scopeId, taskId, requestId) {
  return `window.electronAPI.agent.respondToInteraction({ scopeId: ${JSON.stringify(scopeId)}, taskId: ${JSON.stringify(taskId)},
    requestId: ${JSON.stringify(requestId)}, responseText: '确认继续完成已授权的调研任务。', confirmed: true })`
}
function resumeExpression(scopeId, taskId) {
  return `window.electronAPI.agent.resumeRun({ scopeId: ${JSON.stringify(scopeId)}, taskId: ${JSON.stringify(taskId)},
    requestId: 'xhs-proof-resume-' + Date.now(), responseText: '继续原任务，直到 18/18、两份文件回读和最终验收全部完成。' })`
}

function latestBrowserChild(parentTaskId) {
  return sqlRows(`SELECT * FROM browser_tasks WHERE parent_task_id = ${sqlQuote(parentTaskId)} ORDER BY updated_at DESC LIMIT 1`)[0] || null
}
function providerIdentity() {
  const config = JSON.parse(sqlValue("SELECT value FROM settings WHERE key = 'ai_model_config'"))
  return { provider: config.provider || null, model: config.model || null, agentProtocol: config.agentProtocol || null,
    baseUrl: String(config.baseUrl || '').replace(/:\/\/[^/]+/, '://novacode'), hasCredential: Boolean(config.apiKey) }
}
function readArtifact(path) {
  if (!existsSync(path)) return { path, exists: false }
  const stat = statSync(path); const content = readFileSync(path, 'utf8')
  return { path, exists: true, size: stat.size, mtimeMs: stat.mtimeMs, sha256: sha256Text(content),
    keywordCoverage: keywords.filter((keyword) => content.includes(keyword)), declares18of18: /18\s*\/\s*18/.test(content),
    containsPartialClaim: /首批\s*5|剩余\s*1[0-9]\s*个|未完成/.test(content), content }
}
function readMetrics(path, runIds) {
  const all = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  const target = all.filter((event) => runIds.has(event.requestId) || runIds.has(event.runId))
  const names = ['owner_local_runner_session_rebased', 'owner_local_session_source_cursor_mismatch',
    'renderer_done_without_canonical_terminal', 'renderer_send_success_without_canonical_terminal']
  return { matchedLines: target, counts: Object.fromEntries(names.map((name) => [name, target.filter((event) => event.metric === name).length])),
    runClose: target.filter((event) => event.metric === 'run_close') }
}

async function launchReady(proofNonce, port) {
  const logs = []; const child = spawn(executablePath, [`--remote-debugging-port=${port}`], { cwd: root,
    env: { ...process.env, TMPDIR: tempPath, READY_BROWSER_LIVE_PROOF_NONCE: proofNonce, READY_DB_PATH: databasePath,
      READY_REMOTE_DEBUGGING_PORT: String(port), READY_USER_DATA_DIR: profilePath }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk) => pushLogs(logs, chunk)); child.stderr.on('data', (chunk) => pushLogs(logs, chunk))
  try {
    const target = await waitForRendererTarget(port, 90000); const client = await connect(target.webSocketDebuggerUrl)
    const rawHandshake = await evaluate(client, `window.electronAPI.app.browserLiveProofHandshake(${JSON.stringify(proofNonce)})`)
    assertHandshake(rawHandshake, proofNonce); await enableHarness(client)
    return { child, client, rawHandshake, logs, close: async () => { client.close(); child.kill('SIGTERM'); await waitForExit(child, 10000) } }
  } catch (error) { child.kill('SIGTERM'); await waitForExit(child, 10000); throw new Error(`${error}\n${logs.slice(-80).join('\n')}`) }
}
function normalizeHandshake(handshake, proofNonce) { return { ok: handshake?.success === true, nonce: proofNonce,
  executablePath: handshake?.execPath, executableSha256: handshake?.execSha256, asarPath: handshake?.asarPath,
  asarSha256: handshake?.asarSha256, manifestDigest: handshake?.sourceManifestDigest, profilePath: handshake?.userDataPath,
  databasePath: handshake?.databasePath, metricsPath: handshake?.metricsPath, bootIncarnationId: handshake?.bootIncarnationId,
  appVersion: handshake?.appVersion } }
function assertHandshake(handshake, proofNonce) {
  if (!handshake?.success || handshake.proofNonce !== proofNonce) throw new Error('runtime handshake failed')
  if (!skipBuild && handshake.sourceManifestDigest !== sourceManifest.digest) throw new Error('embedded source manifest mismatch')
  if (handshake.execPath !== executablePath || handshake.execSha256 !== sha256File(executablePath)) throw new Error('runtime executable mismatch')
  if (!handshake.asarPath || handshake.asarSha256 !== sha256File(handshake.asarPath)) throw new Error('runtime asar mismatch')
  if (handshake.userDataPath !== profilePath || handshake.databasePath !== databasePath) throw new Error('runtime data path mismatch')
  if (handshake.metricsPath !== join(tempPath, 'ready-agent-metrics.log')) throw new Error('runtime metric path mismatch')
}
function sqlRows(sql) { const raw = execFileSync('/usr/bin/sqlite3', ['-json', databasePath, sql], { encoding: 'utf8' }).trim(); return raw ? JSON.parse(raw) : [] }
function sqlValue(sql) { return execFileSync('/usr/bin/sqlite3', [databasePath, sql], { encoding: 'utf8' }).trim() }
function sqlQuote(value) { return `'${String(value).replaceAll("'", "''")}'` }
function sha256Text(value) { return createHash('sha256').update(value).digest('hex') }
function findExecutable() { const paths = [resolve(root, 'exports/mac-arm64/Ready.app/Contents/MacOS/Ready'), resolve(root, 'exports/mac/Ready.app/Contents/MacOS/Ready')]; const found = paths.find(existsSync); if (!found) throw new Error('packaged Ready executable not found'); return found }
async function enableHarness(client) { await evaluate(client, `(() => { localStorage.setItem('ready.agentPanelTest', '1'); return true })()`); await client.send('Page.reload', { ignoreCache: false }); const deadline = Date.now() + 30000; while (Date.now() < deadline) { try { if (await evaluate(client, `Boolean(window.__READY_AGENT_TEST__?.submit)`)) return } catch {} await new Promise((resolveWait) => setTimeout(resolveWait, 250)) } throw new Error('packaged harness unavailable') }
async function waitForRendererTarget(port, timeoutMs) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { try { const response = await fetch(`http://127.0.0.1:${port}/json/list`); const targets = response.ok ? await response.json() : []; const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl && /\/index\.html(?:[?#].*)?$/.test(String(item.url || '')) && !/overlay/.test(String(item.url || ''))); if (target) return target } catch {} await new Promise((resolveWait) => setTimeout(resolveWait, 500)) } throw new Error('Ready renderer target unavailable') }
async function connect(url) { const socket = new WebSocket(url); const pending = new Map(); let nextId = 0; socket.addEventListener('message', (event) => { const message = JSON.parse(event.data); const item = pending.get(message.id); if (!item) return; pending.delete(message.id); if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result) }); await new Promise((resolveOpen, rejectOpen) => { socket.addEventListener('open', resolveOpen, { once: true }); socket.addEventListener('error', rejectOpen, { once: true }) }); return { send(method, params = {}) { return new Promise((resolveSend, rejectSend) => { const id = ++nextId; pending.set(id, { resolve: resolveSend, reject: rejectSend }); socket.send(JSON.stringify({ id, method, params })) }) }, close: () => socket.close() } }
async function evaluate(client, expression, timeoutMs = 60000) { let timer; try { const response = await Promise.race([client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Runtime.evaluate timed out')), timeoutMs) })]); if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text); return response.result?.value } finally { if (timer) clearTimeout(timer) } }
async function run(command, args, capture = false) { return new Promise((resolveRun, rejectRun) => { const output = []; const proc = spawn(command, args, { cwd: root, env: process.env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' }); if (capture) { proc.stdout.on('data', (chunk) => output.push(String(chunk))); proc.stderr.on('data', (chunk) => output.push(String(chunk))) } proc.once('error', rejectRun); proc.once('exit', (code, signal) => code === 0 ? resolveRun(output.join('').trim()) : rejectRun(new Error(`${command} ${args.join(' ')} failed code=${code} signal=${signal}\n${output.join('')}`))) }) }
function pushLogs(target, chunk) { target.push(...String(chunk).split(/\r?\n/).filter(Boolean)); if (target.length > 800) target.splice(0, target.length - 800) }
async function waitForExit(proc, timeoutMs) { if (proc.exitCode !== null || proc.signalCode !== null) return; await new Promise((resolveWait) => { const timer = setTimeout(resolveWait, timeoutMs); proc.once('exit', () => { clearTimeout(timer); resolveWait() }) }) }
