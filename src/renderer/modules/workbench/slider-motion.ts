export const WORKBENCH_SLIDER_SPRING = {
  stiffness: 120,
  damping: 40,
  mass: 1.8,
} as const

export const WORKBENCH_SLIDER_FRAME_STEP = 0.016
export const WORKBENCH_SLIDER_CLICK_DURATION_MS = 200

export const WORKBENCH_SLIDER_MOTION_TRANSITION = {
  type: 'spring',
  ...WORKBENCH_SLIDER_SPRING,
} as const

export const REDUCED_MOTION_TRANSITION = { duration: 0.01 } as const

export function easeWorkbenchSliderClick(progress: number): number {
  const clamped = Math.max(0, Math.min(1, progress))
  return 1 - Math.pow(1 - clamped, 3)
}

// Direct "click to switch" feel shared with the mode slider: a short ease-out
// tween (not the heavy drag spring), so the thumb tracks the click immediately
// instead of lagging behind the icon-color swap.
export const WORKBENCH_SLIDER_CLICK_TRANSITION = {
  type: 'tween',
  duration: WORKBENCH_SLIDER_CLICK_DURATION_MS / 1000,
  ease: easeWorkbenchSliderClick,
} as const
