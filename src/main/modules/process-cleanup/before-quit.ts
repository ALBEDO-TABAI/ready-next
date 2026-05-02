/**
 * Graceful shutdown helper for the Electron `before-quit` lifecycle.
 *
 * The previous implementation fired `void cleanupAgentRuntime()` and then
 * synchronously closed the database / killed managers. Because nothing was
 * awaited, the process could exit mid-cleanup, leaving sidecar / chrome
 * orphans behind (see `boot-reaper.ts` for the reap-on-next-boot fallback).
 *
 * Contract:
 *   - Runtime cleanups (`cleanupAgentRuntime`, `agentManager.cleanup`,
 *     `rsshubManager.cleanup`) are run in parallel via `Promise.allSettled`
 *     so a hang in one does not block the others.
 *   - The whole batch is bounded by a hard timeout (default 5s) so quit is
 *     never blocked by a stuck sidecar.
 *   - The database is closed last, after runtime cleanups settle (or the
 *     timeout elapses) — closing while skill_run_shell handlers are still
 *     touching the DB would surface confusing errors during shutdown.
 *
 * This module is intentionally electron-free so it can be unit tested.
 */

export interface BeforeQuitCleanupDeps {
  /** Stops the agent control runtime (sidecar process + memory lifecycle). */
  cleanupAgentRuntime: () => Promise<void> | void
  /** Tears down the AgentManager (kills agent worker processes). */
  cleanupAgentManager: () => Promise<void> | void
  /** Force-kills the embedded RSSHub child process. */
  cleanupRsshubManager: () => Promise<void> | void
  /**
   * Closes any Puppeteer browsers registered via `launchManagedBrowser`.
   * Optional — environments without direct puppeteer use can omit it.
   */
  cleanupManagedBrowsers?: () => Promise<void> | void
  /**
   * Tears down the DB worker_thread (perf-rescue B1). Runs in parallel with
   * the other runtime cleanups so a stuck worker can't block quit beyond
   * `timeoutMs`. Optional for tests / environments without the worker.
   */
  cleanupDbWorker?: () => Promise<void> | void
  /**
   * Closes any active chokidar file watchers (perf-rescue B7). Optional —
   * tests + environments that never opened a watcher can skip this. Runs in
   * parallel with the other runtime cleanups.
   */
  cleanupFileWatchers?: () => Promise<void> | void
  /** Closes the SQLite handle. Runs last. */
  closeDatabase: () => void
  /** Optional logger override (defaults to console). */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>
}

export interface BeforeQuitCleanupOptions {
  /** Hard cap on parallel cleanups, in ms. Default 5000. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 5_000

function safeInvoke(
  fn: () => Promise<void> | void,
  label: string,
  logger: Pick<Console, 'warn'>,
): Promise<void> {
  try {
    const result = fn()
    if (result && typeof (result as Promise<void>).then === 'function') {
      return (result as Promise<void>).catch((err) => {
        logger.warn(`[before-quit] ${label} rejected`, err)
      })
    }
    return Promise.resolve()
  } catch (err) {
    logger.warn(`[before-quit] ${label} threw synchronously`, err)
    return Promise.resolve()
  }
}

/**
 * Run the ordered shutdown sequence. Returns when cleanup completes or the
 * timeout elapses — never throws.
 */
export async function runBeforeQuitCleanup(
  deps: BeforeQuitCleanupDeps,
  options: BeforeQuitCleanupOptions = {},
): Promise<void> {
  const logger = deps.logger ?? console
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  logger.log('[before-quit] starting graceful shutdown')

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timeoutHandle = setTimeout(() => resolve('timeout'), timeoutMs)
    // Keep node alive only as long as needed; allow process to exit if all
    // cleanups already finished.
    if (timeoutHandle && typeof timeoutHandle.unref === 'function') {
      timeoutHandle.unref()
    }
  })

  const tasks: Array<Promise<void>> = [
    safeInvoke(deps.cleanupAgentRuntime, 'cleanupAgentRuntime', logger),
    safeInvoke(deps.cleanupAgentManager, 'agentManager.cleanup', logger),
    safeInvoke(deps.cleanupRsshubManager, 'rsshubManager.cleanup', logger),
  ]
  if (deps.cleanupManagedBrowsers) {
    tasks.push(safeInvoke(deps.cleanupManagedBrowsers, 'cleanupManagedBrowsers', logger))
  }
  if (deps.cleanupDbWorker) {
    tasks.push(safeInvoke(deps.cleanupDbWorker, 'cleanupDbWorker', logger))
  }
  if (deps.cleanupFileWatchers) {
    tasks.push(safeInvoke(deps.cleanupFileWatchers, 'cleanupFileWatchers', logger))
  }
  const cleanupPromise = Promise.allSettled(tasks)

  const winner = await Promise.race([cleanupPromise, timeoutPromise])
  if (timeoutHandle) clearTimeout(timeoutHandle)
  if (winner === 'timeout') {
    logger.warn(`[before-quit] cleanup timed out after ${timeoutMs}ms; forcing quit`)
  }

  try {
    deps.closeDatabase()
  } catch (err) {
    logger.warn('[before-quit] db.close failed', err)
  }

  logger.log('[before-quit] cleanup done')
}
