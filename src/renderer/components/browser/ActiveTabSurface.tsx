import { useEffect, useRef, useState, type RefObject } from 'react'
import { Globe, Loader2, Lock, Star, X } from 'lucide-react'
import type { ActiveTabMode } from '../../modules/browser/useBrowserHeaderInteraction'
import type { BrowserTab } from '../../stores/useBrowserTabs'
import { IconButton } from '../ui'

interface ActiveTabSurfaceProps {
  tab: BrowserTab
  mode: ActiveTabMode
  urlInput: string
  isBookmarked: boolean
  surfaceRef: RefObject<HTMLDivElement | null>
  width: number
  minWidth: number
  draggable?: boolean
  onDragStart?: (event: React.DragEvent<HTMLElement>) => void
  onDragEnd?: (event: React.DragEvent<HTMLElement>) => void
  onContextMenu?: (event: React.MouseEvent<HTMLElement>) => void
  onUrlChange: (value: string) => void
  onExpandRequest: () => void
  onHotspotEnter: () => void
  onHotspotLeave: () => void
  onInputFocus: () => void
  onInputBlur: () => void
  onCommitNavigation: () => void
  onToggleBookmark: () => void
  onClose: () => void
}

export default function ActiveTabSurface({
  tab,
  mode,
  urlInput,
  isBookmarked,
  surfaceRef,
  width,
  minWidth,
  draggable = false,
  onDragStart,
  onDragEnd,
  onContextMenu,
  onUrlChange,
  onExpandRequest,
  onHotspotEnter,
  onHotspotLeave,
  onInputFocus,
  onInputBlur,
  onCommitNavigation,
  onToggleBookmark,
  onClose,
}: ActiveTabSurfaceProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [isComposing, setIsComposing] = useState(false)
  const isExpanded = mode === 'expanded' || mode === 'editing'
  const isHttps = tab.url.startsWith('https://')

  useEffect(() => {
    if (!isExpanded) return
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [isExpanded])

  const tabIcon = tab.loading ? (
    <Loader2
      style={{ width: 14, height: 14 }}
      className="animate-spin flex-shrink-0 text-[var(--rn-ink-3)]"
      strokeWidth={2}
    />
  ) : tab.favicon ? (
    <img
      src={tab.favicon}
      alt=""
      draggable={false}
      className="h-[14px] w-[14px] flex-shrink-0 rounded-[4px] object-cover"
    />
  ) : (
    <Globe style={{ width: 14, height: 14 }} className="flex-shrink-0 text-[var(--rn-ink-2)]" strokeWidth={2} />
  )

  return (
    <div
      ref={surfaceRef}
      draggable={draggable && !isExpanded}
      onDragStart={(event) => {
        const target = event.target as HTMLElement | null
        if (target?.closest('[data-browser-active-action]')) {
          event.preventDefault()
          return
        }
        onDragStart?.(event)
      }}
      onDragEnd={onDragEnd}
      onContextMenu={(event) => {
        const target = event.target as HTMLElement | null
        if (target?.closest('input')) return
        onContextMenu?.(event)
      }}
      className="group relative flex min-w-0 items-center"
      style={{
        borderRadius: 'var(--rn-r-sm)',
        height: 34,
        width,
        minWidth,
        maxWidth: width,
        paddingLeft: 12,
        paddingRight: 10,
        gap: 8,
        // Editing, the tab becomes the shared field (V2 well) with an ink edge, never the signal colour.
        background: mode === 'primed' || mode === 'expanded' || mode === 'editing'
          ? 'var(--rn-well)'
          : 'var(--rn-fill-2)',
        boxShadow: mode === 'primed' || mode === 'expanded' || mode === 'editing'
          ? 'inset 0 1px 2px var(--rn-well-shade), inset 0 0 0 1px var(--rn-ink-3)'
          : 'none',
        transition: 'background-color var(--rn-d-1) var(--rn-ease-out), box-shadow var(--rn-d-1) var(--rn-ease-out)',
      }}
    >
      {tabIcon}

      {isExpanded ? (
        <div
          data-browser-active-hotspot
          className="flex min-w-0 flex-1 items-center gap-2"
          onMouseEnter={onHotspotEnter}
          onMouseLeave={onHotspotLeave}
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
            onChange={(event) => onUrlChange(event.target.value)}
            onFocus={onInputFocus}
            onBlur={onInputBlur}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !isComposing && !event.nativeEvent.isComposing) {
                event.preventDefault()
                onCommitNavigation()
              }
            }}
            className="ready-input-slot-inner h-full min-w-0 flex-1 bg-transparent text-[12px] text-[var(--rn-ink)] outline-none"
          />
        </div>
      ) : (
        <button
          type="button"
          data-browser-active-hotspot
          onClick={onExpandRequest}
          onMouseEnter={onHotspotEnter}
          onMouseLeave={onHotspotLeave}
          className="flex min-w-0 flex-1 items-center bg-transparent text-left"
        >
          <span className="truncate text-[12px] font-medium text-[var(--rn-ink)]">
            {tab.title || 'New Tab'}
          </span>
        </button>
      )}

      <IconButton
        size="sm"
        data-browser-active-action
        onClick={onToggleBookmark}
        icon={<Star fill={isBookmarked ? 'currentColor' : 'none'} />}
        style={isBookmarked ? { color: 'var(--rn-ink)' } : undefined}
        title={isBookmarked ? '取消收藏' : '收藏此页面'}
      />

      <IconButton size="sm" data-browser-active-action onClick={onClose} icon={<X />} title="关闭标签" />
    </div>
  )
}
