import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createElement, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BrowserTabLifecycleService, type BrowserLifecycleTabRecord } from '../main/modules/browser-engine/tab-lifecycle-service'
import { BrowserTabMetaService } from '../main/modules/browser-engine/tab-meta-service'

type TestGlobal = typeof globalThis & Record<string, unknown>

function installDom(): { dom: JSDOM; restore: () => void } {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost/workbench',
    pretendToBeVisual: true,
  })
  const testGlobal = globalThis as TestGlobal
  const previous = {
    window: testGlobal.window,
    document: testGlobal.document,
    navigator: testGlobal.navigator,
    localStorage: testGlobal.localStorage,
    requestAnimationFrame: testGlobal.requestAnimationFrame,
    cancelAnimationFrame: testGlobal.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: testGlobal.IS_REACT_ACT_ENVIRONMENT,
  }

  const requestAnimationFrame = (callback: FrameRequestCallback) =>
    dom.window.setTimeout(() => callback(Date.now()), 0)
  const cancelAnimationFrame = (id: number) => dom.window.clearTimeout(id)

  testGlobal.window = dom.window
  testGlobal.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', {
    value: dom.window.navigator,
    configurable: true,
  })
  testGlobal.localStorage = dom.window.localStorage
  testGlobal.requestAnimationFrame = requestAnimationFrame
  testGlobal.cancelAnimationFrame = cancelAnimationFrame
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true
  dom.window.requestAnimationFrame = requestAnimationFrame
  dom.window.cancelAnimationFrame = cancelAnimationFrame

  return {
    dom,
    restore: () => {
      for (const [key, value] of Object.entries(previous)) {
        if (key === 'navigator') {
          Object.defineProperty(globalThis, key, {
            value,
            configurable: true,
          })
        } else if (value === undefined) {
          Reflect.deleteProperty(testGlobal, key)
        } else {
          testGlobal[key] = value
        }
      }
      dom.window.close()
    },
  }
}

interface BrowserOpenedTestTab {
  id: string
  url: string
  title: string
  domain: string
  favicon: string | null
  owner: 'manual' | 'agent'
  required: boolean
  activity: 'idle' | 'running' | 'attention'
  lastAuditedAt: number | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error: string | null
  active: boolean
}

const existingTab: BrowserOpenedTestTab = {
  id: 'tab-existing',
  url: 'https://initial.example/',
  title: 'Initial',
  domain: 'initial.example',
  favicon: null,
  owner: 'manual' as const,
  required: false,
  activity: 'idle' as const,
  lastAuditedAt: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  error: null,
  active: true,
}

test('direct main creates reach the mounted tab store across document and browser modes without stealing background focus', async () => {
  const handle = installDom()
  let root: Root | null = null
  try {
    let openedHandler: ((tab: BrowserOpenedTestTab) => void) | null = null
    let createTabCalls = 0
    let boundsSyncs = 0
    let activeTabId: string | null = existingTab.id
    const tabs = new Map<string, BrowserLifecycleTabRecord>([[existingTab.id, existingTab]])
    const metadata = new BrowserTabMetaService({ tabs, getActiveTabId: () => activeTabId, queueTabUpdate: () => {} })
    const lifecycle = new BrowserTabLifecycleService({
      tabs,
      getActiveTabId: () => activeTabId,
      setActiveTabId: (id) => { activeTabId = id },
      setSplitTabId: () => {},
      observeRestoredTabId: () => {},
      getNextTabId: () => `tab-${++createTabCalls}`,
      getViewBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
      shouldPresentHosts: () => false,
      isAllowedUrl: () => true,
      extractDomain: (url) => new URL(url).hostname,
      createHost: () => { throw new Error('mock mode must not create native hosts') },
      resetPageBackground: () => {},
      syncPageBackground: () => {},
      applyBounds: () => {},
      detachHost: () => {},
      showHost: () => {},
      sendToRenderer: (_channel, data) => openedHandler?.(data as BrowserOpenedTestTab),
      queueTabUpdate: () => {},
      buildTabPayload: (tab) => metadata.buildTabPayload(tab),
      emitTabMeta: () => {},
      logBrowserDiag: () => {},
      bindPopup: () => {},
      bindAppShortcutBridge: () => {},
      installContextMenu: () => {},
      handleWindowOpen: () => ({ action: 'deny' }),
      ensureDownloadSession: () => {},
      addHistoryEntry: () => {},
      updateHistoryEntryTitle: () => {},
      handleLocalMediaDropNavigation: () => false,
      browserUserAgent: 'test',
      useMock: true,
    })
    Object.defineProperty(handle.dom.window, 'electronAPI', {
      configurable: true,
      value: {
      browser: {
        getTabs: async () => metadata.getTabList(),
        createTab: lifecycle.createTab.bind(lifecycle),
        switchTab: async () => ({ success: true }),
        onTabUpdate: () => () => undefined,
        onTabOpened: (callback: (tab: BrowserOpenedTestTab) => void) => {
          openedHandler = callback
          return () => {
            openedHandler = null
          }
        },
      },
      },
    })

    const { useBrowserRuntimeEffects } = await import('../renderer/modules/browser/useBrowserRuntimeEffects')
    const { useBrowserTabs } = await import('../renderer/stores/useBrowserTabs')
    useBrowserTabs.setState({
      tabs: [],
      activeTabId: null,
      splitTabId: null,
      browserSplitRatio: 50,
      urlInput: '',
    })

    function Harness({ isActive }: { isActive: boolean }) {
      const isAddressEditingRef = useRef(false)
      useBrowserRuntimeEffects({
        isElectron: true,
        isActive,
        isAddressEditingRef,
        sendBoundsImmediate: async () => {
          boundsSyncs += 1
        },
      })
      return null
    }

    const host = handle.dom.window.document.getElementById('root')
    assert.ok(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(createElement(Harness, { isActive: false }))
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    assert.ok(openedHandler)
    assert.equal(createTabCalls, 0)
    const url = 'http://127.0.0.1:18202/page.html'
    await act(async () => {
      const created = await window.electronAPI.browser.createTab(url)
      assert.equal(created.success, true)
      assert.equal(created.tabId, 'tab-1')
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    assert.equal(useBrowserTabs.getState().activeTabId, 'tab-1')
    assert.equal(useBrowserTabs.getState().urlInput, url)
    // Renderer-driven callers also add the returned tab; the announcement must
    // not leave a duplicate row whichever side arrives first.
    useBrowserTabs.getState().addTab({ ...existingTab, id: 'tab-1', url })
    await act(async () => {
      root?.render(createElement(Harness, { isActive: true }))
      await window.electronAPI.browser.createTab(`${url}?background`, { background: true })
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    const state = useBrowserTabs.getState()
    assert.equal(state.activeTabId, 'tab-1')
    assert.equal(state.urlInput, url)
    assert.deepEqual(state.tabs.map((tab) => tab.id), [existingTab.id, 'tab-1', 'tab-2'])
    assert.deepEqual(metadata.getTabList().map((tab) => tab.id), state.tabs.map((tab) => tab.id))
    assert.equal(boundsSyncs > 0, true)
  } finally {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }
    handle.restore()
  }
})
