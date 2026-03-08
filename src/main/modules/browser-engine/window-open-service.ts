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
  private readonly createTab: (url: string) => Promise<{ success: boolean; tabId?: string; error?: string }>
  private readonly logBrowserDiag: (message: string) => void
  private readonly openExternal: (url: string) => void

  constructor(deps: {
    popupManager: AuthPopupManager
    createTab: (url: string) => Promise<{ success: boolean; tabId?: string; error?: string }>
    logBrowserDiag: (message: string) => void
    openExternal: (url: string) => void
  }) {
    this.popupManager = deps.popupManager
    this.createTab = deps.createTab
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
      void this.createTab(details.url).catch((error) => {
        this.logBrowserDiag(`[browser-v3][popup] failed to open in tab: ${String(error)}`)
        this.openExternal(details.url)
      })
      return { action: 'deny' }
    }

    this.openExternal(details.url)
    return { action: 'deny' }
  }
}
