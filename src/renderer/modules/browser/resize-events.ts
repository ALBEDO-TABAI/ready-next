export const PANEL_RESIZE_STATE_EVENT = 'ready:panel-resize-state'

export type PanelResizeReason = 'drag' | 'click-toggle'

export interface PanelResizeStateDetail {
  resizing: boolean
  reason: PanelResizeReason
}
