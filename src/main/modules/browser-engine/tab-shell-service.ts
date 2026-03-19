import type { BrowserHostView, BrowserRect } from './host-types'

interface BrowserShellNavigationHistory {
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
}

interface BrowserShellWebContents {
  loadURL(url: string): Promise<void>
  reload(): void
  close?: () => void
  navigationHistory: BrowserShellNavigationHistory
}

type BrowserShellView = BrowserHostView & {
  webContents: BrowserShellWebContents
}

export type BrowserShellTabOwner = 'manual' | 'agent'
export type BrowserShellTabActivity = 'idle' | 'running' | 'attention'

export interface BrowserShellTabRecord {
  id: string
  url: string
  title: string
  domain: string
  favicon: string | null
  owner: BrowserShellTabOwner
  required: boolean
  activity: BrowserShellTabActivity
  lastAuditedAt: number | null
  view?: BrowserShellView
}

export interface BrowserTabSwitchResult {
  success: boolean
  error?: string
  url?: string
  title?: string
  domain?: string
  favicon?: string | null
  owner?: BrowserShellTabOwner
  required?: boolean
  activity?: BrowserShellTabActivity
  lastAuditedAt?: number | null
  canGoBack?: boolean
  canGoForward?: boolean
}

interface BrowserTabShellHost {
  tabs: Map<string, BrowserShellTabRecord>
  getActiveTabId(): string | null
  setActiveTabId(tabId: string | null): void
  getViewBounds(): BrowserRect
  setViewBounds(bounds: BrowserRect): void
  shouldPresentHosts(): boolean
  isAllowedUrl(url: string): boolean
  createTab(url: string): Promise<{ success: boolean; tabId?: string; error?: string }>
  detachHost(view: BrowserShellView): void
  showHost(view: BrowserShellView, bounds: BrowserRect): void
  applyBounds(view: BrowserShellView): void
  hideHost(view: BrowserShellView): void
  detachPreviewView(): void
  restoreActiveTabHost(): void
}

export class BrowserTabShellService {
  constructor(private readonly host: BrowserTabShellHost) {}

  async navigate(tabId: string | null, url: string): Promise<{ success: boolean; error?: string }> {
    if (!this.host.isAllowedUrl(url)) {
      return { success: false, error: 'Blocked URL protocol. Only http: and https: are allowed.' }
    }

    const resolvedTabId = tabId || this.host.getActiveTabId()
    if (!resolvedTabId) {
      return this.host.createTab(url)
    }

    const tab = this.host.tabs.get(resolvedTabId)
    if (!tab?.view) return { success: false, error: 'Tab not found' }

    await tab.view.webContents.loadURL(url)
    return { success: true }
  }

  goBack(tabId: string | null): { success: boolean; error?: string } {
    const tab = this.resolveTab(tabId)
    if (!tab.success) return tab
    if (tab.record.view?.webContents.navigationHistory.canGoBack()) {
      tab.record.view.webContents.navigationHistory.goBack()
    }
    return { success: true }
  }

  goForward(tabId: string | null): { success: boolean; error?: string } {
    const tab = this.resolveTab(tabId)
    if (!tab.success) return tab
    if (tab.record.view?.webContents.navigationHistory.canGoForward()) {
      tab.record.view.webContents.navigationHistory.goForward()
    }
    return { success: true }
  }

  reload(tabId: string | null): { success: boolean; error?: string } {
    const tab = this.resolveTab(tabId)
    if (!tab.success) return tab
    tab.record.view?.webContents.reload()
    return { success: true }
  }

  closeTab(tabId: string): { success: boolean; error?: string } {
    const tab = this.host.tabs.get(tabId)
    if (!tab) return { success: false, error: 'Tab not found' }

    if (tab.view) {
      this.host.detachHost(tab.view)
      tab.view.webContents.close?.()
    }
    this.host.tabs.delete(tabId)

    if (this.host.getActiveTabId() === tabId) {
      const remaining = Array.from(this.host.tabs.values())
      if (remaining.length > 0) {
        const nextTab = remaining[remaining.length - 1]
        if (nextTab.view) {
          this.host.showHost(nextTab.view, this.host.getViewBounds())
          this.host.applyBounds(nextTab.view)
        }
        this.host.setActiveTabId(nextTab.id)
      } else {
        this.host.setActiveTabId(null)
      }
    }

    return { success: true }
  }

  switchTab(tabId: string): BrowserTabSwitchResult {
    const nextTab = this.host.tabs.get(tabId)
    if (!nextTab?.view) return { success: false, error: 'Tab not found' }

    const activeTabId = this.host.getActiveTabId()
    if (activeTabId) {
      const activeTab = this.host.tabs.get(activeTabId)
      if (activeTab?.view) this.host.detachHost(activeTab.view)
    }

    this.host.setActiveTabId(tabId)
    if (this.host.shouldPresentHosts()) {
      this.host.showHost(nextTab.view, this.host.getViewBounds())
      this.host.applyBounds(nextTab.view)
    }

    return {
      success: true,
      url: nextTab.url,
      title: nextTab.title,
      domain: nextTab.domain,
      favicon: nextTab.favicon,
      owner: nextTab.owner,
      required: nextTab.required,
      activity: nextTab.activity,
      lastAuditedAt: nextTab.lastAuditedAt,
      canGoBack: nextTab.view.webContents.navigationHistory.canGoBack(),
      canGoForward: nextTab.view.webContents.navigationHistory.canGoForward(),
    }
  }

  updateViewBounds(bounds: BrowserRect): { success: boolean } {
    this.host.setViewBounds(bounds)
    const activeTabId = this.host.getActiveTabId()
    if (activeTabId) {
      const activeTab = this.host.tabs.get(activeTabId)
      if (activeTab?.view) {
        this.host.applyBounds(activeTab.view)
      }
    }
    return { success: true }
  }

  hideAllHosts(): { success: boolean } {
    const activeTabId = this.host.getActiveTabId()
    if (activeTabId) {
      const activeTab = this.host.tabs.get(activeTabId)
      if (activeTab?.view) {
        this.host.hideHost(activeTab.view)
      }
    }
    this.host.detachPreviewView()
    return { success: true }
  }

  hideActiveHostOnly(): { success: boolean } {
    const activeTabId = this.host.getActiveTabId()
    if (activeTabId) {
      const activeTab = this.host.tabs.get(activeTabId)
      if (activeTab?.view) {
        this.host.hideHost(activeTab.view)
      }
    }
    return { success: true }
  }

  showActiveHost(): { success: boolean } {
    this.host.detachPreviewView()
    this.host.restoreActiveTabHost()
    return { success: true }
  }

  private resolveTab(tabId: string | null):
    | { success: true; record: BrowserShellTabRecord }
    | { success: false; error: string } {
    const resolvedTabId = tabId || this.host.getActiveTabId()
    if (!resolvedTabId) return { success: false, error: 'No active tab' }
    const tab = this.host.tabs.get(resolvedTabId)
    if (!tab?.view) return { success: false, error: 'Tab not found' }
    return { success: true, record: tab }
  }
}
