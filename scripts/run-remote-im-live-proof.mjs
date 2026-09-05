import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'node:net'
import { openCdp, evaluateCdp, runCdpCommand, closeChildProcess, sqlQuote } from './codex-runtime/live-proof-runtime.mjs'

const root = process.cwd()
const python = process.env.READY_REMOTE_TEST_PYTHON
if (!python) throw new Error('Set READY_REMOTE_TEST_PYTHON to the interpreter used by verify:remote-im')
const output = resolve(root, 'outputs', `remote-im-live-${Date.now()}`)
const profile = resolve(output, 'profile')
const temp = resolve(output, 'tmp')
mkdirSync(profile, { recursive: true, mode: 0o700 }); mkdirSync(temp, { mode: 0o700 })
const fixturePort = await freePort(), cdpPort = await freePort()
const base = `http://127.0.0.1:${fixturePort}`
const logs = []
const fixture = spawn(python, ['scripts/remote-im/fixture_server.py', String(fixturePort)], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
})
fixture.stderr.on('data', chunk => logs.push(String(chunk)))
let app, cdp
let settledRuns = []
const checks = []
try {
  await until(async () => (await fetch(`${base}/fixture/records`)).ok, 'fixture ready')
  const config = { provider: 'openai-compatible', baseUrl: `${base}/v1`, apiKey: 'local-fixture-key', model: 'remote-proof-model',
    agentProtocol: 'openai', wireApi: 'responses', toolUseMode: 'on', contextWindowOverride: 272000 }
  const workspace = { version: 1, activeProfileId: 'remote-proof', profiles: [{ id: 'remote-proof', category: 'custom',
    name: 'Local remote proof', builtIn: false, showInChatSwitcher: true, config }] }
  const rows = { ai_provider_workspace: workspace, ai_model_config: config,
    ai_saved_configs: { 'openai-compatible': config, 'remote-proof': config } }
  const database = resolve(profile, 'ready.db')
  execFileSync('/usr/bin/sqlite3', [database, `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO settings VALUES ${Object.entries(rows).map(([key, value]) => `(${sqlQuote(key)},${sqlQuote(JSON.stringify(value))},${sqlQuote(new Date().toISOString())})`).join(',')};`])
  mkdirSync(resolve(profile, 'agent-sidecar-runtime'))
  symlinkSync(resolve(python, '../..'), resolve(profile, 'agent-sidecar-runtime/python'))
  const packagedApp = process.env.READY_REMOTE_PROOF_APP
  const executable = packagedApp ? resolve(packagedApp, 'Contents/MacOS/Ready') : resolve(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  app = spawn(executable, packagedApp ? [] : [root], {
    cwd: root, env: { ...process.env, READY_USER_DATA_DIR: profile, READY_DB_PATH: database,
      READY_REMOTE_DEBUGGING_PORT: String(cdpPort), TMPDIR: temp }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  app.stdout.on('data', chunk => logs.push(String(chunk)))
  app.stderr.on('data', chunk => logs.push(String(chunk)))
  cdp = await openCdp(cdpPort, { timeoutMs: 90000 })
  await until(async () => evaluateCdp(cdp, 'Boolean(window.electronAPI?.agent)', 2000), 'renderer ready')
  const saved = await evaluateCdp(cdp, `window.electronAPI.agent.upsertChannel(${JSON.stringify({
    id: 'remote-fixture', type: 'feishu-app', name: '本地飞书验收', enabled: true,
    config: { appId: 'fixture-app', appSecret: 'fixture-secret', domain: base, triggerPrefix: '@ready' },
  })})`, 180000)
  assert.equal(saved.success, true, saved.error)
  await until(async () => (await records()).connections === 1, 'Feishu websocket connected')
  const pairing = await evaluateCdp(cdp, "window.electronAPI.agent.startChannelPairing('remote-fixture')")
  assert.equal(pairing.success, true)
  await inbound({ id: 'pair-owner', text: `/bind ${pairing.data.code}` })
  await until(async () => {
    const list = await evaluateCdp(cdp, 'window.electronAPI.agent.listChannels()')
    return list.data?.find(item => item.id === 'remote-fixture')?.config.allowedSenderId === 'fixture-owner'
  }, 'owner pairing')
  await until(async () => (await records()).connections === 1, 'reconfigured connection')
  checks.push('owner_pairing')
  await inbound({ id: 'first-task', text: '请只回复 READY_REMOTE_OK。' })
  await until(async () => (await records()).outbound.length > 0, 'Codex reply', 120000)
  const before = await records()
  assert.equal(JSON.parse(before.outbound[0].content).text, 'READY_REMOTE_OK')
  assert.equal(before.outbound.length, 1)
  assert.ok(before.providerCalls.length > 0)
  checks.push('websocket_to_current_codex_to_original_chat')
  await inbound({ id: 'first-task', text: '请只回复 READY_REMOTE_OK。' })
  await inbound({ id: 'stranger-task', text: '请执行任务', sender: 'unbound-user' })
  await inbound({ id: 'attachment-only', messageType: 'file', content: { file_key: 'fixture-file', file_name: 'brief.txt' } })
  await until(() => {
    const rows = JSON.parse(execFileSync('/usr/bin/sqlite3', ['-json', database,
      "SELECT status FROM agent_channel_events WHERE event_id LIKE '%attachment-only'"], { encoding: 'utf8' }) || '[]')
    return rows[0]?.status === 'done'
  }, 'attachment receipt')
  assert.equal((await records()).outbound.length, 1)
  assert.equal((await records()).providerCalls.length, before.providerCalls.length)
  checks.push('duplicate_and_stranger_ignored', 'standalone_attachment_stored_without_run')
  await inbound({ id: 'second-task', text: '请再次只回复 READY_REMOTE_OK。' })
  await until(async () => (await records()).outbound.length === 2, 'second Codex turn', 120000)
  settledRuns = JSON.parse(execFileSync('/usr/bin/sqlite3', ['-json', database, 'SELECT status,terminal_reason FROM run_meta'], { encoding: 'utf8' }))
  assert.equal(settledRuns.length, 2)
  assert.ok(settledRuns.every(run => run.status === 'done' && run.terminal_reason === 'done'))
  assert.equal(JSON.parse((await records()).outbound[1].content).text, 'READY_REMOTE_OK')
  checks.push('second_turn_same_remote_conversation', 'both_runs_committed_successfully')
  const wechatState = resolve(profile, 'wechat-fixture')
  mkdirSync(resolve(wechatState, 'accounts'), { recursive: true, mode: 0o700 })
  writeFileSync(resolve(wechatState, 'accounts', `${Buffer.from('wechat-account').toString('base64url')}.json`),
    JSON.stringify({ accountId: 'wechat-account', token: 'fixture-token', userId: 'wechat-owner', baseUrl: base }), { mode: 0o600 })
  const savedWechat = await evaluateCdp(cdp, `window.electronAPI.agent.upsertChannel(${JSON.stringify({
    id: 'wechat-fixture', type: 'wechat-openclaw', name: '本地微信验收', enabled: true,
    config: { accountId: 'wechat-account', stateDir: wechatState },
  })})`, 180000)
  assert.equal(savedWechat.success, true, savedWechat.error)
  await until(async () => {
    const list = await evaluateCdp(cdp, 'window.electronAPI.agent.listChannels()')
    return list.data?.find(item => item.id === 'wechat-fixture')?.config.allowedSenderId === 'wechat-owner'
  }, 'stored WeChat owner restored')
  checks.push('wechat_existing_account_restores_owner')
  await wechatInbound({ id: 'wechat-one', text: '请只回复 READY_REMOTE_OK。' })
  await until(async () => (await records()).wechatOutbound.length === 1, 'first WeChat Codex reply', 120000)
  await wechatInbound({ id: 'wechat-one', text: '请只回复 READY_REMOTE_OK。' })
  await wechatInbound({ id: 'wechat-stranger', text: '不能执行', sender: 'unbound-user' })
  await wechatInbound({ id: 'wechat-two', text: '请再次只回复 READY_REMOTE_OK。' })
  await until(async () => (await records()).wechatOutbound.length === 2, 'second WeChat Codex reply', 120000)
  for (const message of (await records()).wechatOutbound) {
    assert.equal(message.to_user_id, 'wechat-owner')
    assert.equal(message.item_list[0].text_item.text, 'READY_REMOTE_OK')
  }
  settledRuns = JSON.parse(execFileSync('/usr/bin/sqlite3', ['-json', database, 'SELECT status,terminal_reason FROM run_meta'], { encoding: 'utf8' }))
  assert.equal(settledRuns.length, 4)
  assert.ok(settledRuns.every(run => run.status === 'done' && run.terminal_reason === 'done'))
  checks.push('wechat_to_current_codex_to_original_owner', 'wechat_duplicate_and_stranger_ignored', 'all_four_runs_committed_successfully')
  await evaluateCdp(cdp, "location.hash = '#/settings'; true")
  await until(async () => evaluateCdp(cdp, `Boolean([...document.querySelectorAll('button')].find(b => b.textContent.includes('远程 IM')))`, 2000), 'settings navigation')
  await evaluateCdp(cdp, `[...document.querySelectorAll('button')].find(b => b.textContent.includes('远程 IM')).click(); true`)
  await until(async () => evaluateCdp(cdp, "document.body.innerText.includes('已绑定本人')", 2000), 'bound UI state')
  const cache = await evaluateCdp(cdp, 'window.electronAPI.agent.getRemoteAttachmentCacheStats()')
  assert.equal(cache.success, true)
  assert.equal(cache.data.totalFiles, 1)
  assert.equal(cache.data.totalBytes, Buffer.byteLength('LOCAL_FIXTURE_ATTACHMENT'))
  await evaluateCdp(cdp, `[...document.querySelectorAll('button')].filter(button => button.textContent.trim() === '刷新').at(-1).click(); true`)
  await until(async () => evaluateCdp(cdp, "document.body.innerText.includes('总附件数：1')", 2000), 'attachment cache UI')
  checks.push('remote_attachment_readback_and_cache_ui')
  const screenshot = await runCdpCommand(cdp, 'Page.captureScreenshot', { format: 'png' })
  writeFileSync(resolve(output, 'remote-settings.png'), Buffer.from(screenshot.data, 'base64'))
  await evaluateCdp(cdp, `[...document.querySelectorAll('div')].find(element => element.textContent === '运行状态')?.scrollIntoView(); true`)
  const statusImage = await runCdpCommand(cdp, 'Page.captureScreenshot', { format: 'png' })
  writeFileSync(resolve(output, 'remote-status.png'), Buffer.from(statusImage.data, 'base64'))
  checks.push('electron_settings_binding_and_connection_state')
  writeFileSync(resolve(output, 'proof.json'), JSON.stringify({ passed: true, checks, settledRuns, provider: 'local fixture', app: process.env.READY_REMOTE_PROOF_APP || 'development build',
    transport: 'real pinned Feishu SDK over loopback websocket and WeChat polling over loopback HTTP', engine: 'current bundled Codex', screenshot: resolve(output, 'remote-settings.png') }, null, 2))
  console.log(JSON.stringify({ passed: true, checks, output }))
} catch (error) {
  writeFileSync(resolve(output, 'proof.json'), JSON.stringify({ passed: false, checks, error: String(error) }, null, 2))
  throw error
} finally {
  cdp?.close()
  if (app) await closeChildProcess(app)
  await closeChildProcess(fixture)
  writeFileSync(resolve(output, 'app.log'), logs.join(''))
  rmSync(profile, { recursive: true, force: true })
}

async function freePort() {
  const server = createServer()
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const port = server.address().port
  await new Promise(resolveClose => server.close(resolveClose))
  return port
}
async function until(predicate, label, timeout = 60000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try { if (await predicate()) return } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 300))
  }
  throw new Error(`Timed out: ${label}`)
}
async function records() { return (await fetch(`${base}/fixture/records`)).json() }
async function inbound(payload) {
  const response = await fetch(`${base}/fixture/inbound`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  const result = await response.json()
  assert.ok(result.connections > 0, 'fixture delivery needs an actual websocket')
}
async function wechatInbound(payload) {
  const response = await fetch(`${base}/fixture/wechat/inbound`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  assert.equal((await response.json()).success, true)
}
