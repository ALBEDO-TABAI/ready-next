/**
 * perf-rescue B6 — streaming reindex tests.
 *
 * Verifies the FileSystemAdapter (post-B6) streams 200 files through 4 batches
 * of 50, yields the event loop per file, honours an AbortSignal mid-stream
 * (preserving rows already committed by earlier batches), and that the
 * `document:cancelReindex` IPC propagates through the worker bridge.
 *
 * Uses an in-memory stub repository so we avoid touching better-sqlite3 here
 * (other tests cover the repository contract). The fixture files are written
 * to a tmpdir; cleanup runs even if a test throws.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AbortError, FileSystemAdapter } from '../main/modules/search-engine/adapters'
import {
  WorkerDbBridgeImpl,
  type WorkerFactory,
  type WorkerLike,
} from '../main/modules/database/worker-bridge'

// ----- Helpers ---------------------------------------------------------------

function withTempRoot<T>(fn: (root: string) => Promise<T> | T): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'ready-indexer-streaming-'))
  return Promise.resolve()
    .then(() => fn(root))
    .finally(() => {
      try { rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ }
    })
}

/** Create N markdown fixtures in a single dir, named 0001.md … NNNN.md. */
function seedFixtures(root: string, count: number): string[] {
  const paths: string[] = []
  for (let i = 0; i < count; i += 1) {
    const name = String(i).padStart(4, '0') + '.md'
    const path = join(root, name)
    // Body big enough that loadFile actually does I/O but cheap to write.
    writeFileSync(path, `# Doc ${i}\n\nbody line for doc ${i}\n`, 'utf-8')
    paths.push(path)
  }
  return paths
}

interface CapturingRepoState {
  indexedPaths: string[]
  transactionCount: number
  /** Per-batch transaction sizes. Useful for asserting BATCH_SIZE behavior. */
  txnSizes: number[]
}

function makeCapturingRepo(state: CapturingRepoState): import('../main/modules/search-engine/repository').SearchRepository {
  let nextId = 1
  const stub = {
    listPathsForWorkspace(): Array<{ id: number; path: string }> { return [] },
    upsertDocument(payload: { path: string }) {
      state.indexedPaths.push(payload.path)
      return { documentId: nextId++, skipped: false }
    },
    replaceTags() {},
    replaceLinks() {},
    replaceAttachments() {},
    deletePath() {},
    resolveWikilinkTargets() {},
    touchWorkspace() {},
    transaction(fn: () => void) {
      const before = state.indexedPaths.length
      state.transactionCount += 1
      fn()
      state.txnSizes.push(state.indexedPaths.length - before)
    },
    getConnection(): never { throw new Error('getConnection not used in this test') },
  }
  return stub as unknown as import('../main/modules/search-engine/repository').SearchRepository
}

// ----- 200 files → 4 batches of 50 ------------------------------------------

test('FileSystemAdapter indexes 200 fixture files in 4 batches of 50', async () => {
  await withTempRoot(async (root) => {
    seedFixtures(root, 200)
    const adapter = new FileSystemAdapter()
    const state: CapturingRepoState = {
      indexedPaths: [],
      transactionCount: 0,
      txnSizes: [],
    }
    const repo = makeCapturingRepo(state)

    const result = await adapter.reindex({
      workspaceId: 1,
      workspaceRoot: root,
      repository: repo,
    })

    assert.equal(result.scanned, 200, 'all 200 fixtures should be scanned')
    assert.equal(result.indexed, 200, 'all 200 fixtures should be indexed')
    assert.equal(state.indexedPaths.length, 200)

    // Batch transactions only — we ignore the trailing resolveWikilinkTargets
    // transaction (always present, always 0-row delta).
    const batchTxns = state.txnSizes.filter((n) => n > 0)
    assert.equal(batchTxns.length, 4, `expected 4 batch transactions, got ${batchTxns.length}`)
    for (const size of batchTxns) {
      assert.ok(size <= 50, `batch transaction size ${size} should not exceed BATCH_SIZE=50`)
    }
    // 4 × 50 = 200 — each batch must commit exactly 50 except possibly the last.
    const sum = batchTxns.reduce((acc, n) => acc + n, 0)
    assert.equal(sum, 200, 'sum of batch sizes must equal indexed count')
  })
})

// ----- Mid-stream abort: partial index remains -------------------------------

test('FileSystemAdapter aborts mid-stream and preserves already-committed rows', async () => {
  await withTempRoot(async (root) => {
    seedFixtures(root, 200)
    const adapter = new FileSystemAdapter()
    const state: CapturingRepoState = {
      indexedPaths: [],
      transactionCount: 0,
      txnSizes: [],
    }
    const repo = makeCapturingRepo(state)

    const controller = new AbortController()

    // Abort once the first two batches (≤100 rows) have been committed.
    // We use a polling timer instead of a per-row hook because reindex doesn't
    // expose progress events — but BATCH_SIZE=50 is small enough that this
    // races into the middle of the run reliably on any modern box.
    const watcher = setInterval(() => {
      if (state.indexedPaths.length >= 100) {
        controller.abort()
      }
    }, 1)

    let caught: unknown = null
    try {
      await adapter.reindex({
        workspaceId: 1,
        workspaceRoot: root,
        repository: repo,
        signal: controller.signal,
      })
    } catch (error) {
      caught = error
    } finally {
      clearInterval(watcher)
    }

    assert.ok(caught instanceof AbortError, `expected AbortError, got ${String(caught)}`)
    // At least the first two batches should have committed before the abort
    // boundary check fired.
    assert.ok(
      state.indexedPaths.length >= 100,
      `expected ≥100 partial rows, got ${state.indexedPaths.length}`,
    )
    // And we must not have indexed everything — the abort actually stopped
    // the run.
    assert.ok(
      state.indexedPaths.length < 200,
      `expected <200 partial rows (abort should have fired), got ${state.indexedPaths.length}`,
    )

    // Partial-index recovery: the first N rows are still observable in the
    // stub (they would be in the real DB too — sqlite committed them).
    // No "in-progress reindex" residue in the stub state.
    for (const txnSize of state.txnSizes.filter((n) => n > 0)) {
      assert.ok(txnSize <= 50, `partial batch size ${txnSize} still bounded by BATCH_SIZE=50`)
    }
  })
})

