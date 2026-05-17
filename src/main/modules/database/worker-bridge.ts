/**
 * Main-thread side of the DB worker. Spawns a single worker_thread, forwards
 * focused queries onto it, and correlates replies via an integer request id.
 *
 * Lifecycle:
 *   - Lazy-spawn on first call to `getWorkerDbBridge()`.
 *   - On crash (`error`/`exit` with non-zero code), reject all pending
 *     requests, then auto-restart up to MAX_RESTARTS (3) times. Subsequent
 *     calls fall through to a rejected promise so callers can fall back.
 *   - `shutdown()` sends a graceful `shutdown` cmd, then `terminate()`.
 *
 * The bridge intentionally exposes only the small set of methods that the
 * task migrates (graph/search/reindex). Callers that need other DB tables
 * keep using `getDatabase()` on the main thread.
 */

import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { Worker } from 'worker_threads'
import { createRequire } from 'module'
import { createRotatingLogger } from '../../utils/rotating-logger'
import type { SearchHit } from '../search-engine/query'
import type {
  ReindexAllSourcesResult,
  ReindexWorkspaceResult,
} from '../search-engine/indexer'

const require = createRequire(import.meta.url)
let electronModule: typeof import('electron') | null = null
try { electronModule = require('electron') as typeof import('electron') }
catch { electronModule = null }

const dbBridgeLogger = createRotatingLogger('ready-database.log')
function logBridge(message: string): void {
  try { dbBridgeLogger.append(`[${new Date().toISOString()}] [worker-bridge] ${message}\n`) }
  catch { /* ignore */ }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  cmd: string
}

interface OutgoingMessage {
  id: number
  cmd: string
  args?: unknown
}

interface IncomingMessage {
  id: number
  ok: boolean
  data?: unknown
  error?: { message: string; stack?: string }
}

export interface GraphResult {
  nodes: Array<{ id: string; type: 'doc' | 'tag' | 'ghost'; label: string; sourceType?: string }>
  edges: Array<{ source: string; target: string; kind: string }>
  note?: string
  // B3: degrade signal + pagination cursor.
  degraded?: boolean
  totalDocs?: number
  nextCursor?: { afterId: number } | null
}

export type SearchResult = SearchHit & {
  sourceType: string
  sourceMeta?: Record<string, unknown> | null
}

export interface SearchPayload {
  items: SearchResult[]
  stats: { returned: number; elapsedMs: number }
  degraded: boolean
}

export interface WorkerDbBridge {
  getDocumentGraph(opts: {
    workspaceRoot?: string
    centerPath?: string
    depth?: number
    limit?: number
    cursor?: { afterId: number }
    mode?: 'full' | 'focus'
  }): Promise<GraphResult>
  searchDocuments(opts: {
    query: string
    workspaceRoot?: string
    workspaceRoots?: string[]
    limit?: number
    sources?: string[]
  }): Promise<SearchPayload>
  reindexWorkspace(opts: { root: string }): Promise<ReindexWorkspaceResult>
  reindexAllSources(opts: { root: string }): Promise<ReindexAllSourcesResult>
  /**
   * perf-rescue B6: cancel every in-flight reindex inside the worker. Returns
   * the number of jobs aborted (0 if none were running). The cancelled
   * reindexWorkspace/reindexAllSources promises will resolve with their own
   * partial-result payload (or reject with AbortError surfaced through the
   * structured `error.message`), depending on which boundary they were at.
   */
  cancelReindex(): Promise<number>
  shutdown(): Promise<void>
  // Test-only escape hatch — never call from production code.
  __isAvailable(): boolean
}

/**
 * Minimal subset of `worker_threads.Worker` that the bridge depends on. Tests
 * inject a fake `WorkerLike` to avoid spawning a real thread.
 */
export interface WorkerLike {
  postMessage(value: unknown): void
  on(event: 'message', listener: (raw: unknown) => void): void
  on(event: 'error', listener: (err: Error) => void): void
  on(event: 'exit', listener: (code: number) => void): void
  terminate(): Promise<unknown> | unknown
}

export type WorkerFactory = (workerData: { dbPath: string }) => WorkerLike

const MAX_RESTARTS = 3

