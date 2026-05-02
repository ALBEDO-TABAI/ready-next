/**
 * perf-rescue B7 — chokidar file watcher for delta incremental indexing.
 *
 * Goal: after the user picks a workspace and the first full reindex completes,
 * subsequent file edits / additions / deletions update the FTS index a single
 * row at a time without rescanning the whole tree. Runs entirely in the main
 * process (chokidar opens kqueue/FSEvents/inotify handles directly).
 *
 * Hard constraints (Wave 0 + B5/B6 lessons):
 *   - Watch the workspace root only. Refuses `~`, `/Users/<x>`, `/Volumes/<x>`,
 *     and the other forbidden roots covered by `validateWorkspaceRoot`. The
 *     indexer-blowup bug that motivated this rescue (bb529f1) was triggered by
 *     watching home; we will not re-introduce that.
 *   - Same dir blocklist (B5 / IGNORED_DIR_NAMES) is applied via chokidar's
 *     `ignored` option — node_modules, .git, .next, .venv, etc. never get
 *     watched, regardless of how deep they appear in the workspace tree.
 *   - Binary extensions from `decideFileForIndex` are NOT enforced here — the
 *     indexer's `loadFile` already short-circuits on those, so re-checking
 *     would just be duplicated work. We let chokidar fire raw add/change and
 *     let the indexer reject. Worst case: a tiny burst of "skipped" events.
 *   - Each file path is debounced 1s — VS Code / IntelliJ tend to write the
 *     same file 3-5 times in 200ms (atomic save dance). We collapse those.
 *
 * The module is structured for testability: `createFileWatcher` accepts an
 * injected `chokidarFactory` so unit tests can swap in a fake. The default
 * factory is `chokidar.watch`. The `validateWorkspaceRoot` import means we
 * never need a side-channel allow/deny list — the renderer-side picker has
 * the same gate.
 */

import chokidar, { type ChokidarOptions } from 'chokidar'
import { randomBytes } from 'crypto'

import { createRotatingLogger } from '../../utils/rotating-logger'
import { validateWorkspaceRoot } from '../../../shared/workspace-validation'
import { IGNORED_DIR_NAMES } from './adapters'

const searchLogger = createRotatingLogger('ready-search.log')

function logWatcher(message: string): void {
  try {
    searchLogger.append(`[${new Date().toISOString()}] [file-watcher] ${message}\n`)
  } catch {
    /* best-effort */
  }
}

/** Per-file callback fired after the debounce window. */
export type FileWatcherChangeKind = 'add' | 'change' | 'unlink'

export interface FileWatcherChange {
  /** Absolute path. Always emitted by chokidar (cwd was workspaceRoot). */
  filePath: string
  kind: FileWatcherChangeKind
  /** Workspace root the watcher was registered with — useful for routing. */
  workspaceRoot: string
}

export type FileWatcherCallback = (change: FileWatcherChange) => void

export interface FileWatcherOptions {
  workspaceRoot: string
  /** Fired once per (path, kind) per debounce window. */
  onChange: FileWatcherCallback
  /** Optional abort signal — closes the watcher cleanly when aborted. */
  signal?: AbortSignal
  /** Debounce window per file in ms. Default 1000. Tests pass smaller. */
  debounceMs?: number
  /** Override chokidar.watch — for unit tests. */
  chokidarFactory?: ChokidarFactory
}

/** Minimal contract we need from chokidar.watch for testing. */
export type ChokidarFactory = (paths: string | string[], opts?: ChokidarOptions) => ChokidarLike

/**
 * The watcher methods we actually use. Mirrors `FSWatcher`'s public surface
 * narrowly so a test fake doesn't have to implement the entire EventEmitter
 * graph.
 */
export interface ChokidarLike {
  on(event: 'add' | 'change' | 'unlink', cb: (path: string) => void): this
  on(event: 'error', cb: (err: Error) => void): this
  on(event: 'ready', cb: () => void): this
  close(): Promise<void>
}

export interface FileWatcherHandle {
  /** Stable id for the IPC bridge (caller maps id -> handle). */
  readonly id: string
  /** The root being watched. Convenience for callers. */
  readonly workspaceRoot: string
  /** Idempotent. Resolves once the underlying chokidar handle is closed. */
  close(): Promise<void>
}

