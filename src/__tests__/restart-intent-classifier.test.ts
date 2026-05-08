/**
 * Stage Q (Stage 11) — restart intent classifier exhaustiveness +
 * decision-table contract.
 *
 * Plan §3.6 contract C8: three-class union is mutually exclusive +
 * exhaustive.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RESTART_INTENT_CLASSES,
  classifyRestartIntent,
  type RestartIntentClass,
} from '../main/modules/agent-control/restart-intent-classifier'

test('exhaustiveness: 3 classes, no fourth', () => {
  assert.equal(RESTART_INTENT_CLASSES.length, 3)
  const set = new Set<RestartIntentClass>(RESTART_INTENT_CLASSES)
  assert.ok(set.has('fresh'))
  assert.ok(set.has('resume'))
  assert.ok(set.has('restart_from_existing'))
})

test('userIntent != start always returns "resume"', () => {
  for (const ui of ['continue', 'repair_config', 'inspect', 'cancel', 'unknown'] as const) {
    assert.equal(classifyRestartIntent({
      userIntent: ui,
      explicitRunStateResource: null,
      providedContinuationState: null,
      continuationRef: null,
    }), 'resume', `expected resume for userIntent=${ui}`)
  }
})

test('userIntent=start + no handle → fresh', () => {
  assert.equal(classifyRestartIntent({
    userIntent: 'start',
    explicitRunStateResource: null,
    providedContinuationState: null,
    continuationRef: null,
  }), 'fresh')
})

test('userIntent=start + explicitRunStateResource → restart_from_existing', () => {
  assert.equal(classifyRestartIntent({
    userIntent: 'start',
    explicitRunStateResource: { runStatePath: '/x' },
    providedContinuationState: null,
    continuationRef: null,
  }), 'restart_from_existing')
})

test('userIntent=start + providedContinuationState → restart_from_existing', () => {
  assert.equal(classifyRestartIntent({
    userIntent: 'start',
    explicitRunStateResource: null,
    providedContinuationState: { taskId: 'tid' },
    continuationRef: null,
  }), 'restart_from_existing')
})

test('userIntent=start + canResumeShape continuationRef → restart_from_existing', () => {
  assert.equal(classifyRestartIntent({
    userIntent: 'start',
    explicitRunStateResource: null,
    providedContinuationState: null,
    continuationRef: {
      childRunId: 'cr-real',
      detachedTaskId: null,
      outputDir: null,
      runStatePath: null,
    },
  }), 'restart_from_existing')
})

test('userIntent=start + empty-shell continuationRef (no durable handle) → fresh', () => {
  // The bug case: user typed "重新开始", the projection has a stale
  // continuationRef with only taskRunId+skillId. canResumeShape returns
  // false → fresh, not restart_from_existing. The stale shell must NOT
  // re-arm the supervisor borrow.
  assert.equal(classifyRestartIntent({
    userIntent: 'start',
    explicitRunStateResource: null,
    providedContinuationState: null,
    continuationRef: {
      childRunId: null,
      detachedTaskId: null,
      outputDir: null,
      runStatePath: null,
    },
  }), 'fresh')
})

test('mutual exclusivity: same inputs always map to one class', () => {
  // Drive a 2x2x2x2 fixture matrix and verify classes are partition.
  const counts: Record<RestartIntentClass, number> = { fresh: 0, resume: 0, restart_from_existing: 0 }
  const userIntents = ['start', 'continue'] as const
  const explicit = [null, { foo: 1 }] as const
  const provided = [null, { taskId: 't' }] as const
  const refs = [null, { outputDir: '/x', runStatePath: '/x/r.json' }] as const
  for (const ui of userIntents) {
    for (const er of explicit) {
      for (const pc of provided) {
        for (const cr of refs) {
          const cls = classifyRestartIntent({
            userIntent: ui,
            explicitRunStateResource: er,
            providedContinuationState: pc,
            continuationRef: cr,
          })
          counts[cls] += 1
        }
      }
    }
  }
  // 16 cells distributed among 3 classes; sum must be 16.
  assert.equal(counts.fresh + counts.resume + counts.restart_from_existing, 16)
  // Every class appears at least once (smoke).
  assert.ok(counts.fresh > 0)
  assert.ok(counts.resume > 0)
  assert.ok(counts.restart_from_existing > 0)
})
