import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { WorkbenchMode } from '../../stores/useMode'
import type { BrowserHostLayoutPhase } from '../../../shared/browser-view-layout'

type ModeComponentProps = {
  isActive?: boolean
  isMotionSettled?: boolean
  browserLayoutPhase?: BrowserHostLayoutPhase | null
  layoutPhase?: BrowserHostLayoutPhase
}

type ModeVisualState = 'current' | 'entering' | 'leaving' | 'hidden'
type TransitionStage = 'settled' | 'preparing' | 'animating' | 'finishing'

interface ModeTransitionState {
  activeMode: WorkbenchMode
  leavingMode: WorkbenchMode | null
  direction: -1 | 0 | 1
  stage: TransitionStage
}

interface ModeSceneProps {
  modeKey: WorkbenchMode
  visualState: ModeVisualState
  transitionStage: TransitionStage
  direction: -1 | 0 | 1
  isMotionSettled: boolean
  browserLayoutPhase: BrowserHostLayoutPhase | null
  onLeavingTransformEnd?: () => void
}

const MODE_SCENE_TRANSITION = 'transform 0.35s cubic-bezier(0.24, 1, 0.36, 1), opacity 0.32s ease-out'
const MODE_LEAVING_OFFSET_PERCENT = 32
const MODE_ENTERING_OFFSET_PERCENT = 32
const MODE_LEAVING_FADE_OPACITY = 0.4
const MODE_FINISHING_SAFETY_MS = 420

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

function resolveModeDirection(from: WorkbenchMode, to: WorkbenchMode): -1 | 0 | 1 {
  const fromIndex = ALL_WORKBENCH_MODES.indexOf(from)
  const toIndex = ALL_WORKBENCH_MODES.indexOf(to)
  if (fromIndex === toIndex) return 0
  return toIndex > fromIndex ? 1 : -1
}

function resolveModeVisualState(
  modeKey: WorkbenchMode,
  transitionState: ModeTransitionState,
): ModeVisualState {
  if (modeKey === transitionState.activeMode) {
    if (transitionState.leavingMode && transitionState.stage !== 'settled') {
      return 'entering'
    }
    return 'current'
  }

  if (modeKey === transitionState.leavingMode && transitionState.stage !== 'settled') {
    return 'leaving'
  }

  return 'hidden'
}

function resolveSceneTransform(
  visualState: ModeVisualState,
  transitionStage: TransitionStage,
  direction: -1 | 0 | 1,
): string {
  if (visualState === 'hidden' || visualState === 'current') {
    return 'translate3d(0, 0, 0)'
  }

  if (visualState === 'entering') {
    if (transitionStage === 'preparing') {
      const offset = MODE_ENTERING_OFFSET_PERCENT
      return direction > 0 ? `translate3d(${offset}%, 0, 0)` : `translate3d(-${offset}%, 0, 0)`
    }
    return 'translate3d(0, 0, 0)'
  }

  if (transitionStage === 'preparing') {
    return 'translate3d(0, 0, 0)'
  }

  const offset = MODE_LEAVING_OFFSET_PERCENT
  return direction > 0 ? `translate3d(-${offset}%, 0, 0)` : `translate3d(${offset}%, 0, 0)`
}

function resolveSceneOpacity(visualState: ModeVisualState, transitionStage: TransitionStage): number {
  if (visualState === 'hidden') return 0
  if (visualState === 'leaving' && (transitionStage === 'animating' || transitionStage === 'finishing')) {
    return MODE_LEAVING_FADE_OPACITY
  }
  return 1
}

function ModeFallback({ mode }: { mode: WorkbenchMode }) {
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
    previous.visualState === next.visualState
    && previous.transitionStage === next.transitionStage
    && previous.direction === next.direction
    && previous.isMotionSettled === next.isMotionSettled
    && previous.browserLayoutPhase === next.browserLayoutPhase
    && previous.onLeavingTransformEnd === next.onLeavingTransformEnd
  )
}

