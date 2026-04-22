import { ipcMain } from 'electron'
import { getDatabase } from '../database'
import { setDocumentWriteIndexHook } from '../document-engine/ipc-handler'
import {
  SearchEngine,
  probeFts5Availability,
  type ReindexAllSourcesResult,
  type ReindexWorkspaceResult,
} from './indexer'
import type { SearchHit } from './query'

interface SearchIPCResponse<T> {
  success: boolean
  data?: T
  error?: string
}

let searchEngine: SearchEngine | null = null

export function getSearchEngine(): SearchEngine | null {
  return searchEngine
}

export function setupSearchIPC(): void {
  const rawDb = getDatabase().getRawDb()
  if (!rawDb) {
    console.warn('[search-engine] database unavailable; global search disabled')
    searchEngine = null
  } else {
    const fts5Available = probeFts5Availability(rawDb)
    searchEngine = new SearchEngine(rawDb, { fts5Available })
    if (!fts5Available) {
      console.warn('[search-engine] FTS5 not available — running in degraded mode')
    }
  }

  setDocumentWriteIndexHook((path, content) => {
    if (!searchEngine) return
    const root = searchEngine.findWorkspaceRootForPath(path)
    if (!root) return
    void searchEngine.indexDocument(root, path, content).catch((error) => {
      console.warn('[search-engine] indexDocument hook failed', error)
    })
  })

  ipcMain.handle(
    'document:reindexWorkspace',
    async (_event, root: string): Promise<SearchIPCResponse<ReindexWorkspaceResult>> => {
      if (!searchEngine) {
        return { success: false, error: 'search engine unavailable' }
      }
      if (typeof root !== 'string' || root.length === 0) {
        return { success: false, error: 'root path required' }
      }
      try {
        const result = await searchEngine.reindexWorkspace(root)
        return { success: true, data: result }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  ipcMain.handle(
    'document:searchIndex',
    async (
      _event,
      payload: { query: string; limit?: number; workspaceRoot?: string; sources?: string[] },
    ): Promise<SearchIPCResponse<{
      items: Array<SearchHit & { sourceType: string; sourceMeta?: Record<string, unknown> | null }>
      stats: { returned: number; elapsedMs: number }
      degraded: boolean
    }>> => {
      if (!searchEngine) {
        return { success: false, error: 'search engine unavailable' }
      }
      if (!payload || typeof payload.query !== 'string') {
        return { success: false, error: 'query required' }
      }
      try {
        const result = await searchEngine.search(payload.query, {
          limit: payload.limit,
          workspaceRoot: payload.workspaceRoot,
          sources: payload.sources,
        })
        return { success: true, data: result }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  ipcMain.handle(
    'document:reindexAllSources',
    async (_event, root: string): Promise<SearchIPCResponse<ReindexAllSourcesResult>> => {
      if (!searchEngine) return { success: false, error: 'search engine unavailable' }
      if (typeof root !== 'string' || root.length === 0) {
        return { success: false, error: 'root path required' }
      }
      try {
        const result = await searchEngine.reindexAllSources(root)
        return { success: true, data: result }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  ipcMain.handle(
    'document:listSources',
    async (): Promise<SearchIPCResponse<{ sources: string[] }>> => {
      if (!searchEngine) return { success: false, error: 'search engine unavailable' }
      return { success: true, data: { sources: searchEngine.listSourceTypes() } }
    },
  )

  ipcMain.handle(
    'document:indexDocument',
    async (
      _event,
      payload: { path: string; root?: string; content?: string },
    ): Promise<SearchIPCResponse<{ ok: boolean; documentId?: number; skipped?: boolean; error?: string }>> => {
      if (!searchEngine) {
        return { success: false, error: 'search engine unavailable' }
      }
      if (!payload || typeof payload.path !== 'string' || payload.path.length === 0) {
        return { success: false, error: 'path required' }
      }
      const root = payload.root && payload.root.length > 0
        ? payload.root
        : searchEngine.findWorkspaceRootForPath(payload.path)
      if (!root) {
        return { success: false, error: 'workspace root not found for path' }
      }
      try {
        const result = await searchEngine.indexDocument(root, payload.path, payload.content)
        return { success: true, data: result }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  ipcMain.handle(
    'document:getBacklinks',
    async (
      _event,
      payload: { path: string; limit?: number },
    ): Promise<SearchIPCResponse<{ references: Array<{ path: string; name: string; kind: string }> }>> => {
      if (!searchEngine) return { success: false, error: 'search engine unavailable' }
      if (!payload || typeof payload.path !== 'string') return { success: false, error: 'path required' }
      const limit = typeof payload.limit === 'number' ? Math.max(1, Math.min(200, payload.limit)) : 50
      try {
        const db = searchEngine.getRepository().getConnection()
        const target = db
          .prepare('SELECT id FROM documents WHERE path = ? LIMIT 1')
          .get<{ id: number }>(payload.path)
        if (!target) return { success: true, data: { references: [] } }
        const rows = db
          .prepare(
            `SELECT src.path AS path, src.name AS name, dl.kind AS kind
             FROM doc_links dl
             JOIN documents src ON src.id = dl.src_doc_id
             WHERE dl.target_doc_id = ? AND src.source_type = 'document'
             LIMIT ?`,
          )
          .all<{ path: string; name: string; kind: string }>(target.id, limit)
        return { success: true, data: { references: rows } }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  ipcMain.handle(
    'document:getGraph',
    async (
      _event,
      payload: { centerPath?: string; depth?: number; workspaceRoot?: string } | undefined,
    ): Promise<SearchIPCResponse<{
      nodes: Array<{ id: string; type: 'doc' | 'tag' | 'ghost'; label: string; sourceType?: string }>
      edges: Array<{ source: string; target: string; kind: string }>
    }>> => {
      if (!searchEngine) return { success: false, error: 'search engine unavailable' }
      const depth = typeof payload?.depth === 'number' ? Math.max(1, Math.min(6, payload.depth)) : 2
      const centerPath = typeof payload?.centerPath === 'string' ? payload.centerPath : null
      const workspaceRoot = typeof payload?.workspaceRoot === 'string' ? payload.workspaceRoot : null
      try {
        const db = searchEngine.getRepository().getConnection()
        const baseQuery = `SELECT id, path, name, source_type AS sourceType FROM documents`
        const documents = workspaceRoot
          ? db
              .prepare(`${baseQuery} WHERE workspace_id = (SELECT id FROM workspaces WHERE root = ?)`)
              .all<{ id: number; path: string; name: string; sourceType: string }>(workspaceRoot)
          : db
              .prepare(baseQuery)
              .all<{ id: number; path: string; name: string; sourceType: string }>()

        let includedIds: Set<number> | null = null
        if (centerPath) {
          const center = documents.find((d) => d.path === centerPath)
          if (!center) return { success: true, data: { nodes: [], edges: [] } }
          includedIds = new Set([center.id])
          let frontier = new Set([center.id])
          for (let level = 0; level < depth; level += 1) {
            if (frontier.size === 0) break
            const ph = Array.from(frontier).map(() => '?').join(',')
            const neighbors = db
              .prepare(
                `SELECT src_doc_id AS a, target_doc_id AS b FROM doc_links WHERE target_doc_id IS NOT NULL AND (src_doc_id IN (${ph}) OR target_doc_id IN (${ph}))`,
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
        const idList = allowedDocs.map((d) => d.id)
        const allowedIdSet = new Set(idList)
        const nodes: Array<{ id: string; type: 'doc' | 'tag' | 'ghost'; label: string; sourceType?: string }> = []
        for (const doc of allowedDocs) {
          nodes.push({ id: `doc:${doc.id}`, type: 'doc', label: doc.name, sourceType: doc.sourceType })
        }
        if (idList.length === 0) return { success: true, data: { nodes, edges: [] } }

        const ph = idList.map(() => '?').join(',')
        const linkRows = db
          .prepare(
            `SELECT src_doc_id AS src, target_doc_id AS tgt, kind, target_text AS label FROM doc_links WHERE src_doc_id IN (${ph})`,
          )
          .all<{ src: number; tgt: number | null; kind: string; label: string }>(...idList)
        const tagRows = db
          .prepare(`SELECT doc_id AS src, tag FROM tags WHERE doc_id IN (${ph})`)
          .all<{ src: number; tag: string }>(...idList)

        const edges: Array<{ source: string; target: string; kind: string }> = []
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
        for (const [id, label] of tagLabels.entries()) {
          nodes.push({ id, type: 'tag', label })
        }
        for (const [id, label] of ghostLabels.entries()) {
          nodes.push({ id, type: 'ghost', label })
        }
        return { success: true, data: { nodes, edges } }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )
}
