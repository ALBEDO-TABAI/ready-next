// Geometry source of truth for workbench chrome.
// Keep only dimensions and alignment numbers here; do not place visual colors or surface styling in this file.
// The shell sizes themselves live in shared/workbench-shell-geometry.ts (W2): rail 52, bands 52.
import { SHELL_BAND_HEIGHT, SHELL_RAIL_WIDTH } from '../../../shared/workbench-shell-geometry'

export const WORKBENCH_EDGE_RAIL_SIZE = SHELL_RAIL_WIDTH
export const WORKBENCH_EDGE_RAIL_SLOT_INSET_X = 8
export const WORKBENCH_EDGE_RAIL_SLOT_SIZE = WORKBENCH_EDGE_RAIL_SIZE - WORKBENCH_EDGE_RAIL_SLOT_INSET_X
export const WORKBENCH_EDGE_ICON_INSET = 14.5
export const WORKBENCH_TAB_ROW_HEIGHT = 38
export const WORKBENCH_TOOLBAR_ROW_HEIGHT = 38
export const WORKBENCH_TOPBAR_HEIGHT = SHELL_BAND_HEIGHT
export const WORKBENCH_STATUSBAR_HEIGHT = SHELL_BAND_HEIGHT
export const WORKBENCH_ROW_PADDING_X = 12
// The frame (V15): every mode's root pads its .workbench-canvas-shell by these, so the panel box is the same in all
// four modes — --rn-frame-gap (8px) below the top band and above the bottom band (y 60 to height − 60), 6px from the
// columns beside it. The assistant's composer sits on the panel's bottom edge through the same bottom value.
export const WORKBENCH_CANVAS_OUTER_PADDING_X = 6
export const WORKBENCH_CANVAS_OUTER_PADDING_TOP = 8
export const WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM = 8
// Keep mode headers aligned with the files panel header rail ("Connected" badge edge).
export const WORKBENCH_HEADER_EDGE_X = 14
// The main window is titleBarStyle 'hiddenInset' with the default light position: the traffic lights sit at x ≈ 20–72,
// centred in the 52px band. The band's sidebar switch starts 12px after them.
export const WORKBENCH_TOPBAR_PADDING_LEFT = 84
export const WORKBENCH_TOPBAR_PADDING_RIGHT = 14
export const WORKBENCH_TAB_MAX_WIDTH = 220
export const WORKBENCH_SUPPORT_PANEL_WIDTH = 300
