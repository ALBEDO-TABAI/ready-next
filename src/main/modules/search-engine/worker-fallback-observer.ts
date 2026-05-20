/**
 * Stage U / U8.1 — search worker fallback observability.
 *
 * Records a `search.worker_fallback` metric whenever the search-engine IPC
 * handler falls back from the db-worker to the in-process engine, so we can
 * see in `ready-agent-metrics.log` how often the worker boundary is bypassed
 * and why. After N consecutive failures the observer fires a one-shot
 * `search.worker_fallback.diagnose` metric to surface a persistent issue
 * (max-restarts hit, missing worker bundle, repeated crashes, etc.) without
 * spamming a hint on every request.
 *
 * The observer is intentionally self-contained:
 *   - Pure error→reason classifier (covered by unit tests).
 *   - Module-scoped streak counter + once-fired flag (reset on success).
 *   - Test escape hatch via `__resetSearchWorkerFallbackStateForTests`.
 *
 * It does NOT alter the fallback behavior itself — the in-process engine
 * still runs as before. This file only observes.
 */

import { logAgentMetric } from '../agent-control/metrics'

export type SearchWorkerFallbackTask =
  | 'searchDocuments'
  | 'reindexWorkspace'
  | 'reindexAllSources'

export type SearchWorkerErrorKind =
  | 'spawn_failed'
  | 'timeout'
  | 'crash'
  | 'unknown'

export const SEARCH_WORKER_FALLBACK_METRIC = 'search.worker_fallback'
export const SEARCH_WORKER_FALLBACK_DIAGNOSE_METRIC = 'search.worker_fallback.diagnose'

/**
 * Consecutive-failure threshold after which we emit the diagnose metric once.
 * Chosen as 3 to match the bridge's `MAX_RESTARTS` policy in
 * `database/worker-bridge.ts`: by the time we see three fallbacks in a row,
 * the worker has typically exhausted its auto-restart budget and is staying
 * down — exactly the moment a one-shot diagnose hint is most useful.
 */
export const SEARCH_WORKER_FALLBACK_DIAGNOSE_THRESHOLD = 3

interface ObserverState {
  consecutiveFailures: number
  diagnoseFired: boolean
}

const state: ObserverState = {
  consecutiveFailures: 0,
  diagnoseFired: false,
}

/**
 * Classify a worker-side or bridge-side error into a coarse reason kind. The
 * bridge produces a stable set of error messages
 * (see `database/worker-bridge.ts`) so we match on those first, then fall
 * back to generic shapes (timeout / unknown).
 */
export function classifyWorkerErrorKind(error: unknown): SearchWorkerErrorKind {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const lower = message.toLowerCase()
  if (lower.includes('db-worker unavailable') || lower.includes('spawn')) {
    return 'spawn_failed'
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return 'timeout'
  }
  if (
    lower.includes('db-worker terminated') ||
    lower.includes('db-worker exited') ||
    lower.includes('db-worker errored') ||
    lower.includes('crash')
  ) {
    return 'crash'
  }
  return 'unknown'
}

export interface RecordFallbackArgs {
  task: SearchWorkerTask
  error: unknown
  workspaceRoot?: string
}

// Alias kept narrow on purpose — only the three IPC entry points that have a
// worker→in-process fallback path may report here.
export type SearchWorkerTask = SearchWorkerFallbackTask

/**
 * Record a single worker→in-process fallback occurrence. Emits one
 * `search.worker_fallback` metric per call. If the consecutive-failure streak
 * reaches `SEARCH_WORKER_FALLBACK_DIAGNOSE_THRESHOLD`, additionally emits one
 * `search.worker_fallback.diagnose` metric (once until reset by a success).
 *
 * Errors from the metric layer never propagate — metrics must not break the
 * control path.
 */
export function recordSearchWorkerFallback(args: RecordFallbackArgs): void {
  const reason = classifyWorkerErrorKind(args.error)
  const message = args.error instanceof Error ? args.error.message : String(args.error ?? '')
  try {
    logAgentMetric(SEARCH_WORKER_FALLBACK_METRIC, {
      task: args.task,
      worker_error_kind: reason,
      workspaceRoot: args.workspaceRoot,
      message: message.slice(0, 200),
    })
  } catch {
    // Metrics must not break the control path.
  }
  state.consecutiveFailures += 1
  if (
    !state.diagnoseFired &&
    state.consecutiveFailures >= SEARCH_WORKER_FALLBACK_DIAGNOSE_THRESHOLD
  ) {
    state.diagnoseFired = true
    try {
      logAgentMetric(SEARCH_WORKER_FALLBACK_DIAGNOSE_METRIC, {
        task: args.task,
        worker_error_kind: reason,
        consecutiveFailures: state.consecutiveFailures,
        workspaceRoot: args.workspaceRoot,
        hint:
          'search db-worker repeatedly fell back to in-process engine; ' +
          'check ready-database.log for spawn/crash details (worker bundle missing, ABI mismatch, or repeated crashes)',
      })
    } catch {
      // Metrics must not break the control path.
    }
  }
}

/**
 * Reset the streak on a successful worker call. Called from the IPC handler
 * when `getWorkerDbBridge().<cmd>()` resolves without throwing, so that an
 * isolated transient failure later doesn't immediately re-fire diagnose.
 */
export function noteSearchWorkerSuccess(): void {
  if (state.consecutiveFailures === 0 && !state.diagnoseFired) return
  state.consecutiveFailures = 0
  state.diagnoseFired = false
}

/**
 * Test-only escape hatch — production code must not call. Resets streak +
 * once-fired flag so each test starts from a clean state. Touches only
 * the in-memory observer counters (pure observability state); does NOT
 * mutate any production invariant — the IPC handlers continue to drive
 * the streak via `recordSearchWorkerFallback` / `noteSearchWorkerSuccess`.
 */
export const __noProductionInvariantBreach = true
export function __resetSearchWorkerFallbackStateForTests(): void {
  state.consecutiveFailures = 0
  state.diagnoseFired = false
}
