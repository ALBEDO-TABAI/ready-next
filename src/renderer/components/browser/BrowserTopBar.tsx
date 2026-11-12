import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, BookOpenText, Bot, Globe, Loader2, Lock, RefreshCw, ShieldAlert, Star, UserRound } from 'lucide-react'
import HeaderUtilityActions from './HeaderUtilityActions'
import { NavigationBackEntry } from '../../modules/workbench/NavigationBackEntry'
import {
  WORKBENCH_HEADER_EDGE_X,
  WORKBENCH_TAB_ROW_HEIGHT,
} from '../../modules/workbench/chrome'
import type { BrowserTab } from '../../stores/useBrowserTabs'
import type { BrowserUtilityMenuKind } from '../../../shared/browser-utility-menu'
import type { BrowserOwnershipStatus } from '../../modules/browser/browserOwnershipStatus'
import type { BrowserPageCapabilities } from '../../../shared/browser-shell'
import { ADDRESS_SUGGESTIONS_FLOAT, useAddressSuggestions, type AddressSuggestion } from '../../modules/browser/useAddressSuggestions'
import BrowserSubscribeButton from './BrowserSubscribeButton'
import { IconButton } from '../ui'

interface BrowserTopBarProps {
  isActive: boolean
  activeTab: BrowserTab | null
  urlInput: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  isBookmarked: boolean
  onUrlChange: (value: string) => void
  onNavigate: (url?: string) => void
  onGoBack: () => void
  onGoForward: () => void
  onRefresh: () => void
  onFocus: () => void
  onBlur: () => void
  onEditStart: () => void
  onEditEnd: () => void
  onToggleBookmark: () => void
  onShowUtilityMenu: (kind: BrowserUtilityMenuKind, anchorRect: DOMRect) => void
  fastCardOpen: boolean
  fastCardItemCount: number
  onToggleFastCard: () => void
  ownershipStatus?: BrowserOwnershipStatus
  /** An open tab picked from the address suggestions. */
  onSwitchTab?: (tabId: string) => void
  /** Feeds the page declares: 订阅 appears in the address field. */
  feeds?: BrowserPageCapabilities['feeds']
  /** 阅读视图: offered when the page reads as an article; pressed while it is shown. */
  reading?: { available: boolean; shown: boolean; onToggle: () => void }
}

function BrowserOwnershipChip({ status }: { status: BrowserOwnershipStatus }) {
  const Icon = status.tone === 'warning' ? ShieldAlert : status.tone === 'agent' ? Bot : UserRound
  const accent = status.tone === 'agent' ? 'var(--rn-accent)' : 'var(--rn-ink-3)'
  return (
    <div
      className="flex h-[28px] w-[20px] flex-shrink-0 items-center justify-center"
      title={`${status.label}：${status.detail}`}
      aria-label={status.label}
      data-browser-ownership={status.kind}
      style={{ color: accent }}
    >
      <Icon style={{ width: 14, height: 14 }} strokeWidth={2} />
    </div>
  )
}

