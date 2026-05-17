import type { BrowserTabDragPayload } from '../../components/layout/fileTreeExternalDrop'

/**
 * Defensive TTL for the browser-tab drag session global. TabRail's
 * `onDragEnd` handler clears state on normal drag end, but does not fire
 * if the tab is closed or re-rendered mid-drag. Without a TTL, a leaked
 * payload would surface on subsequent unrelated drags via the fallback in
 * `FileTree.getExternalDropPayload`, incorrectly opening the drop menu.
 * 60 seconds is well beyond any realistic drag duration.
 */
const BROWSER_TAB_DRAG_TTL_MS = 60_000

interface ActiveBrowserTabDragRecord {
  payload: BrowserTabDragPayload
  createdAt: number
}

let activeBrowserTabDragRecord: ActiveBrowserTabDragRecord | null = null

export function beginBrowserTabDragSession(payload: BrowserTabDragPayload): void {
  activeBrowserTabDragRecord = { payload: { ...payload }, createdAt: Date.now() }
}

export function getActiveBrowserTabDragPayload(): BrowserTabDragPayload | null {
  if (!activeBrowserTabDragRecord) return null
  if (Date.now() - activeBrowserTabDragRecord.createdAt > BROWSER_TAB_DRAG_TTL_MS) {
    activeBrowserTabDragRecord = null
    return null
  }
  return { ...activeBrowserTabDragRecord.payload }
}

export function endBrowserTabDragSession(): void {
  activeBrowserTabDragRecord = null
}

/** Test-only: probe whether the TTL has cleared the session. */
export function __browserTabDragSessionAgeMs(): number | null {
  return activeBrowserTabDragRecord ? Date.now() - activeBrowserTabDragRecord.createdAt : null
}
