import type { BrowserTab } from '../../stores/useBrowserTabs'
import type { VerticalRailOverlayTab } from '../../../shared/browser-vertical-rail-overlay'
import { extractBrowserDomain } from '../../modules/browser/url-utils'

// Build the overlay's tab array in RAW FLAT order (D-SNAPSHOT). The overlay window does
// its OWN run-local split hoist for display, and a reorder command's toRank resolves
// against this flat array (snapshot.tabs.findIndex), never the visual row — so this must
// NOT pre-hoist the split tab via getActiveTabPairOrder. Both the active tab and the
// split tab are flagged `active` (both render highlighted); only the split is `split`.
export function buildOverlaySnapshotTabs(
  tabs: BrowserTab[],
  activeTabId: string | null,
  splitTabId: string | null,
  bookmarkedUrls: string[],
): VerticalRailOverlayTab[] {
  const marks = new Set(bookmarkedUrls)
  return tabs.map((tab) => {
    const isSplit = tab.id === splitTabId && tab.id !== activeTabId
    return {
      id: tab.id,
      title: tab.title || 'New Tab',
      domain: tab.domain || extractBrowserDomain(tab.url || ''),
      url: tab.url,
      favicon: tab.favicon,
      active: tab.id === activeTabId || isSplit,
      split: isSplit,
      loading: Boolean(tab.loading),
      owner: tab.owner,
      activity: tab.activity,
      required: tab.required,
      bookmarked: marks.has(tab.url),
      groupId: tab.groupId ?? null,
    }
  })
}
