import { appendFileSync } from 'fs'
import type { DatabaseConnection } from '../database'
import { getLogPath } from '../../utils/platform'
import { normalizeSearchText } from '../../../shared/document-graph-parse'
import { SearchRepository } from './repository'
import { parseSearchQuery, type SearchHit } from './query'
import {
  AgentMessageAdapter,
  BookmarkAdapter,
  CalendarAdapter,
  FileSystemAdapter,
  RssAdapter,
  SHARED_WORKSPACE_ROOT,
  type AdapterReindexResult,
  type IndexSourceAdapter,
} from './adapters'

const SEARCH_LOG = getLogPath('ready-search.log')

function logSearch(message: string): void {
  try {
    appendFileSync(SEARCH_LOG, `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    /* best-effort */
  }
}

export interface ReindexWorkspaceResult {
  ok: boolean
  root: string
  workspaceId: number
  indexed: number
  skipped: number
  removed: number
  scanned: number
  elapsedMs: number
  degraded: boolean
  error?: string
}

export interface ReindexAllSourcesResult {
  ok: boolean
  perSource: Record<string, AdapterReindexResult & { error?: string }>
  elapsedMs: number
}

export interface SearchEngineOptions {
  fts5Available: boolean
}

export class SearchEngine {
  private readonly repository: SearchRepository
  private readonly fsAdapter: FileSystemAdapter
  private readonly sharedAdapters: IndexSourceAdapter[]
  private readonly adaptersByType: Map<string, IndexSourceAdapter>

  constructor(private readonly db: DatabaseConnection, private readonly options: SearchEngineOptions) {
    this.repository = new SearchRepository(db, options.fts5Available)
    this.fsAdapter = new FileSystemAdapter()
    this.sharedAdapters = [
      new BookmarkAdapter(),
      new RssAdapter(),
      new CalendarAdapter(),
      new AgentMessageAdapter(),
    ]
    this.adaptersByType = new Map()
    for (const adapter of [this.fsAdapter, ...this.sharedAdapters]) {
      this.adaptersByType.set(adapter.sourceType, adapter)
    }
  }

  get fts5Available(): boolean {
    return this.options.fts5Available
  }

  listSourceTypes(): string[] {
    return Array.from(this.adaptersByType.keys())
  }

  async reindexWorkspace(root: string): Promise<ReindexWorkspaceResult> {
    const started = Date.now()
    const result: ReindexWorkspaceResult = {
      ok: false,
      root,
      workspaceId: -1,
      indexed: 0,
      skipped: 0,
      removed: 0,
      scanned: 0,
      elapsedMs: 0,
      degraded: !this.options.fts5Available,
    }

    try {
      const workspaceId = this.repository.ensureWorkspace(root)
      result.workspaceId = workspaceId
      const adapterResult = await this.fsAdapter.reindex({
        workspaceId,
        workspaceRoot: root,
        repository: this.repository,
      })
      result.indexed = adapterResult.indexed
      result.skipped = adapterResult.skipped
      result.removed = adapterResult.removed
      result.scanned = adapterResult.scanned
      this.repository.touchWorkspace(workspaceId, Math.floor(Date.now() / 1000))
      result.ok = true
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error)
    }
    result.elapsedMs = Date.now() - started
    logSearch(
      `reindexWorkspace root=${root} ok=${result.ok} scanned=${result.scanned} indexed=${result.indexed} skipped=${result.skipped} removed=${result.removed} elapsedMs=${result.elapsedMs}${result.error ? ` error=${result.error}` : ''}`,
    )
    return result
  }

  async reindexAllSources(root: string): Promise<ReindexAllSourcesResult> {
    const started = Date.now()
    const perSource: Record<string, AdapterReindexResult & { error?: string }> = {}

    // Filesystem (per-root) runs first
    const fsResult = await this.reindexWorkspace(root)
    perSource[this.fsAdapter.sourceType] = {
      indexed: fsResult.indexed,
      skipped: fsResult.skipped,
      removed: fsResult.removed,
      scanned: fsResult.scanned,
      ...(fsResult.error ? { error: fsResult.error } : {}),
    }

    // Shared adapters run under the @shared workspace
    const sharedWorkspaceId = this.repository.ensureWorkspace(SHARED_WORKSPACE_ROOT)
    for (const adapter of this.sharedAdapters) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await adapter.reindex({
          workspaceId: sharedWorkspaceId,
          workspaceRoot: SHARED_WORKSPACE_ROOT,
          repository: this.repository,
        })
        perSource[adapter.sourceType] = r
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        perSource[adapter.sourceType] = { indexed: 0, skipped: 0, removed: 0, scanned: 0, error: message }
        logSearch(`adapter ${adapter.sourceType} failed error=${message}`)
      }
    }
    this.repository.touchWorkspace(sharedWorkspaceId, Math.floor(Date.now() / 1000))
    return { ok: true, perSource, elapsedMs: Date.now() - started }
  }

  async indexDocument(
    root: string,
    path: string,
    content?: string,
  ): Promise<{ ok: boolean; documentId?: number; skipped?: boolean; error?: string }> {
    try {
      const workspaceId = this.repository.ensureWorkspace(root)
      const parsed = await this.fsAdapter.loadOne(path, content)
      if (!parsed) return { ok: false, error: 'file skipped (binary or oversized)' }
      let documentId = -1
      let skipped = false
      this.repository.transaction(() => {
        const upsert = this.repository.upsertDocument({
          workspaceId,
          path: parsed.path,
          name: parsed.name,
          ext: parsed.ext,
          size: parsed.size,
          mtime: parsed.mtime,
          contentHash: parsed.contentHash,
          frontmatterJson: parsed.frontmatterJson,
          body: parsed.body,
          sourceType: 'document',
        })
        documentId = upsert.documentId
        skipped = upsert.skipped
        this.repository.replaceTags(documentId, parsed.tags)
        this.repository.replaceLinks(documentId, parsed.wikilinks, parsed.mdlinks)
        this.repository.replaceAttachments(documentId, parsed.attachments)
        this.repository.resolveWikilinkTargets(workspaceId)
      })
      return { ok: true, documentId, skipped }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logSearch(`indexDocument failed path=${path} error=${message}`)
      return { ok: false, error: message }
    }
  }

  countDocuments(workspaceId: number): number {
    return this.repository.countDocuments(workspaceId)
  }

  findWorkspaceRootForPath(filePath: string): string | null {
    const roots = this.repository.listWorkspaceRoots()
    for (const { root } of roots) {
      if (!root || root === SHARED_WORKSPACE_ROOT) continue
      const prefix = root.endsWith('/') ? root : `${root}/`
      if (filePath === root || filePath.startsWith(prefix)) return root
    }
    return null
  }

  getRepository(): SearchRepository {
    return this.repository
  }

  async search(
    query: string,
    opts: { limit?: number; workspaceRoot?: string; sources?: string[] } = {},
  ): Promise<{
    items: Array<SearchHit & { sourceType: string; sourceMeta?: Record<string, unknown> | null }>
    stats: { returned: number; elapsedMs: number }
    degraded: boolean
  }> {
    const started = Date.now()
    const limit = Math.max(1, Math.min(200, opts.limit ?? 100))
    const parsed = parseSearchQuery(query)
    const results: Array<SearchHit & { sourceType: string; sourceMeta?: Record<string, unknown> | null }> = []

    const roots = this.repository.listWorkspaceRoots()
    const chosenRoots = opts.workspaceRoot
      ? roots.filter((r) => r.root === opts.workspaceRoot || r.root === SHARED_WORKSPACE_ROOT)
      : roots
    if (chosenRoots.length === 0) {
      return {
        items: [],
        stats: { returned: 0, elapsedMs: Date.now() - started },
        degraded: !this.options.fts5Available,
      }
    }

    // Prefer explicit opts.sources, fall back to in-query `src:xxx` tokens.
    const combined = new Set<string>()
    for (const src of opts.sources ?? []) combined.add(src)
    for (const src of parsed.sources) combined.add(src)
    const sources = combined.size > 0
      ? Array.from(combined).filter((s) => this.adaptersByType.has(s))
      : null

    const normalizedQuery = normalizeSearchText(query).toLowerCase()
    for (const { id: workspaceId } of chosenRoots) {
      const hits = this.runWorkspaceSearch(workspaceId, parsed, limit - results.length, normalizedQuery, sources)
      for (const hit of hits) {
        results.push(hit)
        if (results.length >= limit) break
      }
      if (results.length >= limit) break
    }

    return {
      items: results,
      stats: { returned: results.length, elapsedMs: Date.now() - started },
      degraded: !this.options.fts5Available,
    }
  }

  private runWorkspaceSearch(
    workspaceId: number,
    parsed: ReturnType<typeof parseSearchQuery>,
    limit: number,
    normalizedQuery: string,
    sources: string[] | null,
  ): Array<SearchHit & { sourceType: string; sourceMeta?: Record<string, unknown> | null }> {
    if (limit <= 0) return []
    const fts5 = this.options.fts5Available
    const usingFts = fts5 && parsed.ftsMatch !== null

    const bindings: Array<string | number> = []
    const selectFields = usingFts
      ? `d.id AS id, d.path AS path, d.name AS name,
         d.source_type AS sourceType, d.source_meta_json AS sourceMetaJson,
         bm25(documents_fts, 2.0, 1.0) AS rank,
         snippet(documents_fts, 1, char(1), char(2), '…', 12) AS snip`
      : `d.id AS id, d.path AS path, d.name AS name,
         d.source_type AS sourceType, d.source_meta_json AS sourceMetaJson,
         0 AS rank, '' AS snip`
    let sql = `SELECT ${selectFields} FROM documents d`
    if (usingFts) sql += ' JOIN documents_fts f ON f.rowid = d.id'
    sql += ' WHERE d.workspace_id = ?'
    bindings.push(workspaceId)
    if (usingFts) {
      sql += ' AND documents_fts MATCH ?'
      bindings.push(parsed.ftsMatch as string)
    }
    if (sources) {
      sql += ` AND d.source_type IN (${sources.map(() => '?').join(',')})`
      bindings.push(...sources)
    }
    if (parsed.tags.length > 0) {
      const placeholders = parsed.tags.map(() => '?').join(',')
      sql += ` AND d.id IN (SELECT doc_id FROM tags WHERE tag IN (${placeholders}) GROUP BY doc_id HAVING COUNT(DISTINCT tag) = ?)`
      bindings.push(...parsed.tags, parsed.tags.length)
    }
    if (parsed.wikilinks.length > 0) {
      const placeholders = parsed.wikilinks.map(() => '?').join(',')
      sql += ` AND d.id IN (SELECT src_doc_id FROM doc_links WHERE kind = 'wikilink' AND target_text IN (${placeholders}))`
      bindings.push(...parsed.wikilinks)
    }
    sql += usingFts ? ' ORDER BY rank ASC' : ' ORDER BY d.indexed_at DESC'
    sql += ' LIMIT ?'
    bindings.push(limit)

    let rows: Array<{
      id: number
      path: string
      name: string
      sourceType: string
      sourceMetaJson: string | null
      rank: number
      snip: string
    }> = []
    try {
      rows = this.db
        .prepare(sql)
        .all<{
          id: number
          path: string
          name: string
          sourceType: string
          sourceMetaJson: string | null
          rank: number
          snip: string
        }>(...bindings)
    } catch (error) {
      logSearch(`search query failed sql=${sql} error=${error instanceof Error ? error.message : String(error)}`)
      return []
    }

    if (rows.length === 0) return []

    const ids = rows.map((r) => r.id)
    const placeholder = ids.map(() => '?').join(',')
    const tagHits = this.db
      .prepare(`SELECT doc_id AS id, tag FROM tags WHERE doc_id IN (${placeholder})`)
      .all<{ id: number; tag: string }>(...ids)
    const linkHits = this.db
      .prepare(
        `SELECT src_doc_id AS id, target_text AS target FROM doc_links WHERE kind = 'wikilink' AND src_doc_id IN (${placeholder})`,
      )
      .all<{ id: number; target: string }>(...ids)

    const tagsByDoc = new Map<number, string[]>()
    for (const row of tagHits) {
      const arr = tagsByDoc.get(row.id) ?? []
      arr.push(row.tag)
      tagsByDoc.set(row.id, arr)
    }
    const linksByDoc = new Map<number, string[]>()
    for (const row of linkHits) {
      const arr = linksByDoc.get(row.id) ?? []
      arr.push(row.target)
      linksByDoc.set(row.id, arr)
    }

    const tagFilter = new Set(parsed.tags.map((t) => t.toLowerCase()))
    const linkFilter = new Set(parsed.wikilinks.map((t) => t.toLowerCase()))

    return rows.map((row) => {
      const docTags = tagsByDoc.get(row.id) ?? []
      const docLinks = linksByDoc.get(row.id) ?? []
      const tagsHit = tagFilter.size > 0 ? docTags.filter((tag) => tagFilter.has(tag.toLowerCase())) : []
      const linksHit = linkFilter.size > 0 ? docLinks.filter((target) => linkFilter.has(target.toLowerCase())) : []
      const nameMatch = normalizedQuery.length > 0
        ? normalizeSearchText(row.name).toLowerCase().includes(normalizedQuery)
        : false
      let sourceMeta: Record<string, unknown> | null = null
      if (row.sourceMetaJson) {
        try { sourceMeta = JSON.parse(row.sourceMetaJson) } catch { sourceMeta = null }
      }
      return {
        path: row.path,
        name: row.name,
        snippet: row.snip || '',
        rank: row.rank,
        nameMatch,
        tagsHit,
        linksHit,
        sourceType: row.sourceType || 'document',
        sourceMeta,
      }
    })
  }
}

export function probeFts5Availability(db: DatabaseConnection): boolean {
  try {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='documents_fts'")
      .get<{ name: string }>()
    if (!row) {
      logSearch('fts5 unavailable: documents_fts table missing (migration 026 fallback)')
      return false
    }
    return true
  } catch (error) {
    logSearch(`fts5 unavailable error=${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}
