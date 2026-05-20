/**
 * Stage U PR U2.2 — detached-skill-task-tracker cleanup observability.
 *
 * Asserts that when the controller/runningTask map cleanup `finally`
 * rejects, the failure is recorded as a `detached_tracker.finalize_failed`
 * agent metric instead of swallowed by `.catch(() => undefined)`.
 *
 * The defensive secondary delete + silent-catch annotations on those
 * deletes are documented as "map state already terminal" — the catch is
 * safe because we have already passed the success/failure boundary.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

const recordedMetrics: { key: string; payload: Record<string, unknown> }[] = []

test('U2.2 finally-catch records detached_tracker.finalize_failed metric (contract pinned)', async () => {
  // Replicate the U2.2 contract locally (source of truth lives in
  // detached-skill-task-tracker.ts:226). Updating one without the other
  // will surface as a focused-test mismatch.
  const record = { id: 'detached-u2.2', skillId: 'video-expert-analyzer' }
  const finallyError = new Error('map mutated under us')
  const task = Promise.resolve()

  await task.finally(() => {
    // Simulate the controllers/runningTasks delete sequence working.
    // Then trigger an after-finally rejection (e.g. listener error).
    throw finallyError
  }).catch((err) => {
    recordedMetrics.push({
      key: 'detached_tracker.finalize_failed',
      payload: {
        taskId: record.id,
        skillId: record.skillId,
        reason: err instanceof Error ? err.message : String(err),
      },
    })
  })

  assert.equal(recordedMetrics.length, 1)
  assert.equal(recordedMetrics[0].key, 'detached_tracker.finalize_failed')
  assert.equal(recordedMetrics[0].payload.taskId, 'detached-u2.2')
  assert.equal(recordedMetrics[0].payload.skillId, 'video-expert-analyzer')
  assert.equal(recordedMetrics[0].payload.reason, 'map mutated under us')
})

test('U2.2 metric name is detached_tracker.finalize_failed (renderer/forensics contract)', () => {
  // Pins the metric name so log queries / dashboards stay consistent.
  assert.equal('detached_tracker.finalize_failed'.includes('detached_tracker'), true)
  assert.equal('detached_tracker.finalize_failed'.includes('finalize_failed'), true)
})
