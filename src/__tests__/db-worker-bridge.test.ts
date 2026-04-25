/**
 * perf-rescue B1 — WorkerDbBridge unit tests.
 *
 * Verifies the request/response correlation, restart-on-crash policy, and
 * graceful shutdown contract. Uses a fake `WorkerLike` so no actual
 * worker_thread is spawned (tests stay deterministic and fast).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WorkerDbBridgeImpl,
  type WorkerFactory,
  type WorkerLike,
} from '../main/modules/database/worker-bridge'

interface FakeWorker extends WorkerLike {
  sent: Array<{ id: number; cmd: string; args?: unknown }>
  emit(event: 'message' | 'error' | 'exit', payload: unknown): void
  terminated: boolean
}

function makeFakeWorker(): FakeWorker {
  const handlers: Record<string, Array<(payload: unknown) => void>> = {}
  const sent: Array<{ id: number; cmd: string; args?: unknown }> = []
  const fake: FakeWorker = {
    sent,
    terminated: false,
    postMessage(value: unknown) {
      sent.push(value as { id: number; cmd: string; args?: unknown })
    },
    on(event: string, listener: (payload: unknown) => void) {
      if (!handlers[event]) handlers[event] = []
      handlers[event].push(listener)
    },
    emit(event: string, payload: unknown) {
      const list = handlers[event] ?? []
      for (const fn of list) fn(payload)
    },
    terminate() {
      fake.terminated = true
      return Promise.resolve(0)
    },
  }
  return fake
}

function factoryFromWorker(worker: FakeWorker): WorkerFactory {
  return () => worker
}

function factoryFromFactory(spawn: () => FakeWorker): { factory: WorkerFactory; spawned: FakeWorker[] } {
  const spawned: FakeWorker[] = []
  const factory: WorkerFactory = () => {
    const w = spawn()
    spawned.push(w)
    return w
  }
  return { factory, spawned }
}

/**
 * Drain shutdown deterministically. The bridge posts a `shutdown` cmd and
 * waits up to 1s for an ack; if we reply immediately the test stays fast.
 */
async function shutdownAndDrain(bridge: WorkerDbBridgeImpl, fake: FakeWorker | null): Promise<void> {
  const before = fake?.sent.length ?? 0
  const promise = bridge.shutdown()
  if (fake) {
    const last = fake.sent[fake.sent.length - 1]
    if (last && fake.sent.length > before && last.cmd === 'shutdown') {
      fake.emit('message', { id: last.id, ok: true })
    }
  }
  await promise
}

test('bridge correlates request id to response and resolves with data', async () => {
  const fake = makeFakeWorker()
  const bridge = new WorkerDbBridgeImpl('/tmp/test.db', factoryFromWorker(fake))

  const promise = bridge.getDocumentGraph({ depth: 2 })

  // Bridge should have posted exactly one message with id=1.
  assert.equal(fake.sent.length, 1)
  assert.equal(fake.sent[0].id, 1)
  assert.equal(fake.sent[0].cmd, 'getDocumentGraph')
  // Bridge forwards the original opts object verbatim; only `depth` is set.
  assert.equal((fake.sent[0].args as { depth: number }).depth, 2)

  const expected = { nodes: [{ id: 'doc:1', type: 'doc' as const, label: 'a' }], edges: [] }
  fake.emit('message', { id: 1, ok: true, data: expected })
  const result = await promise
  assert.deepEqual(result, expected)

  await shutdownAndDrain(bridge, fake)
})

test('bridge rejects with worker-side error preserving message', async () => {
  const fake = makeFakeWorker()
  const bridge = new WorkerDbBridgeImpl('/tmp/test.db', factoryFromWorker(fake))

  const promise = bridge.searchDocuments({ query: 'foo' })
  fake.emit('message', { id: 1, ok: false, error: { message: 'boom' } })

  await assert.rejects(promise, /boom/)
  await shutdownAndDrain(bridge, fake)
})

