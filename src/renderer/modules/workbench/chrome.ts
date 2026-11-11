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
export const WORKBENCH_CANVAS_OUTER_PADDING_X = 6
export const WORKBENCH_CANVAS_OUTER_PADDING_TOP = 6
export const WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM = 10
// Keep mode headers aligned with the files panel header rail ("Connected" badge edge).
export const WORKBENCH_HEADER_EDGE_X = 14
export const WORKBENCH_TOPBAR_PADDING_LEFT = 60
export const WORKBENCH_TOPBAR_PADDING_RIGHT = 14
export const WORKBENCH_TAB_MAX_WIDTH = 220
export const WORKBENCH_SUPPORT_PANEL_WIDTH = 300
