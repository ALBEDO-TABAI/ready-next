import type { BrowserHostView, BrowserRect, BrowserViewBoundsUpdate } from './host-types'
import { isReadyBrowserBlankUrl } from '../../../shared/browser-defaults'
import { loadUrlIgnoringAbort } from './load-url-safe'
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
  profile?: string | null
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
  previousActiveTabId?: string | null
  activeTabId?: string | null
  url?: string
  title?: string
  domain?: string
  favicon?: string | null
  profile?: string | null
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
  getFrozenBounds?(tabId: string): BrowserRect | null
  shouldPresentHosts(): boolean
  isAllowedUrl(url: string): boolean
  createTab(url: string): Promise<{ success: boolean; tabId?: string; error?: string }>
  materializeTab?(tabId: string): { success: boolean; tabId?: string; error?: string }
  detachHost(view: BrowserShellView): void
  showHost(view: BrowserShellView, bounds: BrowserRect): void
  applyBounds(view: BrowserShellView, bounds?: BrowserRect): void
  hideHost(view: BrowserShellView): void
  isHostAttached?(view: BrowserShellView): boolean
  detachPreviewView(): void
  restoreActiveTabHost(): void
}

export class BrowserTabShellService {
  constructor(private readonly host: BrowserTabShellHost) {}

  reorderTabs(tabIds: string[]): { success: boolean } {
    const seen = new Set<string>()
    const reordered = new Map<string, BrowserShellTabRecord>()
    for (const rawId of tabIds) {
      const tabId = String(rawId || '')
      const tab = this.host.tabs.get(tabId)
      if (!tabId || seen.has(tabId) || !tab) continue
      reordered.set(tabId, tab)
      seen.add(tabId)
    }
    for (const [tabId, tab] of this.host.tabs) {
      if (!seen.has(tabId)) reordered.set(tabId, tab)
    }
    this.host.tabs.clear()
    for (const [tabId, tab] of reordered) this.host.tabs.set(tabId, tab)
    return { success: true }
  }

  private boundsForTab(tabId: string, requested: BrowserRect): BrowserRect {
    return this.host.getFrozenBounds?.(tabId) || requested
  }

