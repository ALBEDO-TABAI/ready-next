import { existsSync, realpathSync } from 'fs'
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'path'

import type { SearchEngine } from '../search-engine/indexer'
import { validateWorkspaceRoot } from '../../../shared/workspace-validation'

export type FrozenDirectoryAlias = {
  logicalResourceId: string
  name: string
  path: string
}

export type FrozenFileAlias = FrozenDirectoryAlias & {
  currentDigest: string
}

export type FrozenResourceRef =
  | { kind: 'directory'; alias: FrozenDirectoryAlias }
  | { kind: 'file'; alias: FrozenFileAlias }
  | { kind: 'ambiguous' }

export type FrozenDirectoryRef =
  | { kind: 'resolved'; path: string }
  | { kind: 'unmatched'; path: string }
  | { kind: 'ambiguous' }

export interface FileManagementToolContext {
  searchEngine?: SearchEngine | null
  abortSignal?: AbortSignal
  organizeStoreDir?: string | null
  workspaceRoots?: string[] | null
  directoryAliases?: FrozenDirectoryAlias[] | null
  explicitReadablePaths?: string[] | null
  explicitReadableResources?: FrozenFileAlias[] | null
  runId?: string | null
  sessionId?: string | null
  scopeId?: string | null
  requestModuleToolAction?: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

export type AuthorizedRoot =
  | { ok: true; rootPath: string; rootRealPath: string; workspaceRoot: string }
  | { ok: false; output: Record<string, unknown> }

export type FileInventoryItem = {
  path: string
  name: string
  kind: 'file' | 'directory'
  size: number | null
  mtimeMs: number | null
  depth: number
  errorKind?: string
}

export function resolveFrozenDirectoryRef(
  rawPath: string,
  aliases: readonly FrozenDirectoryAlias[] | null | undefined,
): FrozenDirectoryRef {
  const raw = String(rawPath || '').trim()
  if (!raw || !aliases?.length) return { kind: 'unmatched', path: raw }
  if (isAbsolute(raw) && existsSync(raw)) return { kind: 'resolved', path: raw }
  const normalized = raw.replace(/^\/+/, '')
  const mention = normalized.match(/^@\[([^\]]+)\](?:\/(.*))?$/)
    || normalized.match(/^@([^/]+)(?:\/(.*))?$/)
  const logicalMatches = aliases.filter((alias) => {
    const logicalId = alias.logicalResourceId.trim()
    const root = alias.path.trim()
    return Boolean(logicalId && root && (normalized === logicalId || normalized.startsWith(`${logicalId}/`)))
  })
  if (logicalMatches.length === 1) {
    const alias = logicalMatches[0]
    const suffix = normalized.slice(alias.logicalResourceId.trim().length).replace(/^\//, '')
    return { kind: 'resolved', path: suffix ? join(alias.path, suffix) : alias.path }
  }
  if (logicalMatches.length > 1) return { kind: 'ambiguous' }
  const namedMatches = aliases.filter((alias) => {
    const logicalId = alias.logicalResourceId.trim()
    const name = alias.name.trim()
    const root = alias.path.trim()
    if (!logicalId || !name || !root) return false
    if (mention) return mention[1] === name || mention[1] === logicalId
    return normalized === name || normalized.startsWith(`${name}/`)
  })
  if (namedMatches.length > 1) return { kind: 'ambiguous' }
  if (namedMatches.length === 0) return { kind: 'unmatched', path: raw }
  const alias = namedMatches[0]
  const suffix = mention
    ? mention[2]
    : normalized.slice(alias.name.trim().length).replace(/^\//, '')
  return { kind: 'resolved', path: suffix ? join(alias.path, suffix) : alias.path }
}

export function resolveFrozenResourceRef(
  rawPath: string,
  directoryAliases: readonly FrozenDirectoryAlias[] | null | undefined,
  fileAliases: readonly FrozenFileAlias[] | null | undefined,
): FrozenResourceRef | null {
  const raw = String(rawPath || '').trim()
  if (!raw) return null
  const normalized = raw.replace(/^\/+/, '')
  let canonicalRaw: string | null = null
  if (isAbsolute(raw) && existsSync(raw)) {
    try {
      canonicalRaw = realpathSync(raw)
    } catch {
      // silent-catch: a path that vanishes or cannot be canonicalized after existsSync falls back to raw-path matching
      canonicalRaw = null
    }
  }
  const resources: Array<{ kind: 'directory'; alias: FrozenDirectoryAlias } | { kind: 'file'; alias: FrozenFileAlias }> = [
    ...(directoryAliases ?? []).map((alias) => ({ kind: 'directory' as const, alias })),
    ...(fileAliases ?? []).map((alias) => ({ kind: 'file' as const, alias })),
  ]
  const exactMatches = resources.filter(({ alias }) => {
    const logicalId = alias.logicalResourceId.trim()
    const path = alias.path.trim()
    return Boolean(logicalId && path && (
      raw === path || canonicalRaw === path || raw === logicalId || normalized === logicalId
    ))
  })
  if (exactMatches.length === 1) return exactMatches[0]
  if (exactMatches.length > 1) return { kind: 'ambiguous' }
  const mention = normalized.match(/^@\[([^\]]+)\]$/) || normalized.match(/^@(.+)$/)
  const name = mention?.[1] ?? normalized
  const namedMatches = resources.filter(({ alias }) => alias.name.trim() === name)
  if (namedMatches.length === 1) return namedMatches[0]
  if (namedMatches.length > 1) return { kind: 'ambiguous' }
  return null
}

export function resolveFrozenFileRef(
  rawPath: string,
  aliases: readonly FrozenFileAlias[] | null | undefined,
): FrozenFileAlias | null {
  const resolved = resolveFrozenResourceRef(rawPath, null, aliases)
  return resolved?.kind === 'file' ? resolved.alias : null
}

export function normalizeExplicitWorkspaceRoots(roots: string[] | null | undefined): string[] | null {
  if (!Array.isArray(roots)) return null
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const rawRoot of roots) {
    const root = typeof rawRoot === 'string' ? resolvePath(rawRoot.trim()) : ''
    const canonical = root ? canonicalBoundaryPath(root) : null
    if (!canonical || !validateWorkspaceRoot(canonical).ok || seen.has(canonical)) continue
    seen.add(canonical)
    normalized.push(root)
  }
  return normalized
}

