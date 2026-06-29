import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { BrowserCdpSessionService } from '../main/modules/browser-engine/cdp-session-service'
import { BrowserNetworkObserverService } from '../main/modules/browser-engine/network-observer-service'

class FakeDebugger extends EventEmitter {
  attached = false
  commands: Array<{ method: string; params?: Record<string, unknown> }> = []

  isAttached(): boolean {
    return this.attached
  }

  attach(): void {
    this.attached = true
  }

  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ method, params })
    if (method === 'Network.getResponseBody') {
      return { body: '{"ok":true}', base64Encoded: false }
    }
    return {}
  }
}

function createCdpFixture() {
  const fakeDebugger = new FakeDebugger()
  const view = {
    webContents: {
      debugger: fakeDebugger,
    },
  }
  const cdp = new BrowserCdpSessionService({
    resolveTabView: () => ({
      tabId: 'tab-1',
      tab: { id: 'tab-1', view: view as never },
      view: view as never,
    }),
    createBrowserError: (_code, message) => new Error(message),
  })
  return { cdp, fakeDebugger }
}

test('BrowserCdpSessionService reference-counts CDP domain enable/disable', async () => {
  const { cdp, fakeDebugger } = createCdpFixture()

  const releaseOne = await cdp.retainDomain('tab-1', 'Network')
  const releaseTwo = await cdp.retainDomain('tab-1', 'Network')

  assert.equal(fakeDebugger.attached, true)
  assert.deepEqual(fakeDebugger.commands.map((item) => item.method), ['Network.enable'])

  await releaseOne()
  assert.deepEqual(fakeDebugger.commands.map((item) => item.method), ['Network.enable'])

  await releaseTwo()
  assert.deepEqual(fakeDebugger.commands.map((item) => item.method), ['Network.enable', 'Network.disable'])
})

test('BrowserNetworkObserverService records bounded Network events and reads response bodies', async () => {
  const { cdp, fakeDebugger } = createCdpFixture()
  const service = new BrowserNetworkObserverService(cdp)
  const handle = await service.start('tab-1', { maxEvents: 2 })

  fakeDebugger.emit('message', {}, 'Network.requestWillBeSent', {
    requestId: 'r1',
    request: { url: 'https://example.com/a.json', method: 'GET' },
    type: 'XHR',
    initiator: { type: 'script' },
    timestamp: 1,
  })
  fakeDebugger.emit('message', {}, 'Network.responseReceived', {
    requestId: 'r1',
    response: { url: 'https://example.com/a.json', status: 200, mimeType: 'application/json', headers: { 'content-type': 'application/json' } },
    type: 'XHR',
  })
  fakeDebugger.emit('message', {}, 'Network.loadingFinished', {
    requestId: 'r1',
    timestamp: 2,
  })
  fakeDebugger.emit('message', {}, 'Network.requestWillBeSent', {
    requestId: 'r2',
    request: { url: 'https://cdn.example.com/video.mp4', method: 'GET' },
    type: 'Media',
    timestamp: 3,
  })

  const events = handle.events()
  assert.equal(events.length, 2)
  assert.deepEqual(events[0], {
    requestId: 'r1',
    url: 'https://example.com/a.json',
    method: 'GET',
    resourceType: 'XHR',
    initiatorType: 'script',
    startedAt: 1,
    status: 200,
    mimeType: 'application/json',
    responseHeaders: { 'content-type': 'application/json' },
    finishedAt: 2,
  })
  assert.equal(events[1].url, 'https://cdn.example.com/video.mp4')

  const body = await handle.getResponseBody('r1')
  assert.deepEqual(body, { body: '{"ok":true}', base64Encoded: false })

  await handle.stop()
  fakeDebugger.emit('message', {}, 'Network.loadingFailed', {
    requestId: 'r3',
    errorText: 'blocked',
  })
  assert.equal(handle.events().length, 2)
  assert.equal(fakeDebugger.commands.at(-1)?.method, 'Network.disable')
})