const ModeScene = memo(function ModeScene({
  modeKey,
  visualState,
  transitionStage,
  direction,
  isMotionSettled,
  browserLayoutPhase,
  onLeavingTransformEnd,
}: ModeSceneProps) {
  const ModeComponent = MODE_COMPONENTS[modeKey]
  const isVisible = visualState !== 'hidden'
  const isInteractive = visualState === 'current' || visualState === 'entering'
  const isTransitioning = transitionStage !== 'settled' && visualState !== 'hidden'

  const handleTransitionEnd = visualState === 'leaving' && onLeavingTransformEnd
    ? (event: React.TransitionEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget) return
        if (event.propertyName !== 'transform') return
        onLeavingTransformEnd()
      }
    : undefined

  return (
    <div
      className="absolute inset-0 overflow-hidden"
      style={{
        display: isVisible ? 'block' : 'none',
        pointerEvents: isInteractive ? 'auto' : 'none',
        transform: resolveSceneTransform(visualState, transitionStage, direction),
        opacity: resolveSceneOpacity(visualState, transitionStage),
        transition: isTransitioning ? MODE_SCENE_TRANSITION : 'none',
        willChange: isTransitioning ? 'transform, opacity' : 'auto',
      }}
      data-workbench-mode-panel={modeKey}
      data-mode-visual-state={visualState}
      data-mode-transition-stage={transitionStage}
      aria-hidden={!isInteractive}
      onTransitionEnd={handleTransitionEnd}
    >
      <Suspense fallback={<ModeFallback mode={modeKey} />}>
        <ModeComponent
          isActive={visualState === 'current' || visualState === 'entering'}
          isMotionSettled={visualState === 'current' ? isMotionSettled : false}
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
  const previousModeRef = useRef(mode)
  const prepareAnimationFrameRef = useRef<number | null>(null)
  const finishingSafetyTimerRef = useRef<number | null>(null)
  const [transitionState, setTransitionState] = useState<ModeTransitionState>({
    activeMode: mode,
    leavingMode: null,
    direction: 0,
    stage: 'settled',
  })

  useEffect(() => {
    if (hasPreloadedWorkbenchModes) return
    hasPreloadedWorkbenchModes = true
    ALL_MODE_LOADERS.forEach((loadMode) => {
      void loadMode()
    })
  }, [])

  useEffect(() => {
    if (mode === previousModeRef.current) return

    setTransitionState({
      activeMode: mode,
      leavingMode: previousModeRef.current,
      direction: resolveModeDirection(previousModeRef.current, mode),
      stage: 'preparing',
    })
    previousModeRef.current = mode
  }, [mode])

  useEffect(() => {
    if (prepareAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(prepareAnimationFrameRef.current)
      prepareAnimationFrameRef.current = null
    }

    if (transitionState.stage !== 'preparing') return

    prepareAnimationFrameRef.current = window.requestAnimationFrame(() => {
      prepareAnimationFrameRef.current = null
      setTransitionState((previous) => {
        if (previous.stage !== 'preparing') return previous
        return {
          ...previous,
          stage: 'animating',
        }
      })
    })

    return () => {
      if (prepareAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(prepareAnimationFrameRef.current)
        prepareAnimationFrameRef.current = null
      }
    }
  }, [transitionState.stage])

  useEffect(() => {
    if (finishingSafetyTimerRef.current !== null) {
      window.clearTimeout(finishingSafetyTimerRef.current)
      finishingSafetyTimerRef.current = null
    }

    if (transitionState.stage !== 'animating' && transitionState.stage !== 'finishing') return

    finishingSafetyTimerRef.current = window.setTimeout(() => {
      finishingSafetyTimerRef.current = null
      setTransitionState((previous) => {
        if (previous.stage === 'settled') return previous
        return {
          activeMode: previous.activeMode,
          leavingMode: null,
          direction: 0,
          stage: 'settled',
        }
      })
    }, MODE_FINISHING_SAFETY_MS)

    return () => {
      if (finishingSafetyTimerRef.current !== null) {
        window.clearTimeout(finishingSafetyTimerRef.current)
        finishingSafetyTimerRef.current = null
      }
    }
  }, [transitionState.stage])

  const handleLeavingTransformEnd = useCallback(() => {
    setTransitionState((previous) => {
      if (previous.stage === 'settled') return previous
      return {
        activeMode: previous.activeMode,
        leavingMode: null,
        direction: 0,
        stage: 'settled',
      }
    })
  }, [])

  useEffect(() => {
    if (!isMotionSettled) return
    if (transitionState.stage !== 'settled' && transitionState.leavingMode !== null) return

    setTransitionState((previous) => {
      if (previous.leavingMode === null && previous.stage === 'settled') {
        return previous
      }

      return {
        activeMode: previous.activeMode,
        leavingMode: null,
        direction: 0,
        stage: 'settled',
      }
    })
  }, [isMotionSettled, transitionState.stage, transitionState.leavingMode])

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{
        background: 'transparent',
      }}
    >
      {ALL_WORKBENCH_MODES.map((modeKey) => {
        const visualState = resolveModeVisualState(modeKey, transitionState)

        return (
          <ModeScene
            key={modeKey}
            modeKey={modeKey}
            visualState={visualState}
            transitionStage={transitionState.stage}
            direction={transitionState.direction}
            isMotionSettled={isMotionSettled}
            browserLayoutPhase={browserLayoutPhase}
            onLeavingTransformEnd={handleLeavingTransformEnd}
          />
        )
      })}
    </div>
  )
}
