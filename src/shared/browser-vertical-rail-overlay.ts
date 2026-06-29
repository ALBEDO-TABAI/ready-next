// Contract for the vertical tab rail's hover flyout, rendered as a frameless child
// BrowserWindow (mirrors the FastCard / browser-lock overlays) so it can float over the live
// native BrowserView without hiding or dimming it.

export interface VerticalRailOverlayTab {
  id: string
  title: string
  domain: string
  url: string
  favicon?: string
  active: boolean
  split: boolean
  loading: boolean
  owner?: 'manual' | 'agent'
  activity?: 'idle' | 'running' | 'attention'
  required?: boolean
  bookmarked: boolean
}

// Window-content-relative rect of the rail (left edge of the content band, full height).
// The main side adds the window's content origin to place the overlay on screen.
export interface VerticalRailOverlayBounds {
  left: number
  top: number
  width: number
  height: number
}

export interface VerticalRailOverlaySnapshot {
  tabs: VerticalRailOverlayTab[]
  bounds: VerticalRailOverlayBounds
  scrollTop: number
}

export type VerticalRailOverlayCommand =
  | { type: 'hover-enter' }
  | { type: 'hover-leave' }
  | { type: 'switch'; tabId: string; shiftKey?: boolean }
  | { type: 'close'; tabId: string }
  | { type: 'new-tab' }
  | { type: 'reorder'; fromIndex: number; toIndex: number }
  | { type: 'toggle-bookmark'; tabId: string }
  | { type: 'reference'; tabId: string }
