import assert from 'node:assert/strict'
import test from 'node:test'

import { runBeforeQuitCleanup } from '../main/modules/process-cleanup/before-quit'

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
    cleanupAgentRuntime: () => hang,
    cleanupAgentManager: async () => { order.push('agent') },
    cleanupRsshubManager: async () => { order.push('rss') },
    closeDatabase: () => { order.push('db') },
    logger,
  }, { timeoutMs: 50 })
  const elapsed = Date.now() - start

  // The DB must still close, and we must not have waited for the hung cleanup.
  assert.equal(order[order.length - 1], 'db')
  assert.ok(order.includes('agent'))
  assert.ok(order.includes('rss'))
  assert.ok(elapsed < 180, `expected timeout-bounded exit (~50ms), elapsed=${elapsed}ms`)
  assert.ok(rec.warn.some((m) => m.includes('cleanup timed out')), 'expected timeout warning')

  // Drain the lingering cleanup so node:test sees a clean event loop.
  await hang
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

test('runBeforeQuitCleanup does not let one rejecting cleanup abort the others or the DB close', async () => {
  const order: string[] = []
  const { logger, rec } = makeLogger()

  await runBeforeQuitCleanup({
    cleanupAgentRuntime: async () => { throw new Error('runtime boom') },
    cleanupAgentManager: async () => { order.push('agent') },
    cleanupRsshubManager: async () => { order.push('rss') },
    closeDatabase: () => { order.push('db') },
    logger,
  }, { timeoutMs: 1_000 })

  assert.ok(order.includes('agent'))
  assert.ok(order.includes('rss'))
  assert.equal(order[order.length - 1], 'db')
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

test('index.ts before-quit handler installs a re-entry guard and awaits cleanup', async () => {
  // Contract test: ensure the handler in src/main/index.ts (which we cannot
  // execute without electron) preserves the safety properties. If someone
  // accidentally drops the guard or the await, this fails loudly.
  const { readFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const src = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')

  // Re-entry guard variable + check.
  assert.match(src, /let isQuitting = false/, 'isQuitting flag must be declared')
  assert.match(src, /if \(isQuitting\) return/, 'before-quit must short-circuit on re-entry')

  // Default electron exit must be cancelled so cleanup can run.
  assert.match(src, /event\.preventDefault\(\)/)

  // Cleanup must be invoked through the awaitable helper, not as `void cleanupAgentRuntime()`.
  assert.match(src, /runBeforeQuitCleanup\(\{[\s\S]*cleanupAgentRuntime[\s\S]*closeDatabase[\s\S]*\}\)/)
  assert.doesNotMatch(src, /\bvoid cleanupAgentRuntime\(\)/, 'fire-and-forget cleanup regression')

  // Quit must be re-triggered after cleanup so the app actually exits; the
  // isQuitting guard above prevents this from looping.
  assert.match(src, /\.finally\(\(\) => \{[\s\S]*app\.quit\(\)[\s\S]*\}\)/)
})
