import { useEffect, useState } from 'react'
import { Plus, X } from 'lucide-react'
import type {
  VerticalRailOverlayCommand,
  VerticalRailOverlaySnapshot,
} from '../../shared/browser-vertical-rail-overlay'
import {
  resolveVerticalRailFlyoutScrollOffset,
  VERTICAL_RAIL_FLYOUT_PAD_Y,
  VERTICAL_RAIL_FLYOUT_RADIUS,
  VERTICAL_RAIL_FLYOUT_ROW_GAP,
  VERTICAL_RAIL_FLYOUT_ROW_HEIGHT,
  VERTICAL_RAIL_FLYOUT_ROW_RADIUS,
  VERTICAL_RAIL_FLYOUT_SURFACE_BACKDROP,
  VERTICAL_RAIL_FLYOUT_SURFACE_BACKGROUND,
  VERTICAL_RAIL_FLYOUT_SURFACE_BORDER,
  VERTICAL_RAIL_FLYOUT_SURFACE_SHADOW,
} from '../../shared/vertical-rail-flyout-layout'

function send(command: VerticalRailOverlayCommand): void {
  void window.electronAPI?.browser?.sendVerticalRailOverlayCommand?.(command)
}

export default function VerticalRailOverlayWindow() {
  const [snapshot, setSnapshot] = useState<VerticalRailOverlaySnapshot | null>(null)

  useEffect(() => {
    document.documentElement.dataset.verticalRailOverlayWindow = 'true'
    return () => { delete document.documentElement.dataset.verticalRailOverlayWindow }
  }, [])

  useEffect(() => {
    let cancelled = false
    const browser = window.electronAPI?.browser
    const cleanup = browser?.onVerticalRailOverlaySnapshot?.((next) => setSnapshot(next)) ?? (() => undefined)
    void browser?.getVerticalRailOverlaySnapshot?.().then((result) => {
      if (cancelled) return
      if (result?.success && result.data) setSnapshot(result.data)
      else void browser?.hideVerticalRailOverlay?.()
    })
    return () => { cancelled = true; cleanup() }
  }, [])

  const tabs = snapshot?.tabs ?? []
  const flyoutScrollOffset = snapshot
    ? resolveVerticalRailFlyoutScrollOffset(snapshot.scrollTop, tabs.length, snapshot.bounds.height)
    : 0

  return (
    <div
      className="vertical-rail-overlay-root flex h-screen w-screen flex-col overflow-hidden"
      onMouseEnter={() => send({ type: 'hover-enter' })}
      onMouseLeave={() => send({ type: 'hover-leave' })}
      style={{
        paddingTop: VERTICAL_RAIL_FLYOUT_PAD_Y,
        paddingBottom: VERTICAL_RAIL_FLYOUT_PAD_Y,
        background: VERTICAL_RAIL_FLYOUT_SURFACE_BACKGROUND,
        boxShadow: VERTICAL_RAIL_FLYOUT_SURFACE_SHADOW,
        backdropFilter: VERTICAL_RAIL_FLYOUT_SURFACE_BACKDROP,
        WebkitBackdropFilter: VERTICAL_RAIL_FLYOUT_SURFACE_BACKDROP,
        borderRadius: VERTICAL_RAIL_FLYOUT_RADIUS,
        border: VERTICAL_RAIL_FLYOUT_SURFACE_BORDER,
        boxSizing: 'border-box',
        backgroundClip: 'padding-box',
      }}
    >
      <div
        className="flex flex-col"
        style={{
          gap: VERTICAL_RAIL_FLYOUT_ROW_GAP,
          transform: flyoutScrollOffset > 0 ? `translateY(-${flyoutScrollOffset}px)` : undefined,
        }}
      >
        {tabs.map((tab) => {
          const isActive = tab.active || tab.split
          return (
            <div
              key={tab.id}
              className="group relative flex flex-shrink-0 cursor-pointer items-center pr-[8px]"
              onClick={(event) => send({ type: 'switch', tabId: tab.id, shiftKey: event.shiftKey })}
              onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); send({ type: 'close', tabId: tab.id }) } }}
              onContextMenu={(event) => { event.preventDefault(); send({ type: 'reference', tabId: tab.id }) }}
              style={{
                height: VERTICAL_RAIL_FLYOUT_ROW_HEIGHT,
                paddingLeft: 10,
                background: isActive
                  ? 'var(--files-panel-state-active-bg)'
                  : tab.split
                    ? 'color-mix(in srgb, var(--surface-card-bg) 40%, transparent)'
                    : 'transparent',
                boxShadow: isActive ? 'var(--files-panel-state-active-shadow)' : 'none',
                borderRadius: VERTICAL_RAIL_FLYOUT_ROW_RADIUS,
              }}
            >
              <span className="flex min-w-0 flex-1 flex-col justify-center">
                <span className="truncate text-[12px] font-medium" style={{ color: isActive ? 'var(--text-title)' : 'var(--text-body)', lineHeight: 1.3 }}>
                  {tab.title || 'New Tab'}
                </span>
                {tab.domain && (
                  <span className="truncate text-[10px]" style={{ color: 'var(--text-light)', lineHeight: 1.25 }}>{tab.domain}</span>
                )}
              </span>
              <span
                role="button"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => { event.stopPropagation(); send({ type: 'close', tabId: tab.id }) }}
                className="flex h-[20px] w-[20px] flex-shrink-0 items-center justify-center rounded opacity-0 transition-[background-color,opacity] hover:bg-[var(--bg-hover)] group-hover:opacity-80"
                title="关闭标签页"
              >
                <X style={{ width: 12, height: 12 }} strokeWidth={2} className="text-[var(--text-gray)]" />
              </span>
            </div>
          )
        })}
        <div
          role="button"
          onClick={() => send({ type: 'new-tab' })}
          className="flex flex-shrink-0 cursor-pointer items-center gap-[8px] text-[12px] transition-colors hover:bg-[var(--bg-hover)]"
          style={{ height: VERTICAL_RAIL_FLYOUT_ROW_HEIGHT, paddingLeft: 10, color: 'var(--text-muted)', borderRadius: VERTICAL_RAIL_FLYOUT_ROW_RADIUS }}
          title="新标签页"
        >
          <Plus style={{ width: 16, height: 16 }} strokeWidth={2} />
          新标签页
        </div>
      </div>
    </div>
  )
}
