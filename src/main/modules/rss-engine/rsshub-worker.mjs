// Embedded RSSHub worker.
// Runs as a child process and exposes a local HTTP service on 127.0.0.1.

import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readdir, readFile } from 'node:fs/promises'
import { init } from 'rsshub'

const PORT = Number.parseInt(process.env.RSSHUB_PORT || '1200', 10)
const HOST = '127.0.0.1'

/**
 * RSSHub package exports `init()` but not the initialized app instance.
 * We dynamically find the internal app module by locating the generated file
 * that imports app-bootstrap, then call `app.fetch(request)`.
 */
async function resolveRSSHubApp() {
  const pkgEntryUrl = await import.meta.resolve('rsshub')
  const pkgEntryPath = fileURLToPath(pkgEntryUrl)
  const distDir = dirname(pkgEntryPath)
  const files = await readdir(distDir)

  for (const fileName of files) {
    if (!/^app-[A-Za-z0-9_-]+\.mjs$/.test(fileName)) continue
    const fullPath = join(distDir, fileName)
    const source = await readFile(fullPath, 'utf8')
    if (!source.includes('app-bootstrap-') || !source.includes('app_default')) continue
    const mod = await import(pathToFileURL(fullPath).href)
    if (mod?.default?.fetch) return mod.default
  }

  throw new Error('Unable to resolve RSSHub app module')
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

  const app = await resolveRSSHubApp()

  const server = createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', `http://${HOST}:${PORT}`)

      if (reqUrl.pathname === '/healthz') {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: true, service: 'rsshub-embedded', port: PORT }))
        return
      }

      const method = req.method || 'GET'
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) {
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
      const request = new Request(reqUrl.toString(), {
        method,
        headers,
        body,
        signal: timeout.controller.signal,
      })

      const response = await app.fetch(request)
      timeout.clear()
      await toNodeResponse(res, response)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
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
    process.send?.({
      type: 'error',
      message: err?.message || String(err),
      code: err?.code,
    })
    process.exit(1)
  })

  process.on('message', (msg) => {
    if (msg !== 'shutdown') return
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 5000)
  })
}

start().catch((error) => {
  process.send?.({
    type: 'error',
    message: error instanceof Error ? error.message : String(error),
  })
  process.exit(1)
})
