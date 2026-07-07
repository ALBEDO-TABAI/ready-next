// Contract for the vertical tab rail's hover flyout, rendered as a frameless child
// BrowserWindow (mirrors the FastCard / browser-lock overlays) so it can float over the live
// native BrowserView without hiding or dimming it.

import type { TabGroup, TabGroupColor } from './tab-groups'

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
  // Renderer-only grouping (main is unaware). null/absent = ungrouped. The tabs array
  // is the RAW FLAT order (D-SNAPSHOT) — the overlay does its own run-local split hoist,
  // so a command's toRank resolves against snapshot.tabs (flat), never the visual row.
  groupId?: string | null
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
  groups: TabGroup[]
  bounds: VerticalRailOverlayBounds
  scrollTop: number
}

export type VerticalRailOverlayCommand =
  | { type: 'hover-enter' }
  | { type: 'hover-leave' }
  | { type: 'switch'; tabId: string; shiftKey?: boolean }
  | { type: 'close'; tabId: string }
  | { type: 'new-tab' }
  // Reorder is id-based (D-CMD): toRank is a FLAT rank against snapshot.tabs; intoGroupId
  // sets/clears the moved tab's group by the drop geometry. The old index variant is gone.
  | { type: 'reorder'; movedTabId: string; toRank: number; intoGroupId: string | null }
  | { type: 'create-group'; draggedTabId: string; targetTabId: string }
  | { type: 'add-to-group'; tabId: string; groupId: string }
  | { type: 'remove-from-group'; tabId: string }
  | { type: 'rename-group'; groupId: string; name: string }
  | { type: 'recolor-group'; groupId: string; color: TabGroupColor }
  | { type: 'set-group-collapsed'; groupId: string; collapsed: boolean }
  | { type: 'disband-group'; groupId: string }
  | { type: 'delete-group'; groupId: string }
  | { type: 'new-tab-in-group'; groupId: string }
  | { type: 'toggle-bookmark'; tabId: string }
  | { type: 'reference'; tabId: string }
