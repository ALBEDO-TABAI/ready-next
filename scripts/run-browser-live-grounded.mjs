#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'

const require = createRequire(import.meta.url)
const { buildSourceManifest, sha256File } = require('./browser-live-proof-manifest.cjs')

const root = process.cwd()
const handshakeOnly = process.argv.includes('--handshake-only')
const proofNonce = randomBytes(24).toString('hex')
const sourceManifest = buildSourceManifest(root)
const embeddedManifestPath = resolve(root, 'build/browser-live-proof/source-manifest.json')
mkdirSync(dirname(embeddedManifestPath), { recursive: true })
writeFileSync(embeddedManifestPath, `${JSON.stringify(sourceManifest, null, 2)}\n`)

const runRoot = resolve(root, 'outputs/browser-live-grounded', proofNonce)
const runTmp = resolve(runRoot, 'tmp')
const databasePath = resolve(runRoot, 'ready.db')
mkdirSync(runTmp, { recursive: true })

let acceptanceProfile
let sourceDatabasePath = null
let sourceDatabaseShaBefore = null
if (handshakeOnly) {
  acceptanceProfile = mkdtempSync(join(tmpdir(), 'ready-browser-live-handshake-'))
} else {
  const supplied = process.env.READY_BROWSER_LIVE_ACCEPTANCE_PROFILE?.trim()
  if (!supplied) {
    throw new Error('READY_BROWSER_LIVE_ACCEPTANCE_PROFILE is required; it must name the dedicated, user-authorized acceptance profile')
  }
  acceptanceProfile = realpathSync(resolve(supplied))
  const dailyProfile = resolve(homedir(), 'Library/Application Support/Ready')
  if (acceptanceProfile === dailyProfile) throw new Error('daily Ready profile is forbidden for live acceptance')
  sourceDatabasePath = resolve(acceptanceProfile, 'ready.db')
  if (!existsSync(sourceDatabasePath)) throw new Error('dedicated acceptance profile has no ready.db provider seed')
  sourceDatabaseShaBefore = sha256File(sourceDatabasePath)
  copyFileSync(sourceDatabasePath, databasePath)
}

await run('npm', ['run', 'build:dir'])
const executablePath = findExecutable()
const port = 9400 + Number.parseInt(proofNonce.slice(0, 3), 16) % 400
const logs = []
const child = spawn(executablePath, [`--remote-debugging-port=${port}`], {
  cwd: root,
  env: {
    ...process.env,
    TMPDIR: runTmp,
    READY_BROWSER_LIVE_PROOF_NONCE: proofNonce,
    READY_DB_PATH: databasePath,
    READY_REMOTE_DEBUGGING_PORT: String(port),
    READY_USER_DATA_DIR: acceptanceProfile,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (chunk) => pushLogs(logs, chunk))
child.stderr.on('data', (chunk) => pushLogs(logs, chunk))

let client
try {
  const target = await waitForRendererTarget(port, 90_000)
  client = await connect(target.webSocketDebuggerUrl)
  const handshake = await evaluate(client, `window.electronAPI.app.browserLiveProofHandshake(${JSON.stringify(proofNonce)})`)
  assertHandshake(handshake)
  const report = {
    ok: handshakeOnly,
    mode: handshakeOnly ? 'handshake-only' : 'full',
    proofNonce,
    sourceManifest,
    handshake,
    paths: { userData: acceptanceProfile, database: databasePath, runRoot, tmp: runTmp },
    profilePolicy: {
      dedicatedAcceptanceProfile: !handshakeOnly,
      dailyProfileReads: 0,
      dailyProfileWrites: 0,
      sourceDatabasePath: sourceDatabasePath ? '<dedicated-acceptance-profile>/ready.db' : null,
      sourceDatabaseShaBefore,
      sourceDatabaseShaAfter: sourceDatabasePath ? sha256File(sourceDatabasePath) : null,
    },
    acceptanceMatrix: [],
    realSite: { xhsRuns: [], otherSites: [] },
    logTail: logs.slice(-120),
  }
  if (sourceDatabaseShaBefore && report.profilePolicy.sourceDatabaseShaAfter !== sourceDatabaseShaBefore) {
    throw new Error('dedicated acceptance seed database changed during proof')
  }
  const reportPath = resolve(runRoot, 'browser-live-grounded-report.json')
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  if (handshakeOnly) {
    console.log(JSON.stringify({ ok: true, reportPath, handshake }, null, 2))
  } else {
    throw new Error(`live acceptance driver requires the authorized profile and must produce A1-A12 before validation: ${reportPath}`)
  }
} finally {
  client?.close()
  child.kill('SIGTERM')
  await waitForExit(child, 10_000)
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

function assertHandshake(handshake) {
  if (!handshake?.success) throw new Error(`runtime handshake failed: ${handshake?.error || 'unknown'}`)
  if (handshake.proofNonce !== proofNonce) throw new Error('runtime proof nonce mismatch')
  if (handshake.sourceManifestDigest !== sourceManifest.digest) throw new Error('embedded source manifest mismatch')
  if (handshake.execPath !== executablePath || handshake.execSha256 !== sha256File(executablePath)) throw new Error('runtime executable mismatch')
  if (!handshake.asarPath || handshake.asarSha256 !== sha256File(handshake.asarPath)) throw new Error('runtime asar mismatch')
  if (handshake.userDataPath !== acceptanceProfile || handshake.databasePath !== databasePath) throw new Error('runtime data-path mismatch')
  if (handshake.appVersion !== sourceManifest.appVersion) throw new Error('runtime version mismatch')
}

async function run(command, args) {
  await new Promise((resolveRun, rejectRun) => {
    const proc = spawn(command, args, { cwd: root, env: process.env, stdio: 'inherit' })
    proc.once('error', rejectRun)
    proc.once('exit', (code, signal) => code === 0
      ? resolveRun()
      : rejectRun(new Error(`${command} ${args.join(' ')} failed code=${code} signal=${signal}`)))
  })
}

async function waitForRendererTarget(remotePort, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${remotePort}/json/list`)
      const targets = response.ok ? await response.json() : []
      const target = targets.find((item) => (
        item.type === 'page'
        && item.webSocketDebuggerUrl
        && /\/index\.html(?:[?#].*)?$/.test(String(item.url || ''))
        && !/overlay/.test(String(item.url || ''))
      ))
      if (target) return target
    } catch (error) {
      lastError = error
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  }
  throw new Error(`Ready renderer target unavailable: ${lastError?.message || 'timeout'}`)
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

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result?.value
}

function pushLogs(target, chunk) {
  target.push(...String(chunk).split(/\r?\n/).filter(Boolean))
  if (target.length > 400) target.splice(0, target.length - 400)
}

async function waitForExit(proc, timeoutMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  await new Promise((resolveWait) => {
    const timer = setTimeout(resolveWait, timeoutMs)
    proc.once('exit', () => { clearTimeout(timer); resolveWait() })
  })
}