test('bridge multiplexes concurrent requests by id', async () => {
  const fake = makeFakeWorker()
  const bridge = new WorkerDbBridgeImpl('/tmp/test.db', factoryFromWorker(fake))

  const p1 = bridge.getDocumentGraph({ depth: 1 })
  const p2 = bridge.searchDocuments({ query: 'q' })
  const p3 = bridge.reindexWorkspace({ root: '/r' })

  assert.deepEqual(fake.sent.map((m) => m.id), [1, 2, 3])
  assert.deepEqual(fake.sent.map((m) => m.cmd), ['getDocumentGraph', 'searchDocuments', 'reindexWorkspace'])

  // Reply out of order.
  fake.emit('message', { id: 2, ok: true, data: { items: [], stats: { returned: 0, elapsedMs: 1 }, degraded: false } })
  fake.emit('message', { id: 3, ok: true, data: { ok: true, root: '/r', workspaceId: 1, indexed: 0, skipped: 0, removed: 0, scanned: 0, elapsedMs: 1, degraded: false } })
  fake.emit('message', { id: 1, ok: true, data: { nodes: [], edges: [] } })

  const [r1, r2, r3] = await Promise.all([p1, p2, p3])
  assert.deepEqual(r1, { nodes: [], edges: [] })
  assert.equal(r2.stats.returned, 0)
  assert.equal(r3.indexed, 0)

  await shutdownAndDrain(bridge, fake)
})

test('bridge rejects pending requests when worker exits unexpectedly', async () => {
  const { factory, spawned } = factoryFromFactory(() => makeFakeWorker())
  const bridge = new WorkerDbBridgeImpl('/tmp/test.db', factory)

  const promise = bridge.getDocumentGraph({ depth: 2 })
  // Crash the worker.
  spawned[0].emit('error', new Error('oom'))
  spawned[0].emit('exit', 137)

  await assert.rejects(promise, /(db-worker errored|db-worker exited|oom)/)

  // After restart, the bridge must spawn a new worker.
  assert.equal(spawned.length, 2, `expected restart, got ${spawned.length} workers`)

  // The latest spawned worker is the one shutdown will talk to.
  await shutdownAndDrain(bridge, spawned[spawned.length - 1])
})

test('bridge stops restarting after MAX_RESTARTS=3 and rejects further sends', async () => {
  const { factory, spawned } = factoryFromFactory(() => makeFakeWorker())
  const bridge = new WorkerDbBridgeImpl('/tmp/test.db', factory)

  // Initial spawn = 1; crash 3 times -> 3 restarts -> total 4 workers.
  for (let i = 0; i < 4; i += 1) {
    spawned[i].emit('exit', 1)
  }
  // Should NOT have spawned a 5th worker.
  assert.equal(spawned.length, 4, `expected 4 spawns total, got ${spawned.length}`)

  await assert.rejects(bridge.getDocumentGraph({ depth: 2 }), /terminated/)

  // After max-restarts the bridge has no live worker, so shutdown is a fast
  // no-op (no `fake` to drain).
  await shutdownAndDrain(bridge, null)
})

test('bridge.shutdown sends shutdown cmd, terminates worker, and rejects pending', async () => {
  const fake = makeFakeWorker()
  const bridge = new WorkerDbBridgeImpl('/tmp/test.db', factoryFromWorker(fake))

  // Issue a pending request that we'll never reply to.
  const pending = bridge.getDocumentGraph({ depth: 1 })
  // Pre-arm the rejection assertion so node:test owns the promise even if
  // shutdown completes before we get a chance to await it.
  const pendingRejection = assert.rejects(pending, /shutdown/)

  const shutdownPromise = bridge.shutdown()

  // Bridge should have queued a `shutdown` cmd. Reply ok so the inner race
  // resolves quickly instead of hitting the 1s timeout.
  // First message was getDocumentGraph (id=1), second is shutdown (id=2).
  assert.equal(fake.sent.length, 2)
  assert.equal(fake.sent[1].cmd, 'shutdown')
  fake.emit('message', { id: fake.sent[1].id, ok: true })

  await shutdownPromise
  assert.equal(fake.terminated, true, 'fake worker should be terminated')

  // The pending getDocumentGraph must reject with the shutdown error.
  await pendingRejection
})

test('bridge surfaces postMessage throw as rejection', async () => {
  const fake = makeFakeWorker()
  // Override only after the test request — we still need the shutdown to
  // post() successfully, otherwise the bridge can't ack-and-drain.
  let throwOnNext = false
  const realPost = fake.postMessage.bind(fake)
  fake.postMessage = (value: unknown) => {
    if (throwOnNext) {
      throwOnNext = false
      throw new Error('queue full')
    }
    realPost(value)
  }
  const bridge = new WorkerDbBridgeImpl('/tmp/test.db', factoryFromWorker(fake))

  throwOnNext = true
  await assert.rejects(bridge.getDocumentGraph({ depth: 1 }), /queue full/)
  await shutdownAndDrain(bridge, fake)
})
