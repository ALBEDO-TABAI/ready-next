import type { AgentBrowserSurface } from './agent-browser-errors'
import type { BrowserWriteLeaseService } from './browser-write-lease'

export interface BrowserInputSignalLike {
  type?: string
}

export function isUserViewKeyboardTakeoverInput(input: BrowserInputSignalLike): boolean {
  return input.type === 'keyDown' || input.type === 'char'
}

export function shouldRecordUserViewTabSwitch(params: {
  previousActiveTabId: string | null
  nextActiveTabId: string
  leaseTabId: string | null
}): boolean {
  return Boolean(
    params.previousActiveTabId
      && params.leaseTabId
      && params.previousActiveTabId === params.leaseTabId
      && params.nextActiveTabId !== params.leaseTabId,
  )
}

export function recordUserViewTakeoverSignal(params: {
  service: BrowserWriteLeaseService
  activeTabId: string | null
  signalTabId: string | null
  surface?: AgentBrowserSurface
  source: 'keyboard' | 'tab-switch' | 'explicit-button'
}): boolean {
  const surface = params.surface ?? 'user-view'
  if (surface !== 'user-view') return false
  if (params.signalTabId && params.activeTabId !== params.signalTabId) return false
  return params.service.recordUserSignal({ surface: 'user-view', source: params.source })
}