/** Validation reasons that can prevent a watcher from starting. */
export type FileWatcherStartError =
  | { kind: 'invalid_root'; reason: string; message: string }
  | { kind: 'enospc'; message: string }
  | { kind: 'failed'; message: string }

/**
 * The kqueue/inotify error that bites Linux users with too-low watch limits.
 * macOS uses FSEvents and never raises this. We surface it distinctly so the
 * IPC layer can show a toast advising `sysctl fs.inotify.max_user_watches`.
 */
export function isInotifyExhaustionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOSPC') return true
  // chokidar wraps the underlying error message — check the text too.
  return /ENOSPC|inotify/i.test(error.message)
}

/**
 * Default chokidar options.
 *
 * Why these knobs:
 *   - `ignoreInitial: true`: chokidar would otherwise fire `add` for every
 *     file that already exists — that's exactly the full-scan we are trying
 *     to avoid. The first full reindex is done via the indexer, not us.
 *   - `persistent: true`: keep the event loop alive while watching. The
 *     watcher's lifetime is bounded by IPC stop / app quit.
 *   - `followSymlinks: false`: avoid loops + opaque external trees.
 *   - `ignorePermissionErrors: true`: a single unreadable file shouldn't
 *     crash the watcher.
 *   - `awaitWriteFinish`: chokidar's built-in debounce on the *file content*
 *     side. Pairs with our per-path JS debounce — the chokidar one says "no
 *     event until file size is stable for 100ms"; ours says "collapse rapid
 *     same-path emissions into one".
 *   - `ignored`: function form — `validateIgnored(path)` checks the path's
 *     segments against IGNORED_DIR_NAMES and the macOS bundle pattern.
 */
function buildChokidarOptions(): ChokidarOptions {
  return {
    ignoreInitial: true,
    persistent: true,
    followSymlinks: false,
    ignorePermissionErrors: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    ignored: (filePath) => isPathIgnored(filePath),
  }
}

/** Apply the same blocklist as the indexer walker. */
export function isPathIgnored(filePath: string): boolean {
  if (!filePath) return false
  const segments = filePath.split(/[\\/]/g)
  for (const segment of segments) {
    if (!segment) continue
    if (IGNORED_DIR_NAMES.has(segment)) return true
    const lower = segment.toLowerCase()
    if (lower.endsWith('.app') || lower.endsWith('.framework')) return true
  }
  return false
}

/**
 * Start a watcher over the given workspace root. Returns either a handle (on
 * success) or a structured error (on failure). Never throws on validation
 * failure — callers can decide whether to surface a toast or silently ignore.
 *
 * The handle's `close()` is idempotent; calling stop twice is safe and only
 * the first call observes the underlying chokidar promise.
 */
