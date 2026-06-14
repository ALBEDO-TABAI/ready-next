import { useState, useCallback } from 'react'
import {
  Users, Settings, Globe, FileText,
  Rss, Calendar
} from 'lucide-react'
import { motion } from 'framer-motion'
import { useMode, type WorkbenchMode } from '../stores/useMode'
import { useAgent } from '../stores/useAgent'
import ModeSlider from '../components/layout/ModeSlider'
import MorphSegmentedControl, { type MorphSegmentedItem } from '../components/motion/MorphSegmentedControl'
import TaskPanel from '../components/ready/TaskPanel'
import MeetingChat from '../components/ready/MeetingChat'
import LiveFollowPanel from '../components/ready/LiveFollowPanel'
import FilePanel from '../components/ready/FilePanel'
import { isLocalHtmlFilePath, openLocalHtmlFileInBrowser } from '../modules/browser/localHtmlFileOpen'

/* ─── Sub-mode tab definitions ─── */
const subModes: { id: WorkbenchMode; label: string; icon: React.ElementType }[] = [
  { id: 'browser',  label: '浏览器', icon: Globe },
  { id: 'document', label: '文档',   icon: FileText },
  { id: 'rss',      label: 'RSS',    icon: Rss },
  { id: 'calendar', label: '日程',   icon: Calendar }
]

/**
 * ReadyMode — four-panel Ready mode container.
 *
 * Layout:
 *   ReadyTopBar (40px)
 *   ┌──────────┬──────────┬──────────────┬─────────┐
 *   │TaskPanel │MeetingChat│LiveFollowPanel│FilePanel│
 *   │  200px   │  420px   │    fill       │  180px  │
 *   └──────────┴──────────┴──────────────┴─────────┘
 */
export default function ReadyMode() {
  const { readySubMode, setReadySubMode } = useMode()
  const { addMessage } = useAgent()
  const [isFollowMode, setIsFollowMode] = useState(false)

  const subModeItems: MorphSegmentedItem[] = subModes.map((mode) => ({
    id: mode.id,
    label: mode.label,
    icon: mode.icon,
    active: readySubMode === mode.id && !isFollowMode,
    onClick: () => {
      setReadySubMode(mode.id)
      setIsFollowMode(false)
    },
  }))

  /** Handle file drop from FilePanel onto MeetingChat */
  const handleFileDrop = useCallback((filePath: string, fileName: string) => {
    addMessage({
      id: `file-${Date.now()}`,
      agent: 'system',
      content: `📎 附件: ${fileName}\n路径: ${filePath}`,
      type: 'system',
      timestamp: new Date()
    })
  }, [addMessage])

  /** Handle file click in FilePanel — open in the matching LiveFollowPanel mode */
  const handleFileOpen = useCallback((filePath: string) => {
    if (isLocalHtmlFilePath(filePath)) {
      setIsFollowMode(false)
      void openLocalHtmlFileInBrowser(filePath).then((opened) => {
        if (opened) setReadySubMode('browser')
      })
      return
    }

    setReadySubMode('document')
    setIsFollowMode(false)
  }, [setReadySubMode])

  return (
    <div className="flex flex-col h-full">
      {/* ═══ ReadyTopBar (40px) ═══ */}
      <div
        className="glass-surface-panel flex items-center justify-between flex-shrink-0"
        style={{
          height: 40,
          padding: '0 16px 0 72px',
          background: 'var(--surface-toolbar-bg)',
          borderBottom: '1px solid var(--border-default)',
          boxShadow: 'var(--shadow-md)'
        }}
      >
        {/* Left: Green-themed ModeSlider */}
        <div className="flex items-center" style={{ gap: 12 }}>
          <ModeSlider />
        </div>

        {/* Center: Sub-mode tabs */}
        <div className="flex items-center" style={{ gap: 8 }}>
          {/* Live Follow tab — toggleable green */}
          <motion.button
            onClick={() => setIsFollowMode(!isFollowMode)}
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.985, y: 0 }}
            className="flex items-center transition-[background-color,color] duration-200"
            style={{
              padding: '4px 10px',
              borderRadius: 8,
              background: isFollowMode ? 'var(--color-green-medium)' : 'var(--color-green-subtle)',
              fontSize: 11, fontWeight: 500, color: 'var(--color-green)',
              border: isFollowMode ? '1px solid var(--color-green)' : '1px solid transparent'
            }}
          >
            实时跟随
          </motion.button>

          <div className="glass-surface-card morph-segmented-track flex items-center rounded-[12px] p-[2px]">
            <MorphSegmentedControl
              layoutId="ready-submodes"
              items={subModeItems}
              className="flex items-center gap-1"
              itemClassName="relative flex h-[26px] items-center justify-center rounded-[8px] px-[10px]"
              contentClassName="relative z-[1] flex h-full items-center justify-center gap-1 text-[11px] leading-none"
            />
          </div>
        </div>

        {/* Right: collaboration + settings */}
        <div className="flex items-center" style={{ gap: 8 }}>
          <button className="p-1 rounded hover:bg-[var(--bg-hover)] transition-colors" aria-label="协作">
            <Users style={{ width: 15, height: 15 }} className="text-[var(--text-light)]" strokeWidth={2} />
          </button>
          <button className="p-1 rounded hover:bg-[var(--bg-hover)] transition-colors" aria-label="设置">
            <Settings style={{ width: 15, height: 15 }} className="text-[var(--text-light)]" strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* ═══ Four-panel content body ═══ */}
      <div className="flex-1 flex overflow-hidden">
        <TaskPanel />
        <MeetingChat onFileDrop={handleFileDrop} />
        <LiveFollowPanel isFollowMode={isFollowMode} />
        <FilePanel onFileDrop={handleFileDrop} onFileOpen={handleFileOpen} />
      </div>
    </div>
  )
}
