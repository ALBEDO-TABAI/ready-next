import { mkdir, open, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { type BrowserDialogSnapshot } from './browser-dialog-service'
import type {
  BrowserCDPErrorCode
} from './automation-types'
import {
  type BrowserHostView,
} from './host-types'
import {
  type BrowserSitePermissionRequestReadback
} from './browser-permission-policy'
import type { BrowserUtilityMenuRequest } from '../../../shared/browser-utility-menu'
import { readBrowserSessionStatus } from './browser-session-status'
import { type Tab } from './browser-controller-contract-base'
import { BrowserLiveProofRuntime } from './browser-live-proof-runtime'

export abstract class BrowserControllerInteractionRuntime extends BrowserLiveProofRuntime {
  protected createBrowserError(code: BrowserCDPErrorCode, message: string): Error {
    const error = new Error(message)
    ;(error as Error & { code?: BrowserCDPErrorCode }).code = code
    return error
  }

  protected resolveTabView(tabId: string | null): { tabId: string; tab: Tab; view: BrowserHostView } {
    const tid = tabId || this.activeTabId
    if (!tid) {
      throw this.createBrowserError('NO_ACTIVE_TAB', 'No active tab')
    }
    const tab = this.tabs.get(tid)
    if (!tab?.view) {
      throw this.createBrowserError('TAB_NOT_FOUND', `Tab not found: ${tid}`)
    }
    return { tabId: tid, tab, view: tab.view }
  }

  protected handleWindowOpen(
    details: {
      url: string
      frameName?: string
      features?: string
      disposition?: string
      referrer?: { url?: string }
    },
    source: 'tab' | 'preview',
    sourceContentsId: number,
  ): {
    action: 'allow' | 'deny'
    overrideBrowserWindowOptions?: Electron.BrowserWindowConstructorOptions
  } {
    const referrerUrl = details.referrer?.url || this.resolveUrlForWebContentsId(sourceContentsId)
    const sourceTabId = this.getTabIdForWebContents(sourceContentsId)
    const sourceOwner = sourceTabId ? this.tabs.get(sourceTabId)?.owner ?? null : null
    const profile = sourceTabId ? this.tabs.get(sourceTabId)?.profile ?? null : null
    return this.windowOpenService.handle({
      ...details,
      referrer: referrerUrl ? { url: referrerUrl } : details.referrer,
    }, source, sourceContentsId, { sourceTabId, sourceOwner, profile })
  }

  async importBookmarksFromDialog(): Promise<{
    success: boolean
    canceled?: boolean
    imported?: number
    skipped?: number
    error?: string
    filePath?: string
  }> {
    return this.bookmarkTransferService.importBookmarksFromDialog()
  }

  async exportBookmarksToDialog(): Promise<{
    success: boolean
    canceled?: boolean
    exported?: number
    error?: string
    filePath?: string
  }> {
    return this.bookmarkTransferService.exportBookmarksToDialog()
  }

  showUtilityMenu(payload: unknown): { success: boolean } {
    return this.utilityMenuService.showMenu(payload as BrowserUtilityMenuRequest)
  }

  // ── Programmatic API (for tool calling, not IPC) ──────────────────

  async getBrowserDialog(tabId: string | null): Promise<BrowserDialogSnapshot | null> {
    const resolved = this.resolveTabView(tabId).tabId
    await this.dialogService.ensure(resolved)
    return this.dialogService.get(resolved)
  }

  async handleBrowserDialog(
    tabId: string | null,
    params: { accept: boolean; promptText?: string },
  ): Promise<{ success: boolean }> {
    const resolved = this.resolveTabView(tabId).tabId
    await this.dialogService.handle(resolved, params)
    return { success: true }
  }

  async archivePage(
    tabId: string | null,
    path: string,
    format: 'pdf' | 'mhtml' | 'html' | 'markdown',
    options?: { signal?: AbortSignal },
  ): Promise<{ success: boolean; path: string; format: string }> {
    const throwIfAborted = () => {
      if (options?.signal?.aborted) throw options.signal.reason || new Error('archive_aborted')
    }
    const { view } = this.resolveTabView(tabId)
    throwIfAborted()
    await mkdir(dirname(path), { recursive: true })
    const reservation = await open(path, 'wx').catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('archive_destination_exists')
      throw error
    })
    await reservation.close()
    const suffix = extname(path) || `.${format}`
    const temporaryPath = join(dirname(path), `.ready-archive-${randomUUID()}${suffix}.part`)
    try {
      throwIfAborted()
      if (format === 'pdf') {
        const bytes = await view.webContents.printToPDF({ printBackground: true })
        throwIfAborted()
        await writeFile(temporaryPath, bytes, { flag: 'wx' })
      } else if (format === 'mhtml') {
        await view.webContents.savePage(temporaryPath, 'MHTML')
      } else if (format === 'html') {
        await view.webContents.savePage(temporaryPath, 'HTMLOnly')
      } else {
        const page = await this.executeJS(tabId, `(() => ({
          title: document.title || '',
          url: location.href,
          text: document.body?.innerText || '',
        }))()` , { timeoutMs: 10_000, signal: options?.signal }) as { title?: string; url?: string; text?: string }
        throwIfAborted()
        await writeFile(temporaryPath, `# ${String(page.title || 'Archived page')}\n\nSource: ${String(page.url || '')}\n\n${String(page.text || '')}\n`, { encoding: 'utf8', flag: 'wx' })
      }
      throwIfAborted()
      const saved = await stat(temporaryPath)
      if (!saved.isFile() || saved.size <= 0) throw new Error('archive_output_empty')
      throwIfAborted()
      await rename(temporaryPath, path)
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      await unlink(path).catch(() => undefined)
      throw error
    }
    return { success: true, path, format }
  }

  async collectConsoleMessages(
    tabId: string | null,
    options?: { durationMs?: number; limit?: number },
  ): Promise<Array<Record<string, unknown>>> {
    const resolved = this.resolveTabView(tabId).tabId
    const messages: Array<Record<string, unknown>> = []
    const limit = Math.max(1, Math.min(500, Number(options?.limit || 100)))
    const unsubscribe = this.cdpSessionService.subscribe(resolved, (event) => {
      if (!['Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded'].includes(event.method)) return
      messages.push({ method: event.method, ...event.params })
      if (messages.length > limit) messages.splice(0, messages.length - limit)
    })
    const releaseRuntime = await this.cdpSessionService.retainDomain(resolved, 'Runtime')
    const releaseLog = await this.cdpSessionService.retainDomain(resolved, 'Log')
    try {
      const durationMs = Math.max(0, Math.min(10_000, Number(options?.durationMs || 250)))
      if (durationMs > 0) await new Promise((resolve) => setTimeout(resolve, durationMs))
      return messages
    } finally {
      unsubscribe()
      await Promise.all([releaseRuntime(), releaseLog()])
    }
  }

  async clearConsoleMessages(tabId: string | null): Promise<{ success: boolean }> {
    const resolved = this.resolveTabView(tabId).tabId
    await this.cdpSessionService.sendCommand(resolved, 'Runtime.discardConsoleEntries').catch(() => undefined)
    await this.cdpSessionService.sendCommand(resolved, 'Log.clear').catch(() => undefined)
    return { success: true }
  }

  async getBrowserSessionStatus(tabId: string | null, requestedOrigin?: string): Promise<Record<string, unknown>> {
    const { view, tabId: resolvedTabId } = this.resolveTabView(tabId)
    const tab = this.tabs.get(resolvedTabId)
    const currentUrl = view.webContents.getURL()
    return readBrowserSessionStatus({
      tabId: resolvedTabId,
      profile: tab?.profile || null,
      currentUrl,
      requestedOrigin,
      getCookieCount: async (origin) => (await view.webContents.session.cookies.get({ url: origin })).length,
      readStorageCounts: () => view.webContents.executeJavaScript(`(() => ({
        localStorageKeys: Object.keys(localStorage).length,
        sessionStorageKeys: Object.keys(sessionStorage).length,
        hasIndexedDb: typeof indexedDB !== 'undefined',
      }))()`, true),
    })
  }

  async clearBrowserOriginData(
    tabId: string | null,
    requestedOrigin?: string,
    dataTypes?: string[],
  ): Promise<{ success: boolean; origin: string; cleared: string[] }> {
    const { view } = this.resolveTabView(tabId)
    const currentUrl = view.webContents.getURL()
    const origin = requestedOrigin || new URL(currentUrl).origin
    const requested = new Set(dataTypes?.length ? dataTypes : ['cookies', 'cache', 'storage', 'service_workers'])
    const storages: Array<'cookies' | 'localstorage' | 'indexdb' | 'websql' | 'cachestorage' | 'serviceworkers'> = []
    if (requested.has('cookies')) storages.push('cookies')
    if (requested.has('storage')) storages.push('localstorage', 'indexdb', 'websql', 'cachestorage')
    if (requested.has('service_workers')) storages.push('serviceworkers')
    if (storages.length > 0) await view.webContents.session.clearStorageData({ origin, storages })
    if (requested.has('cache')) await view.webContents.session.clearCache()
    return { success: true, origin, cleared: Array.from(requested) }
  }

  getBrowserPermission(siteRequestId: string): BrowserSitePermissionRequestReadback {
    return this.sessionPolicyService.getSitePermissionRequest(siteRequestId)
  }

  setBrowserPermission(
    siteRequestId: string,
    decision: 'allow' | 'deny',
  ): BrowserSitePermissionRequestReadback {
    return this.sessionPolicyService.applySitePermissionRequest(siteRequestId, decision)
  }

  resetBrowserPermission(
    tabId: string,
    origin: string,
    permission: string,
  ): Record<string, unknown> {
    const partition = this.partitionForTab(tabId)
    if (!partition) return { permission, origin, decision: 'ask', source: 'expired_tab' }
    return this.sessionPolicyService.resetPermissionDecision(partition, permission, origin)
  }

  /**
   * Create a new tab and navigate to URL. Returns the tab ID.
   */
}
