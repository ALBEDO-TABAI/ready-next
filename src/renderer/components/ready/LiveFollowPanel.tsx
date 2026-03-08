import { useState, useEffect, useRef } from 'react'
import { useMode, type WorkbenchMode } from '../../stores/useMode'
import { useAgent } from '../../stores/useAgent'
import WorkbenchModeOutlet from '../layout/WorkbenchModeOutlet'

/** Map agent names to their primary working mode */
const agentModeMap: Record<string, WorkbenchMode> = {
  butler: 'browser',
  copywriter: 'document',
  'video-editor': 'video',
  analyst: 'rss'
}

const subModeLabels: Record<WorkbenchMode, string> = {
  browser: '浏览器',
  document: '文档',
  design: '设计',
  video: '剪辑',
  rss: 'RSS',
  calendar: '日程'
}

interface LiveFollowPanelProps {
  isFollowMode: boolean
}

/**
 * LiveFollowPanel (flex fill) — Center panel showing the active sub-mode content.
 * Switches view based on readySubMode from useMode store.
 * When follow mode is active, auto-switches to the working agent's mode.
 */
export default function LiveFollowPanel({ isFollowMode }: LiveFollowPanelProps) {
  const { readySubMode, setReadySubMode } = useMode()
  const { agents } = useAgent()
  const [visible, setVisible] = useState(true)
  const prevModeRef = useRef(readySubMode)

  // Auto-switch mode when an agent is working (follow mode)
  useEffect(() => {
    if (!isFollowMode) return
    const workingAgent = agents.find(a => a.status === 'working' && a.selected)
    if (workingAgent && agentModeMap[workingAgent.name]) {
      setReadySubMode(agentModeMap[workingAgent.name])
    }
  }, [isFollowMode, agents, setReadySubMode])

  // Fade transition on mode change
  useEffect(() => {
    if (prevModeRef.current !== readySubMode) {
      setVisible(false)
      const timer = setTimeout(() => {
        prevModeRef.current = readySubMode
        setVisible(true)
      }, 100)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [readySubMode])

  const hasWorkingAgent = agents.some(a => a.status === 'working' && a.selected)

  const renderSubMode = () => {
    // In follow mode with no working agent, show placeholder
    if (isFollowMode && !hasWorkingAgent) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center" style={{ gap: 16 }}>
          {/* Pulsing circle */}
          <div
            style={{
              width: 48, height: 48, borderRadius: '50%',
              background: 'var(--color-green-light)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              animation: 'pulse 2s cubic-bezier(0.4,0,0.6,1) infinite'
            }}
          >
            <div
              style={{
                width: 20, height: 20, borderRadius: '50%',
                background: 'var(--color-green)',
                opacity: 0.6
              }}
            />
          </div>
          <span style={{ fontSize: 13, color: 'var(--text-light)', fontWeight: 500 }}>
            等待 Agent 开始工作...
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-placeholder)' }}>
            实时跟随模式已开启，将自动切换到 Agent 工作视图
          </span>
        </div>
      )
    }

    switch (readySubMode) {
      case 'browser':
      case 'document':
      case 'design':
      case 'video':
      case 'rss':
      case 'calendar':
        return <WorkbenchModeOutlet mode={readySubMode} />
      default:
        return <WorkbenchModeOutlet mode="browser" />
    }
  }

  return (
    <div
      className="flex-1 flex flex-col min-w-0"
      style={{ background: 'var(--bg-content)', position: 'relative' }}
    >
      {/* Sub-mode label overlay at top-right */}
      <div
        style={{
          position: 'absolute', top: 8, right: 12, zIndex: 10,
          padding: '3px 10px', borderRadius: 8,
          background: isFollowMode ? 'rgba(52,211,153,0.12)' : 'rgba(91,141,239,0.08)',
          color: isFollowMode ? 'var(--color-green)' : 'var(--color-blue)',
          fontSize: 10, fontWeight: 600,
          pointerEvents: 'none',
          backdropFilter: 'blur(8px)'
        }}
      >
        {isFollowMode ? '实时跟随' : subModeLabels[readySubMode]}
      </div>

      {/* Content with fade transition */}
      <div
        className="flex-1 flex flex-col min-w-0"
        style={{
          opacity: visible ? 1 : 0,
          transition: 'opacity 200ms ease-in-out'
        }}
      >
        {renderSubMode()}
      </div>
    </div>
  )
}
