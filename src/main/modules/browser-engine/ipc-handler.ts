import { app, BrowserWindow, ipcMain, shell, session } from 'electron'
import { mkdir, open, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BrowserAppShortcutBridgeService } from './app-shortcut-service'
import { BrowserAutomationService, type BrowserExecutionDeadlineOptions } from './automation-service'
import { BrowserCapabilityService } from './capability-service'
import { BrowserCdpSessionService } from './cdp-session-service'
import { BrowserDialogService, type BrowserDialogSnapshot } from './browser-dialog-service'
import type {
  BrowserAggregateOptions,
  BrowserCapabilityTaskHandle,
  BrowserExtractStructuredOptions,
  BrowserExtractStructuredResult,
  BrowserScrollCollectOptions,
  BrowserScrollCollectResult,
  BrowserStructuredItem,
  BrowserWaitForConditionOptions,
} from './capability-types'
import { AgentInputPassthroughRegistry } from './agent-input-passthrough'
import {
  createAgentTabUserInputTakeoverHandlers,
  persistAgentTabUserTakeover,
} from './agent-tab-control-gate'
import { getBrowserTargetClaimService } from './browser-target-claim-singleton'
import { setBrowserTargetClaimRunCloseoutPort } from './browser-target-claim-closeout'
import {
  bootIncarnationIdFromPhysicalTargetToken,
  partitionForBrowserProfile,
  type BrowserPhysicalTargetKey,
  type BrowserTargetClaimIdentity,
} from './browser-target-claims'
import { BrowserFileChooserGuard } from './file-chooser-guard'
import { agentBrowserError, isAgentBrowserError, type AgentBrowserStructuredError, type AgentBrowserSurface } from './agent-browser-errors'
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
import type { BrowserHostPresentationState } from './host-layout-service'
import {
  BROWSER_HOST_KIND,
  type BrowserHostView,
  type BrowserRect,
  type BrowserViewBoundsUpdate,
  type PreviewTabState,
} from './host-types'
import { setupBrowserClipIPC } from './ipc-clip'
import { setupBrowserClipDraggedTabIPC } from './ipc-clip-dragged-tab'
import { setupBrowserContentStudyIPC } from './ipc-content-study-dragged-tab'
import { setupBrowserDataIPC } from './ipc-data'
import { setupBrowserPrivacyIPC } from './ipc-privacy'
import { BrowserPrivacyService } from './privacy-service'
import { setupBrowserFastCardIPC } from './ipc-fastcard'
import { setupBrowserVerticalRailOverlayIPC } from './ipc-vertical-rail-overlay'
import {
  clearBrowserAgentPointer,
  publishBrowserAgentActionLifecycle,
  publishBrowserAgentPointer,
  setupBrowserLockOverlayIPC,
} from './ipc-browser-lock-overlay'
import { setupBrowserShellIPC } from './ipc-shell'
import { setupBrowserSupervisionIPC } from './ipc-supervision'
import type { BrowserLeaseSupervisionSnapshot } from './ipc-supervision'
import { buildBrowserLeaseSupervisionSnapshot } from './browser-lease-supervision-snapshot'
import { BrowserPreviewService } from './preview-service'
import { BrowserPageBackgroundService } from './page-background-service'
import { BrowserSessionPolicyService } from './session-policy-service'
import {
  resolveAgentPermissionRequestBinding,
  sameBrowserPermissionRequestBinding,
  type BrowserPermissionRequestBinding,
  type BrowserSitePermissionNotice,
  type BrowserSitePermissionRequestReadback,
} from './browser-permission-policy'
import { BrowserTabLifecycleService } from './tab-lifecycle-service'
import {
  downloadRemoteMediaDropUrls,
  scheduleRemoteMediaDropCleanup,
} from './remote-media-drop-cache'
import { type BrowserTabMetaRecord, BrowserTabMetaService } from './tab-meta-service'
import { BrowserTabShellService } from './tab-shell-service'
import {
  BrowserTaskPersistenceService,
  type BrowserResearchAssessment,
  type BrowserResearchEvidenceBindingInput,
  type VerifiedBrowserWorkflowEvidence,
  type BrowserResearchWorkItemInput,
  type BeginBrowserWorkflowActionInput,
  type BrowserWorkflowActiveAction,
  type BrowserWorkflowObservationReceipt,
  type BrowserWorkflowObservationResource,
  type RecordBrowserWorkflowObservationInput,
  type SettledBrowserWorkflowAction,
} from './task-persistence-service'
import type { BrowserActionOutcome } from '../../../shared/browser-action-outcome'
import { BrowserUtilityMenuService } from './utility-menu-service'
import { BrowserWindowOpenService } from './window-open-service'
import { withHtmlInCanvasWebPreferences } from '../app-control/html-in-canvas-feature'
import { getReadyBoardService } from '../board-engine/ipc-handler'
import {
  isAllowedBrowserURL,
  toOAuthCompatibleUserAgent,
} from './popup-policy'
import type { BrowserUtilityMenuRequest } from '../../../shared/browser-utility-menu'
import { mapBrowserAgentPointerToOverlay } from '../../../shared/browser-agent-pointer'
import { READY_BROWSER_BLANK_URL } from '../../../shared/browser-defaults'
import { parseBrowserLocalMediaDropUrl } from '../../../shared/browser-local-media-drop'
import type { BrowserPowerPreflightAuditRecord } from '../database'
import { readBrowserSessionStatus } from './browser-session-status'
import { BrowserPerformanceRuntime } from './browser-performance-runtime'
import type { RegisterDormantBrowserTabsRequest, RegisterDormantBrowserTabsResult } from '../../../shared/browser-tab-session'
import { browserSnapshotService } from './browser-snapshot-service'
import { disposeBrowserPageMapAmbiguity } from './browser-page-map-ambiguity-cache'
import { BrowserVisibilityRuntime } from './browser-visibility-runtime'
import type {
  BrowserHumanTakeoverIntentPort,
  BrowserTargetResumePort,
  BrowserTargetResumeRequest,
  BrowserHumanTakeoverPhysicalTarget,
  BrowserWorkflowWriteAdmissionPort,
  BrowserWorkflowWriteTarget,
} from '../../../shared/browser-workflow-control'

function sameBrowserWorkflowWriteTarget(
  left: BrowserWorkflowWriteTarget,
  right: BrowserWorkflowWriteTarget,
): boolean {
  return left.parentTaskId === right.parentTaskId
    && left.ownerRunId === right.ownerRunId
    && left.browserTaskId === right.browserTaskId
    && left.surface === right.surface
    && left.scopeId === right.scopeId
    && left.profileId === right.profileId
    && left.sessionId === right.sessionId
    && left.partition === right.partition
    && left.tabId === right.tabId
    && left.physicalTargetToken === right.physicalTargetToken
    && left.bootIncarnationId === right.bootIncarnationId
    && left.claimId === right.claimId
    && left.generation === right.generation
}

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
  profile?: string | null
  view?: BrowserHostView
  restoreSnapshot?: {
    entries: Electron.NavigationEntry[]
    index: number
  } | null
}

