import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createBeforeQuitFlushChannel } from '../preload/before-quit-flush'
import { installBeforeQuitFlushBridge, registerBeforeQuitFlushHandler, resetBeforeQuitFlushRegistryForTests } from '../renderer/modules/app/beforeQuitFlushRegistry'

function fakeIpc() {
  const emitter = new EventEmitter()
  const sent: Array<[string, string, unknown]> = []
  return {
    sent,
    listen: (listener: (...args: never[]) => void) => {
      emitter.on('app:flushBeforeQuit', listener)
      return () => { emitter.removeListener('app:flushBeforeQuit', listener) }
    },
    answer: (requestId: string, outcome: unknown) => { sent.push(['app:beforeQuitFlushed', requestId, outcome]) },
    send: (channel: string, requestId: string, outcome: unknown) => { sent.push([channel, requestId, outcome]) },
    request: (requestId: string) => emitter.emit('app:flushBeforeQuit', {}, requestId),
  }
}

test('a quit during startup is answered by the preload instead of timing out', () => {
  const ipc = fakeIpc()
  createBeforeQuitFlushChannel(ipc)
  ipc.request('early')
  assert.deepEqual(ipc.sent, [['app:beforeQuitFlushed', 'early', { success: true }]])
})

test('once the renderer bridge is installed only its flush answers; unsubscribing hands back to the preload', async t => {
  t.after(resetBeforeQuitFlushRegistryForTests)
  const ipc = fakeIpc()
  const subscribe = createBeforeQuitFlushChannel(ipc)
  let release!: () => void
  registerBeforeQuitFlushHandler('slow-save', () => new Promise<void>(resolve => { release = resolve }))
  const uninstall = installBeforeQuitFlushBridge({
    onBeforeQuitFlush: subscribe,
    ackBeforeQuitFlushed: (requestId, outcome) => ipc.send('app:beforeQuitFlushed', requestId, outcome),
  }, { setInteractionFrozen: () => undefined })
  ipc.request('installed')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(ipc.sent, [], 'no early success while the renderer is still saving')
  release()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(ipc.sent, [['app:beforeQuitFlushed', 'installed', { success: true }]])
  uninstall(); uninstall()
  ipc.request('after')
  assert.deepEqual(ipc.sent.at(-1), ['app:beforeQuitFlushed', 'after', { success: true }])
  assert.equal(ipc.sent.length, 2)
})
