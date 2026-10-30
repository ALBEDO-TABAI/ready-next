import assert from 'node:assert/strict'
import test from 'node:test'

import { runBeforeQuitCleanup } from '../main/modules/process-cleanup/before-quit'
import { GracefulWindowCloseCoordinator } from '../main/modules/process-cleanup/graceful-window-close-coordinator'

interface Recorder {
  log: string[]
  warn: string[]
  error: string[]
}

function makeLogger(): { logger: Pick<Console, 'log' | 'warn' | 'error'>; rec: Recorder } {
  const rec: Recorder = { log: [], warn: [], error: [] }
  const logger = {
    log: (...args: unknown[]) => { rec.log.push(args.map(String).join(' ')) },
    warn: (...args: unknown[]) => { rec.warn.push(args.map(String).join(' ')) },
    error: (...args: unknown[]) => { rec.error.push(args.map(String).join(' ')) },
  }
  return { logger, rec }
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (err: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const noOpExitLease = () => ({ release: () => undefined })

test('runBeforeQuitCleanup awaits all three async cleanups before closing DB', async () => {
  const order: string[] = []
  const { logger } = makeLogger()

  const runtime = deferred<void>()
  const agent = deferred<void>()
  const rss = deferred<void>()

  const promise = runBeforeQuitCleanup({
    cleanupAgentRuntime: async () => { await runtime.promise; order.push('runtime') },
    cleanupAgentManager: async () => { await agent.promise; order.push('agent') },
    cleanupRsshubManager: async () => { await rss.promise; order.push('rss') },
    closeDatabase: () => { order.push('db') },
    logger,
  }, { timeoutMs: 1_000 })

  // None of the cleanups should have settled yet, so the DB must not have closed.
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(order, [])

  runtime.resolve()
  agent.resolve()
  rss.resolve()
  await promise

  // DB must come last; the three cleanups can finish in any order.
  assert.equal(order[order.length - 1], 'db')
  assert.equal(order.length, 4)
  assert.ok(order.includes('runtime'))
  assert.ok(order.includes('agent'))
  assert.ok(order.includes('rss'))
})

test('runBeforeQuitCleanup awaits renderer state flush before closing DB', async () => {
  const order: string[] = []
  const { logger } = makeLogger()

  await runBeforeQuitCleanup({
    cleanupAgentRuntime: () => { order.push('runtime') },
    cleanupAgentManager: () => { order.push('agent') },
    cleanupRsshubManager: () => { order.push('rss') },
    cleanupRendererState: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push('renderer-state')
    },
    closeDatabase: () => { order.push('db') },
    logger,
  }, { timeoutMs: 1_000 })

  assert.ok(order.includes('renderer-state'))
  assert.equal(order[order.length - 1], 'db')
})

test('runBeforeQuitCleanup settles book-source jobs before closing DB', async () => {
  const order: string[] = []
  const { logger } = makeLogger()

  await runBeforeQuitCleanup({
    cleanupAgentRuntime: () => { order.push('runtime') },
    cleanupAgentManager: () => { order.push('agent') },
    cleanupRsshubManager: () => { order.push('rss') },
    cleanupLibrarySources: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push('library-sources')
    },
    closeDatabase: () => { order.push('db') },
    logger,
  }, { timeoutMs: 1_000 })

  assert.ok(order.includes('library-sources'))
  assert.equal(order[order.length - 1], 'db')
})

test('runBeforeQuitCleanup honours the timeout when one cleanup hangs', async () => {
  const order: string[] = []
  const { logger, rec } = makeLogger()
  // Resolve well past the timeout; this simulates a "hung" cleanup without
  // leaving a permanently-pending promise that would be flagged by node:test
  // after the test returns. Keep the timer ref'd so node doesn't drop the
  // event loop and node:test stays happy.
  const hang = new Promise<void>((resolve) => { setTimeout(resolve, 200) })

  const start = Date.now()
  await runBeforeQuitCleanup({
    cleanupAgentRuntime: async () => { order.push('runtime') },
    cleanupAgentManager: () => hang,
    cleanupRsshubManager: async () => { order.push('rss') },
    closeDatabase: () => { order.push('db') },
    logger,
  }, { timeoutMs: 50 })
  const elapsed = Date.now() - start

  // The DB must still close, and we must not have waited for the hung cleanup.
  assert.equal(order[order.length - 1], 'db')
  assert.ok(order.includes('runtime'))
  assert.ok(order.includes('rss'))
  assert.ok(elapsed < 180, `expected timeout-bounded exit (~50ms), elapsed=${elapsed}ms`)
  assert.ok(rec.warn.some((m) => m.includes('cleanup timed out')), 'expected timeout warning')

  // Drain the lingering cleanup so node:test sees a clean event loop.
  await hang
})

