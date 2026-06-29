import { useEffect, useState } from 'react'
import { Plus, X } from 'lucide-react'
import type {
  VerticalRailOverlayCommand,
  VerticalRailOverlaySnapshot,
} from '../../shared/browser-vertical-rail-overlay'

// Must match VerticalTabRail's icon column rhythm so each label lines up with its rail icon.
const PAD_Y = 6
const ROW_H = 38
const ROW_GAP = 4

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

  return (
    <div
      className="vertical-rail-overlay-root flex h-screen w-screen flex-col overflow-hidden"
      onMouseEnter={() => send({ type: 'hover-enter' })}
      onMouseLeave={() => send({ type: 'hover-leave' })}
      style={{
        paddingTop: PAD_Y,
        paddingBottom: PAD_Y,
        // Near-opaque so page content behind doesn't bleed into the labels. The base chrome
        // color is ~0.94 alpha; the inset layer stacks it to effectively opaque, theme-safe.
        background: 'var(--workbench-liquid-chrome-bg, var(--bg-content))',
        boxShadow: 'inset 0 0 0 2000px color-mix(in srgb, var(--workbench-liquid-chrome-bg, var(--bg-content)) 80%, transparent), 14px 0 36px -16px color-mix(in srgb, var(--text-title) 38%, transparent)',
        borderTopRightRadius: 14,
        borderBottomRightRadius: 14,
        borderRight: '1px solid color-mix(in srgb, var(--text-title) 10%, transparent)',
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" style={{ gap: ROW_GAP }}>
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
                height: ROW_H,
                paddingLeft: 10,
                background: isActive
                  ? 'var(--files-panel-state-active-bg)'
                  : tab.split
                    ? 'color-mix(in srgb, var(--surface-card-bg) 40%, transparent)'
                    : 'transparent',
                boxShadow: isActive ? 'var(--files-panel-state-active-shadow)' : 'none',
                borderTopRightRadius: 10,
                borderBottomRightRadius: 10,
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
          style={{ height: ROW_H, paddingLeft: 10, color: 'var(--text-muted)', borderTopRightRadius: 10, borderBottomRightRadius: 10 }}
          title="新标签页"
        >
          <Plus style={{ width: 16, height: 16 }} strokeWidth={2} />
          新标签页
        </div>
      </div>
    </div>
  )
}
