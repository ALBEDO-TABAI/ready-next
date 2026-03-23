import HeaderUtilityActions from './HeaderUtilityActions'
import TabRail from './TabRail'
import type { PanelType } from '../../modules/browser/types'
import { useBrowserHeaderInteraction } from '../../modules/browser/useBrowserHeaderInteraction'
import { WORKBENCH_HEADER_EDGE_X, WORKBENCH_TAB_ROW_HEIGHT } from '../../modules/workbench/chrome'
import type { BrowserTab } from '../../stores/useBrowserTabs'

interface BrowserHeaderProps {
  tabs: BrowserTab[]
  activeTabId: string | null
  url: string
  urlInput: string
  bookmarkedUrls: string[]
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  isBookmarked: boolean
  adblockEnabled: boolean
  adblockDomainWhitelisted: boolean
  currentDomain?: string
  activePanel: PanelType
  onTabClick: (id: string) => void
  onTabClose: (id: string) => void
  onNewTab: () => void
  onReorder: (fromIndex: number, toIndex: number) => void
  onUrlChange: (val: string) => void
  onNavigate: (url?: string) => void
  onGoBack: () => void
  onGoForward: () => void
  onRefresh: () => void
  onFocus: () => void
  onBlur: () => void
  onEditStart: () => void
  onEditEnd: () => void
  onOpenExternal: () => void
  onToggleBookmark: () => void
  onToggleBookmarkForTab: (tab: BrowserTab) => void
  onToggleAdblock: () => void
  onToggleCurrentSiteAdblock: () => void
  onTogglePanel: (panel: 'bookmarks' | 'downloads' | 'history') => void
  onPrint: () => void
}

export default function BrowserHeader({
  tabs,
  activeTabId,
  url,
  urlInput,
  bookmarkedUrls,
  loading,
  canGoBack,
  canGoForward,
  isBookmarked,
  adblockEnabled,
  adblockDomainWhitelisted,
  currentDomain,
  activePanel,
  onTabClick,
  onTabClose,
  onNewTab,
  onReorder,
  onUrlChange,
  onNavigate,
  onGoBack,
  onGoForward,
  onRefresh,
  onFocus,
  onBlur,
  onEditStart,
  onEditEnd,
  onOpenExternal,
  onToggleBookmark,
  onToggleBookmarkForTab,
  onToggleAdblock,
  onToggleCurrentSiteAdblock,
  onTogglePanel,
  onPrint,
}: BrowserHeaderProps) {
  const {
    headerRootRef,
    activeTabSurfaceRef,
    activeTabMode,
    refreshDockMode,
    collapseActiveTab,
    primeActiveTab,
    resetActiveTabPrime,
    expandActiveTab,
    beginEditing,
    stopEditing,
    beginRefreshDockHover,
    endRefreshDockHover,
  } = useBrowserHeaderInteraction()

  const collapseAndReset = () => {
    onBlur()
    onEditEnd()
    collapseActiveTab()
  }

  return (
    <div
      ref={headerRootRef}
      className="glass-surface-panel flex-shrink-0"
    >
      <div
        className="flex items-center no-drag"
        style={{
          minHeight: WORKBENCH_TAB_ROW_HEIGHT,
          paddingLeft: WORKBENCH_HEADER_EDGE_X,
          paddingRight: WORKBENCH_HEADER_EDGE_X,
          gap: 8,
          background: 'color-mix(in srgb, var(--surface-toolbar-bg) 14%, transparent)',
          borderBottom: '1px solid transparent',
        }}
      >
        <TabRail
          tabs={tabs}
          activeTabId={activeTabId}
          activeTabMode={activeTabMode}
          loading={loading}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          refreshDockMode={refreshDockMode}
          activeTabSurfaceRef={activeTabSurfaceRef}
          urlInput={urlInput}
          isBookmarked={isBookmarked}
          bookmarkedUrls={bookmarkedUrls}
          onTabClick={onTabClick}
          onTabClose={onTabClose}
          onNewTab={onNewTab}
          onReorder={onReorder}
          onUrlChange={onUrlChange}
          onExpandRequest={() => {
            onFocus()
            expandActiveTab()
          }}
          onHotspotEnter={primeActiveTab}
          onHotspotLeave={resetActiveTabPrime}
          onInputFocus={() => {
            onFocus()
            onEditStart()
            beginEditing()
          }}
          onInputBlur={() => {
            onEditEnd()
            requestAnimationFrame(() => stopEditing())
          }}
          onRefreshDockEnter={beginRefreshDockHover}
          onRefreshDockLeave={endRefreshDockHover}
          onRefresh={() => {
            collapseAndReset()
            onRefresh()
          }}
          onGoBack={() => {
            collapseAndReset()
            onGoBack()
          }}
          onGoForward={() => {
            collapseAndReset()
            onGoForward()
          }}
          onCommitNavigation={() => {
            onEditEnd()
            onNavigate()
            collapseActiveTab()
          }}
          onToggleBookmark={() => {
            onToggleBookmark()
            collapseAndReset()
          }}
          onToggleBookmarkForTab={onToggleBookmarkForTab}
        />

        <HeaderUtilityActions
          adblockEnabled={adblockEnabled}
          adblockDomainWhitelisted={adblockDomainWhitelisted}
          currentDomain={currentDomain}
          activePanel={activePanel}
          onToggleAdblock={() => {
            collapseAndReset()
            onToggleAdblock()
          }}
          onToggleCurrentSiteAdblock={() => {
            collapseAndReset()
            onToggleCurrentSiteAdblock()
          }}
          onTogglePanel={(panel) => {
            collapseAndReset()
            onTogglePanel(panel)
          }}
          onPrint={() => {
            collapseAndReset()
            onPrint()
          }}
          onOpenExternal={() => {
            collapseAndReset()
            onOpenExternal()
          }}
        />
      </div>
    </div>
  )
}
