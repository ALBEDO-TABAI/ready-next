import type { BrowserBoundsSyncMode, BrowserHostView, BrowserRect, BrowserViewBoundsUpdate } from './host-types'
import { isReadyBrowserBlankUrl } from '../../../shared/browser-defaults'
import type { BrowserViewIntent, Rect } from '../../../shared/browser-view-intent'

function rectToBrowserRect(rect: Rect): BrowserRect {
  return { x: rect.x, y: rect.y, width: rect.w, height: rect.h }
}

interface BrowserShellNavigationHistory {
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  clear?: () => void
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
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error: string | null
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
  getSplitTabId(): string | null
  setSplitTabId(tabId: string | null): void
  getViewBounds(): BrowserRect
  setViewBounds(bounds: BrowserRect): void
  getSplitViewBounds(): BrowserRect
  setSplitViewBounds(bounds: BrowserRect): void
  shouldPresentHosts(): boolean
  isAllowedUrl(url: string): boolean
  createTab(url: string): Promise<{ success: boolean; tabId?: string; error?: string }>
  detachHost(view: BrowserShellView): void
  showHost(view: BrowserShellView, bounds: BrowserRect): void
  applyBounds(view: BrowserShellView, syncMode?: BrowserBoundsSyncMode, bounds?: BrowserRect): void
  hideHost(view: BrowserShellView): void
  detachPreviewView(): void
  restoreActiveTabHost(): void
}

export class BrowserTabShellService {
  constructor(private readonly host: BrowserTabShellHost) {}

  private detachNonTargetHosts(targetTabIds: ReadonlySet<string>): void {
    for (const [tabId, tab] of this.host.tabs.entries()) {
      if (targetTabIds.has(tabId)) continue
      if (tab.view) {
        this.host.detachHost(tab.view)
      }
    }
  }

  private clearSplitHostState(): void {
    this.host.setSplitTabId(null)
  }

  private replaceSplitHostState(nextSplitTabId: string | null, keepTabIds: ReadonlySet<string> = new Set()): void {
    const previousSplitTabId = this.host.getSplitTabId()
    if (previousSplitTabId && previousSplitTabId !== nextSplitTabId && !keepTabIds.has(previousSplitTabId)) {
      const previousSplitTab = this.host.tabs.get(previousSplitTabId)
      if (previousSplitTab?.view) {
        this.host.detachHost(previousSplitTab.view)
      }
    }
    this.host.setSplitTabId(nextSplitTabId)
  }

  async navigate(tabId: string | null, url: string): Promise<{ success: boolean; error?: string }> {
    if (!this.host.isAllowedUrl(url)) {
      return { success: false, error: 'Blocked URL protocol. Only http:, https:, and local HTML files are allowed.' }
    }

    const resolvedTabId = tabId || this.host.getActiveTabId()
    if (!resolvedTabId) {
      return this.host.createTab(url)
    }

    const tab = this.host.tabs.get(resolvedTabId)
    if (!tab?.view) return { success: false, error: 'Tab not found' }

    const shouldClearBlankHistory = isReadyBrowserBlankUrl(tab.url) && !isReadyBrowserBlankUrl(url)
    await tab.view.webContents.loadURL(url)
    if (shouldClearBlankHistory) {
      tab.view.webContents.navigationHistory.clear?.()
    }
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
      this.clearSplitHostState()
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
    } else if (this.host.getSplitTabId() === tabId) {
      this.clearSplitHostState()
    }

