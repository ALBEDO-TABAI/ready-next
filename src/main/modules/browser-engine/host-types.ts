import type { BrowserView, WebContentsView } from 'electron'
import type { BrowserBoundsSyncMode, BrowserViewBoundsUpdate } from '../../../shared/browser-view-layout'

export type BrowserHostKind = 'browserView' | 'webContentsView'
export type BrowserHostView = BrowserView | WebContentsView

export interface BrowserRect {
  x: number
  y: number
  width: number
  height: number
}

export type { BrowserBoundsSyncMode, BrowserViewBoundsUpdate }