interface BrowserWorkflowJournalUnitOfWorkPort {
  beginAction(input: BeginBrowserWorkflowActionInput): BrowserWorkflowActiveAction
  settleAction(taskId: string, actionId: string, outcome: BrowserActionOutcome): SettledBrowserWorkflowAction
  recordObservation(input: RecordBrowserWorkflowObservationInput): BrowserWorkflowObservationReceipt
  upsertResearchWorkItems(taskId: string, ownerRunId: string, inputs: BrowserResearchWorkItemInput[]): BrowserResearchAssessment
  bindResearchEvidence(taskId: string, ownerRunId: string, bindings: BrowserResearchEvidenceBindingInput[]): BrowserResearchAssessment
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
  private readonly browserVisibilityRuntime: BrowserVisibilityRuntime
  private readonly localMediaDropRuns = new Map<string, number>()
  private readonly browserHostKind = BROWSER_HOST_KIND
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
  private readonly dialogService: BrowserDialogService
  private readonly fileChooserGuard: BrowserFileChooserGuard
  private readonly networkObserverService: BrowserNetworkObserverService
  private readonly automationService: BrowserAutomationService
  private readonly capabilityService: BrowserCapabilityService
  private readonly taskPersistenceService = new BrowserTaskPersistenceService()
  /** D18-d：agent 自注入输入直通登记（automation-service 派发前登记，两个 before-*-event 守卫凭此放行自家输入） */
  readonly agentInputPassthrough = new AgentInputPassthroughRegistry()
  /** Agent-tab supervision listener de-duplication. */
  private readonly supervisedAgentTabWebContentsIds = new Set<number>()
  /** Most recently created task-owned work tab, used only for supervision display. */
  private agentTabId: string | null = null
  private readonly agentWorkTabs = new Map<string, string>()
  private readonly tabLifecycleService: BrowserTabLifecycleService
  private readonly tabMetaService: BrowserTabMetaService<Tab>
  private readonly tabShellService: BrowserTabShellService
  private readonly performanceRuntime: BrowserPerformanceRuntime<Tab>
  private readonly sessionPolicyService: BrowserSessionPolicyService
  private readonly appShortcutBridgeService: BrowserAppShortcutBridgeService
  private readonly utilityMenuService: BrowserUtilityMenuService
  private readonly windowOpenService: BrowserWindowOpenService
  private readonly userViewTakeoverWebContentsIds = new Set<number>()
  private humanTakeoverIntentPort: BrowserHumanTakeoverIntentPort | null = null
  private targetResumePort: BrowserTargetResumePort | null = null
  private targetCheckpointResolver: ((parentTaskId: string) => string | null) | null = null
  private workflowWriteAdmissionPort: BrowserWorkflowWriteAdmissionPort | null = null
  private workflowJournalUnitOfWork: BrowserWorkflowJournalUnitOfWorkPort | null = null
  private readonly workflowPhysicalBindings = new Map<string, BrowserWorkflowWriteTarget>()
  private readonly pendingFileChooserNotices = new Map<string, Array<{
    target: BrowserPermissionRequestBinding
    notice: BrowserSitePermissionNotice
  }>>()
  private readonly pendingPhysicalTakeovers = new Set<string>()
  private p7cLiveProofClaimIdentity: BrowserTargetClaimIdentity | null = null

  publishAgentBrowserAction(event: { phase: 'start' | 'finish' | 'abort' }): void {
    publishBrowserAgentActionLifecycle(event.phase)
  }

  recordBrowserPowerPreflightAudit(record: BrowserPowerPreflightAuditRecord): void {
    this.dataService.addPowerPreflightAudit(record)
  }

