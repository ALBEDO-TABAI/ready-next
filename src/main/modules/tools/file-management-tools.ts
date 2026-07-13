import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'fs/promises'
import { constants, existsSync } from 'fs'
import { createHash, randomUUID } from 'crypto'
import { tmpdir } from 'os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve as resolvePath } from 'path'
import { fileURLToPath } from 'url'
import type { SearchEngine } from '../search-engine/indexer'
import { getWorkerDbBridge } from '../database/worker-bridge'
import { parseDocumentGraph } from '../../../shared/document-graph-parse'
import { resolveDocumentSectionAnchor } from '../../../shared/document-sectioning'
import { validateWorkspaceRoot } from '../../../shared/workspace-validation'
import { executeTagForgeApply } from '../tag-forge/tag-forge-tool'
import { revisionOf } from '../tag-forge/tag-forge-writer'
import {
  resolveIndexedDocumentCandidate as resolveIndexedDocumentCandidateFromDb,
  type IndexedDocumentRow,
} from './file-locate-path'

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
  organizeStoreDir?: string | null
  workspaceRoots?: string[] | null
  runId?: string | null
  requestModuleToolAction?: (tool:string,args:Record<string,unknown>)=>Promise<Record<string,unknown>>
}

const DEFAULT_EXCERPT_CHARS = 32_000
const MAX_EXCERPT_CHARS = 40_000
const DEFAULT_EXTRACT_CHARS = 20_000
const MAX_EXTRACT_CHARS = 40_000
const DEFAULT_INVENTORY_LIMIT = 100
const MAX_INVENTORY_LIMIT = 500
const DEFAULT_INVENTORY_DEPTH = 2
const MAX_INVENTORY_DEPTH = 5
const ORGANIZE_PLAN_TTL_MS = 30 * 60 * 1000

type OrganizeOperationInput = {
  path: string
  destDir: string
  newName?: string
}

type OrganizeOperation = OrganizeOperationInput & {
  targetPath: string
}

type OrganizeConflict = {
  kind: string
  path?: string
  targetPath?: string
  message: string
}

type OrganizePlan = {
  planId: string
  rootPath: string
  workspaceRoot: string
  createFolders: string[]
  operations: OrganizeOperation[]
  conflicts: OrganizeConflict[]
  confirmed: boolean
  createdAt: string
  expiresAt: string
}

type JournalMove = {
  type: 'move'
  sourcePath: string
  targetPath: string
}

type JournalFolder = {
  type: 'mkdir'
  path: string
}

type OrganizeJournal = {
  journalId: string
  planId: string
  rootPath: string
  workspaceRoot: string
  executedAt: string
  undoneAt: string | null
  operations: Array<JournalMove | JournalFolder>
}

type TagForgeBatchItemState = {
  path: string
  status: 'pending' | 'awaiting_review' | 'completed' | 'conflict' | 'failed'
  errorKind?: string | null
}

type TagForgeBatchState = {
  batchId: string
  rootPath: string
  workspaceRoot: string
  items: TagForgeBatchItemState[]
  createdAt: string
  updatedAt: string
}

type AuthorizedRoot =
  | { ok: true; rootPath: string; rootRealPath: string; workspaceRoot: string }
  | { ok: false; output: Record<string, unknown> }

function normalizeExplicitWorkspaceRoots(roots: string[] | null | undefined): string[] | null {
  if (!Array.isArray(roots)) return null
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const rawRoot of roots) {
    const root = typeof rawRoot === 'string' ? resolvePath(rawRoot.trim()) : ''
    if (!root || !validateWorkspaceRoot(root).ok || seen.has(root)) continue
    seen.add(root)
    normalized.push(root)
  }
  return normalized
}

function assertInsideWorkspace(
  target: string,
  engine: SearchEngine,
  explicitRoots?: string[] | null,
): { ok: true; root: string } | { ok: false; error: string } {
  if (!isAbsolute(target)) {
    return { ok: false, error: 'path must be absolute' }
  }
  const resolved = resolvePath(target)
  const scopedRoots = normalizeExplicitWorkspaceRoots(explicitRoots)
  const root = scopedRoots
    ? scopedRoots.find((candidate) => isPathInsideRoot(resolved, candidate))
    : engine.findWorkspaceRootForPath(resolved)
  if (!root) return { ok: false, error: `path is outside any known workspace: ${resolved}` }
  const rel = relative(root, resolved)
  if (rel.startsWith('..')) return { ok: false, error: `path escapes workspace root: ${rel}` }
  return { ok: true, root }
}

