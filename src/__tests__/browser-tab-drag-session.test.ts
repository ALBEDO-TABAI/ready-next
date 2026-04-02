import assert from 'node:assert/strict'
import test from 'node:test'

import {
  beginBrowserTabDragSession,
  endBrowserTabDragSession,
  getActiveBrowserTabDragPayload,
} from '../renderer/modules/browser/browserTabDragSession'

test('browser tab drag session persists the active tab payload during dragover-safe phases', () => {
  beginBrowserTabDragSession({
    type: 'browser-tab',
    tabId: 'tab-42',
    title: 'Ready',
    name: 'Ready',
    url: 'https://ready.local',
  })

  assert.deepStrictEqual(getActiveBrowserTabDragPayload(), {
    type: 'browser-tab',
    tabId: 'tab-42',
    title: 'Ready',
    name: 'Ready',
    url: 'https://ready.local',
  })

  endBrowserTabDragSession()
  assert.strictEqual(getActiveBrowserTabDragPayload(), null)
})
