import assert from 'node:assert/strict'
import test from 'node:test'

import {
  beginBrowserTabDragSession,
  endBrowserTabDragSession,
  getActiveBrowserTabDragPayload,
  __browserTabDragSessionAgeMs,
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

test('browser tab drag session is auto-cleared after 60s TTL (regression for unmounted-mid-drag leak)', () => {
  // Stub Date.now to simulate the TTL elapsing without sleeping the test.
  const realNow = Date.now
  let virtualNow = 1_000_000
  globalThis.Date.now = () => virtualNow

  try {
    endBrowserTabDragSession() // reset
    beginBrowserTabDragSession({
      type: 'browser-tab',
      tabId: 'tab-stale',
      title: 'Stale',
      name: 'Stale',
      url: 'https://stale.local',
    })

    // Within the TTL window the payload is returned normally.
    virtualNow += 50_000
    assert.notStrictEqual(getActiveBrowserTabDragPayload(), null, 'within 60s: payload should still be live')
    assert.equal(__browserTabDragSessionAgeMs(), 50_000)

    // Past the TTL the get must return null AND clear the underlying record.
    virtualNow += 11_000 // total age 61s
    assert.strictEqual(
      getActiveBrowserTabDragPayload(),
      null,
      'past 60s: payload must be auto-cleared so subsequent unrelated drags do not surface it',
    )
    assert.strictEqual(__browserTabDragSessionAgeMs(), null, 'internal record must be cleared after stale get')
  } finally {
    globalThis.Date.now = realNow
    endBrowserTabDragSession()
  }
})
