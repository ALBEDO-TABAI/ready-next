import assert from 'node:assert/strict'
import test from 'node:test'

import { planBrowserHostPresentation } from '../renderer/modules/browser/browserHostPresentation'

test('already-presented browser host keeps the native host visible when the tab count changes', () => {
  const plan = planBrowserHostPresentation({
    shouldPresentBrowserHost: true,
    shouldRevealBrowserHost: true,
    canShowBrowserHost: true,
    browserRuntimeReady: true,
    tabCount: 3,
    activeTabId: 'tab-2',
    splitTabId: null,
    hostAlreadyPresented: true,
  })

  assert.deepEqual(plan, {
    action: 'sync-bounds',
    fitActiveTabId: 'tab-2',
    fitSplitTabId: null,
  })
})

test('browser host hides only when there is no usable active tab to present', () => {
  const plan = planBrowserHostPresentation({
    shouldPresentBrowserHost: true,
    shouldRevealBrowserHost: true,
    canShowBrowserHost: true,
    browserRuntimeReady: true,
    tabCount: 0,
    activeTabId: null,
    splitTabId: null,
    hostAlreadyPresented: true,
  })

  assert.deepEqual(plan, {
    action: 'hide',
    fitActiveTabId: null,
    fitSplitTabId: null,
  })
})
