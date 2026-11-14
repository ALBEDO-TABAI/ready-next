export const WORKBENCH_SLIDER_CLICK_DURATION_MS = 200

export const REDUCED_MOTION_TRANSITION = { duration: 0.01 } as const

export function easeWorkbenchSliderClick(progress: number): number {
  const clamped = Math.max(0, Math.min(1, progress))
  return 1 - Math.pow(1 - clamped, 3)
}

// Direct "click to switch" feel of the icon rail: a short ease-out tween, so the
// feedback tracks the click immediately.
export const WORKBENCH_SLIDER_CLICK_TRANSITION = {
  type: 'tween',
  duration: WORKBENCH_SLIDER_CLICK_DURATION_MS / 1000,
  ease: easeWorkbenchSliderClick,
} as const
