import { readFile, rename, stat } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'path'
import type { SearchEngine } from '../search-engine/indexer'
import { getSearchEngine } from '../search-engine/ipc-handler'
import { parseDocumentGraph } from '../../../shared/document-graph-parse'

export {
  FILE_MANAGEMENT_TOOL_NAMES,
  getFileManagementAnthropicTools,
  getFileManagementOpenAITools,
} from './file-management-tool-defs'

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface FileManagementToolContext {
  searchEngine?: SearchEngine | null
  abortSignal?: AbortSignal
}

function assertInsideWorkspace(target: string, engine: SearchEngine): { ok: true; root: string } | { ok: false; error: string } {
  if (!isAbsolute(target)) {
    return { ok: false, error: 'path must be absolute' }
  }
  const resolved = resolvePath(target)
  const root = engine.findWorkspaceRootForPath(resolved)
  if (!root) return { ok: false, error: `path is outside any known workspace: ${resolved}` }
  const rel = relative(root, resolved)
  if (rel.startsWith('..')) return { ok: false, error: `path escapes workspace root: ${rel}` }
  return { ok: true, root }
}

function toJsonString(value: unknown): string {
  try { return JSON.stringify(value) } catch { return String(value) }
}

export async function executeFileManagementTool(
  toolName: string,
  args: Record<string, unknown>,
  context?: FileManagementToolContext,
): Promise<string> {
  const engine = context?.searchEngine ?? getSearchEngine()
  if (!engine) return 'Error: search engine unavailable'

  if (context?.abortSignal?.aborted) {
    const err = new Error('Operation aborted')
    err.name = 'AbortError'
    throw err
  }

  switch (toolName) {
    case 'file_search':
      return runFileSearch(args, engine)
    case 'file_locate':
      return runFileLocate(args, engine)
    case 'file_get_backlinks':
      return runFileGetBacklinks(args, engine)
    case 'file_get_graph':
      return runFileGetGraph(args, engine)
    case 'file_classify':
      return runFileClassify(args, engine)
    case 'file_rename':
      return runFileRename(args, engine)
    case 'file_move':
      return runFileMove(args, engine)
    default:
      return `Unknown file management tool: ${toolName}`
  }
}

async function runFileSearch(args: Record<string, unknown>, engine: SearchEngine): Promise<string> {
  const query = typeof args.query === 'string' ? args.query : ''
  if (!query.trim()) return 'Error: query is required'
  const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(200, args.limit)) : 20
  const sources = Array.isArray(args.sources) ? args.sources.filter((s): s is string => typeof s === 'string') : undefined
  const workspaceRoot = typeof args.workspaceRoot === 'string' ? args.workspaceRoot : undefined
  const result = await engine.search(query, { limit, sources, workspaceRoot })
  return toJsonString({
    returned: result.stats.returned,
    degraded: result.degraded,
    items: result.items.map((item) => ({
      path: item.path,
      name: item.name,
      sourceType: item.sourceType,
      snippet: item.snippet,
      tagsHit: item.tagsHit,
      linksHit: item.linksHit,
      rank: item.rank,
    })),
  })
}

