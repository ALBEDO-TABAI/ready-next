import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { BrowserUserAttention } from '../shared/browser-user-attention'
import type { BrowserDownloadReceipt } from '../shared/browser-download-receipt'
import { makeEmptySessionSlice } from '../renderer/stores/agent-store-helpers'
import { useAgent } from '../renderer/stores/useAgent'
import type { AgentMessage } from '../renderer/modules/agent/types'
import {
  attentionTaskForTab,
  browserTasksForRun,
  browserTaskState,
  installBrowserTaskRereadTriggers,
  requestBrowserTaskReread,
  requestTextForRun,
  resetBrowserTaskWorkForTest,
  setBrowserTaskAction,
  shortTaskTitle,
  useBrowserTaskWork,
} from '../renderer/modules/browser/browser-task-work'

// W7 T7/T8: the interface's mirror of the assistant's browser tasks. Main is replaced by a stand-in that answers the
// same calls (tabs, the lease snapshot, the attention read, the receipts); the agent store is the real one.

type Claim = { tabId: string; state: string; browserTaskId: string; parentTaskId: string; ownerRunId: string; surface: string; partition: string; claimId: string; generation: number; suspensionCheckpointId: null; suspensionReason: null }

function attention(reason: BrowserUserAttention['reason'], tabId: string | null = 'tab-2', id = 'att-1'): BrowserUserAttention {
  return {
    id, reason, tabId, physicalTargetToken: tabId ? 'token' : null, status: 'needs_user',
    browserTaskId: 'bt-1', parentTaskId: 'task-1', ownerRunId: 'run-1',
    action: { kind: 'send_user_input', label: reason === 'takeover' ? '让助手接着做' : '我处理好了，继续', text: 'fixed sentence' },
  }
}

function receipt(id = 'r-1'): BrowserDownloadReceipt {
  return {
    receiptId: id, browserTaskId: 'bt-1', ownerRunId: 'run-1', path: '/vault/下载/report.csv', size: 1234, sha256: 'a'.repeat(64),
    sourceUrl: 'http://127.0.0.1/report.csv', readyRef: { kind: 'file', id: 'obj-1' }, readyUri: 'ready://doc/file/obj-1',
  }
}

