import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import type { BrowserWindow } from 'electron'

import {
  createBackgroundCapturePage,
  withDeadline,
} from '../main/modules/browser-engine/background-capture-page'

/** A stand-in for a hidden window: enough of webContents and its debugger for the handle to drive. */
function fakeWindow(options: {
  /** Never answers `Network.enable`, as a window without a renderer does. */
  networkEnableNeverSettles?: boolean
  attachThrows?: boolean
  onLoad?: (url: string, contents: EventEmitter) => Promise<void> | void
  executeJavaScript?: () => Promise<unknown>
} = {}) {
  const contents = new EventEmitter() as EventEmitter & Record<string, unknown>
  const dbg = new EventEmitter() as EventEmitter & Record<string, unknown>
  const calls: string[] = []
  let attached = false
  let currentUrl = ''
  let destroyed = false
  dbg.attach = () => {
    if (options.attachThrows) throw new Error('debugger unavailable')
    attached = true
    calls.push('attach')
  }
  dbg.detach = () => { attached = false; calls.push('detach') }
  dbg.isAttached = () => attached
  dbg.sendCommand = (method: string, params?: { requestId?: string }) => {
    calls.push(`command:${method}`)
    if (method === 'Network.enable') {
      return options.networkEnableNeverSettles ? new Promise(() => undefined) : Promise.resolve({})
    }
    if (method === 'Network.getResponseBody') {
      return Promise.resolve({ body: JSON.stringify({ requestId: params?.requestId }), base64Encoded: false })
    }
    return Promise.resolve({})
  }
  contents.debugger = dbg
  contents.setWindowOpenHandler = () => undefined
  contents.getURL = () => currentUrl
  contents.stop = () => { calls.push('stop') }
  contents.loadURL = async (url: string) => {
    calls.push(`load:${url}`)
    currentUrl = url
    await options.onLoad?.(url, contents)
  }
  contents.executeJavaScript = options.executeJavaScript ?? (async () => ({ __readyCaptureOk: true, value: { title: 'page' } }))
  const window = {
    webContents: contents,
    destroy: () => { destroyed = true },
  } as unknown as BrowserWindow
  return { window, contents, dbg, calls, destroyed: () => destroyed, attached: () => attached }
}

const allowAll = { isAllowedUrl: () => true }
const stopLoadingSoon = (_url: string, contents: EventEmitter) => { setTimeout(() => contents.emit('did-stop-loading'), 5) }

