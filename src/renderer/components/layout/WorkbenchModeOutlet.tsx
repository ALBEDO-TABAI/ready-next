import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import type { WorkbenchMode } from '../../stores/useMode'

type ModeComponentProps = {
  isActive?: boolean
  isMotionSettled?: boolean
  isTransitioning?: boolean
  transitionDirection?: -1 | 1
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
const ALL_MODE_LOADERS = [loadBrowserMode, loadDocumentMode, loadRSSMode, loadCalendarMode]
let hasPreloadedWorkbenchModes = false

function ModeFallback({ mode }: { mode: WorkbenchMode }) {
  return (
    <div className="flex h-full items-center justify-center" style={{ background: 'transparent' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
        {`加载${MODE_LABELS[mode]}...`}
      </span>
    </div>
  )
}

export default function WorkbenchModeOutlet({
  mode,
  isMotionSettled = true,
}: {
  mode: WorkbenchMode
  isMotionSettled?: boolean
}) {
  useEffect(() => {
    if (hasPreloadedWorkbenchModes) return
    hasPreloadedWorkbenchModes = true
    ALL_MODE_LOADERS.forEach((loadMode) => {
      void loadMode()
    })
  }, [])

  // Only render current and previous mode to reduce DOM overhead during transitions
  const [lastActiveMode, setLastActiveMode] = useState<WorkbenchMode>(mode)
  const [transitioningFrom, setTransitioningFrom] = useState<WorkbenchMode | null>(null)

  useEffect(() => {
    if (mode !== lastActiveMode) {
      setTransitioningFrom(lastActiveMode)
      setLastActiveMode(mode)
      // Clear the transitioning state after animation completes
      const timer = window.setTimeout(() => {
        setTransitioningFrom(null)
      }, 400)
      return () => { window.clearTimeout(timer) }
    }
    return undefined
  }, [mode, lastActiveMode])

  // Determine which modes to render: current + transitioning (if any)
  const modesToRender = useMemo(() => {
    const modes = new Set<WorkbenchMode>([mode])
    if (transitioningFrom) {
      modes.add(transitioningFrom)
    }
    return modes
  }, [mode, transitioningFrom])

  // Calculate transition direction based on mode order
  const transitionDirection = useMemo(() => {
    if (!transitioningFrom) return 1
    const fromIndex = ALL_WORKBENCH_MODES.indexOf(transitioningFrom)
    const toIndex = ALL_WORKBENCH_MODES.indexOf(mode)
    return toIndex > fromIndex ? 1 : -1
  }, [mode, transitioningFrom])

  // Generate mode panels
  const modePanels = useMemo(() => {
    return ALL_WORKBENCH_MODES.map((mountedMode) => {
      // Skip rendering modes that are not active and not transitioning
      if (!modesToRender.has(mountedMode)) {
        return <div key={mountedMode} style={{ display: 'none' }} data-skipped-mode={mountedMode} />
      }

      const ModeComponent = MODE_COMPONENTS[mountedMode] || MODE_COMPONENTS.browser
      const isActive = mountedMode === mode
      const isTransitioning = mountedMode === transitioningFrom

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
            <ModeComponent
              isActive={isActive}
              isMotionSettled={isActive ? isMotionSettled : false}
              isTransitioning={isTransitioning}
              transitionDirection={transitionDirection}
            />
          </Suspense>
        </div>
      )
    })
  }, [mode, modesToRender, isMotionSettled, transitioningFrom, transitionDirection])

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden" style={{ background: 'transparent' }}>
      {modePanels}
    </div>
  )
}