export async function createFileWatcher(
  options: FileWatcherOptions,
): Promise<FileWatcherHandle | FileWatcherStartError> {
  // 1. Validate root. We do not allow watching home / system / drive roots.
  //    The renderer should already have validated, but we re-check at the
  //    main-process boundary so a malicious / buggy IPC call can't bypass.
  const validation = validateWorkspaceRoot(options.workspaceRoot)
  if (!validation.ok) {
    logWatcher(`reject root=${options.workspaceRoot} reason=${validation.reason ?? 'unknown'}`)
    return {
      kind: 'invalid_root',
      reason: validation.reason ?? 'unknown',
      message: validation.message ?? 'workspace root rejected',
    }
  }

  const factory: ChokidarFactory = options.chokidarFactory
    ?? ((p, opts) => chokidar.watch(p, opts) as unknown as ChokidarLike)
  const debounceMs = options.debounceMs ?? 1000

  let watcher: ChokidarLike
  try {
    watcher = factory(options.workspaceRoot, buildChokidarOptions())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logWatcher(`spawn failed root=${options.workspaceRoot} error=${message}`)
    if (isInotifyExhaustionError(error)) {
      return { kind: 'enospc', message }
    }
    return { kind: 'failed', message }
  }

  // 2. Track close state so it's idempotent + the abort signal can call it.
  //    Declared before `enqueue` so the closure reads from a fully-initialised
  //    binding (avoids any TDZ surprise even if chokidar ever fired sync).
  let closed = false
  let closePromise: Promise<void> | null = null

  // 3. Set up debounce. We debounce per (filePath, kind) so a file rapidly
  //    "saved → modified → saved" still emits a single 'change' instead of
  //    three. Key shape: `${kind}:${filePath}`.
  const pending = new Map<string, NodeJS.Timeout>()

  const flush = (key: string, change: FileWatcherChange): void => {
    pending.delete(key)
    try {
      options.onChange(change)
    } catch (error) {
      // Caller errors should not blow up the watcher — log + continue.
      const message = error instanceof Error ? error.message : String(error)
      logWatcher(`onChange threw path=${change.filePath} error=${message}`)
    }
  }

  const enqueue = (kind: FileWatcherChangeKind) => (filePath: string) => {
    if (closed) return
    // Defense in depth: chokidar should already have filtered via `ignored`,
    // but if anything slipped through (symlink retarget, glob edge case)
    // we re-check here.
    if (isPathIgnored(filePath)) return
    const key = `${kind}:${filePath}`
    const existing = pending.get(key)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      flush(key, { filePath, kind, workspaceRoot: options.workspaceRoot })
    }, debounceMs)
    // Don't keep the event loop alive solely for a debounce — if the watcher
    // is shutting down we want to exit cleanly.
    if (typeof timer.unref === 'function') timer.unref()
    pending.set(key, timer)
  }

  watcher.on('add', enqueue('add'))
  watcher.on('change', enqueue('change'))
  watcher.on('unlink', enqueue('unlink'))
  watcher.on('error', (error: Error) => {
    if (isInotifyExhaustionError(error)) {
      logWatcher(`ENOSPC root=${options.workspaceRoot} — inotify watch limit exhausted`)
    } else {
      logWatcher(`error root=${options.workspaceRoot} message=${error.message}`)
    }
  })
  watcher.on('ready', () => {
    logWatcher(`ready root=${options.workspaceRoot}`)
  })

  const close = async (): Promise<void> => {
    if (closed) return closePromise ?? Promise.resolve()
    closed = true
    // Drain pending debounce timers — we do NOT flush them. If a file changed
    // a moment before workspace close, the user almost certainly doesn't care
    // about its post-close index update, and we'd risk acting on a workspace
    // that's already being torn down.
    for (const timer of pending.values()) clearTimeout(timer)
    pending.clear()
    closePromise = (async () => {
      try {
        await watcher.close()
      } catch (error) {
        logWatcher(`close failed root=${options.workspaceRoot} error=${error instanceof Error ? error.message : String(error)}`)
      }
    })()
    return closePromise
  }

  if (options.signal) {
    if (options.signal.aborted) {
      // Don't return a handle the caller can never reach — close immediately
      // and report the failure.
      await close()
      return { kind: 'failed', message: 'aborted before watcher attached' }
    }
    options.signal.addEventListener('abort', () => { void close() }, { once: true })
  }

  return {
    id: makeWatcherId(),
    workspaceRoot: options.workspaceRoot,
    close,
  }
}

/** Generates the `wch-<8hex>` id used as the IPC handle. */
function makeWatcherId(): string {
  return `wch-${randomBytes(4).toString('hex')}`
}

/**
 * Process-wide registry of active watchers. The IPC layer treats this as the
 * single source of truth: start returns an id; stop looks it up and closes.
 *
 * We don't expose this as a singleton globally — the IPC handler imports it
 * once. Tests build their own `FileWatcherRegistry` instances.
 */
export class FileWatcherRegistry {
  private readonly watchers = new Map<string, FileWatcherHandle>()

  size(): number {
    return this.watchers.size
  }

  has(id: string): boolean {
    return this.watchers.has(id)
  }

  list(): readonly FileWatcherHandle[] {
    return Array.from(this.watchers.values())
  }

  add(handle: FileWatcherHandle): void {
    this.watchers.set(handle.id, handle)
  }

  /** Idempotent: returns true if a handle existed and was closed. */
  async stop(id: string): Promise<boolean> {
    const handle = this.watchers.get(id)
    if (!handle) return false
    this.watchers.delete(id)
    await handle.close()
    return true
  }

  /** Cleanly close every active watcher. Used on app quit / DB worker exit. */
  async stopAll(): Promise<number> {
    const handles = Array.from(this.watchers.values())
    this.watchers.clear()
    await Promise.all(handles.map((h) => h.close().catch(() => {})))
    return handles.length
  }
}
