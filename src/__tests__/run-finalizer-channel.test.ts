import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  finalizeRunOutcome,
  type RunCloseMetric,
  type RunFinalizerDeps,
} from '../main/modules/agent-control/run-finalizer'

function createMetricSpy(): {
  metrics: RunCloseMetric[]
  deps: RunFinalizerDeps
} {
  const metrics: RunCloseMetric[] = []
  return {
    metrics,
    deps: {
      writeRunCloseMetric(metric) {
        metrics.push(metric)
      },
    },
  }
}

describe('finalizeRunOutcome', () => {
  test('done path writes the correct close metric', async () => {
    const { metrics, deps } = createMetricSpy()

    await finalizeRunOutcome({
      kind: 'done',
      runId: 'run-done',
      durationMs: 1_250,
      toolCallsUsed: 3,
      initiator: 'user_stop',
    }, deps)

    assert.deepEqual(metrics, [{
      runId: 'run-done',
      terminalReason: 'done',
      initiator: 'user_stop',
      toolCallsUsed: 3,
      durationMs: 1_250,
    }])
  })

  test('checkpoint path with a valid handle writes checkpoint close metric', async () => {
    const { metrics, deps } = createMetricSpy()

    await finalizeRunOutcome({
      kind: 'checkpoint',
      runId: 'run-checkpoint',
      continuationHandle: 'state/run-checkpoint.json',
      durationMs: 2_500,
      toolCallsUsed: 7,
      initiator: 'budget',
    }, deps)

    assert.deepEqual(metrics, [{
      runId: 'run-checkpoint',
      terminalReason: 'checkpoint',
      initiator: 'budget',
      toolCallsUsed: 7,
      durationMs: 2_500,
    }])
  })

  test('checkpoint path with a null or empty handle rejects and writes degraded metric', async () => {
    for (const continuationHandle of [null, '']) {
      const { metrics, deps } = createMetricSpy()

      await assert.rejects(
        finalizeRunOutcome({
          kind: 'checkpoint',
          runId: 'run-degraded',
          continuationHandle: continuationHandle as string,
          durationMs: 300,
          toolCallsUsed: 1,
          initiator: 'budget',
        }, deps),
        new Error('checkpoint outcome requires a valid continuation handle'),
      )

      assert.deepEqual(metrics, [{
        runId: 'run-degraded',
        terminalReason: 'checkpoint_degraded_error',
        initiator: 'budget',
        toolCallsUsed: 1,
        durationMs: 300,
      }])
    }
  })

  test('initiator is forwarded from outcome to metric', async () => {
    const { metrics, deps } = createMetricSpy()

    await finalizeRunOutcome({
      kind: 'done',
      runId: 'run-initiator',
      durationMs: 50,
      toolCallsUsed: 0,
      initiator: 'preempted',
    }, deps)

    assert.equal(metrics[0]?.initiator, 'preempted')
  })
})
