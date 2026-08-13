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

export abstract class BrowserControllerCaptureRuntime extends BrowserControllerAutomationRuntime {
  async captureBackgroundPage(
    url: string,
    options?: {
      timeoutMs?: number
      settleMs?: number
      script?: string
      cookies?: Array<{
        url: string
        name: string
        value: string
        domain?: string
        path?: string
        secure?: boolean
        httpOnly?: boolean
        expirationDate?: number
        sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
      }>
    },
  ): Promise<unknown> {
    if (!isAllowedBrowserURL(url)) {
      throw new Error('Blocked URL protocol. Only http: and https: are allowed.')
    }
    if (this.useMock) {
      return {
        title: 'Mock Background Page',
        finalUrl: url,
        items: [],
      }
    }
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
    probeWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const blockNonHttpNavigation = (event: Electron.Event, targetUrl: string) => {
      if (isAllowedBrowserURL(targetUrl)) return
      event.preventDefault()
    }
    probeWindow.webContents.on('will-navigate', blockNonHttpNavigation)
    probeWindow.webContents.on('will-frame-navigate', blockNonHttpNavigation as never)
    probeWindow.webContents.on('will-redirect', blockNonHttpNavigation as never)
    try {
      probeWindow.webContents.setUserAgent(this.browserUserAgent)
      probeWindow.webContents.setAudioMuted(true)
    } catch {
      // ignore background probe sync failures
    }

    const timeoutMs = Math.max(5_000, options?.timeoutMs ?? 30_000)
    const settleMs = Math.max(0, options?.settleMs ?? 1_500)

    try {
      if (Array.isArray(options?.cookies) && options.cookies.length > 0) {
        for (const cookie of options.cookies) {
          try {
            await probeWindow.webContents.session.cookies.set(cookie)
          } catch {
            // ignore cookie seed failures for individual entries
          }
        }
      }

      await new Promise<void>((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => {
          finish(new Error(`Timed out loading ${url}`))
        }, timeoutMs)

        const cleanup = () => {
          clearTimeout(timer)
          probeWindow.webContents.removeListener('did-stop-loading', handleStop)
          probeWindow.webContents.removeListener('did-fail-load', handleFail as never)
        }

        const finish = (error?: Error) => {
          if (settled) return
          settled = true
          cleanup()
          if (error) {
            reject(error)
          } else {
            resolve()
          }
        }

        const handleStop = () => finish()
        const handleFail = (
          _event: Electron.Event,
          errorCode: number,
          errorDescription: string,
          _validatedURL: string,
          isMainFrame: boolean,
        ) => {
          if (!isMainFrame) return
          finish(new Error(`${errorDescription} (${errorCode})`))
        }

        probeWindow.webContents.on('did-stop-loading', handleStop)
        probeWindow.webContents.on('did-fail-load', handleFail as never)
        void probeWindow.webContents.loadURL(url).catch((error) => {
          finish(error instanceof Error ? error : new Error(String(error)))
        })
      })

      if (settleMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, settleMs))
      }

      if (options?.script) {
        const wrappedScript = `
          (async () => {
            try {
              const __readyCaptureSource = ${JSON.stringify(options.script)}
              const __readyCaptureValue = await eval(__readyCaptureSource)
              return { __readyCaptureOk: true, value: __readyCaptureValue }
            } catch (error) {
              return {
                __readyCaptureOk: false,
                error: String((error && (error.stack || error.message)) || error || 'Unknown capture error'),
              }
            }
          })()
        `
        const captureResult = await probeWindow.webContents.executeJavaScript(wrappedScript, true) as
          | { __readyCaptureOk?: boolean; value?: unknown; error?: string }
          | null
        if (captureResult && captureResult.__readyCaptureOk === false) {
          return {
            __readyCaptureError: captureResult.error || 'Unknown capture error',
          }
        }
        return captureResult && captureResult.__readyCaptureOk ? captureResult.value : captureResult
      }

      return probeWindow.webContents.executeJavaScript(
        `(() => ({
          title: document.title || '',
          finalUrl: location.href,
          text: document.body?.innerText || '',
          html: document.documentElement?.outerHTML || '',
        }))()`,
        true,
      )
    } finally {
      try {
        probeWindow.webContents.removeListener('will-navigate', blockNonHttpNavigation)
        probeWindow.webContents.removeListener('will-frame-navigate', blockNonHttpNavigation as never)
        probeWindow.webContents.removeListener('will-redirect', blockNonHttpNavigation as never)
      } catch {
        // ignore listener cleanup failures
      }
      try {
        probeWindow.webContents.stop()
      } catch {
        // ignore stop failures
      }
      try {
        probeWindow.destroy()
      } catch {
        // ignore cleanup failures
      }
    }
  }

  async captureLiveTabPage(
    url: string,
    options?: {
      timeoutMs?: number
      settleMs?: number
      script?: string
    },
  ): Promise<unknown | null> {
    if (!isAllowedBrowserURL(url)) {
      throw new Error('Blocked URL protocol. Only http: and https: are allowed.')
    }
    if (this.useMock) {
      return null
    }
    const tab = this.findReusableTabForCapture(url)
    if (!tab?.view) {
      return null
    }

    const webContents = tab.view.webContents
    const timeoutMs = Math.max(5_000, options?.timeoutMs ?? 30_000)
    const settleMs = Math.max(0, options?.settleMs ?? 1_500)
    const originalUrl = webContents.getURL() || tab.url
    const shouldRestore = !!originalUrl && originalUrl !== url

    await this.loadWebContentsURL(webContents, url, timeoutMs)
    if (settleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, settleMs))
    }

    try {
      if (options?.script) {
        const wrappedScript = `
          (async () => {
            try {
              const __readyCaptureSource = ${JSON.stringify(options.script)}
              const __readyCaptureValue = await eval(__readyCaptureSource)
              return { __readyCaptureOk: true, value: __readyCaptureValue }
            } catch (error) {
              return {
                __readyCaptureOk: false,
                error: String((error && (error.stack || error.message)) || error || 'Unknown capture error'),
              }
            }
          })()
        `
        const captureResult = await webContents.executeJavaScript(wrappedScript, true) as
          | { __readyCaptureOk?: boolean; value?: unknown; error?: string }
          | null
        if (captureResult && captureResult.__readyCaptureOk === false) {
          return {
            __readyCaptureError: captureResult.error || 'Unknown capture error',
          }
        }
        return captureResult && captureResult.__readyCaptureOk ? captureResult.value : captureResult
      }

      return webContents.executeJavaScript(
        `(() => ({
          title: document.title || '',
          finalUrl: location.href,
          text: document.body?.innerText || '',
          html: document.documentElement?.outerHTML || '',
        }))()`,
        true,
      )
    } finally {
      if (shouldRestore) {
        try {
          await this.loadWebContentsURL(webContents, originalUrl, Math.min(timeoutMs, 15_000))
        } catch {
          // ignore restore failures for live capture reuse
        }
      }
    }
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
