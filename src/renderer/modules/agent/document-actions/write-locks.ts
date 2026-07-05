import { useDocTabs } from '../../../stores/useDocTabs'
import type { DocActionDocumentIdentity, DocActionSaveState } from './types'

export const widgetWriteLocks = new Map<string, Promise<void>>()

const pendingToolDocumentWrites = new Map<string, {
  content: string
  baseContent: string
  action: string
  updatedAt: number
}>()

const RECENT_TOOL_TARGET_TTL_MS = 10 * 60 * 1000
let recentToolTargetTab: { tabId: string; updatedAt: number } | null = null

export function rememberPendingToolDocumentWrite(tabId: string, content: string, action: string, baseContent: string): void {
  if (!tabId) return
  pendingToolDocumentWrites.set(tabId, { content, baseContent, action, updatedAt: Date.now() })
  rememberToolTargetTab(tabId)
  rememberDocActionDocument(tabId)
}

export function getPendingToolDocumentWrite(tabId: string): {
  content: string
  baseContent: string
  action: string
  updatedAt: number
} | null {
  return pendingToolDocumentWrites.get(tabId) || null
}

export function clearPendingToolDocumentWrite(tabId: string): void {
  if (!tabId) return
  pendingToolDocumentWrites.delete(tabId)
}

export function rememberToolTargetTab(tabId: string): void {
  if (!tabId) return
  recentToolTargetTab = { tabId, updatedAt: Date.now() }
}

export function clearRecentToolTargetTab(tabId?: string): void {
  if (!recentToolTargetTab) return
  if (!tabId || recentToolTargetTab.tabId === tabId) recentToolTargetTab = null
}

// Per-tab epoch: bumped whenever a pending widget write for that tab should be
// treated as cancelled. runUpdate captures the epoch at enqueue time; before
// committing to the store it re-checks and bails if the epoch has advanced.
export const widgetWriteEpoch = new Map<string, number>()

export function cancelPendingWidgetWritesForTab(tabId: string): void {
  widgetWriteEpoch.set(tabId, (widgetWriteEpoch.get(tabId) || 0) + 1)
}

export function cancelAllPendingWidgetWrites(): void {
  for (const tabId of Array.from(widgetWriteEpoch.keys())) {
    widgetWriteEpoch.set(tabId, (widgetWriteEpoch.get(tabId) || 0) + 1)
  }
}

export function emitWidgetCommitted(tabId: string, widgetId: string | null | undefined): void {
  if (!tabId || !widgetId) return
  if (typeof window === 'undefined') return
  const api = (window as unknown as { electronAPI?: { document?: { notifyWidgetCommitted?: (payload: {
    tabId: string; widgetId: string; requestId?: string; committedAt: number
  }) => void } } }).electronAPI
  api?.document?.notifyWidgetCommitted?.({
    tabId,
    widgetId: String(widgetId),
    committedAt: Date.now(),
  })
}



let lastDocActionDocument: DocActionDocumentIdentity | null = null

export function resetLastDocActionDocument(): void {
  lastDocActionDocument = null
}

export function getLastDocActionDocument(): DocActionDocumentIdentity | null {
  return lastDocActionDocument
}

export function getFreshRecentToolTargetTab(): ReturnType<typeof useDocTabs.getState>['tabs'][number] | null {
  if (!recentToolTargetTab) return null
  if (Date.now() - recentToolTargetTab.updatedAt > RECENT_TOOL_TARGET_TTL_MS) {
    recentToolTargetTab = null
    return null
  }
  const store = useDocTabs.getState()
  const target = store.tabs.find((tab) => tab.id === recentToolTargetTab?.tabId)
  if (!target) recentToolTargetTab = null
  return target || null
}

function snapshotDocActionDocument(tabId?: string | null): DocActionDocumentIdentity | null {
  const id = typeof tabId === 'string' ? tabId.trim() : ''
  if (!id) return null
  const tab = useDocTabs.getState().tabs.find((item) => item.id === id)
  if (!tab) return null
  const saveState: DocActionSaveState = tab.path ? (tab.isDirty ? 'dirty' : 'saved') : 'unsaved'
  return {
    tabId: tab.id,
    title: tab.title,
    path: tab.path || null,
    dirty: Boolean(tab.isDirty),
    requiresSave: saveState !== 'saved',
    saveState,
  }
}

export function rememberDocActionDocument(tabId?: string | null): DocActionDocumentIdentity | null {
  const document = snapshotDocActionDocument(tabId)
  if (document) lastDocActionDocument = document
  return document
}
