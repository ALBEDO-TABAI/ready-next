import { BrowserWindow, shell, WebContents } from 'electron'
import { decidePopupPolicy, type PopupRequestContext } from './popup-policy'
import { withHtmlInCanvasWebPreferences } from '../app-control/html-in-canvas-feature'

export interface PopupOpenInTabContext {
  sourceTabId?: string | null
  sourceOwner?: 'manual' | 'agent' | null
  profile?: string | null
}

type OpenInTabHandler = (url: string, context?: PopupOpenInTabContext) => void
type Logger = (message: string) => void

export class AuthPopupManager {
  private readonly boundContents = new Set<number>()
  private readonly knownPopupContents = new Set<number>()
  private readonly pendingPopupFallbacks = new Map<number, { timer: NodeJS.Timeout; url: string; context: PopupOpenInTabContext }>()
  private readonly contentContexts = new Map<number, PopupOpenInTabContext>()
  private mainWindow: BrowserWindow
  private readonly openInTab: OpenInTabHandler
  private readonly logger: Logger
  private readonly browserUserAgent: string

  constructor(
    mainWindow: BrowserWindow,
    openInTab: OpenInTabHandler,
    logger?: Logger,
    browserUserAgent?: string,
  ) {
    this.mainWindow = mainWindow
    this.openInTab = openInTab
    this.logger = logger || (() => {})
    this.browserUserAgent = String(browserUserAgent || mainWindow.webContents.getUserAgent())
  }

  setMainWindow(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow
  }

  getPopupWindowOptions(profile?: string | null): Electron.BrowserWindowConstructorOptions {
    return {
      show: true,
      width: 980,
      height: 760,
      autoHideMenuBar: true,
      parent: this.mainWindow,
      titleBarStyle: 'default',
      webPreferences: withHtmlInCanvasWebPreferences({
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        partition: profile ? `persist:browser-profile-${profile}` : 'persist:browser',
        webSecurity: true,
        spellcheck: true,
      }),
    }
  }

  bindWindow(contentSource: WebContents, context: PopupOpenInTabContext = {}): void {
    this.contentContexts.set(contentSource.id, {
      sourceTabId: context.sourceTabId ?? null,
      sourceOwner: context.sourceOwner ?? null,
      profile: context.profile ?? null,
    })
    if (this.boundContents.has(contentSource.id)) return
    this.boundContents.add(contentSource.id)

    contentSource.on('did-create-window', (childWindow) => {
      this.clearPendingFallback(contentSource.id, 'popup-created')
      const childContents = childWindow.webContents
      const childContext = this.contentContexts.get(contentSource.id) ?? {}
      this.knownPopupContents.add(childContents.id)
      this.contentContexts.set(childContents.id, childContext)
      this.logger(`[browser-v3][popup] did-create-window id=${childContents.id}`)
      this.bindPopupContents(childContents, childContext)
      if (!childWindow.isDestroyed()) {
        childWindow.show()
        childWindow.focus()
      }
      childWindow.once('closed', () => {
        this.knownPopupContents.delete(childContents.id)
        this.boundContents.delete(childContents.id)
        this.contentContexts.delete(childContents.id)
      })
    })

    contentSource.once('destroyed', () => {
      this.clearPendingFallback(contentSource.id, 'source-destroyed')
      this.boundContents.delete(contentSource.id)
      this.contentContexts.delete(contentSource.id)
    })
  }

