/**
 * Worker-thread side of the DB worker. Owns its own better-sqlite3 connection
 * to the same ready.db file as the main process. The main thread continues to
 * own writes for repositories not migrated here (rss, calendar, settings, …);
 * SQLite WAL allows multiple readers + a single writer concurrently, so this
 * is safe as long as we set busy_timeout to absorb transient SQLITE_BUSY when
 * both sides happen to commit at once.
 *
 * Migrated query categories (perf-rescue B1):
 *   1. document graph (`runFileGetGraph` / `document:getGraph`) — reads up to
 *      681K rows from `documents` + N round-trips for BFS.
 *   2. document search (`SearchEngine.search`) — FTS scan over multi-GB DB.
 *   3. reindex (`SearchEngine.reindexWorkspace` / `reindexAllSources`) — walks
 *      the entire workspace and writes parsed rows in transactions.
 *
 * Everything else stays on the main thread for now (small, low-latency).
 */

import { createRequire } from 'module'
import { parentPort, workerData } from 'worker_threads'

import { runMigrations } from '../migrations'
import { applyPerformancePragmas, type DatabaseConnection } from '../database'
import { SearchEngine, probeFts5Availability } from '../search-engine/indexer'
import type { SearchHit } from '../search-engine/query'
import { queryDocumentGraph, type DocumentGraphQuery } from './document-graph-query'

type BetterSqliteCtor = new (path: string) => DatabaseConnection

const require = createRequire(import.meta.url)

let DatabaseConstructor: BetterSqliteCtor | null = null
try {
  const mod = require('better-sqlite3') as BetterSqliteCtor & { default?: BetterSqliteCtor }
  DatabaseConstructor = mod.default || mod
} catch (error) {
  // Worker can't talk to electron. Use console for diagnostics; the main
  // bridge will see the error via the message channel + worker exit.
  console.error('[db-worker] better-sqlite3 load failed', error)
}

interface InitWorkerData {
  dbPath: string
}

interface IncomingMessage {
  id: number
  cmd: string
  args?: unknown
}

interface OutgoingMessage {
  id: number
  ok: boolean
  data?: unknown
  error?: { message: string; stack?: string }
}

const data = (workerData ?? {}) as Partial<InitWorkerData>
if (!data.dbPath || typeof data.dbPath !== 'string') {
  throw new Error('[db-worker] missing dbPath in workerData')
}
if (!DatabaseConstructor) {
  throw new Error('[db-worker] better-sqlite3 unavailable')
}

const db: DatabaseConnection = new DatabaseConstructor(data.dbPath)
applyPerformancePragmas(db)

// Multiple connections share this DB (main thread + this worker). Set a
// generous busy_timeout so a writer commit on either side doesn't immediately
// throw SQLITE_BUSY on the other reader.
try {
  db.pragma?.('busy_timeout = 5000')
} catch (error) {
  console.warn('[db-worker] busy_timeout pragma failed', error)
}

// Run migrations defensively. The main thread runs them on startup; running
// here is a no-op once user_version is already at the latest version.
try {
  runMigrations(db)
} catch (error) {
  console.warn('[db-worker] runMigrations failed (non-fatal if already migrated)', error)
}

const fts5Available = probeFts5Availability(db)
const engine = new SearchEngine(db, { fts5Available })

if (!parentPort) {
  throw new Error('[db-worker] parentPort missing; this module must run in a worker_thread')
}

const port = parentPort

function reply(msg: OutgoingMessage): void {
  port.postMessage(msg)
}

interface SearchDocumentsArgs {
  query: string
  limit?: number
  workspaceRoot?: string
  workspaceRoots?: string[]
  sources?: string[]
}

type SearchPayload = {
  items: Array<SearchHit & { sourceType: string; sourceMeta?: Record<string, unknown> | null }>
  stats: { returned: number; elapsedMs: number }
  degraded: boolean
}

async function searchDocuments(args: SearchDocumentsArgs): Promise<SearchPayload> {
  return engine.search(args.query, {
    limit: args.limit,
    workspaceRoot: args.workspaceRoot,
    workspaceRoots: args.workspaceRoots,
    sources: args.sources,
  })
}

interface ReindexWorkspaceArgs { root: string }
interface ReindexAllSourcesArgs { root: string }

// perf-rescue B6: per-request abort controllers for in-flight reindex jobs.
// Keyed by message id so concurrent reindexes (e.g. one workspace + one
// shared) can be cancelled independently. `cancelReindex` aborts all entries.
// We don't track other commands (search/graph) since those return in <100ms
// and aren't worth the bookkeeping.
const activeReindexes = new Map<number, AbortController>()

port.on('message', (raw: unknown) => {
  const msg = raw as IncomingMessage
  if (!msg || typeof msg.id !== 'number' || typeof msg.cmd !== 'string') return

  if (msg.cmd === 'shutdown') {
    // Abort any in-flight reindex so we don't leak a pending sqlite write
    // through the close call. The reindex promise will reject with AbortError
    // but its reply has already been racing — we just want the worker to
    // exit cleanly.
    for (const ctrl of activeReindexes.values()) ctrl.abort()
    activeReindexes.clear()
    try { db.close() } catch { /* ignore */ }
    reply({ id: msg.id, ok: true })
    setTimeout(() => process.exit(0), 0)
    return
  }

  if (msg.cmd === 'cancelReindex') {
    const cancelled = activeReindexes.size
    for (const ctrl of activeReindexes.values()) ctrl.abort()
    activeReindexes.clear()
    reply({ id: msg.id, ok: true, data: cancelled })
    return
  }

  // Wrap the dispatch so any sync throw + async rejection both surface as a
  // structured error reply (the main bridge converts `ok:false` into a
  // rejected promise on the original call site).
  ;(async () => {
    try {
      let result: unknown
      switch (msg.cmd) {
        case 'getDocumentGraph':
          result = queryDocumentGraph(db, (msg.args ?? {}) as DocumentGraphQuery)
          break
        case 'searchDocuments':
          result = await searchDocuments((msg.args ?? {}) as SearchDocumentsArgs)
          break
        case 'reindexWorkspace': {
          const a = (msg.args ?? {}) as ReindexWorkspaceArgs
          const controller = new AbortController()
          activeReindexes.set(msg.id, controller)
          try {
            result = await engine.reindexWorkspace({ root: a.root, signal: controller.signal })
          } finally {
            activeReindexes.delete(msg.id)
          }
          break
        }
        case 'reindexAllSources': {
          const a = (msg.args ?? {}) as ReindexAllSourcesArgs
          const controller = new AbortController()
          activeReindexes.set(msg.id, controller)
          try {
            result = await engine.reindexAllSources({ root: a.root, signal: controller.signal })
          } finally {
            activeReindexes.delete(msg.id)
          }
          break
        }
        default:
          reply({ id: msg.id, ok: false, error: { message: `unknown cmd: ${msg.cmd}` } })
          return
      }
      reply({ id: msg.id, ok: true, data: result })
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error))
      reply({ id: msg.id, ok: false, error: { message: e.message, stack: e.stack } })
    }
  })()
})
