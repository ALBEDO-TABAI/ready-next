import { useCallback, useEffect, useRef, type MouseEvent } from 'react'
import { Bot, ShieldAlert, UserRound } from 'lucide-react'

import HeaderUtilityActions from './HeaderUtilityActions'
import TabRail from './TabRail'
import { useBrowserHeaderInteraction } from '../../modules/browser/useBrowserHeaderInteraction'
import { WORKBENCH_HEADER_EDGE_X, WORKBENCH_TAB_ROW_HEIGHT } from '../../modules/workbench/chrome'
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
  const accent = status.tone === 'warning'
    ? 'var(--color-orange)'
    : status.tone === 'agent'
      ? 'var(--color-blue)'
      : 'var(--text-gray)'
  return (
    <div
      className="flex h-[28px] flex-shrink-0 items-center gap-1.5 rounded-[9px] border px-2 text-[11px] font-semibold"
      title={status.detail}
      data-browser-ownership={status.kind}
      style={{
        borderColor: status.tone === 'neutral'
          ? 'color-mix(in srgb, var(--text-gray) 18%, transparent)'
          : `color-mix(in srgb, ${accent} 34%, transparent)`,
        background: status.tone === 'neutral'
          ? 'color-mix(in srgb, var(--surface-card-bg) 16%, transparent)'
          : `color-mix(in srgb, ${accent} 10%, transparent)`,
        color: status.tone === 'neutral' ? 'var(--text-gray)' : accent,
      }}
    >
      <Icon style={{ width: 13, height: 13 }} strokeWidth={2} />
      <span className="whitespace-nowrap">{status.label}</span>
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

  return (
    <div
      ref={headerRootRef}
      className="browser-header-surface glass-surface-panel flex-shrink-0"
      style={{
        overflow: 'visible',
        zIndex: 8,
      }}
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

        {ownershipStatus && <BrowserOwnershipChip status={ownershipStatus} />}

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
    </div>
  )
}
