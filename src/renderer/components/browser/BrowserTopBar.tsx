import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Bot, Globe, Loader2, Lock, RefreshCw, ShieldAlert, Star, UserRound } from 'lucide-react'
import HeaderUtilityActions from './HeaderUtilityActions'
import { NavigationBackEntry } from '../../modules/workbench/NavigationBackEntry'
import {
  WORKBENCH_HEADER_EDGE_X,
  WORKBENCH_TAB_ROW_HEIGHT,
} from '../../modules/workbench/chrome'
import type { BrowserTab } from '../../stores/useBrowserTabs'
import type { BrowserUtilityMenuKind } from '../../../shared/browser-utility-menu'
import type { BrowserOwnershipStatus } from '../../modules/browser/browserOwnershipStatus'

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
}

function BrowserOwnershipChip({ status }: { status: BrowserOwnershipStatus }) {
  const Icon = status.tone === 'warning' ? ShieldAlert : status.tone === 'agent' ? Bot : UserRound
  const accent = status.tone === 'agent' ? 'var(--color-blue)' : 'var(--text-gray)'
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

const navBtn =
  'flex h-[28px] w-[28px] flex-shrink-0 items-center justify-center rounded-lg transition-[background-color,opacity] duration-150 hover:bg-[var(--bg-hover)] disabled:opacity-30 disabled:hover:bg-transparent'

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
}: BrowserTopBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [isComposing, setIsComposing] = useState(false)
  const [focused, setFocused] = useState(false)
  const isHttps = (activeTab?.url || '').startsWith('https://')

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
          <button
            type="button"
            onClick={onGoBack}
            disabled={!canGoBack}
            className={navBtn}
            title="后退"
          >
            <ArrowLeft style={{ width: 15, height: 15 }} className="text-[var(--text-light)]" strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={onGoForward}
            disabled={!canGoForward}
            className={navBtn}
            title="前进"
          >
            <ArrowRight style={{ width: 15, height: 15 }} className="text-[var(--text-light)]" strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={onRefresh}
            className={navBtn}
            title="刷新"
          >
            {loading ? (
              <Loader2 style={{ width: 15, height: 15 }} className="animate-spin text-[var(--color-blue)]" strokeWidth={2} />
            ) : (
              <RefreshCw style={{ width: 15, height: 15 }} className="text-[var(--text-light)]" strokeWidth={2} />
            )}
          </button>
        </div>

        {/* Address bar */}
        <div
          className="flex min-w-0 flex-1 items-center rounded-[14px] border"
          style={{
            height: 32,
            paddingLeft: 12,
            paddingRight: 8,
            gap: 8,
            background: focused ? 'var(--input-slot-bg)' : 'color-mix(in srgb, var(--input-slot-bg) 55%, transparent)',
            borderColor: focused ? 'var(--input-slot-focus-border)' : 'transparent',
            boxShadow: focused ? 'var(--input-slot-shadow-focus)' : 'none',
            transition: 'background-color 200ms ease, border-color 200ms ease, box-shadow 200ms ease',
          }}
        >
          {isHttps ? (
            <Lock style={{ width: 12, height: 12 }} className="flex-shrink-0 text-[var(--color-green)]" strokeWidth={2} />
          ) : (
            <Globe style={{ width: 12, height: 12 }} className="flex-shrink-0 text-[var(--text-gray)]" strokeWidth={2} />
          )}
          <input
            ref={inputRef}
            type="text"
            value={urlInput}
            placeholder="搜索或输入网址"
            spellCheck={false}
            onChange={(event) => onUrlChange(event.target.value)}
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
              if (event.key === 'Enter' && !isComposing && !event.nativeEvent.isComposing) {
                event.preventDefault()
                onNavigate()
                inputRef.current?.blur()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                inputRef.current?.blur()
              }
            }}
            className="ready-input-slot-inner h-full min-w-0 flex-1 bg-transparent text-[12px] text-[var(--text-body)] outline-none"
          />
          <button
            type="button"
            onClick={onToggleBookmark}
            disabled={!activeTab}
            className="flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-40"
            title={isBookmarked ? '取消收藏' : '收藏此页面'}
          >
            <Star
              style={{ width: 13, height: 13 }}
              className={isBookmarked ? 'text-[var(--color-orange)]' : 'text-[var(--text-gray)]'}
              strokeWidth={2}
              fill={isBookmarked ? 'var(--color-orange)' : 'none'}
            />
          </button>
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
