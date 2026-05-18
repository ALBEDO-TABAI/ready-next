import { lazy, memo, Suspense, useLayoutEffect, useRef, useState } from 'react'
import type { WorkbenchMode } from '../../stores/useMode'
import type { BrowserHostLayoutPhase } from '../../../shared/browser-view-layout'

type ModeComponentProps = {
  isActive?: boolean
  isMotionSettled?: boolean
  browserLayoutPhase?: BrowserHostLayoutPhase | null
  layoutPhase?: BrowserHostLayoutPhase
}

type ModeVisualState = 'current' | 'entering' | 'leaving' | 'hidden'
type ModeDirection = 'forward' | 'backward'

interface ModeSceneProps {
  modeKey: WorkbenchMode
  isActive: boolean
  isMotionSettled: boolean
  browserLayoutPhase: BrowserHostLayoutPhase | null
  visualState: ModeVisualState
  direction: ModeDirection
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
const MODE_SCENE_TRANSITION_MS = 280
let hasPreloadedWorkbenchModes = false

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

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
  if (previous.visualState === 'hidden' && next.visualState === 'hidden') return true
  return (
    previous.isActive === next.isActive
    && previous.isMotionSettled === next.isMotionSettled
    && previous.browserLayoutPhase === next.browserLayoutPhase
    && previous.visualState === next.visualState
    && previous.direction === next.direction
  )
}

const ModeScene = memo(function ModeScene({
  modeKey,
  isActive,
  isMotionSettled,
  browserLayoutPhase,
  visualState,
  direction,
}: ModeSceneProps) {
  const ModeComponent = MODE_COMPONENTS[modeKey]

  return (
    <div
      className="workbench-mode-scene"
      style={{
        pointerEvents: visualState === 'current' ? 'auto' : 'none',
      }}
      data-workbench-mode-panel={modeKey}
      data-mode-visual-state={visualState}
      data-mode-direction={direction}
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

interface SceneRuntime {
  current: WorkbenchMode
  previous: WorkbenchMode | null
  direction: ModeDirection
}

function resolveVisualState(
  modeKey: WorkbenchMode,
  runtime: SceneRuntime,
): ModeVisualState {
  if (modeKey === runtime.current) {
    return runtime.previous ? 'entering' : 'current'
  }
  if (modeKey === runtime.previous) return 'leaving'
  return 'hidden'
}

export default function WorkbenchModeOutlet({
  mode,
  mountedModes = ALL_WORKBENCH_MODES,
  isMotionSettled = true,
  browserLayoutPhase = null,
}: {
  mode: WorkbenchMode
  mountedModes?: WorkbenchMode[]
  isMotionSettled?: boolean
  browserLayoutPhase?: BrowserHostLayoutPhase | null
}) {
  const previousModeRef = useRef<WorkbenchMode>(mode)
  const [runtime, setRuntime] = useState<SceneRuntime>({
    current: mode,
    previous: null,
    direction: 'forward',
  })

  useLayoutEffect(() => {
    if (hasPreloadedWorkbenchModes) return
    hasPreloadedWorkbenchModes = true
    ALL_MODE_LOADERS.forEach((loadMode) => {
      void loadMode()
    })
  }, [])

  useLayoutEffect(() => {
    if (mode === previousModeRef.current) return
    const previousMode = previousModeRef.current
    previousModeRef.current = mode
    const prevIdx = ALL_WORKBENCH_MODES.indexOf(previousMode)
    const nextIdx = ALL_WORKBENCH_MODES.indexOf(mode)
    const direction: ModeDirection = nextIdx >= prevIdx ? 'forward' : 'backward'

    if (prefersReducedMotion()) {
      setRuntime({ current: mode, previous: null, direction })
      return
    }

    setRuntime({ current: mode, previous: previousMode, direction })
    const timer = window.setTimeout(() => {
      setRuntime((prev) => (prev.current === mode ? { ...prev, previous: null } : prev))
    }, MODE_SCENE_TRANSITION_MS + 40)

    return () => {
      window.clearTimeout(timer)
    }
  }, [mode])

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{
        background: 'transparent',
      }}
    >
      {mountedModes.map((modeKey) => {
        const visualState = resolveVisualState(modeKey, runtime)
        return (
          <ModeScene
            key={modeKey}
            modeKey={modeKey}
            isActive={modeKey === runtime.current}
            isMotionSettled={isMotionSettled}
            browserLayoutPhase={browserLayoutPhase}
            visualState={visualState}
            direction={runtime.direction}
          />
        )
      })}
    </div>
  )
}
