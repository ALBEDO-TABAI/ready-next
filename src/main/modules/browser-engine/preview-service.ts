import type { WebContents } from 'electron'
import { isAllowedBrowserURL } from './popup-policy'
import { loadUrlIgnoringAbort } from './load-url-safe'
import { type BrowserHostView, type BrowserRect, createDefaultPreviewState, type PreviewTabState } from './host-types'

function applyRoundedPreviewViewport(_view: BrowserHostView): void {
  // Rounded clipping is handled at the native host view layer.
}

interface BrowserPreviewServiceDeps {
  useMock: boolean
  browserUserAgent: string
  createHost: (partition: string) => BrowserHostView
  resetPageBackground: (view: BrowserHostView) => void
  syncPageBackground: (view: BrowserHostView) => void
  showHost: (view: BrowserHostView, bounds: BrowserRect) => void
  hideHost: (view: BrowserHostView) => void
  detachHost: (view: BrowserHostView) => void
  applyPreviewBounds: (view: BrowserHostView) => void
  getPreviewBounds: () => BrowserRect
  setPreviewBounds: (bounds: BrowserRect) => void
  sendToRenderer: (channel: string, data: unknown) => void
  logBrowserDiag: (message: string) => void
  bindPopup: (webContents: WebContents) => void
  installContextMenu: (webContents: WebContents) => void
  ensureDownloadSession?: (targetSession: Electron.Session) => void
  handleWindowOpen: (
    details: {
      url: string
      frameName?: string
      features?: string
      disposition?: string
      referrer?: { url?: string }
    },
    source: 'preview',
    sourceContentsId: number,
  ) => {
    action: 'allow' | 'deny'
    overrideBrowserWindowOptions?: Electron.BrowserWindowConstructorOptions
  }
  hideActiveTab: () => boolean
  restoreActiveTab: () => void
}

export class BrowserPreviewService {
  private previewView: BrowserHostView | null = null
  private previewState: PreviewTabState = createDefaultPreviewState()
  private shouldRestoreActiveTab = false

  constructor(private readonly deps: BrowserPreviewServiceDeps) {}

  getView(): BrowserHostView | null {
    return this.previewView
  }

  getState(): PreviewTabState {
    return { ...this.previewState }
  }

  getUrl(): string {
    return this.previewState.url
  }

  matchesWebContentsId(webContentsId?: number): boolean {
    return Boolean(webContentsId && this.previewView?.webContents.id === webContentsId)
  }

  private sendPreviewUpdate(): void {
    this.deps.sendToRenderer('browser:previewUpdate', { ...this.previewState })
  }

  private ensurePreviewView(): BrowserHostView {
    if (this.previewView) {
      return this.previewView
    }

    const view = this.deps.createHost('persist:browser')
    try {
      view.webContents.setUserAgent(this.deps.browserUserAgent)
    } catch {
      // ignore user-agent sync failures
    }
    this.deps.applyPreviewBounds(view)

    view.webContents.on('dom-ready', () => {
      applyRoundedPreviewViewport(view)
      this.deps.syncPageBackground(view)
    })

    view.webContents.on('page-title-updated', (_, title) => {
      this.previewState.title = title
      this.sendPreviewUpdate()
    })

    view.webContents.on('did-navigate', (_, url) => {
      this.previewState.url = url
      this.previewState.canGoBack = view.webContents.navigationHistory.canGoBack()
      this.previewState.canGoForward = view.webContents.navigationHistory.canGoForward()
      this.previewState.error = undefined
      this.sendPreviewUpdate()
      this.deps.syncPageBackground(view)
    })

    view.webContents.on('did-navigate-in-page', (_, url) => {
      this.previewState.url = url
      this.previewState.canGoBack = view.webContents.navigationHistory.canGoBack()
      this.previewState.canGoForward = view.webContents.navigationHistory.canGoForward()
      this.previewState.error = undefined
      this.sendPreviewUpdate()
      this.deps.syncPageBackground(view)
    })

    view.webContents.on('did-start-loading', () => {
      this.deps.resetPageBackground(view)
      this.previewState.loading = true
      this.sendPreviewUpdate()
    })

    view.webContents.on('did-stop-loading', () => {
      applyRoundedPreviewViewport(view)
      this.deps.syncPageBackground(view)
      this.previewState.loading = false
      this.previewState.canGoBack = view.webContents.navigationHistory.canGoBack()
      this.previewState.canGoForward = view.webContents.navigationHistory.canGoForward()
      this.sendPreviewUpdate()
    })

    view.webContents.on('did-fail-load', (_, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (!isMainFrame) return
      this.deps.logBrowserDiag(`[browser-v3][fail-load][preview] code=${String(errorCode)} message=${errorDescription}`)
      this.previewState.loading = false
      this.previewState.error = `${errorDescription} (${errorCode})`
      this.sendPreviewUpdate()
    })

    this.deps.bindPopup(view.webContents)
    view.webContents.setWindowOpenHandler((details) =>
      this.deps.handleWindowOpen(details, 'preview', view.webContents.id),
    )
    this.deps.installContextMenu(view.webContents)
    this.deps.ensureDownloadSession?.(view.webContents.session)

    this.previewView = view
    return view
  }

