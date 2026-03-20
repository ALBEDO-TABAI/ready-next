import { lazy, Suspense } from 'react'
import type { WorkbenchMode } from '../../stores/useMode'

type ModeComponentProps = {
  isActive?: boolean
}

const loadBrowserMode = () => import('../../pages/modes/BrowserMode')
const loadDocumentMode = () => import('../../pages/modes/DocumentMode')
const loadRSSMode = () => import('../../pages/modes/RSSMode')
const loadCalendarMode = () => import('../../pages/modes/CalendarMode')

const BrowserMode = lazy(loadBrowserMode) as React.ComponentType<ModeComponentProps>
const DocumentMode = lazy(loadDocumentMode) as React.ComponentType<ModeComponentProps>
const RSSMode = lazy(loadRSSMode) as React.ComponentType<ModeComponentProps>
const CalendarMode = lazy(loadCalendarMode) as React.ComponentType<ModeComponentProps>

const MODE_COMPONENTS: Record<WorkbenchMode, React.ComponentType<ModeComponentProps>> = {
  browser: BrowserMode,
  document: DocumentMode,
  rss: RSSMode,
  calendar: CalendarMode,
}

const MODE_LABELS: Record<WorkbenchMode, string> = {
  browser: '浏览器',
  document: '文档',
  rss: 'RSS',
  calendar: '日历',
}

const ALL_WORKBENCH_MODES: WorkbenchMode[] = ['browser', 'document', 'rss', 'calendar']

function ModeFallback({ mode }: { mode: WorkbenchMode }) {
  return (
    <div className="flex h-full items-center justify-center" style={{ background: 'transparent' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
        {`加载${MODE_LABELS[mode]}...`}
      </span>
    </div>
  )
}

export default function WorkbenchModeOutlet({ mode }: { mode: WorkbenchMode }) {
  return (
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden" style={{ background: 'transparent' }}>
      {ALL_WORKBENCH_MODES.map((mountedMode) => {
        const ModeComponent = MODE_COMPONENTS[mountedMode] || MODE_COMPONENTS.browser
        const isActive = mountedMode === mode

        return (
          <div
            key={mountedMode}
            className={`absolute inset-0 flex min-h-0 flex-col overflow-hidden ${isActive ? 'flex' : 'hidden'}`}
            aria-hidden={!isActive}
            data-workbench-mode-panel={mountedMode}
            style={{
              background: 'transparent',
              pointerEvents: isActive ? 'auto' : 'none',
              zIndex: isActive ? 1 : 0,
            }}
          >
            <Suspense fallback={isActive ? <ModeFallback mode={mountedMode} /> : null}>
              <ModeComponent isActive={isActive} />
            </Suspense>
          </div>
        )
      })}
    </div>
  )
}
