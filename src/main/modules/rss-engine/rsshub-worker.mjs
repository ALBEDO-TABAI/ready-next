// Embedded RSSHub worker.
// Runs as a child process and exposes a local HTTP service on 127.0.0.1.

import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { init } from 'rsshub'

const PORT = Number.parseInt(process.env.RSSHUB_PORT || '1200', 10)
const HOST = '127.0.0.1'

function reportWorkerError(error, context = 'rsshub-worker') {
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? error.stack : undefined
  console.error(`[${context}] ${message}`)
  if (stack) {
    console.error(stack)
  }
  process.send?.({ type: 'error', message })
}

async function toNodeResponse(res, response) {
  res.statusCode = response.status
  response.headers.forEach((value, key) => {
    // Let node/http handle content-length automatically when body changes.
    if (key.toLowerCase() === 'content-length') return
    res.setHeader(key, value)
  })
  const body = Buffer.from(await response.arrayBuffer())
  res.end(body)
}

function createAbortableTimeout(timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { controller, clear: () => clearTimeout(timer) }
}

async function start() {
  await init({
    IS_PACKAGE: true,
    CACHE_TYPE: 'memory',
    ALLOW_ORIGIN: '*',
    NODE_ENV: 'production',
  })

  const pkgEntryUrl = await import.meta.resolve('rsshub')
  const pkgSource = await readFile(fileURLToPath(pkgEntryUrl), 'utf8')
  const match = pkgSource.match(/import\("(\.\/app-[^"]+\.mjs)"\)/)

  if (!match?.[1]) {
    throw new Error('Unable to resolve RSSHub app module from package entry')
  }

  const appUrl = new URL(match[1], pkgEntryUrl).href
  const mod = await import(appUrl)
  if (!mod?.default?.request) {
    throw new Error('Resolved RSSHub app module is missing request()')
  }

  const rsshubApp = mod.default

  const server = createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', `http://${HOST}:${PORT}`)

      if (reqUrl.pathname === '/healthz') {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: true, service: 'rsshub-embedded', port: PORT }))
        return
      }

      if (reqUrl.pathname === '/shutdown') {
        res.statusCode = 202
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: true, service: 'rsshub-embedded', shuttingDown: true }))
        setTimeout(() => {
          server.close(() => process.exit(0))
          setTimeout(() => process.exit(1), 5000)
        }, 50)
        return
      }

      const method = req.method || 'GET'
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) {
        const lowerKey = key.toLowerCase()
        if (lowerKey === 'host' || lowerKey === 'connection' || lowerKey === 'content-length') {
          continue
        }
        if (Array.isArray(value)) {
          headers.set(key, value.join(', '))
        } else if (typeof value === 'string') {
          headers.set(key, value)
        }
      }

      let body = undefined
      if (method !== 'GET' && method !== 'HEAD') {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const buf = Buffer.concat(chunks)
        if (buf.length > 0) body = buf
      }

      const timeout = createAbortableTimeout(30_000)
      const response = await rsshubApp.request(`${reqUrl.pathname}${reqUrl.search}`, {
        method,
        headers,
        body,
        signal: timeout.controller.signal,
      })
      timeout.clear()
      await toNodeResponse(res, response)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      reportWorkerError(error, 'rsshub-worker:request')
      res.statusCode = 500
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: message }))
    }
  })

  server.listen(PORT, HOST, () => {
    process.send?.({ type: 'ready', port: PORT })
  })

  server.on('error', (error) => {
    const err = error
    reportWorkerError(err, 'rsshub-worker:server')
    process.exit(1)
  })

  process.on('message', (msg) => {
    if (msg !== 'shutdown') return
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 5000)
  })
}

process.on('uncaughtException', (error) => {
  reportWorkerError(error, 'rsshub-worker:uncaughtException')
  process.exit(1)
})

process.on('unhandledRejection', (error) => {
  reportWorkerError(error, 'rsshub-worker:unhandledRejection')
  process.exit(1)
})

start().catch((error) => {
  reportWorkerError(error, 'rsshub-worker:start')
  process.exit(1)
})