async function runFileLocate(args: Record<string, unknown>, engine: SearchEngine): Promise<string> {
  const path = typeof args.path === 'string' ? args.path : ''
  if (!path) return 'Error: path is required'
  const anchor = typeof args.anchor === 'string' ? args.anchor : ''
  const repo = engine.getRepository()
  const row = repo
    .getConnection()
    .prepare('SELECT id, source_type FROM documents WHERE path = ? LIMIT 1')
    .get<{ id: number; source_type: string }>(path)
  let sourceType = row?.source_type || 'document'
  if (!row) {
    const guard = assertInsideWorkspace(path, engine)
    if (!guard.ok) return toJsonString({ ok: false, error: 'path not in index', detail: guard.error })
    await engine.indexDocument(guard.root, path)
    sourceType = 'document'
  }

  if (sourceType !== 'document') {
    return toJsonString({ ok: true, path, sourceType, note: 'non-filesystem source; open via host UI' })
  }

  try {
    const content = await readFile(path, 'utf-8')
    const lines = content.split('\n')
    if (!anchor) return toJsonString({ ok: true, path, line: 1, sectionTitle: null })
    const anchorLower = anchor.toLowerCase()
    let sectionTitle: string | null = null
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (/^#{1,6}\s/.test(line) && line.toLowerCase().includes(anchorLower)) {
        return toJsonString({ ok: true, path, line: i + 1, sectionTitle: line.replace(/^#+\s*/, '').trim() })
      }
      if (sectionTitle === null && /^#{1,6}\s/.test(line)) {
        sectionTitle = line.replace(/^#+\s*/, '').trim()
      }
      if (line.toLowerCase().includes(anchorLower)) {
        // Walk back for nearest heading
        let heading: string | null = null
        for (let j = i; j >= 0; j -= 1) {
          if (/^#{1,6}\s/.test(lines[j])) {
            heading = lines[j].replace(/^#+\s*/, '').trim()
            break
          }
        }
        return toJsonString({ ok: true, path, line: i + 1, sectionTitle: heading })
      }
    }
    return toJsonString({ ok: true, path, line: null, sectionTitle: null, note: 'anchor not found' })
  } catch (error) {
    return toJsonString({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

async function runFileGetBacklinks(args: Record<string, unknown>, engine: SearchEngine): Promise<string> {
  const path = typeof args.path === 'string' ? args.path : ''
  if (!path) return 'Error: path is required'
  const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(200, args.limit)) : 50
  const db = engine.getRepository().getConnection()
  const target = db.prepare('SELECT id FROM documents WHERE path = ? LIMIT 1').get<{ id: number }>(path)
  if (!target) return toJsonString({ ok: true, path, references: [] })
  const rows = db
    .prepare(
      `SELECT src.path AS path, src.name AS name, dl.kind AS kind
       FROM doc_links dl
       JOIN documents src ON src.id = dl.src_doc_id
       WHERE dl.target_doc_id = ? AND src.source_type = 'document'
       LIMIT ?`,
    )
    .all<{ path: string; name: string; kind: string }>(target.id, limit)
  return toJsonString({ ok: true, path, references: rows })
}

async function runFileGetGraph(args: Record<string, unknown>, engine: SearchEngine): Promise<string> {
  const depth = typeof args.depth === 'number' ? Math.max(1, Math.min(6, args.depth)) : 2
  const centerPath = typeof args.centerPath === 'string' ? args.centerPath : null
  const workspaceRoot = typeof args.workspaceRoot === 'string' ? args.workspaceRoot : null
  const db = engine.getRepository().getConnection()

  let documents: Array<{ id: number; path: string; name: string; sourceType: string }> = []
  const baseQuery = `SELECT id, path, name, source_type AS sourceType FROM documents`
  if (workspaceRoot) {
    documents = db
      .prepare(`${baseQuery} WHERE workspace_id = (SELECT id FROM workspaces WHERE root = ?)`)
      .all(workspaceRoot)
  } else {
    documents = db.prepare(baseQuery).all()
  }

  // BFS filter if centerPath provided
  let includedIds: Set<number> | null = null
  if (centerPath) {
    const center = documents.find((d) => d.path === centerPath)
    if (!center) return toJsonString({ nodes: [], edges: [], note: 'centerPath not in index' })
    includedIds = new Set([center.id])
    let frontier = new Set([center.id])
    for (let level = 0; level < depth; level += 1) {
      if (frontier.size === 0) break
      const placeholders = Array.from(frontier).map(() => '?').join(',')
      const neighbors = db
        .prepare(
          `SELECT src_doc_id AS a, target_doc_id AS b FROM doc_links WHERE target_doc_id IS NOT NULL AND (src_doc_id IN (${placeholders}) OR target_doc_id IN (${placeholders}))`,
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

  const allowedDocs = includedIds
    ? documents.filter((d) => includedIds!.has(d.id))
    : documents
  const allowedIdSet = new Set(allowedDocs.map((d) => d.id))

  const nodes: Array<{ id: string; type: 'doc' | 'tag' | 'ghost'; label: string; sourceType?: string }> = []
  for (const doc of allowedDocs) {
    nodes.push({ id: `doc:${doc.id}`, type: 'doc', label: doc.name, sourceType: doc.sourceType })
  }

  const idList = Array.from(allowedIdSet)
  if (idList.length === 0) {
    return toJsonString({ nodes, edges: [] })
  }
  const placeholders = idList.map(() => '?').join(',')

  const linkRows = db
    .prepare(
      `SELECT src_doc_id AS src, target_doc_id AS tgt, kind, target_text AS label FROM doc_links WHERE src_doc_id IN (${placeholders})`,
    )
    .all<{ src: number; tgt: number | null; kind: string; label: string }>(...idList)
  const tagRows = db
    .prepare(`SELECT doc_id AS src, tag FROM tags WHERE doc_id IN (${placeholders})`)
    .all<{ src: number; tag: string }>(...idList)

  const edges: Array<{ source: string; target: string; kind: string }> = []
  const tagIds = new Set<string>()
  const ghostIds = new Map<string, string>()

  for (const link of linkRows) {
    if (link.tgt && allowedIdSet.has(link.tgt)) {
      edges.push({ source: `doc:${link.src}`, target: `doc:${link.tgt}`, kind: link.kind })
    } else if (!link.tgt && link.kind === 'wikilink') {
      const ghostId = `ghost:${link.label}`
      if (!ghostIds.has(ghostId)) ghostIds.set(ghostId, link.label)
      edges.push({ source: `doc:${link.src}`, target: ghostId, kind: 'wikilink' })
    }
  }
  for (const row of tagRows) {
    const tagId = `tag:${row.tag.toLowerCase()}`
    tagIds.add(`${tagId}|${row.tag}`)
    edges.push({ source: `doc:${row.src}`, target: tagId, kind: 'tag-of' })
  }
  for (const entry of tagIds) {
    const [id, label] = entry.split('|')
    nodes.push({ id, type: 'tag', label })
  }
  for (const [id, label] of ghostIds.entries()) {
    nodes.push({ id, type: 'ghost', label })
  }

  return toJsonString({ nodes, edges })
}

async function runFileClassify(args: Record<string, unknown>, engine: SearchEngine): Promise<string> {
  const path = typeof args.path === 'string' ? args.path : ''
  if (!path) return 'Error: path is required'
  const addTags = Array.isArray(args.addTags) ? args.addTags.filter((t): t is string => typeof t === 'string') : []
  const removeTags = Array.isArray(args.removeTags)
    ? new Set(args.removeTags.filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase()))
    : null
  const setFrontmatter = args.setFrontmatter && typeof args.setFrontmatter === 'object' && !Array.isArray(args.setFrontmatter)
    ? (args.setFrontmatter as Record<string, unknown>)
    : null
  if (addTags.length === 0 && !removeTags && !setFrontmatter) {
    return 'Error: at least one of addTags / removeTags / setFrontmatter required'
  }
  if (!path.toLowerCase().endsWith('.md')) {
    return 'Error: file_classify only supports .md files'
  }
  const guard = assertInsideWorkspace(path, engine)
  if (!guard.ok) return `Error: ${guard.error}`

  try {
    const content = await readFile(path, 'utf-8')
    const graph = parseDocumentGraph(content)
    const currentFm = (graph.frontmatter && typeof graph.frontmatter === 'object') ? { ...graph.frontmatter } : {}
    const existingTags: string[] = Array.isArray(currentFm.tags)
      ? currentFm.tags.filter((t: unknown): t is string => typeof t === 'string')
      : []
    const tagSet = new Map<string, string>()
    for (const tag of existingTags) tagSet.set(tag.toLowerCase(), tag)
    for (const tag of addTags) {
      const clean = tag.trim().replace(/^#/, '')
      if (clean) tagSet.set(clean.toLowerCase(), clean)
    }
    if (removeTags) {
      for (const key of Array.from(tagSet.keys())) {
        if (removeTags.has(key)) tagSet.delete(key)
      }
    }
    const mergedTags = Array.from(tagSet.values())

    const updatedFm: Record<string, unknown> = { ...currentFm }
    if (setFrontmatter) {
      for (const key of Object.keys(setFrontmatter)) {
        updatedFm[key] = setFrontmatter[key]
      }
    }
    if (mergedTags.length > 0) updatedFm.tags = mergedTags
    else delete updatedFm.tags

    const { writeFrontmatter } = await import('../../../shared/document-graph-parse-frontmatter-writer')
    const nextContent = writeFrontmatter(content, updatedFm)
    const { writeFile } = await import('fs/promises')
    await writeFile(path, nextContent, 'utf-8')
    // Keep the index in sync eagerly; the write hook also fires for
    // non-tool-originated document:write calls.
    await engine.indexDocument(guard.root, path, nextContent)
    return toJsonString({ ok: true, path, tags: mergedTags, frontmatter: updatedFm })
  } catch (error) {
    return toJsonString({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

async function runFileRename(args: Record<string, unknown>, engine: SearchEngine): Promise<string> {
  const path = typeof args.path === 'string' ? args.path : ''
  const newName = typeof args.newName === 'string' ? args.newName.trim() : ''
  const overwrite = args.overwrite === true
  if (!path || !newName) return 'Error: path and newName required'
  if (newName.includes('/') || newName.includes('\\')) return 'Error: newName must not contain path separators'

  const guard = assertInsideWorkspace(path, engine)
  if (!guard.ok) return `Error: ${guard.error}`
  const newPath = join(dirname(path), newName)
  const newGuard = assertInsideWorkspace(newPath, engine)
  if (!newGuard.ok) return `Error: ${newGuard.error}`

  try {
    const exists = await stat(newPath).then(() => true).catch(() => false)
    if (exists && !overwrite) return toJsonString({ ok: false, error: 'target exists; pass overwrite=true to replace' })
    await rename(path, newPath)
    // Remove stale entry, index new path
    const db = engine.getRepository().getConnection()
    const existing = db.prepare('SELECT workspace_id FROM documents WHERE path = ?').get<{ workspace_id: number }>(path)
    if (existing) {
      db.prepare('DELETE FROM documents WHERE path = ?').run(path)
    }
    await engine.indexDocument(guard.root, newPath)
    return toJsonString({ ok: true, newPath })
  } catch (error) {
    return toJsonString({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

async function runFileMove(args: Record<string, unknown>, engine: SearchEngine): Promise<string> {
  const path = typeof args.path === 'string' ? args.path : ''
  const destDir = typeof args.destDir === 'string' ? args.destDir : ''
  const newName = typeof args.newName === 'string' ? args.newName.trim() : ''
  const overwrite = args.overwrite === true
  if (!path || !destDir) return 'Error: path and destDir required'

  const srcGuard = assertInsideWorkspace(path, engine)
  if (!srcGuard.ok) return `Error: ${srcGuard.error}`
  const destGuard = assertInsideWorkspace(destDir, engine)
  if (!destGuard.ok) return `Error: ${destGuard.error}`
  if (srcGuard.root !== destGuard.root) return 'Error: cross-workspace move not supported'

  const fileName = newName || path.split(/[\\/]/).pop() || 'file'
  const newPath = join(destDir, fileName)
  const newGuard = assertInsideWorkspace(newPath, engine)
  if (!newGuard.ok) return `Error: ${newGuard.error}`

  try {
    const destStat = await stat(destDir).catch(() => null)
    if (!destStat || !destStat.isDirectory()) return 'Error: destDir is not a directory'
    const exists = await stat(newPath).then(() => true).catch(() => false)
    if (exists && !overwrite) return toJsonString({ ok: false, error: 'target exists; pass overwrite=true to replace' })
    await rename(path, newPath)
    const db = engine.getRepository().getConnection()
    db.prepare('DELETE FROM documents WHERE path = ?').run(path)
    await engine.indexDocument(srcGuard.root, newPath)
    return toJsonString({ ok: true, newPath })
  } catch (error) {
    return toJsonString({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}
