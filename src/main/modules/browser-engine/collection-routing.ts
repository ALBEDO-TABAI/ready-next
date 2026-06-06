import type { AgentBrowserSurface } from './agent-browser-errors'
import { isHighControlPlatformText } from '../../../shared/browser-collection-intent'

export interface BrowserCollectionExecutionTarget {
  tabId: string
  surface: AgentBrowserSurface
  usesVisibleTab: boolean
}

function isUsableTabId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function resolveHighControlCollectionTarget(params: {
  highControl: boolean
  requestedTabId?: string | null
  activeTabId?: string | null
  activeTabUrl?: string | null
}): BrowserCollectionExecutionTarget | null {
  if (!params.highControl) return null
  if (isUsableTabId(params.requestedTabId)) {
    return { tabId: params.requestedTabId.trim(), surface: 'user-view', usesVisibleTab: true }
  }
  const activeTabId = isUsableTabId(params.activeTabId) ? params.activeTabId.trim() : ''
  if (!activeTabId) return null
  const activeTabUrl = typeof params.activeTabUrl === 'string' ? params.activeTabUrl : ''
  if (!isHighControlPlatformText(activeTabUrl)) return null
  return { tabId: activeTabId, surface: 'user-view', usesVisibleTab: true }
}

export function resolveSourceCollectionTarget(params: {
  highControl: boolean
  sourcePayload: Record<string, unknown> | null
}): BrowserCollectionExecutionTarget | null {
  if (!params.highControl || !params.sourcePayload) return null
  const sourceTabId = isUsableTabId(params.sourcePayload.tabId) ? params.sourcePayload.tabId.trim() : ''
  if (!sourceTabId) return null
  const sourceSurface = params.sourcePayload.surface === 'user-view' ? 'user-view' : null
  if (!sourceSurface) return null
  return { tabId: sourceTabId, surface: sourceSurface, usesVisibleTab: true }
}
