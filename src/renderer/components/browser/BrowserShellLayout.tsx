import type { DragEvent, ReactNode, RefObject } from 'react'
import { AlertTriangle, CheckCircle, Globe, RefreshCw, UploadCloud } from 'lucide-react'
import readyWordmark from '../../assets/ready-wordmark.svg'
import { isReadyBrowserBlankUrl } from '../../modules/browser/url-utils'
import type { BrowserTab } from '../../stores/useBrowserTabs'
import { Button } from '../ui'

interface BrowserShellLayoutProps {
  isElectron: boolean
  contentRef: RefObject<HTMLDivElement | null>
  activeTab: BrowserTab | null
  toastVisible: boolean
  onDragOver: (event: DragEvent<HTMLDivElement>) => void
  onDrop: (event: DragEvent<HTMLDivElement>) => void
  onRetry: () => void | Promise<void>
  mediaDropActive?: boolean
  mediaUploadStatus?: { kind: 'uploading' | 'success' | 'error'; message: string } | null
  fillBottomLeftCorner?: boolean
  /** A band above the page (a task waiting on the person): it takes its own height, so the native page moves down. */
  band?: ReactNode
  /** DOM in place of the native page (阅读视图); the page itself is hidden meanwhile. */
  cover?: ReactNode
}

export default function BrowserShellLayout({
  isElectron,
  contentRef,
  activeTab,
  toastVisible,
  onDragOver,
  onDrop,
  onRetry,
  mediaDropActive = false,
  mediaUploadStatus = null,
  fillBottomLeftCorner = true,
  band = null,
  cover = null,
}: BrowserShellLayoutProps) {
  const showReadyBlankPage = activeTab ? isReadyBrowserBlankUrl(activeTab.url) && !activeTab.error : false
  const showBrowserViewCornerFill = isElectron && Boolean(activeTab) && !showReadyBlankPage && !activeTab?.error && !cover

  return (
    <div className="flex min-h-0 h-full flex-1">
      <div className="relative min-w-0 flex flex-1 flex-col">
        {band}
        {activeTab?.loading && (
          <div className="relative h-0.5 flex-shrink-0 overflow-hidden" style={{ background: 'var(--rn-fill-2)' }}>
            <div
              className="absolute left-0 top-0 h-full rounded-r"
              style={{
                background: 'var(--rn-accent)',
                animation: 'browserContentProgress 1.5s ease-in-out infinite',
              }}
            />
          </div>
        )}

        <div className="flex min-h-0 min-w-0 flex-1 bg-transparent">
          <div
            ref={contentRef}
            data-browser-local-media-drop-surface=""
            data-ready-native-surface={showBrowserViewCornerFill ? 'browser' : undefined}
            className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
            onDragOver={onDragOver}
            onDrop={onDrop}
            style={{
              // Bottom-left is square: the vertical rail sits to the left so that corner is
              // interior. The native BrowserView rounds all four corners (setBorderRadius), so
              // we mask its interior bottom-left rounding with a chrome fill below.
              borderRadius: '0 0 var(--workbench-canvas-radius) 0',
              isolation: 'isolate',
            }}
          >
            {showBrowserViewCornerFill && (
              <>
                <div
                  className="browser-shell-corner-fill-left"
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    width: 'var(--workbench-canvas-radius)',
                    height: 'var(--workbench-canvas-radius)',
                    borderBottomRightRadius: 'var(--workbench-canvas-radius)',
                    background: 'var(--workbench-liquid-chrome-bg, var(--rn-sheet))',
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
                    background: 'var(--workbench-liquid-chrome-bg, var(--rn-sheet))',
                    pointerEvents: 'none',
                    zIndex: 2,
                  }}
                />
                {fillBottomLeftCorner && (
                  <div
                    className="browser-shell-corner-fill-bottom-left"
                    style={{
                      position: 'absolute',
                      left: 0,
                      bottom: 0,
                      width: 'var(--workbench-canvas-radius)',
                      height: 'var(--workbench-canvas-radius)',
                      borderTopRightRadius: 'var(--workbench-canvas-radius)',
                      background: 'var(--workbench-liquid-chrome-bg, var(--rn-sheet))',
                      pointerEvents: 'none',
                      zIndex: 2,
                    }}
                  />
                )}
              </>
            )}

            {!isElectron && (
              <div className="absolute inset-0 flex items-center justify-center text-[var(--rn-ink-3)]">
                <div className="text-center">
                  <Globe className="mx-auto mb-3 h-12 w-12 opacity-30" />
                  <p className="text-[13px]">Browser requires Electron environment</p>
                </div>
              </div>
            )}

            {cover}

            {showReadyBlankPage && (
              <div
                className="browser-ready-blank-page absolute inset-0 flex items-center justify-center"
                style={{
                  // No blur of its own (W1 §4): the window's glass is the only frosting behind the page area.
                  background: 'var(--workbench-module-surface-bg)',
                  zIndex: 1,
                  pointerEvents: 'none',
                }}
              >
                <div
                  role="img"
                  aria-label="Ready"
                  style={{
                    display: 'block',
                    width: 'min(210px, calc(100vw - 96px))',
                    aspectRatio: '4048 / 845',
                    background: 'var(--rn-accent)',
                    WebkitMask: `url(${readyWordmark}) center / contain no-repeat`,
                    mask: `url(${readyWordmark}) center / contain no-repeat`,
                  }}
                />
              </div>
            )}

            {activeTab?.error && (
              <div
                className="absolute inset-0 flex items-center justify-center"
                // The page area is paper while the page cannot show (opaque, no blur of its own).
                style={{ background: 'var(--rn-sheet)' }}
              >
                <div className="text-center" style={{ maxWidth: 360 }}>
                  <AlertTriangle
                    className="mx-auto mb-4"
                    style={{ width: 48, height: 48, color: 'var(--rn-warn)' }}
                    strokeWidth={1.5}
                  />
                  <p className="mb-2 text-[15px] font-medium" style={{ color: 'var(--rn-ink)' }}>
                    Page failed to load
                  </p>
                  <p className="mb-4 text-[12px]" style={{ color: 'var(--rn-ink-2)', lineHeight: 1.6 }}>
                    {activeTab.error}
                  </p>
                  <Button icon={<RefreshCw />} onClick={() => void onRetry()}>
                    Retry
                  </Button>
                </div>
              </div>
            )}

            {toastVisible && (
              <div
                className="rn-float"
                style={{
                  position: 'absolute',
                  bottom: 16,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  color: 'var(--rn-ink)',
                  padding: '8px 16px',
                  fontSize: 13,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  zIndex: 30,
                  animation: 'cookieToastFade 3s ease-in-out forwards',
                  pointerEvents: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                <CheckCircle
                  style={{ width: 16, height: 16, color: 'var(--rn-ok)', flexShrink: 0 }}
                  strokeWidth={2}
                />
                已保存登录状态
              </div>
            )}

            {(mediaDropActive || mediaUploadStatus) && (
              <div
                className="absolute inset-0 flex items-end justify-center"
                style={{
                  zIndex: 35,
                  pointerEvents: mediaDropActive ? 'auto' : 'none',
                  paddingBottom: 18,
                  background: 'transparent',
                  cursor: mediaDropActive ? 'copy' : undefined,
                }}
              >
                {(mediaUploadStatus || mediaDropActive) && (
                  <div
                    className="rn-float flex items-center gap-2 px-3 py-2"
                    style={{ borderRadius: 'var(--rn-r-pill)', color: 'var(--rn-ink)' }}
                  >
                    {mediaUploadStatus?.kind === 'success' ? (
                      <CheckCircle style={{ width: 15, height: 15, color: 'var(--rn-ok)' }} strokeWidth={2} />
                    ) : mediaUploadStatus?.kind === 'error' ? (
                      <AlertTriangle style={{ width: 15, height: 15, color: 'var(--rn-bad)' }} strokeWidth={2} />
                    ) : (
                      <UploadCloud style={{ width: 15, height: 15, color: 'var(--rn-accent)' }} strokeWidth={2} />
                    )}
                    <span className="text-[12px] font-medium">
                      {mediaUploadStatus?.message || '松开即可上传到当前网页'}
                    </span>
                  </div>
                )}
              </div>
            )}
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
