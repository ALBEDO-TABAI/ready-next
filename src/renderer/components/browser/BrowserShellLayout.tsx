import type { DragEvent, ReactNode, RefObject } from 'react'
import { AlertTriangle, CheckCircle, Globe, RefreshCw } from 'lucide-react'
import type { BrowserTab } from '../../stores/useBrowserTabs'

interface BrowserShellLayoutProps {
  isElectron: boolean
  contentRef: RefObject<HTMLDivElement | null>
  activeTab: BrowserTab | null
  toastVisible: boolean
  freezeOverlay?: ReactNode
  onDragOver: (event: DragEvent<HTMLDivElement>) => void
  onDrop: (event: DragEvent<HTMLDivElement>) => void
  onRetry: () => void | Promise<void>
}

export default function BrowserShellLayout({
  isElectron,
  contentRef,
  activeTab,
  toastVisible,
  freezeOverlay,
  onDragOver,
  onDrop,
  onRetry,
}: BrowserShellLayoutProps) {
  return (
    <div className="flex min-h-0 h-full flex-1">
      <div className="relative min-w-0 flex flex-1 flex-col">
        {activeTab?.loading && (
          <div className="relative h-0.5 flex-shrink-0 overflow-hidden" style={{ background: 'var(--border-default)' }}>
            <div
              className="absolute left-0 top-0 h-full rounded-r"
              style={{
                background: 'var(--color-blue)',
                animation: 'browserContentProgress 1.5s ease-in-out infinite',
              }}
            />
          </div>
        )}

        <div className="flex min-h-0 min-w-0 flex-1 bg-transparent">
          <div
            ref={contentRef}
            className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
            onDragOver={onDragOver}
            onDrop={onDrop}
            style={{ borderRadius: '0 0 var(--workbench-canvas-radius) var(--workbench-canvas-radius)' }}
          >
            <div
              className="browser-shell-corner-fill-left"
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: 'var(--workbench-canvas-radius)',
                height: 'var(--workbench-canvas-radius)',
                borderBottomRightRadius: 'var(--workbench-canvas-radius)',
                background: 'var(--workbench-liquid-chrome-bg, var(--bg-content))',
                pointerEvents: 'none',
                zIndex: 2,
              }}
            />
            <div
              className="browser-shell-corner-fill-right"
              style={{
                position: 'absolute',
                right: 0,
                top: 0,
                width: 'var(--workbench-canvas-radius)',
                height: 'var(--workbench-canvas-radius)',
                borderBottomLeftRadius: 'var(--workbench-canvas-radius)',
                background: 'var(--workbench-liquid-chrome-bg, var(--bg-content))',
                pointerEvents: 'none',
                zIndex: 2,
              }}
            />

            {!isElectron && (
              <div className="absolute inset-0 flex items-center justify-center text-[var(--text-light)]">
                <div className="text-center">
                  <Globe className="mx-auto mb-3 h-12 w-12 opacity-30" />
                  <p className="text-[13px]">Browser requires Electron environment</p>
                </div>
              </div>
            )}

            {activeTab?.error && (
              <div
                className="absolute inset-0 flex items-center justify-center"
                style={{ background: 'color-mix(in srgb, var(--bg-content) 22%, transparent)', backdropFilter: 'blur(18px) saturate(136%)', WebkitBackdropFilter: 'blur(18px) saturate(136%)' }}
              >
                <div className="text-center" style={{ maxWidth: 360 }}>
                  <AlertTriangle
                    className="mx-auto mb-4"
                    style={{ width: 48, height: 48, color: 'var(--color-orange)' }}
                    strokeWidth={1.5}
                  />
                  <p className="mb-2 text-[15px] font-medium" style={{ color: 'var(--text-title)' }}>
                    Page failed to load
                  </p>
                  <p className="mb-4 text-[12px]" style={{ color: 'var(--text-gray)', lineHeight: 1.6 }}>
                    {activeTab.error}
                  </p>
                  <button
                    onClick={() => void onRetry()}
                    className="inline-flex items-center gap-2 rounded-lg px-4 py-2 transition-colors hover:bg-[var(--color-blue-light)]"
                    style={{
                      color: 'var(--color-blue)',
                      fontSize: 13,
                      border: '1px solid var(--color-blue)',
                      background: 'transparent',
                    }}
                  >
                    <RefreshCw style={{ width: 14, height: 14 }} strokeWidth={2} />
                    Retry
                  </button>
                </div>
              </div>
            )}

            {toastVisible && (
              <div
                style={{
                  position: 'absolute',
                  bottom: 16,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  background: 'var(--surface-floating-bg)',
                  color: 'var(--text-body)',
                  padding: '8px 16px',
                  borderRadius: 8,
                  fontSize: 13,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  zIndex: 30,
                  animation: 'cookieToastFade 3s ease-in-out forwards',
                  pointerEvents: 'none',
                  whiteSpace: 'nowrap',
                  border: '1px solid var(--surface-border)',
                  backdropFilter: 'blur(var(--surface-blur)) saturate(var(--surface-saturate))',
                  WebkitBackdropFilter: 'blur(var(--surface-blur)) saturate(var(--surface-saturate))',
                }}
              >
                <CheckCircle
                  style={{ width: 16, height: 16, color: 'var(--color-green)', flexShrink: 0 }}
                  strokeWidth={2}
                />
                已保存登录状态
              </div>
            )}

            {freezeOverlay}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes browserContentProgress {
          0% { width: 5%; }
          50% { width: 65%; }
          100% { width: 95%; }
        }
        @keyframes cookieToastFade {
          0% { opacity: 0; transform: translateX(-50%) translateY(8px); }
          10% { opacity: 1; transform: translateX(-50%) translateY(0); }
          80% { opacity: 1; transform: translateX(-50%) translateY(0); }
          100% { opacity: 0; transform: translateX(-50%) translateY(-4px); }
        }
      `}</style>
    </div>
  )
}
