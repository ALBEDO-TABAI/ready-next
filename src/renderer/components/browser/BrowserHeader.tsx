import { useCallback, useEffect, useRef, type MouseEvent } from 'react'
import { Bot, ShieldAlert, UserRound } from 'lucide-react'

import HeaderUtilityActions from './HeaderUtilityActions'
import TabRail from './TabRail'
import { useBrowserHeaderInteraction } from '../../modules/browser/useBrowserHeaderInteraction'
import type { BrowserTab } from '../../stores/useBrowserTabs'
import type { BrowserUtilityMenuKind } from '../../../shared/browser-utility-menu'
import type { BrowserOwnershipStatus } from '../../modules/browser/browserOwnershipStatus'

interface BrowserHeaderProps {
  isActive: boolean
  tabs: BrowserTab[]
  activeTabId: string | null
  splitTabId: string | null
  urlInput: string
  bookmarkedUrls: string[]
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  isBookmarked: boolean
  onTabClick: (id: string, event: MouseEvent<HTMLButtonElement>) => void
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
  fastCardOpen: boolean
  fastCardItemCount: number
  onToggleFastCard: () => void
  ownershipStatus?: BrowserOwnershipStatus
}

function BrowserOwnershipChip({ status }: { status: BrowserOwnershipStatus }) {
  const Icon = status.tone === 'warning'
    ? ShieldAlert
    : status.tone === 'agent'
      ? Bot
      : UserRound
  const accent = status.tone === 'agent' ? 'var(--rn-accent)' : 'var(--rn-ink-3)'
  return (
    <div
      className="flex h-[28px] w-[14px] flex-shrink-0 items-center justify-center"
      title={`${status.label}：${status.detail}`}
      aria-label={status.label}
      data-browser-ownership={status.kind}
      style={{
        color: accent,
      }}
    >
      <Icon style={{ width: 14, height: 14 }} strokeWidth={2} />
    </div>
  )
}

export default function BrowserHeader({
  isActive,
  tabs,
  activeTabId,
  splitTabId,
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
  fastCardOpen,
  fastCardItemCount,
  onToggleFastCard,
  ownershipStatus,
}: BrowserHeaderProps) {
  const committingNavigationRef = useRef(false)
  const collapseActiveTabRef = useRef<() => void>(() => undefined)
  const dismissAddressEditing = useCallback(() => {
    committingNavigationRef.current = false
    onBlur()
    onEditEnd()
    collapseActiveTabRef.current()
  }, [onBlur, onEditEnd])

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
  } = useBrowserHeaderInteraction(isActive, dismissAddressEditing)
  collapseActiveTabRef.current = collapseActiveTab

  useEffect(() => {
    if (isActive) return
    dismissAddressEditing()
  }, [dismissAddressEditing, isActive])

  // The browser panel's head row (V11) while no tab is open yet: the starter tab, its address and the page's tools.
  return (
    <div ref={headerRootRef} className="rn-panel__head browser-head no-drag">
      {ownershipStatus && <BrowserOwnershipChip status={ownershipStatus} />}

      <TabRail
        isActive={isActive}
        tabs={tabs}
        activeTabId={activeTabId}
        splitTabId={splitTabId}
        activeTabMode={activeTabMode}
        loading={loading}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        refreshDockMode={refreshDockMode}
        activeTabSurfaceRef={activeTabSurfaceRef}
        urlInput={urlInput}
        isBookmarked={isBookmarked}
        bookmarkedUrls={bookmarkedUrls}
        onTabClick={(tabId, event) => {
          dismissAddressEditing()
          onTabClick(tabId, event)
        }}
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
          committingNavigationRef.current = false
          onFocus()
          onEditStart()
          beginEditing()
        }}
        onInputBlur={() => {
          if (!committingNavigationRef.current) {
            dismissAddressEditing()
          } else {
            onEditEnd()
          }
          requestAnimationFrame(() => {
            committingNavigationRef.current = false
            stopEditing()
          })
        }}
        onRefreshDockEnter={beginRefreshDockHover}
        onRefreshDockLeave={endRefreshDockHover}
        onRefresh={() => {
          dismissAddressEditing()
          onRefresh()
        }}
        onGoBack={() => {
          dismissAddressEditing()
          onGoBack()
        }}
        onGoForward={() => {
          dismissAddressEditing()
          onGoForward()
        }}
        onCommitNavigation={() => {
          committingNavigationRef.current = true
          onEditEnd()
          onNavigate()
          collapseActiveTab()
        }}
        onToggleBookmark={() => {
          onToggleBookmark()
          dismissAddressEditing()
        }}
        onToggleBookmarkForTab={onToggleBookmarkForTab}
      />

      <HeaderUtilityActions
        onShowUtilityMenu={(kind, anchorRect) => {
          dismissAddressEditing()
          onShowUtilityMenu(kind, anchorRect)
        }}
        fastCardOpen={fastCardOpen}
        fastCardItemCount={fastCardItemCount}
        onToggleFastCard={() => {
          dismissAddressEditing()
          onToggleFastCard()
        }}
      />
    </div>
  )
}