function isPathInsideRoot(target: string, root: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function authorizeRoot(
  rawRootPath: string,
  engine: SearchEngine,
  explicitRoots?: string[] | null,
): Promise<AuthorizedRoot> {
  const raw = String(rawRootPath || '').trim()
  if (!raw) return { ok: false, output: { ok: false, error: 'rootPath is required' } }
  const rootPath = resolvePath(raw)
  if (!isAbsolute(rootPath)) return { ok: false, output: { ok: false, error: 'rootPath must be absolute' } }
  const guard = assertInsideWorkspace(rootPath, engine, explicitRoots)
  if (!guard.ok) return { ok: false, output: { ok: false, error: guard.error } }
  try {
    const rootStat = await stat(rootPath)
    if (!rootStat.isDirectory()) return { ok: false, output: { ok: false, error: 'rootPath must be a directory', rootPath } }
    const workspaceRealPath = await realpath(guard.root)
    const rootRealPath = await realpath(rootPath)
    if (!isPathInsideRoot(rootRealPath, workspaceRealPath)) {
      return { ok: false, output: { ok: false, error: 'rootPath escapes workspace via symlink', rootPath } }
    }
    return { ok: true, rootPath, rootRealPath, workspaceRoot: guard.root }
  } catch (error) {
    // silent-catch: root authorization failures are returned as structured tool errors.
    return { ok: false, output: { ok: false, rootPath, error: error instanceof Error ? error.message : String(error) } }
  }
}

async function resolveExistingPathInsideRoot(
  rawPath: string,
  auth: Extract<AuthorizedRoot, { ok: true }>,
): Promise<{ ok: true; path: string; realPath: string } | { ok: false; error: string }> {
  const raw = String(rawPath || '').trim()
  if (!raw) return { ok: false, error: 'path is required' }
  const path = resolvePath(raw)
  if (!isAbsolute(path)) return { ok: false, error: 'path must be absolute' }
  if (!isPathInsideRoot(path, auth.rootPath)) return { ok: false, error: 'path is outside authorized root' }
  try {
    const real = await realpath(path)
    if (!isPathInsideRoot(real, auth.rootRealPath)) return { ok: false, error: 'path escapes authorized root via symlink' }
    return { ok: true, path, realPath: real }
  } catch (error) {
    // silent-catch: path resolution failures are returned as structured tool errors.
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function resolvePlannedPathInsideRoot(
  rawPath: string,
  auth: Extract<AuthorizedRoot, { ok: true }>,
): { ok: true; path: string } | { ok: false; error: string } {
  const raw = String(rawPath || '').trim()
  if (!raw) return { ok: false, error: 'path is required' }
  const path = resolvePath(raw)
  if (!isAbsolute(path)) return { ok: false, error: 'path must be absolute' }
  if (!isPathInsideRoot(path, auth.rootPath)) return { ok: false, error: 'path is outside authorized root' }
  return { ok: true, path }
}

function resolveRelativeFolderInsideRoot(
  rawRelativePath: string,
  auth: Extract<AuthorizedRoot, { ok: true }>,
): { ok: true; path: string; relativePath: string } | { ok: false; error: string } {
  const relativePath = String(rawRelativePath || '').trim()
  if (!relativePath) return { ok: false, error: 'relativePath is required' }
  if (isAbsolute(relativePath)) return { ok: false, error: 'relativePath must not be absolute' }
  const target = resolvePath(auth.rootPath, relativePath)
  if (!isPathInsideRoot(target, auth.rootPath)) return { ok: false, error: 'relativePath escapes authorized root' }
  return { ok: true, path: target, relativePath }
}

async function getOrganizeStoreDir(context?: FileManagementToolContext): Promise<string> {
  const fromContext = context?.organizeStoreDir ? String(context.organizeStoreDir).trim() : ''
  if (fromContext) return fromContext
  try {
    const electron = await import('electron')
    const userData = electron.app?.getPath?.('userData')
    if (userData) return join(userData, 'file-organizer')
  } catch {
    // silent-catch: tests and non-Electron callers fall back to a temp-backed store.
  }
  return join(tmpdir(), 'ready-file-organizer')
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T
  } catch {
    return null
  }
}

function planPath(storeDir: string, planId: string): string {
  return join(storeDir, 'plans', `${planId}.json`)
}

function journalPath(storeDir: string, journalId: string): string {
  return join(storeDir, 'journals', `${journalId}.json`)
}

function toJsonString(value: unknown): string {
  try { return JSON.stringify(value) } catch { return String(value) }
}

function addCandidate(candidates: string[], value: string | null | undefined) {
  const trimmed = String(value || '').trim()
  if (!trimmed || candidates.includes(trimmed)) return
  candidates.push(trimmed)
}

function stripBalancedWrapper(value: string): string {
  let current = value.trim()
  const pairs: Array<[string, string]> = [
    ['`', '`'],
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’'],
    ['<', '>'],
  ]
  let changed = true
  while (changed && current.length >= 2) {
    changed = false
    for (const [open, close] of pairs) {
      if (current.startsWith(open) && current.endsWith(close)) {
        current = current.slice(open.length, current.length - close.length).trim()
        changed = true
      }
    }
  }
  return current
}

function tryDecodeCandidate(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    try {
      return decodeURI(value)
    } catch {
      return null
    }
  }
}

export function buildFileLocatePathCandidates(input: string): string[] {
  const candidates: string[] = []
  const raw = String(input || '').trim()
  addCandidate(candidates, raw)
  const stripped = stripBalancedWrapper(raw)
  addCandidate(candidates, stripped)

  const markdownLink = stripped.match(/^!?\[([^\]]+)\]\(([^)]+)\)$/)
  if (markdownLink) {
    addCandidate(candidates, markdownLink[2])
    addCandidate(candidates, markdownLink[1])
  }

  const mention = stripped.match(/^@?\[([^\]]+)\]$/)
  if (mention) addCandidate(candidates, mention[1])
  if (stripped.startsWith('@') && stripped.length > 1) addCandidate(candidates, stripped.slice(1))

  for (const candidate of [...candidates]) {
    if (/^file:\/\//i.test(candidate)) {
      try {
        addCandidate(candidates, fileURLToPath(candidate))
      } catch {
        // Keep the original candidate; a malformed file URL will fail normally.
      }
    }
    addCandidate(candidates, tryDecodeCandidate(candidate))
  }

  return candidates
}

function resolveFileLocateCandidate(input: string, engine: SearchEngine): {
  path: string
  row: IndexedDocumentRow | null
  ambiguous?: Array<{ path: string; sourceType: string }>
} {
  const db = engine.getRepository().getConnection()
  const candidates = buildFileLocatePathCandidates(input)
  let ambiguous: Array<{ path: string; sourceType: string }> | null = null
  for (const candidate of candidates) {
    const resolved = resolveIndexedDocumentCandidateFromDb(db, candidate)
    if (resolved.kind === 'found') return { path: resolved.row.path, row: resolved.row }
    if (resolved.kind === 'ambiguous' && !ambiguous) ambiguous = resolved.candidates
  }

  if (ambiguous) return { path: input, row: null, ambiguous }
  return { path: candidates.find(isAbsolute) || candidates[0] || input, row: null }
}

export async function executeFileManagementTool(
  toolName: string,
  args: Record<string, unknown>,
  context?: FileManagementToolContext,
): Promise<string> {
  const engine = context?.searchEngine ?? await getDefaultSearchEngine()
  if (!engine) return 'Error: search engine unavailable'

  if (context?.abortSignal?.aborted) {
    const err = new Error('Operation aborted')
    err.name = 'AbortError'
    throw err
  }

  switch (toolName) {
    case 'file_search':
      return runFileSearch(args, engine, context)
    case 'file_locate':
      return runFileLocate(args, engine, context)
    case 'file_read_excerpt':
      return runFileReadExcerpt(args, engine, context)
    case 'file_get_backlinks':
      return runFileGetBacklinks(args, engine, context)
    case 'file_get_graph':
      return runFileGetGraph(args, engine, context)
    case 'file_classify':
      return runFileClassify(args, engine, context)
    case 'tag_forge_apply':
      return executeTagForgeApply(args, engine, context)
    case 'tag_forge_prepare_batch':
      return runTagForgePrepareBatch(args, engine, context)
    case 'tag_forge_apply_batch':
      return runTagForgeApplyBatch(args, engine, context)
    case 'file_rename':
      return runFileRename(args, engine, context)
    case 'file_move':
      return runFileMove(args, engine, context)
    case 'file_copy':
      return runFileCopy(args, engine, context)
    case 'file_inventory':
      return runFileInventory(args, engine, context)
    case 'file_extract_text':
      return runFileExtractText(args, engine, context)
    case 'file_create_folder':
      return runFileCreateFolder(args, engine, context)
    case 'file_organize_preview':
      return runFileOrganizePreview(args, engine, context)
    case 'file_organize_apply':
      return runFileOrganizeApply(args, engine, context)
    case 'file_organize_undo':
      return runFileOrganizeUndo(args, engine, context)
    default:
      return `Unknown file management tool: ${toolName}`
  }
}