export class WorkerDbBridgeImpl implements WorkerDbBridge {
  private worker: WorkerLike | null = null
  private pending = new Map<number, PendingRequest>()
  private nextId = 1
  private restartCount = 0
  private terminated = false
  private readonly dbPath: string
  private readonly factory: WorkerFactory

  constructor(dbPath: string, factory: WorkerFactory) {
    this.dbPath = dbPath
    this.factory = factory
    this.spawn()
  }

  private spawn(): void {
    if (this.terminated) return
    try {
      const w = this.factory({ dbPath: this.dbPath })
      w.on('message', (raw: unknown) => this.onMessage(raw))
      w.on('error', (err: Error) => this.onWorkerError(err))
      w.on('exit', (code: number) => this.onWorkerExit(code))
      this.worker = w
      logBridge(`worker spawned dbPath=${this.dbPath}`)
    } catch (error) {
      logBridge(`worker spawn failed error=${error instanceof Error ? error.message : String(error)}`)
      this.worker = null
    }
  }

  private onMessage(raw: unknown): void {
    const msg = raw as IncomingMessage
    if (!msg || typeof msg.id !== 'number') return
    const pending = this.pending.get(msg.id)
    if (!pending) return
    this.pending.delete(msg.id)
    if (msg.ok) {
      pending.resolve(msg.data)
    } else {
      const err = new Error(msg.error?.message ?? 'unknown worker error')
      if (msg.error?.stack) err.stack = msg.error.stack
      pending.reject(err)
    }
  }

  private onWorkerError(err: Error): void {
    logBridge(`worker error: ${err.message}`)
    this.flushPendingWithError(new Error(`db-worker errored: ${err.message}`))
    // `exit` will fire next; restart logic lives there.
  }

  private onWorkerExit(code: number): void {
    logBridge(`worker exit code=${code}`)
    this.worker = null
    this.flushPendingWithError(new Error(`db-worker exited (code=${code})`))
    if (this.terminated) return
    if (code === 0) return // graceful shutdown
    if (this.restartCount >= MAX_RESTARTS) {
      logBridge(`worker exceeded max restarts (${MAX_RESTARTS}); not restarting`)
      this.terminated = true
      return
    }
    this.restartCount += 1
    logBridge(`worker restarting (attempt ${this.restartCount}/${MAX_RESTARTS})`)
    this.spawn()
  }

  private flushPendingWithError(err: Error): void {
    if (this.pending.size === 0) return
    const snapshot = Array.from(this.pending.values())
    this.pending.clear()
    for (const p of snapshot) p.reject(err)
  }

  private send<T>(cmd: string, args?: unknown): Promise<T> {
    if (this.terminated) {
      return Promise.reject(new Error('db-worker terminated; cannot send'))
    }
    if (!this.worker) {
      return Promise.reject(new Error('db-worker unavailable'))
    }
    const id = this.nextId++
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value: unknown) => resolve(value as T),
        reject,
        cmd,
      })
    })
    const msg: OutgoingMessage = { id, cmd, args }
    try {
      this.worker.postMessage(msg)
    } catch (error) {
      this.pending.delete(id)
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    return promise
  }

  getDocumentGraph(opts: {
    workspaceRoot?: string
    centerPath?: string
    depth?: number
    limit?: number
    cursor?: { afterId: number }
    mode?: 'full' | 'focus'
  }): Promise<GraphResult> {
    return this.send<GraphResult>('getDocumentGraph', opts ?? {})
  }

  searchDocuments(opts: {
    query: string
    workspaceRoot?: string
    workspaceRoots?: string[]
    limit?: number
    sources?: string[]
  }): Promise<SearchPayload> {
    return this.send<SearchPayload>('searchDocuments', opts)
  }

  reindexWorkspace(opts: { root: string }): Promise<ReindexWorkspaceResult> {
    return this.send<ReindexWorkspaceResult>('reindexWorkspace', opts)
  }

  reindexAllSources(opts: { root: string }): Promise<ReindexAllSourcesResult> {
    return this.send<ReindexAllSourcesResult>('reindexAllSources', opts)
  }

  cancelReindex(): Promise<number> {
    return this.send<number>('cancelReindex')
  }

  async shutdown(): Promise<void> {
    if (this.terminated) return
    const w = this.worker
    if (!w) {
      this.terminated = true
      return
    }
    // Best-effort graceful shutdown so the worker can close its DB cleanly.
    // Important: post the `shutdown` cmd BEFORE flipping `terminated` so the
    // request actually goes out (send() rejects synchronously when terminated).
    let shutdownAck: Promise<unknown> | null = null
    try {
      shutdownAck = this.send<void>('shutdown')
    } catch { /* ignore */ }
    this.terminated = true
    if (shutdownAck) {
      try {
        await Promise.race([
          shutdownAck,
          new Promise<void>((resolve) => {
            const handle = setTimeout(resolve, 1000)
            // Don't keep node alive solely to wait for an absent ack — once the
            // rest of the cleanup chain finishes, let the loop drain.
            if (typeof handle.unref === 'function') handle.unref()
          }),
        ])
      } catch { /* ignore */ }
    }
    try { await w.terminate() } catch { /* ignore */ }
    this.flushPendingWithError(new Error('db-worker shutdown'))
    this.worker = null
  }

  __isAvailable(): boolean {
    return !!this.worker && !this.terminated
  }
}

