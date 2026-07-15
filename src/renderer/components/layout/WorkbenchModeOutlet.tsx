import { lazy, memo, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { WorkbenchMode } from '../../stores/useMode'
import type { BrowserHostLayoutPhase } from '../../../shared/browser-view-layout'
import {
  shouldAnimateWorkbenchModeTransition,
  type WorkbenchModeChangePresentation,
} from '../../modules/workbench/mode-transition'

type ModeComponentProps = {
  isActive?: boolean
  isSuspended?: boolean
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
  suspended: boolean
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

type IdleCallbackHandle = ReturnType<Window['setTimeout']>
type IdleCallbackDeadline = { didTimeout: boolean; timeRemaining: () => number }
type IdleSchedulerWindow = Window & {
  requestIdleCallback?: (callback: (deadline: IdleCallbackDeadline) => void, options?: { timeout?: number }) => IdleCallbackHandle
  cancelIdleCallback?: (handle: IdleCallbackHandle) => void
}

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
  if (previous.suspended !== next.suspended) return false
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
  suspended,
}: ModeSceneProps) {
  const ModeComponent = MODE_COMPONENTS[modeKey]

  return (
    <div
      className="workbench-mode-scene"
      style={{
        pointerEvents: visualState === 'current' && !suspended ? 'auto' : 'none',
        visibility: suspended ? 'hidden' : 'visible',
      }}
      data-workbench-mode-panel={modeKey}
      data-mode-visual-state={visualState}
      data-mode-direction={direction}
      aria-hidden={!isActive || suspended}
    >
      <Suspense fallback={<ModeFallback />}>
        <ModeComponent
          isActive={isActive}
          isSuspended={suspended}
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
  transitionPresentation = 'animated',
  isMotionSettled = true,
  browserLayoutPhase = null,
  suspended = false,
}: {
  mode: WorkbenchMode
  mountedModes?: WorkbenchMode[]
  transitionPresentation?: WorkbenchModeChangePresentation
  isMotionSettled?: boolean
  browserLayoutPhase?: BrowserHostLayoutPhase | null
  suspended?: boolean
}) {
  const previousModeRef = useRef<WorkbenchMode>(mode)
  const [runtime, setRuntime] = useState<SceneRuntime>({
    current: mode,
    previous: null,
    direction: 'forward',
  })

  useEffect(() => {
    if (hasPreloadedWorkbenchModes) return

    const idleWindow = window as IdleSchedulerWindow
    let cancelled = false
    const preloadModes = () => {
      if (cancelled || hasPreloadedWorkbenchModes) return
      hasPreloadedWorkbenchModes = true
      ALL_MODE_LOADERS.forEach((loadMode) => {
        void loadMode()
      })
    }

    if (typeof idleWindow.requestIdleCallback === 'function') {
      const handle = idleWindow.requestIdleCallback(preloadModes, { timeout: 4_000 })
      return () => {
        cancelled = true
        idleWindow.cancelIdleCallback?.(handle)
      }
    }

    const timer = window.setTimeout(preloadModes, 1_500)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [])

  useLayoutEffect(() => {
    if (mode === previousModeRef.current) return
    const previousMode = previousModeRef.current
    previousModeRef.current = mode
    const prevIdx = ALL_WORKBENCH_MODES.indexOf(previousMode)
    const nextIdx = ALL_WORKBENCH_MODES.indexOf(mode)
    const direction: ModeDirection = nextIdx >= prevIdx ? 'forward' : 'backward'

    if (!shouldAnimateWorkbenchModeTransition(transitionPresentation, prefersReducedMotion())) {
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
  }, [mode, transitionPresentation])

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
            isActive={modeKey === runtime.current && !suspended}
            isMotionSettled={isMotionSettled}
            browserLayoutPhase={browserLayoutPhase}
            visualState={visualState}
            direction={runtime.direction}
            suspended={suspended}
          />
        )
      })}
    </div>
  )
}