function tagForgeBatchPath(storeDir: string, batchId: string): string {
  return join(storeDir, 'tag-forge-batches', `${batchId}.json`)
}

function hasExistingTagMetadata(content: string): boolean {
  const graph = parseDocumentGraph(content)
  if (Array.isArray(graph.frontmatter?.tags) && graph.frontmatter.tags.length > 0) return true
  return graph.body.replace(/^\uFEFF/, '').split(/\r?\n/).some((line) => /^(?:#[\p{L}\p{N}_\-/]+\s*){1,20}$/u.test(line.trim()))
}

async function loadTagForgeBatch(storeDir: string, batchId: string): Promise<TagForgeBatchState | null> {
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(batchId)) return null
  return readJsonFile<TagForgeBatchState>(tagForgeBatchPath(storeDir, batchId))
}

async function saveTagForgeBatch(storeDir: string, state: TagForgeBatchState): Promise<void> {
  state.updatedAt = new Date().toISOString()
  await writeJsonFile(tagForgeBatchPath(storeDir, state.batchId), state)
}

async function runTagForgePrepareBatch(
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
  const storeDir = await getOrganizeStoreDir(context)
  const requestedBatchId = typeof args.batchId === 'string' ? args.batchId.trim() : ''
  let state = requestedBatchId ? await loadTagForgeBatch(storeDir, requestedBatchId) : null
  if (requestedBatchId && !state) return toJsonString({ ok: false, errorKind: 'tag_forge_batch_not_found' })
  if (!state) {
    const auth = await authorizeRoot(typeof args.rootPath === 'string' ? args.rootPath : '', engine, context?.workspaceRoots)
    if (!auth.ok) return toJsonString(auth.output)
    const inventory = await collectInventory(auth.rootPath, auth, true, MAX_INVENTORY_DEPTH)
    const items: TagForgeBatchItemState[] = []
    for (const item of inventory) {
      if (item.kind !== 'file' || extname(item.path).toLowerCase() !== '.md') continue
      const content = await readFile(item.path, 'utf-8').catch(() => null)
      if (content === null || hasExistingTagMetadata(content)) continue
      items.push({ path: item.path, status: 'pending' })
    }
    const fingerprint = createHash('sha256').update(`${auth.rootPath}\0${Date.now()}\0${randomUUID()}`).digest('hex').slice(0, 20)
    const now = new Date().toISOString()
    state = {
      batchId: `tfb-${fingerprint}`,
      rootPath: auth.rootPath,
      workspaceRoot: auth.workspaceRoot,
      items,
      createdAt: now,
      updatedAt: now,
    }
    await saveTagForgeBatch(storeDir, state)
  }
  const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(12, Math.floor(args.limit))) : 8
  const pending = state.items.filter((item) => item.status !== 'completed').slice(0, limit)
  const documents: Array<{ path: string; expectedRevision: string; content: string }> = []
  for (const item of pending) {
    try {
      const content = await readFile(item.path, 'utf-8')
      documents.push({ path: item.path, expectedRevision: revisionOf(content), content })
    } catch (error) {
      item.status = 'failed'
      item.errorKind = error instanceof Error ? error.message : String(error)
    }
  }
  await saveTagForgeBatch(storeDir, state)
  const completed = state.items.filter((item) => item.status === 'completed').length
  const remaining = state.items.filter((item) => item.status !== 'completed').length
  return toJsonString({
    ok: true,
    batchId: state.batchId,
    rootPath: state.rootPath,
    total: state.items.length,
    completed,
    remaining,
    done: remaining === 0,
    documents,
  })
}

async function runTagForgeApplyBatch(
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
  const batchId = typeof args.batchId === 'string' ? args.batchId.trim() : ''
  const storeDir = await getOrganizeStoreDir(context)
  const state = await loadTagForgeBatch(storeDir, batchId)
  if (!state) return toJsonString({ ok: false, errorKind: 'tag_forge_batch_not_found' })
  const submitted = Array.isArray(args.items) ? args.items : []
  const results: Array<Record<string, unknown>> = []
  for (const raw of submitted) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const item = raw as Record<string, unknown>
    const path = typeof item.path === 'string' ? resolvePath(item.path) : ''
    const tracked = state.items.find((candidate) => candidate.path === path)
    if (!tracked || tracked.status === 'completed') {
      results.push({ path, ok: false, errorKind: tracked ? 'already_completed' : 'path_not_in_batch' })
      continue
    }
    const output = JSON.parse(await executeTagForgeApply({
      path,
      mode: 'explicit',
      expectedRevision: item.expectedRevision,
      proposals: item.proposals,
    }, engine, context)) as Record<string, unknown>
    if (output.ok === true && output.status === 'waiting_review') {
      tracked.status = 'awaiting_review'
      tracked.errorKind = null
    } else if (output.ok === true) {
      tracked.status = 'completed'
      tracked.errorKind = null
    } else {
      const errorKind = typeof output.errorKind === 'string' ? output.errorKind : 'tag_write_failed'
      tracked.status = errorKind === 'revision_conflict' || errorKind === 'open_tab_revision_conflict' ? 'conflict' : 'failed'
      tracked.errorKind = errorKind
    }
    results.push(output)
    await saveTagForgeBatch(storeDir, state)
  }
  const completed = state.items.filter((item) => item.status === 'completed').length
  const remaining = state.items.filter((item) => item.status !== 'completed').length
  const awaitingReview = state.items.filter((item) => item.status === 'awaiting_review').length
  return toJsonString({
    ok: results.every((result) => result.ok === true),
    batchId,
    completed,
    remaining,
    done: remaining === 0,
    awaitingReview,
    reviewRequired: awaitingReview > 0,
    reviewLocation: awaitingReview > 0 ? '设置 > 文档标签' : null,
    resume: awaitingReview > 0 ? { tool: 'tag_forge_prepare_batch', args: { rootPath: state.rootPath, batchId } } : null,
    results,
  })
}

async function getDefaultSearchEngine(): Promise<SearchEngine | null> {
  const { getSearchEngine } = await import('../search-engine/ipc-handler')
  return getSearchEngine()
}

