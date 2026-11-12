import { WebMcpService } from './webmcp-service'
import { isWebMcpExperimentActive } from './webmcp-experiment'
import { app, BrowserWindow, shell } from 'electron'
import { BrowserAppShortcutBridgeService } from './app-shortcut-service'
import { BrowserAutomationService } from './automation-service'
import { BrowserCapabilityService } from './capability-service'
import { BrowserCdpSessionService } from './cdp-session-service'
import { browserInputEnvironmentReadiness } from './browser-input-readiness'
import { BrowserDialogService } from './browser-dialog-service'
import { AgentInputPassthroughRegistry } from './agent-input-passthrough'
import { getBrowserTargetClaimService } from './browser-target-claim-singleton'
import { setBrowserTargetClaimRunCloseoutPort } from './browser-target-claim-closeout'
import {
  type BrowserTargetClaimIdentity
} from './browser-target-claims'
import { BrowserFileChooserGuard } from './file-chooser-guard'
import type {
  BrowserMouseEventPayload
} from './automation-types'
import { AuthPopupManager } from './auth-popup-manager'
import { BrowserBookmarkTransferService } from './bookmark-transfer-service'
import { BrowserContextMenuService } from './context-menu-service'
import { BrowserDataService } from './data-service'
import { BrowserDownloadService } from './download-service'
import { BrowserNetworkObserverService } from './network-observer-service'
import {
  BrowserDiagnosticsService
} from './diagnostics-service'
import { BrowserHostLayoutService } from './host-layout-service'
import {
  BROWSER_HOST_KIND,
  type BrowserHostView,
  type BrowserRect
} from './host-types'
import {
  clearBrowserAgentPointer,
  publishBrowserAgentActionLifecycle,
  publishBrowserAgentPointer
} from './ipc-browser-lock-overlay'
import { BrowserPreviewService } from './preview-service'
import { BrowserPageBackgroundService } from './page-background-service'
import { BrowserSessionPolicyService } from './session-policy-service'
import {
  type BrowserPermissionRequestBinding,
  type BrowserSitePermissionNotice
} from './browser-permission-policy'
import { BrowserTabLifecycleService } from './tab-lifecycle-service'
import { BrowserTabMetaService } from './tab-meta-service'
import { BrowserTabShellService } from './tab-shell-service'
import {
  BrowserTaskPersistenceService
} from './task-persistence-service'
import { BrowserUtilityMenuService } from './utility-menu-service'
import { BrowserWindowOpenService } from './window-open-service'
import {
  isAllowedBrowserURL,
  toOAuthCompatibleUserAgent,
} from './popup-policy'
import { mapBrowserAgentPointerToOverlay } from '../../../shared/browser-agent-pointer'
import type { BrowserPowerPreflightAuditRecord } from '../database/records'
import { BrowserPerformanceRuntime } from './browser-performance-runtime'
import { BrowserVisibilityRuntime } from './browser-visibility-runtime'
import type {
  BrowserWorkflowWriteAdmissionPort,
  BrowserWorkflowWriteTarget
} from '../../../shared/browser-workflow-control'
import {
  BrowserControllerContractBase,
  extractBrowserDomain, type BrowserWorkflowJournalUnitOfWorkPort,
  type Tab
} from './browser-controller-contract-base'

