import { BrowserWindow, shell, session } from 'electron'
import { join } from 'node:path'
import { BrowserAppShortcutBridgeService } from './app-shortcut-service'
import { BrowserAutomationService } from './automation-service'
import { BrowserCapabilityService } from './capability-service'
import type {
  BrowserAggregateOptions,
  BrowserCapabilityTaskHandle,
  BrowserExtractStructuredOptions,
  BrowserExtractStructuredResult,
  BrowserScrollCollectOptions,
  BrowserScrollCollectResult,
  BrowserStructuredItem,
  BrowserStartTaskRequest,
  BrowserWaitForConditionOptions,
} from './capability-types'
import { BrowserContentTaskRunner } from './content-task-runner'
import type {
  BrowserCDPErrorCode,
  BrowserKeyEventPayload,
  BrowserMouseEventPayload,
  BrowserScreenshotOptions,
  BrowserTabContextData,
  BrowserUploadTarget,
  BrowserViewportMetrics,
} from './automation-types'
import { AuthPopupManager } from './auth-popup-manager'
import { BrowserBookmarkTransferService } from './bookmark-transfer-service'
import { BrowserContextMenuService } from './context-menu-service'
import { findReusableCaptureTabId, isReusableCaptureTabUrl } from './capture-url-utils'
import { BrowserDataService, type BrowserAdblockState } from './data-service'
import { BrowserDownloadService, type BrowserDownloadUrlToDirectoryPayload, type BrowserDownloadUrlToDirectoryResult } from './download-service'
import {
  BROWSER_DIAGNOSTICS_LOG_PATH,
  BrowserDiagnosticsService,
  type BrowserContinuityDiagnosticsSnapshot,
  type BrowserPageDiagnosticsSnapshot,
  type BrowserTaskDiagnosticsSnapshot,
} from './diagnostics-service'
import { BrowserHostLayoutService } from './host-layout-service'
import {
  type BrowserBoundsSyncMode,
  type BrowserHostKind,
  type BrowserHostView,
  type BrowserRect,
  type BrowserViewBoundsUpdate,
  type PreviewTabState,
} from './host-types'
import { setupBrowserClipIPC } from './ipc-clip'
import { setupBrowserClipDraggedTabIPC } from './ipc-clip-dragged-tab'
import { setupBrowserContentStudyIPC } from './ipc-content-study-dragged-tab'
import { setupBrowserDataIPC } from './ipc-data'
import { setupBrowserFastCardIPC } from './ipc-fastcard'
import { setupBrowserShellIPC } from './ipc-shell'
import { BrowserPreviewService } from './preview-service'
import { BrowserPageBackgroundService } from './page-background-service'
import { BrowserSessionPolicyService } from './session-policy-service'
import { BrowserTabLifecycleService } from './tab-lifecycle-service'
import { type BrowserTabMetaRecord, BrowserTabMetaService } from './tab-meta-service'
import { BrowserTabShellService } from './tab-shell-service'
import { BrowserTaskPersistenceService } from './task-persistence-service'
import { BrowserUtilityMenuService } from './utility-menu-service'
import { BrowserWindowOpenService } from './window-open-service'
import {
  isAllowedBrowserURL,
  toOAuthCompatibleUserAgent,
} from './popup-policy'
import { BrowserVisibilityCommandState } from './visibility-command-state'
import type { BrowserUtilityMenuRequest } from '../../../shared/browser-utility-menu'

interface Tab extends BrowserTabMetaRecord {
  id: string
  url: string
  title: string
  domain: string
  favicon: string | null
  owner: BrowserTabOwner
  required: boolean
  activity: BrowserTabActivity
  lastAuditedAt: number | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error: string | null
  view?: BrowserHostView
}

export type BrowserTabOwner = 'manual' | 'agent'
export type BrowserTabActivity = 'idle' | 'running' | 'attention'

function extractBrowserDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}


// Re-export for use by tools module
export { isAllowedBrowserURL }

/**
 * BrowserController — programmatic API for browser tab management.
 * Extracted from the closure-based setupBrowserIPC so that other modules
 * (e.g. tool-executor) can access BrowserView instances directly.
 */
export class BrowserController {
  tabs = new Map<string, Tab>()
  activeTabId: string | null = null
  splitTabId: string | null = null
  tabCounter = 0
  viewBounds: BrowserRect = { x: 0, y: 0, width: 800, height: 600 }
  splitViewBounds: BrowserRect = { x: 0, y: 0, width: 800, height: 600 }
  previewBounds: BrowserRect = { x: 0, y: 0, width: 800, height: 600 }
  private readonly browserVisibilityState = new BrowserVisibilityCommandState()
  private readonly browserHostKind: BrowserHostKind
  private mainWindow: BrowserWindow
  private useMock: boolean
  private popupManager: AuthPopupManager
  private readonly browserUserAgent: string
  private readonly dataService: BrowserDataService
  private readonly downloadService: BrowserDownloadService
  private readonly diagnosticsService: BrowserDiagnosticsService
  private readonly previewService: BrowserPreviewService
  private readonly contextMenuService: BrowserContextMenuService
  private readonly bookmarkTransferService: BrowserBookmarkTransferService
  private readonly hostLayoutService: BrowserHostLayoutService
  private readonly pageBackgroundService: BrowserPageBackgroundService
  private readonly automationService: BrowserAutomationService
  private readonly capabilityService: BrowserCapabilityService
  private readonly contentTaskRunner: BrowserContentTaskRunner
  private readonly tabLifecycleService: BrowserTabLifecycleService
  private readonly tabMetaService: BrowserTabMetaService<Tab>
  private readonly tabShellService: BrowserTabShellService
  private readonly sessionPolicyService: BrowserSessionPolicyService
  private readonly appShortcutBridgeService: BrowserAppShortcutBridgeService
  private readonly utilityMenuService: BrowserUtilityMenuService
  private readonly windowOpenService: BrowserWindowOpenService

