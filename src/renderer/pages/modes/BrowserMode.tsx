import { useCallback, useRef, useEffect, useState, useMemo } from 'react'
import BrowserModeEmptyState from '../../components/browser/BrowserModeEmptyState'
import BrowserHeader from '../../components/browser/BrowserHeader'
import BrowserShellLayout from '../../components/browser/BrowserShellLayout'
import { useBrowserDiagnosticsState } from '../../modules/browser/useBrowserDiagnosticsState'
import { useBrowserPanelData } from '../../modules/browser/useBrowserPanelData'
import { useBrowserRuntimeEffects } from '../../modules/browser/useBrowserRuntimeEffects'
import { useBrowserTabActions } from '../../modules/browser/useBrowserTabActions'
import { useBrowserViewBounds } from '../../modules/browser/useBrowserViewBounds'
import {
  extractBrowserDomain,
  normalizeBrowserUrlInput,
} from '../../modules/browser/url-utils'
import type { PanelType } from '../../modules/browser/types'
import { useWorkspace } from '../../stores/useWorkspace'
import { useBrowserTabs, type BrowserTab } from '../../stores/useBrowserTabs'
import { toFileUrl } from '../../utils/dragDrop'

export default function BrowserMode({ isActive = true }: { isActive?: boolean }) {
  // Persistent browser tab state — survives mode switches
  const {
    tabs, activeTabId, urlInput,
    setTabs, setActiveTabId, setUrlInput,
    addTab, updateTab, reorderTabs,
  } = useBrowserTabs()
  const [activePanel, setActivePanel] = useState<PanelType>(null)
  const [isAddressEditing, setIsAddressEditing] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const isElectron = typeof window !== 'undefined' && !!window.electronAPI

  const sidebarVisible = useWorkspace(s => s.sidebarVisible)
  const sidePanelVariant = useWorkspace(s => s.sidePanelVariant)
  const sidePanelWidths = useWorkspace(s => s.sidePanelWidths)
  const skillsSplitRatio = useWorkspace(s => s.skillsSplitRatio)
  const chatPanelVisible = useWorkspace(s => s.chatPanelVisible)
  const chatPanelWidth = useWorkspace(s => s.chatPanelWidth)
  const effectiveSidePanelWidth = sidePanelWidths.shared
  const activeTab = tabs.find(t => t.id === activeTabId) || null
  const currentDomain = activeTab?.domain || extractBrowserDomain(activeTab?.url || '')
  const hasError = !!activeTab?.error
  const { sendBoundsImmediate } = useBrowserViewBounds({
    isElectron,
    contentRef,
    isActive,
    topInset: 0,
    sidebarVisible,
    sidePanelVariant,
    effectiveSidePanelWidth,
    skillsSplitRatio,
    chatPanelVisible,
    chatPanelWidth,
    activePanel,
    hasError,
  })

  // URL helpers — auto-Google for non-URL input (Task 2)
  const normalizeUrl = useCallback((input: string): string => {
    return normalizeBrowserUrlInput(input, toFileUrl)
  }, [])

  const {
    isBookmarked,
    bookmarks,
    selectedBookmarkUrl,
    historyItems,
    downloads,
    setSelectedBookmarkUrl,
    handleToggleBookmark,
    handleToggleBookmarkForTab,
    handleTogglePanel,
    handleNavigateFromPanel,
    handleRemoveBookmark,
    handleClearHistory,
    handleClearDownloads,
  } = useBrowserPanelData({
    isElectron,
    activePanel,
    setActivePanel,
    activeTab,
    activeTabId,
    updateTab,
    setUrlInput,
  })

  const {
    toastVisible,
    adblockState,
    browserDiagnostics,
    refreshAdblockState,
    handleToggleAdblock,
    handleToggleCurrentSiteAdblock,
  } = useBrowserDiagnosticsState({
    isElectron,
    tabs,
    activeTabId,
    currentDomain,
  })

  const currentDomainAdblockWhitelisted = useMemo(() => {
    if (!currentDomain) return false
    return adblockState.whitelistDomains.some((domain) => currentDomain === domain || currentDomain.endsWith(`.${domain}`))
  }, [adblockState.whitelistDomains, currentDomain])

  const {
    handleNewTab,
    handleCloseTab,
    handleTabClick,
    handleNavigate,
    handleContentDragOver,
    handleContentDrop,
    handleGoBack,
    handleGoForward,
    handleRefresh,
    handleRetry,
    handleUrlFocus,
    handleUrlBlur,
    handleOpenExternal,
    handleReorder,
    handlePrint,
  } = useBrowserTabActions({
    isElectron,
    activeTab,
    activeTabId,
    normalizeUrl,
    sendBoundsImmediate,
    setTabs,
    setActiveTabId,
    setUrlInput,
    addTab,
    updateTab,
    reorderTabs,
  })

  useBrowserRuntimeEffects({
    isElectron,
    isActive,
    isAddressEditing,
    sendBoundsImmediate,
    handleNewTab,
  })

  // Task 4: Empty state — no tabs
  if (tabs.length === 0) {
    return <BrowserModeEmptyState onNewTab={handleNewTab} />
  }

  return (
      <div className="workbench-mode-root">
      <div className="flex-1 min-h-0 px-3 pb-3 pt-2">
        <div className="workbench-canvas-shell flex h-full min-h-0 flex-col">
          <BrowserHeader
            tabs={tabs}
            activeTabId={activeTabId}
            url={activeTab?.url || ''}
            urlInput={urlInput}
            loading={activeTab?.loading || false}
            canGoBack={activeTab?.canGoBack || false}
            canGoForward={activeTab?.canGoForward || false}
            isBookmarked={isBookmarked}
            adblockEnabled={adblockState.enabled}
            adblockDomainWhitelisted={currentDomainAdblockWhitelisted}
            currentDomain={currentDomain}
            activePanel={activePanel}
            bookmarkedUrls={bookmarks.map((item) => item.url)}
            onTabClick={handleTabClick}
            onTabClose={handleCloseTab}
            onNewTab={handleNewTab}
            onReorder={handleReorder}
            onUrlChange={setUrlInput}
            onNavigate={handleNavigate}
            onGoBack={handleGoBack}
            onGoForward={handleGoForward}
            onRefresh={handleRefresh}
            onFocus={handleUrlFocus}
            onBlur={handleUrlBlur}
            onEditStart={() => setIsAddressEditing(true)}
            onEditEnd={() => setIsAddressEditing(false)}
            onOpenExternal={handleOpenExternal}
            onToggleBookmark={handleToggleBookmark}
            onToggleBookmarkForTab={handleToggleBookmarkForTab}
            onToggleAdblock={handleToggleAdblock}
            onToggleCurrentSiteAdblock={handleToggleCurrentSiteAdblock}
            onTogglePanel={handleTogglePanel}
            onPrint={handlePrint}
          />

          <BrowserShellLayout
            isElectron={isElectron}
            contentRef={contentRef}
            activeTab={activeTab}
            activePanel={activePanel}
            bookmarks={bookmarks}
            selectedBookmarkUrl={selectedBookmarkUrl}
            historyItems={historyItems}
            downloads={downloads}
            adblockState={adblockState}
            browserDiagnostics={browserDiagnostics}
            toastVisible={toastVisible}
            currentDomain={currentDomain}
            currentDomainAdblockWhitelisted={currentDomainAdblockWhitelisted}
            onDragOver={handleContentDragOver}
            onDrop={handleContentDrop}
            onRetry={() => void handleRetry()}
            onClosePanel={() => setActivePanel(null)}
            onNavigateFromPanel={(url) => void handleNavigateFromPanel(url)}
            onRemoveBookmark={(url) => void handleRemoveBookmark(url)}
            onClearHistory={() => void handleClearHistory()}
            onClearDownloads={() => void handleClearDownloads()}
            onSelectBookmark={setSelectedBookmarkUrl}
            onToggleAdblock={() => void handleToggleAdblock()}
            onRefreshAdblock={() => void refreshAdblockState()}
            onSyncBounds={() => sendBoundsImmediate({ forceExact: true })}
          />
        </div>
      </div>
    </div>
  )
}
