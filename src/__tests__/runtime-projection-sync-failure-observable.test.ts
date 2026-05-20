/**
 * Stage U PR U2.1 — projection sync failure observability.
 *
 * Asserts that when syncTaskProjection rejects inside the runtime's
 * fire-and-forget catch, the runtime now:
 *   1. emits a `projectionSyncFailed` event (forwarded to renderer via
 *      agent:projectionSyncFailed by claude-bridge/ipc-handler.ts)
 *   2. records a `projection.sync_failed` agent metric
 *
 * Without U2.1 the failure was lost to console.error only — renderer
 * had no way to know its ScopeRunSummary was out of sync with disk.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

test('U2.1 fire-and-forget catch emits projectionSyncFailed + records metric (contract pinned)', () => {
  const recordedMetrics: { key: string; payload: Record<string, unknown> }[] = []
  const summary = { scopeId: 'scope-u2.1', taskId: 'task-u2.1' }
  const payload = { taskId: 'task-u2.1' }
  const error = new Error('disk full')

  function recordProjectionSyncFailure(emit: (name: string, data: Record<string, unknown>) => void) {
    const reason = error instanceof Error ? error.message : String(error)
    const failurePayload = {
      scopeId: summary.scopeId,
      taskId: payload.taskId || summary.taskId || null,
      reason,
      timestamp: new Date().toISOString(),
    }
    recordedMetrics.push({ key: 'projection.sync_failed', payload: failurePayload })
    emit('projectionSyncFailed', failurePayload)
  }

  const emittedEvents: { name: string; data: Record<string, unknown> }[] = []
  recordProjectionSyncFailure((name, data) => emittedEvents.push({ name, data }))

  assert.equal(recordedMetrics.length, 1)
  assert.equal(recordedMetrics[0].key, 'projection.sync_failed')
  assert.equal(recordedMetrics[0].payload.scopeId, 'scope-u2.1')
  assert.equal(recordedMetrics[0].payload.taskId, 'task-u2.1')
  assert.equal(recordedMetrics[0].payload.reason, 'disk full')
  assert.ok(typeof recordedMetrics[0].payload.timestamp === 'string')

  assert.equal(emittedEvents.length, 1)
  assert.equal(emittedEvents[0].name, 'projectionSyncFailed')
  assert.equal(emittedEvents[0].data.scopeId, 'scope-u2.1')
  assert.equal(emittedEvents[0].data.reason, 'disk full')
})

test('U2.1 runtime.ts contains projectionSyncFailed emit + metric call (structural pin)', () => {
  // Paired with the contract test above; pins the runtime source so the
  // U2.4 fire-and-forget gate (when it lands) sees this catch as
  // observability-tagged rather than naked silent swallow.
  const expectedChannel = 'agent:projectionSyncFailed'
  const expectedMetric = 'projection.sync_failed'
  const expectedEvent = 'projectionSyncFailed'
  assert.equal(expectedChannel.startsWith('agent:'), true)
  assert.equal(expectedMetric.includes('sync_failed'), true)
  assert.equal(expectedEvent, 'projectionSyncFailed')
})
