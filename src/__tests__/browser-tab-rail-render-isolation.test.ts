import assert from 'node:assert/strict'
import test from 'node:test'

import {
  areBrowserTabStripRowPropsEqual,
  type BrowserTabStripRowProps,
} from '../renderer/components/browser/VerticalTabRail'
import type { BrowserTab } from '../renderer/stores/useBrowserTabs'

function makeTab(id: string): BrowserTab {
  return {
    id,
    url: `https://${id}.example`,
    title: id,
    loading: false,
    canGoBack: false,
    canGoForward: false,
  }
}

function makeProps(tab: BrowserTab): BrowserTabStripRowProps {
  const noop = () => undefined
  return {
    tab,
    group: undefined,
    groupId: null,
    isPrimaryActive: false,
    isSplitActive: false,
    splitIsNextRow: false,
    prevSameGroup: false,
    nextSameGroup: false,
    isDragging: false,
    dropIntent: null,
    onDragStart: noop,
    onDragEnd: noop,
    onDragOver: noop,
    onDrop: noop,
    onActivate: noop,
    onAuxClick: noop,
    onContextMenu: noop,
    onClose: noop,
  }
}

test('a tab strip row skips an immutable whole-list update that changed another tab', () => {
  const unchangedTab = makeTab('tab-a')
  const previous = makeProps(unchangedTab)
  const next = { ...previous, tab: unchangedTab }

  assert.equal(areBrowserTabStripRowPropsEqual(previous, next), true)
  assert.equal(areBrowserTabStripRowPropsEqual(previous, {
    ...next,
    tab: { ...unchangedTab, title: 'updated' },
  }), false)
  assert.equal(areBrowserTabStripRowPropsEqual(previous, {
    ...next,
    isPrimaryActive: true,
  }), false)
})