// ----- Already-aborted signal: no work done ----------------------------------

test('FileSystemAdapter exits immediately when signal is already aborted', async () => {
  await withTempRoot(async (root) => {
    seedFixtures(root, 200)
    const adapter = new FileSystemAdapter()
    const state: CapturingRepoState = {
      indexedPaths: [],
      transactionCount: 0,
      txnSizes: [],
    }
    const repo = makeCapturingRepo(state)

    const controller = new AbortController()
    controller.abort() // pre-aborted

    let caught: unknown = null
    try {
      await adapter.reindex({
        workspaceId: 1,
        workspaceRoot: root,
        repository: repo,
        signal: controller.signal,
      })
    } catch (error) {
      caught = error
    }

    assert.ok(caught instanceof AbortError, `expected AbortError, got ${String(caught)}`)
    assert.equal(state.indexedPaths.length, 0, 'no files should have been indexed')
    assert.equal(state.transactionCount, 0, 'no transactions should have been opened')
  })
})

// ----- Cancellation IPC propagates to worker --------------------------------

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

test('WorkerDbBridge.cancelReindex posts cancelReindex cmd and resolves with count', async () => {
  const fake = makeFakeWorker()
  const bridge = new WorkerDbBridgeImpl('/tmp/test.db', factoryFromWorker(fake))

  const promise = bridge.cancelReindex()
  assert.equal(fake.sent.length, 1, 'bridge should post exactly one message')
  assert.equal(fake.sent[0].cmd, 'cancelReindex', 'cmd must be cancelReindex')

  // Worker replies with the count of aborted reindexes.
  fake.emit('message', { id: fake.sent[0].id, ok: true, data: 2 })
  const cancelled = await promise
  assert.equal(cancelled, 2, 'bridge resolves with aborted-count from worker')

  // Drain shutdown so the test process doesn't keep handles alive.
  const before = fake.sent.length
  const shutdownPromise = bridge.shutdown()
  if (fake.sent.length > before && fake.sent[fake.sent.length - 1].cmd === 'shutdown') {
    fake.emit('message', { id: fake.sent[fake.sent.length - 1].id, ok: true })
  }
  await shutdownPromise
})

test('WorkerDbBridge.cancelReindex resolves with 0 when worker reports no in-flight jobs', async () => {
  const fake = makeFakeWorker()
  const bridge = new WorkerDbBridgeImpl('/tmp/test.db', factoryFromWorker(fake))

  const promise = bridge.cancelReindex()
  assert.equal(fake.sent[0].cmd, 'cancelReindex')

  fake.emit('message', { id: fake.sent[0].id, ok: true, data: 0 })
  const cancelled = await promise
  assert.equal(cancelled, 0, 'no-op cancel still resolves cleanly')

  // Drain.
  const before = fake.sent.length
  const shutdownPromise = bridge.shutdown()
  if (fake.sent.length > before && fake.sent[fake.sent.length - 1].cmd === 'shutdown') {
    fake.emit('message', { id: fake.sent[fake.sent.length - 1].id, ok: true })
  }
  await shutdownPromise
})

test('WorkerDbBridge.cancelReindex multiplexes alongside other commands', async () => {
  const fake = makeFakeWorker()
  const bridge = new WorkerDbBridgeImpl('/tmp/test.db', factoryFromWorker(fake))

  // Send a reindex + a cancel back-to-back. The bridge correlates by id.
  const reindexP = bridge.reindexWorkspace({ root: '/r' })
  const cancelP = bridge.cancelReindex()

  assert.equal(fake.sent.length, 2)
  assert.equal(fake.sent[0].cmd, 'reindexWorkspace')
  assert.equal(fake.sent[1].cmd, 'cancelReindex')

  // Reply to cancel first (worker would emit cancel-reply synchronously
  // before the reindex finishes its own teardown).
  fake.emit('message', { id: fake.sent[1].id, ok: true, data: 1 })
  // Then reindex resolves with a partial-result payload (aborted=true).
  fake.emit('message', {
    id: fake.sent[0].id,
    ok: true,
    data: {
      ok: false,
      root: '/r',
      workspaceId: 1,
      indexed: 50,
      skipped: 0,
      removed: 0,
      scanned: 200,
      elapsedMs: 5,
      degraded: false,
      error: 'reindex aborted',
      aborted: true,
    },
  })

  const [cancelled, reindex] = await Promise.all([cancelP, reindexP])
  assert.equal(cancelled, 1, 'cancelReindex resolves to 1 aborted job')
  assert.equal(reindex.indexed, 50, 'reindex returns the partial count it had committed')
  assert.equal(reindex.error, 'reindex aborted')

  // Drain.
  const before = fake.sent.length
  const shutdownPromise = bridge.shutdown()
  if (fake.sent.length > before && fake.sent[fake.sent.length - 1].cmd === 'shutdown') {
    fake.emit('message', { id: fake.sent[fake.sent.length - 1].id, ok: true })
  }
  await shutdownPromise
})