    return { success: true }
  }

  switchTab(tabId: string): BrowserTabSwitchResult {
    const nextTab = this.host.tabs.get(tabId)
    if (!nextTab?.view) return { success: false, error: 'Tab not found' }
    const currentSplitTabId = this.host.getSplitTabId()
    const nextSplitTabId = currentSplitTabId && currentSplitTabId !== tabId && this.host.tabs.get(currentSplitTabId)?.view
      ? currentSplitTabId
      : null
    this.host.setSplitTabId(nextSplitTabId)
    this.host.setActiveTabId(tabId)
    if (this.host.shouldPresentHosts()) {
      this.host.showHost(nextTab.view, this.host.getViewBounds())
      this.host.applyBounds(nextTab.view)
      if (nextSplitTabId) {
        const splitTab = this.host.tabs.get(nextSplitTabId)
        if (splitTab?.view) {
          this.host.showHost(splitTab.view, this.host.getSplitViewBounds())
          this.host.applyBounds(splitTab.view, 'settled', this.host.getSplitViewBounds())
        }
      }
    }
    const visibleTabIds = new Set([tabId])
    if (nextSplitTabId) visibleTabIds.add(nextSplitTabId)
    this.detachNonTargetHosts(visibleTabIds)

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
      canGoBack: nextTab.canGoBack ?? nextTab.view.webContents.navigationHistory.canGoBack(),
      canGoForward: nextTab.canGoForward ?? nextTab.view.webContents.navigationHistory.canGoForward(),
    }
  }

  updateViewBounds(bounds: BrowserViewBoundsUpdate): { success: boolean } {
    const {
      syncMode = 'settled',
      tabId,
      secondaryTabId,
      secondaryBounds,
      ...nextBounds
    } = bounds
    this.host.setViewBounds(nextBounds)
    const resolvedActiveTabId = this.host.getActiveTabId()
    const resolvedPrimaryTabId = tabId || resolvedActiveTabId
    const resolvedSecondaryTabId =
      secondaryTabId && secondaryTabId !== resolvedPrimaryTabId && secondaryBounds
        ? secondaryTabId
        : null
    this.replaceSplitHostState(
      resolvedSecondaryTabId,
      resolvedPrimaryTabId ? new Set([resolvedPrimaryTabId]) : new Set(),
    )
    if (resolvedSecondaryTabId && secondaryBounds) {
      this.host.setSplitViewBounds(secondaryBounds)
    }
    if (!this.host.shouldPresentHosts()) {
      return { success: true }
    }
    if (resolvedPrimaryTabId) {
      const activeTab = this.host.tabs.get(resolvedPrimaryTabId)
      if (activeTab?.view) {
        this.host.applyBounds(activeTab.view, syncMode, nextBounds)
      }
    }
    if (resolvedSecondaryTabId) {
      const splitTab = this.host.tabs.get(resolvedSecondaryTabId)
      if (splitTab?.view) {
        this.host.applyBounds(splitTab.view, syncMode, this.host.getSplitViewBounds())
      }
    }
    return { success: true }
  }

  hideAllHosts(): { success: boolean } {
    for (const tab of this.host.tabs.values()) {
      if (tab.view) {
        this.host.hideHost(tab.view)
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

  /**
   * Stage X4 PR-shell-1 — single decision point that maps every renderer
   * BrowserViewIntent to existing BrowserView API calls. Renderer no
   * longer calls `hideAll/showActive/updateBounds` directly; all 5 intent
   * kinds funnel through here.
   */
  applyIntent(intent: BrowserViewIntent): { success: boolean } {
    switch (intent.kind) {
      case 'hide-all':
        return this.hideAllHosts()
      case 'show': {
        const tab = this.host.tabs.get(intent.tabId)
        if (!tab?.view) return { success: false }
        const bounds = rectToBrowserRect(intent.bounds)
        this.host.setViewBounds(bounds)
        if (this.host.shouldPresentHosts()) {
          this.host.showHost(tab.view, bounds)
          this.host.applyBounds(tab.view, 'settled', bounds)
        }
        return { success: true }
      }
      case 'hide': {
        const tab = this.host.tabs.get(intent.tabId)
        if (intent.reason === 'split-collapse') {
          const activeTabId = this.host.getActiveTabId()
          const isCurrentSplitTab = this.host.getSplitTabId() === intent.tabId
          if (isCurrentSplitTab) {
            this.host.setSplitTabId(null)
          }
          if (tab?.view && activeTabId !== intent.tabId) {
            this.host.detachHost(tab.view)
          }
          return { success: true }
        }
        if (!tab?.view) return { success: false }
        this.host.hideHost(tab.view)
        return { success: true }
      }
      case 'set-bounds': {
        const bounds = rectToBrowserRect(intent.bounds)
        const syncMode: BrowserBoundsSyncMode = intent.syncMode ?? 'settled'
        this.host.setViewBounds(bounds)
        if (!this.host.shouldPresentHosts()) return { success: true }
        const tab = this.host.tabs.get(intent.tabId)
        if (tab?.view) {
          this.host.applyBounds(tab.view, syncMode, bounds)
        }
        return { success: true }
      }
      case 'secondary-set-bounds': {
        const bounds = rectToBrowserRect(intent.bounds)
        const syncMode: BrowserBoundsSyncMode = intent.syncMode ?? 'settled'
        const activeTabId = this.host.getActiveTabId()
        this.replaceSplitHostState(intent.tabId, activeTabId ? new Set([activeTabId]) : new Set())
        this.host.setSplitViewBounds(bounds)
        if (!this.host.shouldPresentHosts()) return { success: true }
        const tab = this.host.tabs.get(intent.tabId)
        if (tab?.view) {
          this.host.showHost(tab.view, bounds)
          this.host.applyBounds(tab.view, syncMode, bounds)
        }
        return { success: true }
      }
      default: {
        const _exhaustive: never = intent
        void _exhaustive
        return { success: false }
      }
    }
  }

  showActiveHost(): { success: boolean } {
    this.host.detachPreviewView()
    const activeTabId = this.host.getActiveTabId()
    const splitTabId = this.host.getSplitTabId()
    const visibleTabIds = new Set<string>()
    if (activeTabId) visibleTabIds.add(activeTabId)
    if (splitTabId && splitTabId !== activeTabId) visibleTabIds.add(splitTabId)
    this.detachNonTargetHosts(visibleTabIds)

    if (activeTabId) {
      const activeTab = this.host.tabs.get(activeTabId)
      if (activeTab?.view) {
        this.host.showHost(activeTab.view, this.host.getViewBounds())
        this.host.applyBounds(activeTab.view, 'settled', this.host.getViewBounds())
      }
    }

    if (splitTabId && splitTabId !== activeTabId) {
      const splitTab = this.host.tabs.get(splitTabId)
      if (splitTab?.view) {
        this.host.showHost(splitTab.view, this.host.getSplitViewBounds())
        this.host.applyBounds(splitTab.view, 'settled', this.host.getSplitViewBounds())
      }
    }
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
