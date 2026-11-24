import type { DragEvent, ReactNode, RefObject } from 'react'
import { AlertTriangle, CheckCircle, Globe, RefreshCw, UploadCloud } from 'lucide-react'
import readyWordmark from '../../assets/ready-wordmark.svg'
import { isReadyBrowserBlankUrl } from '../../modules/browser/url-utils'
import type { BrowserTab } from '../../stores/useBrowserTabs'
import { Button } from '../ui'
import { useLeavingRef } from '../ui/leave'

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
  band = null,
  cover = null,
}: BrowserShellLayoutProps) {
  const showReadyBlankPage = activeTab ? isReadyBrowserBlankUrl(activeTab.url) && !activeTab.error : false
  // The native page is showing in this frame (not the blank page, an error or the reading view over it).
  const showNativePage = isElectron && Boolean(activeTab) && !showReadyBlankPage && !activeTab?.error && !cover
  // The loading line creeps forward and never rewinds; when the page has loaded it fades out where it got to.
  const progressRef = useLeavingRef<HTMLDivElement>()

  return (
    // One pane of the browser panel's framed body (V11): the bands for this page, then the page, inset by the frame pad.
    <div className="browser-pane">
      {band}
      <div className="browser-pane__page">
        {/* Loading: a quiet ink line in the frame gap above the page; it takes no room, so the page never shifts. */}
        {activeTab?.loading && <div ref={progressRef} className="browser-pane__progress" aria-hidden="true"><span /></div>}
        <div
          ref={contentRef}
          data-browser-local-media-drop-surface=""
          data-ready-native-surface={showNativePage ? 'browser' : undefined}
          // The page's box (browser-shell.css): the native view rounds its corners with the same radius (HOST_BORDER_RADIUS
          // in Main), and the DOM in its place (blank page, error, reading view) clips to it, so the outline never changes.
          className="browser-page"
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
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
                // The empty page stands where the opaque native page shows, so it is opaque too (no flash between them).
                background: 'var(--rn-solid)',
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
              // The page area stays opaque while the page cannot show (no blur of its own).
              style={{ background: 'var(--rn-solid)' }}
            >
              <div className="text-center" style={{ maxWidth: 360 }}>
                <AlertTriangle
                  className="mx-auto mb-4"
                  style={{ width: 48, height: 48, color: 'var(--rn-warn)' }}
                  strokeWidth={1.5}
                />
                <p className="mb-2 text-[15px] leading-[24px] font-medium" style={{ color: 'var(--rn-ink)' }}>
                  Page failed to load
                </p>
                <p className="mb-4 text-[12px]" style={{ color: 'var(--rn-ink-2)', lineHeight: '16px' }}>
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
                animation: 'cookieToastFade calc(var(--rn-d-flash) * 2.5) var(--rn-ease-std) forwards',
                pointerEvents: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              <CheckCircle
                style={{ width: 16, height: 16, color: 'var(--rn-ok)', flexShrink: 0 }}
                strokeWidth={1.5}
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
                paddingBottom: 16,
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
                    <CheckCircle style={{ width: 16, height: 16, color: 'var(--rn-ok)' }} strokeWidth={1.5} />
                  ) : mediaUploadStatus?.kind === 'error' ? (
                    <AlertTriangle style={{ width: 16, height: 16, color: 'var(--rn-bad)' }} strokeWidth={1.5} />
                  ) : (
                    <UploadCloud style={{ width: 16, height: 16, color: 'var(--rn-accent)' }} strokeWidth={1.5} />
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

      <style>{`
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