function stand(t: TestContext) {
  const main = {
    tabs: [] as Array<{ id: string; browserTaskId?: string }>,
    claims: [] as Claim[],
    attention: new Map<string, BrowserUserAttention | null>(),
    receipts: new Map<string, BrowserDownloadReceipt[]>(),
    attentionReads: [] as Array<{ scopeId: string; browserTaskId: string }>,
    lease: [] as Array<(snapshot: { claims?: Claim[] }) => void>,
  }
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  const on = (name: string) => (callback: (...args: unknown[]) => void) => {
    (listeners[name] ??= []).push(callback)
    return () => { listeners[name] = listeners[name].filter(item => item !== callback) }
  }
  const electronAPI = {
    browser: {
      getTabs: async () => main.tabs.map(tab => ({ ...tab, url: `http://x/${tab.id}`, title: tab.id, active: false })),
      getAgentSupervisionState: async () => ({ controlState: 'active', agentTabId: null, tasks: [], claims: main.claims }),
      getTaskDownloadReceipts: async ({ browserTaskId }: { browserTaskId: string }) => ({ success: true, downloadReceipts: main.receipts.get(browserTaskId) ?? [] }),
      onTabOpened: on('tabOpened'),
      onTabUpdate: on('tabUpdate'),
      onLeaseChanged: on('lease'),
      onAgentControlChanged: on('control'),
    },
    agent: {
      getBrowserTaskAttention: async (request: { scopeId: string; browserTaskId: string }) => {
        main.attentionReads.push(request)
        return request.scopeId === 'scope-a' ? main.attention.get(request.browserTaskId) ?? null : null
      },
      getTaskProjection: async () => ({ success: false }),
    },
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    value: { electronAPI, setTimeout, clearTimeout, setInterval, clearInterval },
    configurable: true,
  })
  const agentState = useAgent.getState()
  useAgent.setState({
    currentScopeId: 'scope-a',
    messages: [],
    scopeRunStates: {},
    sessions: { 'session-a': { ...makeEmptySessionSlice('scope-a'), aliasGeneration: 1 } },
    activeSessionId: 'session-a',
    scopes: [],
  })
  resetBrowserTaskWorkForTest()
  t.after(() => {
    resetBrowserTaskWorkForTest()
    useAgent.setState(agentState, true)
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  const emit = (name: string, ...args: unknown[]) => { for (const listener of listeners[name] ?? []) listener(...args) }
  return { main, emit }
}

const held = (tabId: string, browserTaskId = 'bt-1'): Claim => ({
  tabId, state: 'held', browserTaskId, parentTaskId: 'task-1', ownerRunId: 'run-1', surface: 'agent-view',
  partition: 'persist:browser', claimId: `c-${tabId}`, generation: 1, suspensionCheckpointId: null, suspensionReason: null,
})

test('tasks come from Main: tabs carry the task, a held page means running, a need read for the open conversation', async t => {
  const { main } = stand(t)
  main.tabs = [{ id: 'tab-1' }, { id: 'tab-2', browserTaskId: 'bt-1' }, { id: 'tab-3', browserTaskId: 'bt-1' }]
  main.claims = [held('tab-2')]
  await requestBrowserTaskReread('mount')
  let task = useBrowserTaskWork.getState().tasks['bt-1']
  assert.deepEqual(task.tabIds, ['tab-2', 'tab-3'])
  assert.equal(task.ownerRunId, 'run-1')
  assert.equal(browserTaskState(task, []), 'running')
  assert.deepEqual(main.attentionReads, [{ scopeId: 'scope-a', browserTaskId: 'bt-1' }], 'the need is read against the open conversation')

  // The run closes out: the page is released and Main now reports the login wall.
  main.claims = []
  main.attention.set('bt-1', attention('login'))
  await requestBrowserTaskReread('run-ended')
  task = useBrowserTaskWork.getState().tasks['bt-1']
  assert.equal(browserTaskState(task, []), 'needs_user')
  assert.equal(attentionTaskForTab(useBrowserTaskWork.getState().tasks, 'tab-2')?.browserTaskId, 'bt-1')
  assert.equal(attentionTaskForTab(useBrowserTaskWork.getState().tasks, 'tab-3'), null, 'the band belongs to the page the need names')

  // Answered: Main no longer reports a need; the task is done and keeps its tabs.
  main.attention.set('bt-1', null)
  await requestBrowserTaskReread('acted', ['bt-1'])
  task = useBrowserTaskWork.getState().tasks['bt-1']
  assert.equal(browserTaskState(task, []), 'done')
  assert.equal(browserTaskState(task, ['run-1']), 'running', 'a task whose run is still executing counts as running')
})

test('a need that names no page (a rejected review) shows on every page of the task', async t => {
  const { main } = stand(t)
  main.tabs = [{ id: 'tab-2', browserTaskId: 'bt-1' }]
  main.attention.set('bt-1', attention('review_rejected', null))
  await requestBrowserTaskReread('mount')
  assert.equal(attentionTaskForTab(useBrowserTaskWork.getState().tasks, 'tab-2')?.attention?.reason, 'review_rejected')
})

test('downloaded files keep their card after the tabs close; a task with nothing left to show is forgotten', async t => {
  const { main } = stand(t)
  main.tabs = [{ id: 'tab-2', browserTaskId: 'bt-1' }, { id: 'tab-4', browserTaskId: 'bt-2' }]
  main.receipts.set('bt-1', [receipt()])
  await requestBrowserTaskReread('mount')
  assert.equal(browserTasksForRun(useBrowserTaskWork.getState().tasks, 'run-1').length, 1)
  main.tabs = []
  await requestBrowserTaskReread('tabs')
  const tasks = useBrowserTaskWork.getState().tasks
  assert.deepEqual(Object.keys(tasks), ['bt-1'], 'bt-2 had no files and no need')
  assert.equal(tasks['bt-1'].receipts[0].receiptId, 'r-1')
  assert.deepEqual(tasks['bt-1'].tabIds, [])
})

test('a refusal stays while its need stands and goes when the need changes', async t => {
  const { main } = stand(t)
  main.tabs = [{ id: 'tab-2', browserTaskId: 'bt-1' }]
  main.attention.set('bt-1', attention('takeover'))
  await requestBrowserTaskReread('mount')
  setBrowserTaskAction('bt-1', { attentionId: 'att-1', phase: 'refused', message: '当前模型配置无法使用' })
  await requestBrowserTaskReread('poll')
  assert.equal(useBrowserTaskWork.getState().actions['bt-1']?.phase, 'refused')
  main.attention.set('bt-1', attention('takeover', 'tab-2', 'att-2'))
  await requestBrowserTaskReread('poll')
  assert.equal(useBrowserTaskWork.getState().actions['bt-1'], undefined)
})

test('the run-end triggers re-read: a page released on the lease push, and a run finishing in the assistant', async t => {
  const { main, emit } = stand(t)
  main.tabs = [{ id: 'tab-2', browserTaskId: 'bt-1' }]
  main.claims = [held('tab-2')]
  const busyRun = { scopeId: 'scope-a', agent: 'butler', requestId: 'run-1', phase: 'tool_running', toolTrace: [], updatedAt: new Date().toISOString() }
  useAgent.setState({ scopeRunStates: { 'scope-a': busyRun as never } })
  const uninstall = installBrowserTaskRereadTriggers()
  t.after(uninstall)
  await requestBrowserTaskReread('mount')
  assert.deepEqual(useBrowserTaskWork.getState().activeRunIds, ['run-1'])
  emit('lease', { claims: main.claims })

  main.claims = []
  main.attention.set('bt-1', attention('login'))
  emit('lease', { claims: [] })
  await requestBrowserTaskReread('claims')
  assert.equal(useBrowserTaskWork.getState().tasks['bt-1'].attention?.reason, 'login', 'the released page re-read the need')

  main.attention.set('bt-1', attention('login', 'tab-2', 'att-9'))
  useAgent.setState({ scopeRunStates: { 'scope-a': { ...busyRun, phase: 'done', terminalReason: 'done' } as never } })
  assert.deepEqual(useBrowserTaskWork.getState().activeRunIds, [])
  await requestBrowserTaskReread('run-ended')
  assert.equal(useBrowserTaskWork.getState().tasks['bt-1'].attention?.id, 'att-9')
})

test('the task name is what the person asked, skipping the help inputs that only point back at it', () => {
  const message = (id: string, type: AgentMessage['type'], content: string, runId?: string): AgentMessage => ({
    id, agent: 'butler', type, content, timestamp: new Date(), ...(runId ? { meta: { runId } } : {}),
  })
  const messages = [
    message('u1', 'user', '  帮我调研三家印厂的报价\n要含运费'),
    message('a1', 'agent', '需要登录', 'run-1'),
    message('browser-help:bt-1:att-1', 'user', '我已完成登录，请重新检查页面后继续原任务。'),
    message('a2', 'agent', '好的', 'run-2'),
  ]
  assert.equal(requestTextForRun(messages, 'run-1'), '帮我调研三家印厂的报价\n要含运费')
  assert.equal(requestTextForRun(messages, 'run-2'), '帮我调研三家印厂的报价\n要含运费')
  assert.equal(requestTextForRun(messages, 'run-x'), null)
  assert.equal(shortTaskTitle('  帮我调研三家印厂的报价\n要含运费'), '帮我调研三家印厂的报价')
  assert.equal(shortTaskTitle('一'.repeat(40)).length, 24)
})
