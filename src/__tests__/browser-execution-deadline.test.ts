import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserAutomationService } from '../main/modules/browser-engine/automation-service'
import { BrowserCdpSessionService } from '../main/modules/browser-engine/cdp-session-service'

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined)
}

function fixture() {
  const commands: string[] = []
  const webContents = {
    executeJavaScript: () => never<unknown>(),
    stop: () => { commands.push('webContents.stop') },
    debugger: {
      isAttached: () => true,
      attach: () => undefined,
      sendCommand: (method: string) => {
        commands.push(method)
        if (method === 'Runtime.evaluate' || method === 'Page.navigate') return never<unknown>()
        return Promise.resolve({})
      },
    },
  }
  const view = { webContents }
  const host = {
    resolveTabView: () => ({ tabId: 'tab-1', tab: { id: 'tab-1', url: 'https://example.test', title: 'Fixture' }, view }),
    createBrowserError: (_code: string, message: string) => new Error(message),
    getViewBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
  }
  return { commands, host, view }
}

test('executeJS terminates a stuck page at the bottom deadline', async () => {
  const { commands, host } = fixture()
  const service = new BrowserAutomationService(host as never)
  await assert.rejects(
    service.executeJS('tab-1', 'while (true) {}', { timeoutMs: 10 }),
    /deadline_exceeded:10/,
  )
  assert.deepEqual(commands, ['Runtime.terminateExecution'])
})

test('executeJS propagates external abort and terminates late execution', async () => {
  const { commands, host } = fixture()
  const service = new BrowserAutomationService(host as never)
  const abort = new AbortController()
  const pending = service.executeJS('tab-1', 'new Promise(() => {})', { timeoutMs: 5_000, signal: abort.signal })
  abort.abort(new Error('turn_cancelled'))
  await assert.rejects(pending, /turn_cancelled/)
  assert.deepEqual(commands, ['Runtime.terminateExecution'])
})

test('CDP runtime deadlines terminate execution instead of accepting a late result', async () => {
  const { commands, host } = fixture()
  const service = new BrowserCdpSessionService(host as never)
  await assert.rejects(
    service.sendCommand('tab-1', 'Runtime.evaluate', { expression: 'while (true) {}' }, { timeoutMs: 10 }),
    /deadline_exceeded:10/,
  )
  assert.deepEqual(commands, ['Runtime.evaluate', 'Runtime.terminateExecution'])
})

test('aborting CDP navigation stops page loading', async () => {
  const { commands, host } = fixture()
  const service = new BrowserCdpSessionService(host as never)
  const abort = new AbortController()
  const pending = service.sendCommand('tab-1', 'Page.navigate', { url: 'https://example.test/next' }, {
    timeoutMs: 5_000,
    signal: abort.signal,
  })
  abort.abort(new Error('turn_cancelled'))
  await assert.rejects(pending, /turn_cancelled/)
  assert.deepEqual(commands, ['Page.navigate', 'Page.stopLoading'])
})
