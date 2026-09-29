import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  finalizeRunOutcome,
  type RunCloseMetric,
  type RunFinalizerDeps,
} from '../main/modules/agent-control/runtime-core/run-finalizer'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('run-finalizer-channel declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'run-finalizer-channel transitive sqlite load')
})

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
      taskType: null,
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
      taskType: null,
    }])
  })

  test('checkpoint_user_input can close through the finalizer without a file handle', async () => {
    const { metrics, deps } = createMetricSpy()

    await finalizeRunOutcome({
      kind: 'checkpoint',
      runId: 'run-user-input-checkpoint',
      continuationHandle: null,
      terminalReason: 'checkpoint_user_input',
      durationMs: 400,
      toolCallsUsed: 2,
      initiator: 'user_input',
    }, deps)

    assert.deepEqual(metrics, [{
      runId: 'run-user-input-checkpoint',
      terminalReason: 'checkpoint_user_input',
      initiator: 'user_input',
      toolCallsUsed: 2,
      durationMs: 400,
      taskType: null,
    }])
  })

  test('checkpoint_incomplete closes as resumable only with a durable checkpoint handle', async () => {
    const { metrics, deps } = createMetricSpy()

    await finalizeRunOutcome({
      kind: 'checkpoint',
      runId: 'run-incomplete-checkpoint',
      continuationHandle: 'checkpoint-incomplete-1',
      terminalReason: 'checkpoint_incomplete',
      durationMs: 500,
      toolCallsUsed: 4,
      initiator: 'incomplete',
    }, deps)

    assert.deepEqual(metrics, [{
      runId: 'run-incomplete-checkpoint',
      terminalReason: 'checkpoint_incomplete',
      initiator: 'incomplete',
      toolCallsUsed: 4,
      durationMs: 500,
      taskType: null,
    }])
  })

  test('budget checkpoint path with a null or empty handle rejects and writes degraded metric', async () => {
    for (const continuationHandle of [null, '']) {
      const { metrics, deps } = createMetricSpy()

      await assert.rejects(
        finalizeRunOutcome({
          kind: 'checkpoint',
          runId: 'run-degraded',
          continuationHandle: continuationHandle as string,
          terminalReason: 'checkpoint_budget',
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

  test('provider failure identity is retained on the run-close metric', async () => {
    const { metrics, deps } = createMetricSpy()
    await finalizeRunOutcome({
      kind: 'error',
      runId: 'run-provider-failure-metric',
      durationMs: 75,
      toolCallsUsed: 0,
      initiator: 'error',
      terminalReason: 'blocked_external',
      providerDiagnostics: {
        provider: 'openai-compatible',
        agentProtocol: 'openai-compatible',
        wireApi: 'responses',
        contextWindow: 65_536,
        protocolSource: 'explicit',
        contextWindowSource: 'model',
        lastProviderFailureHttpStatus: 503,
        lastProviderFailureErrorKind: 'transient',
      },
    }, deps)
    assert.equal(metrics[0]?.lastProviderFailureHttpStatus, 503)
    assert.equal(metrics[0]?.lastProviderFailureErrorKind, 'transient')
  })
})
