import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createBrowserTabActivationSequencer,
} from '../renderer/modules/browser/browserTabActivationSequencer'
import {
  createBrowserTabSwitchExecutor,
  type BrowserTabSwitchExecutorResult,
} from '../renderer/modules/browser/browserTabSwitchExecutor'
import type { BrowserTab } from '../renderer/stores/useBrowserTabs'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function createTab(id: string, url: string, title: string): BrowserTab {
  return {
    id,
    url,
    title,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    domain: new URL(url).hostname,
    activity: 'idle',
    owner: 'manual',
    required: false,
  }
}

test('browser tab switch executor only applies the newest finished tab activation intent', async () => {
  const sequencer = createBrowserTabActivationSequencer()
  const deferredByTabId = new Map<string, ReturnType<typeof createDeferred<BrowserTabSwitchExecutorResult | undefined>>>([
    ['tab-2', createDeferred<BrowserTabSwitchExecutorResult | undefined>()],
    ['tab-3', createDeferred<BrowserTabSwitchExecutorResult | undefined>()],
  ])

  const state: { activeTabId: string | null; urlInput: string; tabs: BrowserTab[] } = {
    activeTabId: 'tab-1',
    urlInput: 'https://one.example',
    tabs: [
      createTab('tab-1', 'https://one.example', 'One'),
      createTab('tab-2', 'https://two.example', 'Two'),
      createTab('tab-3', 'https://three.example', 'Three'),
    ],
  }

  const executor = createBrowserTabSwitchExecutor({
    switchTab: (tabId) => deferredByTabId.get(tabId)?.promise,
    getState: () => ({
      activeTabId: state.activeTabId,
      tabs: state.tabs,
    }),
    setActiveTabId: (tabId) => {
      state.activeTabId = tabId
    },
    setUrlInput: (value) => {
      state.urlInput = value
    },
    updateTab: (tabId, patch) => {
      state.tabs = state.tabs.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab))
    },
    sequencer,
  })

  const staleSwitch = executor('tab-2')
  const latestSwitch = executor('tab-3')

  deferredByTabId.get('tab-3')?.resolve({
    success: true,
    url: 'https://three.example/final',
    title: 'Three Final',
    domain: 'three.example',
    canGoBack: true,
    canGoForward: false,
  })

  assert.strictEqual(await latestSwitch, true)
  assert.strictEqual(state.activeTabId, 'tab-3')
  assert.strictEqual(state.urlInput, 'https://three.example/final')
  assert.strictEqual(state.tabs.find((tab) => tab.id === 'tab-3')?.title, 'Three Final')

  deferredByTabId.get('tab-2')?.resolve({
    success: true,
    url: 'https://two.example/stale',
    title: 'Two Stale',
    domain: 'two.example',
    canGoBack: false,
    canGoForward: false,
  })

  assert.strictEqual(await staleSwitch, false)
  assert.strictEqual(state.activeTabId, 'tab-3')
  assert.strictEqual(state.urlInput, 'https://three.example/final')
  assert.strictEqual(state.tabs.find((tab) => tab.id === 'tab-2')?.title, 'Two')
})

test('browser tab switch executor ignores completed switches after another action invalidates pending activation intents', async () => {
  const sequencer = createBrowserTabActivationSequencer()
  const deferred = createDeferred<BrowserTabSwitchExecutorResult | undefined>()

  const state: { activeTabId: string | null; urlInput: string; tabs: BrowserTab[] } = {
    activeTabId: 'tab-1',
    urlInput: 'https://one.example',
    tabs: [
      createTab('tab-1', 'https://one.example', 'One'),
      createTab('tab-2', 'https://two.example', 'Two'),
    ],
  }

  const executor = createBrowserTabSwitchExecutor({
    switchTab: () => deferred.promise,
    getState: () => ({
      activeTabId: state.activeTabId,
      tabs: state.tabs,
    }),
    setActiveTabId: (tabId) => {
      state.activeTabId = tabId
    },
    setUrlInput: (value) => {
      state.urlInput = value
    },
    updateTab: (tabId, patch) => {
      state.tabs = state.tabs.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab))
    },
    sequencer,
  })

  const pendingSwitch = executor('tab-2')
  sequencer.invalidate()

  deferred.resolve({
    success: true,
    url: 'https://two.example/late',
    title: 'Two Late',
    domain: 'two.example',
    canGoBack: false,
    canGoForward: false,
  })

  assert.strictEqual(await pendingSwitch, false)
  assert.strictEqual(state.activeTabId, 'tab-1')
  assert.strictEqual(state.urlInput, 'https://one.example')
  assert.strictEqual(state.tabs.find((tab) => tab.id === 'tab-2')?.title, 'Two')
})
