import { useEffect, useState } from 'react'
import { Bot, ShieldAlert, X } from 'lucide-react'
import type { BrowserLockOverlaySnapshot } from '../../shared/browser-lock-overlay'
import { IconButton } from '../components/ui'

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

  const Icon = snapshot.tone === 'warning' ? ShieldAlert : Bot

  return (
    <div
      data-browser-lock-overlay-root=""
      data-browser-lock-overlay-kind={snapshot.kind}
      style={{ width: '100vw', height: '100vh', pointerEvents: 'auto', background: 'transparent', display: 'flex', alignItems: 'stretch' }}
    >
      <div className="browser-lock-overlay" data-tone={snapshot.tone}>
        {snapshot.proof?.enabled && (
          <div
            data-p7c3-proof-marker=""
            style={{
              position: 'absolute',
              left: snapshot.proof.samplePoint.x - 6,
              top: snapshot.proof.samplePoint.y - 6,
              width: 12,
              height: 12,
              // The proof marker's colour is test data supplied with the snapshot.
              background: snapshot.proof.color,
              zIndex: 3,
            }}
          />
        )}
        <div className="browser-lock-overlay__icon">
          <Icon strokeWidth={2} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="browser-lock-overlay__label">{snapshot.label}</div>
          <div className="browser-lock-overlay__detail">{snapshot.detail}</div>
        </div>
        <IconButton
          icon={<X aria-hidden="true" strokeWidth={2} />}
          title="关闭 Agent 控制提示"
          onClick={() => { void window.electronAPI?.browser?.dismissBrowserLockOverlay?.() }}
        />
      </div>
    </div>
  )
}
