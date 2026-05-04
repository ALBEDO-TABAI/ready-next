import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cancelChildRunForIpc,
  listActiveChildRunsForIpc,
} from '../main/modules/claude-bridge/active-child-run-ipc'
import {
  __setMetricSinkForTests,
  type AgentMetricEvent,
} from '../main/modules/agent-control/metrics'

function captureMetrics(): {
  events: AgentMetricEvent[]
  restore: () => void
} {
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  return { events, restore: () => __setMetricSinkForTests(null) }
}

/**
 * Stage 3 W1 — IPC consumer now reads `listActiveChildRunsWithDiagnostics`,
 * so test shims provide `{ rows, projectionFailure }` instead of returning
 * an array directly. Behavior of row normalization / dropped-sample cap is
 * unchanged from Stage 2.3.
 */
function diagnosticsRuntime(
  rows: unknown,
  projectionFailure: { reason: string; message: string } | null = null,
) {
  return {
    listActiveChildRunsWithDiagnostics: () => ({ rows, projectionFailure }),
  }
}

test('listActiveChildRunsForIpc returns active child run summaries with projection fields', () => {
  const rows = [{
    childRunId: 'vcr_1',
    status: 'running',
    startedAt: '2026-05-02T00:00:00.000Z',
    progress: {
      detail: '评分批次 2/7,约 12/39 场景',
      activityUpdatedAt: '2026-05-04T06:00:00.000Z',
    },
  }]

  const response = listActiveChildRunsForIpc(diagnosticsRuntime(rows))

  assert.deepEqual(response, {
    success: true,
    data: [{
      childRunId: 'vcr_1',
      status: 'running',
      startedAt: '2026-05-02T00:00:00.000Z',
      progress: {
        stage: null,
        completed: null,
        total: null,
        coverage: null,
        overallCoverage: null,
        fingerprint: null,
        updatedAt: null,
        lastError: null,
        detail: '评分批次 2/7,约 12/39 场景',
        activityUpdatedAt: '2026-05-04T06:00:00.000Z',
        handoff: null,
      },
      blockedReason: null,
      liveness: 'background',
      closeStatus: null,
    }],
  })
})

test('listActiveChildRunsForIpc rejects non-array rows as invalid shape', () => {
  const { events, restore } = captureMetrics()
  try {
    for (const bad of [null, undefined, {}, { rows: [] }, 'oops', 42] as const) {
      const response = listActiveChildRunsForIpc(diagnosticsRuntime(bad))
      assert.deepEqual(response, { success: false, error: 'invalid_payload_shape' }, `non-array=${JSON.stringify(bad)}`)
    }
    // no rows were dropped because we never entered the row loop
    assert.equal(events.length, 0)
  } finally {
    restore()
  }
})

test('listActiveChildRunsForIpc drops non-object rows and emits sampled metrics', () => {
  const { events, restore } = captureMetrics()
  try {
    const runtime = diagnosticsRuntime([
      null,
      'not-an-object',
      42,
      { childRunId: 'vcr_keep', status: 'running', startedAt: '2026-05-05T00:00:00.000Z' },
    ])
    const response = listActiveChildRunsForIpc(runtime)
    assert.equal(response.success, true)
    assert.equal(Array.isArray(response.data), true)
    const data = response.data as Array<Record<string, unknown>>
    assert.equal(data.length, 1)
    assert.equal(data[0].childRunId, 'vcr_keep')
    const dropped = events.filter((e) => e.metric === 'active_child_run_row_dropped')
    assert.equal(dropped.length, 3)
    for (const event of dropped) {
      assert.equal(event.reason, 'not_an_object')
      assert.deepEqual(event.sampleKeys, [])
    }
  } finally {
    restore()
  }
})

test('listActiveChildRunsForIpc drops rows missing childRunId with sampleKeys', () => {
  const { events, restore } = captureMetrics()
  try {
    const runtime = diagnosticsRuntime([
      { skillId: 'x', status: 'running', startedAt: '2026-05-05T00:00:00.000Z' },
      { childRunId: '   ', status: 'running' }, // blank id is treated as missing
      { childRunId: 'vcr_keep', status: 'running', startedAt: '2026-05-05T00:00:00.000Z' },
    ])
    const response = listActiveChildRunsForIpc(runtime)
    assert.equal(response.success, true)
    const data = response.data as Array<Record<string, unknown>>
    assert.equal(data.length, 1)
    assert.equal(data[0].childRunId, 'vcr_keep')
    const dropped = events.filter((e) => e.metric === 'active_child_run_row_dropped')
    assert.equal(dropped.length, 2)
    for (const event of dropped) {
      assert.equal(event.reason, 'missing_child_run_id')
      assert.equal(Array.isArray(event.sampleKeys), true)
    }
  } finally {
    restore()
  }
})

