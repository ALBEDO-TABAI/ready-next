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

// B3: graph endpoint hard caps to prevent main-thread OOM (681K rows would
// blow the IPC payload to ~67MB; renderer force-layout caps at 500 anyway).
const GRAPH_DEFAULT_LIMIT = 1000
const GRAPH_MAX_LIMIT = 5000
const GRAPH_DEGRADED_THRESHOLD = 500

interface GetDocumentGraphArgs {
  workspaceRoot?: string
  centerPath?: string
  depth?: number
  limit?: number
  cursor?: { afterId: number }
  mode?: 'full' | 'focus'
}

interface GraphNode {
  id: string
  type: 'doc' | 'tag' | 'ghost'
  label: string
  sourceType?: string
}
interface GraphEdge { source: string; target: string; kind: string }
interface GraphResult {
  nodes: GraphNode[]
  edges: GraphEdge[]
  note?: string
  degraded?: boolean       // true when total docs > GRAPH_DEGRADED_THRESHOLD without focus
  totalDocs?: number       // present in non-focus mode for renderer to size warnings
  nextCursor?: { afterId: number } | null  // present when more pages exist
}

function getDocumentGraph(args: GetDocumentGraphArgs): GraphResult {
  const depth = typeof args.depth === 'number' ? Math.max(1, Math.min(6, args.depth)) : 2
  const centerPath = typeof args.centerPath === 'string' ? args.centerPath : null
  const workspaceRoot = typeof args.workspaceRoot === 'string' ? args.workspaceRoot : null
  const limit = Math.min(
    GRAPH_MAX_LIMIT,
    Math.max(1, typeof args.limit === 'number' ? args.limit : GRAPH_DEFAULT_LIMIT),
  )
  const afterId = typeof args.cursor?.afterId === 'number' ? args.cursor.afterId : null
  const mode: 'full' | 'focus' = args.mode === 'focus' ? 'focus' : 'full'

  // Refuse focus mode without a centerPath — caller signaled focus but gave no center.
  if (mode === 'focus' && !centerPath) {
    return { nodes: [], edges: [], note: 'centerPath_required_in_focus', degraded: true, totalDocs: 0 }
  }

  // Pre-compute total when no centerPath so we can set degraded flag.
  // This is a single COUNT(*) — index-backed; cheap even on 681K rows.
  let totalDocs: number | undefined
  if (!centerPath) {
    const countRow = workspaceRoot
      ? db
          .prepare(`SELECT COUNT(*) AS n FROM documents WHERE workspace_id = (SELECT id FROM workspaces WHERE root = ?)`)
          .get<{ n: number }>(workspaceRoot)
      : db.prepare(`SELECT COUNT(*) AS n FROM documents`).get<{ n: number }>()
    totalDocs = countRow?.n ?? 0
  }

  const baseSelect = `SELECT id, path, name, source_type AS sourceType FROM documents`
  // Build the documents fetch:
  //  - centerPath: fetch ALL docs for BFS (kept legacy behavior; expected caller
  //    has a small workspace OR is already focused). The BFS itself bounds the
  //    output set tightly, so memory is OK once we know we have a center.
  //  - no centerPath: cap with LIMIT + cursor pagination.
  const documents: Array<{ id: number; path: string; name: string; sourceType: string }> = (() => {
    if (centerPath) {
      return workspaceRoot
        ? db
            .prepare(`${baseSelect} WHERE workspace_id = (SELECT id FROM workspaces WHERE root = ?)`)
            .all<{ id: number; path: string; name: string; sourceType: string }>(workspaceRoot)
        : db.prepare(baseSelect).all<{ id: number; path: string; name: string; sourceType: string }>()
    }
    // No centerPath: paginate
    const cursorClause = afterId !== null ? `AND id > ?` : ''
    const cursorParams = afterId !== null ? [afterId] : []
    if (workspaceRoot) {
      return db
        .prepare(
          `${baseSelect} WHERE workspace_id = (SELECT id FROM workspaces WHERE root = ?) ${cursorClause} ORDER BY id LIMIT ?`,
        )
        .all<{ id: number; path: string; name: string; sourceType: string }>(workspaceRoot, ...cursorParams, limit)
    }
    return db
      .prepare(`${baseSelect} ${afterId !== null ? 'WHERE id > ?' : ''} ORDER BY id LIMIT ?`)
      .all<{ id: number; path: string; name: string; sourceType: string }>(...cursorParams, limit)
  })()

  let includedIds: Set<number> | null = null
  if (centerPath) {
    const center = documents.find((d) => d.path === centerPath)
    if (!center) return { nodes: [], edges: [], note: 'centerPath not in index' }
    includedIds = new Set([center.id])
    let frontier = new Set([center.id])
    for (let level = 0; level < depth; level += 1) {
      if (frontier.size === 0) break
      const placeholders = Array.from(frontier).map(() => '?').join(',')
      const neighbors = db
        .prepare(
          `SELECT src_doc_id AS a, target_doc_id AS b FROM doc_links
           WHERE target_doc_id IS NOT NULL AND (src_doc_id IN (${placeholders}) OR target_doc_id IN (${placeholders}))`,
        )
        .all<{ a: number; b: number }>(...Array.from(frontier), ...Array.from(frontier))
      const next = new Set<number>()
      for (const edge of neighbors) {
        if (edge.a && !includedIds.has(edge.a)) { includedIds.add(edge.a); next.add(edge.a) }
        if (edge.b && !includedIds.has(edge.b)) { includedIds.add(edge.b); next.add(edge.b) }
      }
      frontier = next
    }
  }

  const allowedDocs = includedIds ? documents.filter((d) => includedIds!.has(d.id)) : documents
  const allowedIdSet = new Set(allowedDocs.map((d) => d.id))

  const nodes: GraphNode[] = []
  for (const doc of allowedDocs) {
    nodes.push({ id: `doc:${doc.id}`, type: 'doc', label: doc.name, sourceType: doc.sourceType })
  }

  const idList = Array.from(allowedIdSet)
  if (idList.length === 0) return { nodes, edges: [] }

  const placeholders = idList.map(() => '?').join(',')
  const linkRows = db
    .prepare(
      `SELECT src_doc_id AS src, target_doc_id AS tgt, kind, target_text AS label FROM doc_links WHERE src_doc_id IN (${placeholders})`,
    )
    .all<{ src: number; tgt: number | null; kind: string; label: string }>(...idList)
  const tagRows = db
    .prepare(`SELECT doc_id AS src, tag FROM tags WHERE doc_id IN (${placeholders})`)
    .all<{ src: number; tag: string }>(...idList)

  const edges: GraphEdge[] = []
  const ghostLabels = new Map<string, string>()
  const tagLabels = new Map<string, string>()

  for (const link of linkRows) {
    if (link.tgt && allowedIdSet.has(link.tgt)) {
      edges.push({ source: `doc:${link.src}`, target: `doc:${link.tgt}`, kind: link.kind })
    } else if (!link.tgt && link.kind === 'wikilink') {
      const ghostId = `ghost:${link.label}`
      if (!ghostLabels.has(ghostId)) ghostLabels.set(ghostId, link.label)
      edges.push({ source: `doc:${link.src}`, target: ghostId, kind: 'wikilink' })
    }
  }
  for (const row of tagRows) {
    const tagId = `tag:${row.tag.toLowerCase()}`
    tagLabels.set(tagId, row.tag)
    edges.push({ source: `doc:${row.src}`, target: tagId, kind: 'tag-of' })
  }
  for (const [id, label] of tagLabels.entries()) nodes.push({ id, type: 'tag', label })
  for (const [id, label] of ghostLabels.entries()) nodes.push({ id, type: 'ghost', label })

  // B3: signal degraded + paginate hint when no centerPath and total exceeds threshold.
  const result: GraphResult = { nodes, edges }
  if (!centerPath) {
    result.totalDocs = totalDocs
    if ((totalDocs ?? 0) > GRAPH_DEGRADED_THRESHOLD) {
      result.degraded = true
      // Suggest using centerPath instead of pagination for huge graphs:
      result.note = `Graph has ${totalDocs} documents (>${GRAPH_DEGRADED_THRESHOLD}); use centerPath to focus, or paginate via cursor.`
    }
    // Cursor for next page: last fetched id (callers can pass this back as cursor.afterId)
    if (documents.length > 0 && documents.length === limit) {
      result.nextCursor = { afterId: documents[documents.length - 1].id }
    } else {
      result.nextCursor = null
    }
  }
  return result
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
          result = getDocumentGraph((msg.args ?? {}) as GetDocumentGraphArgs)
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
