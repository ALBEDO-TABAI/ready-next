import { BrowserWindow, ipcMain, shell, session } from 'electron'
import { join } from 'node:path'
import { BrowserAppShortcutBridgeService } from './app-shortcut-service'
import { BrowserAutomationService } from './automation-service'
import { BrowserCapabilityService } from './capability-service'
import { BrowserCdpSessionService } from './cdp-session-service'
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
  BrowserCapabilityTaskKind,
} from './capability-types'
import { BrowserContentTaskRunner, type BrowserSiteCardLearningSink, type BrowserTaskProjectionSink } from './content-task-runner'
import { registerWaitingHumanBrowserTaskResumePort } from './task-event-bridge'
import { ScopedBrowserFacade } from './scoped-browser-facade'
import type { BrowserCollectionTarget } from './collection-targets'
import { AgentTabControlGate } from './agent-tab-control-gate'
import { getBrowserWriteLeaseService } from './agent-browser-lease-singleton'
import { agentBrowserError, isAgentBrowserError, type AgentBrowserStructuredError, type AgentBrowserSurface } from './agent-browser-errors'
import {
  isUserViewKeyboardTakeoverInput,
  recordUserViewTakeoverSignal,
  shouldRecordUserViewTabSwitch,
} from './user-view-takeover-bridge'
import { isHighControlPlatformText } from '../../../shared/browser-collection-intent'
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
import { findReusableCaptureTabId } from './capture-url-utils'
import { BrowserDataService, type BrowserAdblockState } from './data-service'
import { BrowserDownloadService, type BrowserDownloadUrlToDirectoryPayload, type BrowserDownloadUrlToDirectoryResult } from './download-service'
import { BrowserNetworkObserverService, type BrowserNetworkObserverHandle, type BrowserNetworkObserverOptions } from './network-observer-service'
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
import { resolveBrowserHostKindFromConfig } from './host-kind-config'
import { setupBrowserClipIPC } from './ipc-clip'
import { setupBrowserClipDraggedTabIPC } from './ipc-clip-dragged-tab'
import { setupBrowserContentStudyIPC } from './ipc-content-study-dragged-tab'
import { setupBrowserDataIPC } from './ipc-data'
import { setupBrowserFastCardIPC } from './ipc-fastcard'
import { setupBrowserVerticalRailOverlayIPC } from './ipc-vertical-rail-overlay'
import { setupBrowserLockOverlayIPC } from './ipc-browser-lock-overlay'
import { setupBrowserShellIPC } from './ipc-shell'
import { setupBrowserSupervisionIPC } from './ipc-supervision'
import type { BrowserLeaseSupervisionSnapshot } from './ipc-supervision'
import { buildBrowserLeaseSupervisionSnapshot } from './browser-lease-supervision-snapshot'
import { BrowserPreviewService } from './preview-service'
import { BrowserPageBackgroundService } from './page-background-service'
import { BrowserSessionPolicyService } from './session-policy-service'
import { BrowserTabLifecycleService } from './tab-lifecycle-service'
import {
  downloadRemoteMediaDropUrls,
  scheduleRemoteMediaDropCleanup,
} from './remote-media-drop-cache'
import { type BrowserTabMetaRecord, BrowserTabMetaService } from './tab-meta-service'
import { BrowserTabShellService } from './tab-shell-service'
import { BrowserTaskPersistenceService } from './task-persistence-service'
import { BrowserUtilityMenuService } from './utility-menu-service'
import { BrowserWindowOpenService } from './window-open-service'
import { BrowserCollectionConsentStore, type BrowserCollectionConsentVia } from './browser-collection-consent'
import { buildCollectionHandoffPlanFromTask } from './collection-handoff'
import { resolveHighControlCollectionTarget, resolveSourceCollectionTarget } from './collection-routing'
import { withHtmlInCanvasWebPreferences } from '../app-control/html-in-canvas-feature'
import { getReadyBoardService } from '../board-engine/ipc-handler'
import {
  isAllowedBrowserURL,
  toOAuthCompatibleUserAgent,
} from './popup-policy'
import { BrowserVisibilityCommandState } from './visibility-command-state'
import {
  BrowserWorkflowSessionStore,
  type BrowserWorkflowSession,
} from './browser-workflow-session'
import type { BrowserUtilityMenuRequest } from '../../../shared/browser-utility-menu'
import { READY_BROWSER_BLANK_URL } from '../../../shared/browser-defaults'
import { parseBrowserLocalMediaDropUrl } from '../../../shared/browser-local-media-drop'

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
  private readonly frozenBoundsByTab = new Map<string, { bounds: BrowserRect; tokens: Set<string> }>()
  private readonly browserVisibilityState = new BrowserVisibilityCommandState()
  private readonly localMediaDropRuns = new Map<string, number>()
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
  private readonly cdpSessionService: BrowserCdpSessionService
  private readonly networkObserverService: BrowserNetworkObserverService
  private readonly automationService: BrowserAutomationService
  private readonly collectionConsentStore = new BrowserCollectionConsentStore()
  private readonly capabilityService: BrowserCapabilityService
  private readonly contentTaskRunner: BrowserContentTaskRunner
  /** Freeze-then-confirm supervision gate for the background agent tab (plan §3.6). */
  private readonly agentTabControlGate = new AgentTabControlGate()
  /** The dedicated background tab the collector sub-agent drives (plan §3.5/§3.9). */
  private agentTabId: string | null = null
  private foregroundAgentTabId: string | null = null
  private readonly workflowSessionStore = new BrowserWorkflowSessionStore()
  private releaseForegroundWorkflowBoundsLock: (() => void) | null = null
  private readonly tabLifecycleService: BrowserTabLifecycleService
  private readonly tabMetaService: BrowserTabMetaService<Tab>
  private readonly tabShellService: BrowserTabShellService
  private readonly sessionPolicyService: BrowserSessionPolicyService
  private readonly appShortcutBridgeService: BrowserAppShortcutBridgeService
  private readonly utilityMenuService: BrowserUtilityMenuService
  private readonly windowOpenService: BrowserWindowOpenService
  private readonly userViewTakeoverWebContentsIds = new Set<number>()
  private p7cLiveProofLeaseId: string | null = null

  constructor(mainWindow: BrowserWindow, useMock = false) {
    this.mainWindow = mainWindow
    this.useMock = useMock
    this.dataService = new BrowserDataService()
    this.browserHostKind = this.resolveBrowserHostKind()
    this.browserUserAgent = toOAuthCompatibleUserAgent(mainWindow.webContents.getUserAgent())
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
      (url) => this.openPopupInTab(url),
      (message) => this.logBrowserDiag(message),
      this.browserUserAgent,
    )
    this.contextMenuService = new BrowserContextMenuService({
      mainWindow,
      isAllowedUrl: (url) => isAllowedBrowserURL(url),
      createTab: (url) => this.createTab(url),
      addImageToActiveBoard: (url) => getReadyBoardService().addRemoteImageToActiveBoard(url),
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
    this.cdpSessionService = new BrowserCdpSessionService({
      resolveTabView: (tabId) => this.resolveTabView(tabId),
      createBrowserError: (code, message) => this.createBrowserError(code, message),
    })
    this.networkObserverService = new BrowserNetworkObserverService(this.cdpSessionService)
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
      cdpSession: this.cdpSessionService,
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
      getBrowserWriteLeaseService(),
      // The collector facade is built per-task here (the controller owns
      // executeBrowserTool + the control gate); executeBrowserTool is imported
      // lazily to avoid a static cycle with tools/browser-tools (plan §3.4).
      ({ agentTabId, leaseId, surface }) => {
        const releaseLayoutLock = this.acquireTabBoundsLock(agentTabId, `collection:${leaseId}`)
        return {
          facade: new ScopedBrowserFacade({
          agentTabId,
          leaseService: getBrowserWriteLeaseService(),
          leaseId,
          controlGate: this.agentTabControlGate,
          surface,
          execute: async (toolName, args, gateSurface, gateLeaseId) => {
            const { executeBrowserTool } = await import('../tools/browser-tools')
            const output = await executeBrowserTool(toolName, args, this, undefined, undefined, {
              service: getBrowserWriteLeaseService(),
              surface: gateSurface,
              leaseId: gateLeaseId,
            })
            return typeof output === 'string' ? output : output.text
          },
          }),
          // Only a CONFIRMED freeze cancels the background task; pending_confirm
          // blocks writes (via the facade's isWriteBlocked) but must not cancel
          // before the user confirms (Codex result-review #1 residual).
          isControlFrozen: () => this.agentTabControlGate.isFrozen(),
          releaseLayoutLock,
        }
      },
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
      bindPopup: (webContents) => {
        const sourceTabId = this.getTabIdForWebContents(webContents.id)
        this.popupManager.bindWindow(webContents, {
          sourceTabId,
          sourceOwner: sourceTabId ? this.tabs.get(sourceTabId)?.owner ?? null : null,
        })
      },
      bindAppShortcutBridge: (webContents) => this.bindAppShortcutBridge(webContents),
      installContextMenu: (webContents) => this.contextMenuService.install(webContents),
      handleWindowOpen: (details, source, sourceContentsId) => this.handleWindowOpen(details, source, sourceContentsId),
      ensureDownloadSession: (targetSession) => this.downloadService.ensureRegistered(targetSession),
      addHistoryEntry: (url, title, metadata) => this.dataService.addHistoryEntry(url, title, metadata),
      updateHistoryEntryTitle: (url, title, favicon) => this.dataService.updateHistoryEntryTitle(url, title, favicon),
      handleLocalMediaDropNavigation: (tabId, url) => this.handleLocalMediaDropNavigation(tabId, url),
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
      getFrozenBounds: (tabId) => this.getFrozenBoundsForTab(tabId),
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
      openInTab: (url, context) => this.openPopupInTab(url, context),
      logBrowserDiag: (message) => this.logBrowserDiag(message),
      openExternal: (url) => {
        shell.openExternal(url)
      },
    })
    getBrowserWriteLeaseService().onTransition(() => {
      this.notifyBrowserLeaseChanged()
    })
    void this.contentTaskRunner.resumePendingTasks()
  }

  private logBrowserDiag(message: string): void {
    this.diagnosticsService.log(message)
  }

  // ── Internal helpers ──────────────────────────────────────────────

  private resolveBrowserHostKind(): BrowserHostKind {
    return resolveBrowserHostKindFromConfig(
      process.env.READY_BROWSER_HOST_DRIVER,
      () => this.dataService.getSetting('browser_host_driver'),
    )
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

  private resolveUrlForWebContentsId(webContentsId?: number): string {
    if (!webContentsId) return ''
    for (const tab of this.tabs.values()) {
      if (tab.view?.webContents.id === webContentsId) {
        return tab.view.webContents.getURL() || tab.url
      }
    }
    if (this.previewService.matchesWebContentsId(webContentsId)) {
      return this.previewService.getUrl()
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

  private syncPopupContextForTab(tabId: string): void {
    const tab = this.tabs.get(tabId)
    const webContents = tab?.view?.webContents
    if (!tab || !webContents) return
    this.popupManager.bindWindow(webContents, {
      sourceTabId: tab.id,
      sourceOwner: tab.owner,
    })
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

  private isDuplicateLocalMediaDrop(signature: string): boolean {
    const now = Date.now()
    for (const [key, startedAt] of this.localMediaDropRuns) {
      if (now - startedAt > 2500) this.localMediaDropRuns.delete(key)
    }
    const startedAt = this.localMediaDropRuns.get(signature)
    if (startedAt && now - startedAt <= 2500) return true
    this.localMediaDropRuns.set(signature, now)
    return false
  }

  private handleLocalMediaDropNavigation(tabId: string, url: string): boolean {
    const request = parseBrowserLocalMediaDropUrl(url)
    if (!request) return false
    const remoteUrls = request.urls || []
    const dropSignature = JSON.stringify({ tabId, paths: request.paths, urls: remoteUrls })
    if (this.isDuplicateLocalMediaDrop(dropSignature)) {
      this.logBrowserDiag(`[browser-v3][local-media-drop][tab:${tabId}] ignored duplicate local=${request.paths.length} remote=${remoteUrls.length}`)
      return true
    }
    this.logBrowserDiag(`[browser-v3][local-media-drop][tab:${tabId}] received local=${request.paths.length} remote=${remoteUrls.length}`)
    void (async () => {
      let remoteFiles: string[] = []
      try {
        if (remoteUrls.length > 0) {
          this.sendToRenderer('browser:localMediaUploadStatus', {
            tabId,
            status: {
              kind: 'uploading',
              message: remoteUrls.length > 1 ? `正在准备 ${remoteUrls.length} 张网页图片...` : '正在准备网页图片...',
            },
          })
          const downloaded = await downloadRemoteMediaDropUrls(remoteUrls)
          remoteFiles = downloaded.files
          if (remoteFiles.length === 0 && request.paths.length === 0) {
            const firstError = downloaded.failed[0]?.error
            this.sendToRenderer('browser:localMediaUploadStatus', {
              tabId,
              status: {
                kind: 'error',
                message: firstError ? `网页图片下载失败：${firstError}` : '网页图片下载失败',
              },
            })
            return
          }
        }
        const files = [...request.paths, ...remoteFiles]
        this.sendToRenderer('browser:localMediaUploadStatus', {
          tabId,
          status: {
            kind: 'uploading',
            message: files.length > 1 ? `正在上传 ${files.length} 个素材...` : '正在上传素材...',
          },
        })
        const result = await this.uploadLocalMediaFiles(tabId, {
          files,
          x: request.x,
          y: request.y,
        })
        if (result.success) {
          this.sendToRenderer('browser:localMediaUploadStatus', {
            tabId,
            status: {
              kind: 'success',
              message: result.method === 'drop' ? '已把素材拖入网页' : '已把素材交给网页上传',
            },
          })
          return
        }
        this.sendToRenderer('browser:localMediaUploadStatus', {
          tabId,
          status: {
            kind: 'error',
            message: result.error || '网页没有接住这个素材',
          },
        })
      } catch (error) {
        this.sendToRenderer('browser:localMediaUploadStatus', {
          tabId,
          status: {
            kind: 'error',
            message: error instanceof Error ? error.message : '素材上传失败',
          },
        })
      } finally {
        scheduleRemoteMediaDropCleanup(remoteFiles)
      }
    })()
    return true
  }

  private openPopupInTab(
    url: string,
    context: { sourceTabId?: string | null; sourceOwner?: BrowserTabOwner | null } = {},
  ): void {
    const agentOwned = context.sourceOwner === 'agent'
    void this.createTab(url, agentOwned ? { background: true } : undefined)
      .then((result) => {
        if (!result.success || !result.tabId) {
          this.logBrowserDiag(`[browser-v3][popup] create tab failed: ${result.error || 'unknown error'}`)
          shell.openExternal(url)
          return
        }

        const tab = this.tabs.get(result.tabId)
        if (!tab) {
          this.logBrowserDiag(`[browser-v3][popup] created tab missing metadata tab=${result.tabId}`)
          return
        }

        if (agentOwned) {
          this.updateTabRuntimeState(result.tabId, {
            owner: 'agent',
            required: true,
            activity: 'running',
            lastAuditedAt: Date.now(),
          })
          this.syncPopupContextForTab(result.tabId)
          this.attachAgentTabSupervision(result.tabId)
          this.adoptForegroundWorkflowPopup(context.sourceTabId || null, result.tabId)
        }

        this.sendToRenderer('browser:tabOpened', this.tabMetaService.buildTabPayload(tab))
      })
      .catch((error) => {
        this.logBrowserDiag(`[browser-v3][popup] create tab failed: ${String(error)}`)
        shell.openExternal(url)
      })
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

  private currentBoundsForTab(tabId: string): BrowserRect {
    if (tabId === this.splitTabId) return { ...this.splitViewBounds }
    if (tabId === this.activeTabId) return { ...this.viewBounds }
    const tab = this.tabs.get(tabId)
    const readBounds = (tab?.view as unknown as { getBounds?: () => BrowserRect })?.getBounds
    if (typeof readBounds === 'function') {
      try {
        const bounds = readBounds.call(tab?.view)
        if (
          bounds &&
          Number(bounds.width) > 20 &&
          Number(bounds.height) > 20 &&
          Number(bounds.x) > -10000 &&
          Number(bounds.y) > -10000
        ) {
          return {
            x: Math.round(Number(bounds.x)),
            y: Math.round(Number(bounds.y)),
            width: Math.round(Number(bounds.width)),
            height: Math.round(Number(bounds.height)),
          }
        }
      } catch {
        // silent-catch: fall back to the last primary BrowserView bounds.
      }
    }
    return { ...this.viewBounds }
  }

  private acquireTabBoundsLock(tabId: string, token: string): () => void {
    const existing = this.frozenBoundsByTab.get(tabId)
    if (existing) {
      existing.tokens.add(token)
      this.logBrowserDiag(`[browser-host][bounds-lock] reuse tab=${tabId} token=${token} x=${existing.bounds.x} y=${existing.bounds.y} w=${existing.bounds.width} h=${existing.bounds.height}`)
      return () => this.releaseTabBoundsLock(tabId, token)
    }
    const bounds = this.currentBoundsForTab(tabId)
    this.frozenBoundsByTab.set(tabId, { bounds, tokens: new Set([token]) })
    this.logBrowserDiag(`[browser-host][bounds-lock] acquire tab=${tabId} token=${token} x=${bounds.x} y=${bounds.y} w=${bounds.width} h=${bounds.height}`)
    return () => this.releaseTabBoundsLock(tabId, token)
  }

  private releaseTabBoundsLock(tabId: string, token: string): void {
    const existing = this.frozenBoundsByTab.get(tabId)
    if (!existing) return
    existing.tokens.delete(token)
    if (existing.tokens.size > 0) return
    this.frozenBoundsByTab.delete(tabId)
    this.logBrowserDiag(`[browser-host][bounds-lock] release tab=${tabId} token=${token}`)
  }

  private getFrozenBoundsForTab(tabId: string): BrowserRect | null {
    const existing = this.frozenBoundsByTab.get(tabId)
    return existing ? { ...existing.bounds } : null
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

  async startVisibleCollection(payload: Record<string, unknown>, scopeId?: string): Promise<BrowserCapabilityTaskHandle> {
    const requestedTabId = typeof payload.tabId === 'string' ? payload.tabId : null
    const tabUrl = requestedTabId ? this.tabs.get(requestedTabId)?.url || '' : ''
    const activeTab = this.getActiveTab()
    const targetUrl = String(payload.url || tabUrl || activeTab?.url || '').trim()
    const highControl = payload.highControl === true || isHighControlPlatformText(targetUrl || tabUrl || activeTab?.url || '')
    const visibleTarget = resolveHighControlCollectionTarget({
      highControl,
      requestedTabId,
      activeTabId: activeTab?.id || null,
      activeTabUrl: activeTab?.url || null,
    })
    const executionTarget = visibleTarget ?? {
      tabId: await this.ensureAgentTab(),
      surface: 'agent-view' as AgentBrowserSurface,
      usesVisibleTab: false,
    }
    return this.contentTaskRunner.startTask({
      kind: 'visible_collect',
      payload: {
        ...payload,
        url: targetUrl || undefined,
        tabId: executionTarget.tabId,
        surface: executionTarget.surface,
        leaseId: undefined,
        ...(scopeId && scopeId.trim() ? { scopeId: scopeId.trim() } : {}),
      },
    })
  }

  createSyntheticVisibleCollection(payload: {
    targets: BrowserCollectionTarget[]
    targetUrl?: string
    outputRootDir?: string
    sourceMessageIds?: string[]
  }, scopeId?: string): BrowserCapabilityTaskHandle {
    return this.contentTaskRunner.createSyntheticVisibleCollection({
      ...payload,
      scopeId: scopeId?.trim() || undefined,
    })
  }

  async getTask(taskId: string): Promise<BrowserCapabilityTaskHandle | null> {
    return this.contentTaskRunner.getTask(taskId)
  }

  /** EP2 dogfood gap 1 — the download-redirect guard needs to discover this
   *  scope's image_gallery source tasks. */
  async listTasksByKind(kind: BrowserCapabilityTaskKind): Promise<BrowserCapabilityTaskHandle[]> {
    return this.contentTaskRunner.listTasks(kind)
  }

  /** EP2 dogfood gap 3 — passthrough to the execution-ledger owner. */
  async recordCollectedMediaDownload(taskId: string, summary: {
    discovered: number
    saved: number
    failed: number
    remaining: number
    directory: string
    expectedTotal?: number | null
  }): Promise<BrowserCapabilityTaskHandle | null> {
    return this.contentTaskRunner.recordCollectedMediaDownload(taskId, summary)
  }

  getTaskPayload(taskId: string): Record<string, unknown> | null {
    return this.contentTaskRunner.getTaskPayload(taskId)
  }

  async findCollectionTaskBySourceTaskId(sourceTaskId: string): Promise<BrowserCapabilityTaskHandle | null> {
    const sourceId = sourceTaskId.trim()
    if (!sourceId) return null
    const tasks = [
      ...(await this.contentTaskRunner.listTasks('card_loop')),
      ...(await this.contentTaskRunner.listTasks('note_collect')),
    ]
    const matches = tasks.filter((task) => {
      const payload = this.contentTaskRunner.getTaskPayload(task.taskId)
      const plan = payload?.plan && typeof payload.plan === 'object' ? payload.plan as Record<string, unknown> : null
      const result = task.result && typeof task.result === 'object' ? task.result as Record<string, unknown> : null
      const status = task.status
      if (status === 'cancelled' || status === 'failed') return false
      return plan?.sourceTaskId === sourceId || result?.sourceTaskId === sourceId
    })
    return matches.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))[0] || null
  }

  private async startCollectionFromCompletedVisibleTask(
    sourceTask: BrowserCapabilityTaskHandle,
  ): Promise<BrowserCapabilityTaskHandle | null> {
    const handoff = buildCollectionHandoffPlanFromTask(sourceTask)
    if (!handoff) return null
    const existing = await this.findCollectionTaskBySourceTaskId(sourceTask.taskId)
    if (existing) return existing
    const sourcePayload = this.contentTaskRunner.getTaskPayload(sourceTask.taskId)
    const scopeId = typeof sourcePayload?.scopeId === 'string' && sourcePayload.scopeId.trim()
      ? sourcePayload.scopeId.trim()
      : undefined
    if (handoff.strategy === 'card_loop') {
      return this.startCardLoopCollection(handoff.plan, scopeId)
    }
    return this.startNoteCollection(handoff.plan, scopeId)
  }

  async resumeTask(taskId: string): Promise<BrowserCapabilityTaskHandle | null> {
    const current = await this.contentTaskRunner.getTask(taskId)
    if (current?.kind === 'note_collect' || current?.kind === 'card_loop') {
      const payload = this.contentTaskRunner.getTaskPayload(taskId)
      if (payload) {
        const agentTabId = await this.ensureAgentTab()
        this.contentTaskRunner.updateTaskPayload(taskId, {
          ...payload,
          agentTabId,
          surface: payload.surface || 'agent-view',
        })
      }
    }
    return this.contentTaskRunner.resumeTask(taskId)
  }

  async cancelTask(taskId: string): Promise<BrowserCapabilityTaskHandle | null> {
    return this.contentTaskRunner.cancelTask(taskId)
  }

  /**
   * Ensure the dedicated background tab the collector sub-agent drives (plan
   * §3.5/§3.9), WITHOUT stealing the user's foreground. We create the tab,
   * tag it owner:'agent', and restore whatever tab the user had active so the
   * agent never preempts the visible browser.
   */
  async ensureAgentTab(): Promise<string> {
    if (this.agentTabId) {
      const agentTab = this.tabs.get(this.agentTabId)
      if (agentTab?.owner === 'agent') {
        this.agentTabControlGate.reset()
        this.updateTabRuntimeState(this.agentTabId, { activity: 'running' })
        return this.agentTabId
      }
    }
    // Create the agent tab in the BACKGROUND so it never becomes active or gets
    // presented — no foreground preemption, no create-then-switch-back flicker
    // (Codex result-review #4). Belt-and-suspenders: if the host ever activates
    // it anyway, restore the user's tab.
    const previousActive = this.activeTabId
    const created = await this.createTab(READY_BROWSER_BLANK_URL, { background: true })
    if (!created.success || !created.tabId) {
      throw new Error(created.error || 'failed to create agent tab')
    }
    this.agentTabId = created.tabId
    this.agentTabControlGate.reset()
    this.updateTabRuntimeState(created.tabId, { owner: 'agent', activity: 'running' })
    this.syncPopupContextForTab(created.tabId)
    if (previousActive && this.activeTabId === created.tabId && this.tabs.has(previousActive)) {
      this.switchTab(previousActive)
    }
    this.attachAgentTabSupervision(created.tabId)
    return created.tabId
  }

  private async ensureForegroundAgentTab(): Promise<string> {
    if (this.foregroundAgentTabId) {
      const foregroundTab = this.tabs.get(this.foregroundAgentTabId)
      if (foregroundTab?.owner === 'agent') {
        this.agentTabControlGate.reset()
        this.updateTabRuntimeState(this.foregroundAgentTabId, {
          required: true,
          activity: 'running',
          lastAuditedAt: Date.now(),
        })
        this.syncPopupContextForTab(this.foregroundAgentTabId)
        this.attachAgentTabSupervision(this.foregroundAgentTabId)
        return this.foregroundAgentTabId
      }
    }

    const previousActive = this.activeTabId
    const created = await this.createTab(READY_BROWSER_BLANK_URL, { background: true })
    if (!created.success || !created.tabId) {
      throw new Error(created.error || 'failed to create foreground agent tab')
    }
    this.foregroundAgentTabId = created.tabId
    this.agentTabControlGate.reset()
    this.updateTabRuntimeState(created.tabId, {
      owner: 'agent',
      required: true,
      activity: 'running',
      lastAuditedAt: Date.now(),
    })
    this.syncPopupContextForTab(created.tabId)
    if (previousActive && this.activeTabId === created.tabId && this.tabs.has(previousActive)) {
      this.switchTab(previousActive)
    }
    this.attachAgentTabSupervision(created.tabId)
    return created.tabId
  }

  private getForegroundAgentLaneStartBlocker(runId: string): AgentBrowserStructuredError | null {
    const leaseService = getBrowserWriteLeaseService()
    const state = leaseService.getState('agent-view')
    const lease = leaseService.getLease('agent-view')
    if (state === 'held' && lease?.runId !== runId) {
      return agentBrowserError(
        'lease_held',
        `Surface agent-view is already locked by task ${lease?.taskId || 'unknown'}.`,
        { surface: 'agent-view', heldBy: lease?.taskId ?? null, leaseId: lease?.leaseId ?? null },
      )
    }
    if (state === 'takeover') {
      return agentBrowserError(
        'lease_takeover',
        'Surface agent-view is under user takeover; foreground workflow is blocked.',
        { surface: 'agent-view' },
      )
    }
    return null
  }

  async beginForegroundBrowserWorkflowSession(params: {
    runId: string
    taskId?: string
    lane?: AgentBrowserSurface
  }): Promise<{ ok: true; session: BrowserWorkflowSession } | { ok: false; error: AgentBrowserStructuredError }> {
    const lane = params.lane ?? 'agent-view'
    const sourceUserTabId = this.activeTabId
    if (lane === 'agent-view') {
      const blocker = this.getForegroundAgentLaneStartBlocker(params.runId)
      if (blocker) return { ok: false, error: blocker }
    }
    const boundTabId = lane === 'agent-view'
      ? await this.ensureForegroundAgentTab()
      : sourceUserTabId
    if (!boundTabId) {
      return {
        ok: false,
        error: {
          ok: false,
          errorCode: 'browser_surface_binding_violation',
          message: 'Browser workflow has no tab to bind.',
          detail: { surface: lane },
        },
      }
    }

    const result = this.workflowSessionStore.startForeground({
      runId: params.runId,
      taskId: params.taskId || params.runId,
      lane,
      boundTabId,
      sourceUserTabId,
      frameUrl: this.tabs.get(sourceUserTabId || '')?.url || null,
    })
    if (result.ok) {
      if (lane === 'agent-view') {
        this.releaseForegroundWorkflowBoundsLock?.()
        this.releaseForegroundWorkflowBoundsLock = this.acquireTabBoundsLock(boundTabId, `foreground-workflow:${params.runId}`)
      }
      this.notifyBrowserLeaseChanged()
      this.sendToRenderer('browser:agentControlChanged', { state: this.agentTabControlGate.getState() })
    }
    return result
  }

  updateForegroundBrowserWorkflowTarget(runId: string, boundTabId: string, reason?: string): BrowserWorkflowSession | null {
    const updated = this.workflowSessionStore.updateBoundTab(runId, boundTabId, reason)
    if (updated?.lane === 'agent-view') {
      this.foregroundAgentTabId = boundTabId
      this.updateTabRuntimeState(boundTabId, {
        owner: 'agent',
        required: true,
        activity: 'running',
        lastAuditedAt: Date.now(),
      })
      this.syncPopupContextForTab(boundTabId)
      this.attachAgentTabSupervision(boundTabId)
      this.sendToRenderer('browser:agentControlChanged', { state: this.agentTabControlGate.getState() })
    }
    return updated
  }

  closeForegroundBrowserWorkflowSession(
    runId: string,
    closeKind: 'workflow_completed' | 'workflow_failed' | 'user_interrupted',
    reason?: string,
  ): BrowserWorkflowSession | null {
    const session = this.workflowSessionStore.close(runId, reason || closeKind)
    if (!session) return null
    if (session.lane === 'agent-view') {
      this.updateTabRuntimeState(session.boundTabId, {
        required: false,
        activity: closeKind === 'user_interrupted' ? 'attention' : 'idle',
        lastAuditedAt: Date.now(),
      })
      this.releaseForegroundWorkflowBoundsLock?.()
      this.releaseForegroundWorkflowBoundsLock = null
    }
    this.notifyBrowserLeaseChanged()
    this.sendToRenderer('browser:agentControlChanged', { state: this.agentTabControlGate.getState() })
    return session
  }

  getActiveForegroundBrowserWorkflowSession(): BrowserWorkflowSession | null {
    return this.workflowSessionStore.getActiveForeground()
  }

  private adoptForegroundWorkflowPopup(sourceTabId: string | null, nextTabId: string): void {
    const activeSession = this.workflowSessionStore.getActiveForeground()
    if (!activeSession || activeSession.boundTabId !== sourceTabId) return
    this.updateTabRuntimeState(activeSession.boundTabId, {
      required: false,
      activity: 'idle',
      lastAuditedAt: Date.now(),
    })
    this.updateForegroundBrowserWorkflowTarget(activeSession.runId, nextTabId, 'agent_popup_followed')
  }

  /**
   * Wire real user interaction with the agent tab to the freeze-confirm flow
   * (Codex result-review #2). before-input-event fires only for genuine user
   * keyboard input — the agent's own writes go through CDP/executeJS/loadURL and
   * never trigger it. So a keypress here means the user is trying to take over:
   * raise the interruption (→ pending_confirm), notify the renderer, and BLOCK
   * the keystroke until the user explicitly confirms (the second confirmation).
   * Once frozen (confirmed), input passes through — the user has control.
   */
  private attachAgentTabSupervision(tabId: string): void {
    const webContents = this.tabs.get(tabId)?.view?.webContents
    if (!webContents) return
    const blockUserInputUntilConfirmed = (event: { preventDefault: () => void }): void => {
      const state = this.agentTabControlGate.getState()
      if (state === 'frozen') return // user has taken over — allow input through
      if (state === 'active') {
        this.agentTabControlGate.requestInterruption()
        this.notifyAgentControlChanged()
      }
      event.preventDefault() // agent still controls until the 2nd confirmation
    }
    webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' && input.type !== 'keyUp' && input.type !== 'char') return
      blockUserInputUntilConfirmed(event)
    })
    webContents.on('before-mouse-event', (event, mouse) => {
      if (
        mouse.type !== 'mouseDown'
        && mouse.type !== 'mouseUp'
        && mouse.type !== 'mouseWheel'
        && mouse.type !== 'contextMenu'
      ) {
        return
      }
      blockUserInputUntilConfirmed(event)
    })
  }

  private notifyAgentControlChanged(): void {
    this.sendToRenderer('browser:agentControlChanged', { state: this.agentTabControlGate.getState() })
  }

  private notifyBrowserLeaseChanged(): void {
    this.sendToRenderer('browser:leaseChanged', this.getBrowserLeaseSnapshot())
  }

  private attachUserViewLeaseTakeover(tabId: string): void {
    const webContents = this.tabs.get(tabId)?.view?.webContents
    if (!webContents || this.userViewTakeoverWebContentsIds.has(webContents.id)) return
    this.userViewTakeoverWebContentsIds.add(webContents.id)
    webContents.on('before-input-event', (_event, input) => {
      if (!isUserViewKeyboardTakeoverInput(input)) return
      const tab = this.tabs.get(tabId)
      if (!tab || tab.owner === 'agent') return
      recordUserViewTakeoverSignal({
        service: getBrowserWriteLeaseService(),
        activeTabId: this.activeTabId,
        signalTabId: tabId,
        source: 'keyboard',
      })
    })
    webContents.once('destroyed', () => {
      this.userViewTakeoverWebContentsIds.delete(webContents.id)
    })
  }

  getAgentTabId(): string | null {
    const tab = this.agentTabId ? this.tabs.get(this.agentTabId) : null
    return tab?.owner === 'agent' ? this.agentTabId : null
  }

  /** Agent-owned browser collection tasks (for the supervision panel). */
  async listAgentCollectionTasks(): Promise<BrowserCapabilityTaskHandle[]> {
    const [visible, notes, cardLoop] = await Promise.all([
      this.contentTaskRunner.listTasks('visible_collect'),
      this.contentTaskRunner.listTasks('note_collect'),
      this.contentTaskRunner.listTasks('card_loop'),
    ])
    return [...visible, ...notes, ...cardLoop]
      .filter((task) => {
        const payload = this.contentTaskRunner.getTaskPayload(task.taskId)
        return payload?.surface === 'agent-view'
      })
      .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
  }

  /** Wire the chat task-projection sink (set by setupAgentIPC, plan §3.3). */
  setTaskProjectionSink(sink: BrowserTaskProjectionSink | null): void {
    this.contentTaskRunner.setTaskProjectionSink(sink)
  }

  setSiteCardLearningSink(sink: BrowserSiteCardLearningSink | null): void {
    this.contentTaskRunner.setSiteCardLearningSink(sink)
  }

  /**
   * Start a background note-collection task on the agent tab (plan §3.3). The
   * caller supplies the validated note list (the main agent plans 判断题); the
   * task acquires its own agent-view lease and runs the deterministic engine.
   */
  async startNoteCollection(plan: Record<string, unknown>, scopeId?: string): Promise<BrowserCapabilityTaskHandle> {
    // Global concurrency cap (Codex result-review #5): bound how many background
    // collections run at once. High-control platforms get a cap of 1 so same-
    // domain collections serialize (the per-domain rate control), on top of the
    // per-note pacing the runner already applies.
    const isHighControl = isHighControlPlatformText(JSON.stringify(plan))
    const cap = isHighControl ? 1 : 2
    const active = (await this.contentTaskRunner.listTasks('note_collect'))
      .filter((task) => task.status === 'running' || task.status === 'queued')
    if (active.length >= cap) {
      throw new Error(
        `已有 ${active.length} 个后台采集任务在运行（上限 ${cap}${isHighControl ? '，高风控平台限单并发' : ''}），请等当前任务完成后再发起。`,
      )
    }
    const agentTabId = await this.ensureAgentTab()
    return this.contentTaskRunner.startTask({
      kind: 'note_collect',
      payload: {
        agentTabId,
        surface: 'agent-view' as AgentBrowserSurface,
        plan,
        // Bind the task to the dispatching conversation so it projects into
        // that chat (plan §3.2); absent for non-chat callers (skip projection).
        ...(scopeId && scopeId.trim() ? { scopeId: scopeId.trim() } : {}),
      },
    })
  }

  async startCardLoopCollection(plan: Record<string, unknown>, scopeId?: string): Promise<BrowserCapabilityTaskHandle> {
    const withStrategy: Record<string, unknown> = { ...plan, strategy: 'card_loop' }
    const isHighControl = isHighControlPlatformText(JSON.stringify(withStrategy))
    const cap = isHighControl ? 1 : 2
    const active = (await this.contentTaskRunner.listTasks('card_loop'))
      .filter((task) => task.status === 'running' || task.status === 'queued')
    if (active.length >= cap) {
      throw new Error(
        `已有 ${active.length} 个逐张点开采集任务在运行（上限 ${cap}${isHighControl ? '，高风控平台限单并发' : ''}），请等当前任务完成后再发起。`,
      )
    }
    const sourceTaskId = typeof withStrategy.sourceTaskId === 'string' ? withStrategy.sourceTaskId.trim() : ''
    const sourcePayload = sourceTaskId ? this.contentTaskRunner.getTaskPayload(sourceTaskId) : null
    const sourceTarget = resolveSourceCollectionTarget({ highControl: isHighControl, sourcePayload })
    const agentTabId = sourceTarget?.tabId ?? await this.ensureAgentTab()
    const surface = sourceTarget?.surface ?? 'agent-view'
    return this.contentTaskRunner.startTask({
      kind: 'card_loop',
      payload: {
        agentTabId,
        surface,
        plan: withStrategy,
        ...(scopeId && scopeId.trim() ? { scopeId: scopeId.trim() } : {}),
      },
    })
  }

  /** Supervision (plan §3.6): two-step interrupt of the agent's browser control. */
  requestAgentInterruption(): { state: ReturnType<AgentTabControlGate['getState']>; pending: boolean } {
    const pending = this.agentTabControlGate.requestInterruption()
    this.notifyAgentControlChanged()
    return { state: this.agentTabControlGate.getState(), pending }
  }

  async confirmAgentInterruption(): Promise<{ state: ReturnType<AgentTabControlGate['getState']>; frozen: boolean; takeoverTabId?: string | null }> {
    const frozen = this.agentTabControlGate.confirmInterruption()
    // Don't wait for the next loop tick: on confirm, immediately cancel the
    // running collection tasks so "确认后立即中断" is real (Codex result-review
    // #1). The freeze probe is still the backstop for the in-flight note.
    if (frozen) {
      const tasks = [
        ...(await this.contentTaskRunner.listTasks('visible_collect')),
        ...(await this.contentTaskRunner.listTasks('note_collect')),
        ...(await this.contentTaskRunner.listTasks('card_loop')),
      ].filter((task) => {
        const payload = this.contentTaskRunner.getTaskPayload(task.taskId)
        return payload?.surface === 'agent-view'
          && (task.status === 'queued' || task.status === 'running' || task.status === 'paused')
      })
      await Promise.all(tasks.map((task) => this.contentTaskRunner.cancelTask(task.taskId)))
      const foreground = this.workflowSessionStore.getActiveForeground()
      const takeoverTabId = foreground?.boundTabId || this.agentTabId
      if (takeoverTabId && this.tabs.has(takeoverTabId)) {
        this.updateTabRuntimeState(takeoverTabId, { owner: 'manual', activity: 'attention' })
        this.syncPopupContextForTab(takeoverTabId)
        if (takeoverTabId === this.agentTabId) this.agentTabId = null
        if (takeoverTabId === this.foregroundAgentTabId) this.foregroundAgentTabId = null
      }
      if (foreground) {
        this.workflowSessionStore.close(foreground.runId, 'user_takeover_confirmed')
        this.releaseForegroundWorkflowBoundsLock?.()
        this.releaseForegroundWorkflowBoundsLock = null
        this.notifyBrowserLeaseChanged()
      }
      this.notifyAgentControlChanged()
      return { state: this.agentTabControlGate.getState(), frozen, takeoverTabId }
    }
    this.notifyAgentControlChanged()
    return { state: this.agentTabControlGate.getState(), frozen, takeoverTabId: null }
  }

  dismissAgentInterruption(): { state: ReturnType<AgentTabControlGate['getState']> } {
    this.agentTabControlGate.dismissInterruption()
    this.notifyAgentControlChanged()
    return { state: this.agentTabControlGate.getState() }
  }

  getAgentControlState(): ReturnType<AgentTabControlGate['getState']> {
    return this.agentTabControlGate.getState()
  }

  getBrowserLeaseSnapshot(): BrowserLeaseSupervisionSnapshot {
    return buildBrowserLeaseSupervisionSnapshot(getBrowserWriteLeaseService())
  }

  private isP7cLiveProofEnabled(): boolean {
    return process.env.READY_P7C_LIVE_PROOF === '1'
  }

  private async readP7cLiveProofPageState(tab: Tab): Promise<{
    focusToken: string
    scrollX: number
    scrollY: number
    url: string
    title: string
  }> {
    if (!tab.view?.webContents) throw new Error('active tab has no browser webContents')
    const pageState = await tab.view.webContents.executeJavaScript(`(() => {
      const active = document.activeElement;
      const tokenParts = [];
      if (active) {
        tokenParts.push(active.tagName || '');
        tokenParts.push(active.id || '');
        tokenParts.push(active.getAttribute('name') || '');
        tokenParts.push(active.getAttribute('role') || '');
        tokenParts.push(active.getAttribute('aria-label') || '');
        tokenParts.push(active.className && typeof active.className === 'string' ? active.className : '');
      }
      return {
        focusToken: tokenParts.join('#'),
        scrollX: Math.round(window.scrollX || document.documentElement.scrollLeft || document.body.scrollLeft || 0),
        scrollY: Math.round(window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0),
        url: location.href,
        title: document.title || '',
      };
    })()`, true) as {
      focusToken?: unknown
      scrollX?: unknown
      scrollY?: unknown
      url?: unknown
      title?: unknown
    }
    return {
      focusToken: String(pageState?.focusToken || ''),
      scrollX: Number(pageState?.scrollX || 0),
      scrollY: Number(pageState?.scrollY || 0),
      url: String(pageState?.url || tab.url || ''),
      title: String(pageState?.title || tab.title || ''),
    }
  }

  async prepareP7cLiveProofForegroundProbe(): Promise<{
    success: boolean
    state?: { tabId: string; url: string; title: string; focusToken: string; scrollX: number; scrollY: number }
    error?: string
  }> {
    if (!this.isP7cLiveProofEnabled()) {
      return { success: false, error: 'p7c live proof is disabled' }
    }
    const tab = this.getActiveTab()
    if (!tab?.view?.webContents) return { success: false, error: 'no active browser webContents' }
    try {
      await tab.view.webContents.executeJavaScript(`(() => {
        document.title = 'Ready P7c2 foreground proof';
        document.body.innerHTML = [
          '<main id="ready-p7c2-proof-root" style="min-height:2400px;padding:24px;font-family:sans-serif">',
          '<label for="ready-p7c2-focus">P7c2 focus target</label>',
          '<input id="ready-p7c2-focus" name="ready-p7c2-focus" aria-label="P7c2 focus target" value="focus target" />',
          '<section style="height:1800px">scroll proof spacer</section>',
          '</main>'
        ].join('');
        const input = document.getElementById('ready-p7c2-focus');
        if (input) input.focus();
        window.scrollTo(0, 360);
        return true;
      })()`, true)
      const state = await this.readP7cLiveProofPageState(tab)
      return { success: true, state: { tabId: tab.id, ...state } }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async sampleP7cLiveProofActiveTabState(): Promise<{
    success: boolean
    state?: { tabId: string; url: string; title: string; focusToken: string; scrollX: number; scrollY: number }
    error?: string
  }> {
    if (!this.isP7cLiveProofEnabled()) {
      return { success: false, error: 'p7c live proof is disabled' }
    }
    const tab = this.getActiveTab()
    if (!tab?.view?.webContents) return { success: false, error: 'no active browser webContents' }
    try {
      const state = await this.readP7cLiveProofPageState(tab)
      return { success: true, state: { tabId: tab.id, ...state } }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async createP7cLiveProofManualTab(): Promise<{ success: boolean; tabId?: string; error?: string }> {
    if (!this.isP7cLiveProofEnabled()) {
      return { success: false, error: 'p7c live proof is disabled' }
    }
    const created = await this.createTab(READY_BROWSER_BLANK_URL)
    if (!created.success || !created.tabId) {
      return { success: false, error: created.error || 'failed to create p7c proof tab' }
    }
    this.updateTabRuntimeState(created.tabId, { owner: 'manual', activity: 'idle', required: false })
    return { success: true, tabId: created.tabId }
  }

  startP7cLiveProofUserViewLease(): { success: boolean; leaseId?: string; tabId?: string; error?: string } {
    if (!this.isP7cLiveProofEnabled()) {
      return { success: false, error: 'p7c live proof is disabled' }
    }
    const tab = this.getActiveTab()
    if (!tab?.id) return { success: false, error: 'no active browser tab' }
    const service = getBrowserWriteLeaseService()
    const state = service.getState('user-view')
    if (state === 'takeover' || state === 'expired') {
      service.clearTakeover('user-view')
    }
    const lease = service.acquire({
      surface: 'user-view',
      taskId: 'p7c-live-proof',
      runId: `p7c-live-proof-${Date.now()}`,
      tabId: tab.id,
      ttlMs: 30_000,
    })
    if (isAgentBrowserError(lease)) {
      return { success: false, error: lease.message || lease.errorCode }
    }
    this.p7cLiveProofLeaseId = lease.leaseId
    return { success: true, leaseId: lease.leaseId, tabId: tab.id }
  }

  sendP7cLiveProofUserKey(key = 'a'): { success: boolean; error?: string } {
    if (!this.isP7cLiveProofEnabled()) {
      return { success: false, error: 'p7c live proof is disabled' }
    }
    const tab = this.getActiveTab()
    const webContents = tab?.view?.webContents
    if (!webContents) return { success: false, error: 'no active browser webContents' }
    webContents.sendInputEvent({ type: 'keyDown', keyCode: key })
    webContents.sendInputEvent({ type: 'keyUp', keyCode: key })
    return { success: true }
  }

  checkP7cLiveProofWriteDenied(): { success: boolean; errorKind?: string; error?: string } {
    if (!this.isP7cLiveProofEnabled()) {
      return { success: false, error: 'p7c live proof is disabled' }
    }
    const denied = getBrowserWriteLeaseService().checkWrite({
      surface: 'user-view',
      leaseId: this.p7cLiveProofLeaseId,
    })
    if (!denied) return { success: false, error: 'write was still allowed' }
    return { success: true, errorKind: denied.errorCode }
  }

  clearP7cLiveProofState(): { success: boolean; error?: string } {
    if (!this.isP7cLiveProofEnabled()) {
      return { success: false, error: 'p7c live proof is disabled' }
    }
    this.p7cLiveProofLeaseId = null
    getBrowserWriteLeaseService().clearTakeover('user-view')
    return { success: true }
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
    const referrerUrl = details.referrer?.url || this.resolveUrlForWebContentsId(sourceContentsId)
    const sourceTabId = this.getTabIdForWebContents(sourceContentsId)
    const sourceOwner = sourceTabId ? this.tabs.get(sourceTabId)?.owner ?? null : null
    return this.windowOpenService.handle({
      ...details,
      referrer: referrerUrl ? { url: referrerUrl } : details.referrer,
    }, source, sourceContentsId, { sourceTabId, sourceOwner })
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
  async createTab(
    url: string,
    options?: { background?: boolean },
  ): Promise<{ success: boolean; tabId?: string; error?: string }> {
    if (!options?.background) this.clearSplitTabHost()
    const result = await this.tabLifecycleService.createTab(url, options)
    if (result.success && result.tabId) {
      this.attachUserViewLeaseTakeover(result.tabId)
    }
    return result
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

  /** D10 frame 穿透：列出主帧+子帧（frameKey '0'=主帧，子帧 pid-rid）。 */
  listContentFrames(tabId: string | null) {
    return this.automationService.listContentFrames(tabId)
  }

  /** D10 frame 穿透：在指定 frameKey 的帧内执行 JS（'0' 回落主帧路径）。 */
  async executeJSInFrame(tabId: string | null, frameKey: string, code: string): Promise<unknown> {
    return this.automationService.executeJSInFrame(tabId, frameKey, code)
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
    previousActiveTabId?: string | null
    activeTabId?: string | null
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
    const result = this.tabShellService.switchTab(tabId)
    if (result.success) {
      const leaseTabId = getBrowserWriteLeaseService().getLease('user-view')?.tabId ?? null
      const nextTab = this.tabs.get(tabId)
      if (
        nextTab?.owner !== 'agent'
        && shouldRecordUserViewTabSwitch({
          previousActiveTabId: result.previousActiveTabId ?? null,
          nextActiveTabId: result.activeTabId ?? tabId,
          leaseTabId,
        })
      ) {
        recordUserViewTakeoverSignal({
          service: getBrowserWriteLeaseService(),
          activeTabId: this.activeTabId,
          signalTabId: tabId,
          source: 'tab-switch',
        })
      }
    }
    return result
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

  async startNetworkObserver(
    tabId: string,
    options?: BrowserNetworkObserverOptions,
  ): Promise<BrowserNetworkObserverHandle> {
    return this.networkObserverService.start(tabId, options)
  }

  async sendCdpCommand(
    tabId: string | null,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    return this.cdpSessionService.sendCommand(tabId, method, params)
  }

  confirmCollectionConsent(payload: {
    requestId?: string
    confirmedVia?: BrowserCollectionConsentVia
  }): { success: boolean; data?: unknown; error?: string } {
    const requestId = String(payload?.requestId || '').trim()
    const confirmedVia = String(payload?.confirmedVia || '').trim()
    if (!requestId) return { success: false, error: 'Missing requestId' }
    if (confirmedVia !== 'ask_user_questions' && confirmedVia !== 'ui_action') {
      return { success: false, error: 'Invalid confirmedVia' }
    }
    const record = this.collectionConsentStore.confirmPendingRequest(requestId, confirmedVia)
    if (!record) return { success: false, error: 'Collection consent request not found' }
    return { success: true, data: record }
  }

  async resumeBrowserTask(payload: { taskId?: string }): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const taskId = String(payload?.taskId || '').trim()
    if (!taskId) return { success: false, error: 'Missing taskId' }
    const task = await this.resumeTask(taskId)
    if (!task) return { success: false, error: 'Browser task not found' }
    const downstreamTask = await this.startCollectionFromCompletedVisibleTask(task)
    return { success: true, data: downstreamTask || task }
  }
}

export function setupBrowserIPC(
  mainWindow: BrowserWindow,
  useMock = false,
  options?: { preloadPath?: string; rendererFile?: string },
): BrowserController {
  const controller = new BrowserController(mainWindow, useMock)
  registerWaitingHumanBrowserTaskResumePort({
    getTask: (taskId) => controller.getTask(taskId),
    resumeTask: (taskId) => controller.resumeTask(taskId),
  })
  const browserDataService = new BrowserDataService()
  setupBrowserShellIPC(controller)
  setupBrowserSupervisionIPC(controller)
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
    sendToRenderer: (_channel, data) => controller.sendToRenderer('clip:backgroundUpdate', data),
  })
  setupBrowserContentStudyIPC({
    sendToRenderer: (channel, data) => {
      if (channel === 'clip:backgroundUpdate') {
        controller.sendToRenderer('clip:backgroundUpdate', data)
        return
      }
      if (channel === 'clip:contentStudyUpdate') {
        controller.sendToRenderer('clip:contentStudyUpdate', data)
      }
    },
  })
  setupBrowserFastCardIPC({
    getMainWindow: () => controller.getMainWindow(),
    preloadPath: options?.preloadPath || join(__dirname, '../preload/index.mjs'),
    rendererFile: options?.rendererFile || join(__dirname, '../renderer/index.html'),
  })
  setupBrowserLockOverlayIPC({
    getMainWindow: () => controller.getMainWindow(),
    preloadPath: options?.preloadPath || join(__dirname, '../preload/index.mjs'),
    rendererFile: options?.rendererFile || join(__dirname, '../renderer/index.html'),
  })
  setupBrowserVerticalRailOverlayIPC({
    getMainWindow: () => controller.getMainWindow(),
    preloadPath: options?.preloadPath || join(__dirname, '../preload/index.mjs'),
    rendererFile: options?.rendererFile || join(__dirname, '../renderer/index.html'),
  })
  ipcMain.handle('browser:confirmCollectionConsent', (_, payload: { requestId?: string; confirmedVia?: BrowserCollectionConsentVia }) => {
    return controller.confirmCollectionConsent(payload)
  })
  ipcMain.handle('browser:resumeTask', (_, payload: { taskId?: string }) => {
    return controller.resumeBrowserTask(payload)
  })

  return controller
}
