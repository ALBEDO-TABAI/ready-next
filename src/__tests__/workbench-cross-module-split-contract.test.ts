import assert from 'node:assert/strict'
import test from 'node:test'

import { openRSSItemInBrowserTab } from '../renderer/modules/rss/open-rss-item-in-browser'
import { isWorkbenchModePairActive, resolveWorkbenchSplitToggle } from '../renderer/modules/workbench/mode-split'
import { resolveWorkbenchModeTabLayout } from '../renderer/modules/workbench/mode-tabs-layout'

test('Shift-click split selection adds, swaps, and removes only the secondary workbench module', () => {
  assert.equal(
    resolveWorkbenchSplitToggle({
      workbenchMode: 'browser',
      splitMode: null,
      requestedMode: 'document',
    }),
    'document',
  )

  assert.equal(
    resolveWorkbenchSplitToggle({
      workbenchMode: 'browser',
      splitMode: 'document',
      requestedMode: 'rss',
    }),
    'rss',
  )

  assert.equal(
    resolveWorkbenchSplitToggle({
      workbenchMode: 'browser',
      splitMode: 'document',
      requestedMode: 'document',
    }),
    null,
  )

  assert.equal(
    resolveWorkbenchSplitToggle({
      workbenchMode: 'browser',
      splitMode: 'document',
      requestedMode: 'browser',
    }),
    'document',
  )
})

test('browser and rss count as a split pair in either primary/secondary order', () => {
  assert.equal(
    isWorkbenchModePairActive({
      workbenchMode: 'browser',
      splitMode: 'rss',
      firstMode: 'browser',
      secondMode: 'rss',
    }),
    true,
  )

  assert.equal(
    isWorkbenchModePairActive({
      workbenchMode: 'rss',
      splitMode: 'browser',
      firstMode: 'browser',
      secondMode: 'rss',
    }),
    true,
  )

  assert.equal(
    isWorkbenchModePairActive({
      workbenchMode: 'browser',
      splitMode: 'document',
      firstMode: 'browser',
      secondMode: 'rss',
    }),
    false,
  )
})

test('split mode tab layout pulls the secondary icon next to the primary and stretches the thumb over both', () => {
  const browserRss = resolveWorkbenchModeTabLayout('browser', 'rss')
  assert.deepEqual(browserRss.displayModes, ['browser', 'rss', 'document', 'calendar'])
  assert.equal(browserRss.thumbStart, 0)
  assert.equal(browserRss.thumbSpan, 2)
  assert.equal(browserRss.visualIndexByMode.rss, 1)
  assert.equal(browserRss.visualIndexByMode.document, 2)

  const rssBrowser = resolveWorkbenchModeTabLayout('rss', 'browser')
  assert.deepEqual(rssBrowser.displayModes, ['document', 'browser', 'rss', 'calendar'])
  assert.equal(rssBrowser.thumbStart, 1)
  assert.equal(rssBrowser.thumbSpan, 2)

  const single = resolveWorkbenchModeTabLayout('browser', null)
  assert.deepEqual(single.displayModes, ['browser', 'document', 'rss', 'calendar'])
  assert.equal(single.thumbStart, 0)
  assert.equal(single.thumbSpan, 1)
})

test('RSS item browser handoff creates and activates a browser tab for the target link', async () => {
  const createdUrls: string[] = []
  const addedTabs: Array<{ id: string; url: string; title: string }> = []
  let activeTabId: string | null = null
  let urlInput = ''
  let invalidated = false

  const opened = await openRSSItemInBrowserTab(
    {
      link: 'https://example.com/article',
      title: 'Example Article',
    },
    {
      createTab: async (url) => {
        createdUrls.push(url)
        return { success: true, tabId: 'tab-rss' }
      },
      store: {
        addTab: (tab) => {
          addedTabs.push({ id: tab.id, url: tab.url, title: tab.title })
        },
        setActiveTabId: (id) => {
          activeTabId = id
        },
        setUrlInput: (input) => {
          urlInput = input
        },
      },
      invalidateActivation: () => {
        invalidated = true
      },
    },
  )

  assert.equal(opened, true)
  assert.deepEqual(createdUrls, ['https://example.com/article'])
  assert.deepEqual(addedTabs, [
    { id: 'tab-rss', url: 'https://example.com/article', title: 'Example Article' },
  ])
  assert.equal(activeTabId, 'tab-rss')
  assert.equal(urlInput, 'https://example.com/article')
  assert.equal(invalidated, true)
})
