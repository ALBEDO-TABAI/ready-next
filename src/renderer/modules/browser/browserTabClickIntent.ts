export interface BrowserTabClickIntentInput {
  clickedTabId: string
  shiftKey: boolean
  activeTabId: string | null
  splitTabId: string | null
}

export interface BrowserTabClickIntent {
  activateTabId: string | null
  collapseSplitTabId: string | null
  nextSplitTabId: string | null
  forceBoundsSync: boolean
}

export function resolveBrowserTabClickIntent({
  clickedTabId,
  shiftKey,
  activeTabId,
  splitTabId,
}: BrowserTabClickIntentInput): BrowserTabClickIntent {
  if (shiftKey && clickedTabId !== activeTabId) {
    return {
      activateTabId: null,
      collapseSplitTabId: null,
      nextSplitTabId: clickedTabId,
      forceBoundsSync: false,
    }
  }

  const hasSplit = Boolean(splitTabId && splitTabId !== activeTabId)
  return {
    activateTabId: clickedTabId === activeTabId ? null : clickedTabId,
    collapseSplitTabId: hasSplit && clickedTabId !== splitTabId ? splitTabId : null,
    nextSplitTabId: null,
    forceBoundsSync: hasSplit,
  }
}
