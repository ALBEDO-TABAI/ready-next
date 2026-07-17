import type { BrowserLockOverlayBounds } from './browser-lock-overlay'

export type BrowserAgentPointerPhase = 'move' | 'press' | 'release' | 'scroll' | 'drag' | 'focus'

export interface BrowserAgentPointerSnapshot {
  revision: number
  tabId: string
  phase: BrowserAgentPointerPhase
  x: number
  y: number
  bounds: BrowserLockOverlayBounds
  occurredAt: number
}

export function mapBrowserAgentPointerToOverlay(params: {
  x: number
  y: number
  bounds: BrowserLockOverlayBounds
  pageZoomFactor?: number
  displayScaleFactor?: number
}): { x: number; y: number } {
  const zoom = Number.isFinite(params.pageZoomFactor)
    ? Math.max(0.25, Math.min(5, Number(params.pageZoomFactor)))
    : 1
  // Electron window bounds and child-window coordinates are already in DIP.
  // Retina scale therefore must not be applied a second time. Browser page
  // zoom is different: CDP input coordinates are page CSS pixels and must be
  // mapped into the rendered BrowserView's DIP surface.
  void params.displayScaleFactor
  return {
    x: Math.max(0, Math.min(params.bounds.width, params.x * zoom)),
    y: Math.max(0, Math.min(params.bounds.height, params.y * zoom)),
  }
}
