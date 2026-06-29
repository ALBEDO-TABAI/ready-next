import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveBrowserTabClickIntent } from '../renderer/modules/browser/browserTabClickIntent'

describe('resolveBrowserTabClickIntent', () => {
  it('opens a split tab only for shift-clicking a non-active tab', () => {
    assert.deepEqual(resolveBrowserTabClickIntent({
      clickedTabId: 'tab-b',
      shiftKey: true,
      activeTabId: 'tab-a',
      splitTabId: null,
    }), {
      activateTabId: null,
      collapseSplitTabId: null,
      nextSplitTabId: 'tab-b',
      forceBoundsSync: false,
    })
  })

  it('switches tabs normally when split mode is not active', () => {
    assert.deepEqual(resolveBrowserTabClickIntent({
      clickedTabId: 'tab-b',
      shiftKey: false,
      activeTabId: 'tab-a',
      splitTabId: null,
    }), {
      activateTabId: 'tab-b',
      collapseSplitTabId: null,
      nextSplitTabId: null,
      forceBoundsSync: false,
    })
  })

  it('collapses split mode when the active tab is clicked without shift', () => {
    assert.deepEqual(resolveBrowserTabClickIntent({
      clickedTabId: 'tab-a',
      shiftKey: false,
      activeTabId: 'tab-a',
      splitTabId: 'tab-b',
    }), {
      activateTabId: null,
      collapseSplitTabId: 'tab-b',
      nextSplitTabId: null,
      forceBoundsSync: true,
    })
  })

  it('switches to the split tab and collapses split mode on a normal click', () => {
    assert.deepEqual(resolveBrowserTabClickIntent({
      clickedTabId: 'tab-b',
      shiftKey: false,
      activeTabId: 'tab-a',
      splitTabId: 'tab-b',
    }), {
      activateTabId: 'tab-b',
      collapseSplitTabId: null,
      nextSplitTabId: null,
      forceBoundsSync: true,
    })
  })

  it('switches to a third tab and hides the previous split tab on a normal click', () => {
    assert.deepEqual(resolveBrowserTabClickIntent({
      clickedTabId: 'tab-c',
      shiftKey: false,
      activeTabId: 'tab-a',
      splitTabId: 'tab-b',
    }), {
      activateTabId: 'tab-c',
      collapseSplitTabId: 'tab-b',
      nextSplitTabId: null,
      forceBoundsSync: true,
    })
  })
})