async function runFileSearch(
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
  const query = typeof args.query === 'string' ? args.query : ''
  if (!query.trim()) return 'Error: query is required'
  const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(200, args.limit)) : 20
  const sources = Array.isArray(args.sources) ? args.sources.filter((s): s is string => typeof s === 'string') : undefined
  const workspaceRoot = typeof args.workspaceRoot === 'string' ? args.workspaceRoot : undefined
  const workspaceRoots = normalizeExplicitWorkspaceRoots(context?.workspaceRoots)

  // perf-rescue B1: FTS scan over an 80GB index used to lock the main thread.
  // Offload to worker; on worker failure fall back to the in-process engine so
  // we never break this tool path.
  let result: Awaited<ReturnType<SearchEngine['search']>>
  try {
    result = await getWorkerDbBridge().searchDocuments({ query, limit, sources, workspaceRoot, workspaceRoots: workspaceRoots ?? undefined })
  } catch {
    // silent-catch: worker failure falls back to the in-process engine (perf-rescue B1 above)
    result = await engine.search(query, { limit, sources, workspaceRoot, workspaceRoots: workspaceRoots ?? undefined })
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

async function runFileLocate(
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
  const requestedPath = typeof args.path === 'string' ? args.path : ''
  if (!requestedPath) return 'Error: path is required'
  const anchor = typeof args.anchor === 'string' ? args.anchor : ''
  const resolved = resolveFileLocateCandidate(requestedPath, engine)
  const path = resolved.path
  if (resolved.ambiguous?.length) {
    return toJsonString({
      ok: false,
      error: 'ambiguous path',
      candidates: resolved.ambiguous,
    })
  }
  const row = resolved.row
  let sourceType = row?.source_type || 'document'
  if (!row) {
    const guard = assertInsideWorkspace(path, engine, context?.workspaceRoots)
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
    const section = resolveDocumentSectionAnchor(content, anchor)
    if (section) {
      return toJsonString({
        ok: true,
        path,
        line: section.line + 1,
        sectionTitle: section.displayTitle,
      })
    }
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

async function resolveReadableDocumentPath(
  rawPath: string,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<
  | { ok: true; path: string; readPath: string; root: string }
  | { ok: false; output: Record<string, unknown> }
> {
  let path = rawPath.trim()
  if (!path) return { ok: false, output: { ok: false, error: 'path is required' } }
  const resolved = resolveFileLocateCandidate(path, engine)
  let sourceType = 'document'
  if (resolved.row) {
    path = resolved.path
    sourceType = resolved.row.source_type || 'document'
  } else if (resolved.ambiguous?.length) {
    return { ok: false, output: { ok: false, error: 'ambiguous path', candidates: resolved.ambiguous } }
  } else {
    path = resolved.path
    const guard = assertInsideWorkspace(path, engine, context?.workspaceRoots)
    if (!guard.ok) return { ok: false, output: { ok: false, error: 'path not in index', detail: guard.error } }
    await engine.indexDocument(guard.root, path)
  }

  if (sourceType !== 'document') {
    return { ok: false, output: { ok: false, path, sourceType, error: 'non-filesystem source; open via host UI' } }
  }

  const guard = assertInsideWorkspace(path, engine, context?.workspaceRoots)
  if (!guard.ok) return { ok: false, output: { ok: false, error: guard.error } }

  const rootRealPath = await realpath(guard.root)
  const targetRealPath = await realpath(path)
  const rootPrefix = rootRealPath.endsWith('/') ? rootRealPath : `${rootRealPath}/`
  if (targetRealPath !== rootRealPath && !targetRealPath.startsWith(rootPrefix)) {
    return {
      ok: false,
      output: {
        ok: false,
        path,
        error: 'path escapes workspace via symlink',
      },
    }
  }
  return { ok: true, path, readPath: targetRealPath, root: guard.root }
}

function headingInfo(line: string): { level: number; title: string } | null {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
  if (!match) return null
  return { level: match[1].length, title: match[2].trim() }
}

function clampLine(value: unknown, fallback: number, lineCount: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.max(1, Math.min(lineCount, numeric))
}

function boundedExcerpt(
  lines: string[],
  startIndex: number,
  endExclusive: number,
  maxChars: number,
): { content: string; lineEnd: number; truncated: boolean; nextLine: number | null } {
  let content = ''
  let endIndex = startIndex - 1
  let truncated = false
  for (let i = startIndex; i < endExclusive; i += 1) {
    const addition = content ? `\n${lines[i]}` : lines[i]
    if (content.length + addition.length > maxChars) {
      const remaining = maxChars - content.length
      if (remaining > 0 && !content) {
        content = addition.slice(0, remaining)
        endIndex = i
      }
      truncated = true
      break
    }
    content += addition
    endIndex = i
  }
  if (endIndex < startIndex) endIndex = startIndex
  return {
    content,
    lineEnd: endIndex + 1,
    truncated,
    nextLine: truncated && endIndex + 2 <= lines.length ? endIndex + 2 : null,
  }
}

function resolveExcerptRange(
  content: string,
  lines: string[],
  args: Record<string, unknown>,
): { ok: true; startIndex: number; endExclusive: number; anchorLine: number | null; sectionTitle: string | null }
  | { ok: false; output: Record<string, unknown> } {
  const lineCount = Math.max(1, lines.length)
  const hasExplicitRange = typeof args.lineStart === 'number' || typeof args.lineEnd === 'number'
  const anchor = typeof args.anchor === 'string' ? args.anchor.trim() : ''
  if (hasExplicitRange) {
    const start = clampLine(args.lineStart, 1, lineCount)
    const end = clampLine(args.lineEnd, start, lineCount)
    if (end < start) {
      return { ok: false, output: { ok: false, error: 'lineEnd must be greater than or equal to lineStart' } }
    }
    return { ok: true, startIndex: start - 1, endExclusive: end, anchorLine: null, sectionTitle: null }
  }

  if (!anchor) {
    return { ok: true, startIndex: 0, endExclusive: lines.length, anchorLine: null, sectionTitle: null }
  }

  const section = resolveDocumentSectionAnchor(content, anchor)
  if (section) {
    return {
      ok: true,
      startIndex: section.line,
      endExclusive: Math.max(section.line + 1, Math.min(lines.length, section.endLine)),
      anchorLine: section.line + 1,
      sectionTitle: section.displayTitle,
    }
  }

  const anchorLower = anchor.toLowerCase()
  let foundIndex = -1
  let foundHeading: { level: number; title: string } | null = null
  for (let i = 0; i < lines.length; i += 1) {
    const heading = headingInfo(lines[i])
    if (heading && (heading.title.toLowerCase().includes(anchorLower) || lines[i].toLowerCase().includes(anchorLower))) {
      foundIndex = i
      foundHeading = heading
      break
    }
  }
  if (foundIndex < 0) {
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].toLowerCase().includes(anchorLower)) {
        foundIndex = i
        break
      }
    }
  }
  if (foundIndex < 0) {
    return { ok: false, output: { ok: false, error: 'anchor not found', anchor } }
  }

  let endExclusive = lines.length
  if (foundHeading) {
    for (let i = foundIndex + 1; i < lines.length; i += 1) {
      const heading = headingInfo(lines[i])
      if (heading && heading.level <= foundHeading.level) {
        endExclusive = i
        break
      }
    }
  } else {
    endExclusive = Math.min(lines.length, foundIndex + 80)
  }
  return {
    ok: true,
    startIndex: foundIndex,
    endExclusive,
    anchorLine: foundIndex + 1,
    sectionTitle: foundHeading?.title || null,
  }
}

async function runFileReadExcerpt(
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
  const rawPath = typeof args.path === 'string' ? args.path : ''
  const resolved = await resolveReadableDocumentPath(rawPath, engine, context)
  if (!resolved.ok) return toJsonString(resolved.output)

  try {
    const content = await readFile(resolved.readPath, 'utf-8')
    const lines = content.split(/\r?\n/)
    const range = resolveExcerptRange(content, lines, args)
    if (!range.ok) return toJsonString({ ...range.output, path: resolved.path })
    const maxChars = Math.max(
      1,
      Math.min(
        MAX_EXCERPT_CHARS,
        typeof args.maxChars === 'number' && Number.isFinite(args.maxChars)
          ? Math.floor(args.maxChars)
          : DEFAULT_EXCERPT_CHARS,
      ),
    )
    const excerpt = boundedExcerpt(lines, range.startIndex, range.endExclusive, maxChars)
    return toJsonString({
      ok: true,
      path: resolved.path,
      lineStart: range.startIndex + 1,
      lineEnd: excerpt.lineEnd,
      anchorLine: range.anchorLine,
      sectionTitle: range.sectionTitle,
      truncated: excerpt.truncated,
      nextLine: excerpt.nextLine,
      content: excerpt.content,
    })
  } catch (error) {
    // silent-catch: tool dispatch surface — the error message is serialized into the JSON
    // string returned to the LLM as the tool result, which is the surfaced channel for
    // tool errors. No separate metric/log: this matches how other file_management tools
    // signal failure to the model.
    return toJsonString({ ok: false, path: resolved.path, error: error instanceof Error ? error.message : String(error) })
  }
}

async function runFileGetBacklinks(
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
  const path = typeof args.path === 'string' ? args.path : ''
  if (!path) return 'Error: path is required'
  const guard = assertInsideWorkspace(path, engine, context?.workspaceRoots)
  if (!guard.ok) return toJsonString({ ok: false, path, error: guard.error })
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
  const scopedRows = rows.filter((row) => assertInsideWorkspace(row.path, engine, context?.workspaceRoots).ok)
  return toJsonString({ ok: true, path, references: scopedRows })
}

async function runFileGetGraph(
  args: Record<string, unknown>,
  _engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
  const depth = typeof args.depth === 'number' ? Math.max(1, Math.min(6, args.depth)) : 2
  const centerPath = typeof args.centerPath === 'string' ? args.centerPath : undefined
  const workspaceRoot = typeof args.workspaceRoot === 'string' ? args.workspaceRoot : undefined
  const workspaceRoots = normalizeExplicitWorkspaceRoots(context?.workspaceRoots)

  // perf-rescue B1: graph queries can scan 681K rows + N BFS round-trips.
  // Offload to the worker_thread so the main thread stays responsive.
  // Falls back to an error JSON if the worker is unavailable, matching the
  // contract for the original implementation (always returns a JSON string).
  try {
    const result = await getWorkerDbBridge().getDocumentGraph({ depth, centerPath, workspaceRoot: workspaceRoot ?? workspaceRoots?.[0] })
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

async function runFileClassify(
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
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
  const guard = assertInsideWorkspace(path, engine, context?.workspaceRoots)
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

function boundedText(content: string, offsetValue: unknown, maxCharsValue: unknown): {
  offset: number
  maxChars: number
  text: string
  truncated: boolean
  nextOffset: number | null
} {
  const offset = typeof offsetValue === 'number' && Number.isFinite(offsetValue)
    ? Math.max(0, Math.floor(offsetValue))
    : 0
  const maxChars = typeof maxCharsValue === 'number' && Number.isFinite(maxCharsValue)
    ? Math.max(1, Math.min(MAX_EXTRACT_CHARS, Math.floor(maxCharsValue)))
    : DEFAULT_EXTRACT_CHARS
  const text = content.slice(offset, offset + maxChars)
  const nextOffset = offset + text.length < content.length ? offset + text.length : null
  return {
    offset,
    maxChars,
    text,
    truncated: nextOffset !== null,
    nextOffset,
  }
}

async function extractTextFromPath(path: string): Promise<{ ok: true; text: string; kind: string } | { ok: false; error: string; kind: string }> {
  const ext = extname(path).toLowerCase()
  try {
    if (ext === '.docx') {
      const mammoth = await import('mammoth')
      const buffer = await readFile(path)
      const mammothMod = (mammoth as unknown as { default?: typeof import('mammoth') }).default || mammoth
      const result = await mammothMod.extractRawText({ buffer })
      return { ok: true, kind: 'docx', text: result.value || '' }
    }
    if (ext === '.xlsx' || ext === '.xls') {
      const xlsx = await import('xlsx')
      const buffer = await readFile(path)
      const xlsxMod = (xlsx as unknown as { default?: typeof import('xlsx') }).default || xlsx
      const workbook = xlsxMod.read(buffer, { type: 'buffer' })
      const parts: string[] = []
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName]
        const rows = xlsxMod.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][]
        parts.push(`# ${sheetName}`)
        for (const row of rows.slice(0, 200)) {
          parts.push(row.map((cell) => String(cell ?? '')).join('\t').trimEnd())
        }
      }
      return { ok: true, kind: 'spreadsheet', text: parts.join('\n') }
    }
    if (ext === '.pdf') {
      const previousDisableLogs = process.env.PDF2JSON_DISABLE_LOGS
      process.env.PDF2JSON_DISABLE_LOGS = '1'
      try {
        const { default: PDFParser } = await import('pdf2json')
        const buffer = await readFile(path)
        const text = await new Promise<string>((resolve, reject) => {
          const parser = new PDFParser(null, true)
          const timer = setTimeout(() => reject(new Error('PDF text extraction timed out')), 15_000)
          parser.on('pdfParser_dataError', (errData: Error | { parserError: Error }) => {
            clearTimeout(timer)
            reject(errData instanceof Error ? errData : errData.parserError)
          })
          parser.on('pdfParser_dataReady', () => {
            clearTimeout(timer)
            resolve(parser.getRawTextContent())
          })
          parser.parseBuffer(buffer)
        })
        return { ok: true, kind: 'pdf', text }
      } finally {
        if (previousDisableLogs === undefined) {
          delete process.env.PDF2JSON_DISABLE_LOGS
        } else {
          process.env.PDF2JSON_DISABLE_LOGS = previousDisableLogs
        }
      }
    }
    const text = await readFile(path, 'utf-8')
    return { ok: true, kind: ext ? ext.slice(1) : 'text', text }
  } catch (error) {
    // silent-catch: extraction failures are returned to the model as tool output.
    return { ok: false, kind: ext ? ext.slice(1) : 'unknown', error: error instanceof Error ? error.message : String(error) }
  }
}

async function runFileExtractText(
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
  const rawPath = typeof args.path === 'string' ? args.path : ''
  const resolved = await resolveReadableDocumentPath(rawPath, engine, context)
  if (!resolved.ok) return toJsonString(resolved.output)
  const extracted = await extractTextFromPath(resolved.readPath)
  if (!extracted.ok) return toJsonString({ ok: false, path: resolved.path, kind: extracted.kind, error: extracted.error })
  return toJsonString({
    ok: true,
    path: resolved.path,
    kind: extracted.kind,
    ...boundedText(extracted.text, args.offset, args.maxChars),
  })
}

async function collectInventory(
  dir: string,
  auth: Extract<AuthorizedRoot, { ok: true }>,
  recursive: boolean,
  maxDepth: number,
  depth = 0,
): Promise<Array<{ path: string; name: string; kind: 'file' | 'directory'; size: number | null; mtimeMs: number | null; depth: number }>> {
  const entries = await readdir(dir, { withFileTypes: true })
  const sorted = entries.sort((a, b) => a.name.localeCompare(b.name))
  const items: Array<{ path: string; name: string; kind: 'file' | 'directory'; size: number | null; mtimeMs: number | null; depth: number }> = []
  for (const entry of sorted) {
    const path = join(dir, entry.name)
    if (!isPathInsideRoot(path, auth.rootPath)) continue
    const stats = await stat(path).catch(() => null)
    const kind = entry.isDirectory() ? 'directory' : 'file'
    items.push({
      path,
      name: entry.name,
      kind,
      size: stats?.isFile() ? stats.size : null,
      mtimeMs: stats?.mtimeMs ?? null,
      depth,
    })
    if (recursive && entry.isDirectory() && depth + 1 < maxDepth) {
      const childReal = await realpath(path).catch(() => null)
      if (childReal && isPathInsideRoot(childReal, auth.rootRealPath)) {
        items.push(...await collectInventory(path, auth, recursive, maxDepth, depth + 1))
      }
    }
  }
  return items
}

async function runFileInventory(
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
  const auth = await authorizeRoot(typeof args.rootPath === 'string' ? args.rootPath : '', engine, context?.workspaceRoots)
  if (!auth.ok) return toJsonString(auth.output)
  const limit = typeof args.limit === 'number'
    ? Math.max(1, Math.min(MAX_INVENTORY_LIMIT, Math.floor(args.limit)))
    : DEFAULT_INVENTORY_LIMIT
  const cursor = typeof args.cursor === 'string' ? Math.max(0, Number.parseInt(args.cursor, 10) || 0) : 0
  const recursive = args.recursive === true
  const maxDepth = typeof args.maxDepth === 'number'
    ? Math.max(1, Math.min(MAX_INVENTORY_DEPTH, Math.floor(args.maxDepth)))
    : DEFAULT_INVENTORY_DEPTH
  const includeSummaries = args.includeSummaries === true
  try {
    const allItems = await collectInventory(auth.rootPath, auth, recursive, maxDepth)
    const page = allItems.slice(cursor, cursor + limit)
    const items: Array<Record<string, unknown>> = []
    for (const item of page) {
      let summary: string | null = null
      let summaryError: string | null = null
      if (includeSummaries && item.kind === 'file') {
        const extracted = await extractTextFromPath(item.path)
        if (extracted.ok) summary = extracted.text.slice(0, 600)
        else summaryError = extracted.error
      }
      items.push({ ...item, summary, summaryError })
    }
    return toJsonString({
      ok: true,
      rootPath: auth.rootPath,
      total: allItems.length,
      returned: items.length,
      nextCursor: cursor + items.length < allItems.length ? String(cursor + items.length) : null,
      items,
    })
  } catch (error) {
    // silent-catch: list failures are returned as structured tool errors.
    return toJsonString({ ok: false, rootPath: auth.rootPath, error: error instanceof Error ? error.message : String(error) })
  }
}

async function runFileCreateFolder(
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
  const auth = await authorizeRoot(typeof args.rootPath === 'string' ? args.rootPath : '', engine, context?.workspaceRoots)
  if (!auth.ok) return toJsonString(auth.output)
  const target = resolveRelativeFolderInsideRoot(typeof args.relativePath === 'string' ? args.relativePath : '', auth)
  if (!target.ok) return toJsonString({ ok: false, error: target.error })
  const parentReal = await realpath(dirname(target.path)).catch(() => null)
  if (parentReal && !isPathInsideRoot(parentReal, auth.rootRealPath)) {
    return toJsonString({ ok: false, error: 'folder parent escapes authorized root via symlink' })
  }
  try {
    await mkdir(target.path, { recursive: true })
    return toJsonString({ ok: true, path: target.path, relativePath: target.relativePath })
  } catch (error) {
    // silent-catch: folder creation failures are returned as structured tool errors.
    return toJsonString({ ok: false, path: target.path, error: error instanceof Error ? error.message : String(error) })
  }
}

function parseOrganizeOperations(value: unknown): OrganizeOperationInput[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      path: typeof item.path === 'string' ? item.path : '',
      destDir: typeof item.destDir === 'string' ? item.destDir : '',
      newName: typeof item.newName === 'string' ? item.newName : undefined,
    }))
}

