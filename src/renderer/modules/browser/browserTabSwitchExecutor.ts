import type { BrowserTab } from '../../stores/useBrowserTabs'
import { DEFAULT_BROWSER_URL } from './url-utils'
import type { BrowserTabActivationSequencer } from './browserTabActivationSequencer'

export interface BrowserTabSwitchExecutorResult {
  success: boolean
  url?: string
  title?: string
  domain?: string
  favicon?: string | null
  owner?: 'manual' | 'agent'
  required?: boolean
  activity?: 'idle' | 'running' | 'attention'
  lastAuditedAt?: number | null
  canGoBack?: boolean
  canGoForward?: boolean
}

interface CreateBrowserTabSwitchExecutorParams {
  switchTab: (tabId: string) => Promise<BrowserTabSwitchExecutorResult | undefined>
  getState: () => { activeTabId: string | null; tabs: BrowserTab[] }
  setActiveTabId: (tabId: string) => void
  setUrlInput: (value: string) => void
  updateTab: (tabId: string, patch: Partial<BrowserTab>) => void
  sequencer: BrowserTabActivationSequencer
}

export function createBrowserTabSwitchExecutor({
  switchTab,
  getState,
  setActiveTabId,
  setUrlInput,
  updateTab,
  sequencer,
}: CreateBrowserTabSwitchExecutorParams) {
  return async (tabId: string): Promise<boolean> => {
    const { activeTabId, tabs } = getState()
    if (tabId === activeTabId) return false
    const previousActiveTabId = activeTabId
    const previousActiveTab = tabs.find((item) => item.id === previousActiveTabId) || null
    const nextTab = tabs.find((item) => item.id === tabId) || null

    setActiveTabId(tabId)
    setUrlInput(nextTab?.url === DEFAULT_BROWSER_URL ? '' : nextTab?.url || '')

    const activationToken = sequencer.begin()
    const result = await switchTab(tabId)
    if (!result?.success) {
      if (sequencer.isCurrent(activationToken) && previousActiveTabId) {
        setActiveTabId(previousActiveTabId)
        setUrlInput(previousActiveTab?.url === DEFAULT_BROWSER_URL ? '' : previousActiveTab?.url || '')
      }
      return false
    }

    if (!sequencer.isCurrent(activationToken)) {
      const currentState = getState()
      if (currentState.activeTabId === tabId && previousActiveTabId) {
        setActiveTabId(previousActiveTabId)
        setUrlInput(previousActiveTab?.url === DEFAULT_BROWSER_URL ? '' : previousActiveTab?.url || '')
      }
      return false
    }

    const tab = getState().tabs.find((item) => item.id === tabId)

    setUrlInput(result.url === DEFAULT_BROWSER_URL ? '' : result.url || tab?.url || '')
    updateTab(tabId, {
      url: result.url || tab?.url || '',
      title: result.title || tab?.title || '',
      domain: result.domain,
      favicon: result.favicon || undefined,
      owner: result.owner,
      required: result.required,
      activity: result.activity,
      lastAuditedAt: result.lastAuditedAt,
      canGoBack: result.canGoBack || false,
      canGoForward: result.canGoForward || false,
    })
    return true
  }
}
