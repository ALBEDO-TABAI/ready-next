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

export type { BrowserViewBoundsUpdate }

export interface PreviewTabState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error?: string
}

export function createDefaultPreviewState(): PreviewTabState {
  return {
    url: '',
    title: 'Preview',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  }
}
