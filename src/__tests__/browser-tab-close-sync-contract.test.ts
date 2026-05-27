import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createElement, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { closeBrowserTabAndNotify } from '../main/modules/browser-engine/tab-close-notifier'

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

interface BrowserCloseTestTab {
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

const tabA: BrowserCloseTestTab = {
  id: 'tab-a',
  url: 'https://a.example/',
  title: 'A',
  domain: 'a.example',
  favicon: null,
  owner: 'manual',
  required: false,
  activity: 'idle',
  lastAuditedAt: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  error: null,
  active: false,
}

const tabB: BrowserCloseTestTab = {
  ...tabA,
  id: 'tab-b',
  url: 'https://b.example/',
  title: 'B',
  domain: 'b.example',
  active: true,
}

test('main closeTab success pushes a closed tab update to the renderer sender', () => {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const result = closeBrowserTabAndNotify(
    {
      activeTabId: 'tab-a',
      closeTab: (tabId: string) => ({ success: tabId === 'tab-b' }),
    },
    {
      send: (channel, payload) => {
        sent.push({ channel, payload })
      },
    },
    'tab-b',
  )

  assert.deepEqual(result, { success: true })
  assert.deepEqual(sent, [
    {
      channel: 'browser:tabUpdate',
      payload: { type: 'closed', tabId: 'tab-b', activeTabId: 'tab-a' },
    },
  ])
})

test('main closeTab failure does not send a renderer closed event', () => {
  const sent: unknown[] = []
  const result = closeBrowserTabAndNotify(
    {
      activeTabId: 'tab-a',
      closeTab: () => ({ success: false, error: 'not found' }),
    },
    {
      send: (...args) => {
        sent.push(args)
      },
    },
    'missing-tab',
  )

  assert.deepEqual(result, { success: false, error: 'not found' })
  assert.deepEqual(sent, [])
})

test('renderer removes closed tabs from visible and persisted browser state', async () => {
  const handle = installDom()
  let root: Root | null = null
  try {
    let updateHandler: ((event: unknown) => void) | null = null
    Object.defineProperty(handle.dom.window, 'electronAPI', {
      configurable: true,
      value: {
        browser: {
          getTabs: async () => [tabA, tabB],
          createTab: async () => ({ success: false, error: 'renderer should restore existing tabs' }),
          switchTab: async () => ({ success: true }),
          onTabUpdate: (callback: (event: unknown) => void) => {
            updateHandler = callback
            return () => {
              updateHandler = null
            }
          },
          onTabOpened: () => () => undefined,
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
        sendBoundsImmediate: async () => undefined,
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

    assert.equal(useBrowserTabs.getState().activeTabId, 'tab-b')
    assert.ok(updateHandler)
    updateHandler({ type: 'closed', tabId: 'tab-b', activeTabId: 'tab-a' })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    const state = useBrowserTabs.getState()
    assert.deepEqual(state.tabs.map((tab) => tab.id), ['tab-a'])
    assert.equal(state.activeTabId, 'tab-a')
    assert.equal(state.urlInput, 'https://a.example/')
  } finally {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }
    handle.restore()
  }
})
