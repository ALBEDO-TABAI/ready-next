import { EASE, MOTION_MS } from '../../design/next/motion'

// A docked panel opening or closing (motion language M2): --rn-d-2 on the arrival curve, the columns' CSS width
// transition in flat-chrome.css; the assistant's content slides in with them by a short shift.
export const WORKBENCH_PANEL_MOTION_DURATION_MS = MOTION_MS.d2
export const WORKBENCH_PANEL_MOTION_DURATION_S = WORKBENCH_PANEL_MOTION_DURATION_MS / 1000
/** Under reduced motion the content only dissolves, over the feedback time. */
export const WORKBENCH_PANEL_REDUCED_MOTION_DURATION_MS = MOTION_MS.d1
export const WORKBENCH_PANEL_REDUCED_MOTION_DURATION_S = WORKBENCH_PANEL_REDUCED_MOTION_DURATION_MS / 1000
/** --rn-shift-2 */
export const WORKBENCH_PANEL_MOTION_OFFSET_PX = 8
export const WORKBENCH_PANEL_MOTION_EASE = EASE.out
