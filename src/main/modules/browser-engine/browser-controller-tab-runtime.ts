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
  isAgentNavigationEcho,
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
import { type BrowserTabActivity, type BrowserTabOwner, type Tab } from './browser-controller-contract-base'
import { BrowserControllerInteractionRuntime } from './browser-controller-interaction-runtime'

export abstract class BrowserControllerTabRuntime extends BrowserControllerInteractionRuntime {
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
  async navigate(tabId: string | null, url: string): Promise<{ success: boolean; error?: string }> {
    const resolvedTabId = tabId || this.activeTabId
    if (resolvedTabId) this.requestNavigationTakeover(resolvedTabId, 'navigate')
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
    if (resolvedTabId) this.requestNavigationTakeover(resolvedTabId, 'back')
    return this.tabShellService.goBack(tabId)
  }

  goForward(tabId: string | null): { success: boolean; error?: string } {
    const resolvedTabId = tabId || this.activeTabId
    if (resolvedTabId) this.requestNavigationTakeover(resolvedTabId, 'forward')
    return this.tabShellService.goForward(tabId)
  }

  reload(tabId: string | null): { success: boolean; error?: string } {
    const resolvedTabId = tabId || this.activeTabId
    if (resolvedTabId) this.requestNavigationTakeover(resolvedTabId, 'reload')
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
}