describe('the hidden capture page', () => {
  it('loads the page without waiting for network observation to be switched on', async () => {
    // A window that has not navigated yet never answers Network.enable; gating the load on it waits forever.
    const fake = fakeWindow({ networkEnableNeverSettles: true, onLoad: stopLoadingSoon })
    const page = createBackgroundCapturePage(fake.window, { ...allowAll, observe: { urlIncludes: ['/api/'] } })

    await page.navigate('https://example.test/profile', { timeoutMs: 5_000 })

    assert.deepEqual(fake.calls.slice(0, 3), ['attach', 'command:Network.enable', 'load:https://example.test/profile'])
    await page.close()
  })

  it('keeps the JSON answers the page itself asked for, and only those', async () => {
    const fake = fakeWindow({ onLoad: stopLoadingSoon })
    const page = createBackgroundCapturePage(fake.window, { ...allowAll, observe: { urlIncludes: ['/api/list'] } })
    await page.navigate('https://example.test/profile')

    const respond = (requestId: string, url: string, type: string) => {
      fake.dbg.emit('message', {}, 'Network.responseReceived', { requestId, type, response: { url, status: 200, mimeType: 'application/json' } })
      fake.dbg.emit('message', {}, 'Network.loadingFinished', { requestId })
    }
    respond('1', 'https://example.test/api/list?page=1', 'XHR')
    respond('2', 'https://example.test/api/other', 'Fetch')
    respond('3', 'https://example.test/api/list.js', 'Script')
    respond('4', 'https://example.test/api/list?page=2', 'Fetch')

    assert.equal(await page.waitForResponses((responses) => responses.length === 2, 1_000), true)
    assert.deepEqual(page.responses().map((entry) => [entry.url, entry.status, entry.body]), [
      ['https://example.test/api/list?page=1', 200, '{"requestId":"1"}'],
      ['https://example.test/api/list?page=2', 200, '{"requestId":"4"}'],
    ])
    await page.close()
    assert.equal(fake.attached(), false)
    assert.equal(fake.destroyed(), true)
  })

  it('still reads the page when its answers cannot be observed', async () => {
    const fake = fakeWindow({ attachThrows: true, onLoad: stopLoadingSoon })
    const page = createBackgroundCapturePage(fake.window, { ...allowAll, observe: { urlIncludes: ['/api/'] } })
    await page.navigate('https://example.test/profile')
    assert.equal(await page.waitForResponses(() => false, 5_000), false, 'returns at once: there is nothing to wait for')
    assert.deepEqual(await page.evaluate('1'), { title: 'page' })
    await page.close()
  })

  it('gives up on a page script that never answers, and a late failure of that script harms nobody', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    let failLate: (error: Error) => void = () => undefined
    const fake = fakeWindow({
      onLoad: stopLoadingSoon,
      executeJavaScript: () => new Promise((_resolve, reject) => { failLate = reject }),
    })
    const page = createBackgroundCapturePage(fake.window, allowAll)
    await page.navigate('https://example.test/profile')
    try {
      const startedAt = Date.now()
      await assert.rejects(page.evaluate('poll()', { timeoutMs: 1_000 }), /Timed out reading the page after 1000 ms/)
      assert.ok(Date.now() - startedAt < 3_000)
      failLate(new Error('Execution context was destroyed'))
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.deepEqual(unhandled, [])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      await page.close()
    }
  })

  it('follows a navigation the page replaced, reports a failed load, and does not wait past its deadline', async () => {
    const replaced = fakeWindow({
      onLoad: (_url, contents) => {
        setTimeout(() => contents.emit('did-stop-loading'), 10)
        throw new Error('ERR_ABORTED (-3) loading https://example.test/profile')
      },
    })
    await createBackgroundCapturePage(replaced.window, allowAll).navigate('https://example.test/profile')

    const failed = fakeWindow({
      onLoad: (_url, contents) => { setTimeout(() => contents.emit('did-fail-load', {}, -106, 'ERR_INTERNET_DISCONNECTED', 'https://example.test/', true), 5) },
    })
    await assert.rejects(
      createBackgroundCapturePage(failed.window, allowAll).navigate('https://example.test/profile'),
      /ERR_INTERNET_DISCONNECTED \(-106\)/,
    )

    const silent = fakeWindow({ onLoad: () => undefined })
    await assert.rejects(
      createBackgroundCapturePage(silent.window, allowAll).navigate('https://example.test/profile', { timeoutMs: 5_000 }),
      /Timed out loading/,
    )
  })

  it('refuses an address that is not a web page', async () => {
    const fake = fakeWindow()
    const page = createBackgroundCapturePage(fake.window, { isAllowedUrl: (url) => url.startsWith('https://') })
    await assert.rejects(page.navigate('file:///etc/passwd'), /Blocked URL protocol/)
    assert.deepEqual(fake.calls.filter((call) => call.startsWith('load:')), [])
  })
})

describe('a deadline for work that may never finish', () => {
  it('passes the result through, rejects when the time is up, and swallows a late failure', async () => {
    assert.equal(await withDeadline(Promise.resolve(7), 1_000, 'work'), 7)
    await assert.rejects(withDeadline(Promise.reject(new Error('boom')), 1_000, 'work'), /boom/)

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      let failLate: (error: Error) => void = () => undefined
      const never = new Promise<number>((_resolve, reject) => { failLate = reject })
      await assert.rejects(withDeadline(never, 30, 'Xiaohongshu page'), /Xiaohongshu page did not finish within 30 ms/)
      failLate(new Error('late'))
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.deepEqual(unhandled, [])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
