import { create } from 'zustand'

export type RitualStage = 'mode-switch' | 'theme-transition'
export type RitualPhase = 'idle' | 'entering' | 'holding' | 'leaving'
export type RitualDirection = 'to-dark' | 'to-light' | null

export interface RitualTimelineConfig {
  enterDurationMs: number
  holdingMinDurationMs: number
  leaveDurationMs: number
}

export interface RitualMeta {
  direction?: RitualDirection
}

export interface RitualSession {
  id: number
  stage: RitualStage
  phase: RitualPhase
  startedAt: number
  reduceMotion: boolean
  timeline: RitualTimelineConfig
  meta: RitualMeta
}

interface RitualOverlayState {
  session: RitualSession | null
  _setSession: (session: RitualSession | null) => void
  _setPhase: (id: number, phase: RitualPhase) => void
  _setMeta: (id: number, meta: RitualMeta) => void
}

export const useRitualOverlayStore = create<RitualOverlayState>((set) => ({
  session: null,
  _setSession: (session) => set({ session }),
  _setPhase: (id, phase) => set((state) => {
    if (!state.session || state.session.id !== id) return state
    return { session: { ...state.session, phase } }
  }),
  _setMeta: (id, meta) => set((state) => {
    if (!state.session || state.session.id !== id) return state
    return { session: { ...state.session, meta: { ...state.session.meta, ...meta } } }
  }),
}))

const MODE_SWITCH_TIMELINE: RitualTimelineConfig = {
  enterDurationMs: 120,
  holdingMinDurationMs: 100,
  leaveDurationMs: 100,
}

const THEME_TRANSITION_TIMELINE: RitualTimelineConfig = {
  enterDurationMs: 180,
  holdingMinDurationMs: 320,
  leaveDurationMs: 900,
}

export const THEME_TRANSITION_ENTER_DURATION_MS = THEME_TRANSITION_TIMELINE.enterDurationMs
export const THEME_HOLD_DURATION_MS = THEME_TRANSITION_TIMELINE.holdingMinDurationMs
export const THEME_TRANSITION_LEAVE_DURATION_MS = THEME_TRANSITION_TIMELINE.leaveDurationMs

const REDUCE_MOTION_FLASH_MS = 80

let sessionCounter = 0
let currentAbortController: AbortController | null = null
let currentCleanup: (() => void) | null = null
let panelResizingActive = false

export function setPanelResizingSignal(resizing: boolean): void {
  panelResizingActive = resizing
}

// True when the ritual engine would skip animation entirely (panel-resize in progress,
// or the user prefers reduced motion). Callers that own DOM mutations wrapped in a ritual
// should check this first and mutate synchronously instead of entering withRitual — because
// the bypass paths don't coordinate phase hooks and can leave DOM vs store out of sync.
export function isRitualBypassActive(): boolean {
  if (panelResizingActive) return true
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export function cancelRitual(stage?: RitualStage): void {
  const currentStage = useRitualOverlayStore.getState().session?.stage
  if (stage && currentStage !== stage) return
  currentAbortController?.abort()
  if (currentCleanup) {
    try { currentCleanup() } catch { /* ignore */ }
  }
}

const resolveTimeline = (stage: RitualStage): RitualTimelineConfig =>
  stage === 'theme-transition' ? THEME_TRANSITION_TIMELINE : MODE_SWITCH_TIMELINE

const prefersReducedMotion = (): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

const waitFor = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) { resolve(); return }
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      window.clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      resolve()
      return
    }
    window.requestAnimationFrame(() => resolve())
  })

const runReduceMotionFlash = (stage: RitualStage) => {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.setAttribute('data-ritual-reduce-flash', stage)
  window.setTimeout(() => {
    if (root.getAttribute('data-ritual-reduce-flash') === stage) {
      root.removeAttribute('data-ritual-reduce-flash')
    }
  }, REDUCE_MOTION_FLASH_MS)
}

