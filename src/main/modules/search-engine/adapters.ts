import { rebuildCalendarLinks } from './calendar-link-adapter'
import { canonicalObjectPath } from '../object-service/registry'
import { ReadyRefSchema, toReadyUri } from '../../../shared/ready-ref'
import { calendarEventToRecord, originalToSeconds } from '../calendar-engine/calendar-row-codec'
import { CalendarStore } from '../database/calendar-store'
import { readFile, readdir, stat, open } from 'fs/promises'
import { createHash } from 'crypto'
import { basename, extname, join } from 'path'
import { BINARY_EXTENSIONS } from '../document-engine/binary-extensions'
import { createRotatingLogger } from '../../utils/rotating-logger'
import { parseDocumentGraph } from '../../../shared/document-graph-parse'
import { FS_SOURCE_TYPE } from '../../../shared/search-source-types'
import type { IndexedPathMetadata, SearchRepository } from './repository'
import { SEARCH_INDEX_CONTENT_VERSION } from './query'

const searchLogger = createRotatingLogger('ready-search.log')

function logSearch(message: string): void {
  try {
    searchLogger.append(`[${new Date().toISOString()}] ${message}\n`)
  } catch {
    /* best-effort */
  }
}

export interface AdapterReindexResult {
  indexed: number
  skipped: number
  removed: number
  scanned: number
}

export interface IndexSourceAdapter {
  readonly sourceType: string
  readonly workspaceScope: 'per-root' | 'shared'
  reindex(ctx: AdapterContext): Promise<AdapterReindexResult>
}

export interface AdapterContext {
  workspaceId: number
  workspaceRoot: string
  repository: SearchRepository
  signal?: AbortSignal
}

interface IndexFileStat {
  size: number
  mtimeMs: number
  isFile(): boolean
}

// Hardened 2026-04-25 (perf-rescue B5): bumped from 2MB → 5MB so legitimate
// large markdown/SQL dumps fit. Anything beyond is skipped + logged.
const MAX_FILE_BYTES = 5 * 1024 * 1024

// perf-rescue B6: streaming reindex.
//   - BATCH_SIZE 500 → 50: keeps the per-batch transaction tight so a slow
//     workspace doesn't pin the worker on a single sync write for seconds.
//   - BATCH_CONCURRENCY 4: bounded loadFile parallelism per batch (was
//     Promise.all of the whole 500-file batch — could spawn hundreds of
//     concurrent reads + binary sniffs on a cold cache).
//   - After each (loadFile + insert) we yield via setImmediate so the worker
//     event loop can service abort/cancel posts mid-batch.
const BATCH_SIZE = 50
const BATCH_CONCURRENCY = 4
const METADATA_CONCURRENCY = 24

/** Cancellation marker. Distinguished by `name === 'AbortError'`. */
export class AbortError extends Error {
  readonly name = 'AbortError'
  constructor(message = 'reindex aborted') {
    super(message)
  }
}

/**
 * Bounded-concurrency map. Equivalent to `Promise.all(items.map(fn))` but
 * with at most `concurrency` in-flight at a time. Preserves input order in
 * the resulting array. Used so a 50-file batch sniffs/reads at most 4 files
 * concurrently instead of all 50 at once.
 */
async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers: Array<Promise<void>> = []
  const limit = Math.min(Math.max(1, concurrency), items.length)
  for (let w = 0; w < limit; w += 1) {
    workers.push((async () => {
      while (true) {
        const idx = cursor
        cursor += 1
        if (idx >= items.length) return
        results[idx] = await fn(items[idx], idx)
      }
    })())
  }
  await Promise.all(workers)
  return results
}

