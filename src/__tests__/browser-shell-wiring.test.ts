import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { EventEmitter } from 'node:events'
import ts from 'typescript'
import { randomUUID } from 'node:crypto'
import * as attention from '../main/modules/browser-engine/browser-user-attention'
import * as attentionTypes from '../shared/browser-user-attention'

/** Execute the real module, replacing only unavailable process/native dependencies, not its methods. */
function load(filename: string, requireDependency: (id: string) => unknown): Record<string, { prototype: Record<string, (...args: unknown[]) => unknown> }> {
  const output = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  runInNewContext(output, { exports, require: requireDependency, process, console, setTimeout, clearTimeout })
  return exports
}

test('preload invokes all shell handlers and push unsubscribe removes exactly its own listener', async () => {
  const file = resolve('src/preload/index.ts'), requireReal = createRequire(file)
  const emitter = new EventEmitter(), invocations: unknown[] = []
  let api!: Window['electronAPI']
  load(file, id => id === 'electron' ? {
    ipcRenderer: { on: emitter.on.bind(emitter), removeListener: emitter.removeListener.bind(emitter), send: () => {}, invoke: async (...args: unknown[]) => { invocations.push(args); return { success: true } } },
    contextBridge: { exposeInMainWorld: (_name: string, exposed: Window['electronAPI']) => { api = exposed } }, webUtils: {},
  } : requireReal(id))
  await api.browser.suggest({ query: 'a', limit: 3 })
  await api.browser.findInPage({ tabId: 'tab', text: 'x' })
  await api.browser.stopFindInPage({ tabId: 'tab', action: 'clearSelection' })
  await api.browser.getPageCapabilities({ tabId: 'tab' })
  await api.browser.readTab({ tabId: 'tab' })
  assert.deepEqual(JSON.parse(JSON.stringify(invocations)), [
    ['agent:readRuntimeReady'],
    ['browser:suggest', { query: 'a', limit: 3 }], ['browser:findInPage', { tabId: 'tab', text: 'x' }],
    ['browser:stopFindInPage', { tabId: 'tab', action: 'clearSelection' }], ['browser:getPageCapabilities', { tabId: 'tab' }], ['browser:readTab', { tabId: 'tab' }],
  ])
  let calls = 0
  const subscriptions = [
    ['browser:foundInPage', api.browser.onFoundInPage(() => { calls++ })],
    ['browser:pageCapabilitiesChanged', api.browser.onPageCapabilitiesChanged(() => { calls++ })],
    ['browser:searchSettingsChanged', api.browser.onSearchSettingsChanged(() => { calls++ })],
    ['agent:browserTaskAttentionChanged', api.agent.onBrowserTaskAttentionChanged(() => { calls++ })],
  ] as const
  for (const [channel, unsubscribe] of subscriptions) {
    emitter.emit(channel, {}, {})
    unsubscribe()
    emitter.emit(channel, {}, {})
    assert.equal(emitter.listenerCount(channel), 0)
  }
  assert.equal(calls, 4)
})

test('Main records attention before publishing a scope/task invalidation, including foreground and review-rejected tasks', () => {
  const module = load(resolve('src/main/modules/browser-engine/browser-controller.ts'), id => {
    if (id === 'node:crypto') return { randomUUID }
    if (id === '../../../shared/browser-user-attention') return attentionTypes
    if (id === './browser-user-attention') return attention
    if (id === './browser-controller-capture-runtime') return { BrowserControllerCaptureRuntime: class {} }
    return {} // The exercised methods do not call other imports or native dependencies.
  })
  const methods = module.BrowserController.prototype
  const task = { taskId: 'task', parentTaskId: 'parent', createdByRunId: 'run', status: 'running', result: undefined as unknown }
  let payload: Record<string, unknown> = {}
  const pushes: { channel: string; data: unknown }[] = []
  let notifications = 0
  const controller = {
    taskPersistenceService: { getTask: () => task, getTaskPayload: () => payload, patchTaskPayload: (_id: string, patch: Record<string, unknown>) => { payload = { ...payload, ...patch }; return true } },
    attentionScopeResolver: (id: string) => { assert.equal(id, 'parent'); return 'scope' },
    sendToRenderer: (channel: string, data: unknown) => { pushes.push({ channel, data }) },
    getTaskAttention: (id: string) => Reflect.apply(methods.getTaskAttention, controller, [id]),
    publishTaskAttentionChanged: (id: string) => Reflect.apply(methods.publishTaskAttentionChanged, controller, [id]),
    notifyTaskAttention: (id: string) => Reflect.apply(methods.notifyTaskAttention, controller, [id]),
    mainWindow: { isDestroyed: () => false, isFocused: () => true },
    attentionNotificationPort: () => { notifications++ },
    getPhysicalTargetToken: () => 'physical', switchTab: () => ({ success: true }), getTabList: () => [],
  }
  Reflect.apply(methods.recordTaskAttention, controller, [{ browserTaskId: 'task', parentTaskId: 'parent', ownerRunId: 'run', tabId: 'tab', physicalTargetToken: 'physical' }, 'login'])
  assert.deepEqual(JSON.parse(JSON.stringify(pushes)), [{ channel: 'agent:browserTaskAttentionChanged', data: { scopeId: 'scope', browserTaskId: 'task' } }])
  assert.ok(controller.getTaskAttention('task'), 'attention was persisted before the push')
  assert.equal(notifications, 0, 'foreground still receives data invalidation but no system notification')
  payload = {}
  task.status = 'failed'
  task.result = { userAttentionReason: 'review_rejected' }
  controller.notifyTaskAttention('task')
  assert.equal(pushes.length, 2)
  assert.deepEqual(Object.keys(pushes[1].data as object).sort(), ['browserTaskId', 'scopeId'])
  task.result = undefined
  task.status = 'completed'
  controller.notifyTaskAttention('task')
  assert.equal(controller.getTaskAttention('task'), null)
  assert.equal(pushes.length, 3, 'clearing attention still sends only a reread hint')
})

test('both tab selection paths share the production setter that clears the outgoing page find', () => {
  const module = load(resolve('src/main/modules/browser-engine/browser-controller-composition.ts'), id => id === './browser-controller-contract-base' ? { BrowserControllerContractBase: class {} } : {})
  const cleared: string[] = []
  const controller = { activeTabId: 'old' as string | null, pageTools: { clearFind: (tabId: string) => { cleared.push(tabId) } } }
  const select = (tabId: string | null) => Reflect.apply(module.BrowserControllerComposition.prototype.setActiveBrowserTab, controller, [tabId])
  select('old')
  assert.deepEqual(cleared, [])
  select('new')
  assert.equal(controller.activeTabId, 'new')
  assert.deepEqual(cleared, ['old'])
  select(null)
  assert.deepEqual(cleared, ['old', 'new'])
})
