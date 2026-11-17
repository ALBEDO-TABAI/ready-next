import { BrowserWindow, session } from 'electron'
import type {
  BrowserUploadTarget
} from './automation-types'
import { type BrowserDownloadUrlToDirectoryPayload, type BrowserDownloadUrlToDirectoryResult } from './download-service'
import {
  type BrowserRect
} from './host-types'
import { withHtmlInCanvasWebPreferences } from '../app-control/html-in-canvas-feature'
import {
  isAllowedBrowserURL
} from './popup-policy'
import { BrowserControllerAutomationRuntime } from './browser-controller-automation-runtime'
import {
  createBackgroundCapturePage,
  createMockBackgroundPage,
  type BackgroundPageHandle,
  type BackgroundPageObserveOptions,
} from './background-capture-page'

export abstract class BrowserControllerCaptureRuntime extends BrowserControllerAutomationRuntime {
  /**
   * Opens one hidden page in the person's own browser session (same cookies and user agent as their tabs).
   * It never touches a tab the person has open. The caller closes it.
   */
  async openBackgroundPage(options?: { observe?: BackgroundPageObserveOptions }): Promise<BackgroundPageHandle> {
    if (this.useMock) return createMockBackgroundPage()
    const probeWindow = new BrowserWindow({
      show: false,
      width: 1440,
      height: 1080,
      paintWhenInitiallyHidden: true,
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: withHtmlInCanvasWebPreferences({
        partition: 'persist:browser',
        nodeIntegration: false,
        contextIsolation: true,
        spellcheck: true,
        webSecurity: true,
        backgroundThrottling: false,
      }),
    })
    probeWindow.setMenuBarVisibility(false)
    try {
      probeWindow.webContents.setUserAgent(this.browserUserAgent)
      probeWindow.webContents.setAudioMuted(true)
    } catch {
      // silent-catch: the page still loads with the session default user agent
    }
    return createBackgroundCapturePage(probeWindow, {
      observe: options?.observe,
      isAllowedUrl: isAllowedBrowserURL,
    })
  }

  /**
   * Get the HTML content of a page (document.documentElement.outerHTML), truncated to 50K chars.
   */
  async getPageHTML(tabId: string | null): Promise<string> {
    return this.automationService.getPageHTML(tabId)
  }

  /**
   * Take a screenshot of the tab, returned as base64 PNG.
   */
  async screenshot(tabId: string | null): Promise<string> {
    return this.automationService.screenshot(tabId)
  }

  async findUploadTargets(tabId: string | null): Promise<BrowserUploadTarget[]> {
    return this.automationService.findUploadTargets(tabId)
  }

  async setFileInputFiles(
    tabId: string | null,
    payload: {
      files: string[]
      selector?: string
      targetToken?: string
      frameDocumentToken?: string
      backendDOMNodeId?: number
    },
  ): Promise<{ ok: boolean; targetDescription: string; inputFound: boolean; filesAssigned?: boolean; assignedFileNames?: string[] }> {
    return this.automationService.setFileInputFiles(tabId, payload)
  }

  async uploadLocalMediaFiles(
    tabId: string | null,
    payload: { files: string[]; x?: number; y?: number },
  ): Promise<{
    success: boolean
    method?: 'file-input' | 'drop'
    targetDescription?: string
    assignedFileNames?: string[]
    error?: string
  }> {
    return this.automationService.uploadLocalMediaFiles(tabId, payload)
  }

  /**
   * Navigate the active tab (or specified tab) to a URL.
   */

  async captureWindowSnapshot(bounds: BrowserRect): Promise<{ success: boolean; data?: string; error?: string }> {
    try {
      if (bounds.width <= 0 || bounds.height <= 0) {
        return { success: false, error: 'Invalid snapshot bounds' }
      }
      const image = await this.mainWindow.capturePage(bounds)
      return { success: true, data: image.toPNG().toString('base64') }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async captureViewportSnapshot(tabId?: string | null): Promise<{ success: boolean; data?: string; error?: string }> {
    try {
      const data = await this.screenshot(tabId || null)
      return { success: true, data }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async downloadUrlToDirectory(
    payload: BrowserDownloadUrlToDirectoryPayload,
  ): Promise<BrowserDownloadUrlToDirectoryResult> {
    let targetSession = session.fromPartition('persist:browser')
    if (payload.tabId) {
      try { targetSession = this.resolveTabView(payload.tabId).view.webContents.session } catch { /* use default browser session */ }
    }
    return this.downloadService.downloadUrlToDirectory(targetSession, payload)
  }

}