let singleton: WorkerDbBridgeImpl | null = null

function resolveDbPath(): string {
  if (electronModule?.app) {
    const userData = electronModule.app.getPath('userData')
    return join(userData, 'ready.db')
  }
  // Worker can also be tested with an explicit env override.
  if (process.env.READY_DB_PATH) return process.env.READY_DB_PATH
  throw new Error('cannot resolve ready.db path: electron app unavailable and READY_DB_PATH not set')
}

function resolveWorkerPath(): string {
  // Dev: tsx/node entry — load the .ts source directly via electron-vite's
  // dev server, but since worker_threads can't run .ts, we load the bundled
  // out path. In dev `electron-vite dev` writes to out/main as well.
  // Search the same candidates as rsshub-worker in priority order.
  const electronUtil = (() => { try { return require('@electron-toolkit/utils') as typeof import('@electron-toolkit/utils') } catch { return null } })()
  const isDev = electronUtil?.is?.dev ?? (process.env.NODE_ENV !== 'production')
  const candidates: string[] = []
  if (electronModule?.app) {
    const appPath = electronModule.app.getAppPath()
    candidates.push(
      join(appPath, 'out', 'main', 'db-worker.js'),
      join(appPath, 'out', 'main', 'db-worker.mjs'),
      join(process.resourcesPath ?? '', 'app.asar.unpacked', 'out', 'main', 'db-worker.js'),
      join(dirname(appPath), 'db-worker.mjs'),
    )
  }
  if (isDev) {
    candidates.push(join(process.cwd(), 'out', 'main', 'db-worker.js'))
    candidates.push(join(process.cwd(), 'out', 'main', 'db-worker.mjs'))
  }
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  // Last resort — return the first candidate so the spawn error surfaces in
  // the log with a path the developer can investigate.
  return candidates[0] ?? join(process.cwd(), 'out', 'main', 'db-worker.js')
}

function defaultWorkerFactory(workerPath: string): WorkerFactory {
  return ({ dbPath }) => {
    const w = new Worker(workerPath, { workerData: { dbPath } })
    return w as unknown as WorkerLike
  }
}

export function getWorkerDbBridge(): WorkerDbBridge {
  if (singleton) return singleton
  const dbPath = resolveDbPath()
  const workerPath = resolveWorkerPath()
  singleton = new WorkerDbBridgeImpl(dbPath, defaultWorkerFactory(workerPath))
  return singleton
}

/** Test-only — replace the singleton with an explicit instance. */
export function __setWorkerDbBridgeForTest(bridge: WorkerDbBridge | null): void {
  singleton = bridge as WorkerDbBridgeImpl | null
}

/**
 * Tear down the worker on app quit. Safe to call even if the worker was never
 * spawned. Returns once the underlying worker_thread has exited (or after
 * the shutdown timeout).
 */
export async function shutdownWorkerDbBridge(): Promise<void> {
  if (!singleton) return
  await singleton.shutdown()
  singleton = null
}