// Directories never worth indexing — package manager output, build artifacts,
// virtual envs, IDE caches. Cheaper to filter at walk-time than per-file.
// Exported so the chokidar file-watcher (B7) can apply the same blocklist as
// the indexer's directory walker — keeps a single source of truth.
export const IGNORED_DIR_NAMES: ReadonlySet<string> = new Set<string>([
  // VCS / metadata
  '.DS_Store', '.git', '.hg', '.svn',
  // Vault machine data (anchors, comments) owned by Ready services
  '.ready',
  // Package managers / vendored deps
  'node_modules', 'vendor',
  // Python tooling
  '__pycache__', '.pytest_cache', '.tox', '.venv', 'venv',
  // JS framework build / cache dirs
  '.cache', '.next', '.nuxt', '.parcel-cache', '.svelte-kit', '.turbo',
  // Build / dist outputs (JVM, Rust, JS)
  'build', 'dist', 'out', 'target',
  // JVM build tools
  '.gradle', '.mvn',
  // Coverage reports
  'coverage',
])

// Path segments that, if present anywhere in a file's path, should disqualify
// it. Separate from IGNORED_DIR_NAMES because we also defend at loadFile time
// (in case a path arrives via syncOne / external override that bypassed the
// directory walker).
const BLOCKED_PATH_SEGMENTS: ReadonlySet<string> = new Set<string>([
  '.cache', '.git', '.next', '.nuxt', '.parcel-cache', '.svelte-kit',
  '.turbo', '.venv', '__pycache__', 'build', 'coverage', 'dist',
  'node_modules', 'out', 'target', 'vendor', 'venv',
])

/** macOS bundle directory test (e.g. `Foo.app`, `Quartz.framework`). */
function isMacBundleDirectory(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.app') || lower.endsWith('.framework')
}

/** True if any path segment matches a blocked name (cross-platform separator). */
function hasBlockedPathSegment(filePath: string): boolean {
  const normalized = filePath.split(/[\\/]/g)
  for (const segment of normalized) {
    if (!segment) continue
    if (BLOCKED_PATH_SEGMENTS.has(segment)) return true
    if (isMacBundleDirectory(segment)) return true
  }
  return false
}

/**
 * Heuristic binary sniff for files with missing or unknown extensions. Reads
 * the first 256 bytes and rejects:
 *   - any buffer containing a NUL byte (textbook binary marker)
 *   - any buffer where >30% of bytes are control chars (excluding 9/10/13)
 *
 * Buffers that look like valid printable text (incl. UTF-8 multibyte) pass.
 * Empty buffers are accepted (zero-byte files are harmless to index).
 */