export default function BrowserTopBar({
  isActive,
  activeTab,
  urlInput,
  loading,
  canGoBack,
  canGoForward,
  isBookmarked,
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
  onShowUtilityMenu,
  fastCardOpen,
  fastCardItemCount,
  onToggleFastCard,
  ownershipStatus,
  onSwitchTab,
  feeds,
  reading,
}: BrowserTopBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const addressRef = useRef<HTMLDivElement>(null)
  const [isComposing, setIsComposing] = useState(false)
  const [focused, setFocused] = useState(false)
  const isHttps = (activeTab?.url || '').startsWith('https://')
  const suggestions = useAddressSuggestions({
    anchorRef: addressRef,
    query: urlInput,
    editing: focused,
    onPick: (item: AddressSuggestion) => {
      if (item.kind === 'tab') onSwitchTab?.(item.tabId)
      else onNavigate(item.kind === 'search' ? item.title : item.url)
      inputRef.current?.blur()
    },
  })

  useEffect(() => {
    if (isActive) return
    if (focused) {
      inputRef.current?.blur()
    }
  }, [focused, isActive])

  return (
    <div
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
          position: 'relative',
          zIndex: 2,
        }}
      >
        <NavigationBackEntry mode="browser" />
        {ownershipStatus && <BrowserOwnershipChip status={ownershipStatus} />}

        {/* Navigation cluster */}
        <div className="flex flex-shrink-0 items-center" style={{ gap: 2 }}>
          <IconButton icon={<ArrowLeft />} title="后退" onClick={onGoBack} disabled={!canGoBack} />
          <IconButton icon={<ArrowRight />} title="前进" onClick={onGoForward} disabled={!canGoForward} />
          <IconButton
            icon={loading ? <Loader2 className="animate-spin" style={{ color: 'var(--rn-accent)' }} /> : <RefreshCw />}
            title="刷新"
            onClick={onRefresh}
          />
        </div>

        {/* Address bar: drawn as the shared field (W1 §5) — a recessed slot with a hairline; focus brings the
            paper up and deepens the edge in ink, never the signal colour. */}
        <div
          ref={addressRef}
          data-float-anchor={ADDRESS_SUGGESTIONS_FLOAT}
          className="flex min-w-0 flex-1 items-center"
          style={{
            height: 32,
            paddingLeft: 12,
            paddingRight: 6,
            gap: 6,
            borderRadius: 'var(--rn-r-md)',
            background: focused ? 'var(--rn-sheet)' : 'var(--rn-fill)',
            boxShadow: focused ? 'inset 0 0 0 1.5px var(--rn-ink-3)' : 'inset 0 0 0 1px var(--rn-hair)',
            transition: 'background-color var(--rn-d-1) var(--rn-ease-out), box-shadow var(--rn-d-1) var(--rn-ease-out)',
          }}
        >
          {isHttps ? (
            <Lock style={{ width: 12, height: 12 }} className="flex-shrink-0 text-[var(--rn-ok)]" strokeWidth={2} />
          ) : (
            <Globe style={{ width: 12, height: 12 }} className="flex-shrink-0 text-[var(--rn-ink-3)]" strokeWidth={2} />
          )}
          <input
            ref={inputRef}
            type="text"
            value={urlInput}
            placeholder="搜索或输入网址"
            spellCheck={false}
            aria-label="地址"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={suggestions.expanded}
            aria-controls={suggestions.expanded ? 'browser-address-suggestions' : undefined}
            aria-activedescendant={suggestions.activeDescendant}
            onChange={(event) => { suggestions.onTyped(); onUrlChange(event.target.value) }}
            onFocus={(event) => {
              setFocused(true)
              onFocus()
              onEditStart()
              event.currentTarget.select()
            }}
            onBlur={() => {
              setFocused(false)
              onBlur()
              onEditEnd()
            }}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
            onKeyDown={(event) => {
              if (!isComposing && !event.nativeEvent.isComposing && suggestions.onKeyDown(event)) return
              if (event.key === 'Enter' && !isComposing && !event.nativeEvent.isComposing) {
                event.preventDefault()
                onNavigate()
                inputRef.current?.blur()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                inputRef.current?.blur()
              }
            }}
            className="ready-input-slot-inner h-full min-w-0 flex-1 bg-transparent text-[12px] text-[var(--rn-ink)] outline-none"
          />
          {/* 阅读视图: the shared icon button; pressed while the reader is shown (the rail's glowing glyph is the rail's alone). */}
          {reading && (reading.available || reading.shown) && (
            <IconButton size="sm" icon={<BookOpenText aria-hidden="true" />} active={reading.shown} data-browser-reading-toggle=""
              title={reading.shown ? '回到网页' : '阅读视图'} aria-label="阅读视图" onClick={reading.onToggle} />
          )}
          {feeds && feeds.length > 0 && <BrowserSubscribeButton feeds={feeds} pageTitle={activeTab?.title || ''} />}
          {/* A saved page's star is solid ink (DL6), as the document's 收藏 is. */}
          <IconButton
            size="sm"
            icon={<Star fill={isBookmarked ? 'currentColor' : 'none'} />}
            title={isBookmarked ? '取消收藏' : '收藏此页面'}
            onClick={onToggleBookmark}
            disabled={!activeTab}
            style={isBookmarked ? { color: 'var(--rn-ink)' } : undefined}
          />
        </div>

        <HeaderUtilityActions
          onShowUtilityMenu={onShowUtilityMenu}
          fastCardOpen={fastCardOpen}
          fastCardItemCount={fastCardItemCount}
          onToggleFastCard={onToggleFastCard}
        />
      </div>
    </div>
  )
}
