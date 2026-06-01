import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import { openWebpageInBrowser } from '../renderer/modules/browser/openWebpageInBrowser'
import { READY_WORKBENCH_MODE_CHANGE_EVENT } from '../renderer/modules/workbench/mode-transition'
import { useBrowserTabs } from '../renderer/stores/useBrowserTabs'
import { useMode } from '../renderer/stores/useMode'

async function withDom(run: (dom: JSDOM) => Promise<void>): Promise<void> {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousCustomEvent = globalThis.CustomEvent
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true })
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true })
  Object.defineProperty(globalThis, 'CustomEvent', { value: dom.window.CustomEvent, configurable: true })
  try {
    await run(dom)
  } finally {
    useBrowserTabs.setState({ tabs: [], activeTabId: null, splitTabId: null, browserSplitRatio: 50, urlInput: '' })
    useMode.setState({ appMode: 'workbench', workbenchMode: 'browser', splitMode: null, workbenchSplitRatio: 50, readySubMode: 'browser' })
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', { value: previousWindow, configurable: true })
    } else {
      delete (globalThis as typeof globalThis & { window?: Window }).window
    }
    if (previousDocument) {
      Object.defineProperty(globalThis, 'document', { value: previousDocument, configurable: true })
    } else {
      delete (globalThis as typeof globalThis & { document?: Document }).document
    }
    if (previousCustomEvent) {
      Object.defineProperty(globalThis, 'CustomEvent', { value: previousCustomEvent, configurable: true })
    } else {
      delete (globalThis as typeof globalThis & { CustomEvent?: typeof CustomEvent }).CustomEvent
    }
    dom.window.close()
  }
}

test('openWebpageInBrowser creates a browser tab and requests browser mode without directly changing the mode store', async () => {
  await withDom(async (dom) => {
    useMode.getState().setWorkbenchMode('document')
    const events: string[] = []
    dom.window.addEventListener(READY_WORKBENCH_MODE_CHANGE_EVENT, (event) => {
      events.push(String((event as CustomEvent<{ mode?: string }>).detail?.mode || ''))
    })
    const openedExternally: string[] = []
    dom.window.open = ((href: string) => {
      openedExternally.push(href)
      return null
    }) as typeof dom.window.open
    ;(dom.window as Window & { electronAPI?: unknown }).electronAPI = {
      browser: {
        createTab: async (url: string) => {
          assert.equal(url, 'https://example.com/page')
          return { success: true, tabId: 'tab-new', title: 'Example Page' }
        },
      },
    }

    const opened = await openWebpageInBrowser('https://example.com/page')

    assert.equal(opened, true)
    assert.deepEqual(events, ['browser'])
    assert.equal(useMode.getState().workbenchMode, 'document')
    assert.deepEqual(openedExternally, [])

    const state = useBrowserTabs.getState()
    assert.equal(state.activeTabId, 'tab-new')
    assert.equal(state.urlInput, 'https://example.com/page')
    assert.equal(state.tabs.length, 1)
    assert.equal(state.tabs[0]?.title, 'Example Page')
  })
})

test('openWebpageInBrowser falls back to window.open without entering browser mode when createTab fails', async () => {
  await withDom(async (dom) => {
    useMode.getState().setWorkbenchMode('document')
    let modeRequestCount = 0
    dom.window.addEventListener(READY_WORKBENCH_MODE_CHANGE_EVENT, () => {
      modeRequestCount += 1
    })
    const openedExternally: string[] = []
    dom.window.open = ((href: string) => {
      openedExternally.push(href)
      return null
    }) as typeof dom.window.open
    ;(dom.window as Window & { electronAPI?: unknown }).electronAPI = {
      browser: {
        createTab: async () => ({ success: false, error: 'failed' }),
      },
    }

    const opened = await openWebpageInBrowser('https://example.com/fallback')

    assert.equal(opened, false)
    assert.equal(modeRequestCount, 0)
    assert.equal(useMode.getState().workbenchMode, 'document')
    assert.deepEqual(openedExternally, ['https://example.com/fallback'])
    assert.equal(useBrowserTabs.getState().tabs.length, 0)
    assert.equal(useBrowserTabs.getState().activeTabId, null)
  })
})