  constructor(mainWindow: BrowserWindow, useMock = false) {
    this.mainWindow = mainWindow
    this.useMock = useMock
    this.browserHostKind = this.resolveBrowserHostKind()
    this.browserUserAgent = toOAuthCompatibleUserAgent(mainWindow.webContents.getUserAgent())
    this.dataService = new BrowserDataService()
    this.downloadService = new BrowserDownloadService({
      dataService: this.dataService,
      sendToRenderer: (channel, data) => this.sendToRenderer(channel, data),
    })
    this.diagnosticsService = new BrowserDiagnosticsService()
    this.hostLayoutService = new BrowserHostLayoutService(mainWindow, this.browserHostKind)
    this.pageBackgroundService = new BrowserPageBackgroundService((message) => this.logBrowserDiag(message))
    this.appShortcutBridgeService = new BrowserAppShortcutBridgeService({
      sendToRenderer: (channel, data) => this.sendToRenderer(channel, data),
    })
    this.popupManager = new AuthPopupManager(
      mainWindow,
      (url) => {
        void this.createTab(url).catch((error) => {
          this.logBrowserDiag(`[browser-v3][popup] create tab failed: ${String(error)}`)
          shell.openExternal(url)
        })
      },
      (message) => this.logBrowserDiag(message),
      this.browserUserAgent,
    )
    this.contextMenuService = new BrowserContextMenuService({
      mainWindow,
      isAllowedUrl: (url) => isAllowedBrowserURL(url),
      createTab: (url) => this.createTab(url),
      getTabIdForWebContents: (webContents) => this.getTabIdForWebContents(webContents.id),
      sendToRenderer: (channel, data) => this.sendToRenderer(channel, data),
      logBrowserDiag: (message) => this.logBrowserDiag(message),
    })
    this.bookmarkTransferService = new BrowserBookmarkTransferService({
      mainWindow,
      isAllowedUrl: (url) => isAllowedBrowserURL(url),
      addBookmark: (url, title) => this.dataService.addBookmark(url, title),
      isBookmarked: (url) => this.dataService.isBookmarked(url),
      getBookmarks: () => this.dataService.getBookmarks(),
      sendToRenderer: (channel, data) => this.sendToRenderer(channel, data),
    })
    this.previewService = new BrowserPreviewService({
      useMock: this.useMock,
      browserUserAgent: this.browserUserAgent,
      createHost: (partition) => this.createHost(partition),
      resetPageBackground: (view) => this.pageBackgroundService.reset(view),
      syncPageBackground: (view) => this.pageBackgroundService.sync(view),
      showHost: (view, bounds) => this.showHost(view, bounds),
      hideHost: (view) => this.hideHost(view),
      detachHost: (view) => this.detachHost(view),
      applyPreviewBounds: (view) => this.applyPreviewBounds(view),
      getPreviewBounds: () => this.previewBounds,
      setPreviewBounds: (bounds) => {
        this.previewBounds = bounds
      },
      sendToRenderer: (channel, data) => this.sendToRenderer(channel, data),
      logBrowserDiag: (message) => this.logBrowserDiag(message),
      bindPopup: (webContents) => this.popupManager.bindWindow(webContents),
      installContextMenu: (webContents) => this.contextMenuService.install(webContents),
      ensureDownloadSession: (targetSession) => this.downloadService.ensureRegistered(targetSession),
      handleWindowOpen: (details, source, sourceContentsId) => this.handleWindowOpen(details, source, sourceContentsId),
      hideActiveTab: () => this.hideActiveTabHost(),
      restoreActiveTab: () => this.restoreActiveTabHost(),
    })
    this.automationService = new BrowserAutomationService({
      resolveTabView: (tabId) => this.resolveTabView(tabId),
      createBrowserError: (code, message) => this.createBrowserError(code, message),
      getViewBounds: () => this.viewBounds,
    })
    this.capabilityService = new BrowserCapabilityService({
      openForCaptureTarget: (url) => this.openForCaptureTarget(url),
      createTab: (url) => this.createTab(url),
      navigate: (tabId, url) => this.navigate(tabId, url),
      getActiveTab: () => this.getActiveTab(),
      executeJS: (tabId, code) => this.executeJS(tabId, code),
      captureLiveTabPage: (url, options) => this.captureLiveTabPage(url, options),
      captureBackgroundPage: (url, options) => this.captureBackgroundPage(url, options),
    })
    this.contentTaskRunner = new BrowserContentTaskRunner(
      this.capabilityService,
      new BrowserTaskPersistenceService(),
    )
    this.tabMetaService = new BrowserTabMetaService({
      tabs: this.tabs,
      getActiveTabId: () => this.activeTabId,
      sendToRenderer: (channel, data) => this.sendToRenderer(channel, data),
    })
    this.tabLifecycleService = new BrowserTabLifecycleService({
      tabs: this.tabs,
      getActiveTabId: () => this.activeTabId,
      setActiveTabId: (tabId) => {
        this.activeTabId = tabId
      },
      getNextTabId: () => `tab-${++this.tabCounter}`,
      getViewBounds: () => this.viewBounds,
      shouldPresentHosts: () => this.browserVisibilityState.shouldPresentHosts(),
      isAllowedUrl: (url) => isAllowedBrowserURL(url, { allowLocalHtml: true }),
      extractDomain: (url) => extractBrowserDomain(url),
      createHost: (partition) => this.createHost(partition),
      resetPageBackground: (view) => this.pageBackgroundService.reset(view),
      syncPageBackground: (view) => this.pageBackgroundService.sync(view),
      applyBounds: (view) => this.applyBounds(view, 'settled'),
      detachHost: (view) => this.detachHost(view),
      showHost: (view, bounds) => this.showHost(view, bounds),
      sendToRenderer: (channel, data) => this.sendToRenderer(channel, data),
      emitTabMeta: (tabId) => this.emitTabMeta(tabId),
      logBrowserDiag: (message) => this.logBrowserDiag(message),
      bindPopup: (webContents) => this.popupManager.bindWindow(webContents),
      bindAppShortcutBridge: (webContents) => this.bindAppShortcutBridge(webContents),
      installContextMenu: (webContents) => this.contextMenuService.install(webContents),
      handleWindowOpen: (details, source, sourceContentsId) => this.handleWindowOpen(details, source, sourceContentsId),
      ensureDownloadSession: (targetSession) => this.downloadService.ensureRegistered(targetSession),
      addHistoryEntry: (url, title, metadata) => this.dataService.addHistoryEntry(url, title, metadata),
      browserUserAgent: this.browserUserAgent,
      useMock: this.useMock,
    })
    this.tabShellService = new BrowserTabShellService({
      tabs: this.tabs,
      getActiveTabId: () => this.activeTabId,
      setActiveTabId: (tabId) => {
        this.activeTabId = tabId
      },
      getSplitTabId: () => this.splitTabId,
      setSplitTabId: (tabId) => {
        this.splitTabId = tabId
      },
      getViewBounds: () => this.viewBounds,
      setViewBounds: (bounds) => {
        this.viewBounds = bounds
      },
      getSplitViewBounds: () => this.splitViewBounds,
      setSplitViewBounds: (bounds) => {
        this.splitViewBounds = bounds
      },
      shouldPresentHosts: () => this.browserVisibilityState.shouldPresentHosts(),
      isAllowedUrl: (url) => isAllowedBrowserURL(url, { allowLocalHtml: true }),
      createTab: (url) => this.createTab(url),
      detachHost: (view) => this.detachHost(view),
      showHost: (view, bounds) => this.showHost(view, bounds),
      applyBounds: (view, syncMode, bounds) => this.applyBounds(view, syncMode, bounds),
      hideHost: (view) => this.hideHost(view),
      detachPreviewView: () => this.detachPreviewView(),
      restoreActiveTabHost: () => this.restoreActiveTabHost(),
    })
    this.sessionPolicyService = new BrowserSessionPolicyService({
      dataService: this.dataService,
      sendToRenderer: (channel, data) => this.sendToRenderer(channel, data),
      resolveOriginDomain: (webContentsId) => this.resolveOriginDomainForWebContentsId(webContentsId),
      isPreviewWebContentsId: (webContentsId) => this.previewService.matchesWebContentsId(webContentsId),
      getMainWindow: () => (this.mainWindow && !this.mainWindow.isDestroyed() ? this.mainWindow : null),
    })
    this.utilityMenuService = new BrowserUtilityMenuService({
      mainWindow,
      getBookmarks: () => this.dataService.getBookmarks(),
      getDownloads: () => this.dataService.getDownloads(),
      getHistory: (limit) => this.dataService.getHistory(limit),
      getAdblockState: () => this.sessionPolicyService.getAdblockState(),
      isBookmarked: (url) => this.dataService.isBookmarked(url),
      addBookmark: (url, title) => {
        this.dataService.addBookmark(url, title)
      },
      removeBookmarkByUrl: (url) => this.dataService.removeBookmarkByUrl(url),
      importBookmarksFromDialog: () => this.importBookmarksFromDialog(),
      exportBookmarksToDialog: () => this.exportBookmarksToDialog(),
      clearHistory: () => this.dataService.clearHistory(),
      clearDownloads: () => this.dataService.clearDownloads(),
      navigateToUrl: async (url) => {
        if (this.activeTabId) {
          await this.navigate(this.activeTabId, url)
          return
        }
        await this.createTab(url)
      },
      setAdblockEnabled: (enabled) => {
        this.sessionPolicyService.setAdblockEnabled(enabled, 'all')
      },
      toggleAdblockDomain: (domain) => {
        this.sessionPolicyService.toggleAdblockDomain(domain)
      },
      printCurrentTab: () => {
        const activeTab = this.getActiveTab()
        activeTab?.view?.webContents.print()
      },
      openExternal: (url) => {
        shell.openExternal(url)
      },
      sendToRenderer: (channel, data) => this.sendToRenderer(channel, data),
    })
    this.sessionPolicyService.setupBrowserSessionPolicies()
    this.windowOpenService = new BrowserWindowOpenService({
      popupManager: this.popupManager,
      requestNewTab: (url) => {
        this.sendToRenderer('browser:newTabRequest', url)
      },
      logBrowserDiag: (message) => this.logBrowserDiag(message),
      openExternal: (url) => {
        shell.openExternal(url)
      },
    })
    void this.contentTaskRunner.resumePendingTasks()
  }

