import HeaderUtilityActions from './HeaderUtilityActions'
import TabRail from './TabRail'
import { useBrowserHeaderInteraction } from '../../modules/browser/useBrowserHeaderInteraction'
import { WORKBENCH_HEADER_EDGE_X, WORKBENCH_TAB_ROW_HEIGHT } from '../../modules/workbench/chrome'
import type { BrowserTab } from '../../stores/useBrowserTabs'
import type { BrowserUtilityMenuKind } from '../../../shared/browser-utility-menu'

interface BrowserHeaderProps {
  tabs: BrowserTab[]
  activeTabId: string | null
  urlInput: string
  bookmarkedUrls: string[]
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  isBookmarked: boolean
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
  onToggleBookmark: () => void
  onToggleBookmarkForTab: (tab: BrowserTab) => void
  onShowUtilityMenu: (kind: BrowserUtilityMenuKind, anchorRect: DOMRect) => void
}

export default function BrowserHeader({
  tabs,
  activeTabId,
  urlInput,
  bookmarkedUrls,
  loading,
  canGoBack,
  canGoForward,
  isBookmarked,
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
  onToggleBookmark,
  onToggleBookmarkForTab,
  onShowUtilityMenu,
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
      className="browser-header-surface glass-surface-panel flex-shrink-0"
      style={{ overflow: 'visible', zIndex: 8 }}
    >
      <div
        className="flex items-center no-drag"
        style={{
          minHeight: WORKBENCH_TAB_ROW_HEIGHT,
          paddingLeft: WORKBENCH_HEADER_EDGE_X,
          paddingRight: WORKBENCH_HEADER_EDGE_X,
          gap: 8,
          background: 'transparent',
          borderBottom: '1px solid transparent',
          alignItems: 'center',
          position: 'relative',
          zIndex: 2,
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
          onShowUtilityMenu={(kind, anchorRect) => {
            collapseAndReset()
            onShowUtilityMenu(kind, anchorRect)
          }}
        />
      </div>
    </div>
  )
}
