import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { WorkbenchMode } from '../../../stores/useMode'
import { WORKBENCH_MODE_SCENE_TRANSITION_MS } from '../mode-transition'

/** The rail's order of the modes (ShellRail), top to bottom. */
export const SHELL_RAIL_ORDER: readonly WorkbenchMode[] = ['browser', 'document', 'rss', 'calendar']

/** A navigator change in progress (V23): the mode whose navigator is leaving, and which way the rail moved. */
export interface ShellNavigatorMotion {
  from: WorkbenchMode
  /** down: the new mode is lower in the rail, so its navigator rises from below and the old one leaves upward. */
  direction: 'down' | 'up'
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Moves the sidebar's navigators vertically when the shown mode changes, in step with the content's scenes: the motion
 * lasts as long as theirs, then clears, and only then is the old navigator hidden. With `animate` off (an immediate
 * mode change, a collapsed sidebar) or reduced motion the change is instant.
 */
export function useNavigatorMotion(mode: WorkbenchMode, animate: boolean): ShellNavigatorMotion | null {
  const [motion, setMotion] = useState<ShellNavigatorMotion | null>(null)
  const shown = useRef(mode)
  const animateRef = useRef(animate)
  animateRef.current = animate
  // Before paint, so the old navigator never flashes hidden for a frame.
  useLayoutEffect(() => {
    const from = shown.current
    if (from === mode) return
    shown.current = mode
    if (!animateRef.current || prefersReducedMotion()) {
      setMotion(null)
      return
    }
    setMotion({ from, direction: SHELL_RAIL_ORDER.indexOf(mode) > SHELL_RAIL_ORDER.indexOf(from) ? 'down' : 'up' })
  }, [mode])
  useEffect(() => {
    if (!motion) return
    // As long as the scenes' transition (WorkbenchModeOutlet clears its own after the same time).
    const timer = window.setTimeout(() => setMotion(null), WORKBENCH_MODE_SCENE_TRANSITION_MS + 40)
    return () => window.clearTimeout(timer)
  }, [motion])
  return motion
}
