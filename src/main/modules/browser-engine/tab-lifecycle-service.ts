import type { Session, WebContents } from 'electron'
import type { BrowserHostView, BrowserRect } from './host-types'

function applyRoundedViewport(_view: BrowserHostView): void {
  // Rounded clipping is handled at the native host view layer.
}

export type BrowserLifecycleTabOwner = 'manual' | 'agent'
export type BrowserLifecycleTabActivity = 'idle' | 'running' | 'attention'

export interface BrowserLifecycleTabRecord {
  id: string
  url: string
  title: string
  domain: string
  favicon: string | null
  owner: BrowserLifecycleTabOwner
  required: boolean
  activity: BrowserLifecycleTabActivity
  lastAuditedAt: number | null
  view?: BrowserHostView
}

interface BrowserWindowOpenDetails {
  url: string
  frameName?: string
  features?: string
  disposition?: string
  referrer?: { url?: string }
}

interface BrowserWindowOpenResult {
  action: 'allow' | 'deny'
  overrideBrowserWindowOptions?: Electron.BrowserWindowConstructorOptions
}

interface BrowserTabLifecycleHost {
  tabs: Map<string, BrowserLifecycleTabRecord>
  getActiveTabId(): string | null
  setActiveTabId(tabId: string | null): void
  getNextTabId(): string
  getViewBounds(): BrowserRect
  shouldPresentHosts(): boolean
  isAllowedUrl(url: string): boolean
  extractDomain(url: string): string
  createHost(partition: string): BrowserHostView
  applyBounds(view: BrowserHostView): void
  detachHost(view: BrowserHostView): void
  showHost(view: BrowserHostView, bounds: BrowserRect): void
  sendToRenderer(channel: string, data: unknown): void
  emitTabMeta(tabId: string): void
  logBrowserDiag(message: string): void
  bindPopup(webContents: WebContents): void
  bindAppShortcutBridge(webContents: WebContents): void
  installContextMenu(webContents: WebContents): void
  handleWindowOpen(details: BrowserWindowOpenDetails, source: 'tab', sourceContentsId: number): BrowserWindowOpenResult
  ensureDownloadSession(targetSession: Session): void
  addHistoryEntry(url: string, title: string, metadata: {
    favicon: string | null
    transition?: string | null
    sessionId?: string | null
  }): void
  browserUserAgent: string
  useMock: boolean
}

export class BrowserTabLifecycleService {
  constructor(private readonly host: BrowserTabLifecycleHost) {}

  async createTab(url: string): Promise<{ success: boolean; tabId?: string; error?: string }> {
    if (!this.host.isAllowedUrl(url)) {
      return { success: false, error: 'Blocked URL protocol. Only http: and https: are allowed.' }
    }

    const tabId = this.host.getNextTabId()
    if (this.host.useMock) {
      const tab: BrowserLifecycleTabRecord = {
        id: tabId,
        url,
        title: 'Mock Tab',
        domain: this.host.extractDomain(url),
        favicon: null,
        owner: 'manual',
        required: false,
        activity: 'idle',
        lastAuditedAt: null,
      }
      this.host.tabs.set(tabId, tab)
      this.host.setActiveTabId(tabId)
      return { success: true, tabId }
    }

    const view = this.host.createHost('persist:browser')
    try {
      view.webContents.setUserAgent(this.host.browserUserAgent)
    } catch {
      // ignore user-agent sync failures
    }

    this.host.applyBounds(view)

    const tab: BrowserLifecycleTabRecord = {
      id: tabId,
      url,
      title: 'Loading...',
      domain: this.host.extractDomain(url),
      favicon: null,
      owner: 'manual',
      required: false,
      activity: 'idle',
      lastAuditedAt: null,
      view,
    }
    this.host.tabs.set(tabId, tab)

    this.bindTabEvents(tabId, tab, view)

    this.host.bindPopup(view.webContents)
    this.host.bindAppShortcutBridge(view.webContents)
    view.webContents.setWindowOpenHandler((details) => this.host.handleWindowOpen(details, 'tab', view.webContents.id))
    this.host.installContextMenu(view.webContents)
    this.host.ensureDownloadSession(view.webContents.session)

    const previousTab = this.host.getActiveTabId()
      ? this.host.tabs.get(this.host.getActiveTabId() as string) || null
      : null
    const previousView = previousTab?.view || null
    let resolvedSwap = false
    const finalizeSwap = (shouldShow: boolean) => {
      if (resolvedSwap) return
      resolvedSwap = true
      if (this.host.getActiveTabId() !== tabId) return
      if (previousView) {
        this.host.detachHost(previousView)
      }
      if (shouldShow && this.host.shouldPresentHosts()) {
        this.host.showHost(view, this.host.getViewBounds())
      }
    }

    view.webContents.once('did-stop-loading', () => {
      finalizeSwap(true)
    })
    view.webContents.once('did-fail-load', () => {
      // Even when a page reports a load failure, we still need to swap the
      // new host into view so the renderer can show the page's own error state
      // instead of leaving a blank container.
      finalizeSwap(true)
    })

    this.host.setActiveTabId(tabId)
    finalizeSwap(true)
    view.webContents.loadURL(url).catch(() => {
      // handled by did-fail-load
    })
    return { success: true, tabId }
  }

