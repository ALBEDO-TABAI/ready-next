import { lazy, memo, Suspense, useEffect } from 'react'
import type { WorkbenchMode } from '../../stores/useMode'
import type { BrowserHostLayoutPhase } from '../../../shared/browser-view-layout'

type ModeComponentProps = {
  isActive?: boolean
  isMotionSettled?: boolean
  browserLayoutPhase?: BrowserHostLayoutPhase | null
  layoutPhase?: BrowserHostLayoutPhase
}

interface ModeSceneProps {
  modeKey: WorkbenchMode
  isActive: boolean
  isMotionSettled: boolean
  browserLayoutPhase: BrowserHostLayoutPhase | null
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

const ALL_WORKBENCH_MODES: WorkbenchMode[] = ['browser', 'document', 'rss', 'calendar']
const ALL_MODE_LOADERS = [loadBrowserMode, loadDocumentMode, loadRSSMode, loadCalendarMode]
let hasPreloadedWorkbenchModes = false

function ModeFallback() {
  return (
    <div className="flex h-full items-center justify-center" style={{ background: 'transparent' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
        加载中...
      </span>
    </div>
  )
}

function areModeScenePropsEqual(previous: ModeSceneProps, next: ModeSceneProps) {
  if (previous.modeKey !== next.modeKey) return false
  if (!previous.isActive && !next.isActive) return true
  return (
    previous.isActive === next.isActive
    && previous.isMotionSettled === next.isMotionSettled
    && previous.browserLayoutPhase === next.browserLayoutPhase
  )
}

const ModeScene = memo(function ModeScene({
  modeKey,
  isActive,
  isMotionSettled,
  browserLayoutPhase,
}: ModeSceneProps) {
  const ModeComponent = MODE_COMPONENTS[modeKey]

  return (
    <div
      className="absolute inset-0 overflow-hidden"
      style={{
        display: isActive ? 'block' : 'none',
        pointerEvents: isActive ? 'auto' : 'none',
        transform: 'translate3d(0, 0, 0)',
        opacity: isActive ? 1 : 0,
      }}
      data-workbench-mode-panel={modeKey}
      data-mode-visual-state={isActive ? 'current' : 'hidden'}
      aria-hidden={!isActive}
    >
      <Suspense fallback={<ModeFallback />}>
        <ModeComponent
          isActive={isActive}
          isMotionSettled={isActive ? isMotionSettled : false}
          browserLayoutPhase={modeKey === 'browser' ? browserLayoutPhase : null}
          layoutPhase={modeKey === 'browser' ? browserLayoutPhase ?? undefined : undefined}
        />
      </Suspense>
    </div>
  )
}, areModeScenePropsEqual)

export default function WorkbenchModeOutlet({
  mode,
  isMotionSettled = true,
  browserLayoutPhase = null,
}: {
  mode: WorkbenchMode
  isMotionSettled?: boolean
  browserLayoutPhase?: BrowserHostLayoutPhase | null
}) {
  useEffect(() => {
    if (hasPreloadedWorkbenchModes) return
    hasPreloadedWorkbenchModes = true
    ALL_MODE_LOADERS.forEach((loadMode) => {
      void loadMode()
    })
  }, [])

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{
        background: 'transparent',
      }}
    >
      {ALL_WORKBENCH_MODES.map((modeKey) => (
        <ModeScene
          key={modeKey}
          modeKey={modeKey}
          isActive={modeKey === mode}
          isMotionSettled={isMotionSettled}
          browserLayoutPhase={browserLayoutPhase}
        />
      ))}
    </div>
  )
}