export abstract class BrowserControllerComposition extends BrowserControllerContractBase {
  tabs = new Map<string, Tab>()
  activeTabId: string | null = null
  splitTabId: string | null = null
  tabCounter = 0
  viewBounds: BrowserRect = { x: 0, y: 0, width: 800, height: 600 }
  splitViewBounds: BrowserRect = { x: 0, y: 0, width: 800, height: 600 }
  previewBounds: BrowserRect = { x: 0, y: 0, width: 800, height: 600 }
  protected readonly browserVisibilityRuntime: BrowserVisibilityRuntime
  protected readonly localMediaDropRuns = new Map<string, number>()
  protected readonly browserHostKind = BROWSER_HOST_KIND
  protected mainWindow: BrowserWindow
  protected useMock: boolean
  protected popupManager: AuthPopupManager
  protected readonly browserUserAgent: string
  protected readonly dataService: BrowserDataService
  protected readonly downloadService: BrowserDownloadService
  protected readonly diagnosticsService: BrowserDiagnosticsService
  protected readonly previewService: BrowserPreviewService
  protected readonly contextMenuService: BrowserContextMenuService
  protected readonly bookmarkTransferService: BrowserBookmarkTransferService
  protected readonly hostLayoutService: BrowserHostLayoutService
  protected readonly pageBackgroundService: BrowserPageBackgroundService
  readonly webMcp: WebMcpService
  protected readonly cdpSessionService: BrowserCdpSessionService
  protected readonly dialogService: BrowserDialogService
  protected readonly fileChooserGuard: BrowserFileChooserGuard
  protected readonly networkObserverService: BrowserNetworkObserverService
  protected readonly automationService: BrowserAutomationService
  protected readonly capabilityService: BrowserCapabilityService
  protected readonly taskPersistenceService = new BrowserTaskPersistenceService()
  /** D18-d：agent 自注入输入直通登记（automation-service 派发前登记，两个 before-*-event 守卫凭此放行自家输入） */
  readonly agentInputPassthrough = new AgentInputPassthroughRegistry()
  /** Agent-tab supervision listener de-duplication. */
  protected readonly supervisedAgentTabWebContentsIds = new Set<number>()
  /** Most recently created task-owned work tab, used only for supervision display. */
  protected agentTabId: string | null = null
  protected readonly agentWorkTabs = new Map<string, string>()
  protected readonly taskWorkTabs = new Map<string, { browserTaskId: string; openerTabId: string | null; physicalTargetToken: string }>()
  protected readonly tabLifecycleService: BrowserTabLifecycleService
  protected readonly tabMetaService: BrowserTabMetaService<Tab>
  protected readonly tabShellService: BrowserTabShellService
  protected readonly performanceRuntime: BrowserPerformanceRuntime<Tab>
  protected readonly sessionPolicyService: BrowserSessionPolicyService
  protected readonly appShortcutBridgeService: BrowserAppShortcutBridgeService
  protected readonly utilityMenuService: BrowserUtilityMenuService
  protected readonly windowOpenService: BrowserWindowOpenService
  protected targetCheckpointResolver: ((parentTaskId: string) => string | null) | null = null
  protected workflowWriteAdmissionPort: BrowserWorkflowWriteAdmissionPort | null = null
  protected workflowJournalUnitOfWork: BrowserWorkflowJournalUnitOfWorkPort | null = null
  protected readonly workflowPhysicalBindings = new Map<string, BrowserWorkflowWriteTarget>()
  protected readonly pendingFileChooserNotices = new Map<string, Array<{
    target: BrowserPermissionRequestBinding
    notice: BrowserSitePermissionNotice
  }>>()
  protected readonly pendingPhysicalTakeovers = new Set<string>()
  protected p7cLiveProofClaimIdentity: BrowserTargetClaimIdentity | null = null

  publishAgentBrowserAction(event: { phase: 'start' | 'finish' | 'abort' }): void {
    publishBrowserAgentActionLifecycle(event.phase)
  }

  recordBrowserPowerPreflightAudit(record: BrowserPowerPreflightAuditRecord): void {
    this.dataService.addPowerPreflightAudit(record)
  }

  constructor(mainWindow: BrowserWindow, useMock = false) {
    super()
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
      captureInputGuard: (tabId, method) => {
        if (!method.startsWith('Input.')) return undefined
        const resolved = this.resolveTabView(tabId)
        const binding = this.workflowPhysicalBindings.get(resolved.tabId)
        if (!binding) return undefined
        return () => {
          if (!this.isBrowserWorkflowWriteAdmitted(binding)) throw new Error('browser_write_admission_closed')
          if ((method === 'Input.dispatchMouseEvent' || method === 'Input.dispatchDragEvent')
            && !browserInputEnvironmentReadiness(this, resolved.tabId, 'trusted_pointer').ready) {
            throw new Error('browser_pointer_surface_unavailable')
          }
        }
      },
    })
    this.webMcp = new WebMcpService(this.cdpSessionService, isWebMcpExperimentActive())
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
      networkInFlight: tabId => this.cdpSessionService.networkInFlight(tabId),
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
      preparePageTools: tabId => this.webMcp.enableTab(tabId),
      preparePageObservation: tabId => this.cdpSessionService.ensureNetworkTracking(tabId),
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
}