  private bindTabEvents(tabId: string, tab: BrowserLifecycleTabRecord, view: BrowserHostView): void {
    view.webContents.on('dom-ready', () => {
      applyRoundedViewport(view)
    })

    view.webContents.on('page-title-updated', (_event, title) => {
      tab.title = title
      this.host.sendToRenderer('browser:tabUpdate', { type: 'title', tabId, title })
      this.host.emitTabMeta(tabId)
    })

    view.webContents.on('page-favicon-updated', (_event, favicons) => {
      tab.favicon = Array.isArray(favicons) && favicons.length > 0 ? String(favicons[0] || '') : null
      this.host.emitTabMeta(tabId)
    })

    view.webContents.on('did-navigate', (_event, newUrl) => {
      tab.url = newUrl
      tab.domain = this.host.extractDomain(newUrl)
      try {
        this.host.addHistoryEntry(newUrl, tab.title, {
          favicon: tab.favicon,
          transition: 'navigate',
          sessionId: tabId,
        })
      } catch {
        // ignore history write failures
      }
      this.emitNavigationState(tabId, tab, view, newUrl)
    })

    view.webContents.on('did-navigate-in-page', (_event, newUrl) => {
      tab.url = newUrl
      tab.domain = this.host.extractDomain(newUrl)
      this.emitNavigationState(tabId, tab, view, newUrl)
    })

    view.webContents.on('did-start-loading', () => {
      this.host.sendToRenderer('browser:tabUpdate', { type: 'loading', tabId, loading: true })
    })

    view.webContents.on('did-stop-loading', () => {
      applyRoundedViewport(view)
      this.host.sendToRenderer('browser:tabUpdate', { type: 'loading', tabId, loading: false })
    })

    view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (!isMainFrame) return
      this.host.logBrowserDiag(`[browser-v3][fail-load][tab:${tabId}] code=${String(errorCode)} message=${errorDescription}`)
      this.host.sendToRenderer('browser:tabUpdate', {
        type: 'error',
        tabId,
        error: `${errorDescription} (${errorCode})`,
      })
    })
  }

  private emitNavigationState(
    tabId: string,
    tab: BrowserLifecycleTabRecord,
    view: BrowserHostView,
    url: string,
  ): void {
    this.host.sendToRenderer('browser:tabUpdate', {
      type: 'navigate',
      tabId,
      url,
      canGoBack: view.webContents.navigationHistory.canGoBack(),
      canGoForward: view.webContents.navigationHistory.canGoForward(),
    })
    this.host.emitTabMeta(tabId)
  }
}
