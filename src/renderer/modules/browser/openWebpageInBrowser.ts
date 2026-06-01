import { useBrowserTabs } from '../../stores/useBrowserTabs'
import { requestWorkbenchModeChange } from '../workbench/mode-transition'
import { browserTabActivationSequencer } from './browserTabActivationSequencer'
import { isLocalHtmlFilePath, openLocalHtmlFileInBrowser } from './localHtmlFileOpen'

interface OpenWebpageOptions {
  localPath?: string | null
}

export async function openWebpageInBrowser(href: string, opts: OpenWebpageOptions = {}): Promise<boolean> {
  if (opts.localPath && isLocalHtmlFilePath(opts.localPath)) {
    const opened = await openLocalHtmlFileInBrowser(opts.localPath)
    if (opened) requestWorkbenchModeChange('browser')
    return opened
  }

  if (typeof window === 'undefined') return false

  if (window.electronAPI?.browser?.createTab) {
    const result = await window.electronAPI.browser.createTab(href)
    if (result?.success && result.tabId) {
      const browserTabs = useBrowserTabs.getState()
      if (!browserTabs.tabs.some((tab) => tab.id === result.tabId)) {
        browserTabs.addTab({
          id: result.tabId,
          url: href,
          title: result.title || href,
          loading: true,
          canGoBack: false,
          canGoForward: false,
        })
      }
      browserTabActivationSequencer.invalidate()
      browserTabs.setActiveTabId(result.tabId)
      browserTabs.setUrlInput(href)
      requestWorkbenchModeChange('browser')
      return true
    }
  }

  window.open(href, '_blank', 'noopener,noreferrer')
  return false
}