export interface WithRitualArgs {
  signalReady: () => void
  abortSignal: AbortSignal
  setMeta: (meta: RitualMeta) => void
}

export async function withRitual<T>(
  stage: RitualStage,
  workFn: (args: WithRitualArgs) => Promise<T> | T,
  options: { meta?: RitualMeta } = {},
): Promise<T> {
  if (panelResizingActive) {
    const noopAbort = new AbortController()
    const args: WithRitualArgs = {
      signalReady: () => undefined,
      abortSignal: noopAbort.signal,
      setMeta: () => undefined,
    }
    return await workFn(args)
  }

  if (currentAbortController) {
    currentAbortController.abort()
  }
  if (currentCleanup) {
    try { currentCleanup() } catch { /* ignore */ }
    currentCleanup = null
  }

  const id = ++sessionCounter
  const abortController = new AbortController()
  currentAbortController = abortController

  const reduceMotion = prefersReducedMotion()
  const timeline = resolveTimeline(stage)

  const store = useRitualOverlayStore

  const cleanup = () => {
    if (currentAbortController === abortController) {
      currentAbortController = null
    }
    if (currentCleanup === cleanup) {
      currentCleanup = null
    }
    const current = store.getState().session
    if (current && current.id === id) {
      store.getState()._setSession(null)
    }
  }
  currentCleanup = cleanup

  if (reduceMotion) {
    runReduceMotionFlash(stage)
    let readyFired = false
    const args: WithRitualArgs = {
      signalReady: () => { readyFired = true },
      abortSignal: abortController.signal,
      setMeta: () => undefined,
    }
    try {
      const result = await workFn(args)
      void readyFired
      return result
    } finally {
      cleanup()
    }
  }

  store.getState()._setSession({
    id,
    stage,
    phase: 'entering',
    startedAt: Date.now(),
    reduceMotion: false,
    timeline,
    meta: options.meta ?? {},
  })

  let readyResolve: () => void = () => undefined
  const readyPromise = new Promise<void>((resolve) => { readyResolve = resolve })
  let readyFired = false
  const args: WithRitualArgs = {
    signalReady: () => {
      if (readyFired) return
      readyFired = true
      readyResolve()
    },
    abortSignal: abortController.signal,
    setMeta: (meta) => store.getState()._setMeta(id, meta),
  }

  try {
    await waitFor(timeline.enterDurationMs, abortController.signal)
    if (abortController.signal.aborted) {
      cleanup()
      throw new DOMException('ritual aborted', 'AbortError')
    }

    store.getState()._setPhase(id, 'holding')
    await nextFrame()

    const holdingStart = Date.now()
    const workPromise = Promise.resolve().then(() => workFn(args))

    await Promise.race([
      readyPromise,
      workPromise.catch(() => undefined),
    ])

    const holdingElapsed = Date.now() - holdingStart
    const remainingHold = Math.max(0, timeline.holdingMinDurationMs - holdingElapsed)
    if (remainingHold > 0) {
      await waitFor(remainingHold, abortController.signal)
    }

    let result: T
    try {
      result = await workPromise
    } catch (error) {
      store.getState()._setPhase(id, 'leaving')
      await waitFor(timeline.leaveDurationMs, abortController.signal)
      cleanup()
      throw error
    }

    if (abortController.signal.aborted) {
      cleanup()
      throw new DOMException('ritual aborted', 'AbortError')
    }

    store.getState()._setPhase(id, 'leaving')
    await waitFor(timeline.leaveDurationMs, abortController.signal)
    cleanup()
    return result
  } catch (error) {
    cleanup()
    throw error
  }
}

export const __testing__ = {
  resetRitualOverlay: () => {
    if (currentAbortController) {
      currentAbortController.abort()
      currentAbortController = null
    }
    currentCleanup = null
    sessionCounter = 0
    panelResizingActive = false
    useRitualOverlayStore.getState()._setSession(null)
  },
  getPanelResizingSignal: () => panelResizingActive,
}