async function validateOrganizePlan(
  rootPath: string,
  createFoldersInput: unknown,
  operationsInput: unknown,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<{ ok: true; plan: OrganizePlan } | { ok: false; output: Record<string, unknown> }> {
  const auth = await authorizeRoot(rootPath, engine, context?.workspaceRoots)
  if (!auth.ok) return { ok: false, output: auth.output }
  const conflicts: OrganizeConflict[] = []
  const createFolders = Array.isArray(createFoldersInput)
    ? createFoldersInput.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : []
  const folderTargets = new Map<string, string>()
  for (const relativeFolder of createFolders) {
    const target = resolveRelativeFolderInsideRoot(relativeFolder, auth)
    if (!target.ok) {
      conflicts.push({ kind: 'folder_invalid', message: target.error })
      continue
    }
    const existing = await stat(target.path).catch(() => null)
    if (existing && !existing.isDirectory()) {
      conflicts.push({ kind: 'folder_target_is_file', targetPath: target.path, message: 'folder target exists as a file' })
    }
    folderTargets.set(target.path, target.relativePath)
  }

  const operations: OrganizeOperation[] = []
  const targetPaths = new Set<string>()
  for (const op of parseOrganizeOperations(operationsInput)) {
    const source = await resolveExistingPathInsideRoot(op.path, auth)
    if (!source.ok) {
      conflicts.push({ kind: 'source_invalid', path: op.path, message: source.error })
      continue
    }
    const sourceStat = await stat(source.realPath).catch(() => null)
    if (!sourceStat?.isFile()) {
      conflicts.push({ kind: 'source_not_file', path: source.path, message: 'source must be a file' })
      continue
    }
    const dest = resolvePlannedPathInsideRoot(op.destDir, auth)
    if (!dest.ok) {
      conflicts.push({ kind: 'dest_invalid', path: op.destDir, message: dest.error })
      continue
    }
    const destStat = await stat(dest.path).catch(() => null)
    if (destStat && !destStat.isDirectory()) {
      conflicts.push({ kind: 'dest_not_directory', path: dest.path, message: 'destDir is not a directory' })
      continue
    }
    if (!destStat && !folderTargets.has(dest.path)) {
      conflicts.push({ kind: 'dest_missing', path: dest.path, message: 'destDir does not exist and is not listed in createFolders' })
      continue
    }
    const name = op.newName?.trim() || basename(source.path)
    if (!name || name.includes('/') || name.includes('\\')) {
      conflicts.push({ kind: 'new_name_invalid', path: source.path, message: 'newName must be a file name without path separators' })
      continue
    }
    const targetPath = join(dest.path, name)
    const target = resolvePlannedPathInsideRoot(targetPath, auth)
    if (!target.ok) {
      conflicts.push({ kind: 'target_invalid', path: source.path, targetPath, message: target.error })
      continue
    }
    if (target.path === source.path) {
      conflicts.push({ kind: 'noop', path: source.path, targetPath: target.path, message: 'source and target are the same path' })
      continue
    }
    if (targetPaths.has(target.path)) {
      conflicts.push({ kind: 'duplicate_target', path: source.path, targetPath: target.path, message: 'multiple operations target the same path' })
      continue
    }
    const existingTarget = await stat(target.path).catch(() => null)
    if (existingTarget) {
      conflicts.push({ kind: 'target_exists', path: source.path, targetPath: target.path, message: 'target already exists' })
      continue
    }
    targetPaths.add(target.path)
    operations.push({ path: source.path, destDir: dest.path, newName: op.newName, targetPath: target.path })
  }

  const now = new Date()
  return {
    ok: true,
    plan: {
      planId: `file-plan-${randomUUID()}`,
      rootPath: auth.rootPath,
      workspaceRoot: auth.workspaceRoot,
      createFolders,
      operations,
      conflicts,
      confirmed: false,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ORGANIZE_PLAN_TTL_MS).toISOString(),
    },
  }
}

