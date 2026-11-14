import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserDialogService } from '../main/modules/browser-engine/browser-dialog-service'
import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import { captureAgentPageMap } from '../main/modules/tools/browser-observe-tools'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'

test('dialog events emitted during Page.enable are captured before any page script can run', async () => {
  let listener: ((event: { tabId: string; method: string; params: Record<string, unknown> }) => void) | null = null
  const service = new BrowserDialogService({
    subscribe: (_tabId, handler) => { listener = handler; return () => { listener = null } },
    sendCommand: async () => {
      listener?.({ tabId: 'tab-race', method: 'Page.javascriptDialogOpening', params: { type: 'alert', message: '打开即提示' } })
      return {}
    },
  })
  await service.ensure('tab-race')
  assert.equal(service.get('tab-race')?.message, '打开即提示')
})

test('concurrent dialog consumers await the same event subscription readiness', async () => {
  let enable: () => void = () => { throw new Error('enable not started') }
  let commands = 0
  let subscriptions = 0
  const service = new BrowserDialogService({
    subscribe: () => { subscriptions += 1; return () => undefined },
    sendCommand: async () => { commands += 1; await new Promise<void>(resolve => { enable = resolve }) },
  })
  const first = service.ensure('tab-shared')
  let completed = false
  const second = service.ensure('tab-shared').then(() => { completed = true })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(completed, false)
  assert.equal(commands, 1)
  assert.equal(subscriptions, 1)
  enable()
  await Promise.all([first, second])
  assert.equal(completed, true)
  service.clear('tab-shared')
  const renewed = service.ensure('tab-shared')
  await Promise.resolve()
  assert.equal(commands, 2)
  assert.equal(subscriptions, 2)
  enable()
  await renewed
})

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

test('dialog pending changes notify the load governor and clear removes the old listener', async () => {
  let listener: ((event: { tabId: string; method: string; params: Record<string, unknown> }) => void) | null = null
  const changes: string[] = []
  const service = new BrowserDialogService({
    sendCommand: async () => ({}),
    subscribe: (_tabId, handler) => {
      listener = handler
      return () => { listener = null }
    },
  }, (tabId) => changes.push(tabId))

  await service.ensure('tab-3')
  listener?.({ tabId: 'tab-3', method: 'Page.javascriptDialogOpening', params: { type: 'confirm', message: 'Continue?' } })
  assert.equal(service.hasPending('tab-3'), true)
  assert.deepEqual(changes, ['tab-3'])

  service.clear('tab-3')
  assert.equal(service.hasPending('tab-3'), false)
  assert.equal(listener, null)
  assert.deepEqual(changes, ['tab-3', 'tab-3'])
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

test('ordinary actions stop on dialogs until browser_dialog handles the current dialog', async () => {
  let dialogType: 'alert' | 'confirm' = 'confirm'
  let dialogOpen = true
  let handled = 0
  let backCalls = 0
  const controller = {
    getActiveTab: () => ({ id: 'tab-1', title: 'Fixture', url: 'https://example.test', active: true }),
    getTabList: () => [{ id: 'tab-1', title: 'Fixture', url: 'https://example.test', active: true }],
    getPhysicalTargetToken: () => 'physical-tab-1',
    getBrowserDialog: async () => dialogOpen ? { tabId: 'tab-1', type: dialogType, message: 'Dialog' } : null,
    handleBrowserDialog: async () => { handled += 1; dialogOpen = false },
    beginBrowserWorkflowAction: (input: Record<string, unknown>) => ({
      actionId: 'dialog-action-1',
      actionSeq: 1,
      identity: input.identity,
    }),
    settleBrowserWorkflowAction: (_taskId: string, actionId: string, outcome: unknown) => ({
      receiptId: 'dialog-receipt-1',
      actionId,
      actionSeq: 1,
      outcome,
    }),
    executeJS: async (_tabId: string | null, script: string) => script.includes('__READY_AGENT_PAGE_MAP__')
      ? {
          identity: { url: 'https://example.test', title: 'Fixture', frameDocumentToken: 'document-tab-1' },
          viewport: { width: 1000, height: 800 },
          rawRoots: [],
        }
      : {
          url: 'https://example.test',
          title: 'Fixture',
          timeOrigin: 1,
          mutationRevision: 0,
          frameDocumentToken: 'document-tab-1',
        },
    goBack: () => { backCalls += 1; return { success: true } },
  } as unknown as BrowserController
  const taskContext = {
    ownerRunId: 'run-dialog-test',
    browserTaskId: 'browser-task-dialog-test',
    parentTaskId: 'parent-dialog-test',
    inputSource: 'trusted_internal' as const,
  }
  const execute = (name: string, args: Record<string, unknown>) => executeBrowserTool(
    name,
    args,
    controller,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    taskContext,
  )

  await captureAgentPageMap(controller, 'tab-1')
  const blocked = await execute('browser_navigate', { action: 'back' })
  assert.equal(typeof blocked === 'string' ? null : blocked.data?.errorKind, 'dialog_open')
  assert.equal(backCalls, 0)
  assert.equal(handled, 0)

  dialogType = 'alert'
  const alertBlocked = await execute('browser_navigate', { action: 'back' })
  assert.equal(typeof alertBlocked === 'string' ? null : alertBlocked.data?.errorKind, 'dialog_open')
  assert.equal(handled, 0)
  assert.equal(backCalls, 0)

  const handledResult = await execute('browser_dialog', { action: 'accept' })
  assert.equal(typeof handledResult === 'string' ? null : handledResult.data?.ok, true)
  assert.equal(handled, 1)

  const allowed = await execute('browser_navigate', { action: 'back' })
  assert.doesNotMatch(typeof allowed === 'string' ? allowed : allowed.text, /dialog_open/)
  assert.equal(backCalls, 1)
})
