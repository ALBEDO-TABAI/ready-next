import { useCallback } from 'react'
import { Globe, FileText, Rss, Calendar } from 'lucide-react'
import { useMode, type WorkbenchMode } from '../stores/useMode'
import { useAgent } from '../stores/useAgent'
import ModeSlider from '../components/layout/ModeSlider'
import MorphSegmentedControl, { type MorphSegmentedItem } from '../components/motion/MorphSegmentedControl'
import TaskPanel from '../components/ready/TaskPanel'
import MeetingChat from '../components/ready/MeetingChat'
import FilePanel from '../components/ready/FilePanel'
import WorkbenchModeOutlet from '../components/layout/WorkbenchModeOutlet'
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
 *   │TaskPanel │MeetingChat│  Workbench   │FilePanel│
 *   │  200px   │  420px   │    fill       │  180px  │
 *   └──────────┴──────────┴──────────────┴─────────┘
 */
export default function ReadyMode() {
  const { readySubMode, setReadySubMode } = useMode()
  const { addMessage } = useAgent()

  const subModeItems: MorphSegmentedItem[] = subModes.map((mode) => ({
    id: mode.id,
    label: mode.label,
    icon: mode.icon,
    active: readySubMode === mode.id,
    onClick: () => setReadySubMode(mode.id),
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

  /** Handle file click in FilePanel — open in the matching workbench mode */
  const handleFileOpen = useCallback((filePath: string) => {
    if (isLocalHtmlFilePath(filePath)) {
      void openLocalHtmlFileInBrowser(filePath).then((opened) => {
        if (opened) setReadySubMode('browser')
      })
      return
    }

    setReadySubMode('document')
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

        <div aria-hidden="true" />
      </div>

      {/* ═══ Four-panel content body ═══ */}
      <div className="flex-1 flex overflow-hidden">
        <TaskPanel />
        <MeetingChat onFileDrop={handleFileDrop} />
        <div className="flex-1 flex flex-col min-w-0" style={{ background: 'var(--bg-content)' }}>
          <WorkbenchModeOutlet mode={readySubMode} />
        </div>
        <FilePanel onFileDrop={handleFileDrop} onFileOpen={handleFileOpen} />
      </div>
    </div>
  )
}
