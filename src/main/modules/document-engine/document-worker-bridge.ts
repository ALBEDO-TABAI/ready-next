import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'

import type {
  DocumentWorkerApi,
  DocumentWorkerCommand,
  DocumentWorkerRequest,
  DocumentWorkerResponse,
  DocumentTextExtractOptions,
  DocumentTextExtractResult,
} from './document-worker-protocol'

const DEFAULT_IDLE_MS = 60_000
const IDLE_SHUTDOWN_GRACE_MS = 1_000
const EXPLICIT_SHUTDOWN_GRACE_MS = 4_500

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
}

export interface DocumentWorkerLike {
  postMessage(value: unknown): void
  on(event: 'message', listener: (message: unknown) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'exit', listener: (code: number) => void): void
  terminate(): Promise<unknown> | unknown
}

export type DocumentWorkerFactory = () => DocumentWorkerLike

function workerFailure(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

export class DocumentWorkerBridge implements DocumentWorkerApi {
  private worker: DocumentWorkerLike | null = null
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private terminated = false

  constructor(
    private readonly factory: DocumentWorkerFactory,
    private readonly idleMs = DEFAULT_IDLE_MS,
  ) {}

  private clearIdleTimer(): void {
    if (!this.idleTimer) return
    clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private scheduleIdleShutdown(): void {
    this.clearIdleTimer()
    if (!this.worker || this.pending.size > 0 || this.terminated) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.pending.size > 0 || !this.worker) return
      const worker = this.worker
      this.worker = null
      try {
        worker.postMessage({ id: 0, cmd: 'shutdown' } satisfies DocumentWorkerRequest)
      } catch {
        void worker.terminate()
        return
      }
      const forceTimer = setTimeout(() => { void worker.terminate() }, IDLE_SHUTDOWN_GRACE_MS)
      forceTimer.unref?.()
    }, Math.max(0, this.idleMs))
    this.idleTimer.unref?.()
  }

  private ensureWorker(): DocumentWorkerLike {
    if (this.terminated) throw workerFailure('document worker is shut down', 'DOCUMENT_WORKER_SHUTDOWN')
    if (this.worker) return this.worker
    const worker = this.factory()
    this.worker = worker
    worker.on('message', (raw) => this.handleMessage(worker, raw))
    worker.on('error', (error) => this.handleFailure(worker, workerFailure(
      `document worker crashed: ${error.message}`,
      'DOCUMENT_WORKER_CRASH',
    )))
    worker.on('exit', (code) => {
      if (this.worker !== worker) return
      if (code === 0 && this.pending.size === 0) {
        this.worker = null
        return
      }
      this.handleFailure(worker, workerFailure(
        `document worker exited before completing requests (code ${code})`,
        'DOCUMENT_WORKER_EXIT',
      ))
    })
    return worker
  }

  private handleMessage(worker: DocumentWorkerLike, raw: unknown): void {
    if (this.worker !== worker) return
    const message = raw as DocumentWorkerResponse
    if (!message || typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.ok) {
      pending.resolve(message.data)
    } else {
      const error = workerFailure(
        message.error?.message || 'document worker request failed',
        message.error?.code || 'DOCUMENT_WORKER_REQUEST_FAILED',
      )
      if (message.error?.stack) error.stack = message.error.stack
      pending.reject(error)
    }
    this.scheduleIdleShutdown()
  }

  private handleFailure(worker: DocumentWorkerLike, error: Error): void {
    if (this.worker !== worker) return
    this.worker = null
    this.clearIdleTimer()
    const requests = Array.from(this.pending.values())
    this.pending.clear()
    for (const pending of requests) pending.reject(error)
  }

  private request<T>(cmd: DocumentWorkerCommand, args?: Record<string, unknown>): Promise<T> {
    this.clearIdleTimer()
    let worker: DocumentWorkerLike
    try {
      worker = this.ensureWorker()
    } catch (error) {
      return Promise.reject(error)
    }
    const id = this.nextId
    this.nextId += 1
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject })
    })
    try {
      worker.postMessage({ id, cmd, args } satisfies DocumentWorkerRequest)
    } catch (error) {
      this.pending.delete(id)
      this.scheduleIdleShutdown()
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    return promise
  }

  parseDocx(path: string): Promise<Record<string, unknown>> {
    return this.request('parseDocx', { path })
  }

  parseXlsx(path: string): Promise<Record<string, unknown>> {
    return this.request('parseXlsx', { path })
  }

  importEpub(sourcePath: string): Promise<Record<string, unknown>> {
    return this.request('importEpub', { sourcePath })
  }

  extractDocumentText(path: string, options?: DocumentTextExtractOptions): Promise<DocumentTextExtractResult> {
    return this.request('extractDocumentText', { path, options })
  }

  readDocxText(path: string): Promise<{ success: boolean; content: string; error?: string }> {
    return this.request('readDocxText', { path })
  }

  writeDocx(path: string, content: string): Promise<{ success: boolean; error?: string }> {
    return this.request('writeDocx', { path, content })
  }

  async shutdown(): Promise<void> {
    if (this.terminated) return
    this.terminated = true
    this.clearIdleTimer()
    const worker = this.worker
    this.worker = null
    const requests = Array.from(this.pending.values())
    this.pending.clear()
    for (const pending of requests) {
      pending.reject(workerFailure('document worker shut down', 'DOCUMENT_WORKER_SHUTDOWN'))
    }
    if (!worker) return

    let exited = false
    const exitPromise = new Promise<void>((resolve) => {
      worker.on('exit', () => {
        exited = true
        resolve()
      })
    })
    try {
      worker.postMessage({ id: 0, cmd: 'shutdown' } satisfies DocumentWorkerRequest)
    } catch {
      // Termination below is the fallback.
    }
    await Promise.race([
      exitPromise,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, EXPLICIT_SHUTDOWN_GRACE_MS)
        timer.unref?.()
      }),
    ])
    if (!exited) await Promise.resolve(worker.terminate()).catch(() => undefined)
  }

  getStatsForTests(): { running: boolean; pending: number; terminated: boolean } {
    return { running: this.worker !== null, pending: this.pending.size, terminated: this.terminated }
  }
}

let singleton: DocumentWorkerBridge | null = null

export function resolveDocumentWorkerPath(): string {
  const moduleDirectory = typeof __dirname === 'string'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(moduleDirectory, 'document-worker.js'),
    join(moduleDirectory, 'document-worker.mjs'),
    join(process.cwd(), 'out', 'main', 'document-worker.js'),
    join(process.cwd(), 'out', 'main', 'document-worker.mjs'),
    join(process.resourcesPath || '', 'app.asar', 'out', 'main', 'document-worker.js'),
    join(process.resourcesPath || '', 'app.asar.unpacked', 'out', 'main', 'document-worker.js'),
  ]
  return candidates.find((candidate) => candidate && existsSync(candidate)) || candidates[0]
}

function defaultFactory(): DocumentWorkerLike {
  return new Worker(resolveDocumentWorkerPath()) as unknown as DocumentWorkerLike
}

export function getDocumentWorker(): DocumentWorkerApi {
  singleton ??= new DocumentWorkerBridge(defaultFactory)
  return singleton
}

export function setDocumentWorkerForTests(worker: DocumentWorkerBridge | null): void {
  singleton = worker
}

export async function shutdownDocumentWorker(): Promise<void> {
  if (!singleton) return
  await singleton.shutdown()
  singleton = null
}
