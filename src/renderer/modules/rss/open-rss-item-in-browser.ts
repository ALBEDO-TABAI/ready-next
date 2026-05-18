import { browserTabActivationSequencer } from '../browser/browserTabActivationSequencer'
import { extractBrowserDomain } from '../browser/url-utils'
import { useBrowserTabs, type BrowserTab } from '../../stores/useBrowserTabs'

interface RSSBrowserTarget {
  link: string
  title: string
}

interface BrowserTabStore {
  addTab: (tab: BrowserTab) => void
  setActiveTabId: (id: string | null) => void
  setUrlInput: (input: string) => void
}

interface OpenRSSItemInBrowserDeps {
  createTab?: (url: string) => Promise<{ success: boolean; tabId?: string }>
  store?: BrowserTabStore
  invalidateActivation?: () => void
}

export async function openRSSItemInBrowserTab(
  item: RSSBrowserTarget,
  deps: OpenRSSItemInBrowserDeps = {},
): Promise<boolean> {
  const targetUrl = item.link.trim()
  if (!targetUrl) return false

  const createTab = deps.createTab ?? window.electronAPI?.browser?.createTab
  if (!createTab) return false

  const result = await createTab(targetUrl)
  if (!result?.success || !result.tabId) return false

  const store = deps.store ?? useBrowserTabs.getState()
  store.addTab({
    id: result.tabId,
    url: targetUrl,
    title: item.title || 'Loading...',
    loading: true,
    canGoBack: false,
    canGoForward: false,
    domain: extractBrowserDomain(targetUrl),
    owner: 'manual',
    required: false,
    activity: 'idle',
  })
  const invalidateActivation = deps.invalidateActivation ?? browserTabActivationSequencer.invalidate
  invalidateActivation()
  store.setActiveTabId(result.tabId)
  store.setUrlInput(targetUrl)
  return true
}
