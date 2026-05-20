/**
 * Stage U / U8.1 — search worker fallback observability behavior test.
 *
 * Verifies that the search-engine IPC handler's worker→in-process fallback
 * path emits a `search.worker_fallback` metric with a structured
 * `worker_error_kind` reason and a workspace root + task field, and that a
 * one-shot `search.worker_fallback.diagnose` metric fires after the
 * configured consecutive-failure threshold (defaults to 3 — matches the
 * db-worker MAX_RESTARTS budget).
 *
 * Testing strategy: drive the observer module directly. The observer is the
 * single surface that classifies errors + emits metrics + tracks the streak;
 * each IPC catch-block does nothing more than call `recordSearchWorkerFallback`
 * with the bridge error, so exercising the observer with the exact error
 * shapes that `database/worker-bridge.ts` produces is the behavioral truth.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'
import {
  SEARCH_WORKER_FALLBACK_DIAGNOSE_METRIC,
  SEARCH_WORKER_FALLBACK_DIAGNOSE_THRESHOLD,
  SEARCH_WORKER_FALLBACK_METRIC,
  __resetSearchWorkerFallbackStateForTests,
  classifyWorkerErrorKind,
  noteSearchWorkerSuccess,
  recordSearchWorkerFallback,
} from '../main/modules/search-engine/worker-fallback-observer'

function captureMetrics(): { events: AgentMetricEvent[]; restore: () => void } {
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  return {
    events,
    restore: () => __setMetricSinkForTests(null),
  }
}

test('classifyWorkerErrorKind maps the bridge error shapes to stable reasons', () => {
  // These are the exact error messages produced by WorkerDbBridgeImpl
  // in database/worker-bridge.ts; if those strings change, this test
  // pulls the regression forward so we re-audit the mapping.
  assert.equal(classifyWorkerErrorKind(new Error('db-worker unavailable')), 'spawn_failed')
  assert.equal(classifyWorkerErrorKind(new Error('worker spawn failed: ENOENT')), 'spawn_failed')
  assert.equal(classifyWorkerErrorKind(new Error('db-worker terminated; cannot send')), 'crash')
  assert.equal(classifyWorkerErrorKind(new Error('db-worker exited (code=137)')), 'crash')
  assert.equal(classifyWorkerErrorKind(new Error('db-worker errored: segfault')), 'crash')
  assert.equal(classifyWorkerErrorKind(new Error('request timed out after 5s')), 'timeout')
  assert.equal(classifyWorkerErrorKind(new Error('some other failure')), 'unknown')
  assert.equal(classifyWorkerErrorKind('plain string'), 'unknown')
  assert.equal(classifyWorkerErrorKind(undefined), 'unknown')
})

test('recordSearchWorkerFallback emits one metric per call with task + reason + root', () => {
  __resetSearchWorkerFallbackStateForTests()
  const { events, restore } = captureMetrics()
  try {
    recordSearchWorkerFallback({
      task: 'searchDocuments',
      error: new Error('db-worker exited (code=1)'),
      workspaceRoot: '/Users/x/notes',
    })
    const fallbacks = events.filter((event) => event.metric === SEARCH_WORKER_FALLBACK_METRIC)
    assert.equal(fallbacks.length, 1)
    const event = fallbacks[0]
    assert.equal(event.task, 'searchDocuments')
    assert.equal(event.worker_error_kind, 'crash')
    assert.equal(event.workspaceRoot, '/Users/x/notes')
    assert.equal(typeof event.message, 'string')
  } finally {
    restore()
    __resetSearchWorkerFallbackStateForTests()
  }
})

test('diagnose metric fires exactly once after threshold consecutive failures', () => {
  __resetSearchWorkerFallbackStateForTests()
  const { events, restore } = captureMetrics()
  try {
    // Below threshold: no diagnose.
    for (let i = 0; i < SEARCH_WORKER_FALLBACK_DIAGNOSE_THRESHOLD - 1; i += 1) {
      recordSearchWorkerFallback({
        task: 'reindexWorkspace',
        error: new Error('db-worker unavailable'),
        workspaceRoot: '/r',
      })
    }
    assert.equal(
      events.filter((event) => event.metric === SEARCH_WORKER_FALLBACK_DIAGNOSE_METRIC).length,
      0,
      'diagnose must not fire before the threshold',
    )

    // Threshold crossed: diagnose fires once.
    recordSearchWorkerFallback({
      task: 'reindexWorkspace',
      error: new Error('db-worker unavailable'),
      workspaceRoot: '/r',
    })
    const diagnoseAfterThreshold = events.filter(
      (event) => event.metric === SEARCH_WORKER_FALLBACK_DIAGNOSE_METRIC,
    )
    assert.equal(diagnoseAfterThreshold.length, 1, 'diagnose must fire exactly once at threshold')
    assert.equal(diagnoseAfterThreshold[0].worker_error_kind, 'spawn_failed')
    assert.equal(diagnoseAfterThreshold[0].consecutiveFailures, SEARCH_WORKER_FALLBACK_DIAGNOSE_THRESHOLD)
    assert.equal(diagnoseAfterThreshold[0].workspaceRoot, '/r')
    assert.equal(typeof diagnoseAfterThreshold[0].hint, 'string')

    // Further failures keep emitting fallback metrics but NOT another diagnose.
    recordSearchWorkerFallback({
      task: 'reindexWorkspace',
      error: new Error('db-worker unavailable'),
      workspaceRoot: '/r',
    })
    recordSearchWorkerFallback({
      task: 'reindexWorkspace',
      error: new Error('db-worker unavailable'),
      workspaceRoot: '/r',
    })
    const diagnoseAfterMore = events.filter(
      (event) => event.metric === SEARCH_WORKER_FALLBACK_DIAGNOSE_METRIC,
    )
    assert.equal(diagnoseAfterMore.length, 1, 'diagnose must remain one-shot')
    const fallbackCount = events.filter((event) => event.metric === SEARCH_WORKER_FALLBACK_METRIC).length
    assert.equal(fallbackCount, SEARCH_WORKER_FALLBACK_DIAGNOSE_THRESHOLD + 2)
  } finally {
    restore()
    __resetSearchWorkerFallbackStateForTests()
  }
})

test('noteSearchWorkerSuccess resets the streak so diagnose can re-fire later', () => {
  __resetSearchWorkerFallbackStateForTests()
  const { events, restore } = captureMetrics()
  try {
    // Trip the threshold once.
    for (let i = 0; i < SEARCH_WORKER_FALLBACK_DIAGNOSE_THRESHOLD; i += 1) {
      recordSearchWorkerFallback({
        task: 'searchDocuments',
        error: new Error('db-worker errored: boom'),
      })
    }
    assert.equal(
      events.filter((event) => event.metric === SEARCH_WORKER_FALLBACK_DIAGNOSE_METRIC).length,
      1,
    )

    // A successful worker call clears the streak + once-fired flag.
    noteSearchWorkerSuccess()

    // Now a new burst of failures must be able to fire diagnose again.
    for (let i = 0; i < SEARCH_WORKER_FALLBACK_DIAGNOSE_THRESHOLD; i += 1) {
      recordSearchWorkerFallback({
        task: 'searchDocuments',
        error: new Error('db-worker exited (code=1)'),
      })
    }
    assert.equal(
      events.filter((event) => event.metric === SEARCH_WORKER_FALLBACK_DIAGNOSE_METRIC).length,
      2,
      'diagnose must fire again after success + new burst',
    )
  } finally {
    restore()
    __resetSearchWorkerFallbackStateForTests()
  }
})

test('non-consecutive failures interleaved with success do not trigger diagnose', () => {
  __resetSearchWorkerFallbackStateForTests()
  const { events, restore } = captureMetrics()
  try {
    for (let i = 0; i < SEARCH_WORKER_FALLBACK_DIAGNOSE_THRESHOLD * 2; i += 1) {
      recordSearchWorkerFallback({
        task: 'searchDocuments',
        error: new Error('db-worker unavailable'),
      })
      noteSearchWorkerSuccess()
    }
    assert.equal(
      events.filter((event) => event.metric === SEARCH_WORKER_FALLBACK_DIAGNOSE_METRIC).length,
      0,
      'isolated failures separated by success must not trip diagnose',
    )
    assert.equal(
      events.filter((event) => event.metric === SEARCH_WORKER_FALLBACK_METRIC).length,
      SEARCH_WORKER_FALLBACK_DIAGNOSE_THRESHOLD * 2,
    )
  } finally {
    restore()
    __resetSearchWorkerFallbackStateForTests()
  }
})
