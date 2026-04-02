import type { BrowserTabDragPayload } from '../../components/layout/fileTreeBrowserTabDrop'

let activeBrowserTabDragPayload: BrowserTabDragPayload | null = null

export function beginBrowserTabDragSession(payload: BrowserTabDragPayload): void {
  activeBrowserTabDragPayload = { ...payload }
}

export function getActiveBrowserTabDragPayload(): BrowserTabDragPayload | null {
  if (!activeBrowserTabDragPayload) return null
  return { ...activeBrowserTabDragPayload }
}

export function endBrowserTabDragSession(): void {
  activeBrowserTabDragPayload = null
}
