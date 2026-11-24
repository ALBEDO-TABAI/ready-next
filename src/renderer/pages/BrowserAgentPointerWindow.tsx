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
  // The pointer glides from where it was to where the agent acts next, its label with it, and the ring tightens on a
  // press (motion language M2; electron-shell.css): one element moved by transform, so the path is seen, not a jump.
  return (
    <div
      data-browser-agent-pointer-root=""
      data-pointer-phase={snapshot.phase}
      style={{ position: 'fixed', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}
    >
      <div className="browser-agent-pointer" style={{ transform: `translate3d(${snapshot.x}px, ${snapshot.y}px, 0)` }}>
        <div data-browser-agent-pointer-ring="" data-pressed={pressed} className="browser-agent-pointer__ring" />
        <div className="browser-agent-pointer__label">Agent</div>
      </div>
    </div>
  )
}
