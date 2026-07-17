import { parentPort } from 'node:worker_threads'

import {
  extractDocumentTextOperation,
  importEpubOperation,
  parseDocxOperation,
  parseXlsxOperation,
  readDocxTextOperation,
  writeDocxOperation,
} from './document-worker-operations'
import type {
  DocumentWorkerRequest,
  DocumentWorkerResponse,
} from './document-worker-protocol'

if (!parentPort) throw new Error('[document-worker] parentPort missing')
const port = parentPort
const activeTasks = new Set<Promise<void>>()
let taskQueue = Promise.resolve()
let shuttingDown = false

function reply(message: DocumentWorkerResponse): void {
  port.postMessage(message)
}

port.on('message', (raw: unknown) => {
  const request = raw as DocumentWorkerRequest
  if (!request || typeof request.id !== 'number' || typeof request.cmd !== 'string') return

  if (request.cmd === 'shutdown') {
    shuttingDown = true
    void Promise.allSettled(Array.from(activeTasks)).then(() => {
      reply({ id: request.id, ok: true })
      setTimeout(() => process.exit(0), 0)
    })
    return
  }

  if (shuttingDown) {
    reply({ id: request.id, ok: false, error: { message: 'document worker is shutting down', code: 'DOCUMENT_WORKER_SHUTDOWN' } })
    return
  }

  const task = taskQueue.then(async () => {
    try {
      const args = request.args ?? {}
      let data: unknown
      switch (request.cmd) {
        case 'parseDocx':
          data = await parseDocxOperation(String(args.path || ''))
          break
        case 'parseXlsx':
          data = await parseXlsxOperation(String(args.path || ''))
          break
        case 'importEpub':
          data = await importEpubOperation(String(args.sourcePath || ''))
          break
        case 'extractDocumentText':
          data = await extractDocumentTextOperation(
            String(args.path || ''),
            args.options && typeof args.options === 'object' ? args.options : {},
          )
          break
        case 'readDocxText':
          data = await readDocxTextOperation(String(args.path || ''))
          break
        case 'writeDocx':
          data = await writeDocxOperation(String(args.path || ''), String(args.content ?? ''))
          break
        default:
          throw Object.assign(new Error(`unknown document worker command: ${String(request.cmd)}`), {
            code: 'UNKNOWN_COMMAND',
          })
      }
      reply({ id: request.id, ok: true, data })
    } catch (error) {
      const resolved = error instanceof Error ? error : new Error(String(error))
      reply({
        id: request.id,
        ok: false,
        error: {
          message: resolved.message,
          stack: resolved.stack,
          code: typeof (resolved as Error & { code?: unknown }).code === 'string'
            ? (resolved as Error & { code: string }).code
            : undefined,
        },
      })
    }
  })
  taskQueue = task.catch(() => undefined)
  activeTasks.add(task)
  void task.finally(() => activeTasks.delete(task))
})
