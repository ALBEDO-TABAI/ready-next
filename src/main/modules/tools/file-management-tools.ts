import { readFile, rename, stat } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'path'
import type { SearchEngine } from '../search-engine/indexer'
import { getSearchEngine } from '../search-engine/ipc-handler'
import { getWorkerDbBridge } from '../database/worker-bridge'
import { parseDocumentGraph } from '../../../shared/document-graph-parse'
import { resolveIndexedDocumentCandidate } from './file-locate-path'

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

  // perf-rescue B1: FTS scan over an 80GB index used to lock the main thread.
  // Offload to worker; on worker failure fall back to the in-process engine so
  // we never break this tool path.
  let result: Awaited<ReturnType<SearchEngine['search']>>
  try {
    result = await getWorkerDbBridge().searchDocuments({ query, limit, sources, workspaceRoot })
  } catch {
    result = await engine.search(query, { limit, sources, workspaceRoot })
  }
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
  let path = typeof args.path === 'string' ? args.path.trim() : ''
  if (!path) return 'Error: path is required'
  const anchor = typeof args.anchor === 'string' ? args.anchor : ''
  const repo = engine.getRepository()
  const resolved = resolveIndexedDocumentCandidate(repo.getConnection(), path)
  let sourceType = 'document'
  if (resolved.kind === 'found') {
    path = resolved.row.path
    sourceType = resolved.row.source_type || 'document'
  } else if (resolved.kind === 'ambiguous') {
    return toJsonString({ ok: false, error: 'path is ambiguous', candidates: resolved.candidates })
  } else {
    const guard = assertInsideWorkspace(path, engine)
    if (!guard.ok) return toJsonString({ ok: false, error: 'path not in index', detail: guard.error })
    await engine.indexDocument(guard.root, path)
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

async function runFileGetGraph(args: Record<string, unknown>, _engine: SearchEngine): Promise<string> {
  const depth = typeof args.depth === 'number' ? Math.max(1, Math.min(6, args.depth)) : 2
  const centerPath = typeof args.centerPath === 'string' ? args.centerPath : undefined
  const workspaceRoot = typeof args.workspaceRoot === 'string' ? args.workspaceRoot : undefined

  // perf-rescue B1: graph queries can scan 681K rows + N BFS round-trips.
  // Offload to the worker_thread so the main thread stays responsive.
  // Falls back to an error JSON if the worker is unavailable, matching the
  // contract for the original implementation (always returns a JSON string).
  try {
    const result = await getWorkerDbBridge().getDocumentGraph({ depth, centerPath, workspaceRoot })
    if (result.note === 'centerPath not in index') {
      return toJsonString({ nodes: [], edges: [], note: result.note })
    }
    return toJsonString({ nodes: result.nodes, edges: result.edges })
  } catch (error) {
    return toJsonString({
      nodes: [],
      edges: [],
      error: error instanceof Error ? error.message : String(error),
    })
  }
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
