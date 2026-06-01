import assert from 'node:assert/strict'
import test from 'node:test'

import { planBrowserHostPresentation } from '../renderer/modules/browser/browserHostPresentation'

test('ordinary browser tab activation resyncs bounds instead of hiding and re-showing the native host', () => {
  const plan = planBrowserHostPresentation({
    shouldPresentBrowserHost: true,
    shouldRevealBrowserHost: true,
    canShowBrowserHost: true,
    browserRuntimeReady: true,
    tabCount: 2,
    activeTabId: 'next-tab',
    splitTabId: null,
    hostAlreadyPresented: true,
  })

  assert.equal(plan.action, 'sync-bounds')
  assert.equal(plan.fitActiveTabId, 'next-tab')
  assert.equal(plan.fitSplitTabId, null)
})

test('first browser presentation still shows the native host once after fitting the active tab', () => {
  const plan = planBrowserHostPresentation({
    shouldPresentBrowserHost: true,
    shouldRevealBrowserHost: true,
    canShowBrowserHost: true,
    browserRuntimeReady: true,
    tabCount: 1,
    activeTabId: 'first-tab',
    splitTabId: null,
    hostAlreadyPresented: false,
  })

  assert.equal(plan.action, 'show')
  assert.equal(plan.fitActiveTabId, 'first-tab')
})

test('split browser presentation fits both panes while staying on the bounds-sync path', () => {
  const plan = planBrowserHostPresentation({
    shouldPresentBrowserHost: true,
    shouldRevealBrowserHost: true,
    canShowBrowserHost: true,
    browserRuntimeReady: true,
    tabCount: 2,
    activeTabId: 'primary-tab',
    splitTabId: 'secondary-tab',
    hostAlreadyPresented: true,
  })

  assert.deepEqual(plan, {
    action: 'sync-bounds',
    fitActiveTabId: 'primary-tab',
    fitSplitTabId: 'secondary-tab',
  })
})
