import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import BrowserModeEmptyState from '../../components/browser/BrowserModeEmptyState'
import BrowserHeader from '../../components/browser/BrowserHeader'
import BrowserShellLayout from '../../components/browser/BrowserShellLayout'
import { useBrowserDiagnosticsState } from '../../modules/browser/useBrowserDiagnosticsState'
import { useBrowserPanelData } from '../../modules/browser/useBrowserPanelData'
import { useBrowserResizeFreeze } from '../../modules/browser/useBrowserResizeFreeze'
import { useBrowserRuntimeEffects } from '../../modules/browser/useBrowserRuntimeEffects'
import { useBrowserTabActions } from '../../modules/browser/useBrowserTabActions'
import { useBrowserViewBounds } from '../../modules/browser/useBrowserViewBounds'
import {
  extractBrowserDomain,
  normalizeBrowserUrlInput,
} from '../../modules/browser/url-utils'
import { useWorkspace } from '../../stores/useWorkspace'
import { useBrowserTabs } from '../../stores/useBrowserTabs'
import { toFileUrl } from '../../utils/dragDrop'
import type { BrowserUtilityMenuKind } from '../../../shared/browser-utility-menu'

export default function BrowserMode({ isActive = true }: { isActive?: boolean }) {
  // Persistent browser tab state — survives mode switches
  const {
    tabs, activeTabId, urlInput,
    setTabs, setActiveTabId, setUrlInput,
    addTab, updateTab, reorderTabs,
  } = useBrowserTabs()
  const [isAddressEditing, setIsAddressEditing] = useState(false)
  const hostVisibleRef = useRef(false)
  const shellRef = useRef<HTMLDivElement>(null)
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
    hostVisibleRef,
    topInset: 0,
    sidebarVisible,
    sidePanelVariant,
    effectiveSidePanelWidth,
    skillsSplitRatio,
    chatPanelVisible,
    chatPanelWidth,
    hasError,
  })

  // URL helpers — auto-Google for non-URL input (Task 2)
  const normalizeUrl = useCallback((input: string): string => {
    return normalizeBrowserUrlInput(input, toFileUrl)
  }, [])

  const {
    isBookmarked,
    bookmarks,
    handleToggleBookmark,
    handleToggleBookmarkForTab,
  } = useBrowserPanelData({
    isElectron,
    activeTab,
  })

  const {
    toastVisible,
    adblockState,
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

  const handleShowUtilityMenu = useCallback((kind: BrowserUtilityMenuKind, anchorRect: DOMRect) => {
    if (!isElectron) return

    const currentTabPayload = activeTab
      ? {
          id: activeTab.id,
          url: activeTab.url,
          title: activeTab.title || activeTab.url,
          domain: activeTab.domain || currentDomain,
        }
      : null

    void window.electronAPI?.browser?.showUtilityMenu({
      kind,
      anchorRect: {
        left: anchorRect.left,
        top: anchorRect.top,
        right: anchorRect.right,
        bottom: anchorRect.bottom,
        width: anchorRect.width,
        height: anchorRect.height,
      },
      currentTab: currentTabPayload,
      currentDomain,
      adblockEnabled: adblockState.enabled,
      adblockDomainWhitelisted: currentDomainAdblockWhitelisted,
    })
  }, [activeTab, adblockState.enabled, currentDomain, currentDomainAdblockWhitelisted, isElectron])

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
    handleReorder,
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

  const {
    browserRuntimeReady,
  } = useBrowserRuntimeEffects({
    isElectron,
    isActive,
    isAddressEditing,
    sendBoundsImmediate,
    handleNewTab,
  })
  hostVisibleRef.current = browserRuntimeReady && tabs.length > 0

  const { freezeFrame } = useBrowserResizeFreeze({
    isElectron,
    isActive,
    browserRuntimeReady,
    surfaceRef: shellRef,
    sendBoundsImmediate,
  })

  useEffect(() => {
    if (!isElectron || !isActive) return

    const syncVisibleHost = async () => {
      if (!browserRuntimeReady || tabs.length === 0) {
        await window.electronAPI?.browser?.hideAll?.()
        return
      }
      await sendBoundsImmediate({ forceExact: true })
      await window.electronAPI?.browser?.showActive?.()
    }

    void syncVisibleHost().catch(() => undefined)
  }, [browserRuntimeReady, isActive, isElectron, sendBoundsImmediate, tabs.length])

  // Task 4: Empty state — no tabs
  if (!browserRuntimeReady || tabs.length === 0) {
    return <BrowserModeEmptyState onNewTab={handleNewTab} contentRef={contentRef} loading={!browserRuntimeReady} />
  }

  return (
      <div className="workbench-mode-root">
      <div className="flex-1 min-h-0 px-3 pb-3 pt-2">
        <div ref={shellRef} className="workbench-canvas-shell relative flex h-full min-h-0 flex-col">
          <BrowserHeader
            tabs={tabs}
            activeTabId={activeTabId}
            urlInput={urlInput}
            loading={activeTab?.loading || false}
            canGoBack={activeTab?.canGoBack || false}
            canGoForward={activeTab?.canGoForward || false}
            isBookmarked={isBookmarked}
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
            onToggleBookmark={handleToggleBookmark}
            onToggleBookmarkForTab={handleToggleBookmarkForTab}
            onShowUtilityMenu={handleShowUtilityMenu}
          />

          <BrowserShellLayout
            isElectron={isElectron}
            contentRef={contentRef}
            activeTab={activeTab}
            toastVisible={toastVisible}
            onDragOver={handleContentDragOver}
            onDrop={handleContentDrop}
            onRetry={() => void handleRetry()}
          />
          {freezeFrame?.src && (
            <div
              className="browser-resize-shell-freeze"
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: 40,
                pointerEvents: 'none',
                overflow: 'hidden',
                borderRadius: 'inherit',
              }}
            >
              <img
                src={freezeFrame.src}
                alt=""
                draggable={false}
                style={{
                  width: '100%',
                  height: '100%',
                  display: 'block',
                  objectFit: 'fill',
                  userSelect: 'none',
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
