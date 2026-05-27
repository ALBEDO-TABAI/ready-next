import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createElement, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'

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

test('renderer syncs a main-created popup tab into the visible tab store', async () => {
  const handle = installDom()
  let root: Root | null = null
  try {
    let openedHandler: ((tab: BrowserOpenedTestTab) => void) | null = null
    let createTabCalls = 0
    let boundsSyncs = 0
    Object.defineProperty(handle.dom.window, 'electronAPI', {
      configurable: true,
      value: {
      browser: {
        getTabs: async () => [existingTab],
        createTab: async () => {
          createTabCalls += 1
          return { success: false, error: 'renderer should not create popup tabs' }
        },
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

    function Harness() {
      const isAddressEditingRef = useRef(false)
      useBrowserRuntimeEffects({
        isElectron: true,
        isActive: true,
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
      root?.render(createElement(Harness))
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    assert.ok(openedHandler)
    openedHandler({
      ...existingTab,
      id: 'tab-popup',
      url: 'http://127.0.0.1:18202/popup.html',
      title: 'Popup',
      domain: '127.0.0.1',
      active: true,
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    const state = useBrowserTabs.getState()
    assert.equal(createTabCalls, 0)
    assert.equal(state.activeTabId, 'tab-popup')
    assert.equal(state.urlInput, 'http://127.0.0.1:18202/popup.html')
    assert.equal(state.tabs.some((tab) => tab.id === 'tab-popup' && tab.title === 'Popup'), true)
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
