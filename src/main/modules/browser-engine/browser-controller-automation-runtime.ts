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
import { BrowserControllerTabRuntime } from './browser-controller-tab-runtime'

export abstract class BrowserControllerAutomationRuntime extends BrowserControllerTabRuntime {
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