async function runFileOrganizePreview(
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
  const rootPath = typeof args.rootPath === 'string' ? args.rootPath : ''
  const validated = await validateOrganizePlan(rootPath, args.createFolders, args.operations, engine, context)
  if (!validated.ok) return toJsonString(validated.output)
  const plan = validated.plan
  const storeDir = await getOrganizeStoreDir(context)
  await writeJsonFile(planPath(storeDir, plan.planId), plan)
  return toJsonString({
    ok: plan.conflicts.length === 0,
    planId: plan.planId,
    rootPath: plan.rootPath,
    operations: plan.operations,
    createFolders: plan.createFolders,
    conflicts: plan.conflicts,
    impact: {
      createFolderCount: plan.createFolders.length,
      moveCount: plan.operations.length,
    },
    confirmed: false,
    expiresAt: plan.expiresAt,
    requiresConfirmation: true,
  })
}

function deleteIndexedPath(engine: SearchEngine, workspaceRoot: string, path: string): void {
  try {
    const repo = engine.getRepository()
    const workspaceId = repo.ensureWorkspace(workspaceRoot)
    repo.deletePath(workspaceId, path)
  } catch {
    // silent-catch: best-effort index cleanup; the filesystem operation already succeeded.
  }
}

async function indexPathIfPossible(engine: SearchEngine, workspaceRoot: string, path: string): Promise<void> {
  try {
    await engine.indexDocument(workspaceRoot, path)
  } catch {
    // silent-catch: best-effort eager index sync; watcher/reindex can reconcile later.
  }
}

