export type BrowserBoundsSyncMode = 'transient' | 'settled'

export type BrowserHostLayoutPhase = 'idle' | 'entering' | 'leaving' | 'dragging'

export interface BrowserViewBoundsUpdate {
  x: number
  y: number
  width: number
  height: number
  syncMode?: BrowserBoundsSyncMode
}