  private bindPopupContents(contents: WebContents, context: PopupOpenInTabContext = {}): void {
    this.contentContexts.set(contents.id, {
      sourceTabId: context.sourceTabId ?? null,
      sourceOwner: context.sourceOwner ?? null,
      profile: context.profile ?? null,
    })
    if (this.boundContents.has(contents.id)) return
    this.boundContents.add(contents.id)

    try {
      contents.setUserAgent(this.browserUserAgent)
    } catch {
      // ignore user-agent sync failures
    }

    contents.setWindowOpenHandler((details) => {
      const decision = decidePopupPolicy({
        url: details.url,
        frameName: details.frameName,
        features: details.features,
        disposition: details.disposition,
        referrer: details.referrer?.url,
      })
      this.logger(`[browser-v3][popup] nested-open id=${contents.id} mode=${decision.mode} reason=${decision.reason} url=${details.url}`)
      if (decision.mode === 'allow-popup') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: this.getPopupWindowOptions(this.contentContexts.get(contents.id)?.profile),
        }
      }
      if (decision.mode === 'open-tab') {
        this.openInTab(details.url, this.contentContexts.get(contents.id) ?? {})
        return { action: 'deny' }
      }
      shell.openExternal(details.url)
      return { action: 'deny' }
    })

    contents.on('will-navigate', (event, url) => {
      if (this.knownPopupContents.has(contents.id) && /^https?:/i.test(url)) {
        const decision = decidePopupPolicy({ url })
        this.logger(`[browser-v3][popup] child-navigate id=${contents.id} mode=${decision.mode} reason=${decision.reason} url=${url}`)
        if (decision.mode !== 'allow-popup') {
          event.preventDefault()
          if (decision.mode === 'open-tab') this.openInTab(url, this.contentContexts.get(contents.id) ?? {})
          else shell.openExternal(url)
          const owner = BrowserWindow.fromWebContents(contents)
          if (owner && !owner.isDestroyed()) owner.close()
        }
        return
      }
      if (!/^https?:/i.test(url)) {
        event.preventDefault()
        shell.openExternal(url)
      }
    })
  }

  resolveWindowOpen(context: PopupRequestContext, source?: PopupOpenInTabContext): {
    action: 'allow' | 'deny'
    overrideBrowserWindowOptions?: Electron.BrowserWindowConstructorOptions
    mode: 'allow-popup' | 'open-tab' | 'external'
    reason: string
  } {
    const decision = decidePopupPolicy(context)
    if (decision.mode === 'allow-popup') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: this.getPopupWindowOptions(source?.profile),
        mode: decision.mode,
        reason: decision.reason,
      }
    }
    return {
      action: 'deny',
      mode: decision.mode,
      reason: decision.reason,
    }
  }

  notifyWindowOpenRequested(params: {
    sourceContentsId: number
    url: string
    mode: 'allow-popup' | 'open-tab' | 'external'
    reason: string
    context?: PopupOpenInTabContext
  }): void {
    const { sourceContentsId, url, mode, reason } = params
    if (!sourceContentsId || !Number.isFinite(sourceContentsId)) return
    if (params.context) {
      this.contentContexts.set(sourceContentsId, {
        sourceTabId: params.context.sourceTabId ?? null,
        sourceOwner: params.context.sourceOwner ?? null,
        profile: params.context.profile ?? null,
      })
    }

    this.clearPendingFallback(sourceContentsId, `next-open:${reason}`)

    // Only schedule fallback for http(s) auth popups.
    if (mode !== 'allow-popup' || !/^https?:\/\//i.test(url)) {
      return
    }

    const timer = setTimeout(() => {
      const pending = this.pendingPopupFallbacks.get(sourceContentsId)
      if (!pending) return
      this.pendingPopupFallbacks.delete(sourceContentsId)
      this.logger(
        `[browser-v3][popup] fallback-open-tab source=${sourceContentsId} url=${pending.url}`,
      )
      this.openInTab(pending.url, pending.context)
    }, 1100)

    this.pendingPopupFallbacks.set(sourceContentsId, {
      timer,
      url,
      context: this.contentContexts.get(sourceContentsId) ?? {},
    })
  }

  private clearPendingFallback(sourceContentsId: number, reason: string): void {
    const pending = this.pendingPopupFallbacks.get(sourceContentsId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingPopupFallbacks.delete(sourceContentsId)
    this.logger(`[browser-v3][popup] clear-fallback source=${sourceContentsId} reason=${reason}`)
  }
}