  private ensureTabView(tabId: string):
    | { success: true; record: BrowserShellTabRecord & { view: BrowserShellView } }
    | { success: false; error: string } {
    const existing = this.host.tabs.get(tabId)
    if (!existing) return { success: false, error: 'Tab not found' }
    if (!existing.view) {
      const materialized = this.host.materializeTab?.(tabId)
      if (!materialized?.success) {
        return { success: false, error: materialized?.error || 'Tab could not be materialized' }
      }
    }
    const record = this.host.tabs.get(tabId)
    if (!record?.view) return { success: false, error: 'Tab could not be materialized' }
    return { success: true, record: record as BrowserShellTabRecord & { view: BrowserShellView } }
  }

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
    const loaded = await loadUrlIgnoringAbort(tab.view.webContents, url)
    if (!loaded.ok) return { success: false, error: loaded.error }
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
      const remainingTabIds = Array.from(this.host.tabs.keys()).reverse()
      let nextActiveTabId: string | null = null
      for (const nextTabId of remainingTabIds) {
        const nextTab = this.ensureTabView(nextTabId)
        if (!nextTab.success) continue
        this.host.showHost(nextTab.record.view, this.host.getViewBounds())
        this.host.applyBounds(nextTab.record.view)
        nextActiveTabId = nextTabId
        break
      }
      this.host.setActiveTabId(nextActiveTabId)
    } else if (this.host.getSplitTabId() === tabId) {
      this.clearSplitHostState()
    }

    return { success: true }
  }

  switchTab(tabId: string): BrowserTabSwitchResult {
    const previousActiveTabId = this.host.getActiveTabId()
    const nextTabResult = this.ensureTabView(tabId)
    if (!nextTabResult.success) return nextTabResult
    const nextTab = nextTabResult.record
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
          this.host.applyBounds(splitTab.view, this.host.getSplitViewBounds())
        }
      }
    }
    const visibleTabIds = new Set([tabId])
    if (nextSplitTabId) visibleTabIds.add(nextSplitTabId)
    this.detachNonTargetHosts(visibleTabIds)

    return {
      success: true,
      previousActiveTabId,
      activeTabId: tabId,
      url: nextTab.url,
      title: nextTab.title,
      domain: nextTab.domain,
      favicon: nextTab.favicon,
      profile: nextTab.profile ?? null,
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
      const activeTab = this.ensureTabView(resolvedPrimaryTabId)
      if (!activeTab.success) return { success: false }
      this.host.applyBounds(activeTab.record.view, this.boundsForTab(resolvedPrimaryTabId, nextBounds))
    }
    if (resolvedSecondaryTabId) {
      const splitTab = this.ensureTabView(resolvedSecondaryTabId)
      if (!splitTab.success) return { success: false }
      this.host.applyBounds(splitTab.record.view, this.boundsForTab(resolvedSecondaryTabId, this.host.getSplitViewBounds()))
    }
    return { success: true }
  }

  hideAllHosts(): { success: boolean } {
    for (const tab of this.host.tabs.values()) {
      if (tab.view && (this.host.isHostAttached?.(tab.view) ?? true)) {
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
        const activeTabId = this.host.getActiveTabId()
        const splitTabId = this.host.getSplitTabId()
        const visibleTabIds = new Set<string>()
        if (activeTabId) visibleTabIds.add(activeTabId)
        if (splitTabId && splitTabId !== activeTabId) visibleTabIds.add(splitTabId)
        this.detachNonTargetHosts(visibleTabIds)
        if (intent.tabId !== activeTabId) return { success: false }
        const tab = this.ensureTabView(intent.tabId)
        if (!tab.success) return { success: false }
        const bounds = rectToBrowserRect(intent.bounds)
        const hostBounds = this.boundsForTab(intent.tabId, bounds)
        this.host.setViewBounds(bounds)
        if (this.host.shouldPresentHosts()) {
          this.host.showHost(tab.record.view, hostBounds)
          this.host.applyBounds(tab.record.view, hostBounds)
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
        const activeTabId = this.host.getActiveTabId()
        const splitTabId = this.host.getSplitTabId()
        const visibleTabIds = new Set<string>()
        if (activeTabId) visibleTabIds.add(activeTabId)
        if (splitTabId && splitTabId !== activeTabId) visibleTabIds.add(splitTabId)
        this.detachNonTargetHosts(visibleTabIds)
        if (intent.tabId !== activeTabId) return { success: false }
        const bounds = rectToBrowserRect(intent.bounds)
        const hostBounds = this.boundsForTab(intent.tabId, bounds)
        this.host.setViewBounds(bounds)
        if (!this.host.shouldPresentHosts()) return { success: true }
        const tab = this.ensureTabView(intent.tabId)
        if (!tab.success) return { success: false }
        this.host.applyBounds(tab.record.view, hostBounds)
        return { success: true }
      }
      case 'secondary-set-bounds': {
        const activeTabId = this.host.getActiveTabId()
        if (intent.tabId === activeTabId) return { success: false }
        const bounds = rectToBrowserRect(intent.bounds)
        const hostBounds = this.boundsForTab(intent.tabId, bounds)
        const tab = this.ensureTabView(intent.tabId)
        if (!tab.success) return { success: false }
        this.host.setSplitTabId(intent.tabId)
        const visibleTabIds = new Set<string>([intent.tabId])
        if (activeTabId) visibleTabIds.add(activeTabId)
        this.detachNonTargetHosts(visibleTabIds)
        this.host.setSplitViewBounds(bounds)
        if (!this.host.shouldPresentHosts()) return { success: true }
        this.host.showHost(tab.record.view, hostBounds)
        this.host.applyBounds(tab.record.view, hostBounds)
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
      const activeTab = this.ensureTabView(activeTabId)
      if (!activeTab.success) return { success: false }
      this.host.showHost(activeTab.record.view, this.host.getViewBounds())
      this.host.applyBounds(activeTab.record.view, this.host.getViewBounds())
    }

    if (splitTabId && splitTabId !== activeTabId) {
      const splitTab = this.ensureTabView(splitTabId)
      if (!splitTab.success) {
        this.host.setSplitTabId(null)
        return { success: true }
      }
      this.host.showHost(splitTab.record.view, this.host.getSplitViewBounds())
      this.host.applyBounds(splitTab.record.view, this.host.getSplitViewBounds())
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