  private logBrowserDiag(message: string): void {
    this.diagnosticsService.log(message)
  }

  // ── Internal helpers ──────────────────────────────────────────────

  private resolveBrowserHostKind(): BrowserHostKind {
    const envRaw = process.env.READY_BROWSER_HOST_DRIVER
    const normalizedEnv = typeof envRaw === 'string' ? envRaw.trim().toLowerCase() : ''
    if (normalizedEnv === 'browserview') return 'browserView'
    if (normalizedEnv === 'webcontentsview') return 'webContentsView'
    try {
      const raw = String(this.dataService.getSetting('browser_host_driver') || '').trim().toLowerCase()
      if (raw === 'browserview') return 'browserView'
      if (raw === 'webcontentsview') return 'webContentsView'
    } catch {
      // ignore persisted setting failures
    }
    return 'webContentsView'
  }

  private resolveOriginDomainForWebContentsId(webContentsId?: number): string {
    if (!webContentsId) return ''
    for (const tab of this.tabs.values()) {
      if (tab.view?.webContents.id === webContentsId) {
        return tab.domain || extractBrowserDomain(tab.url)
      }
    }
    if (this.previewService.matchesWebContentsId(webContentsId)) {
      return extractBrowserDomain(this.previewService.getUrl())
    }
    return ''
  }