test('runBeforeQuitCleanup never closes DB while the critical agent runtime is still settling', async () => {
  const order: string[] = []
  const { logger } = makeLogger()
  const runtime = deferred<void>()
  const cleanup = runBeforeQuitCleanup({
    cleanupAgentRuntime: async () => { await runtime.promise; order.push('runtime') },
    cleanupAgentManager: async () => { order.push('agent') },
    cleanupRsshubManager: async () => { order.push('rss') },
    closeDatabase: () => { order.push('db') },
    logger,
  }, { timeoutMs: 10 })

  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(order, [])
  runtime.resolve()
  await cleanup
  assert.deepEqual(order, ['runtime', 'agent', 'rss', 'db'])
})

test('runBeforeQuitCleanup runs cleanups in parallel, not sequentially', async () => {
  const { logger } = makeLogger()
  const start = Date.now()
  await runBeforeQuitCleanup({
    cleanupAgentRuntime: () => new Promise((r) => setTimeout(r, 60)),
    cleanupAgentManager: () => new Promise((r) => setTimeout(r, 60)),
    cleanupRsshubManager: () => new Promise((r) => setTimeout(r, 60)),
    closeDatabase: () => {},
    logger,
  }, { timeoutMs: 5_000 })
  const elapsed = Date.now() - start
  assert.ok(elapsed < 200, `parallel cleanups should complete in ~60ms, elapsed=${elapsed}ms`)
})

test('runBeforeQuitCleanup cancels quit when the critical runtime cannot prove shutdown', async () => {
  const order: string[] = []
  const { logger, rec } = makeLogger()

  await assert.rejects(runBeforeQuitCleanup({
    cleanupAgentRuntime: async () => { throw new Error('runtime boom') },
    cleanupAgentManager: async () => { order.push('agent') },
    cleanupRsshubManager: async () => { order.push('rss') },
    closeDatabase: () => { order.push('db') },
    logger,
  }, { timeoutMs: 1_000 }), /runtime boom/)

  assert.deepEqual(order, [])
  assert.ok(rec.warn.some((m) => m.includes('cleanupAgentRuntime')), 'expected warn about failing cleanup')
})

test('runBeforeQuitCleanup does not throw when closeDatabase fails', async () => {
  const { logger, rec } = makeLogger()
  await runBeforeQuitCleanup({
    cleanupAgentRuntime: async () => {},
    cleanupAgentManager: async () => {},
    cleanupRsshubManager: async () => {},
    closeDatabase: () => { throw new Error('db boom') },
    logger,
  }, { timeoutMs: 1_000 })
  assert.ok(rec.warn.some((m) => m.includes('db.close failed')), 'expected db.close warn')
})

test('runBeforeQuitCleanup tolerates synchronous void cleanups', async () => {
  const order: string[] = []
  const { logger } = makeLogger()
  await runBeforeQuitCleanup({
    cleanupAgentRuntime: () => { order.push('runtime') },
    cleanupAgentManager: () => { order.push('agent') },
    cleanupRsshubManager: () => { order.push('rss') },
    closeDatabase: () => { order.push('db') },
    logger,
  })
  assert.equal(order[order.length - 1], 'db')
  assert.equal(order.length, 4)
})

test('graceful exit prevents every repeated quit until flush and cleanup finish', async () => {
  const flush = deferred<void>()
  let flushes = 0
  let cleanups = 0
  let quits = 0
  let prevented = 0
  const coordinator = new GracefulWindowCloseCoordinator({
    flushRendererState: () => { flushes += 1; return flush.promise.then(noOpExitLease) },
    cleanupBeforeQuit: async () => { cleanups += 1 },
    requestWindowClose: () => assert.fail('quit must not request window-only close'),
    requestAppQuit: () => { quits += 1 },
    onFailure: (error) => assert.fail(String(error)),
  })
  const event = { preventDefault: () => { prevented += 1 } }

  coordinator.handleBeforeQuit(event)
  coordinator.handleBeforeQuit(event)
  assert.equal(prevented, 2)
  assert.equal(flushes, 1)
  assert.equal(quits, 0)

  flush.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(cleanups, 1)
  assert.equal(quits, 1)

  coordinator.handleBeforeQuit(event)
  assert.equal(prevented, 2, 'the coordinator must allow only its own final quit')
})

