import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

import { useBrowserTabActions } from '../renderer/modules/browser/useBrowserTabActions'
import { DEFAULT_BROWSER_URL, isReadyBrowserBlankUrl, isSupportedBrowserNavigationUrl } from '../renderer/modules/browser/url-utils'
import { useBrowserTabs, type BrowserTab } from '../renderer/stores/useBrowserTabs'

function makeTab(patch: Partial<BrowserTab> = {}): BrowserTab {
  return {
    id: 'tab-1',
    url: 'https://example.com',
    title: 'Example',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    domain: 'example.com',
    owner: 'manual',
    required: false,
    activity: 'idle',
    ...patch,
  }
}

test('Ready blank tab is a supported browser navigation target', () => {
  assert.equal(isReadyBrowserBlankUrl(DEFAULT_BROWSER_URL), true)
  assert.equal(isSupportedBrowserNavigationUrl(DEFAULT_BROWSER_URL), true)
  assert.equal(isSupportedBrowserNavigationUrl('https://example.com'), true)
  assert.equal(isSupportedBrowserNavigationUrl('file:///tmp/example.pdf'), false)
})

test('closing the last browser tab replaces it with a Ready blank tab', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousAnimationFrame = globalThis.requestAnimationFrame
  const previousElectronApi = (globalThis.window as Window & { electronAPI?: unknown } | undefined)?.electronAPI

  Object.defineProperty(globalThis, 'window', {
    value: dom.window,
    configurable: true,
  })
  Object.defineProperty(globalThis, 'document', {
    value: dom.window.document,
    configurable: true,
  })
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    value: (callback: FrameRequestCallback) => {
      callback(0)
      return 0
    },
    configurable: true,
  })

  const closedTabs: string[] = []
  ;(window as Window & { electronAPI?: unknown }).electronAPI = {
    browser: {
      createTab: async (url: string) => {
        assert.equal(url, DEFAULT_BROWSER_URL)
        return { success: true, tabId: 'tab-new' }
      },
      closeTab: async (id: string) => {
        closedTabs.push(id)
        return { success: true }
      },
      getTabs: async () => [
        {
          id: 'tab-new',
          url: DEFAULT_BROWSER_URL,
          title: 'New Tab',
          loading: false,
          canGoBack: false,
          canGoForward: false,
          domain: '',
          active: true,
        },
      ],
    },
  }

  useBrowserTabs.setState({
    tabs: [makeTab({ id: 'tab-old' })],
    activeTabId: 'tab-old',
    urlInput: 'https://example.com',
  })

  let closeLastTab: ((id: string) => Promise<void>) | null = null
  function Harness() {
    const state = useBrowserTabs()
    const actions = useBrowserTabActions({
      isElectron: true,
      activeTab: state.tabs.find((tab) => tab.id === state.activeTabId) || null,
      activeTabId: state.activeTabId,
      normalizeUrl: (value) => value,
      sendBoundsImmediate: async () => {},
      setTabs: state.setTabs,
      setActiveTabId: state.setActiveTabId,
      setUrlInput: state.setUrlInput,
      addTab: state.addTab,
      updateTab: state.updateTab,
      reorderTabs: state.reorderTabs,
    })
    closeLastTab = actions.handleCloseTab
    return null
  }

  const root = createRoot(dom.window.document.getElementById('root') as HTMLElement)
  try {
    flushSync(() => root.render(createElement(Harness)))
    assert.ok(closeLastTab)
    await closeLastTab('tab-old')

    const state = useBrowserTabs.getState()
    assert.deepEqual(closedTabs, ['tab-old'])
    assert.equal(state.tabs.length, 1)
    assert.equal(state.tabs[0]?.id, 'tab-new')
    assert.equal(state.tabs[0]?.url, DEFAULT_BROWSER_URL)
    assert.equal(state.activeTabId, 'tab-new')
    assert.equal(state.urlInput, '')
  } finally {
    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 10))
    useBrowserTabs.setState({ tabs: [], activeTabId: null, urlInput: '' })
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', { value: previousWindow, configurable: true })
      ;(globalThis.window as Window & { electronAPI?: unknown }).electronAPI = previousElectronApi
    } else {
      delete (globalThis as typeof globalThis & { window?: Window }).window
    }
    if (previousDocument) {
      Object.defineProperty(globalThis, 'document', { value: previousDocument, configurable: true })
    } else {
      delete (globalThis as typeof globalThis & { document?: Document }).document
    }
    if (previousAnimationFrame) {
      Object.defineProperty(globalThis, 'requestAnimationFrame', { value: previousAnimationFrame, configurable: true })
    } else {
      delete (globalThis as typeof globalThis & { requestAnimationFrame?: typeof requestAnimationFrame }).requestAnimationFrame
    }
    dom.window.close()
  }
})