function canonicalBoundaryPath(rawPath: string): string | null {
  let cursor = resolvePath(rawPath)
  const missingSegments: string[] = []
  while (!existsSync(cursor)) {
    const parent = dirname(cursor)
    if (parent === cursor) return null
    missingSegments.unshift(basename(cursor))
    cursor = parent
  }
  try {
    return resolvePath(realpathSync(cursor), ...missingSegments)
  } catch {
    return null
  }
}

export function assertInsideWorkspace(
  target: string,
  engine: SearchEngine,
  explicitRoots?: string[] | null,
): { ok: true; root: string } | { ok: false; error: string } {
  if (!isAbsolute(target)) return { ok: false, error: 'path must be absolute' }
  const resolved = resolvePath(target)
  const canonicalTarget = canonicalBoundaryPath(resolved)
  if (!canonicalTarget) return { ok: false, error: `path cannot be resolved safely: ${resolved}` }
  const scopedRoots = normalizeExplicitWorkspaceRoots(explicitRoots)
  const containsCanonicalTarget = (candidate: string | null): candidate is string => {
    if (!candidate) return false
    const canonicalRoot = canonicalBoundaryPath(candidate)
    return Boolean(canonicalRoot && isPathInsideRoot(canonicalTarget, canonicalRoot))
  }
  const root = scopedRoots
    ? scopedRoots.find(containsCanonicalTarget)
    : [engine.findWorkspaceRootForPath(resolved), engine.findWorkspaceRootForPath(canonicalTarget)]
        .find(containsCanonicalTarget)
  if (!root) return { ok: false, error: `path is outside any known workspace: ${resolved}` }
  return { ok: true, root }
}