test('listActiveChildRunsForIpc caps dropped-row metric samples at 5 per call', () => {
  const { events, restore } = captureMetrics()
  try {
    const runtime = diagnosticsRuntime(Array.from({ length: 12 }, () => null))
    const response = listActiveChildRunsForIpc(runtime)
    assert.equal(response.success, true)
    const data = response.data as unknown[]
    assert.equal(data.length, 0)
    const dropped = events.filter((e) => e.metric === 'active_child_run_row_dropped')
    assert.equal(dropped.length, 5, 'cap should be 5 sample emits per call')
  } finally {
    restore()
  }
})

/**
 * Stage 3 W1 — three new behaviors: emit projection_db_error metric, keep
 * normalizing the rows we did get, and stay silent on the happy path.
 */

test('listActiveChildRunsForIpc emits projection failure metric when diagnostics report failure', () => {
  const { events, restore } = captureMetrics()
  try {
    const runtime = {
      listActiveChildRunsWithDiagnostics: () => ({
        rows: [{ childRunId: 'vcr_inmem', status: 'running', startedAt: '2026-05-06T00:00:00.000Z' }],
        projectionFailure: { reason: 'projection_db_error', message: 'SQLITE_BUSY' },
      }),
    }
    const response = listActiveChildRunsForIpc(runtime)
    assert.equal(response.success, true)
    const projectionEvents = events.filter((e) => e.metric === 'active_child_run_projection_query_failed')
    assert.equal(projectionEvents.length, 1)
    assert.equal(projectionEvents[0].reason, 'projection_db_error')
    assert.equal(projectionEvents[0].message, 'SQLITE_BUSY')
  } finally {
    restore()
  }
})

test('listActiveChildRunsForIpc still normalizes in-memory rows after emitting projection failure', () => {
  const { events, restore } = captureMetrics()
  try {
    const runtime = {
      listActiveChildRunsWithDiagnostics: () => ({
        rows: [
          null, // bad row
          { childRunId: 'vcr_inmem', status: 'running', startedAt: '2026-05-06T00:00:00.000Z' },
        ],
        projectionFailure: { reason: 'projection_db_error', message: 'something went wrong' },
      }),
    }
    const response = listActiveChildRunsForIpc(runtime)
    assert.equal(response.success, true)
    const data = response.data as Array<Record<string, unknown>>
    assert.equal(data.length, 1, 'projection failure must not block in-memory rows')
    assert.equal(data[0].childRunId, 'vcr_inmem')
    const projection = events.filter((e) => e.metric === 'active_child_run_projection_query_failed')
    assert.equal(projection.length, 1)
    const dropped = events.filter((e) => e.metric === 'active_child_run_row_dropped')
    assert.equal(dropped.length, 1, 'row normalization still runs after projection failure')
  } finally {
    restore()
  }
})

test('listActiveChildRunsForIpc emits no projection metric when diagnostics report success', () => {
  const { events, restore } = captureMetrics()
  try {
    const runtime = diagnosticsRuntime([
      { childRunId: 'vcr_ok', status: 'running', startedAt: '2026-05-06T00:00:00.000Z' },
    ])
    const response = listActiveChildRunsForIpc(runtime)
    assert.equal(response.success, true)
    const projection = events.filter((e) => e.metric === 'active_child_run_projection_query_failed')
    assert.equal(projection.length, 0, 'happy path should not emit projection failure metric')
  } finally {
    restore()
  }
})

test('cancelChildRunForIpc validates childRunId and records ui_button source', async () => {
  const seen: Array<{ childRunId: string; source: string }> = []
  const closeEvent = { status: 'cancelled', terminalReason: 'cancelled_user' }
  const runtime = {
    cancelChildRun: async (childRunId: string, options: { source: 'ui_button' }) => {
      seen.push({ childRunId, source: options.source })
      return closeEvent
    },
  }

  const missing = await cancelChildRunForIpc(runtime, { childRunId: '   ' })
  const cancelled = await cancelChildRunForIpc(runtime, { childRunId: '  vcr_123  ' })

  assert.deepEqual(missing, { success: false, error: 'childRunId is required' })
  assert.deepEqual(cancelled, { success: true, data: closeEvent })
  assert.deepEqual(seen, [{ childRunId: 'vcr_123', source: 'ui_button' }])
})
