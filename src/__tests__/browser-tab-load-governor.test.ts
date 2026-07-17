import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BrowserTabLoadGovernor,
  type GovernedBrowserTab,
} from '../main/modules/browser-engine/browser-tab-load-governor'
import { BrowserPerformanceRuntime, type BrowserPerformanceTab } from '../main/modules/browser-engine/browser-performance-runtime'

function makeTab(id: string): GovernedBrowserTab & { calls: boolean[]; audible: boolean } {
  const tab = {
    id,
    required: false,
    activity: 'idle' as const,
    calls: [] as boolean[],
    audible: false,
    view: {
      webContents: {
        setBackgroundThrottling: (allowed: boolean) => tab.calls.push(allowed),
        isCurrentlyAudible: () => tab.audible,
      },
    },
  }
  return tab
}

test('browser tab governor throttles only unprotected background tabs', () => {
  let now = 1_000
  let activeTabId: string | null = 'a'
  const tabs = [makeTab('a'), makeTab('b'), makeTab('c')]
  const governor = new BrowserTabLoadGovernor({
    readSnapshot: () => ({ tabs, activeTabId, splitTabId: null, shouldPresentHosts: true }),
    now: () => now,
    recentInteractionMs: 30,
  })

  governor.reconcile()
  assert.equal(governor.getState('a'), 'visible')
  assert.equal(governor.getState('b'), 'throttled')
  assert.equal(governor.getState('c'), 'throttled')
  assert.deepEqual(tabs[0].calls, [false])
  assert.deepEqual(tabs[1].calls, [true])

  activeTabId = 'b'
  now += 31
  governor.reconcile()
  assert.equal(governor.getState('a'), 'protected-background')
  assert.equal(governor.getState('b'), 'visible')

  now += 31
  governor.reconcile()
  assert.equal(governor.getState('a'), 'throttled')
})

test('audible, runtime-protected, running, and required tabs stay live in background', () => {
  let now = 5_000
  const audible = makeTab('audible')
  audible.audible = true
  const running = makeTab('running')
  running.activity = 'running'
  const required = makeTab('required')
  required.required = true
  const protectedTab = makeTab('protected')
  const tabs = [audible, running, required, protectedTab]
  const governor = new BrowserTabLoadGovernor({
    readSnapshot: () => ({ tabs, activeTabId: null, splitTabId: null, shouldPresentHosts: false }),
    now: () => now,
    recentInteractionMs: 0,
  })
  const release = governor.protect('protected', 'download')

  assert.deepEqual(governor.getSnapshot(), [
    { tabId: 'audible', state: 'protected-background' },
    { tabId: 'running', state: 'protected-background' },
    { tabId: 'required', state: 'protected-background' },
    { tabId: 'protected', state: 'protected-background' },
  ])

  audible.audible = false
  running.activity = 'idle'
  required.required = false
  release()
  now += 1
  governor.reconcile()
  assert.ok(tabs.every((tab) => governor.getState(tab.id) === 'throttled'))
})

test('governor records dormant tabs and does not create a timer without a recent candidate', () => {
  let timers = 0
  const dormant: GovernedBrowserTab = { id: 'dormant', activity: 'idle' }
  const governor = new BrowserTabLoadGovernor({
    readSnapshot: () => ({ tabs: [dormant], activeTabId: null, splitTabId: null, shouldPresentHosts: false }),
    setTimeout: (() => { timers += 1; return 1 as unknown as ReturnType<typeof setTimeout> }),
    clearTimeout: () => undefined,
  })
  governor.reconcile()
  assert.equal(governor.getState('dormant'), 'dormant')
  assert.equal(timers, 0)
})

test('runtime wakes reclaim when recent protection expires and reclaims after the cold floor', () => {
  let now = 0
  let activeTabId: string | null = 'a'
  let nextTimerId = 0
  const timers = new Map<number, { due: number; callback: () => void }>()
  const microtasks: Array<() => void> = []
  const reclaimed: string[] = []
  const makeRuntimeTab = (id: string, required = false): BrowserPerformanceTab => ({
    id,
    url: `https://${id}.example`,
    required,
    activity: 'idle',
    loading: false,
    view: {
      webContents: {
        id: id.charCodeAt(0),
        setBackgroundThrottling: () => undefined,
        isCurrentlyAudible: () => false,
        isDestroyed: () => false,
        close: () => undefined,
        navigationHistory: {
          getAllEntries: () => [{ url: `https://${id}.example` }],
          getActiveIndex: () => 0,
        },
      },
      setBounds: () => undefined,
      setVisible: () => undefined,
    } as BrowserPerformanceTab['view'],
  })
  const tabs = [makeRuntimeTab('a'), makeRuntimeTab('b', true), makeRuntimeTab('c', true), makeRuntimeTab('d', true), makeRuntimeTab('e', true)]
  const flushMicrotasks = () => {
    while (microtasks.length > 0) microtasks.shift()?.()
  }
  const advanceTo = (target: number) => {
    while (true) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort((left, right) => left[1].due - right[1].due)[0]
      if (!next) break
      timers.delete(next[0])
      now = next[1].due
      next[1].callback()
      flushMicrotasks()
    }
    now = target
    flushMicrotasks()
  }
  const runtime = new BrowserPerformanceRuntime({
    getTabs: () => tabs,
    getActiveTabId: () => activeTabId,
    getSplitTabId: () => null,
    shouldPresentHosts: () => true,
    getProtectionReasons: () => [],
    detachHost: (view) => {
      const tab = tabs.find((candidate) => candidate.view === view)
      if (tab) reclaimed.push(tab.id)
    },
    disposeTabResources: () => undefined,
    emitTabUpdate: () => undefined,
    log: () => undefined,
    now: () => now,
    setTimeout: (callback, delayMs) => {
      const id = ++nextTimerId
      timers.set(id, { due: now + delayMs, callback })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: (handle) => { timers.delete(handle as unknown as number) },
    queueMicrotask: (callback) => { microtasks.push(callback) },
    getTotalMemoryBytes: () => 4 * 1024 ** 3,
    getAppMetrics: () => [],
    recentInteractionMs: 30_000,
    recentInputFloorMs: 5 * 60_000,
  })

  runtime.reconcile()
  flushMicrotasks()
  activeTabId = 'b'
  runtime.onLoadStateMayChange('b', 'activated')
  flushMicrotasks()
  assert.deepEqual(reclaimed, [])

  advanceTo(30_000)
  assert.deepEqual(reclaimed, [])
  advanceTo(5 * 60_000)
  assert.deepEqual(reclaimed, ['a'])
  assert.equal(tabs[0].view, undefined)
  runtime.destroy()
})
