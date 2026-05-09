import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PARALLEL_BRANCH_HARD_CAP,
  createParallelBranchOrchestrator,
  mergePatchesSerially,
} from '../main/modules/agent-control/parallel-branch-orchestrator'
import { __setMetricSinkForTests } from '../main/modules/agent-control/metrics'

test('PARALLEL_BRANCH_HARD_CAP is exactly 3', () => {
  assert.equal(PARALLEL_BRANCH_HARD_CAP, 3)
})

test('spawn rejects beyond hard cap and emits parallel_branch_hard_cap_reached metric', async () => {
  const orch = createParallelBranchOrchestrator()
  const events: Array<Record<string, unknown>> = []
  __setMetricSinkForTests((event) => events.push(event))
  try {
    // Fill the cap with branches that resolve only when we say so.
    let releaseA!: (v: unknown) => void
    let releaseB!: (v: unknown) => void
    let releaseC!: (v: unknown) => void
    const a = orch.spawn('a', () => new Promise((res) => { releaseA = res }))
    const b = orch.spawn('b', () => new Promise((res) => { releaseB = res }))
    const c = orch.spawn('c', () => new Promise((res) => { releaseC = res }))
    assert.ok(a)
    assert.ok(b)
    assert.ok(c)
    assert.equal(orch.getActive().length, 3)

    // 4th spawn must return null (over cap) and emit the metric.
    const overflow = orch.spawn('d', () => Promise.resolve('never'))
    assert.equal(overflow, null)
    const overflowEvents = events.filter(
      (e) => e.metric === 'parallel_branch_hard_cap_reached',
    )
    assert.equal(overflowEvents.length, 1)
    assert.equal(overflowEvents[0].active, 3)
    assert.equal(overflowEvents[0].hardCap, 3)
    assert.equal(overflowEvents[0].task, 'd')

    // Release all so awaitAll settles.
    releaseA('A')
    releaseB('B')
    releaseC('C')
    const results = await orch.awaitAll()
    assert.equal(results.length, 3)
    assert.deepEqual(
      results.map((r) => r.status),
      ['fulfilled', 'fulfilled', 'fulfilled'],
    )
    assert.deepEqual(
      results.map((r) => r.value),
      ['A', 'B', 'C'],
    )

    // After awaitAll, active should be empty so a fresh spawn is allowed.
    assert.equal(orch.getActive().length, 0)
    const next = orch.spawn('e', () => Promise.resolve('E'))
    assert.ok(next)
    await orch.awaitAll()
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('spawn passes a live AbortSignal that becomes aborted after cancel(branchId)', async () => {
  const orch = createParallelBranchOrchestrator()
  const captured: { signal: AbortSignal | null } = { signal: null }
  let abortObserved = false
  const branch = orch.spawn('cancellable', (signal) => {
    captured.signal = signal
    return new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        abortObserved = true
        resolve('cancelled')
      })
    })
  })
  assert.ok(branch)
  assert.ok(captured.signal)
  assert.equal(captured.signal!.aborted, false)

  orch.cancel(branch!.id)
  assert.equal(captured.signal!.aborted, true)

  const results = await orch.awaitAll()
  assert.equal(abortObserved, true)
  assert.equal(results.length, 1)
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[0].value, 'cancelled')
})

test('cancel on an unknown / already-settled branch is a no-op', async () => {
  const orch = createParallelBranchOrchestrator()
  // Unknown id — must not throw.
  orch.cancel('nonexistent-id')

  const branch = orch.spawn('quick', () => Promise.resolve('done'))
  assert.ok(branch)
  await orch.awaitAll()
  // After settle the branch is removed from active; cancel must be a no-op.
  orch.cancel(branch!.id)
})

test('awaitAll uses Promise.allSettled shape: rejected branches do not poison others', async () => {
  const orch = createParallelBranchOrchestrator()
  const ok = orch.spawn('ok', () => Promise.resolve(42))
  const bad = orch.spawn('bad', () => Promise.reject(new Error('boom')))
  assert.ok(ok)
  assert.ok(bad)

  const results = await orch.awaitAll()
  assert.equal(results.length, 2)
  const okR = results.find((r) => r.branchId === ok!.id)
  const badR = results.find((r) => r.branchId === bad!.id)
  assert.ok(okR)
  assert.ok(badR)
  assert.equal(okR!.status, 'fulfilled')
  assert.equal(okR!.value, 42)
  assert.equal(badR!.status, 'rejected')
  assert.ok(badR!.reason instanceof Error)
  assert.equal((badR!.reason as Error).message, 'boom')
})

test('awaitAll catches synchronous throws from the branch function', async () => {
  const orch = createParallelBranchOrchestrator()
  const branch = orch.spawn('sync-throw', () => {
    throw new Error('sync boom')
  })
  assert.ok(branch)
  const [result] = await orch.awaitAll()
  assert.equal(result.status, 'rejected')
  assert.ok(result.reason instanceof Error)
  assert.equal((result.reason as Error).message, 'sync boom')
})

test('awaitAllOrFirstFailure aborts siblings when one branch rejects', async () => {
  const orch = createParallelBranchOrchestrator()
  let siblingAborted = false
  let secondSiblingAborted = false
  const ok = orch.spawn('long-running', (signal) => {
    return new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        siblingAborted = true
        resolve('aborted-1')
      })
    })
  })
  const ok2 = orch.spawn('long-running-2', (signal) => {
    return new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        secondSiblingAborted = true
        resolve('aborted-2')
      })
    })
  })
  const bad = orch.spawn('failing', () => Promise.reject(new Error('first failure')))
  assert.ok(ok)
  assert.ok(ok2)
  assert.ok(bad)

  const results = await orch.awaitAllOrFirstFailure()
  assert.equal(results.length, 3)
  // All siblings observed the abort signal.
  assert.equal(siblingAborted, true)
  assert.equal(secondSiblingAborted, true)
  const badR = results.find((r) => r.branchId === bad!.id)
  assert.ok(badR)
  assert.equal(badR!.status, 'rejected')
  assert.equal((badR!.reason as Error).message, 'first failure')
})

test('awaitAllOrFirstFailure resolves cleanly when all branches succeed', async () => {
  const orch = createParallelBranchOrchestrator()
  const a = orch.spawn('a', () => Promise.resolve(1))
  const b = orch.spawn('b', () => Promise.resolve(2))
  assert.ok(a)
  assert.ok(b)
  const results = await orch.awaitAllOrFirstFailure()
  assert.equal(results.length, 2)
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled'])
})

test('mergePatchesSerially folds N branch patches deterministically (delegates to mergeTurnFramePatches)', () => {
  const merged = mergePatchesSerially([
    { activeArtifactRoots: ['/a', '/b'], terminalReason: 'done' },
    { activeArtifactRoots: ['/b', '/c'], livenessHint: 'running_process' },
    { discoveredHandles: { taskRunId: 'tr-1' } },
  ])
  // Concat-and-dedupe preserving first-seen order on activeArtifactRoots.
  assert.deepEqual(merged.activeArtifactRoots, ['/a', '/b', '/c'])
  assert.equal(merged.terminalReason, 'done')
  assert.equal(merged.livenessHint, 'running_process')
  assert.deepEqual(merged.discoveredHandles, { taskRunId: 'tr-1' })

  // Empty input → empty patch (no spurious fields).
  const empty = mergePatchesSerially([])
  assert.deepEqual(empty, {})
})