test('window close flushes renderer state before allowing the same close event path', async () => {
  let prevented = 0
  let requestedClose = 0
  let cleanups = 0
  let releases = 0
  const coordinator = new GracefulWindowCloseCoordinator({
    flushRendererState: async () => ({ release: () => { releases += 1 } }),
    cleanupBeforeQuit: async () => { cleanups += 1 },
    requestWindowClose: () => { requestedClose += 1 },
    requestAppQuit: () => assert.fail('window close must not quit the macOS app'),
    onFailure: (error) => assert.fail(String(error)),
  })
  const event = { preventDefault: () => { prevented += 1 } }

  coordinator.handleWindowClose(event)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(prevented, 1)
  assert.equal(requestedClose, 1)
  assert.equal(cleanups, 0)

  coordinator.handleWindowClose(event)
  assert.equal(prevented, 1)
  assert.equal(coordinator.getStateForTests(), 'idle')
  assert.equal(releases, 0, 'the lease stays held until the BrowserWindow closed event')
  coordinator.handleWindowClosed()
  assert.equal(releases, 1)
})

test('app quit upgrades an in-flight window close without starting a second flush', async () => {
  const flush = deferred<void>()
  let flushes = 0
  let closeRequests = 0
  let quitRequests = 0
  let prevented = 0
  const coordinator = new GracefulWindowCloseCoordinator({
    flushRendererState: () => { flushes += 1; return flush.promise.then(noOpExitLease) },
    cleanupBeforeQuit: async () => undefined,
    requestWindowClose: () => { closeRequests += 1 },
    requestAppQuit: () => { quitRequests += 1 },
    onFailure: (error) => assert.fail(String(error)),
  })
  const event = { preventDefault: () => { prevented += 1 } }

  coordinator.handleWindowClose(event)
  coordinator.handleBeforeQuit(event)
  flush.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.equal(prevented, 2)
  assert.equal(flushes, 1)
  assert.equal(closeRequests, 0)
  assert.equal(quitRequests, 1)
})

test('flush failure keeps the window open and permits a later clean retry', async () => {
  let shouldFail = true
  let failures = 0
  let closes = 0
  const coordinator = new GracefulWindowCloseCoordinator({
    flushRendererState: async () => {
      if (shouldFail) throw new Error('disk full')
      return noOpExitLease()
    },
    cleanupBeforeQuit: async () => undefined,
    requestWindowClose: () => { closes += 1 },
    requestAppQuit: () => assert.fail('window retry must not quit the app'),
    onFailure: (error) => {
      failures += 1
      assert.match(String(error), /disk full/)
    },
  })
  const event = { preventDefault: () => undefined }

  coordinator.handleWindowClose(event)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(failures, 1)
  assert.equal(closes, 0)
  assert.equal(coordinator.getStateForTests(), 'idle')

  shouldFail = false
  coordinator.handleWindowClose(event)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(closes, 1)
})

for (const failingStep of ['close', 'cleanup', 'quit'] as const) {
  test(`a ${failingStep} action failure releases the successful renderer flush lease`, async () => {
    let releases = 0
    let failures = 0
    const coordinator = new GracefulWindowCloseCoordinator({
      flushRendererState: async () => ({ release: () => { releases += 1 } }),
      cleanupBeforeQuit: async () => {
        if (failingStep === 'cleanup') throw new Error('cleanup failed')
      },
      requestWindowClose: () => {
        if (failingStep === 'close') throw new Error('close failed')
      },
      requestAppQuit: () => {
        if (failingStep === 'quit') throw new Error('quit failed')
      },
      onFailure: () => { failures += 1 },
    })
    const event = { preventDefault: () => undefined }

    if (failingStep === 'close') coordinator.handleWindowClose(event)
    else coordinator.handleBeforeQuit(event)
    await new Promise<void>((resolve) => setImmediate(resolve))

    assert.equal(failures, 1)
    assert.equal(releases, 1)
    assert.equal(coordinator.getStateForTests(), 'idle')
  })
}