export function isPathInsideRoot(target: string, root: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export async function authorizeRoot(
  rawRootPath: string,
  engine: SearchEngine,
  explicitRoots?: string[] | null,
  directoryAliases?: readonly FrozenDirectoryAlias[] | null,
): Promise<AuthorizedRoot> {
  const directoryRef = resolveFrozenDirectoryRef(String(rawRootPath || '').trim(), directoryAliases)
  if (directoryRef.kind === 'ambiguous') {
    return { ok: false, output: { ok: false, errorKind: 'selected_resource_ambiguous' } }
  }
  const raw = directoryRef.path
  if (!raw) return { ok: false, output: { ok: false, error: 'rootPath is required' } }
  if (!isAbsolute(raw)) return { ok: false, output: { ok: false, error: 'rootPath must be absolute' } }
  const rootPath = resolvePath(raw)
  try {
    const rootStat = await stat(rootPath)
    if (!rootStat.isDirectory()) return { ok: false, output: { ok: false, error: 'rootPath must be a directory', rootPath } }
    const rootRealPath = await realpath(rootPath)
    if (!validateWorkspaceRoot(rootRealPath).ok) {
      return { ok: false, output: { ok: false, error: 'rootPath resolves to a forbidden broad root', rootPath } }
    }
    const guard = assertInsideWorkspace(rootRealPath, engine, explicitRoots)
    if (!guard.ok) return { ok: false, output: { ok: false, error: guard.error } }
    const workspaceRealPath = await realpath(guard.root)
    if (!isPathInsideRoot(rootRealPath, workspaceRealPath)) {
      return { ok: false, output: { ok: false, error: 'rootPath escapes workspace via symlink', rootPath } }
    }
    return { ok: true, rootPath, rootRealPath, workspaceRoot: guard.root }
  } catch (error) {
    // silent-catch: root authorization failures are returned as structured tool errors.
    return { ok: false, output: { ok: false, rootPath, error: error instanceof Error ? error.message : String(error) } }
  }
}

export async function resolveExistingPathInsideRoot(
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

export function resolvePlannedPathInsideRoot(
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

export function resolveRelativeFolderInsideRoot(
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

export async function getFileManagementStoreDir(context?: FileManagementToolContext): Promise<string> {
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

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8', flag: 'wx' })
    await rename(tmp, path)
  } catch (error) {
    await unlink(tmp).catch(() => undefined)
    throw error
  }
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T
  } catch {
    return null
  }
}

export function toJsonString(value: unknown): string {
  try { return JSON.stringify(value) } catch { return String(value) }
}

export async function collectFileInventory(
  dir: string,
  auth: Extract<AuthorizedRoot, { ok: true }>,
  recursive: boolean,
  maxDepth: number,
  depth = 0,
): Promise<FileInventoryItem[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const sorted = entries.sort((a, b) => a.name.localeCompare(b.name))
  const items: FileInventoryItem[] = []
  for (const entry of sorted) {
    const path = join(dir, entry.name)
    if (!isPathInsideRoot(path, auth.rootPath)) continue
    if (entry.isSymbolicLink()) {
      items.push({ path, name: entry.name, kind: 'file', size: null, mtimeMs: null, depth, errorKind: 'symlink_not_supported' })
      continue
    }
    const resolved = await resolveExistingPathInsideRoot(path, auth)
    if (!resolved.ok) {
      items.push({ path, name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file', size: null, mtimeMs: null, depth, errorKind: 'workspace_boundary_rejected' })
      continue
    }
    const stats = await lstat(path).catch(() => null)
    if (!stats || stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) continue
    const kind = stats.isDirectory() ? 'directory' : 'file'
    items.push({
      path,
      name: entry.name,
      kind,
      size: stats.isFile() ? stats.size : null,
      mtimeMs: stats.mtimeMs,
      depth,
    })
    if (recursive && kind === 'directory' && depth + 1 < maxDepth) {
      items.push(...await collectFileInventory(path, auth, recursive, maxDepth, depth + 1))
    }
  }
  return items
}
