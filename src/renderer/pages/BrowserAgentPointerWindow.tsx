import { useEffect, useState } from 'react'
import type { BrowserAgentPointerSnapshot } from '../../shared/browser-agent-pointer'

export default function BrowserAgentPointerWindow() {
  const [snapshot, setSnapshot] = useState<BrowserAgentPointerSnapshot | null>(null)

  useEffect(() => {
    document.documentElement.dataset.browserAgentPointerWindow = 'true'
    const browser = window.electronAPI?.browser
    const cleanup = browser?.onBrowserAgentPointerSnapshot?.(setSnapshot) ?? (() => undefined)
    void browser?.getBrowserAgentPointerSnapshot?.().then((result) => {
      if (result?.success && result.data) setSnapshot(result.data)
    })
    return () => {
      cleanup()
      delete document.documentElement.dataset.browserAgentPointerWindow
    }
  }, [])

  if (!snapshot) return <div data-browser-agent-pointer-root="" />
  const pressed = snapshot.phase === 'press' || snapshot.phase === 'drag'
  return (
    <div
      data-browser-agent-pointer-root=""
      data-pointer-phase={snapshot.phase}
      style={{ position: 'fixed', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}
    >
      <div
        key={`${snapshot.revision}-ripple`}
        data-browser-agent-pointer-ring=""
        data-pressed={pressed}
        className="browser-agent-pointer__ring"
        style={{ left: snapshot.x, top: snapshot.y }}
      />
      <div className="browser-agent-pointer__label" style={{ left: snapshot.x + 11, top: snapshot.y + 11 }}>
        Agent
      </div>
    </div>
  )
}
