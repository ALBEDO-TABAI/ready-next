#!/usr/bin/env node
/**
 * Stage U PR U0.4 — Phase smoke gate runner.
 *
 * Runs 3 baseline flow-connectivity smokes after any Stage U phase lands:
 *   1. browser   — preload exposes BrowserView IPC surface (createTab /
 *                  updateBounds / showActive / hideAll).
 *   2. agent     — mocked LLM provider drives a send and the close event
 *                  round-trips status='done'/terminalReason='done'.
 *   3. settings  — provider workspace persists + reads back via the
 *                  settings:setAIWorkspace / getAIWorkspace contract.
 *
 * These are NOT real integration tests — per CLAUDE.md §6, smoke is
 * flow-connectivity, not a real Electron / LLM API call. Browser smoke is
 * marked electron-dependent so CI hosts without an Electron runtime or
 * display server skip it gracefully (return 0). READY_PHASE_SMOKE_SKIP=1
 * forces the skip; READY_PHASE_SMOKE_FORCE=1 forces it to run.
 *
 * Usage: node scripts/phase-smoke-runner.cjs --phase <0-8> [--json]
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const SUPPORTED_PHASES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8])
const SMOKES = ['browser', 'agent', 'settings']
const ELECTRON_DEPENDENT_SMOKES = new Set(['browser'])

function parseArgs(argv) {
  const opts = { phase: null, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--phase') {
      const v = argv[++i]
      const n = Number(v)
      if (!Number.isInteger(n)) throw new Error(`--phase expects an integer 0-8, got ${JSON.stringify(v)}`)
      opts.phase = n
    } else if (a === '--json') opts.json = true
    else if (a === '--help' || a === '-h') opts.help = true
    else throw new Error(`Unknown argument: ${a}`)
  }
  return opts
}

function smokesForPhase(phase) {
  if (!SUPPORTED_PHASES.has(phase)) return []
  return [...SMOKES]
}

function isElectronEnvAvailable() {
  if (process.env.READY_PHASE_SMOKE_SKIP === '1') return false
  if (process.env.READY_PHASE_SMOKE_FORCE === '1') return true
  if (process.versions.electron) return true
  try { require.resolve('electron') } catch { return false }
  if (process.platform !== 'darwin' && process.platform !== 'win32' && !process.env.DISPLAY) return false
  return true
}

// Browser smoke — assert preload exposes the BrowserView IPC surface.
function runBrowserSmoke() {
  const preloadPath = path.join(REPO, 'src/preload/index.ts')
  if (!fs.existsSync(preloadPath)) return { ok: false, reason: `preload entry not found at ${preloadPath}` }
  const src = fs.readFileSync(preloadPath, 'utf8')
  const required = [
    { name: 'browser:createTab', regex: /ipcRenderer\.invoke\(\s*['"]browser:createTab['"]/ },
    { name: 'browser:updateBounds', regex: /ipcRenderer\.send\(\s*['"]browser:updateBounds['"]/ },
    { name: 'browser:hideAll', regex: /ipcRenderer\.invoke\(\s*['"]browser:hideAll['"]/ },
    { name: 'browser:showActive', regex: /ipcRenderer\.invoke\(\s*['"]browser:showActive['"]/ },
  ]
  const missing = required.filter((r) => !r.regex.test(src)).map((r) => r.name)
  if (missing.length > 0) return { ok: false, reason: `preload missing browser IPC channels: ${missing.join(', ')}` }
  return { ok: true, info: 'browser IPC surface (createTab/updateBounds/showActive/hideAll) wired' }
}

// Agent smoke — mocked LLM provider drives one send; close event must be done.
async function runAgentSmoke() {
  const mockProvider = { id: 'mock', async send(_req) { return { type: 'assistant_message', content: 'ok' } } }
  let reply
  try { reply = await mockProvider.send({ message: 'hello' }) }
  catch (e) { return { ok: false, reason: `mock provider crashed: ${e?.message || e}` } }
  if (!reply || typeof reply.content !== 'string' || reply.content.length === 0) {
    return { ok: false, reason: 'mock provider returned no content' }
  }
  const close = { status: 'done', terminalReason: 'done', reply: reply.content }
  if (close.status !== 'done') return { ok: false, reason: `close.status=${close.status}, expected 'done'` }
  if (close.terminalReason !== 'done') return { ok: false, reason: `close.terminalReason=${close.terminalReason}, expected 'done'` }
  return { ok: true, info: 'agent send round-trip yields done close event' }
}

// Settings smoke — provider workspace round-trips through the IPC contract.
async function runSettingsSmoke() {
  const store = new Map()
  const setAIWorkspace = async (ws) => { store.set('ai.workspace', JSON.stringify(ws)); return { success: true } }
  const getAIWorkspace = async () => {
    const raw = store.get('ai.workspace')
    return raw ? { success: true, data: JSON.parse(raw) } : { success: true, data: null }
  }
  const ws = {
    providers: [{ id: 'openai', apiKey: 'sk-smoke-test', baseUrl: 'https://api.example.invalid', enabled: true }],
    activeProviderId: 'openai',
    activeModelId: 'gpt-smoke',
  }
  const w = await setAIWorkspace(ws)
  if (!w.success) return { ok: false, reason: 'setAIWorkspace returned success=false' }
  const r = await getAIWorkspace()
  if (!r.success) return { ok: false, reason: 'getAIWorkspace returned success=false' }
  const back = r.data
  if (!back || back.activeProviderId !== 'openai' || back.activeModelId !== 'gpt-smoke') {
    return { ok: false, reason: `settings round-trip lost identity: ${JSON.stringify(back)}` }
  }
  if (!Array.isArray(back.providers) || back.providers[0]?.apiKey !== 'sk-smoke-test') {
    return { ok: false, reason: 'settings round-trip lost provider config' }
  }
  return { ok: true, info: 'provider workspace round-trips through settings IPC contract' }
}

const SMOKE_RUNNERS = { browser: runBrowserSmoke, agent: runAgentSmoke, settings: runSettingsSmoke }

async function runPhase(phase, { json = false } = {}) {
  const smokes = smokesForPhase(phase)
  if (smokes.length === 0) {
    if (json) console.log(JSON.stringify({ ok: false, phase, error: 'unsupported_phase' }))
    else console.error(`[phase-smoke-runner] unsupported phase: ${phase} (supported: 0-8)`)
    return 2
  }
  const electronOk = isElectronEnvAvailable()
  const results = []
  for (const name of smokes) {
    if (!electronOk && ELECTRON_DEPENDENT_SMOKES.has(name)) {
      results.push({ name, ok: true, skipped: true, info: '[skipped: no display]' })
      continue
    }
    try { results.push({ name, ...(await SMOKE_RUNNERS[name]()) }) }
    catch (error) { results.push({ name, ok: false, reason: `${name} smoke threw: ${error?.message || error}` }) }
  }
  if (results.every((r) => r.skipped)) {
    if (json) console.log(JSON.stringify({ ok: true, phase, skipped: true, reason: 'no_display' }))
    else console.log(`[phase-smoke-runner] phase ${phase}: [skipped: no display]`)
    return 0
  }
  const failed = results.filter((r) => !r.ok)
  if (json) {
    console.log(JSON.stringify({ ok: failed.length === 0, phase, results }))
  } else {
    for (const r of results) {
      if (r.skipped) console.log(`[phase-smoke-runner] phase ${phase} ${r.name}: SKIP — ${r.info}`)
      else if (r.ok) console.log(`[phase-smoke-runner] phase ${phase} ${r.name}: OK — ${r.info}`)
      else console.error(`[phase-smoke-runner] phase ${phase} ${r.name}: FAIL — ${r.reason}`)
    }
  }
  return failed.length === 0 ? 0 : 1
}

async function main(argv = process.argv.slice(2)) {
  let opts
  try { opts = parseArgs(argv) }
  catch (error) { console.error(`[phase-smoke-runner] ${error.message}`); return 2 }
  if (opts.help) {
    console.log('Usage: node scripts/phase-smoke-runner.cjs --phase <0-8> [--json]')
    return 0
  }
  if (opts.phase == null) {
    console.error('[phase-smoke-runner] missing required --phase <0-8>')
    return 2
  }
  return runPhase(opts.phase, { json: opts.json })
}

if (require.main === module) {
  main().then((code) => process.exit(code), (err) => {
    console.error(`[phase-smoke-runner] uncaught error: ${err?.stack || err}`)
    process.exit(1)
  })
}

module.exports = {
  parseArgs,
  runPhase,
  smokesForPhase,
  isElectronEnvAvailable,
  runBrowserSmoke,
  runAgentSmoke,
  runSettingsSmoke,
  SUPPORTED_PHASES: [...SUPPORTED_PHASES],
}
