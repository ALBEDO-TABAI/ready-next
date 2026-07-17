import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserDialogService } from '../main/modules/browser-engine/browser-dialog-service'
import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'

test('dialog service records and deterministically handles javascript dialogs', async () => {
  const commands: Array<{ tabId: string | null; method: string; params?: Record<string, unknown> }> = []
  let listener: ((event: { tabId: string; method: string; params: Record<string, unknown> }) => void) | null = null
  const service = new BrowserDialogService({
    sendCommand: async (tabId, method, params) => {
      commands.push({ tabId, method, params })
      return {}
    },
    subscribe: (_tabId, handler) => {
      listener = handler
      return () => { listener = null }
    },
  })

  await service.ensure('tab-1')
  assert.ok(listener)
  listener?.({
    tabId: 'tab-1',
    method: 'Page.javascriptDialogOpening',
    params: { type: 'prompt', message: 'Name?', defaultPrompt: 'A' },
  })
  assert.deepEqual(service.get('tab-1'), {
    tabId: 'tab-1',
    type: 'prompt',
    message: 'Name?',
    defaultPrompt: 'A',
  })

  await service.handle('tab-1', { accept: true, promptText: 'B' })
  assert.equal(service.get('tab-1'), null)
  assert.deepEqual(commands.at(-1), {
    tabId: 'tab-1',
    method: 'Page.handleJavaScriptDialog',
    params: { accept: true, promptText: 'B' },
  })
})

test('dialog service clears stale state when CDP reports close', async () => {
  let listener: ((event: { tabId: string; method: string; params: Record<string, unknown> }) => void) | null = null
  const service = new BrowserDialogService({
    sendCommand: async () => ({}),
    subscribe: (_tabId, handler) => {
      listener = handler
      return () => { listener = null }
    },
  })
  await service.ensure('tab-2')
  listener?.({ tabId: 'tab-2', method: 'Page.javascriptDialogOpening', params: { type: 'alert', message: 'Hi' } })
  listener?.({ tabId: 'tab-2', method: 'Page.javascriptDialogClosed', params: {} })
  assert.equal(service.get('tab-2'), null)
})

test('dialog service classifies alert, confirm, prompt and beforeunload deterministically', async () => {
  let listener: ((event: { tabId: string; method: string; params: Record<string, unknown> }) => void) | null = null
  const service = new BrowserDialogService({
    sendCommand: async () => ({}),
    subscribe: (_tabId, handler) => {
      listener = handler
      return () => { listener = null }
    },
  })
  await service.ensure('tab-all')
  for (const type of ['alert', 'confirm', 'prompt', 'beforeunload'] as const) {
    listener?.({
      tabId: 'tab-all',
      method: 'Page.javascriptDialogOpening',
      params: { type, message: `${type} message` },
    })
    assert.equal(service.get('tab-all')?.type, type)
    assert.equal(service.get('tab-all')?.message, `${type} message`)
    listener?.({ tabId: 'tab-all', method: 'Page.javascriptDialogClosed', params: {} })
    assert.equal(service.get('tab-all'), null)
  }
})

test('ordinary actions auto-clear alerts but stop on confirm until browser_dialog handles it', async () => {
  let dialogType: 'alert' | 'confirm' = 'confirm'
  let handled = 0
  let backCalls = 0
  const controller = {
    getActiveTab: () => ({ id: 'tab-1', title: 'Fixture', url: 'https://example.test', active: true }),
    getTabList: () => [{ id: 'tab-1', title: 'Fixture', url: 'https://example.test', active: true }],
    getBrowserDialog: async () => ({ tabId: 'tab-1', type: dialogType, message: 'Dialog' }),
    handleBrowserDialog: async () => { handled += 1 },
    goBack: () => { backCalls += 1; return { success: true } },
  } as unknown as BrowserController

  const blocked = await executeBrowserTool('browser_navigate', { action: 'back' }, controller)
  assert.equal(typeof blocked === 'string' ? null : blocked.data?.errorKind, 'dialog_open')
  assert.equal(backCalls, 0)
  assert.equal(handled, 0)

  dialogType = 'alert'
  const allowed = await executeBrowserTool('browser_navigate', { action: 'back' }, controller)
  assert.doesNotMatch(typeof allowed === 'string' ? allowed : allowed.text, /dialog_open/)
  assert.equal(handled, 1)
  assert.equal(backCalls, 1)
})
