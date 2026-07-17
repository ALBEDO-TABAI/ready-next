import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_RENDERER_STATE_FLUSH_TIMEOUT_MS,
  RendererStateFlushCoordinator,
} from '../main/modules/process-cleanup/renderer-state-flush-coordinator'
import {
  installBeforeQuitFlushBridge,
  registerBeforeQuitFlushHandler,
  resetBeforeQuitFlushRegistryForTests,
} from '../renderer/modules/app/beforeQuitFlushRegistry'

test('renderer flush waits only for the selected main renderer acknowledgement', async () => {
  let requestId = ''
  const coordinator = new RendererStateFlushCoordinator({ createRequestId: () => 'flush-1' })
  let settled = false
  const pending = coordinator.request({
    id: 41,
    send: (nextRequestId) => { requestId = nextRequestId },
  }, 1_000).then(() => { settled = true })

  coordinator.acknowledge(requestId, 99, { success: true })
  await Promise.resolve()
  assert.equal(settled, false)

  coordinator.acknowledge(requestId, 41, { success: true })
  await pending
  assert.equal(settled, true)
})

test('renderer flush rejects when the selected renderer reports a save failure', async () => {
  let requestId = ''
  const coordinator = new RendererStateFlushCoordinator({ createRequestId: () => 'flush-failed' })
  const pending = coordinator.request({
    id: 41,
    send: (nextRequestId) => { requestId = nextRequestId },
  }, 1_000)

  coordinator.acknowledge(requestId, 41, {
    success: false,
    error: '一个或多个画板未能保存',
  })
  await assert.rejects(pending, /一个或多个画板未能保存/)
})

test('renderer flush rejects on timeout instead of treating silence as a safe save', async () => {
  const coordinator = new RendererStateFlushCoordinator({ createRequestId: () => 'flush-timeout' })
  const cancelled: string[] = []
  await assert.rejects(
    coordinator.request({
      id: 41,
      send: () => undefined,
      cancel: (requestId) => { cancelled.push(requestId) },
    }, 5),
    /timed out/i,
  )
  assert.deepEqual(cancelled, ['flush-timeout'])
})

test('renderer flush still rejects when the best-effort cancellation send also throws', async () => {
  const coordinator = new RendererStateFlushCoordinator({ createRequestId: () => 'flush-cancel-throws' })
  await assert.rejects(
    coordinator.request({
      id: 41,
      send: () => undefined,
      cancel: () => { throw new Error('renderer disappeared during cancel') },
    }, 5),
    /timed out/i,
  )
})

test('default renderer flush budget permits a save that finishes after three seconds', async () => {
  let requestId = ''
  let scheduledDelay = 0
  const coordinator = new RendererStateFlushCoordinator({
    createRequestId: () => 'flush-slow-save',
    setTimeout: (_callback, delayMs) => {
      scheduledDelay = delayMs
      return { unref: () => undefined } as ReturnType<typeof setTimeout>
    },
    clearTimeout: () => undefined,
  })
  let settled = false
  const pending = coordinator.request({
    id: 41,
    send: (nextRequestId) => { requestId = nextRequestId },
  }, DEFAULT_RENDERER_STATE_FLUSH_TIMEOUT_MS).then(() => { settled = true })

  assert.equal(scheduledDelay, 5_000)
  await Promise.resolve()
  assert.equal(settled, false)
  coordinator.acknowledge(requestId, 41, { success: true })
  await pending
  assert.equal(settled, true)
})

test('renderer flush resolves with no renderer but rejects when IPC send throws', async () => {
  const coordinator = new RendererStateFlushCoordinator({ createRequestId: () => 'flush-2' })
  await coordinator.request(null, 1_000)
  await assert.rejects(
    coordinator.request({
      id: 41,
      send: () => { throw new Error('renderer closed') },
    }, 1_000),
    /renderer closed/,
  )
})

test('successful renderer flush returns an idempotent lease that releases the interaction freeze', async () => {
  let requestId = ''
  const cancelled: string[] = []
  const coordinator = new RendererStateFlushCoordinator({ createRequestId: () => 'flush-lease' })
  const pending = coordinator.request({
    id: 41,
    send: (nextRequestId) => { requestId = nextRequestId },
    cancel: (nextRequestId) => { cancelled.push(nextRequestId) },
  }, 1_000)

  coordinator.acknowledge(requestId, 41, { success: true })
  const lease = await pending
  assert.deepEqual(cancelled, [])
  lease.release()
  lease.release()
  assert.deepEqual(cancelled, ['flush-lease'])
})

test('renderer lease watchdog unfreezes interaction when Main timeout cancellation cannot be sent', async () => {
  resetBeforeQuitFlushRegistryForTests()
  const never = new Promise<void>(() => undefined)
  const unregister = registerBeforeQuitFlushHandler('hung-save', () => never)
  let requestHandler: ((requestId: string) => void) | null = null
  const frozen: boolean[] = []
  const uninstall = installBeforeQuitFlushBridge({
    onBeforeQuitFlush: (handler) => {
      requestHandler = handler
      return () => { requestHandler = null }
    },
    ackBeforeQuitFlushed: () => undefined,
  }, {
    leaseTimeoutMs: 15,
    setInteractionFrozen: (value) => { frozen.push(value) },
  })
  const coordinator = new RendererStateFlushCoordinator({ createRequestId: () => 'flush-watchdog' })

  await assert.rejects(coordinator.request({
    id: 41,
    send: (requestId) => requestHandler?.(requestId),
    cancel: () => { throw new Error('cancel IPC send failed') },
  }, 5), /timed out/i)
  assert.deepEqual(frozen, [true])
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(frozen, [true, false])

  uninstall()
  unregister()
  resetBeforeQuitFlushRegistryForTests()
})