export function isLikelyTextContent(buf: Buffer): boolean {
  if (buf.length === 0) return true
  let controlChars = 0
  for (let i = 0; i < buf.length; i += 1) {
    const byte = buf[i]
    if (byte === 0x00) return false
    // Tab (9), LF (10), CR (13) are legitimate; other <32 are control chars.
    // 0x7F (DEL) also counts as control.
    const isControl = (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 0x7f
    if (isControl) controlChars += 1
  }
  return controlChars / buf.length <= 0.3
}

/** Read up to `cap` bytes from the head of `filePath` without slurping. */
async function readHeadBytes(filePath: string, cap: number): Promise<Buffer> {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(cap)
    const { bytesRead } = await handle.read(buffer, 0, cap, 0)
    return bytesRead === cap ? buffer : buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * Single-source-of-truth filter decision for one file path. Cheap-first order:
 *   1. blocked path segment (no IO)
 *   2. binary extension (no IO)
 *   3. size cap (one stat)
 *   4. binary sniff for ext-less / unknown-ext files (one 256-byte read)
 *
 * Returns the parsed file metadata on accept, `null` on reject.
 */
export type FileFilterDecision =
  | { accept: true }
  | { accept: false; reason: 'blocked_segment' | 'binary_ext' | 'oversized' | 'binary_sniff' | 'not_a_file' | 'stat_failed' }

export async function decideFileForIndex(
  filePath: string,
  fileStat: { size: number; isFile(): boolean } | null,
): Promise<FileFilterDecision> {
  if (hasBlockedPathSegment(filePath)) return { accept: false, reason: 'blocked_segment' }
  const ext = extname(filePath).toLowerCase()
  if (ext && BINARY_EXTENSIONS.has(ext)) return { accept: false, reason: 'binary_ext' }
  if (fileStat) {
    if (!fileStat.isFile()) return { accept: false, reason: 'not_a_file' }
    if (fileStat.size > MAX_FILE_BYTES) return { accept: false, reason: 'oversized' }
  }
  // Sniff bytes for files lacking a known text extension. We treat any ext
  // not in BINARY_EXTENSIONS as "unknown" — even an explicit '.md' is known
  // text and skips the read. This catches the common ext-less binary case
  // (config dumps, lock files, opaque blobs) without paying I/O for the
  // 99% of legitimate text files that have a real extension.
  if (!ext) {
    try {
      const head = await readHeadBytes(filePath, 256)
      if (!isLikelyTextContent(head)) return { accept: false, reason: 'binary_sniff' }
    } catch {
      return { accept: false, reason: 'stat_failed' }
    }
  }
  return { accept: true }
}

/** Canonical filesystem adapter — the original single-source reindex behavior.
 *
 * `sourceType` is exported as the shared `FS_SOURCE_TYPE` constant so the
 * renderer's reindex reducer can read `perSource[FS_SOURCE_TYPE]?.error`
 * without hardcoding the string in two places. */
export class FileSystemAdapter implements IndexSourceAdapter {
  readonly sourceType = FS_SOURCE_TYPE
  readonly workspaceScope = 'per-root'

  async reindex(ctx: AdapterContext): Promise<AdapterReindexResult> {
    const result: AdapterReindexResult = { indexed: 0, skipped: 0, removed: 0, scanned: 0 }
    // Early-exit when the caller passes an already-aborted signal — don't
    // even stat the root. Throws so the caller's catch handler can route to
    // the partial-result branch.
    if (ctx.signal?.aborted) throw new AbortError()

    try {
      const rootStat = await stat(ctx.workspaceRoot)
      if (!rootStat.isDirectory()) throw new Error(`root is not a directory: ${ctx.workspaceRoot}`)
    } catch (error) {
      if (error instanceof AbortError) throw error
      logSearch(`FileSystemAdapter: root invalid ${ctx.workspaceRoot} ${error instanceof Error ? error.message : String(error)}`)
      return result
    }

    const existingPaths = new Map<string, IndexedPathMetadata>()
    for (const row of ctx.repository.listPathsForWorkspace(ctx.workspaceId, this.sourceType)) {
      existingPaths.set(row.path, row)
    }

    const filePaths = (await this.collectCandidatePaths(ctx.workspaceRoot)).map(canonicalObjectPath)
    result.scanned = filePaths.length

    for (let offset = 0; offset < filePaths.length; offset += BATCH_SIZE) {
      // Signal-check at batch boundary. Earlier batches already committed
      // remain in the DB — partial index is a feature, not a bug, since the
      // caller can resume by re-running reindex.
      if (ctx.signal?.aborted) throw new AbortError()
      const batch = filePaths.slice(offset, offset + BATCH_SIZE)

      // Bounded-parallel load (4 concurrent reads/sniffs) instead of a
      // 50-wide Promise.all. Yields to the event loop after each individual
      // file so the worker can process incoming abort/cancel posts mid-batch.

      // Metadata checks are cheap and do not read file bodies, so they can run
      // wider than content parsing. This keeps a no-change rebuild from being
      // serialized behind the conservative four-reader content limit.
      const candidates = await mapBounded(batch, METADATA_CONCURRENCY, async (p) => ({
        path: p,
        fileStat: await stat(p).catch(() => null),
      }))
      const changedCandidates: Array<{ path: string; fileStat: IndexFileStat | null }> = []
      for (const candidate of candidates) {
        const existing = existingPaths.get(candidate.path)
        if (isUnchangedIndexedMetadata(existing, candidate.fileStat)) {
          result.skipped += 1
          existingPaths.delete(candidate.path)
        } else {
          changedCandidates.push(candidate)
        }
      }

      const parsedBatch = await mapBounded(changedCandidates, BATCH_CONCURRENCY, async (candidate) => {
        const parsed = await this.loadFile(candidate.path, undefined, candidate.fileStat)
        // Per-file yield. setImmediate runs on the macrotask queue, giving
        // any pending message handler (cancel posts) a chance to set the
        // abort flag before we read the next changed file.
        await new Promise<void>((resolve) => setImmediate(resolve))
        return parsed
      })

      // Re-check signal before opening the write transaction — a cancel
      // arriving during loadFile shouldn't blow another sync write.
      if (ctx.signal?.aborted) throw new AbortError()

      const filesToUpsert: LoadedFile[] = []
      for (const parsed of parsedBatch) {
        if (!parsed) continue
        filesToUpsert.push(parsed)
      }

      if (filesToUpsert.length > 0) {
        ctx.repository.transaction(() => {
          for (const parsed of filesToUpsert) {
            const upsert = ctx.repository.upsertDocument({
              workspaceId: ctx.workspaceId,
              path: parsed.path,
              name: parsed.name,
              ext: parsed.ext,
              size: parsed.size,
              mtime: parsed.mtime,
              contentHash: parsed.contentHash,
              frontmatterJson: parsed.frontmatterJson,
              body: parsed.body,
              sourceType: this.sourceType,
            })
            if (upsert.skipped) {
              result.skipped += 1
            } else {
              ctx.repository.replaceTags(upsert.documentId, parsed.tags)
              ctx.repository.replaceLinks(upsert.documentId, parsed.raw)
              ctx.repository.replaceAttachments(upsert.documentId, parsed.attachments)
              result.indexed += 1
            }
            existingPaths.delete(parsed.path)
          }
        })
      }

      // Inter-batch yield. Combined with the per-file yield above, this is
      // belt-and-suspenders for cancel responsiveness on huge workspaces.

      await new Promise<void>((resolve) => setImmediate(resolve))
    }

    if (existingPaths.size > 0) {
      // Even orphan-cleanup deserves a signal check — if the caller cancelled
      // we don't want to spend N round-trips deleting rows.
      if (ctx.signal?.aborted) throw new AbortError()
      ctx.repository.transaction(() => {
        for (const path of existingPaths.keys()) {
          ctx.repository.deletePath(ctx.workspaceId, path)
          result.removed += 1
        }
      })
    }

    if (result.indexed > 0 || result.removed > 0) {
      ctx.repository.transaction(() => {
        ctx.repository.resolveWikilinkTargets(ctx.workspaceId)
      })
    }

    return result
  }

  async loadOne(
    filePath: string,
    rawOverride?: string,
  ): Promise<LoadedFile | null> {
    const fileStat = await stat(filePath).catch(() => null)
    return this.loadFile(filePath, rawOverride, fileStat)
  }

  private async collectCandidatePaths(root: string): Promise<string[]> {
    const results: string[] = []
    const stack: string[] = [root]
    while (stack.length > 0) {
      const current = stack.pop()!
      let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> = []
      try {

        entries = await readdir(current, { withFileTypes: true })
      } catch { continue }
      for (const entry of entries) {
        const fullPath = join(current, entry.name)
        if (entry.isDirectory()) {
          // Cheapest filter first: well-known build/cache/vcs directories.
          if (IGNORED_DIR_NAMES.has(entry.name)) continue
          // macOS bundles (.app, .framework) are directories that contain a
          // sea of opaque resources — treat the whole tree as binary.
          if (isMacBundleDirectory(entry.name)) continue
          stack.push(fullPath)
          continue
        }
        if (!entry.isFile()) continue
        // Per-file cheap filters (no IO beyond what the parent readdir gave us).
        // Heavy filters (binary sniff) happen lazily in loadFile.
        const ext = extname(entry.name).toLowerCase()
        if (ext && BINARY_EXTENSIONS.has(ext)) continue
        results.push(fullPath)
      }
    }
    return results
  }

  private async loadFile(
    filePath: string,
    rawOverride: string | undefined,
    fileStat: IndexFileStat | null,
  ): Promise<LoadedFile | null> {
    try {
      const ext = extname(filePath).toLowerCase()
      // When we have an override (e.g. live in-memory edit being re-indexed)
      // skip the on-disk binary sniff — caller already has the bytes — but
      // still enforce extension + path-segment blocks.
      const decision = rawOverride !== undefined
        ? decideOverrideOnly(filePath)
        : await decideFileForIndex(filePath, fileStat)
      if (!decision.accept) {
        if (decision.reason === 'oversized' && fileStat) {
          logSearch(`skip oversized path=${filePath} size=${fileStat.size}`)
        } else if (decision.reason === 'binary_sniff') {
          logSearch(`skip binary-sniffed path=${filePath}`)
        } else if (decision.reason === 'blocked_segment') {
          logSearch(`skip blocked-segment path=${filePath}`)
        }
        return null
      }
      let size = 0
      let mtime = 0
      if (fileStat) {
        size = fileStat.size
        mtime = Math.floor(fileStat.mtimeMs)
      }
      const raw = rawOverride ?? (await readFile(filePath, 'utf-8'))
      if (!fileStat) {
        size = Buffer.byteLength(raw, 'utf-8')
        mtime = Math.floor(Date.now())
      }
      const contentHash = buildSearchIndexContentHash(raw)
      const graph = parseDocumentGraph(raw)
      const frontmatterJson = graph.frontmatter ? JSON.stringify(graph.frontmatter) : null
      return {
        raw,
        path: filePath,
        name: basename(filePath),
        ext,
        size,
        mtime,
        contentHash,
        frontmatterJson,
        body: graph.body,
        tags: graph.tags,
        wikilinks: graph.wikilinks,
        mdlinks: graph.mdlinks,
        attachments: graph.attachments,
      }
    } catch (error) {
      logSearch(`loadFile failed path=${filePath} error=${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }
}

/**
 * Synchronous slice of decideFileForIndex used when the caller already has
 * the file body in memory (e.g. live commit re-index). Skips IO and the
 * size cap (caller is responsible — the body is bounded by editor limits).
 */
function decideOverrideOnly(filePath: string): FileFilterDecision {
  if (hasBlockedPathSegment(filePath)) return { accept: false, reason: 'blocked_segment' }
  const ext = extname(filePath).toLowerCase()
  if (ext && BINARY_EXTENSIONS.has(ext)) return { accept: false, reason: 'binary_ext' }
  return { accept: true }
}

export interface LoadedFile {
  raw: string
  path: string
  name: string
  ext: string
  size: number
  mtime: number
  contentHash: string
  frontmatterJson: string | null
  body: string
  tags: ReturnType<typeof parseDocumentGraph>['tags']
  wikilinks: ReturnType<typeof parseDocumentGraph>['wikilinks']
  mdlinks: ReturnType<typeof parseDocumentGraph>['mdlinks']
  attachments: ReturnType<typeof parseDocumentGraph>['attachments']
}

function isUnchangedIndexedMetadata(
  existing: IndexedPathMetadata | undefined,
  fileStat: IndexFileStat | null,
): existing is IndexedPathMetadata {
  return Boolean(
    existing
      && fileStat?.isFile()
      && existing.size === fileStat.size
      && existing.mtime === Math.floor(fileStat.mtimeMs)
      && existing.contentHash?.startsWith(`${SEARCH_INDEX_CONTENT_VERSION}:`),
  )
}

// ---------------------------------------------------------------------------
// Shared-scope adapters below. Each reads a single SQLite table (owned by its
// domain module) and mirrors rows into `documents` with source_type set. The
// adapters deliberately stay read-only against their source tables; writes are
// still performed by the domain modules (rss-engine, calendar-engine, …) which
// emit events or we simply re-scan on next reindex.
// ---------------------------------------------------------------------------

function stripHtml(html: string | null | undefined): string {
  if (!html) return ''
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

export function buildSearchIndexContentHash(body: string): string {
  const digest = createHash('sha256')
    .update(SEARCH_INDEX_CONTENT_VERSION)
    .update('\0')
    .update(body)
    .digest('hex')
    .slice(0, 16)
  return `${SEARCH_INDEX_CONTENT_VERSION}:${digest}`
}

function syncShared(
  adapter: IndexSourceAdapter,
  ctx: AdapterContext,
  rows: Array<{
    path: string
    sourceId: string
    name: string
    body: string
    meta: Record<string, unknown>
    mtime: number
  }>,
): AdapterReindexResult {
  const result: AdapterReindexResult = { indexed: 0, skipped: 0, removed: 0, scanned: rows.length }
  const existingPaths = new Map<string, number>()
  for (const row of ctx.repository.listPathsForWorkspace(ctx.workspaceId, adapter.sourceType)) {
    existingPaths.set(row.path, row.id)
  }

  ctx.repository.transaction(() => {
    for (const row of rows) {
      const contentHash = buildSearchIndexContentHash(`${row.name}\n${row.body}`)
      const upsert = ctx.repository.upsertDocument({
        workspaceId: ctx.workspaceId,
        path: row.path,
        name: row.name,
        ext: null,
        size: Buffer.byteLength(row.body, 'utf-8'),
        mtime: row.mtime,
        contentHash,
        frontmatterJson: null,
        body: row.body,
        sourceType: adapter.sourceType,
        sourceId: row.sourceId,
        sourceMetaJson: JSON.stringify(row.meta),
      })
      if (upsert.skipped) result.skipped += 1
      else result.indexed += 1
      if (!upsert.skipped) {
        ctx.repository.replaceTags(upsert.documentId, [])
        ctx.repository.replaceLinks(upsert.documentId, row.body)
        ctx.repository.replaceAttachments(upsert.documentId, [])
      }
      existingPaths.delete(row.path)
    }
    for (const path of existingPaths.keys()) {
      ctx.repository.deletePath(ctx.workspaceId, path)
      result.removed += 1
    }
  })

  return result
}

export class BookmarkAdapter implements IndexSourceAdapter {
  readonly sourceType = 'bookmark'
  readonly workspaceScope = 'shared'

  async reindex(ctx: AdapterContext): Promise<AdapterReindexResult> {
    const db = ctx.repository.getConnection()
    const bookmarks = db
      .prepare('SELECT id, url, title, favicon, created_at FROM browser_bookmarks')
      .all<{ id: string; url: string; title: string; favicon: string | null; created_at: number | null }>()
    const rows = bookmarks.filter(b => ReadyRefSchema.safeParse({ kind: 'web', url: b.url }).success).map((b) => ({
      path: toReadyUri({ kind: 'web', url: b.url }),
      sourceId: b.id,
      name: b.title || b.url,
      body: [b.title || '', b.url].filter(Boolean).join(' '),
      meta: { url: b.url, favicon: b.favicon, createdAt: b.created_at },
      mtime: b.created_at ?? 0,
    }))
    const result = syncShared(this, ctx, rows)
    result.scanned = bookmarks.length
    result.skipped += bookmarks.length - rows.length
    return result
  }
}

export class RssAdapter implements IndexSourceAdapter {
  readonly sourceType = 'rss'
  readonly workspaceScope = 'shared'

  async reindex(ctx: AdapterContext): Promise<AdapterReindexResult> {
    const db = ctx.repository.getConnection()
    const items = db
      .prepare(
        `SELECT id, source_id, title, link, summary, author, published_at, starred
         FROM rss_items
         ORDER BY published_at DESC
         LIMIT 5000`,
      )
      .all<{
        id: string
        source_id: string
        title: string
        link: string
        summary: string | null
        author: string | null
        published_at: number | null
        starred: number | null
      }>()
    const rows = items.map((item) => ({
      path: toReadyUri({ kind: 'rss-item', id: item.id }),
      sourceId: item.id,
      name: item.title || item.link,
      body: [item.title || '', stripHtml(item.summary), item.author || '', item.link].filter(Boolean).join(' '),
      meta: {
        link: item.link,
        sourceId: item.source_id,
        publishedAt: item.published_at,
        starred: item.starred === 1,
      },
      mtime: item.published_at ?? 0,
    }))
    return syncShared(this, ctx, rows)
  }
}

export class CalendarAdapter implements IndexSourceAdapter {
  readonly sourceType = 'calendar'
  readonly workspaceScope = 'shared'

  async reindex(ctx: AdapterContext): Promise<AdapterReindexResult> {
    const db = ctx.repository.getConnection()
    rebuildCalendarLinks(db)
    const events = new CalendarStore(()=>db).snapshot().events.map(event=>({
      ...calendarEventToRecord(event),
      id: event.recurringEventId && event.originalStart !== undefined ? `${event.recurringEventId}#${originalToSeconds(event.originalStart)}` : event.recurringEventId || event.id,
      path: toReadyUri({ kind: 'event', id: event.recurringEventId || event.id,
        ...(event.recurringEventId && event.originalStart !== undefined ? { occurrence: String(event.originalStart) } : {}),
      }),
    })).sort((a,b)=>b.start_time-a.start_time).slice(0,5000)
    const rows = events.map((event) => ({
      path: event.path,
      sourceId: event.id,
      name: event.title,
      body: [event.title, event.description || '', event.location || ''].filter(Boolean).join(' '),
      meta: {
        calendarId: event.calendar_id,
        startTime: event.start_time,
        endTime: event.end_time,
        allDay: event.all_day === 1,
        location: event.location,
      },
      mtime: event.start_time,
    }))
    return syncShared(this, ctx, rows)
  }
}

export class AgentMessageAdapter implements IndexSourceAdapter {
  readonly sourceType = 'agent'
  readonly workspaceScope = 'shared'

  async reindex(ctx: AdapterContext): Promise<AdapterReindexResult> {
    const db = ctx.repository.getConnection()
    const conversations = db
      .prepare(
        `SELECT id, agent, title, updated_at FROM chat_conversations
         WHERE closed_at IS NULL ORDER BY updated_at DESC LIMIT 500`,
      )
      .all<{ id: string; agent: string; title: string; updated_at: string }>()
    const rows: Array<{
      path: string
      sourceId: string
      name: string
      body: string
      meta: Record<string, unknown>
      mtime: number
    }> = []
    for (const conv of conversations) {
      const messages = db
        .prepare(
          `SELECT message.role, message.content, message.timestamp
             FROM chat_messages message
             JOIN chat_conversations scope ON scope.id = message.conversation_id
            WHERE message.conversation_id = ?
              AND scope.closed_at IS NULL
              AND message.message_visibility_epoch = scope.message_visibility_epoch
            ORDER BY message.timestamp DESC LIMIT 40`,
        )
        .all<{ role: string; content: string; timestamp: string }>(conv.id)
      if (messages.length === 0) continue
      const body = messages
        .slice()
        .reverse()
        .map((m) => `[${m.role}] ${m.content}`)
        .join('\n')
      const lastTs = Date.parse(messages[0].timestamp)
      rows.push({
        path: toReadyUri({ kind: 'conversation', id: conv.id }),
        sourceId: conv.id,
        name: conv.title || `${conv.agent} · ${conv.id.slice(0, 8)}`,
        body,
        meta: {
          agent: conv.agent,
          messageCount: messages.length,
          lastRole: messages[0].role,
        },
        mtime: Number.isFinite(lastTs) ? Math.floor(lastTs) : 0,
      })
    }
    return syncShared(this, ctx, rows)
  }
}

export const SHARED_WORKSPACE_ROOT = '@shared'
