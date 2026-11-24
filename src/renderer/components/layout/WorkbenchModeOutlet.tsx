import { lazy, memo, Suspense, useEffect } from 'react'
import type { WorkbenchMode } from '../../stores/useMode'
import type { BrowserHostLayoutPhase } from '../../../shared/browser-view-layout'
import { shouldAnimateWorkbenchModeTransition, type WorkbenchModeChangePresentation } from '../../modules/workbench/mode-transition'
import { useSceneMotion, type SceneDirection, type SceneMotion } from '../../modules/workbench/scene-motion'
import { useNativeSurfaceAwareOverlay } from '../../modules/overlay/useNativeSurfaceAwareOverlay'

type ModeComponentProps = {
  isActive?: boolean
  isSceneVisible?: boolean
  isSuspended?: boolean
  isMotionSettled?: boolean
  browserLayoutPhase?: BrowserHostLayoutPhase | null
  layoutPhase?: BrowserHostLayoutPhase
}

type ModeVisualState = 'current' | 'entering' | 'leaving' | 'hidden'
type ModeDirection = SceneDirection

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
let hasPreloadedWorkbenchModes = false

type IdleCallbackHandle = ReturnType<Window['setTimeout']>
type IdleCallbackDeadline = { didTimeout: boolean; timeRemaining: () => number }
type IdleSchedulerWindow = Window & {
  requestIdleCallback?: (callback: (deadline: IdleCallbackDeadline) => void, options?: { timeout?: number }) => IdleCallbackHandle
  cancelIdleCallback?: (handle: IdleCallbackHandle) => void
}

// A mode that is still loading says so only if it takes a while: nothing for a beat, then a quiet fade in (motion
// language M2), so a quick first switch never flashes a word mid-slide.
function ModeFallback() {
  return (
    <div className="flex h-full items-center justify-center" style={{ background: 'transparent' }}>
      <span className="workbench-mode-fallback" style={{ color: 'var(--rn-ink-3)', fontSize: 13 }}>
        正在加载…
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
      // A scene on its way out is seen for a moment but takes no focus or keys.
      inert={visualState === 'leaving' || undefined}
    >
      <Suspense fallback={<ModeFallback />}>
        <ModeComponent
          isActive={isActive}
          isSceneVisible={visualState !== 'hidden' && !suspended}
          isSuspended={suspended}
          isMotionSettled={isActive ? isMotionSettled : false}
          browserLayoutPhase={modeKey === 'browser' ? browserLayoutPhase : null}
          layoutPhase={modeKey === 'browser' ? browserLayoutPhase ?? undefined : undefined}
        />
      </Suspense>
    </div>
  )
}, areModeScenePropsEqual)

function resolveVisualState(modeKey: WorkbenchMode, motion: SceneMotion<WorkbenchMode>): ModeVisualState {
  if (modeKey === motion.current) return motion.entering ? 'entering' : 'current'
  if (motion.leaving[modeKey]) return 'leaving'
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
  useNativeSurfaceAwareOverlay()
  // A change slides the new scene in from its side of the rail and the old one out the other way (motion language M2,
  // ritual-overlay.css); under reduced motion the shift token is 0 and the two only dissolve.
  const runtime = useSceneMotion(mode, { animate: shouldAnimateWorkbenchModeTransition(transitionPresentation), order: ALL_WORKBENCH_MODES })

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

  // The scenes' container clips only while a scene slides in or out (V22, flat-chrome.css): otherwise the panel's
  // shadow reaches past it.
  return (
    <div
      className="workbench-mode-outlet"
      data-mode-transition={runtime.entering || Object.keys(runtime.leaving).length ? 'true' : undefined}
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
            direction={runtime.leaving[modeKey] ?? runtime.direction}
            suspended={suspended}
          />
        )
      })}
    </div>
  )
}
