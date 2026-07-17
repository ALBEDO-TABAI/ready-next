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
        style={{
          position: 'absolute',
          left: snapshot.x,
          top: snapshot.y,
          width: pressed ? 34 : 22,
          height: pressed ? 34 : 22,
          borderRadius: '50%',
          border: `2px solid ${pressed ? 'rgba(52,120,246,.9)' : 'rgba(52,120,246,.55)'}`,
          background: pressed ? 'rgba(52,120,246,.14)' : 'rgba(52,120,246,.06)',
          boxShadow: '0 0 0 5px rgba(52,120,246,.08), 0 5px 18px rgba(18,62,140,.24)',
          transform: 'translate(-50%, -50%)',
          transition: 'left 90ms linear, top 90ms linear, width 90ms ease, height 90ms ease',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: snapshot.x + 11,
          top: snapshot.y + 11,
          padding: '3px 7px',
          borderRadius: 999,
          background: 'rgba(25, 35, 55, .78)',
          color: 'white',
          font: '600 10px -apple-system, BlinkMacSystemFont, sans-serif',
          boxShadow: '0 4px 14px rgba(0,0,0,.2)',
          whiteSpace: 'nowrap',
        }}
      >
        Agent
      </div>
    </div>
  )
}
