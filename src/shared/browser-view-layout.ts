export type BrowserBoundsSyncMode = 'transient' | 'settled'

export type BrowserHostLayoutPhase = 'idle' | 'entering' | 'leaving' | 'dragging'

export interface BrowserViewRect {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserViewBoundsUpdate {
  x: number
  y: number
  width: number
  height: number
  tabId?: string | null
  secondaryTabId?: string | null
  secondaryBounds?: BrowserViewRect | null
  syncMode?: BrowserBoundsSyncMode
}
