export type BrowserHostPresentationAction = 'skip' | 'hide' | 'show' | 'sync-bounds'

export interface BrowserHostPresentationInput {
  shouldPresentBrowserHost: boolean
  shouldRevealBrowserHost: boolean
  canShowBrowserHost: boolean
  browserRuntimeReady: boolean
  tabCount: number
  activeTabId: string | null
  splitTabId: string | null
  hostAlreadyPresented: boolean
}

export interface BrowserHostPresentationPlan {
  action: BrowserHostPresentationAction
  fitActiveTabId: string | null
  fitSplitTabId: string | null
}

export function planBrowserHostPresentation(input: BrowserHostPresentationInput): BrowserHostPresentationPlan {
  if (!input.shouldPresentBrowserHost || !input.shouldRevealBrowserHost) {
    return { action: 'skip', fitActiveTabId: null, fitSplitTabId: null }
  }

  if (!input.canShowBrowserHost || !input.browserRuntimeReady || input.tabCount === 0 || !input.activeTabId) {
    return { action: 'hide', fitActiveTabId: null, fitSplitTabId: null }
  }

  return {
    action: input.hostAlreadyPresented ? 'sync-bounds' : 'show',
    fitActiveTabId: input.activeTabId,
    fitSplitTabId: input.splitTabId && input.splitTabId !== input.activeTabId ? input.splitTabId : null,
  }
}
