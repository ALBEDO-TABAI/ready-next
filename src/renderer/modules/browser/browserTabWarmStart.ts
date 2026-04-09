import { browserTabActivationSequencer } from './browserTabActivationSequencer'
import { DEFAULT_BROWSER_URL, extractBrowserDomain } from './url-utils'
import { useBrowserTabs, type BrowserTab } from '../../stores/useBrowserTabs'

let primeBrowserTabsPromise: Promise<boolean> | null = null

export async function primeBrowserTabsStore(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.electronAPI?.browser?.getTabs) return false
  if (useBrowserTabs.getState().tabs.length > 0) return true
  if (primeBrowserTabsPromise) return primeBrowserTabsPromise

  primeBrowserTabsPromise = window.electronAPI.browser.getTabs()
    .then((existingTabs) => {
      if (!Array.isArray(existingTabs) || existingTabs.length === 0) return false

      const hydratedTabs: BrowserTab[] = existingTabs.map((tab) => ({
        id: tab.id,
        url: tab.url,
        title: tab.title || 'New Tab',
        loading: Boolean(tab.loading),
        canGoBack: Boolean(tab.canGoBack),
        canGoForward: Boolean(tab.canGoForward),
        domain: tab.domain || extractBrowserDomain(tab.url),
        favicon: tab.favicon || undefined,
        owner: tab.owner,
        required: tab.required,
        activity: tab.activity,
        lastAuditedAt: tab.lastAuditedAt,
        error: tab.error || undefined,
      }))
      const activeTab = existingTabs.find((tab) => tab.active) || existingTabs[existingTabs.length - 1]

      browserTabActivationSequencer.invalidate()
      useBrowserTabs.setState({
        tabs: hydratedTabs,
        activeTabId: activeTab?.id || hydratedTabs[hydratedTabs.length - 1]?.id || null,
        urlInput: activeTab?.url === DEFAULT_BROWSER_URL ? '' : activeTab?.url || '',
      })
      return true
    })
    .finally(() => {
      primeBrowserTabsPromise = null
    })

  return primeBrowserTabsPromise
}
