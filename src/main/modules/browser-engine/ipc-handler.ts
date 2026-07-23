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
import { BrowserController } from './browser-controller'

export { BrowserController } from './browser-controller'
export type { BrowserTabActivity, BrowserTabOwner } from './browser-controller-contract-base'
export { isAllowedBrowserURL } from './popup-policy'

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
