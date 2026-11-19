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
  if (platform === 'win32') return path.join(ROOT, 'exports', 'win-unpacked', 'Ready Next.exe')
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

function getWebSocketConstructor() {
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket
  // Node 20 on GitHub runners may not expose the browser-compatible global.
  // `ws` is already available in this workspace dependency graph.
  return require('ws')
}

function addSocketListener(socket, eventName, handler) {
  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener(eventName, handler)
    return
  }
  socket.on(eventName, handler)
}

function socketMessageData(eventOrData) {
  if (eventOrData && typeof eventOrData === 'object' && 'data' in eventOrData) {
    return eventOrData.data
  }
  return eventOrData
}

function openCdpClient(webSocketDebuggerUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const WebSocketCtor = getWebSocketConstructor()
    const socket = new WebSocketCtor(webSocketDebuggerUrl)
    const pending = new Map()
    let nextId = 1
    let opened = false
    const openTimer = setTimeout(() => {
      reject(new Error(`Timed out opening DevTools websocket: ${webSocketDebuggerUrl}`))
      try { socket.close() } catch { /* ignore */ }
    }, Math.min(timeoutMs, 10000))

    function failAll(error) {
      for (const { reject: rejectPending } of pending.values()) rejectPending(error)
      pending.clear()
    }

    addSocketListener(socket, 'open', () => {
      opened = true
      clearTimeout(openTimer)
      resolve({
        send(method, params = {}) {
          return new Promise((resolveCommand, rejectCommand) => {
            const id = nextId++
            const commandTimer = setTimeout(() => {
              pending.delete(id)
              rejectCommand(new Error(`Timed out waiting for CDP method ${method}`))
            }, timeoutMs)
            pending.set(id, {
              resolve: (value) => {
                clearTimeout(commandTimer)
                resolveCommand(value)
              },
              reject: (error) => {
                clearTimeout(commandTimer)
                rejectCommand(error)
              },
            })
            socket.send(JSON.stringify({ id, method, params }))
          })
        },
        close() {
          try { socket.close() } catch { /* ignore */ }
        },
      })
    })

    addSocketListener(socket, 'message', (eventOrData) => {
      const data = socketMessageData(eventOrData)
      let message
      try {
        message = JSON.parse(String(data))
      } catch {
        return
      }
      if (!message || typeof message.id !== 'number') return
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      if (message.error) {
        waiter.reject(new Error(message.error.message || JSON.stringify(message.error)))
      } else {
        waiter.resolve(message)
      }
    })

    addSocketListener(socket, 'error', (error) => {
      if (!opened) {
        clearTimeout(openTimer)
        reject(error)
      }
      failAll(error)
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
            const url = String(target.url || '')
            return target.type === 'page' && url.includes('/out/renderer/')
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

async function evaluateRendererDom(page, timeoutMs) {
  if (!page.webSocketDebuggerUrl) {
    throw new Error('Ready renderer target is missing webSocketDebuggerUrl; cannot verify DOM readiness')
  }
  const client = await openCdpClient(page.webSocketDebuggerUrl, timeoutMs)
  try {
    await client.send('Runtime.enable')
    const deadline = Date.now() + timeoutMs
    let lastSnapshot = null
    while (Date.now() < deadline) {
      const evaluated = await client.send('Runtime.evaluate', {
        awaitPromise: true,
        returnByValue: true,
        expression: `(() => {
          const root = document.getElementById('root');
          const bodyText = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
          const interactiveCount = document.querySelectorAll('button,[role="button"],a,input,textarea,select').length;
          const title = document.title || '';
          const hasBootstrapError =
            Boolean(document.querySelector('[data-ready-bootstrap-error]')) ||
            /启动失败|bootstrap failed|白屏/i.test(bodyText);
          return {
            readyState: document.readyState,
            title,
            url: location.href,
            rootChildCount: root?.childElementCount || 0,
            bodyTextLength: bodyText.length,
            bodyTextSample: bodyText.slice(0, 500),
            interactiveCount,
            hasBootstrapError
          };
        })()`,
      })
      if (evaluated.exceptionDetails) {
        throw new Error(`Renderer DOM evaluation failed: ${evaluated.exceptionDetails.text || 'exception'}`)
      }
      lastSnapshot = evaluated.result?.result?.value || null
      if (
        lastSnapshot &&
        lastSnapshot.readyState !== 'loading' &&
        lastSnapshot.rootChildCount > 0 &&
        lastSnapshot.bodyTextLength > 20 &&
        lastSnapshot.interactiveCount > 0 &&
        !lastSnapshot.hasBootstrapError
      ) {
        return lastSnapshot
      }
      await sleep(500)
    }
    throw new Error(`Ready renderer DOM did not become interactive before timeout. Last snapshot: ${JSON.stringify(lastSnapshot)}`)
  } finally {
    client.close()
  }
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode != null) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const finish = (exited) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
  })
}

async function stopApp(child, platform) {
  if (!child || child.exitCode != null) return
  if (platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    return
  }
  child.kill('SIGTERM')
  if (await waitForChildExit(child, 5000)) return
  child.kill('SIGKILL')
  await waitForChildExit(child, 5000)
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const appPath = path.resolve(options.app || defaultAppPath(options.platform))
  if (!fs.existsSync(appPath)) {
    throw new Error(`Packaged app executable not found: ${appPath}`)
  }

  const startedAt = new Date().toISOString()
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-packaged-smoke-'))
  const isolatedTemp = path.join(userDataDir, 'temp')
  const windows = options.platform === 'win32'
  if (windows) fs.mkdirSync(isolatedTemp)
  const logs = []
  const child = spawn(appPath, [`--remote-debugging-port=${options.port}`], {
    cwd: ROOT,
    env: {
      ...process.env,
      READY_REMOTE_DEBUGGING_PORT: String(options.port),
      READY_USER_DATA_DIR: userDataDir,
      ...(windows && {
        READY_DB_PATH: path.join(userDataDir, 'ready.db'),
        TEMP: isolatedTemp, TMP: isolatedTemp, READY_TEST_LOG_ISOLATION: '1',
      }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => logs.push(String(chunk)))
  child.stderr.on('data', (chunk) => logs.push(String(chunk)))

  try {
    const { page, targets } = await pollTarget(options.port, options.timeoutMs)
    const renderer = await evaluateRendererDom(page, options.timeoutMs)
    const agentRecovery = windows
      ? await require('./codex-runtime/check-windows-packaged-recovery.cjs').checkWindowsPackagedRecovery({
        userDataDir, appPath, mainPid: child.pid, timeoutMs: options.timeoutMs,
      }) : undefined
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
      renderer,
      agentRecovery,
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
    await stopApp(child, options.platform)
  }
}

main().catch((error) => {
  console.error(`[run-packaged-smoke] ${error && error.stack ? error.stack : String(error)}`)
  process.exit(1)
})
