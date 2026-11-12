import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_BROWSER_URL,
  READY_BROWSER_BLANK_URL,
  extractBrowserDomain,
  isReadyBrowserBlankUrl,
  isLocalHtmlBrowserUrl,
  isSupportedBrowserNavigationUrl,
  isLikelyAbsolutePath,
  normalizeBrowserUrlInput,
} from '../renderer/modules/browser/url-utils'
import { isLocalHtmlFilePath, openLocalHtmlFileInBrowser } from '../renderer/modules/browser/localHtmlFileOpen'
import { useBrowserTabs } from '../renderer/stores/useBrowserTabs'

test('extractBrowserDomain handles regular urls and invalid input safely', () => {
  assert.equal(extractBrowserDomain('https://sub.example.com/path'), 'example.com')
  assert.equal(extractBrowserDomain('not-a-url'), '')
})

test('isLikelyAbsolutePath detects unix windows and UNC paths', () => {
  assert.equal(isLikelyAbsolutePath('/Users/demo/file.txt'), true)
  assert.equal(isLikelyAbsolutePath('C:\\\\demo\\\\file.txt'), true)
  assert.equal(isLikelyAbsolutePath('\\\\server\\share\\file.txt'), true)
  assert.equal(isLikelyAbsolutePath('example.com'), false)
})

test('normalizeBrowserUrlInput preserves urls, maps paths, and falls back to search/default', () => {
  const toFileUrl = (path: string) => `file://${path}`

  assert.equal(normalizeBrowserUrlInput('', toFileUrl), DEFAULT_BROWSER_URL)
  assert.equal(DEFAULT_BROWSER_URL, READY_BROWSER_BLANK_URL)
  assert.equal(isReadyBrowserBlankUrl(DEFAULT_BROWSER_URL), true)
  assert.equal(normalizeBrowserUrlInput('https://openai.com', toFileUrl), 'https://openai.com')
  assert.equal(normalizeBrowserUrlInput('/tmp/demo.txt', toFileUrl), 'file:///tmp/demo.txt')
  assert.equal(normalizeBrowserUrlInput('example.com', toFileUrl), 'https://example.com')
  assert.equal(normalizeBrowserUrlInput('hello world', toFileUrl), 'https://www.google.com/search?q=hello%20world')
})

test('isSupportedBrowserNavigationUrl allows web urls, local HTML files, and the Ready blank page only', () => {
  const encodedHtml = READY_BROWSER_BLANK_URL.slice(READY_BROWSER_BLANK_URL.indexOf(',') + 1)
  const previousBlankSurfaceUrl = `data:text/html;charset=utf-8,${encodeURIComponent(
    decodeURIComponent(encodedHtml).replace('#e8e8e9', '#eff2f6'),
  )}`

  assert.equal(isSupportedBrowserNavigationUrl(READY_BROWSER_BLANK_URL), true)
  assert.equal(isReadyBrowserBlankUrl(previousBlankSurfaceUrl), true)
  assert.equal(isSupportedBrowserNavigationUrl(previousBlankSurfaceUrl), true)
  assert.equal(isSupportedBrowserNavigationUrl('https://openai.com'), true)
  assert.equal(isSupportedBrowserNavigationUrl('http://example.com'), true)
  assert.equal(isSupportedBrowserNavigationUrl('file:///tmp/demo.html'), true)
  assert.equal(isSupportedBrowserNavigationUrl('local-file:///tmp/demo.htm'), true)
  assert.equal(isSupportedBrowserNavigationUrl('data:text/html,external'), false)
  assert.equal(isSupportedBrowserNavigationUrl('file:///tmp/demo.txt'), false)
  assert.equal(isSupportedBrowserNavigationUrl('local-file:///tmp/demo.txt'), false)
})

test('local HTML helpers only accept htm/html file targets', async () => {
  assert.equal(isLocalHtmlBrowserUrl('file:///tmp/Demo.HTML'), true)
  assert.equal(isLocalHtmlBrowserUrl('local-file:///Users/demo/page.htm'), true)
  assert.equal(isLocalHtmlBrowserUrl('file:///tmp/demo.md'), false)
  assert.equal(isLocalHtmlFilePath('/Users/demo/page.html'), true)
  assert.equal(isLocalHtmlFilePath('/Users/demo/page.txt'), false)

  const previousWindow = globalThis.window
  let createdUrl = ''
  let switchedTabId = ''
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    electronAPI: {
      browser: {
        getTabs: async () => [],
        createTab: async (url: string) => {
          createdUrl = url
          return { success: true, tabId: 'local-html-tab' }
        },
        switchTab: async (tabId: string) => {
          switchedTabId = tabId
          return { success: true, url: createdUrl, title: 'page.html' }
        },
      },
    },
  }

  useBrowserTabs.setState({ tabs: [], activeTabId: null, urlInput: '' })
  try {
    const opened = await openLocalHtmlFileInBrowser('/Users/demo/page.html', 'page.html')
    assert.equal(opened, true)
    assert.equal(createdUrl, 'file:///Users/demo/page.html')
    assert.equal(switchedTabId, 'local-html-tab')
    const state = useBrowserTabs.getState()
    assert.equal(state.activeTabId, 'local-html-tab')
    assert.equal(state.urlInput, 'file:///Users/demo/page.html')
    assert.equal(state.tabs[0]?.title, 'page.html')
  } finally {
    useBrowserTabs.setState({ tabs: [], activeTabId: null, urlInput: '' })
    ;(globalThis as typeof globalThis & { window: unknown }).window = previousWindow
  }
})

