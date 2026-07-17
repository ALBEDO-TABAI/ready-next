import { useEffect, useState } from 'react'
import { Bot, ShieldAlert, X } from 'lucide-react'
import type { BrowserLockOverlaySnapshot } from '../../shared/browser-lock-overlay'

export default function BrowserLockOverlayWindow() {
  const [snapshot, setSnapshot] = useState<BrowserLockOverlaySnapshot | null>(null)

  useEffect(() => {
    document.documentElement.dataset.browserLockOverlayWindow = 'true'
    return () => {
      delete document.documentElement.dataset.browserLockOverlayWindow
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const browser = window.electronAPI?.browser
    const cleanup = browser?.onBrowserLockOverlaySnapshot?.((next) => {
      setSnapshot(next)
    }) ?? (() => undefined)

    void browser?.getBrowserLockOverlaySnapshot?.().then((result) => {
      if (cancelled) return
      if (result?.success && result.data) {
        setSnapshot(result.data)
        return
      }
      void browser?.hideBrowserLockOverlay?.()
    })

    return () => {
      cancelled = true
      cleanup()
    }
  }, [])

  if (!snapshot) return <div data-browser-lock-overlay-root="" />

  const isWarning = snapshot.tone === 'warning'
  const Icon = isWarning ? ShieldAlert : Bot
  const accent = isWarning ? '#f97316' : '#3478f6'

  return (
    <div
      data-browser-lock-overlay-root=""
      data-browser-lock-overlay-kind={snapshot.kind}
      style={{
        width: '100vw',
        height: '100vh',
        pointerEvents: 'auto',
        background: 'transparent',
        display: 'flex',
        alignItems: 'stretch',
      }}
    >
      <div
        style={{
          position: 'relative',
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '8px 12px',
          borderRadius: 14,
          border: `1px solid color-mix(in srgb, ${accent} 42%, transparent)`,
          background: 'color-mix(in srgb, rgba(250, 252, 255, 0.94) 92%, transparent)',
          boxShadow: `0 12px 30px color-mix(in srgb, ${accent} 20%, transparent), inset 0 1px 0 rgba(255,255,255,0.74)`,
          color: '#172033',
          overflow: 'hidden',
          fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif',
        }}
      >
        {snapshot.proof?.enabled && (
          <div
            data-p7c3-proof-marker=""
            style={{
              position: 'absolute',
              left: snapshot.proof.samplePoint.x - 6,
              top: snapshot.proof.samplePoint.y - 6,
              width: 12,
              height: 12,
              background: snapshot.proof.color,
              zIndex: 3,
            }}
          />
        )}
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: `color-mix(in srgb, ${accent} 13%, transparent)`,
            color: accent,
            flexShrink: 0,
          }}
        >
          <Icon style={{ width: 17, height: 17 }} strokeWidth={2.2} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 700, lineHeight: 1.15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {snapshot.label}
          </div>
          <div style={{ marginTop: 3, fontSize: 11, lineHeight: 1.2, color: '#5f6b7d', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {snapshot.detail}
          </div>
        </div>
        <button
          type="button"
          aria-label="关闭 Agent 控制提示"
          onClick={() => { void window.electronAPI?.browser?.dismissBrowserLockOverlay?.() }}
          style={{
            width: 28,
            height: 28,
            border: 0,
            borderRadius: 9,
            background: 'rgba(80, 94, 120, 0.08)',
            color: '#657086',
            display: 'grid',
            placeItems: 'center',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <X aria-hidden="true" style={{ width: 14, height: 14 }} strokeWidth={2.2} />
        </button>
      </div>
    </div>
  )
}