  private getTabIdForWebContents(webContentsId?: number): string | null {
    if (!webContentsId) return null
    for (const tab of this.tabs.values()) {
      if (tab.view?.webContents.id === webContentsId) return tab.id
    }
    return null
  }

  private emitTabMeta(tabId: string): void {
    this.tabMetaService.emitTabMeta(tabId)
  }

  attachWindow(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow
    this.hostLayoutService.setMainWindow(mainWindow)
    this.popupManager.setMainWindow(mainWindow)
    this.contextMenuService.setMainWindow(mainWindow)
    this.bookmarkTransferService.setMainWindow(mainWindow)
    this.utilityMenuService.setMainWindow(mainWindow)
  }

  private createHost(partition: string): BrowserHostView {
    const view = this.hostLayoutService.createHost(partition)
    this.pageBackgroundService.reset(view)
    return view
  }

  detachHost(view: BrowserHostView): void {
    this.hostLayoutService.detachHost(view)
  }

  showHost(view: BrowserHostView, bounds: { x: number; y: number; width: number; height: number }): void {
    this.hostLayoutService.showHost(view, bounds)
  }

  hideHost(view: BrowserHostView): void {
    this.hostLayoutService.hideHost(view)
  }

  sendToRenderer(channel: string, data: unknown): void {
    if (!this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data)
    }
  }

  getMainWindow(): BrowserWindow | null {
    return this.mainWindow.isDestroyed() ? null : this.mainWindow
  }

  applyBounds(
    view: BrowserHostView,
    syncMode: BrowserBoundsSyncMode = 'settled',
    bounds: BrowserRect = this.viewBounds,
  ): void {
    this.hostLayoutService.applyBounds(view, bounds, syncMode)
  }

  applyPreviewBounds(view: BrowserHostView): void {
    this.hostLayoutService.applyBounds(view, this.previewBounds, 'settled')
  }

  private hideActiveTabHost(): boolean {
    if (!this.activeTabId) return false
    const activeTab = this.tabs.get(this.activeTabId)
    if (!activeTab?.view) return false
    if (!this.hostLayoutService.isHostVisible(activeTab.view)) return false
    this.hideHost(activeTab.view)
    return true
  }

  private restoreActiveTabHost(): void {
    if (!this.activeTabId) return
    const activeTab = this.tabs.get(this.activeTabId)
    if (activeTab?.view) {
      this.showHost(activeTab.view, this.viewBounds)
      this.applyBounds(activeTab.view, 'settled')
    }
  }

  private clearSplitTabHost(): void {
    if (!this.splitTabId) return
    const splitTab = this.tabs.get(this.splitTabId)
    if (splitTab?.view) {
      this.detachHost(splitTab.view)
    }
    this.splitTabId = null
  }

  private bindAppShortcutBridge(webContents: Electron.WebContents): void {
    this.appShortcutBridgeService.bind(webContents)
  }

  getActiveTab(): Tab | undefined {
    if (!this.activeTabId) return undefined
    return this.tabs.get(this.activeTabId)
  }

  private findReusableTabForCapture(targetUrl: string): Tab | null {
    const candidateId = findReusableCaptureTabId(
      targetUrl,
      Array.from(this.tabs.values())
        .filter((tab) => tab.view)
        .map((tab) => ({
          id: tab.id,
          url: tab.view?.webContents.getURL() || tab.url,
        })),
      this.activeTabId,
    )
    return candidateId ? this.tabs.get(candidateId) || null : null
  }

  private async loadWebContentsURL(
    webContents: Electron.WebContents,
    url: string,
    timeoutMs: number,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => finish(new Error(`Timed out loading ${url}`)), timeoutMs)

      const cleanup = () => {
        clearTimeout(timer)
        webContents.removeListener('did-stop-loading', handleStop)
        webContents.removeListener('did-fail-load', handleFail as never)
      }

      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        cleanup()
        if (error) reject(error)
        else resolve()
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

      webContents.on('did-stop-loading', handleStop)
      webContents.on('did-fail-load', handleFail as never)
      void webContents.loadURL(url).catch((error) => {
        finish(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  updateTabRuntimeState(
    tabId: string | null,
    updates: Partial<Pick<Tab, 'owner' | 'required' | 'activity' | 'lastAuditedAt'>>,
  ): Tab | null {
    const resolvedTabId = tabId || this.activeTabId
    if (!resolvedTabId) return null
    const tab = this.tabs.get(resolvedTabId)
    if (!tab) return null
    if (updates.owner !== undefined) tab.owner = updates.owner
    if (updates.required !== undefined) tab.required = updates.required
    if (updates.activity !== undefined) tab.activity = updates.activity
    if (updates.lastAuditedAt !== undefined) tab.lastAuditedAt = updates.lastAuditedAt
    this.emitTabMeta(resolvedTabId)
    return tab
  }

  getAdblockState(): BrowserAdblockState {
    return this.sessionPolicyService.getAdblockState()
  }

  setAdblockEnabled(enabled: boolean, scope: 'main' | 'preview' | 'all' = 'all'): BrowserAdblockState {
    return this.sessionPolicyService.setAdblockEnabled(enabled, scope)
  }

  toggleAdblockDomain(domain: string): BrowserAdblockState {
    return this.sessionPolicyService.toggleAdblockDomain(domain)
  }

  getTabList(): Array<{
    id: string
    url: string
    title: string
    domain: string
    favicon: string | null
    owner: BrowserTabOwner
    required: boolean
    activity: BrowserTabActivity
    lastAuditedAt: number | null
    loading: boolean
    canGoBack: boolean
    canGoForward: boolean
    error: string | null
    active: boolean
  }> {
    return this.tabMetaService.getTabList() as Array<{
      id: string
      url: string
      title: string
      domain: string
      favicon: string | null
      owner: BrowserTabOwner
      required: boolean
      activity: BrowserTabActivity
      lastAuditedAt: number | null
      loading: boolean
      canGoBack: boolean
      canGoForward: boolean
      error: string | null
      active: boolean
    }>
  }

  getDiagnostics(): {
    hostDriver: BrowserHostKind
    tabCount: number
    activeTabId: string | null
    diagnosticsLogPath: string
    recentLogs: string[]
    preview: PreviewTabState
    currentTask: BrowserTaskDiagnosticsSnapshot | null
    pageState: BrowserPageDiagnosticsSnapshot | null
    continuity: BrowserContinuityDiagnosticsSnapshot | null
    lastFailure: { reason: string; updatedAt: string } | null
    availableActions: string[]
  } {
    const agentSnapshot = this.diagnosticsService.getAgentSnapshot()
    return {
      hostDriver: this.browserHostKind,
      tabCount: this.tabs.size,
      activeTabId: this.activeTabId,
      diagnosticsLogPath: BROWSER_DIAGNOSTICS_LOG_PATH,
      recentLogs: this.diagnosticsService.getRecentEntries(16),
      preview: this.previewService.getState(),
      currentTask: agentSnapshot.currentTask,
      pageState: agentSnapshot.pageState,
      continuity: agentSnapshot.continuity,
      lastFailure: agentSnapshot.lastFailure,
      availableActions: agentSnapshot.availableActions,
    }
  }

  reportAgentTaskDiagnostics(snapshot: BrowserTaskDiagnosticsSnapshot | null): void {
    this.diagnosticsService.recordTask(snapshot)
  }

  reportAgentPageDiagnostics(snapshot: BrowserPageDiagnosticsSnapshot | null): void {
    this.diagnosticsService.recordPageState(snapshot)
  }

  reportAgentContinuityDiagnostics(snapshot: BrowserContinuityDiagnosticsSnapshot | null): void {
    this.diagnosticsService.recordContinuity(snapshot)
  }

  async getTabContext(tabId?: string | null): Promise<BrowserTabContextData> {
    return this.automationService.getTabContext(tabId)
  }

  async waitForCondition(
    tabId: string | null,
    options: BrowserWaitForConditionOptions,
  ): Promise<{ matched: boolean; elapsedMs: number; value?: unknown }> {
    return this.capabilityService.waitForCondition(tabId, options)
  }

  async extractStructured(
    tabId: string | null,
    options: BrowserExtractStructuredOptions,
  ): Promise<BrowserExtractStructuredResult> {
    return this.capabilityService.extractStructured(tabId, options)
  }

  async extractStructuredFromUrl(
    url: string,
    options: BrowserExtractStructuredOptions,
  ): Promise<BrowserExtractStructuredResult> {
    return this.capabilityService.extractStructuredFromUrl(url, options)
  }

  async scrollCollect(
    tabId: string | null,
    options: BrowserScrollCollectOptions,
  ): Promise<BrowserScrollCollectResult> {
    return this.capabilityService.scrollCollect(tabId, options)
  }

  aggregateResults(items: BrowserStructuredItem[], options?: BrowserAggregateOptions): BrowserStructuredItem[] {
    return this.capabilityService.aggregateResults(items, options)
  }

  async startTask(request: BrowserStartTaskRequest): Promise<BrowserCapabilityTaskHandle> {
    return this.contentTaskRunner.startTask(request)
  }

  async getTask(taskId: string): Promise<BrowserCapabilityTaskHandle | null> {
    return this.contentTaskRunner.getTask(taskId)
  }

  async resumeTask(taskId: string): Promise<BrowserCapabilityTaskHandle | null> {
    return this.contentTaskRunner.resumeTask(taskId)
  }

  async cancelTask(taskId: string): Promise<BrowserCapabilityTaskHandle | null> {
    return this.contentTaskRunner.cancelTask(taskId)
  }

  private createBrowserError(code: BrowserCDPErrorCode, message: string): Error {
    const error = new Error(message)
    ;(error as Error & { code?: BrowserCDPErrorCode }).code = code
    return error
  }

  private resolveTabView(tabId: string | null): { tabId: string; tab: Tab; view: BrowserHostView } {
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

  private handleWindowOpen(
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
    return this.windowOpenService.handle(details, source, sourceContentsId)
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

  async previewOpen(url: string): Promise<{ success: boolean; error?: string }> {
    return this.previewService.open(url)
  }

  async previewNavigate(url: string): Promise<{ success: boolean; error?: string }> {
    return this.previewService.navigate(url)
  }

  previewGoBack(): { success: boolean; error?: string } {
    return this.previewService.goBack()
  }

  previewGoForward(): { success: boolean; error?: string } {
    return this.previewService.goForward()
  }

  previewReload(): { success: boolean; error?: string } {
    return this.previewService.reload()
  }

  previewUpdateBounds(bounds: { x: number; y: number; width: number; height: number }): { success: boolean } {
    return this.previewService.updateBounds(bounds)
  }

  previewClose(): { success: boolean } {
    return this.previewService.close()
  }

  previewGetState(): PreviewTabState {
    return this.previewService.getState()
  }

  detachPreviewView(): void {
    this.previewService.detach()
  }

  // ── Programmatic API (for tool calling, not IPC) ──────────────────

  /**
   * Create a new tab and navigate to URL. Returns the tab ID.
   */
  async createTab(url: string): Promise<{ success: boolean; tabId?: string; error?: string }> {
    this.clearSplitTabHost()
    return this.tabLifecycleService.createTab(url)
  }

  async openForCaptureTarget(
    url: string,
  ): Promise<{ success: boolean; tabId?: string; reused?: boolean; error?: string }> {
    if (!isAllowedBrowserURL(url)) {
      return { success: false, error: 'Blocked URL protocol. Only http: and https: are allowed.' }
    }

    const reusable = this.findReusableTabForCapture(url)
    if (!reusable?.id) {
      const created = await this.createTab(url)
      return created.success
        ? { success: true, tabId: created.tabId, reused: false }
        : { success: false, error: created.error }
    }

    const currentUrl = reusable.view?.webContents.getURL() || reusable.url
    if (currentUrl !== url) {
      const navigation = await this.navigate(reusable.id, url)
      if (!navigation.success) {
        return { success: false, error: navigation.error }
      }
    }

    const switched = this.switchTab(reusable.id)
    if (!switched.success) {
      return { success: false, error: switched.error }
    }

    return { success: true, tabId: reusable.id, reused: true }
  }

  hasReusableCaptureTarget(url: string): boolean {
    return !!this.findReusableTabForCapture(url)
  }

  /**
   * Attach Chrome DevTools Protocol debugger to a tab's webContents.
   * Safe to call repeatedly.
   */
  async ensureDebugger(tabId: string | null): Promise<{ tabId: string }> {
    return this.automationService.ensureDebugger(tabId)
  }

  /**
   * Resolve viewport metrics in CSS pixels.
   * Prefers window.visualViewport and falls back to CDP layout metrics.
   */
  async getViewportMetrics(tabId: string | null): Promise<BrowserViewportMetrics> {
    return this.automationService.getViewportMetrics(tabId)
  }

  /**
   * Map normalized coordinates (0..999) into CSS pixel coordinates in viewport.
   */
  async normalizedToCss(tabId: string | null, x: number, y: number): Promise<{
    x: number
    y: number
    width: number
    height: number
  }> {
    return this.automationService.normalizedToCss(tabId, x, y)
  }

  /**
   * Dispatch low-level mouse event through CDP.
   */
  async dispatchMouse(tabId: string | null, payload: BrowserMouseEventPayload): Promise<void> {
    return this.automationService.dispatchMouse(tabId, payload)
  }

  /**
   * Dispatch low-level keyboard event through CDP.
   */
  async dispatchKey(tabId: string | null, payload: BrowserKeyEventPayload): Promise<void> {
    return this.automationService.dispatchKey(tabId, payload)
  }

  /**
   * Insert text at current focus target via CDP.
   */
  async typeTextDirectly(
    tabId: string | null,
    text: string,
    options?: { useShiftEnterForNewline?: boolean },
  ): Promise<void> {
    return this.automationService.typeTextDirectly(tabId, text, options)
  }

  /**
   * Take screenshot in different modes.
   */
  async screenshotAdvanced(tabId: string | null, options?: BrowserScreenshotOptions): Promise<string> {
    return this.automationService.screenshotAdvanced(tabId, options)
  }

  /**
   * Execute JavaScript in a tab's webContents. Runs in BrowserView sandbox (isolated from Node).
   */
  async executeJS(tabId: string | null, code: string): Promise<unknown> {
    return this.automationService.executeJS(tabId, code)
  }

  /**
   * Get the plain text content of a page (document.body.innerText), truncated to 30K chars.
   */
  async getPageContent(tabId: string | null): Promise<string> {
    return this.automationService.getPageContent(tabId)
  }

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
      webPreferences: {
        partition: 'persist:browser',
        nodeIntegration: false,
        contextIsolation: true,
        spellcheck: true,
        webSecurity: true,
        backgroundThrottling: false,
      },
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

  async captureFromUrl(
    url: string,
    options: {
      customScript: string
      timeoutMs?: number
      settleMs?: number
      preferReuse?: boolean
    },
  ): Promise<unknown | null> {
    return this.capabilityService.captureFromUrl(url, options)
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
      target?: string
      x?: number
      y?: number
    },
  ): Promise<{ ok: boolean; targetDescription: string; inputFound: boolean; filesAssigned?: boolean; assignedFileNames?: string[] }> {
    return this.automationService.setFileInputFiles(tabId, payload)
  }

  /**
   * Navigate the active tab (or specified tab) to a URL.
   */
  async navigate(tabId: string | null, url: string): Promise<{ success: boolean; error?: string }> {
    return this.tabShellService.navigate(tabId, url)
  }

  /**
   * Go back in the active tab.
   */
  goBack(tabId: string | null): { success: boolean; error?: string } {
    return this.tabShellService.goBack(tabId)
  }

  goForward(tabId: string | null): { success: boolean; error?: string } {
    return this.tabShellService.goForward(tabId)
  }

  reload(tabId: string | null): { success: boolean; error?: string } {
    return this.tabShellService.reload(tabId)
  }

  closeTab(tabId: string): { success: boolean; error?: string } {
    return this.tabShellService.closeTab(tabId)
  }

  reorderTabs(tabIds: string[]): { success: boolean; error?: string } {
    const seen = new Set<string>()
    const reordered = new Map<string, Tab>()

    for (const rawId of tabIds) {
      const tabId = String(rawId || '')
      if (!tabId || seen.has(tabId)) continue
      const tab = this.tabs.get(tabId)
      if (!tab) continue
      reordered.set(tabId, tab)
      seen.add(tabId)
    }

    for (const [tabId, tab] of this.tabs.entries()) {
      if (seen.has(tabId)) continue
      reordered.set(tabId, tab)
    }

    this.tabs.clear()
    for (const [tabId, tab] of reordered.entries()) {
      this.tabs.set(tabId, tab)
    }
    return { success: true }
  }

  switchTab(tabId: string): {
    success: boolean
    error?: string
    url?: string
    title?: string
    domain?: string
    favicon?: string | null
    owner?: BrowserTabOwner
    required?: boolean
    activity?: BrowserTabActivity
    lastAuditedAt?: number | null
    canGoBack?: boolean
    canGoForward?: boolean
  } {
    return this.tabShellService.switchTab(tabId)
  }

  updateViewBounds(bounds: BrowserViewBoundsUpdate): { success: boolean } {
    return this.tabShellService.updateViewBounds(bounds)
  }

  hideAllHosts(payload?: { requestId?: number }): { success: boolean } {
    if (!this.browserVisibilityState.applyHide(payload?.requestId)) {
      return { success: true }
    }
    this.logBrowserDiag(`[browser-host][visibility] hideAll request=${String(payload?.requestId || 'none')}`)
    return this.tabShellService.hideAllHosts()
  }

  hideActiveHost(payload?: { requestId?: number }): { success: boolean } {
    if (!this.browserVisibilityState.applyHide(payload?.requestId)) {
      return { success: true }
    }
    this.logBrowserDiag(`[browser-host][visibility] hideActive request=${String(payload?.requestId || 'none')}`)
    return this.tabShellService.hideActiveHostOnly()
  }

  showActiveHost(payload?: { requestId?: number }): { success: boolean } {
    if (!this.browserVisibilityState.applyShow(payload?.requestId)) {
      return { success: true }
    }
    this.logBrowserDiag(`[browser-host][visibility] showActive request=${String(payload?.requestId || 'none')}`)
    return this.tabShellService.showActiveHost()
  }

  /**
   * Stage X4 PR-shell-1 — single intent boundary. Renderer pushes
   * declarative BrowserViewIntent through `browser:intent`; this method
   * is the only writer onto `tabShellService.applyIntent`. For
   * `hide-all` and `show` intents we go through the same visibility
   * monotonic-id gate used by the legacy preload endpoints so that ack
   * ordering remains intact for PR-shell-2.
   */
  applyBrowserViewIntent(intent: import('../../../shared/browser-view-intent').BrowserViewIntent): { success: boolean } {
    if (intent.kind === 'hide-all') {
      if (!this.browserVisibilityState.applyHide(intent.intentId)) {
        return { success: true }
      }
      this.logBrowserDiag(`[browser-host][intent] hide-all intentId=${intent.intentId} reason=${intent.reason}`)
      return this.tabShellService.applyIntent(intent)
    }
    if (intent.kind === 'show') {
      if (!this.browserVisibilityState.applyShow(intent.intentId)) {
        return { success: true }
      }
      this.logBrowserDiag(`[browser-host][intent] show intentId=${intent.intentId} tab=${intent.tabId} reason=${intent.reason}`)
      return this.tabShellService.applyIntent(intent)
    }
    if (intent.kind === 'hide') {
      this.logBrowserDiag(`[browser-host][intent] hide intentId=${intent.intentId} tab=${intent.tabId} reason=${intent.reason}`)
      return this.tabShellService.applyIntent(intent)
    }
    if (intent.kind === 'set-bounds') {
      this.logBrowserDiag(`[browser-host][intent] set-bounds intentId=${intent.intentId} tab=${intent.tabId} x=${intent.bounds.x} y=${intent.bounds.y} w=${intent.bounds.w} h=${intent.bounds.h}`)
      return this.tabShellService.applyIntent(intent)
    }
    if (intent.kind === 'secondary-set-bounds') {
      this.logBrowserDiag(`[browser-host][intent] secondary-set-bounds intentId=${intent.intentId} tab=${intent.tabId} x=${intent.bounds.x} y=${intent.bounds.y} w=${intent.bounds.w} h=${intent.bounds.h}`)
      return this.tabShellService.applyIntent(intent)
    }
    return { success: false }
  }

  async fitActiveTabToBounds(tabId?: string | null): Promise<{ success: boolean; zoomFactor?: number; error?: string }> {
    try {
      const { view } = this.resolveTabView(tabId || null)
      const metrics = await view.webContents.executeJavaScript(`(() => {
        const root = document.documentElement
        const body = document.body
        if (!root || !body) {
          return { viewportWidth: 0, contentWidth: 0 }
        }

        const viewportWidth = Math.max(window.innerWidth || 0, root.clientWidth || 0)
        const contentWidth = Math.max(
          root.scrollWidth || 0,
          body.scrollWidth || 0,
          root.offsetWidth || 0,
          body.offsetWidth || 0,
          ...Array.from(document.querySelectorAll('body *'))
            .slice(0, 240)
            .map((node) => {
              if (!(node instanceof HTMLElement)) return 0
              const style = window.getComputedStyle(node)
              if (style.display === 'none' || style.visibility === 'hidden') return 0
              const rect = node.getBoundingClientRect()
              return rect.width > 40 && rect.height > 20 ? rect.right : 0
            }),
        )

        return { viewportWidth, contentWidth }
      })()`, true) as { viewportWidth?: number; contentWidth?: number }

      const viewportWidth = Math.max(0, Number(metrics?.viewportWidth || 0))
      const contentWidth = Math.max(0, Number(metrics?.contentWidth || 0))
      let zoomFactor = 1

      if (viewportWidth > 0 && contentWidth > viewportWidth + 24) {
        zoomFactor = Math.max(0.72, Math.min(1, viewportWidth / contentWidth))
      }

      view.webContents.setZoomFactor(zoomFactor)

      return { success: true, zoomFactor }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

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
    return this.downloadService.downloadUrlToDirectory(session.fromPartition('persist:browser'), payload)
  }
}

export function setupBrowserIPC(
  mainWindow: BrowserWindow,
  useMock = false,
  options?: { preloadPath?: string; rendererFile?: string },
): BrowserController {
  const controller = new BrowserController(mainWindow, useMock)
  const browserDataService = new BrowserDataService()
  setupBrowserShellIPC(controller)
  setupBrowserDataIPC(controller, browserDataService)
  setupBrowserClipIPC({
    getActiveTab: () => {
      const active = controller.getActiveTab()
      if (!active) return undefined
      return {
        id: active.id,
        url: active.url,
        title: active.title,
        domain: active.domain,
      }
    },
    getTab: (tabId) => {
      const tab = controller.tabs.get(tabId)
      if (!tab) return undefined
      return {
        id: tab.id,
        url: tab.url,
        title: tab.title,
        domain: tab.domain,
      }
    },
    executeJS: (tabId, code) => controller.executeJS(tabId, code),
  })
  setupBrowserClipDraggedTabIPC({
    sendToRenderer: (channel, data) => controller.sendToRenderer(channel, data),
  })
  setupBrowserContentStudyIPC({
    sendToRenderer: (channel, data) => controller.sendToRenderer(channel, data),
  })
  setupBrowserFastCardIPC({
    getMainWindow: () => controller.getMainWindow(),
    preloadPath: options?.preloadPath || join(__dirname, '../preload/index.mjs'),
    rendererFile: options?.rendererFile || join(__dirname, '../renderer/index.html'),
  })

  return controller
}
