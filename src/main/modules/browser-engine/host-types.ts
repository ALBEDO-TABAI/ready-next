import type { WebContentsView } from 'electron'
import type { BrowserViewBoundsUpdate } from '../../../shared/browser-view-layout'

export const BROWSER_HOST_KIND = 'webContentsView' as const
export type BrowserHostKind = typeof BROWSER_HOST_KIND
export type BrowserHostView = WebContentsView

export interface BrowserRect {
  x: number
  y: number
  width: number
  height: number
}

export function parkedBrowserHostBounds(bounds: BrowserRect): BrowserRect {
  return {
    x: -100000,
    y: -100000,
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  }
}

export type { BrowserViewBoundsUpdate }