  async open(url: string): Promise<{ success: boolean; error?: string }> {
    if (!isAllowedBrowserURL(url)) {
      return { success: false, error: 'Blocked URL protocol. Only http: and https: are allowed.' }
    }
    if (this.deps.useMock) {
      this.previewState = {
        url,
        title: 'Mock Preview',
        loading: false,
        canGoBack: false,
        canGoForward: false,
      }
      this.sendPreviewUpdate()
      return { success: true }
    }

    const view = this.ensurePreviewView()
    this.shouldRestoreActiveTab = this.deps.hideActiveTab() || this.shouldRestoreActiveTab
    this.deps.showHost(view, this.deps.getPreviewBounds())
    this.deps.applyPreviewBounds(view)
    this.previewState = {
      ...this.previewState,
      url,
      loading: true,
      error: undefined,
    }
    this.sendPreviewUpdate()
    const opened = await loadUrlIgnoringAbort(view.webContents, url)
    if (!opened.ok) return { success: false, error: opened.error }
    return { success: true }
  }

  async navigate(url: string): Promise<{ success: boolean; error?: string }> {
    if (!isAllowedBrowserURL(url)) {
      return { success: false, error: 'Blocked URL protocol. Only http: and https: are allowed.' }
    }
    if (this.deps.useMock) {
      this.previewState = { ...this.previewState, url }
      this.sendPreviewUpdate()
      return { success: true }
    }

    const view = this.ensurePreviewView()
    this.shouldRestoreActiveTab = this.deps.hideActiveTab() || this.shouldRestoreActiveTab
    this.deps.showHost(view, this.deps.getPreviewBounds())
    const loaded = await loadUrlIgnoringAbort(view.webContents, url)
    if (!loaded.ok) return { success: false, error: loaded.error }
    return { success: true }
  }

  goBack(): { success: boolean; error?: string } {
    if (this.deps.useMock) return { success: true }
    if (!this.previewView) return { success: false, error: 'Preview is not open' }
    if (this.previewView.webContents.navigationHistory.canGoBack()) {
      this.previewView.webContents.navigationHistory.goBack()
    }
    return { success: true }
  }

  goForward(): { success: boolean; error?: string } {
    if (this.deps.useMock) return { success: true }
    if (!this.previewView) return { success: false, error: 'Preview is not open' }
    if (this.previewView.webContents.navigationHistory.canGoForward()) {
      this.previewView.webContents.navigationHistory.goForward()
    }
    return { success: true }
  }

  reload(): { success: boolean; error?: string } {
    if (this.deps.useMock) return { success: true }
    if (!this.previewView) return { success: false, error: 'Preview is not open' }
    this.previewView.webContents.reload()
    return { success: true }
  }

  updateBounds(bounds: BrowserRect): { success: boolean } {
    this.deps.setPreviewBounds(bounds)
    if (this.previewView) {
      this.deps.applyPreviewBounds(this.previewView)
    }
    return { success: true }
  }

  close(): { success: boolean } {
    if (this.previewView) {
      this.deps.detachHost(this.previewView)
      this.previewView.webContents.close()
      this.previewView = null
    }
    this.previewState = createDefaultPreviewState()
    this.sendPreviewUpdate()
    if (this.shouldRestoreActiveTab) {
      this.deps.restoreActiveTab()
    }
    this.shouldRestoreActiveTab = false
    return { success: true }
  }

  detach(): void {
    if (!this.previewView) return
    this.deps.hideHost(this.previewView)
  }
}
