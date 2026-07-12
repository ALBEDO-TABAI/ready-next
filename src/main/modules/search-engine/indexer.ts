import type { DatabaseConnection } from '../database'
import { createRotatingLogger } from '../../utils/rotating-logger'
import { normalizeSearchText } from '../../../shared/document-graph-parse'
import { validateWorkspaceRoot } from '../../../shared/workspace-validation'
import { SearchRepository } from './repository'
import { parseSearchQuery, type SearchHit } from './query'
import { reconcileIndexedFrontmatter,reconcileIndexedWorkspace } from '../tag-forge/reconcile'
import {
  AbortError,
  AgentMessageAdapter,
  BookmarkAdapter,
  CalendarAdapter,
  FileSystemAdapter,
  RssAdapter,
  SHARED_WORKSPACE_ROOT,
  type AdapterReindexResult,
  type IndexSourceAdapter,
} from './adapters'

const searchLogger = createRotatingLogger('ready-search.log')

function logSearch(message: string): void {
  try {
    searchLogger.append(`[${new Date().toISOString()}] ${message}\n`)
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
  // perf-rescue B8: override the debounced workspace-wide wikilink resolve
  // window. Default: 5000ms. Tests pass a small value (or 0) to assert the
  // backup pass actually runs without sleeping for 5 seconds.
  workspaceResolveDebounceMs?: number
}

export class SearchEngine {
  private readonly repository: SearchRepository
  private readonly fsAdapter: FileSystemAdapter
  private readonly sharedAdapters: IndexSourceAdapter[]
  private readonly adaptersByType: Map<string, IndexSourceAdapter>
  // perf-rescue B8: debounced workspace-wide wikilink resolve. Each per-doc
  // index call only resolves THAT doc's outgoing + incoming links; an edge
  // case the per-doc path can miss (deletions, renames, ambiguous names)
  // is reconciled by a delayed full-workspace pass that aggregates rapid
  // bursts of saves into one DB scan.
  //
  // Map keyed by workspaceId so multiple workspaces don't share a debounce.
  // Each entry tracks its setTimeout handle + the AbortController used to
  // cancel it (e.g. on workspace close / app quit).
  private readonly workspaceResolveTimers: Map<number, {
    timer: NodeJS.Timeout
    controller: AbortController
  }> = new Map()
  private static readonly DEFAULT_WORKSPACE_RESOLVE_DEBOUNCE_MS = 5_000

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

  async reindexWorkspace(opts: { root: string; signal?: AbortSignal }): Promise<ReindexWorkspaceResult> {
    const { root, signal } = opts
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
        signal,
      })
      result.indexed = adapterResult.indexed
      result.skipped = adapterResult.skipped
      result.removed = adapterResult.removed
      result.scanned = adapterResult.scanned
      this.repository.touchWorkspace(workspaceId, Math.floor(Date.now() / 1000))
      result.ok = true
      reconcileIndexedWorkspace(this.repository.getConnection(),root,workspaceId)
    } catch (error) {
      // perf-rescue B6: AbortError is a first-class signal for callers; we
      // still log it but surface a structured `aborted: true` flag so the
      // worker can distinguish cancellation from a real failure.
      const message = error instanceof Error ? error.message : String(error)
      result.error = message
      if (error instanceof AbortError) {
        ;(result as ReindexWorkspaceResult & { aborted?: boolean }).aborted = true
      }
    }
    result.elapsedMs = Date.now() - started
    logSearch(
      `reindexWorkspace root=${root} ok=${result.ok} scanned=${result.scanned} indexed=${result.indexed} skipped=${result.skipped} removed=${result.removed} elapsedMs=${result.elapsedMs}${result.error ? ` error=${result.error}` : ''}`,
    )
    return result
  }

  async reindexAllSources(opts: { root: string; signal?: AbortSignal }): Promise<ReindexAllSourcesResult> {
    const { root, signal } = opts
    const started = Date.now()
    const perSource: Record<string, AdapterReindexResult & { error?: string }> = {}

    // Filesystem (per-root) runs first
    const fsResult = await this.reindexWorkspace({ root, signal })
    perSource[this.fsAdapter.sourceType] = {
      indexed: fsResult.indexed,
      skipped: fsResult.skipped,
      removed: fsResult.removed,
      scanned: fsResult.scanned,
      ...(fsResult.error ? { error: fsResult.error } : {}),
    }
    const fsAborted = (fsResult as ReindexWorkspaceResult & { aborted?: boolean }).aborted === true

    // If the FS pass was aborted, skip shared adapters too — caller wants
    // the whole reindex stopped, not partially advanced into bookmark/RSS.
    if (fsAborted || signal?.aborted) {
      return { ok: false, perSource, elapsedMs: Date.now() - started }
    }

    // Shared adapters run under the @shared workspace
    const sharedWorkspaceId = this.repository.ensureWorkspace(SHARED_WORKSPACE_ROOT)
    for (const adapter of this.sharedAdapters) {
      if (signal?.aborted) {
        perSource[adapter.sourceType] = { indexed: 0, skipped: 0, removed: 0, scanned: 0, error: 'aborted' }
        continue
      }
      try {

        const r = await adapter.reindex({
          workspaceId: sharedWorkspaceId,
          workspaceRoot: SHARED_WORKSPACE_ROOT,
          repository: this.repository,
          signal,
        })
        perSource[adapter.sourceType] = r
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        perSource[adapter.sourceType] = { indexed: 0, skipped: 0, removed: 0, scanned: 0, error: message }
        logSearch(`adapter ${adapter.sourceType} failed error=${message}`)
      }
    }
    this.repository.touchWorkspace(sharedWorkspaceId, Math.floor(Date.now() / 1000))
    // `ok` reflects the primary deliverable: the FS index for `root`. When
    // the FS pass failed (e.g. ENOENT after the workspace dir was deleted)
    // we still let shared adapters run so bookmark / RSS / calendar caches
    // get refreshed, but the overall call must NOT report success — the
    // renderer-side reducer relies on this to avoid persisting a "successful"
    // IndexStatus on top of a root whose FS index never actually built.
    return { ok: fsResult.ok, perSource, elapsedMs: Date.now() - started }
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
        // perf-rescue B8: per-document wikilink resolve.
        //
        // Was: resolveWikilinkTargets(workspaceId) — full workspace re-scan
        //      on every save. On a 100k-doc workspace this is a multi-second
        //      hot loop that runs for every keystroke-triggered save.
        //
        // Now: resolve only THIS doc's outgoing + incoming links. The
        //      backup workspace-wide pass below catches edge cases (deletes,
        //      renames, name-collision reshuffles) by aggregating bursts of
        //      saves into one scan after a 5s quiet window.
        this.repository.resolveWikilinkTargetsForDocument(documentId)
      })
      // Schedule the backup resolve outside the transaction — we don't want
      // this to keep the per-file transaction open. Skipped writes (no
      // content change) still trigger it because rename/incoming-resolve
      // edge cases don't depend on whether the body changed.
      this.scheduleWorkspaceLinkResolve(workspaceId)
      reconcileIndexedFrontmatter(this.repository.getConnection(),root,parsed.path,parsed.tags)
      return { ok: true, documentId, skipped }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logSearch(`indexDocument failed path=${path} error=${message}`)
      return { ok: false, error: message }
    }
  }

  /**
   * perf-rescue B8: schedule a debounced workspace-wide wikilink resolve.
   *
   * Coalesces rapid-fire single-file saves (e.g. autosave + watcher) into a
   * single full resolve after a 5s quiet window. Each call resets the timer.
   *
   * The returned AbortSignal can be used by the caller to cancel a pending
   * resolve (e.g. workspace close, app quit). When aborted, the scheduled
   * pass will not run; in-flight passes are not interrupted (the SQL itself
   * is fast enough that a single UPDATE is atomic from the caller's view).
   *
   * Idempotent: callable from any thread/context. Returning the controller's
   * signal is mostly for tests and lifecycle hooks; routine callers can
   * ignore the return value.
   */
  scheduleWorkspaceLinkResolve(workspaceId: number): AbortSignal {
    const existing = this.workspaceResolveTimers.get(workspaceId)
    if (existing) {
      clearTimeout(existing.timer)
      // Re-use the controller — if a caller is holding the signal from a
      // prior call, "rescheduling" semantically continues the same logical
      // intent. Aborting the prior signal here would surprise observers
      // that just wanted "fire eventually".
    }
    const controller = existing?.controller ?? new AbortController()
    const debounceMs = this.options.workspaceResolveDebounceMs
      ?? SearchEngine.DEFAULT_WORKSPACE_RESOLVE_DEBOUNCE_MS
    const timer = setTimeout(() => {
      this.workspaceResolveTimers.delete(workspaceId)
      if (controller.signal.aborted) return
      try {
        this.repository.transaction(() => {
          this.repository.resolveWikilinkTargets(workspaceId)
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logSearch(`scheduledWorkspaceLinkResolve failed workspaceId=${workspaceId} error=${message}`)
      }
    }, debounceMs)
    // Allow Node to exit even if a debounce timer is pending — we don't want
    // to block process shutdown over a backup resolve. Test harnesses can
    // still observe the timer via fake timers or by calling the method
    // directly with a 0-ms override (currently constant; expose if needed).
    if (typeof timer.unref === 'function') timer.unref()
    this.workspaceResolveTimers.set(workspaceId, { timer, controller })
    return controller.signal
  }

  /**
   * Cancel any pending debounced workspace resolves. Called on workspace
   * close / app quit to prevent a delayed pass from firing against a
   * detached DB.
   */
  cancelPendingWorkspaceResolves(): number {
    let cancelled = 0
    for (const [, entry] of this.workspaceResolveTimers) {
      clearTimeout(entry.timer)
      entry.controller.abort()
      cancelled += 1
    }
    this.workspaceResolveTimers.clear()
    return cancelled
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
    opts: { limit?: number; workspaceRoot?: string; workspaceRoots?: string[]; sources?: string[] } = {},
  ): Promise<{
    items: Array<SearchHit & { sourceType: string; sourceMeta?: Record<string, unknown> | null }>
    stats: { returned: number; elapsedMs: number }
    degraded: boolean
  }> {
    const started = Date.now()
    const limit = Math.max(1, Math.min(200, opts.limit ?? 100))
    const parsed = parseSearchQuery(query)

    const allRoots = this.repository.listWorkspaceRoots()
    // Defense-in-depth: filter out any DB rows pointing at unsafe trees BEFORE
    // any scope branching. Stale `workspaces` rows from before validation was
    // added (legacy `~` / `/Users/<x>` / `/Volumes/<x>` etc.) must NEVER leak
    // into results, regardless of how the caller scoped this search. The
    // IPC handler also rejects unsafe inputs at the boundary; this layer
    // covers the case where a caller bypasses the handler (worker bridge,
    // in-process tests, future direct callers) and the DB itself carries
    // pre-validation rows.
    const safeAllRoots = allRoots.filter((r) =>
      r.root === SHARED_WORKSPACE_ROOT || validateWorkspaceRoot(r.root).ok,
    )
    // Scope precedence:
    //   1. `workspaceRoots` (array, possibly empty) — caller explicitly named
    //      the scope. An empty list means "no scope" → no results. We MUST NOT
    //      fall through to unscoped here; otherwise an empty list silently
    //      broadens to "every workspace ever indexed", leaking old workspaces.
    //      Unsafe entries in the list are stripped — if every requested root
    //      is unsafe, the result set is empty (NO SHARED bleed-through).
    //   2. `workspaceRoot` (single string) — legacy single-root caller.
    //      An unsafe value yields empty results, mirroring (1).
    //   3. Neither — legacy unscoped fallback. Returns the full safe set.
    // SHARED_WORKSPACE_ROOT is appended to (1) and (2) so bookmark/RSS/calendar/
    // agent hits surface alongside file results.
    let chosenRoots: typeof allRoots
    if (opts.workspaceRoots !== undefined) {
      const safeRequested = opts.workspaceRoots.filter((r) => validateWorkspaceRoot(r).ok)
      chosenRoots = safeRequested.length === 0
        ? []
        : safeAllRoots.filter((r) => safeRequested.includes(r.root) || r.root === SHARED_WORKSPACE_ROOT)
    } else if (opts.workspaceRoot) {
      chosenRoots = validateWorkspaceRoot(opts.workspaceRoot).ok
        ? safeAllRoots.filter((r) => r.root === opts.workspaceRoot || r.root === SHARED_WORKSPACE_ROOT)
        : []
    } else {
      chosenRoots = safeAllRoots
    }
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
    // Single SQL pass across all chosen workspace_ids: cross-root ranking is
    // computed by BM25 in one ORDER BY, so the global top-K cannot be starved
    // by an early root saturating its slice.
    const workspaceIds = chosenRoots.map((r) => r.id)
    const results = this.runMultiWorkspaceSearch(workspaceIds, parsed, limit, normalizedQuery, sources)

    return {
      items: results,
      stats: { returned: results.length, elapsedMs: Date.now() - started },
      degraded: !this.options.fts5Available,
    }
  }

  private runMultiWorkspaceSearch(
    workspaceIds: readonly number[],
    parsed: ReturnType<typeof parseSearchQuery>,
    limit: number,
    normalizedQuery: string,
    sources: string[] | null,
  ): Array<SearchHit & { sourceType: string; sourceMeta?: Record<string, unknown> | null }> {
    if (limit <= 0 || workspaceIds.length === 0) return []
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
    const workspacePlaceholders = workspaceIds.map(() => '?').join(',')
    sql += ` WHERE d.workspace_id IN (${workspacePlaceholders})`
    bindings.push(...workspaceIds)
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