  constructor(mainWindow: BrowserWindow, useMock = false) {
    this.mainWindow = mainWindow
    this.useMock = useMock
    this.dataService = new BrowserDataService()
    this.browserUserAgent = toOAuthCompatibleUserAgent(mainWindow.webContents.getUserAgent())
    this.downloadService = new BrowserDownloadService({
      dataService: this.dataService,
      sendToRenderer: (channel, data) => this.sendToRenderer(channel, data),
      resolveTabIdForWebContents: (webContentsId) => this.getTabIdForWebContents(webContentsId),
      onTabDownloadStateChange: () => this.performanceRuntime?.reconcile(),
    })
    this.diagnosticsService = new BrowserDiagnosticsService()
    this.hostLayoutService = new BrowserHostLayoutService(mainWindow)
    this.browserVisibilityRuntime = new BrowserVisibilityRuntime({
      hideAllHosts: () => this.tabShellService.hideAllHosts(),
      hideActiveHost: () => this.tabShellService.hideActiveHostOnly(),
      showActiveHost: () => this.tabShellService.showActiveHost(),
      applyIntent: (intent) => this.tabShellService.applyIntent(intent),
      clearAgentPointer: () => clearBrowserAgentPointer(),
      reconcileLoadStates: () => this.performanceRuntime.reconcile(),
      recordIntent: (kind) => this.performanceRuntime.recordIntent(kind),
      log: (message) => this.logBrowserDiag(message),
    })
    this.performanceRuntime = new BrowserPerformanceRuntime({
      getTabs: () => this.tabs.values(),
      getActiveTabId: () => this.activeTabId,
      getSplitTabId: () => this.splitTabId,
      shouldPresentHosts: () => this.browserVisibilityRuntime.shouldPresentHosts(),
      getProtectionReasons: (tabId) => [
        this.isTabLeaseProtected(tabId) ? 'agent-lease' : null,
        this.downloadService.isTabDownloading(tabId) ? 'download' : null,
        this.dialogService?.hasPending(tabId) ? 'dialog' : null,
        this.popupManager?.isSourceTabInPopupFlow(tabId) ? 'auth-popup' : null,
      ].filter((reason): reason is string => Boolean(reason)),
      detachHost: (view) => this.detachHost(view as BrowserHostView),
      disposeTabResources: (tabId) => this.disposeTabRuntimeResources(tabId),
      emitTabUpdate: (payload) => this.sendToRendererImmediate('browser:tabUpdate', payload),
      log: (message) => this.logBrowserDiag(message),
      getAppMetrics: () => app.getAppMetrics(),
    })
    this.pageBackgroundService = new BrowserPageBackgroundService((message) => this.logBrowserDiag(message))
    this.appShortcutBridgeService = new BrowserAppShortcutBridgeService({
      sendToRenderer: (channel, data) => this.sendToRenderer(channel, data),
    })
    this.popupManager = new AuthPopupManager(
      mainWindow,
      (url) => this.openPopupInTab(url),
      (message) => this.logBrowserDiag(message),
      this.browserUserAgent,
      () => this.performanceRuntime?.reconcile(),
    )
    this.contextMenuService = new BrowserContextMenuService({
      mainWindow,
      isAllowedUrl: (url) => isAllowedBrowserURL(url),
      createTab: (url, options) => this.createTab(url, options),
      addImageToActiveBoard: (url) => getReadyBoardService().importRemoteImageToActiveBoard(url),
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
    this.dialogService = new BrowserDialogService(this.cdpSessionService, () => {
      this.performanceRuntime.reconcile()
    })
    this.fileChooserGuard = new BrowserFileChooserGuard({
      cdp: this.cdpSessionService,
      resolveTabUrl: (tabId) => {
        try {
          return this.resolveTabView(tabId).view.webContents.getURL()
        } catch {
          return ''
        }
      },
      onIntercepted: (tabId, url) => this.recordFileChooserIntercepted(tabId, url),
      log: (message) => this.logBrowserDiag(message),
    })
    this.networkObserverService = new BrowserNetworkObserverService(this.cdpSessionService)
    this.previewService = new BrowserPreviewService({
      useMock: this.useMock,
      browserUserAgent: this.browserUserAgent,
      createHost: (partition) => {
        this.sessionPolicyService.applyForPartition(partition)
        return this.createHost(partition)
      },
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
      agentInputPassthrough: this.agentInputPassthrough,
      onTrustedInput: (event) => {
        if (event.tabId !== this.activeTabId || !this.browserVisibilityRuntime.shouldPresentHosts()) return
        if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) return
        const phase = event.kind === 'drag'
          ? 'drag'
          : event.type === 'mousePressed'
            ? 'press'
            : event.type === 'mouseReleased'
              ? 'release'
              : event.type === 'mouseWheel'
                ? 'scroll'
                : 'move'
        const pointer = mapBrowserAgentPointerToOverlay({
          x: Number(event.x),
          y: Number(event.y),
          pageZoomFactor: event.pageZoomFactor,
          bounds: {
            left: this.viewBounds.x,
            top: this.viewBounds.y,
            width: this.viewBounds.width,
            height: this.viewBounds.height,
          },
        })
        publishBrowserAgentPointer({
          tabId: event.tabId,
          phase,
          x: pointer.x,
          y: pointer.y,
          bounds: {
            left: this.viewBounds.x,
            top: this.viewBounds.y,
            width: this.viewBounds.width,
            height: this.viewBounds.height,
          },
        })
      },
    })
    this.capabilityService = new BrowserCapabilityService({
      getActiveTab: () => this.getActiveTab(),
      executeJS: (tabId, code) => this.executeJS(tabId, code),
      dispatchMouse: (tabId, payload) => this.dispatchMouse(tabId, payload as unknown as BrowserMouseEventPayload),
      downloadUrlToDirectory: (payload) => this.downloadUrlToDirectory(payload),
    })
    this.tabMetaService = new BrowserTabMetaService({
      tabs: this.tabs,
      getActiveTabId: () => this.activeTabId,
      queueTabUpdate: (data) => this.performanceRuntime.queueTabUpdate(data),
    })
    this.tabLifecycleService = new BrowserTabLifecycleService({
      tabs: this.tabs,
      getActiveTabId: () => this.activeTabId,
      setActiveTabId: (tabId) => {
        this.activeTabId = tabId
      },
      setSplitTabId: (tabId) => {
        this.splitTabId = tabId
      },
      observeRestoredTabId: (tabId) => {
        const numericId = /^tab-(\d+)$/.exec(tabId)?.[1]
        if (numericId) this.tabCounter = Math.max(this.tabCounter, Number(numericId))
      },
      getNextTabId: () => `tab-${++this.tabCounter}`,
      getViewBounds: () => this.viewBounds,
      shouldPresentHosts: () => this.browserVisibilityRuntime.shouldPresentHosts(),
      isAllowedUrl: (url) => isAllowedBrowserURL(url, { allowLocalHtml: true }),
      extractDomain: (url) => extractBrowserDomain(url),
      createHost: (partition) => {
        this.sessionPolicyService.applyForPartition(partition)
        return this.createHost(partition)
      },
      resetPageBackground: (view) => this.pageBackgroundService.reset(view),
      syncPageBackground: (view) => this.pageBackgroundService.sync(view),
      applyBounds: (view) => this.applyBounds(view),
      detachHost: (view) => this.detachHost(view),
      showHost: (view, bounds) => this.showHost(view, bounds),
      sendToRenderer: (channel, data) => this.sendToRenderer(channel, data),
      queueTabUpdate: (data) => this.performanceRuntime.queueTabUpdate(data),
      buildTabPayload: (tab) => this.tabMetaService.buildTabPayload(tab),
      emitTabMeta: (tabId) => this.emitTabMeta(tabId),
      logBrowserDiag: (message) => this.logBrowserDiag(message),
      bindPopup: (webContents) => {
        const sourceTabId = this.getTabIdForWebContents(webContents.id)
        this.popupManager.bindWindow(webContents, {
          sourceTabId,
          sourceOwner: sourceTabId ? this.tabs.get(sourceTabId)?.owner ?? null : null,
          profile: sourceTabId ? this.tabs.get(sourceTabId)?.profile ?? null : null,
        })
      },
      bindAppShortcutBridge: (webContents) => this.bindAppShortcutBridge(webContents),
      installContextMenu: (webContents) => this.contextMenuService.install(webContents),
      handleWindowOpen: (details, source, sourceContentsId) => this.handleWindowOpen(details, source, sourceContentsId),
      ensureDownloadSession: (targetSession) => this.downloadService.ensureRegistered(targetSession),
      addHistoryEntry: (url, title, metadata) => this.dataService.addHistoryEntry(url, title, metadata),
      updateHistoryEntryTitle: (url, title, favicon) => this.dataService.updateHistoryEntryTitle(url, title, favicon),
      handleLocalMediaDropNavigation: (tabId, url) => this.handleLocalMediaDropNavigation(tabId, url),
      onTabLoadStateMayChange: (tabId, reason) => this.performanceRuntime.onLoadStateMayChange(tabId, reason),
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
      shouldPresentHosts: () => this.browserVisibilityRuntime.shouldPresentHosts(),
      isAllowedUrl: (url) => isAllowedBrowserURL(url, { allowLocalHtml: true }),
      createTab: (url) => this.createTab(url),
      materializeTab: (tabId) => this.tabLifecycleService.materializeTab(tabId),
      detachHost: (view) => this.detachHost(view),
      showHost: (view, bounds) => this.showHost(view, bounds),
      applyBounds: (view, bounds) => this.applyBounds(view, bounds),
      hideHost: (view) => this.hideHost(view),
      isHostAttached: (view) => this.hostLayoutService.isHostAttached(view),
      detachPreviewView: () => this.detachPreviewView(),
      restoreActiveTabHost: () => this.restoreActiveTabHost(),
    })
    this.sessionPolicyService = new BrowserSessionPolicyService({
      dataService: this.dataService,
      sendToRenderer: (channel, data) => this.sendToRenderer(channel, data),
      resolveOriginDomain: (webContentsId) => this.resolveOriginDomainForWebContentsId(webContentsId),
      isPreviewWebContentsId: (webContentsId) => this.previewService.matchesWebContentsId(webContentsId),
      getMainWindow: () => (this.mainWindow && !this.mainWindow.isDestroyed() ? this.mainWindow : null),
      resolveAgentPermissionBinding: (webContentsId, partition) => (
        this.resolveAgentPermissionBinding(webContentsId, partition)
      ),
      isAgentPermissionBindingLive: (binding) => this.isAgentPermissionBindingLive(binding),
      logDiagnostics: (message) => this.diagnosticsService.log(message),
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
    getBrowserTargetClaimService().onTransition((transition) => {
      this.notifyBrowserLeaseChanged()
      this.notifyAgentControlChanged()
      this.performanceRuntime.reconcile()
      // D16 — 写租约离开 held（释放/接管/过期）即解除文件选择器拦截，
      // 用户随后的原生选择器行为不受 agent 遗留影响。
      if (transition.previousState === 'held' && transition.state !== 'held') {
        clearBrowserAgentPointer()
        publishBrowserAgentActionLifecycle('abort')
        void this.fileChooserGuard.disarmAll()
      }
    })
    setBrowserTargetClaimRunCloseoutPort((input) => {
      getBrowserTargetClaimService().closeoutRun(input)
    })
  }

  private logBrowserDiag(message: string): void {
    this.diagnosticsService.log(message)
  }

  private isTabLeaseProtected(tabId: string): boolean {
    return getBrowserTargetClaimService().list()
      .some((claim) => claim.logicalKey.tabId === tabId && claim.state === 'held')
  }

  private disposeTabRuntimeResources(tabId: string): void {
    this.dialogService.clear(tabId)
    this.fileChooserGuard.disposeTab(tabId)
    this.sessionPolicyService.expireSitePermissionRequestsForTab(tabId)
    this.pendingFileChooserNotices.delete(tabId)
    browserSnapshotService.disposeTab(this, tabId)
    disposeBrowserPageMapAmbiguity(tabId)
    this.cdpSessionService.disposeTab(tabId)
    this.networkObserverService.disposeTab(tabId)
  }

  // ── Internal helpers ──────────────────────────────────────────────

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

  private partitionForTab(tabId: string): string | null {
    const tab = this.tabs.get(tabId)
    if (!tab) return null
    const profile = String(tab.profile || '').trim().toLowerCase()
    return profile ? `persist:browser-profile-${profile}` : 'persist:browser'
  }

  private resolveAgentPermissionBinding(
    webContentsId: number | undefined,
    partition: string,
  ): BrowserPermissionRequestBinding | null {
    const tabId = this.getTabIdForWebContents(webContentsId)
    return tabId ? this.resolveAgentPermissionBindingForTab(tabId, partition) : null
  }

  private resolveAgentPermissionBindingForTab(
    tabId: string,
    partition: string,
  ): BrowserPermissionRequestBinding | null {
    if (this.partitionForTab(tabId) !== partition) return null
    const workflowTarget = this.workflowPhysicalBindings.get(tabId) || null
    return resolveAgentPermissionRequestBinding({
      partition,
      tabId,
      physicalTargetToken: this.getPhysicalTargetToken(tabId) || null,
      workflowTarget,
      admittedTarget: workflowTarget && this.isBrowserWorkflowWriteAdmitted(workflowTarget)
        ? workflowTarget
        : null,
    })
  }

  private isAgentPermissionBindingLive(binding: BrowserPermissionRequestBinding): boolean {
    return this.partitionForTab(binding.tabId) === binding.partition
      && this.getPhysicalTargetToken(binding.tabId) === binding.physicalTargetToken
  }

  private recordFileChooserIntercepted(tabId: string, url: string): void {
    const partition = this.partitionForTab(tabId)
    const target = partition ? this.resolveAgentPermissionBindingForTab(tabId, partition) : null
    if (!target) return
    const records = this.pendingFileChooserNotices.get(tabId) || []
    records.push({
      target,
      notice: {
        kind: 'file_chooser_intercepted',
        permission: '',
        origin: url || tabId,
        at: new Date().toISOString(),
        guidance: 'The page opened a native file chooser. Use browser_find and browser_upload on this exact tab instead of waiting for the native dialog.',
      },
    })
    this.pendingFileChooserNotices.set(tabId, records.slice(-4))
  }

  consumeBrowserSiteNotices(target: BrowserWorkflowWriteTarget): BrowserSitePermissionNotice[] {
    if (!this.isBrowserWorkflowWriteAdmitted(target)) return []
    const notices = this.sessionPolicyService.consumeSitePermissionNotices(target)
    const fileChooserRecords = this.pendingFileChooserNotices.get(target.tabId) || []
    this.pendingFileChooserNotices.delete(target.tabId)
    for (const record of fileChooserRecords) {
      if (
        sameBrowserPermissionRequestBinding(record.target, {
          ...target,
        })
      ) notices.push(record.notice)
    }
    return notices
  }

  private syncPopupContextForTab(tabId: string): void {
    const tab = this.tabs.get(tabId)
    const webContents = tab?.view?.webContents
    if (!tab || !webContents) return
    this.popupManager.bindWindow(webContents, {
      sourceTabId: tab.id,
      sourceOwner: tab.owner,
      profile: tab.profile ?? null,
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
    const tabId = this.getTabIdForWebContents(view.webContents.id)
    if (tabId && this.isAgentActivelyDrivingTab(tabId)) {
      this.hostLayoutService.parkHost(view, this.currentBoundsForTab(tabId))
      return
    }
    this.hostLayoutService.hideHost(view)
  }

  sendToRenderer(channel: string, data: unknown): void {
    this.sendToRendererImmediate(channel, data)
  }

  private sendToRendererImmediate(channel: string, data: unknown): void {
    if (!this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data)
    }
  }

  notifyTabClosed(tabId: string): void {
    this.performanceRuntime.queueTabUpdate({
      type: 'closed',
      tabId,
      activeTabId: this.activeTabId,
    })
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
    context: { sourceTabId?: string | null; sourceOwner?: BrowserTabOwner | null; profile?: string | null } = {},
  ): void {
    const agentOwned = context.sourceOwner === 'agent'
    void this.createTab(url, {
      background: agentOwned,
      openerTabId: context.sourceTabId ?? null,
      profile: context.profile ?? null,
    })
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
    bounds: BrowserRect = this.viewBounds,
  ): void {
    this.hostLayoutService.applyBounds(view, bounds)
  }

  applyPreviewBounds(view: BrowserHostView): void {
    this.hostLayoutService.applyBounds(view, this.previewBounds)
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
      this.applyBounds(activeTab.view)
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
    this.performanceRuntime.reconcile()
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

  getTabList() {
    return this.tabMetaService.getTabList()
  }

  getDiagnostics(options?: { includePerformance?: boolean }) {
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
      ...this.performanceRuntime.getDiagnostics(options?.includePerformance),
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

  getPhysicalTargetToken(tabId: string | null): string {
    return this.automationService.getPhysicalTargetToken(tabId)
  }

  setHumanTakeoverIntentPort(port: BrowserHumanTakeoverIntentPort | null): void {
    this.humanTakeoverIntentPort = port
  }

  setBrowserTargetResumePort(port: BrowserTargetResumePort | null): void {
    this.targetResumePort = port
  }

  setBrowserTargetCheckpointResolver(port: ((parentTaskId: string) => string | null) | null): void {
    this.targetCheckpointResolver = port
  }

  async resumeBrowserTarget(input: BrowserTargetResumeRequest): Promise<{ success: boolean; error?: string; errorKind?: string }> {
    if (!this.targetResumePort) return { success: false, error: 'target_resume_unavailable', errorKind: 'resume_failed' }
    return this.targetResumePort(input)
  }

  setBrowserWorkflowWriteAdmissionPort(port: BrowserWorkflowWriteAdmissionPort | null): void {
    this.workflowWriteAdmissionPort = port
  }

  setBrowserWorkflowJournalUnitOfWork(port: BrowserWorkflowJournalUnitOfWorkPort | null): void {
    this.workflowJournalUnitOfWork = port
  }

  /** Bind the physical Browser target to the durable Parent/child owner while
   * that owner is live. The returned cleanup is identity guarded so an older
   * run cannot erase a newer binding for the same tab. */
  bindBrowserWorkflowPhysicalTarget(input: BrowserWorkflowWriteTarget): () => void {
    const binding = { ...input }
    this.workflowPhysicalBindings.set(input.tabId, binding)
    return () => {
      if (this.workflowPhysicalBindings.get(input.tabId) === binding) {
        this.workflowPhysicalBindings.delete(input.tabId)
      }
    }
  }

  isBrowserWorkflowWriteAdmitted(input: BrowserWorkflowWriteTarget): boolean {
    const current = this.workflowPhysicalBindings.get(input.tabId)
    if (!current || !sameBrowserWorkflowWriteTarget(current, input)) return false
    if (this.pendingPhysicalTakeovers.has(input.tabId)) return false
    if (this.getPhysicalTargetToken(input.tabId) !== input.physicalTargetToken) return false
    const denied = getBrowserTargetClaimService().checkWrite({
      partition: input.partition,
      tabId: input.tabId,
      physicalTargetToken: input.physicalTargetToken,
      bootIncarnationId: input.bootIncarnationId,
      claimId: input.claimId,
      generation: input.generation,
      ownerRunId: input.ownerRunId,
    })
    if (denied) return false
    if (!this.workflowWriteAdmissionPort) return false
    return this.workflowWriteAdmissionPort(input)
  }

  /** Apply the already-committed durable fence to the matching native target.
   * This is deliberately scoped to one physical tab; unrelated tabs sharing a
   * coarse surface remain available. */
  fenceBrowserWorkflowPhysicalTarget(input: BrowserWorkflowWriteTarget): boolean {
    const current = this.workflowPhysicalBindings.get(input.tabId)
    if (!current || !sameBrowserWorkflowWriteTarget(current, input)) return false
    if (this.getPhysicalTargetToken(input.tabId) !== input.physicalTargetToken) return false
    this.workflowPhysicalBindings.delete(input.tabId)
    const tab = this.tabs.get(input.tabId)
    if (tab) {
      this.updateTabRuntimeState(input.tabId, { owner: 'manual', activity: 'attention' })
      this.syncPopupContextForTab(input.tabId)
      if (this.agentTabId === input.tabId) this.agentTabId = null
    }
    this.notifyAgentControlChanged()
    return true
  }

  beginBrowserWorkflowAction(input: BeginBrowserWorkflowActionInput) {
    if (!this.workflowJournalUnitOfWork) throw new Error('browser_workflow_journal_unit_of_work_unavailable')
    return this.workflowJournalUnitOfWork.beginAction(input)
  }

  settleBrowserWorkflowAction(taskId: string, actionId: string, outcome: BrowserActionOutcome): SettledBrowserWorkflowAction {
    if (!this.workflowJournalUnitOfWork) throw new Error('browser_workflow_journal_unit_of_work_unavailable')
    return this.workflowJournalUnitOfWork.settleAction(taskId, actionId, outcome)
  }

  recordBrowserWorkflowObservation(input: RecordBrowserWorkflowObservationInput): BrowserWorkflowObservationReceipt {
    if (!this.workflowJournalUnitOfWork) throw new Error('browser_workflow_journal_unit_of_work_unavailable')
    return this.workflowJournalUnitOfWork.recordObservation(input)
  }

  readHighestBrowserWorkflowObservation(taskId: string): BrowserWorkflowObservationReceipt | null {
    return this.taskPersistenceService.readHighestObservation(taskId)
  }

  readBrowserWorkflowObservationResource(taskId: string, resourceId: string): BrowserWorkflowObservationResource | null {
    return this.taskPersistenceService.readObservationResource(taskId, resourceId)
  }

  listBrowserWorkflowObservationResources(taskId: string): BrowserWorkflowObservationResource[] {
    return this.taskPersistenceService.listObservationResources(taskId)
  }

  readVerifiedBrowserWorkflowEvidence(taskId: string): VerifiedBrowserWorkflowEvidence {
    return this.taskPersistenceService.readVerifiedWorkflowEvidence(taskId)
  }

  getBrowserInputEnvironment(tabId: string | null): {
    mainWindowForeground: boolean
    hostPresentation: BrowserHostPresentationState
    tabActive: boolean
  } {
    const resolved = this.resolveTabView(tabId)
    return {
      mainWindowForeground: !this.mainWindow.isDestroyed()
        && this.mainWindow.isVisible()
        && !this.mainWindow.isMinimized()
        && this.mainWindow.isFocused(),
      hostPresentation: this.hostLayoutService.getHostPresentationState(resolved.view),
      tabActive: resolved.tabId === this.activeTabId,
    }
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

  async scrollCollect(
    tabId: string | null,
    options: BrowserScrollCollectOptions,
    signal?: AbortSignal,
  ): Promise<BrowserScrollCollectResult> {
    return this.capabilityService.scrollCollect(tabId, options, signal)
  }

  aggregateResults(items: BrowserStructuredItem[], options?: BrowserAggregateOptions): BrowserStructuredItem[] {
    return this.capabilityService.aggregateResults(items, options)
  }

  async getTask(taskId: string): Promise<BrowserCapabilityTaskHandle | null> {
    return this.taskPersistenceService.getTask(taskId)
  }

  getTaskPayload(taskId: string): Record<string, unknown> | null {
    return this.taskPersistenceService.getTaskPayload(taskId)
  }

  upsertBrowserResearchWorkItems(
    taskId: string,
    ownerRunId: string,
    workItems: BrowserResearchWorkItemInput[],
  ): BrowserResearchAssessment {
    if (!this.workflowJournalUnitOfWork) throw new Error('browser_workflow_journal_unit_of_work_unavailable')
    return this.workflowJournalUnitOfWork.upsertResearchWorkItems(taskId, ownerRunId, workItems)
  }

  bindBrowserResearchEvidence(
    taskId: string,
    ownerRunId: string,
    bindings: BrowserResearchEvidenceBindingInput[],
  ): BrowserResearchAssessment {
    if (!this.workflowJournalUnitOfWork) throw new Error('browser_workflow_journal_unit_of_work_unavailable')
    return this.workflowJournalUnitOfWork.bindResearchEvidence(taskId, ownerRunId, bindings)
  }

  assessBrowserResearch(taskId: string): BrowserResearchAssessment {
    return this.taskPersistenceService.assessResearch(taskId)
  }

  /**
   * A real user key or mouse action on an actively driven agent tab takes over
   * immediately. Agent-injected CDP input is identified by
   * `agentInputPassthrough` and still passes without changing ownership.
   *
   * The user event is never cancelled: the synchronous part of
   * requestAgentInterruption freezes the gate and flips the write lease before
   * this handler returns, then task cancellation continues asynchronously.
   */
  private attachAgentTabSupervision(tabId: string): void {
    const webContents = this.tabs.get(tabId)?.view?.webContents
    if (!webContents || this.supervisedAgentTabWebContentsIds.has(webContents.id)) return
    this.supervisedAgentTabWebContentsIds.add(webContents.id)
    webContents.once('destroyed', () => {
      this.supervisedAgentTabWebContentsIds.delete(webContents.id)
    })
    const inputTakeover = createAgentTabUserInputTakeoverHandlers({
      isActivelyDriven: () => this.isAgentActivelyDrivingTab(tabId),
      isFrozen: () => this.pendingPhysicalTakeovers.has(tabId),
      isAgentKey: (key) => this.agentInputPassthrough.matchKey(key),
      isAgentMouse: () => this.agentInputPassthrough.matchMouse(),
      takeOver: () => { void this.requestAgentInterruption(tabId, 'physical_input') },
    })
    webContents.on('before-input-event', (event, input) => {
      inputTakeover.onKeyboardInput(event, input)
    })
    webContents.on('before-mouse-event', (event, mouse) => {
      inputTakeover.onMouseInput(event, mouse)
    })
  }

  /** A tab is actively driven only while its exact target claim is held. */
  private isAgentActivelyDrivingTab(tabId: string): boolean {
    if (getBrowserTargetClaimService().list().some((claim) => (
      claim.logicalKey.tabId === tabId && claim.state === 'held'
    ))) return true
    return false
  }

  private notifyAgentControlChanged(): void {
    this.sendToRenderer('browser:agentControlChanged', { state: this.getAgentControlState() })
  }

  private notifyBrowserLeaseChanged(): void {
    this.sendToRenderer('browser:leaseChanged', this.getBrowserLeaseSnapshot())
  }

  private attachTargetClaimSupervision(tabId: string): void {
    const webContents = this.tabs.get(tabId)?.view?.webContents
    if (!webContents || this.userViewTakeoverWebContentsIds.has(webContents.id)) return
    this.userViewTakeoverWebContentsIds.add(webContents.id)
    const inputTakeover = createAgentTabUserInputTakeoverHandlers({
      isActivelyDriven: () => this.isAgentActivelyDrivingTab(tabId),
      isFrozen: () => this.pendingPhysicalTakeovers.has(tabId),
      isAgentKey: (key) => this.agentInputPassthrough.matchKey(key),
      isAgentMouse: () => this.agentInputPassthrough.matchMouse(),
      takeOver: () => { void this.requestAgentInterruption(tabId, 'physical_input') },
    })
    webContents.on('before-input-event', (event, input) => {
      inputTakeover.onKeyboardInput(event, input)
    })
    webContents.on('before-mouse-event', (event, input) => {
      inputTakeover.onMouseInput(event, input)
    })
    webContents.once('destroyed', () => {
      this.userViewTakeoverWebContentsIds.delete(webContents.id)
    })
  }

  getAgentTabId(): string | null {
    const tab = this.agentTabId ? this.tabs.get(this.agentTabId) : null
    return tab?.owner === 'agent' ? this.agentTabId : null
  }

  /** Agent-view browser tasks (for supervision and immediate takeover). */
  async listAgentCollectionTasks(): Promise<BrowserCapabilityTaskHandle[]> {
    return []
  }

  /**
   * Freeze and transfer agent-view control in one action. Everything before the
   * first await is synchronous so a real key/mouse event can continue to the
   * page after the lease has already rejected further agent writes.
   */
  async requestAgentInterruption(
    requestedTabId?: string | null,
    source: BrowserHumanTakeoverPhysicalTarget['source'] = 'supervision_button',
    signalSource: 'keyboard' | 'pointer' | 'navigation' | 'explicit-button' = source === 'supervision_button'
      ? 'explicit-button'
      : 'keyboard',
  ): Promise<{
    state: 'active' | 'frozen'
    frozen: boolean
    takeoverTabId?: string | null
  }> {
    const claimService = getBrowserTargetClaimService()
    const claims = claimService.list().filter((claim) => claim.state === 'held')
    const selected = requestedTabId
      ? claims.find((claim) => claim.logicalKey.tabId === requestedTabId) || null
      : claims.find((claim) => claim.logicalKey.tabId === this.agentTabId)
        || claims[0]
        || null
    const takeoverTabId = requestedTabId || selected?.logicalKey.tabId || this.agentTabId
    const binding = takeoverTabId ? this.workflowPhysicalBindings.get(takeoverTabId) || null : null
    const physicalTargetToken = takeoverTabId ? this.getPhysicalTargetToken(takeoverTabId) : ''
    if (
      !selected
      || !takeoverTabId
      || !binding
      || binding.claimId !== selected.claimId
      || binding.generation !== selected.generation
      || !physicalTargetToken
      || !this.humanTakeoverIntentPort
    ) {
      return { state: this.getAgentControlState(), frozen: false, takeoverTabId: takeoverTabId || null }
    }
    if (signalSource === 'navigation' && claimService.hasActiveAgentAction({
      partition: selected.logicalKey.partition,
      tabId: selected.logicalKey.tabId,
      physicalTargetToken: selected.physicalTargetToken!,
      bootIncarnationId: selected.bootIncarnationId!,
      claimId: selected.claimId,
      generation: selected.generation,
      ownerRunId: selected.ownerRunId,
    })) {
      return { state: this.getAgentControlState(), frozen: false, takeoverTabId }
    }
    this.pendingPhysicalTakeovers.add(takeoverTabId)
    this.notifyAgentControlChanged()
    const persisted = await persistAgentTabUserTakeover({
      persist: async () => {
        await this.humanTakeoverIntentPort!({
          parentTaskId: binding.parentTaskId,
          ownerRunId: binding.ownerRunId,
          browserTaskId: binding.browserTaskId,
          targetClaimId: selected.claimId,
          targetClaimGeneration: selected.generation,
          surface: binding.surface,
          scopeId: binding.scopeId,
          profileId: this.tabs.get(takeoverTabId)?.profile || null,
          sessionId: binding.sessionId,
          tabId: takeoverTabId,
          physicalTargetToken,
          source,
        })
      },
      onPersisted: () => {},
      onPersistenceFailure: (error) => {
        this.logBrowserDiag(`[browser-takeover] durable intent failed; retaining physical fence tab=${takeoverTabId} error=${error instanceof Error ? error.message : String(error)}`)
      },
    })
    if (!persisted) {
      this.notifyAgentControlChanged()
      return { state: 'frozen', frozen: true, takeoverTabId }
    }
    const frozen = claimService.read(selected.logicalKey)
    if (frozen?.state !== 'user_owned') {
      this.logBrowserDiag(`[browser-takeover] durable intent committed without target fence tab=${takeoverTabId}`)
      return { state: 'frozen', frozen: true, takeoverTabId }
    }

    if (takeoverTabId && this.tabs.has(takeoverTabId)) {
      this.updateTabRuntimeState(takeoverTabId, { owner: 'manual', activity: 'attention' })
      this.syncPopupContextForTab(takeoverTabId)
      if (takeoverTabId === this.agentTabId) this.agentTabId = null
    }
    this.pendingPhysicalTakeovers.delete(takeoverTabId)
    this.notifyAgentControlChanged()

    return { state: 'frozen', frozen: true, takeoverTabId }
  }

  getAgentControlState(): 'active' | 'frozen' {
    return this.pendingPhysicalTakeovers.size > 0
      || getBrowserTargetClaimService().list().some((claim) => claim.state === 'user_owned')
      ? 'frozen'
      : 'active'
  }

  getBrowserLeaseSnapshot(): BrowserLeaseSupervisionSnapshot {
    return buildBrowserLeaseSupervisionSnapshot(getBrowserTargetClaimService())
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
    const physicalTargetToken = this.getPhysicalTargetToken(tab.id)
    if (!physicalTargetToken) return { success: false, error: 'physical target unavailable' }
    const service = getBrowserTargetClaimService()
    const ownerRunId = `p7c-live-proof-${Date.now()}`
    const claim = service.acquire({
      partition: partitionForBrowserProfile(tab.profile),
      physicalTargetToken,
      bootIncarnationId: bootIncarnationIdFromPhysicalTargetToken(physicalTargetToken),
      profileId: tab.profile || null,
      surface: 'user-view',
      parentTaskId: 'p7c-live-proof',
      browserTaskId: 'p7c-live-proof',
      ownerRunId,
      scopeId: null,
      sessionId: null,
      tabId: tab.id,
      ttlMs: 30_000,
    })
    if (isAgentBrowserError(claim)) {
      return { success: false, error: claim.message || claim.errorCode }
    }
    this.p7cLiveProofClaimIdentity = {
      partition: claim.logicalKey.partition,
      tabId: claim.logicalKey.tabId,
      physicalTargetToken: claim.physicalTargetToken!,
      bootIncarnationId: claim.bootIncarnationId!,
      claimId: claim.claimId,
      generation: claim.generation,
      ownerRunId: claim.ownerRunId,
    }
    return { success: true, leaseId: claim.claimId, tabId: tab.id }
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

  async sendP7cLiveProofAgentClick(
    x = 140,
    y = 160,
  ): Promise<{ success: boolean; tabId?: string; x?: number; y?: number; error?: string }> {
    if (!this.isP7cLiveProofEnabled()) {
      return { success: false, error: 'p7c live proof is disabled' }
    }
    const tab = this.getActiveTab()
    if (!tab?.id || !tab.view?.webContents) {
      return { success: false, error: 'no active browser webContents' }
    }
    try {
      const metrics = await this.getViewportMetrics(tab.id)
      const clickX = Math.max(0, Math.min(Math.max(0, metrics.width - 1), Math.round(x)))
      const clickY = Math.max(0, Math.min(Math.max(0, metrics.height - 1), Math.round(y)))
      publishBrowserAgentActionLifecycle('start')
      await this.dispatchMouse(tab.id, { type: 'mouseMoved', x: clickX, y: clickY, button: 'none' })
      await this.dispatchMouse(tab.id, {
        type: 'mousePressed',
        x: clickX,
        y: clickY,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      })
      await this.dispatchMouse(tab.id, {
        type: 'mouseReleased',
        x: clickX,
        y: clickY,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      })
      return { success: true, tabId: tab.id, x: clickX, y: clickY }
    } catch (error) {
      publishBrowserAgentActionLifecycle('abort')
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  finishP7cLiveProofAgentAction(
    phase: 'finish' | 'abort' = 'finish',
  ): { success: boolean; phase?: 'finish' | 'abort'; error?: string } {
    if (!this.isP7cLiveProofEnabled()) {
      return { success: false, error: 'p7c live proof is disabled' }
    }
    publishBrowserAgentActionLifecycle(phase)
    return { success: true, phase }
  }

  checkP7cLiveProofWriteDenied(): { success: boolean; errorKind?: string; error?: string } {
    if (!this.isP7cLiveProofEnabled()) {
      return { success: false, error: 'p7c live proof is disabled' }
    }
    const denied = this.p7cLiveProofClaimIdentity
      ? getBrowserTargetClaimService().checkWrite(this.p7cLiveProofClaimIdentity)
      : agentBrowserError('lease_required', 'proof claim missing')
    if (!denied) return { success: false, error: 'write was still allowed' }
    return { success: true, errorKind: denied.errorCode }
  }

  clearP7cLiveProofState(): { success: boolean; error?: string } {
    if (!this.isP7cLiveProofEnabled()) {
      return { success: false, error: 'p7c live proof is disabled' }
    }
    if (this.p7cLiveProofClaimIdentity) {
      getBrowserTargetClaimService().closeTarget(this.p7cLiveProofClaimIdentity)
    }
    this.p7cLiveProofClaimIdentity = null
    publishBrowserAgentActionLifecycle('abort')
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
  async createTab(
    url: string,
    options?: { background?: boolean; openerTabId?: string | null; profile?: string | null; owner?: BrowserTabOwner },
  ): Promise<{ success: boolean; tabId?: string; error?: string }> {
    if (!options?.background) this.clearSplitTabHost()
    const result = await this.tabLifecycleService.createTab(url, options)
    if (result.success && result.tabId) {
      this.attachTargetClaimSupervision(result.tabId)
      if (options?.owner === 'agent') {
        this.agentTabId = result.tabId
        this.attachAgentTabSupervision(result.tabId)
      }
      void this.dialogService.ensure(result.tabId).catch(() => undefined)
      this.performanceRuntime.reconcile()
      this.performanceRuntime.scheduleReclaim()
    }
    return result
  }

  getAgentWorkTab(browserTaskId: string): string | null {
    const tabId = this.agentWorkTabs.get(browserTaskId) || null
    if (!tabId || this.tabs.get(tabId)?.owner !== 'agent') {
      if (tabId) this.agentWorkTabs.delete(browserTaskId)
      return null
    }
    return tabId
  }

  async ensureAgentWorkTab(
    browserTaskId: string,
    url = 'about:blank',
  ): Promise<{ success: boolean; tabId?: string; error?: string }> {
    const current = this.getAgentWorkTab(browserTaskId)
    if (current) return { success: true, tabId: current }
    const created = await this.createTab(url, { background: true, owner: 'agent' })
    if (created.success && created.tabId) this.agentWorkTabs.set(browserTaskId, created.tabId)
    return created
  }

  registerDormantTabs(request: RegisterDormantBrowserTabsRequest): RegisterDormantBrowserTabsResult {
    const result = this.tabLifecycleService.registerDormantTabs(request)
    this.performanceRuntime.reconcile()
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

  async retainTrustedInputSequence(tabId: string | null): Promise<() => void> {
    return this.automationService.retainTrustedInputSequence(tabId)
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
    const resolved = this.resolveTabView(tabId)
    const previousPresentation = this.hostLayoutService.getHostPresentationState(resolved.view)
    const temporarilyParked = previousPresentation === 'detached' || previousPresentation === 'hidden'
    if (temporarilyParked) {
      this.hostLayoutService.parkHost(resolved.view, this.currentBoundsForTab(resolved.tabId))
    }
    try {
      return await this.automationService.dispatchKey(resolved.tabId, payload)
    } finally {
      if (temporarilyParked && this.hostLayoutService.getHostPresentationState(resolved.view) === 'parked') {
        if (previousPresentation === 'detached') this.hostLayoutService.detachHost(resolved.view)
        else this.hostLayoutService.hideHost(resolved.view)
      }
    }
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
  async executeJS(tabId: string | null, code: string, options?: BrowserExecutionDeadlineOptions): Promise<unknown> {
    return this.automationService.executeJS(tabId, code, options)
  }

  /** D10 frame 穿透：列出主帧+子帧（frameKey '0'=主帧，子帧 pid-rid）。 */
  listContentFrames(tabId: string | null) {
    return this.automationService.listContentFrames(tabId)
  }

  /** D10 frame 穿透：在指定 frameKey 的帧内执行 JS（'0' 回落主帧路径）。 */
  async executeJSInFrame(tabId: string | null, frameKey: string, code: string, options?: BrowserExecutionDeadlineOptions): Promise<unknown> {
    return this.automationService.executeJSInFrame(tabId, frameKey, code, options)
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
  async navigate(tabId: string | null, url: string): Promise<{ success: boolean; error?: string }> {
    const resolvedTabId = tabId || this.activeTabId
    if (resolvedTabId) void this.requestAgentInterruption(resolvedTabId, 'physical_input', 'navigation')
    if (resolvedTabId && !this.tabs.get(resolvedTabId)?.view) {
      const materialized = this.tabLifecycleService.materializeTab(resolvedTabId, {
        activate: resolvedTabId === this.activeTabId,
      })
      if (!materialized.success) return { success: false, error: materialized.error }
      this.performanceRuntime.reconcile()
    }
    return this.tabShellService.navigate(tabId, url)
  }

  materializeBrowserTab(
    tabId: string,
    options: { preserveViewport?: boolean } = {},
  ): { success: boolean; tabId?: string; error?: string } {
    const result = this.tabLifecycleService.materializeTab(tabId, { activate: false })
    if (result.success) {
      const partition = this.partitionForTab(tabId)
      const physicalTargetToken = this.getPhysicalTargetToken(tabId)
      if (partition && physicalTargetToken) {
        const service = getBrowserTargetClaimService()
        const current = service.read({ partition, tabId })
        try {
          service.replacePhysicalTarget({
            partition,
            tabId,
            physicalTargetToken,
            bootIncarnationId: bootIncarnationIdFromPhysicalTargetToken(physicalTargetToken),
          }, current?.state === 'held'
            ? this.targetCheckpointResolver?.(current.parentTaskId) || null
            : null)
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
      }
      if (options.preserveViewport) {
        const view = this.tabs.get(tabId)?.view
        if (!view) return { success: false, error: 'Tab could not be materialized' }
        this.hostLayoutService.parkHost(view, this.currentBoundsForTab(tabId))
      }
      this.performanceRuntime.reconcile()
    }
    return result
  }

  /**
   * Go back in the active tab.
   */
  goBack(tabId: string | null): { success: boolean; error?: string } {
    const resolvedTabId = tabId || this.activeTabId
    if (resolvedTabId) void this.requestAgentInterruption(resolvedTabId, 'physical_input', 'navigation')
    return this.tabShellService.goBack(tabId)
  }

  goForward(tabId: string | null): { success: boolean; error?: string } {
    const resolvedTabId = tabId || this.activeTabId
    if (resolvedTabId) void this.requestAgentInterruption(resolvedTabId, 'physical_input', 'navigation')
    return this.tabShellService.goForward(tabId)
  }

  reload(tabId: string | null): { success: boolean; error?: string } {
    const resolvedTabId = tabId || this.activeTabId
    if (resolvedTabId) void this.requestAgentInterruption(resolvedTabId, 'physical_input', 'navigation')
    return this.tabShellService.reload(tabId)
  }

  closeTab(tabId: string): { success: boolean; error?: string } {
    const partition = this.partitionForTab(tabId)
    if (this.tabs.has(tabId)) this.disposeTabRuntimeResources(tabId)
    const result = this.tabShellService.closeTab(tabId)
    if (result.success) {
      if (partition) getBrowserTargetClaimService().closeTarget({ partition, tabId })
      this.workflowPhysicalBindings.delete(tabId)
      this.pendingPhysicalTakeovers.delete(tabId)
      this.performanceRuntime.disposeTab(tabId)
      for (const [browserTaskId, ownedTabId] of this.agentWorkTabs) {
        if (ownedTabId === tabId) this.agentWorkTabs.delete(browserTaskId)
      }
      if (this.agentTabId === tabId) this.agentTabId = null
    }
    return result
  }

  reorderTabs(tabIds: string[]): { success: boolean; error?: string } {
    return this.tabShellService.reorderTabs(tabIds)
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
    profile?: string | null
    owner?: BrowserTabOwner
    required?: boolean
    activity?: BrowserTabActivity
    lastAuditedAt?: number | null
    canGoBack?: boolean
    canGoForward?: boolean
  } {
    if (!this.tabs.get(tabId)?.view) {
      const materialized = this.tabLifecycleService.materializeTab(tabId)
      if (!materialized.success) return { success: false, error: materialized.error }
    }
    const result = this.tabShellService.switchTab(tabId)
    if (result.success) {
      this.performanceRuntime.noteInteraction(tabId)
      if (result.previousActiveTabId && result.previousActiveTabId !== (result.activeTabId ?? tabId)) {
        clearBrowserAgentPointer()
      }
    }
    return result
  }

  updateViewBounds(bounds: BrowserViewBoundsUpdate): { success: boolean } {
    clearBrowserAgentPointer()
    return this.tabShellService.updateViewBounds(bounds)
  }

  hideAllHosts(payload?: { requestId?: number }): { success: boolean } {
    return this.browserVisibilityRuntime.hideAll(payload)
  }

  hideActiveHost(payload?: { requestId?: number }): { success: boolean } {
    return this.browserVisibilityRuntime.hideActive(payload)
  }

  showActiveHost(payload?: { requestId?: number }): { success: boolean } {
    return this.browserVisibilityRuntime.showActive(payload)
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
    return this.browserVisibilityRuntime.applyIntent(intent)
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
    let targetSession = session.fromPartition('persist:browser')
    if (payload.tabId) {
      try { targetSession = this.resolveTabView(payload.tabId).view.webContents.session } catch { /* use default browser session */ }
    }
    return this.downloadService.downloadUrlToDirectory(targetSession, payload)
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
    options?: import('./cdp-session-service').BrowserCdpCommandOptions,
  ): Promise<unknown> {
    return this.cdpSessionService.sendCommand(tabId, method, params, options)
  }

  async callFunctionOnBackendNode(
    tabId: string | null,
    backendDOMNodeId: number,
    functionDeclaration: string,
    args: unknown[] = [],
  ): Promise<unknown> {
    const resolved = await this.sendCdpCommand(tabId, 'DOM.resolveNode', {
      backendNodeId: backendDOMNodeId,
    }) as { object?: { objectId?: unknown } } | null
    const objectId = String(resolved?.object?.objectId || '')
    if (!objectId) throw Object.assign(new Error('backend_node_not_resolved'), { code: 'BACKEND_NODE_NOT_RESOLVED' })
    try {
      const called = await this.sendCdpCommand(tabId, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: true,
      }) as {
        result?: { value?: unknown }
        exceptionDetails?: { text?: unknown; exception?: { description?: unknown } }
      } | null
      if (called?.exceptionDetails) {
        const message = String(called.exceptionDetails.exception?.description || called.exceptionDetails.text || 'backend_node_call_failed')
        throw Object.assign(new Error(message), { code: 'BACKEND_NODE_CALL_FAILED' })
      }
      return called?.result?.value
    } finally {
      await this.sendCdpCommand(tabId, 'Runtime.releaseObject', { objectId }).catch(() => undefined)
    }
  }

  /**
   * D16 — tool-executor 在 agent 写租约生效的写动作前调用，武装该 tab 的
   * 文件选择器拦截（幂等、best-effort）。解除由租约转移监听统一处理。
   */
  async armAgentFileChooserGuard(tabId: string | null): Promise<void> {
    await this.fileChooserGuard.arm(tabId)
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
  setupBrowserSupervisionIPC(controller)
  setupBrowserDataIPC(controller, browserDataService)
  setupBrowserPrivacyIPC(new BrowserPrivacyService({
    getSession: () => session.fromPartition('persist:browser'),
    data: browserDataService,
  }))
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

  return controller
}
