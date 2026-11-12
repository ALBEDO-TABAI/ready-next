import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserCdpSessionService } from '../main/modules/browser-engine/cdp-session-service'
import { BrowserNetworkObserverService } from '../main/modules/browser-engine/network-observer-service'

function createHarness(
  initiallyAttached = false,
  executeCommand: (method: string) => Promise<unknown> = async () => ({}),
  captureInputGuard?: (tabId: string | null, method: string) => (() => void) | undefined,
) {
  let attached = initiallyAttached
  const listeners = new Set<(...args: unknown[]) => void>()
  const commands: string[] = []
  let attachCalls = 0
  let detachCalls = 0
  const debuggerApi = {
    isAttached: () => attached,
    attach: () => {
      attached = true
      attachCalls += 1
    },
    detach: () => {
      attached = false
      detachCalls += 1
    },
    sendCommand: async (method: string) => {
      commands.push(method)
      return executeCommand(method)
    },
    on: (_event: string, listener: (...args: unknown[]) => void) => {
      listeners.add(listener)
    },
    removeListener: (_event: string, listener: (...args: unknown[]) => void) => {
      listeners.delete(listener)
    },
  }
  const view = { webContents: { debugger: debuggerApi } }
  const service = new BrowserCdpSessionService({
    resolveTabView: () => ({ tabId: 'tab-1', tab: { id: 'tab-1', view }, view }),
    createBrowserError: (_code, message) => new Error(message),
    captureInputGuard,
  } as ConstructorParameters<typeof BrowserCdpSessionService>[0])
  return {
    commands,
    listeners,
    service,
    get attachCalls() { return attachCalls },
    get detachCalls() { return detachCalls },
  }
}

test('CDP rechecks the captured writer after attachment and before every physical event', async () => {
  for (const reason of ['stopped', 'taken_over']) {
    let admitted = true
    const harness = createHarness(false, async () => ({}), (_tab, method) => {
      if (!method.startsWith('Input.')) return undefined
      return () => { if (!admitted) throw new Error(reason) }
    })
    await harness.service.sendCommand('tab-1', 'Input.dispatchMouseEvent', { type: 'mousePressed' })
    const pending = harness.service.sendCommand('tab-1', 'Input.dispatchMouseEvent', { type: 'mouseMoved' })
    admitted = false
    await assert.rejects(pending, new RegExp(reason))
    await assert.rejects(harness.service.sendCommand('tab-1', 'Input.dispatchMouseEvent', { type: 'mouseReleased' }), new RegExp(reason))
    assert.deepEqual(harness.commands, ['Input.dispatchMouseEvent'])
  }
})

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('standalone CDP command releases its service-owned debugger attachment', async () => {
  const harness = createHarness()

  await harness.service.sendCommand('tab-1', 'Runtime.evaluate')

  assert.equal(harness.attachCalls, 1)
  assert.equal(harness.detachCalls, 1)
})

test('failed standalone CDP command still releases its debugger attachment', async () => {
  const harness = createHarness(false, async () => { throw new Error('command failed') })

  await assert.rejects(harness.service.sendCommand('tab-1', 'Runtime.evaluate'), /command failed/)

  assert.equal(harness.attachCalls, 1)
  assert.equal(harness.detachCalls, 1)
})

test('timed out standalone CDP command terminates work and releases its debugger attachment', async () => {
  const never = new Promise<unknown>(() => undefined)
  const harness = createHarness(false, async (method) => method === 'Runtime.evaluate' ? never : {})

  await assert.rejects(
    harness.service.sendCommand('tab-1', 'Runtime.evaluate', {}, { timeoutMs: 5 }),
    /deadline_exceeded/,
  )

  assert.deepEqual(harness.commands, ['Runtime.evaluate', 'Runtime.terminateExecution'])
  assert.equal(harness.detachCalls, 1)
})

test('concurrent standalone CDP commands detach only after the final command settles', async () => {
  const first = deferred<unknown>()
  const second = deferred<unknown>()
  const harness = createHarness(false, (method) => method === 'Runtime.first' ? first.promise : second.promise)
  const firstCommand = harness.service.sendCommand('tab-1', 'Runtime.first')
  const secondCommand = harness.service.sendCommand('tab-1', 'Runtime.second')
  await new Promise<void>((resolve) => setImmediate(resolve))

  first.resolve({})
  await firstCommand
  assert.equal(harness.detachCalls, 0)

  second.resolve({})
  await secondCommand
  assert.equal(harness.attachCalls, 1)
  assert.equal(harness.detachCalls, 1)
})

test('retained CDP attachment keeps a trusted input sequence on one debugger session', async () => {
  const harness = createHarness()
  const release = await harness.service.retainAttachment('tab-1')

  await harness.service.sendCommand('tab-1', 'Input.dispatchMouseEvent')
  await harness.service.sendCommand('tab-1', 'Input.dispatchMouseEvent')
  await harness.service.sendCommand('tab-1', 'Input.insertText')

  assert.equal(harness.attachCalls, 1)
  assert.equal(harness.detachCalls, 0)
  release()
  assert.equal(harness.detachCalls, 1)
})

test('failed domain enable rolls back its reservation and debugger attachment', async () => {
  const harness = createHarness(false, async (method) => {
    if (method === 'Network.enable') throw new Error('enable failed')
    return {}
  })

  await assert.rejects(harness.service.retainDomain('tab-1', 'Network'), /enable failed/)

  assert.equal(harness.attachCalls, 1)
  assert.equal(harness.detachCalls, 1)
})

test('CDP detaches only after the final owned domain and subscriber release', async () => {
  const harness = createHarness()
  const releaseNetwork = await harness.service.retainDomain('tab-1', 'Network')
  const unsubscribe = harness.service.subscribe('tab-1', () => {})

  await releaseNetwork()
  assert.deepEqual(harness.commands, ['Network.enable', 'Network.disable'])
  assert.equal(harness.detachCalls, 0)

  unsubscribe()
  assert.equal(harness.attachCalls, 1)
  assert.equal(harness.detachCalls, 1)
})

test('CDP never detaches a debugger attachment owned by another service', async () => {
  const harness = createHarness(true)
  const releaseNetwork = await harness.service.retainDomain('tab-1', 'Network')
  await releaseNetwork()

  assert.equal(harness.attachCalls, 0)
  assert.equal(harness.detachCalls, 0)
})

test('tab disposal removes subscriptions and force-detaches service-owned CDP', async () => {
  const harness = createHarness()
  await harness.service.ensureAttached('tab-1')
  harness.service.subscribe('tab-1', () => {})

  harness.service.disposeTab('tab-1')

  assert.equal(harness.listeners.size, 0)
  assert.equal(harness.detachCalls, 1)
})

test('network observer disposal releases its CDP domain and debugger attachment', async () => {
  const harness = createHarness()
  const observers = new BrowserNetworkObserverService(harness.service)
  await observers.start('tab-1')

  observers.disposeTab('tab-1')
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.deepEqual(harness.commands, ['Network.enable', 'Network.disable'])
  assert.equal(harness.listeners.size, 0)
  assert.equal(harness.detachCalls, 1)
})
