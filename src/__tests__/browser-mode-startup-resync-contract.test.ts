import assert from 'node:assert/strict'
import test from 'node:test'

import { planBrowserHostPresentation } from '../renderer/modules/browser/browserHostPresentation'

test('browser startup presentation waits for a ready active tab before showing the native host', () => {
  assert.deepEqual(planBrowserHostPresentation({
    shouldPresentBrowserHost: true,
    shouldRevealBrowserHost: true,
    canShowBrowserHost: true,
    browserRuntimeReady: false,
    tabCount: 1,
    activeTabId: 'tab-1',
    splitTabId: null,
    hostAlreadyPresented: false,
  }), {
    action: 'hide',
    fitActiveTabId: null,
    fitSplitTabId: null,
  })

  assert.deepEqual(planBrowserHostPresentation({
    shouldPresentBrowserHost: true,
    shouldRevealBrowserHost: true,
    canShowBrowserHost: true,
    browserRuntimeReady: true,
    tabCount: 1,
    activeTabId: 'tab-1',
    splitTabId: null,
    hostAlreadyPresented: false,
  }), {
    action: 'show',
    fitActiveTabId: 'tab-1',
    fitSplitTabId: null,
  })
})

test('browser presentation stays hidden while the active tab has no native surface to show', () => {
  assert.deepEqual(planBrowserHostPresentation({
    shouldPresentBrowserHost: true,
    shouldRevealBrowserHost: true,
    canShowBrowserHost: false,
    browserRuntimeReady: true,
    tabCount: 1,
    activeTabId: 'blank-tab',
    splitTabId: null,
    hostAlreadyPresented: true,
  }), {
    action: 'hide',
    fitActiveTabId: null,
    fitSplitTabId: null,
  })
})
