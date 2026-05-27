import { AuthPopupManager } from './auth-popup-manager'

interface WindowOpenDetails {
  url: string
  frameName?: string
  features?: string
  disposition?: string
  referrer?: { url?: string }
}

export class BrowserWindowOpenService {
  private readonly popupManager: AuthPopupManager
  private readonly openInTab: (url: string) => void
  private readonly logBrowserDiag: (message: string) => void
  private readonly openExternal: (url: string) => void

  constructor(deps: {
    popupManager: AuthPopupManager
    openInTab: (url: string) => void
    logBrowserDiag: (message: string) => void
    openExternal: (url: string) => void
  }) {
    this.popupManager = deps.popupManager
    this.openInTab = deps.openInTab
    this.logBrowserDiag = deps.logBrowserDiag
    this.openExternal = deps.openExternal
  }

  handle(
    details: WindowOpenDetails,
    source: 'tab' | 'preview',
    sourceContentsId: number,
  ): {
    action: 'allow' | 'deny'
    overrideBrowserWindowOptions?: Electron.BrowserWindowConstructorOptions
  } {
    const resolved = this.popupManager.resolveWindowOpen({
      url: details.url,
      frameName: details.frameName,
      features: details.features,
      disposition: details.disposition,
      referrer: details.referrer?.url,
    })
    this.logBrowserDiag(
      `[browser-v3][popup] source=${source} mode=${resolved.mode} reason=${resolved.reason} url=${details.url}`,
    )
    this.popupManager.notifyWindowOpenRequested({
      sourceContentsId,
      url: details.url,
      mode: resolved.mode,
      reason: resolved.reason,
    })

    if (resolved.mode === 'allow-popup') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: resolved.overrideBrowserWindowOptions,
      }
    }

    if (resolved.mode === 'open-tab') {
      this.openInTab(details.url)
      return { action: 'deny' }
    }

    this.openExternal(details.url)
    return { action: 'deny' }
  }
}
