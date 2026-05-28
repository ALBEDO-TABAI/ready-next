#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')

function parseArgs(argv) {
  const options = {
    app: '',
    out: '',
    platform: process.platform,
    port: 9335,
    timeoutMs: 90000,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === '--app') {
      options.app = next || ''
      i += 1
    } else if (arg === '--out') {
      options.out = next || ''
      i += 1
    } else if (arg === '--platform') {
      options.platform = next || options.platform
      i += 1
    } else if (arg === '--port') {
      options.port = Number(next || options.port)
      i += 1
    } else if (arg === '--timeout') {
      options.timeoutMs = Number(next || options.timeoutMs)
      i += 1
    }
  }
  return options
}

function defaultAppPath(platform) {
  if (platform === 'win32') return path.join(ROOT, 'exports', 'win-unpacked', 'Ready.exe')
  if (platform === 'darwin') {
    return path.join(ROOT, 'exports', 'mac-arm64', 'Ready.app', 'Contents', 'MacOS', 'Ready')
  }
  return path.join(ROOT, 'exports', 'linux-unpacked', 'ready')
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
      })
      res.on('end', () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode || 'unknown'} from ${url}: ${body.slice(0, 200)}`))
          return
        }
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(error)
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(5000, () => {
      req.destroy(new Error(`Timed out requesting ${url}`))
    })
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pollTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const targets = await requestJson(`http://127.0.0.1:${port}/json/list`)
      const page = Array.isArray(targets)
        ? targets.find((target) => {
            const title = String(target.title || '')
            const url = String(target.url || '')
            return target.type === 'page' && (title.includes('Ready') || url.includes('/out/renderer/'))
          })
        : null
      if (page) return { page, targets }
    } catch (error) {
      lastError = error
    }
    await sleep(1000)
  }
  throw new Error(`Ready renderer target did not appear before timeout. Last error: ${lastError?.message || 'none'}`)
}

function stopApp(child, platform) {
  if (!child || child.exitCode != null) return
  if (platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    return
  }
  child.kill('SIGTERM')
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const appPath = path.resolve(options.app || defaultAppPath(options.platform))
  if (!fs.existsSync(appPath)) {
    throw new Error(`Packaged app executable not found: ${appPath}`)
  }

  const startedAt = new Date().toISOString()
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-packaged-smoke-'))
  const logs = []
  const child = spawn(appPath, [`--remote-debugging-port=${options.port}`], {
    cwd: ROOT,
    env: {
      ...process.env,
      READY_REMOTE_DEBUGGING_PORT: String(options.port),
      READY_USER_DATA_DIR: userDataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => logs.push(String(chunk)))
  child.stderr.on('data', (chunk) => logs.push(String(chunk)))

  try {
    const { page, targets } = await pollTarget(options.port, options.timeoutMs)
    const report = {
      status: 'pass',
      platform: options.platform,
      appPath,
      userDataDir,
      remoteDebuggingPort: options.port,
      startedAt,
      completedAt: new Date().toISOString(),
      target: {
        id: page.id,
        type: page.type,
        title: page.title,
        url: page.url,
      },
      targetCount: Array.isArray(targets) ? targets.length : 0,
      logTail: logs.join('').split(/\r?\n/).filter(Boolean).slice(-40),
    }
    if (options.out) {
      const outPath = path.resolve(options.out)
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n')
    }
    console.log(JSON.stringify(report, null, 2))
  } finally {
    stopApp(child, options.platform)
  }
}

main().catch((error) => {
  console.error(`[run-packaged-smoke] ${error && error.stack ? error.stack : String(error)}`)
  process.exit(1)
})
