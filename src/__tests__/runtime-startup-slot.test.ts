import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RuntimeStartupSlot,
  agentRuntimeStartCancelled,
  isAgentRuntimeStartCancelled,
  startRendererBeforeRuntimeReady,
} from '../main/modules/claude-bridge/runtime-startup-slot'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

test('pending runtime startup cannot promote after cleanup and drains the late candidate', async () => {
  const start = deferred<void>()
  const calls: string[] = []
  const candidate = {
    async start() { calls.push('start'); await start.promise },
    async stop() { calls.push('stop') },
  }
  const slot = new RuntimeStartupSlot(candidate)
  let promoted = false
  const promotion = slot.promote().then(() => { promoted = true })
  const cleanup = slot.cancelAndDrain()
  assert.deepEqual(calls, ['start', 'stop'])

  start.resolve()
  await assert.rejects(promotion, /agent_runtime_start_cancelled/)
  await cleanup
  assert.equal(promoted, false)
  assert.deepEqual(calls, ['start', 'stop', 'stop', 'stop'])
  assert.deepEqual(slot.snapshot(), { cancelled: true, settled: true })
})

test('rejected runtime startup stops its candidate and leaves the slot settled', async () => {
  const start = deferred<void>()
  let stopCount = 0
  const candidate = {
    async start() { await start.promise },
    async stop() { stopCount += 1 },
  }
  const slot = new RuntimeStartupSlot(candidate)
  const promotion = slot.promote()
  start.reject(new Error('startup_failed'))

  await assert.rejects(promotion, /startup_failed/)
  assert.equal(stopCount, 1)
  assert.deepEqual(slot.snapshot(), { cancelled: false, settled: true })
})

test('workbench renderer starts while Agent initialization is still pending', async () => {
  const start = deferred<void>()
  const calls: string[] = []
  const boot = startRendererBeforeRuntimeReady({
    async startRuntime() {
      calls.push('agent:start')
      await start.promise
      calls.push('agent:ready')
    },
    startRenderer() { calls.push('renderer:start') },
  })

  await Promise.resolve()
  assert.deepEqual(calls, ['agent:start', 'renderer:start'])
  start.resolve()
  await boot
  assert.deepEqual(calls, ['agent:start', 'renderer:start', 'agent:ready'])
})

test('synchronous Agent setup failure still starts the workbench renderer', async () => {
  const calls: string[] = []
  await assert.rejects(startRendererBeforeRuntimeReady({
    startRuntime() {
      calls.push('agent:start')
      throw new Error('agent_boot_failed')
    },
    startRenderer() { calls.push('renderer:start') },
  }), /agent_boot_failed/)
  assert.deepEqual(calls, ['agent:start', 'renderer:start'])
})

test('a runtime start cancelled by shutdown resolves as cancelled instead of failing the window setup', async () => {
  const calls: string[] = []
  const outcome = await startRendererBeforeRuntimeReady({
    async startRuntime() {
      calls.push('agent:start')
      throw agentRuntimeStartCancelled()
    },
    startRenderer() { calls.push('renderer:start') },
  })
  assert.equal(outcome, 'cancelled')
  assert.deepEqual(calls, ['agent:start', 'renderer:start'])
  assert.equal(await startRendererBeforeRuntimeReady({ async startRuntime() {}, startRenderer() {} }), 'ready')
})

test('other asynchronous runtime failures still reject', async () => {
  await assert.rejects(startRendererBeforeRuntimeReady({
    async startRuntime() { throw new Error('agent_boot_failed') },
    startRenderer() {},
  }), /agent_boot_failed/)
  assert.equal(isAgentRuntimeStartCancelled(new Error('agent_boot_failed')), false)
  assert.equal(isAgentRuntimeStartCancelled('agent_runtime_start_cancelled'), false)
})

test('a slot cancelled before its start finishes rejects promote with the cancellation error', async () => {
  const start = deferred<void>()
  const slot = new RuntimeStartupSlot({ start: () => start.promise, stop: async () => {} })
  const promoted = slot.promote()
  const drained = slot.cancelAndDrain()
  start.resolve()
  await drained
  await assert.rejects(promoted, error => isAgentRuntimeStartCancelled(error))
})

