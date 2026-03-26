export const WORKBENCH_SLIDER_SPRING = {
  stiffness: 120,
  damping: 40,
  mass: 1.8,
} as const

export const WORKBENCH_SLIDER_FRAME_STEP = 0.016

export const WORKBENCH_SLIDER_MOTION_TRANSITION = {
  type: 'spring',
  ...WORKBENCH_SLIDER_SPRING,
} as const

export const REDUCED_MOTION_TRANSITION = { duration: 0.01 } as const
