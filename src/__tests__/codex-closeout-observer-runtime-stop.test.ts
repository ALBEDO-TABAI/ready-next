import assert from 'node:assert/strict'
import test from 'node:test'

import { createLifecycleWiring } from '../main/modules/agent-control/codex-runtime/composition/lifecycle'
import { createCodexCompositionLive } from '../main/modules/agent-control/codex-runtime/composition/live-state'

// The live composition's closeout observer retries a pending closeout every second. Once the runtime stops it must
// stop retrying (the next boot's recovery owns the run) instead of reading a closing database forever.
test('the pending closeout observer stops retrying once the runtime stops', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const live = createCodexCompositionLive()
  live.lifecycle = 'running'
  let attempts = 0
  const { lifecycleAdapter } = createLifecycleWiring({
    live,
    closeCandidate: async () => {
      attempts += 1
      throw new Error('codex_product_closeout_in_flight')
    },
    verified: { manifestDigest: 'manifest', manifest: { stableV2SchemaSha256: 'schema' } },
  } as unknown as Parameters<typeof createLifecycleWiring>[0])
  const candidate = { kind: 'native_terminal', readyRunId: 'run-1', readyTaskId: 'task-1' }
  const unsubscribe = lifecycleAdapter.observeRunCloseout({
    prepared: { runId: 'run-1', taskId: 'task-1' },
    expectedScopeId: 'scope-1',
    pending: { state: 'ready_closeout_pending', candidate, recoveryEvidenceDigest: 'evidence' },
  } as unknown as Parameters<typeof lifecycleAdapter.observeRunCloseout>[0], () => {
    throw new Error('unexpected_readback')
  })
  try {
    // Let each rejected attempt settle so only the runtime state decides whether the next tick retries.
    const settle = () => new Promise((resolve) => setImmediate(resolve))
    t.mock.timers.tick(1_000)
    await settle()
    t.mock.timers.tick(1_000)
    await settle()
    assert.equal(attempts, 2, 'a running runtime keeps retrying the pending closeout')
    live.lifecycle = 'stopped'
    for (let second = 0; second < 5; second += 1) {
      t.mock.timers.tick(1_000)
      await settle()
    }
    assert.equal(attempts, 2, 'a stopped runtime never retries again')
  } finally {
    unsubscribe()
  }
})