async function runFileOrganizeApply(
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
  const planId = typeof args.planId === 'string' ? args.planId : ''
  const confirmed = args.confirmed === true
  const confirmedVia = typeof args.confirmedVia === 'string' ? args.confirmedVia : ''
  if (!planId) return toJsonString({ ok: false, error: 'planId is required' })
  if (!confirmed || (confirmedVia !== 'ask_user_questions' && confirmedVia !== 'ui_action')) {
    return toJsonString({ ok: false, planId, error: 'file_organize_apply requires explicit user confirmation' })
  }
  const storeDir = await getOrganizeStoreDir(context)
  const plan = await readJsonFile<OrganizePlan & { appliedJournalId?: string }>(planPath(storeDir, planId))
  if (!plan) return toJsonString({ ok: false, planId, error: 'plan not found' })
  if (plan.appliedJournalId) return toJsonString({ ok: false, planId, error: 'plan already applied', journalId: plan.appliedJournalId })
  if (new Date(plan.expiresAt).getTime() < Date.now()) return toJsonString({ ok: false, planId, error: 'plan expired' })
  if (plan.conflicts.length > 0) return toJsonString({ ok: false, planId, error: 'plan has conflicts', conflicts: plan.conflicts })
  const auth = await authorizeRoot(plan.rootPath, engine, context?.workspaceRoots)
  if (!auth.ok) return toJsonString(auth.output)

  const journal: OrganizeJournal = {
    journalId: `file-journal-${randomUUID()}`,
    planId,
    rootPath: plan.rootPath,
    workspaceRoot: plan.workspaceRoot,
    executedAt: new Date().toISOString(),
    undoneAt: null,
    operations: [],
  }
  try {
    for (const relativeFolder of plan.createFolders) {
      const folder = resolveRelativeFolderInsideRoot(relativeFolder, auth)
      if (!folder.ok) throw new Error(folder.error)
      const existed = existsSync(folder.path)
      await mkdir(folder.path, { recursive: true })
      if (!existed) journal.operations.push({ type: 'mkdir', path: folder.path })
    }
    for (const op of plan.operations) {
      const source = await resolveExistingPathInsideRoot(op.path, auth)
      if (!source.ok) throw new Error(`source invalid: ${source.error}`)
      const target = resolvePlannedPathInsideRoot(op.targetPath, auth)
      if (!target.ok) throw new Error(`target invalid: ${target.error}`)
      if (existsSync(target.path)) throw new Error(`target already exists: ${target.path}`)
      await mkdir(dirname(target.path), { recursive: true })
      await rename(source.path, target.path)
      journal.operations.push({ type: 'move', sourcePath: source.path, targetPath: target.path })
      deleteIndexedPath(engine, plan.workspaceRoot, source.path)
      await indexPathIfPossible(engine, plan.workspaceRoot, target.path)
    }
    plan.confirmed = true
    plan.appliedJournalId = journal.journalId
    await writeJsonFile(planPath(storeDir, planId), plan)
    await writeJsonFile(journalPath(storeDir, journal.journalId), journal)
    return toJsonString({ ok: true, planId, journalId: journal.journalId, executed: journal.operations.length })
  } catch (error) {
    // silent-catch: partial apply failures are journaled and returned as structured tool output.
    await writeJsonFile(journalPath(storeDir, journal.journalId), journal)
    return toJsonString({
      ok: false,
      planId,
      journalId: journal.journalId,
      executed: journal.operations.length,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function runFileOrganizeUndo(
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
  const journalId = typeof args.journalId === 'string' ? args.journalId : ''
  if (!journalId) return toJsonString({ ok: false, error: 'journalId is required' })
  const storeDir = await getOrganizeStoreDir(context)
  const journal = await readJsonFile<OrganizeJournal>(journalPath(storeDir, journalId))
  if (!journal) return toJsonString({ ok: false, journalId, error: 'journal not found' })
  if (journal.undoneAt) return toJsonString({ ok: false, journalId, error: 'journal already undone', undoneAt: journal.undoneAt })
  const auth = await authorizeRoot(journal.rootPath, engine, context?.workspaceRoots)
  if (!auth.ok) return toJsonString(auth.output)
  const undone: string[] = []
  try {
    const reverseMoves = journal.operations
      .filter((op): op is JournalMove => op.type === 'move')
      .reverse()
    for (const op of reverseMoves) {
      const source = resolvePlannedPathInsideRoot(op.sourcePath, auth)
      const target = await resolveExistingPathInsideRoot(op.targetPath, auth)
      if (!source.ok) throw new Error(`source restore path invalid: ${source.error}`)
      if (!target.ok) throw new Error(`moved file missing: ${op.targetPath}`)
      if (existsSync(source.path)) throw new Error(`restore target already exists: ${source.path}`)
      await mkdir(dirname(source.path), { recursive: true })
      await rename(target.path, source.path)
      deleteIndexedPath(engine, journal.workspaceRoot, target.path)
      await indexPathIfPossible(engine, journal.workspaceRoot, source.path)
      undone.push(source.path)
    }
    journal.undoneAt = new Date().toISOString()
    await writeJsonFile(journalPath(storeDir, journalId), journal)
    return toJsonString({
      ok: true,
      journalId,
      restored: undone.length,
      restoredPaths: undone,
      note: 'created folders are left in place to avoid deleting user-created content',
    })
  } catch (error) {
    // silent-catch: rollback failures are returned with the best restored-path evidence available.
    return toJsonString({
      ok: false,
      journalId,
      restored: undone.length,
      restoredPaths: undone,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function runFileRename(
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
  const path = typeof args.path === 'string' ? args.path : ''
  const newName = typeof args.newName === 'string' ? args.newName.trim() : ''
  const overwrite = args.overwrite === true
  if (!path || !newName) return 'Error: path and newName required'
  if (newName.includes('/') || newName.includes('\\')) return 'Error: newName must not contain path separators'

  const guard = assertInsideWorkspace(path, engine, context?.workspaceRoots)
  if (!guard.ok) return `Error: ${guard.error}`
  const newPath = join(dirname(path), newName)
  const newGuard = assertInsideWorkspace(newPath, engine, context?.workspaceRoots)
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


async function runFileCopy(
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
  const path = typeof args.path === 'string' ? args.path : ''
  const destDir = typeof args.destDir === 'string' ? args.destDir : ''
  const newName = typeof args.newName === 'string' ? args.newName.trim() : ''
  const overwrite = args.overwrite === true
  if (!path || !destDir) return 'Error: path and destDir required'

  const srcGuard = assertInsideWorkspace(path, engine, context?.workspaceRoots)
  if (!srcGuard.ok) return `Error: ${srcGuard.error}`
  const destGuard = assertInsideWorkspace(destDir, engine, context?.workspaceRoots)
  if (!destGuard.ok) return `Error: ${destGuard.error}`
  if (srcGuard.root !== destGuard.root) return 'Error: cross-workspace copy not supported'

  const fileName = newName || path.split(/[\\/]/).pop() || 'file'
  if (!fileName || fileName.includes('/') || fileName.includes('\\')) return 'Error: newName must not contain path separators'
  const newPath = join(destDir, fileName)
  const newGuard = assertInsideWorkspace(newPath, engine, context?.workspaceRoots)
  if (!newGuard.ok) return `Error: ${newGuard.error}`

  try {
    const sourceStat = await stat(path)
    if (!sourceStat.isFile()) return 'Error: source is not a file'
    const destStat = await stat(destDir).catch(() => null)
    if (!destStat || !destStat.isDirectory()) return 'Error: destDir is not a directory'
    const targetLinkStats = await lstat(newPath).catch(() => null)
    if (targetLinkStats?.isSymbolicLink()) return toJsonString({ ok: false, error: 'refusing to overwrite symlink target' })
    await copyFile(path, newPath, overwrite ? 0 : constants.COPYFILE_EXCL)
    await engine.indexDocument(srcGuard.root, newPath)
    return toJsonString({ ok: true, newPath })
  } catch (error) {
    return toJsonString({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

async function runFileMove(
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
  const path = typeof args.path === 'string' ? args.path : ''
  const destDir = typeof args.destDir === 'string' ? args.destDir : ''
  const newName = typeof args.newName === 'string' ? args.newName.trim() : ''
  const overwrite = args.overwrite === true
  if (!path || !destDir) return 'Error: path and destDir required'

  const srcGuard = assertInsideWorkspace(path, engine, context?.workspaceRoots)
  if (!srcGuard.ok) return `Error: ${srcGuard.error}`
  const destGuard = assertInsideWorkspace(destDir, engine, context?.workspaceRoots)
  if (!destGuard.ok) return `Error: ${destGuard.error}`
  if (srcGuard.root !== destGuard.root) return 'Error: cross-workspace move not supported'

  const fileName = newName || path.split(/[\\/]/).pop() || 'file'
  const newPath = join(destDir, fileName)
  const newGuard = assertInsideWorkspace(newPath, engine, context?.workspaceRoots)
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
