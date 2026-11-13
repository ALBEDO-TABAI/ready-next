import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, BookOpenText, Bot, Globe, Loader2, Lock, RefreshCw, ShieldAlert, Star, UserRound } from 'lucide-react'
import HeaderUtilityActions from './HeaderUtilityActions'
import { NavigationBackEntry } from '../../modules/workbench/NavigationBackEntry'
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
  return (
    <div
      className="browser-head__status"
      title={`${status.label}：${status.detail}`}
      aria-label={status.label}
      data-browser-ownership={status.kind}
      data-tone={status.tone}
    >
      <Icon aria-hidden="true" />
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

  // The browser panel's head row (V11): the way back, who holds the page, back / forward / reload, the address field
  // and the page's tools. The page sits right under it, framed by the panel (browser-shell.css).
  return (
    <div className="rn-panel__head browser-head no-drag">
      <NavigationBackEntry mode="browser" />
      {ownershipStatus && <BrowserOwnershipChip status={ownershipStatus} />}

      <div className="browser-head__group">
        <IconButton icon={<ArrowLeft />} title="后退" onClick={onGoBack} disabled={!canGoBack} />
        <IconButton icon={<ArrowRight />} title="前进" onClick={onGoForward} disabled={!canGoForward} />
        <IconButton
          icon={loading ? <Loader2 className="animate-spin" style={{ color: 'var(--rn-ink-3)' }} /> : <RefreshCw />}
          title="刷新"
          onClick={onRefresh}
        />
      </div>

      {/* Address: the shared single-line field (V2, V4), a pill well; focus deepens the edge in ink, never the signal colour. */}
      <div ref={addressRef} data-float-anchor={ADDRESS_SUGGESTIONS_FLOAT} className="browser-address">
        {isHttps
          ? <Lock className="browser-address__glyph" data-secure="" aria-hidden="true" />
          : <Globe className="browser-address__glyph" aria-hidden="true" />}
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
          className="browser-address__input ready-input-slot-inner"
        />
        {/* 阅读视图: the shared icon button; pressed while the reader is shown (the rail's glowing glyph is the rail's alone). */}
        {reading && (reading.available || reading.shown) && (
          <IconButton icon={<BookOpenText aria-hidden="true" />} active={reading.shown} data-browser-reading-toggle=""
            title={reading.shown ? '回到网页' : '阅读视图'} aria-label="阅读视图" onClick={reading.onToggle} />
        )}
        {feeds && feeds.length > 0 && <BrowserSubscribeButton feeds={feeds} pageTitle={activeTab?.title || ''} />}
        {/* A saved page's star is solid ink (DL6), as the document's 收藏 is. */}
        <IconButton
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
  )
}