test('local HTML opener reuses and repairs an existing legacy local-file tab', async () => {
  const previousWindow = globalThis.window
  const calls: string[] = []
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    electronAPI: {
      browser: {
        getTabs: async () => [{
          id: 'legacy-html-tab',
          url: 'local-file:///Users/demo/page.html',
          title: 'Old Local File',
          loading: false,
          canGoBack: false,
          canGoForward: false,
          active: false,
        }],
        navigate: async (tabId: string, url: string) => {
          calls.push(`navigate:${tabId}:${url}`)
          return { success: true }
        },
        switchTab: async (tabId: string) => {
          calls.push(`switch:${tabId}`)
          return { success: true, url: 'file:///Users/demo/page.html', title: 'page.html' }
        },
        createTab: async () => {
          calls.push('create')
          return { success: true, tabId: 'unexpected-tab' }
        },
      },
    },
  }

  useBrowserTabs.setState({ tabs: [], activeTabId: null, urlInput: '' })
  try {
    const opened = await openLocalHtmlFileInBrowser('/Users/demo/page.html', 'page.html')
    assert.equal(opened, true)
    assert.deepEqual(calls, [
      'navigate:legacy-html-tab:file:///Users/demo/page.html',
      'switch:legacy-html-tab',
    ])
    const state = useBrowserTabs.getState()
    assert.equal(state.activeTabId, 'legacy-html-tab')
    assert.equal(state.urlInput, 'file:///Users/demo/page.html')
    assert.equal(state.tabs.length, 1)
    assert.equal(state.tabs[0]?.url, 'file:///Users/demo/page.html')
  } finally {
    useBrowserTabs.setState({ tabs: [], activeTabId: null, urlInput: '' })
    ;(globalThis as typeof globalThis & { window: unknown }).window = previousWindow
  }
})

test('local HTML opener prefers an already healthy file tab over a stale legacy tab', async () => {
  const previousWindow = globalThis.window
  const calls: string[] = []
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    electronAPI: {
      browser: {
        getTabs: async () => [
          {
            id: 'stale-local-tab',
            url: 'local-file:///Users/demo/page.html',
            title: 'Loading...',
            loading: true,
            canGoBack: false,
            canGoForward: false,
            active: false,
          },
          {
            id: 'healthy-file-tab',
            url: 'file:///Users/demo/page.html',
            title: 'page.html',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            active: false,
          },
        ],
        navigate: async (tabId: string, url: string) => {
          calls.push(`navigate:${tabId}:${url}`)
          return { success: true }
        },
        switchTab: async (tabId: string) => {
          calls.push(`switch:${tabId}`)
          return { success: true, url: 'file:///Users/demo/page.html', title: 'page.html' }
        },
        createTab: async () => {
          calls.push('create')
          return { success: true, tabId: 'unexpected-tab' }
        },
      },
    },
  }

  useBrowserTabs.setState({ tabs: [], activeTabId: null, urlInput: '' })
  try {
    const opened = await openLocalHtmlFileInBrowser('/Users/demo/page.html', 'page.html')
    assert.equal(opened, true)
    assert.deepEqual(calls, ['switch:healthy-file-tab'])
    const state = useBrowserTabs.getState()
    assert.equal(state.activeTabId, 'healthy-file-tab')
    assert.equal(state.tabs[0]?.url, 'file:///Users/demo/page.html')
  } finally {
    useBrowserTabs.setState({ tabs: [], activeTabId: null, urlInput: '' })
    ;(globalThis as typeof globalThis & { window: unknown }).window = previousWindow
  }
})

test('Ready blank BrowserView fallback keeps only a neutral blank surface', () => {
  const encodedHtml = READY_BROWSER_BLANK_URL.slice(READY_BROWSER_BLANK_URL.indexOf(',') + 1)
  const html = decodeURIComponent(encodedHtml)

  assert.match(html, /--ready-blank-surface: #e8e8e9/)
  assert.match(html, /--ready-blank-surface: #24282e/)
  assert.match(html, /height: 100%/)
  assert.doesNotMatch(html, /ready-dot-logo/)
  assert.doesNotMatch(html, /ready-wordmark/)
})
