import { EASE, MOTION_MS, REDUCED_TRANSITION } from '../../design/next/motion'

export const WORKBENCH_SLIDER_CLICK_DURATION_MS = MOTION_MS.d2

export const REDUCED_MOTION_TRANSITION = REDUCED_TRANSITION

// Direct "click to switch" feel of the icon rail: the selection moves on the arrival curve over --rn-d-2, so the
// feedback tracks the click immediately (motion language M2).
export const WORKBENCH_SLIDER_CLICK_TRANSITION = {
  type: 'tween',
  duration: WORKBENCH_SLIDER_CLICK_DURATION_MS / 1000,
  ease: EASE.out,
} as const
