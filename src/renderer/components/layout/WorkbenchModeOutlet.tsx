import { lazy, Suspense } from 'react'
import type { WorkbenchMode } from '../../stores/useMode'

const BrowserMode = lazy(() => import('../../pages/modes/BrowserMode'))
const DocumentMode = lazy(() => import('../../pages/modes/DocumentMode'))
const DesignMode = lazy(() => import('../../pages/modes/DesignMode'))
const VideoMode = lazy(() => import('../../pages/modes/VideoMode'))
const RSSMode = lazy(() => import('../../pages/modes/RSSMode'))
const CalendarMode = lazy(() => import('../../pages/modes/CalendarMode'))

const MODE_COMPONENTS: Record<WorkbenchMode, React.ComponentType> = {
  browser: BrowserMode,
  document: DocumentMode,
  design: DesignMode,
  video: VideoMode,
  rss: RSSMode,
  calendar: CalendarMode,
}

const MODE_LABELS: Record<WorkbenchMode, string> = {
  browser: '浏览器',
  document: '文档',
  design: '设计',
  video: '剪辑',
  rss: 'RSS',
  calendar: '日历',
}

function ModeFallback({ mode }: { mode: WorkbenchMode }) {
  return (
    <div className="flex items-center justify-center h-full">
      <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
        {`加载${MODE_LABELS[mode]}...`}
      </span>
    </div>
  )
}

export default function WorkbenchModeOutlet({ mode }: { mode: WorkbenchMode }) {
  const ModeComponent = MODE_COMPONENTS[mode] || MODE_COMPONENTS.browser

  return (
    <Suspense fallback={<ModeFallback mode={mode} />}>
      <ModeComponent />
    </Suspense>
  )
}
