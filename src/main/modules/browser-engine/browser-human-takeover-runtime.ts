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
import { type Tab } from './browser-controller-contract-base'
import { BrowserControllerHostRuntime } from './browser-controller-host-runtime'

export abstract class BrowserHumanTakeoverRuntime extends BrowserControllerHostRuntime {
  protected attachAgentTabSupervision(tabId: string): void {
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
  protected isAgentActivelyDrivingTab(tabId: string): boolean {
    if (getBrowserTargetClaimService().list().some((claim) => (
      claim.logicalKey.tabId === tabId && claim.state === 'held'
    ))) return true
    return false
  }

  protected notifyAgentControlChanged(takeoverError?: string | null): void {
    this.sendToRenderer('browser:agentControlChanged', {
      state: this.getAgentControlState(),
      takeoverError: takeoverError || null,
    })
  }

  protected notifyBrowserLeaseChanged(): void {
    this.sendToRenderer('browser:leaseChanged', this.getBrowserLeaseSnapshot())
  }

  protected attachTargetClaimSupervision(tabId: string): void {
    this.attachAgentTabSupervision(tabId)
  }

  protected requestNavigationTakeover(
    tabId: string,
    action: 'navigate' | 'back' | 'forward' | 'reload',
  ): void {
    const claim = getBrowserTargetClaimService().list().find((candidate) => (
      candidate.logicalKey.tabId === tabId && candidate.state === 'held'
    ))
    const binding = this.workflowPhysicalBindings.get(tabId)
    const physicalTargetToken = this.getPhysicalTargetToken(tabId)
    if (
      !claim
      || !binding
      || binding.claimId !== claim.claimId
      || binding.generation !== claim.generation
      || binding.ownerRunId !== claim.ownerRunId
      || !physicalTargetToken
      || claim.physicalTargetToken !== physicalTargetToken
      || !claim.bootIncarnationId
    ) return
    void this.requestAgentInterruption(tabId, 'physical_input', 'navigation', {
      action,
      tabId,
      physicalTargetToken,
      bootIncarnationId: claim.bootIncarnationId,
      claimId: claim.claimId,
      generation: claim.generation,
      ownerRunId: claim.ownerRunId,
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
    expectedNavigationTarget?: {
      action: 'navigate' | 'back' | 'forward' | 'reload'
      tabId: string
      physicalTargetToken: string
      bootIncarnationId: string
      claimId: string
      generation: number
      ownerRunId: string
    },
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
      || (expectedNavigationTarget && (
        signalSource !== 'navigation'
        || expectedNavigationTarget.tabId !== takeoverTabId
        || expectedNavigationTarget.physicalTargetToken !== physicalTargetToken
        || expectedNavigationTarget.bootIncarnationId !== selected.bootIncarnationId
        || expectedNavigationTarget.claimId !== selected.claimId
        || expectedNavigationTarget.generation !== selected.generation
        || expectedNavigationTarget.ownerRunId !== selected.ownerRunId
      ))
    ) {
      return { state: this.getAgentControlState(), frozen: false, takeoverTabId: takeoverTabId || null }
    }
    if (isAgentNavigationEcho({
      signalSource,
      hasActiveAgentAction: claimService.hasActiveAgentAction({
        partition: selected.logicalKey.partition,
        tabId: selected.logicalKey.tabId,
        physicalTargetToken: selected.physicalTargetToken!,
        bootIncarnationId: selected.bootIncarnationId!,
        claimId: selected.claimId,
        generation: selected.generation,
        ownerRunId: selected.ownerRunId,
      }),
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
      this.notifyAgentControlChanged('接管状态保存失败；为保护当前页面，Agent 仍保持暂停。')
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
    this.notifyAgentControlChanged(null)

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

}
