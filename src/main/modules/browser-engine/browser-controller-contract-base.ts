import type { BrowserMainPushChannel } from '../../../shared/browser-ipc-channels'
import { BrowserWindow } from 'electron'
import { type BrowserExecutionDeadlineOptions } from './automation-service'
import { type BrowserDialogSnapshot } from './browser-dialog-service'
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
import type {
  BrowserCDPErrorCode,
  BrowserKeyEventPayload,
  BrowserMouseEventPayload,
  BrowserScreenshotOptions,
  BrowserTabContextData,
  BrowserUploadTarget,
  BrowserViewportMetrics,
} from './automation-types'
import { type BrowserAdblockState } from './data-service'
import { type BrowserDownloadUrlToDirectoryPayload, type BrowserDownloadUrlToDirectoryResult } from './download-service'
import { type BrowserNetworkObserverHandle, type BrowserNetworkObserverOptions } from './network-observer-service'
import {
  type BrowserContinuityDiagnosticsSnapshot,
  type BrowserPageDiagnosticsSnapshot,
  type BrowserTaskDiagnosticsSnapshot
} from './diagnostics-service'
import type { BrowserHostPresentationState } from './host-layout-service'
import {
  type BrowserHostView,
  type BrowserRect,
  type BrowserViewBoundsUpdate,
  type PreviewTabState
} from './host-types'
import type { BrowserLeaseSupervisionSnapshot } from './ipc-supervision'
import {
  type BrowserPermissionRequestBinding,
  type BrowserSitePermissionNotice,
  type BrowserSitePermissionRequestReadback
} from './browser-permission-policy'
import { type BrowserTabMetaPayload, type BrowserTabMetaRecord } from './tab-meta-service'
import {
  type BrowserResearchAssessment,
  type BrowserResearchEvidenceBindingInput,
  type VerifiedBrowserWorkflowEvidence,
  type BrowserResearchWorkItemInput,
  type BeginBrowserWorkflowActionInput,
  type BrowserWorkflowActiveAction,
  type BrowserWorkflowObservationReceipt,
  type BrowserWorkflowObservationResource,
  type RecordBrowserWorkflowObservationInput,
  type SettledBrowserWorkflowAction
} from './task-persistence-service'
import type { BrowserActionOutcome } from '../../../shared/browser-action-outcome'
import type { BrowserPowerPreflightAuditRecord } from '../database/records'
import type { RegisterDormantBrowserTabsRequest, RegisterDormantBrowserTabsResult } from '../../../shared/browser-tab-session'
import type {
  BrowserHumanTakeoverPhysicalTarget,
  BrowserWorkflowWriteAdmissionPort,
  BrowserWorkflowWriteTarget,
} from '../../../shared/browser-workflow-control'

export function sameBrowserWorkflowWriteTarget(
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

export interface Tab extends BrowserTabMetaRecord {
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

export interface BrowserWorkflowJournalUnitOfWorkPort {
  beginAction(input: BeginBrowserWorkflowActionInput): BrowserWorkflowActiveAction
  settleAction(taskId: string, actionId: string, outcome: BrowserActionOutcome): SettledBrowserWorkflowAction
  recordObservation(input: RecordBrowserWorkflowObservationInput): BrowserWorkflowObservationReceipt
  upsertResearchWorkItems(taskId: string, ownerRunId: string, inputs: BrowserResearchWorkItemInput[]): BrowserResearchAssessment
  bindResearchEvidence(taskId: string, ownerRunId: string, bindings: BrowserResearchEvidenceBindingInput[]): BrowserResearchAssessment
}

export type BrowserTabOwner = 'manual' | 'agent'
export type BrowserTabActivity = 'idle' | 'running' | 'attention'

export function extractBrowserDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export abstract class BrowserControllerContractBase {
  abstract publishAgentBrowserAction(event: {
      phase: 'start' | 'finish' | 'abort';
  }): void;
  abstract recordBrowserPowerPreflightAudit(record: BrowserPowerPreflightAuditRecord): void;
  protected abstract logBrowserDiag(message: string): void;
  protected abstract isTabLeaseProtected(tabId: string): boolean;
  protected abstract disposeTabRuntimeResources(tabId: string): void;
  // ── Internal helpers ──────────────────────────────────────────────
  protected abstract resolveOriginDomainForWebContentsId(webContentsId?: number): string;
  protected abstract resolveUrlForWebContentsId(webContentsId?: number): string;
  protected abstract getTabIdForWebContents(webContentsId?: number): string | null;
  protected abstract partitionForTab(tabId: string): string | null;
  protected abstract resolveAgentPermissionBinding(webContentsId: number | undefined, partition: string): BrowserPermissionRequestBinding | null;
  protected abstract resolveAgentPermissionBindingForTab(tabId: string, partition: string): BrowserPermissionRequestBinding | null;
  protected abstract isAgentPermissionBindingLive(binding: BrowserPermissionRequestBinding): boolean;
  protected abstract recordFileChooserIntercepted(tabId: string, url: string): void;
  abstract consumeBrowserSiteNotices(target: BrowserWorkflowWriteTarget): BrowserSitePermissionNotice[];
  protected abstract syncPopupContextForTab(tabId: string): void;
  protected abstract emitTabMeta(tabId: string): void;
  abstract attachWindow(mainWindow: BrowserWindow): void;
  protected abstract createHost(partition: string): BrowserHostView;
  abstract detachHost(view: BrowserHostView): void;
  abstract showHost(view: BrowserHostView, bounds: {
      x: number;
      y: number;
      width: number;
      height: number;
  }): void;
  abstract hideHost(view: BrowserHostView): void;
  abstract sendToRenderer(channel: BrowserMainPushChannel, data: unknown): void;
  protected abstract sendToRendererImmediate(channel: BrowserMainPushChannel, data: unknown): void;
  abstract notifyTabClosed(tabId: string): void;
  protected abstract isDuplicateLocalMediaDrop(signature: string): boolean;
  protected abstract handleLocalMediaDropNavigation(tabId: string, url: string): boolean;
  protected abstract openPopupInTab(url: string, context?: {
      sourceTabId?: string | null;
      sourceOwner?: BrowserTabOwner | null;
      profile?: string | null;
  }): void;
  abstract getMainWindow(): BrowserWindow | null;
  abstract applyBounds(view: BrowserHostView, bounds?: BrowserRect): void;
  abstract applyPreviewBounds(view: BrowserHostView): void;
  protected abstract hideActiveTabHost(): boolean;
  protected abstract restoreActiveTabHost(): void;
  protected abstract currentBoundsForTab(tabId: string): BrowserRect;
  protected abstract clearSplitTabHost(): void;
  protected abstract bindAppShortcutBridge(webContents: Electron.WebContents): void;
  abstract getActiveTab(): Tab | undefined;
  protected abstract findReusableTabForCapture(targetUrl: string): Tab | null;
  protected abstract loadWebContentsURL(webContents: Electron.WebContents, url: string, timeoutMs: number): Promise<void>;
  abstract updateTabRuntimeState(tabId: string | null, updates: Partial<Pick<Tab, 'owner' | 'required' | 'activity' | 'lastAuditedAt'>>): Tab | null;
  abstract getAdblockState(): BrowserAdblockState;
  abstract setAdblockEnabled(enabled: boolean, scope?: 'main' | 'preview' | 'all'): BrowserAdblockState;
  abstract toggleAdblockDomain(domain: string): BrowserAdblockState;
  abstract getTabList(): Array<BrowserTabMetaPayload & { browserTaskId?: string }>;
  abstract getDiagnostics(options?: {
      includePerformance?: boolean;
  }): any;
  abstract reportAgentTaskDiagnostics(snapshot: BrowserTaskDiagnosticsSnapshot | null): void;
  abstract reportAgentPageDiagnostics(snapshot: BrowserPageDiagnosticsSnapshot | null): void;
  abstract reportAgentContinuityDiagnostics(snapshot: BrowserContinuityDiagnosticsSnapshot | null): void;
  abstract getTabContext(tabId?: string | null): Promise<BrowserTabContextData>;
  abstract getPhysicalTargetToken(tabId: string | null): string;
  abstract setBrowserTargetCheckpointResolver(port: ((parentTaskId: string) => string | null) | null): void;
  abstract setBrowserWorkflowWriteAdmissionPort(port: BrowserWorkflowWriteAdmissionPort | null): void;
  abstract setBrowserWorkflowJournalUnitOfWork(port: BrowserWorkflowJournalUnitOfWorkPort | null): void;
  /** Bind the physical Browser target to the durable Parent/child owner while
   * that owner is live. The returned cleanup is identity guarded so an older
   * run cannot erase a newer binding for the same tab. */
  abstract bindBrowserWorkflowPhysicalTarget(input: BrowserWorkflowWriteTarget): () => void;
  abstract isBrowserWorkflowWriteAdmitted(input: BrowserWorkflowWriteTarget): boolean;
  /** Apply the already-committed durable fence to the matching native target.
   * This is deliberately scoped to one physical tab; unrelated tabs sharing a
   * coarse surface remain available. */
  abstract fenceBrowserWorkflowPhysicalTarget(input: BrowserWorkflowWriteTarget): boolean;
  abstract beginBrowserWorkflowAction(input: BeginBrowserWorkflowActionInput): any;
  abstract settleBrowserWorkflowAction(taskId: string, actionId: string, outcome: BrowserActionOutcome): SettledBrowserWorkflowAction;
  abstract recordBrowserWorkflowObservation(input: RecordBrowserWorkflowObservationInput): BrowserWorkflowObservationReceipt;
  abstract readHighestBrowserWorkflowObservation(taskId: string): BrowserWorkflowObservationReceipt | null;
  abstract readBrowserWorkflowObservationResource(taskId: string, resourceId: string): BrowserWorkflowObservationResource | null;
  abstract listBrowserWorkflowObservationResources(taskId: string): BrowserWorkflowObservationResource[];
  abstract readVerifiedBrowserWorkflowEvidence(taskId: string): VerifiedBrowserWorkflowEvidence;
  abstract getBrowserInputEnvironment(tabId: string | null): {
      mainWindowForeground: boolean;
      hostPresentation: BrowserHostPresentationState;
      tabActive: boolean;
      backgroundWorkSurfaceAdmitted?: boolean;
  };
  abstract getTaskAttention(browserTaskId: string): import('../../../shared/browser-user-attention').BrowserUserAttention | null;
  abstract recordTaskAttention(target: import('../../../shared/browser-user-attention').BrowserAttentionTarget, reason: import('../../../shared/browser-user-attention').BrowserAttentionReason): void;
  abstract notifyTaskAttention(browserTaskId: string): void;
  abstract waitForCondition(tabId: string | null, options: BrowserWaitForConditionOptions, signal?: AbortSignal): Promise<{
      matched: boolean;
      elapsedMs: number;
      value?: unknown;
  }>;
  abstract extractStructured(tabId: string | null, options: BrowserExtractStructuredOptions): Promise<BrowserExtractStructuredResult>;
  abstract scrollCollect(tabId: string | null, options: BrowserScrollCollectOptions, signal?: AbortSignal): Promise<BrowserScrollCollectResult>;
  abstract aggregateResults(items: BrowserStructuredItem[], options?: BrowserAggregateOptions): BrowserStructuredItem[];
  abstract getTask(taskId: string): Promise<BrowserCapabilityTaskHandle | null>;
  abstract approveTaskWriteOrigin(browserTaskId: string, ownerRunId: string, origin: string): void;
  abstract resolveTaskDownloadDirectory(requested: unknown, roots: readonly string[]): string;
  abstract getTaskDownloadReceipts(request: { browserTaskId: string }): { success: boolean; downloadReceipts: import('../../../shared/browser-download-receipt').BrowserDownloadReceipt[]; error?: string };
  abstract consumeTaskDownload(file: unknown, directory: string, browserTaskId: string, ownerRunId: string): import('../../../shared/browser-download-receipt').BrowserDownloadReceipt;
  abstract getTaskPayload(taskId: string): Record<string, unknown> | null;
  abstract upsertBrowserResearchWorkItems(taskId: string, ownerRunId: string, workItems: BrowserResearchWorkItemInput[]): BrowserResearchAssessment;
  abstract bindBrowserResearchEvidence(taskId: string, ownerRunId: string, bindings: BrowserResearchEvidenceBindingInput[]): BrowserResearchAssessment;
  abstract assessBrowserResearch(taskId: string): BrowserResearchAssessment;
  /**
   * A real user key or mouse action on an actively driven agent tab takes over
   * immediately. Agent-injected CDP input is identified by
   * `agentInputPassthrough` and still passes without changing ownership.
   *
   * The user event is never cancelled: the synchronous part of
   * requestAgentInterruption freezes the gate and flips the write lease before
   * this handler returns, then task cancellation continues asynchronously.
   */
  protected abstract attachAgentTabSupervision(tabId: string): void;
  /** A tab is actively driven only while its exact target claim is held. */
  protected abstract isAgentActivelyDrivingTab(tabId: string): boolean;
  protected abstract notifyAgentControlChanged(takeoverError?: string | null): void;
  protected abstract notifyBrowserLeaseChanged(): void;
  protected abstract attachTargetClaimSupervision(tabId: string): void;
  protected abstract requestNavigationTakeover(tabId: string, action: 'navigate' | 'back' | 'forward' | 'reload'): void;
  abstract getAgentTabId(): string | null;
  /** Agent-view browser tasks (for supervision and immediate takeover). */
  abstract listAgentCollectionTasks(): Promise<BrowserCapabilityTaskHandle[]>;
  /**
   * Freeze and transfer agent-view control in one action. Everything before the
   * first await is synchronous so a real key/mouse event can continue to the
   * page after the lease has already rejected further agent writes.
   */
  abstract requestAgentInterruption(requestedTabId?: string | null, source?: BrowserHumanTakeoverPhysicalTarget['source'], signalSource?: 'keyboard' | 'pointer' | 'navigation' | 'explicit-button', expectedNavigationTarget?: {
      action: 'navigate' | 'back' | 'forward' | 'reload';
      tabId: string;
      physicalTargetToken: string;
      bootIncarnationId: string;
      claimId: string;
      generation: number;
      ownerRunId: string;
  }): Promise<{
      state: 'active' | 'frozen';
      frozen: boolean;
      takeoverTabId?: string | null;
  }>;
  abstract getAgentControlState(): 'active' | 'frozen';
  abstract getBrowserLeaseSnapshot(): BrowserLeaseSupervisionSnapshot;
  protected abstract isP7cLiveProofEnabled(): boolean;
  protected abstract readP7cLiveProofPageState(tab: Tab): Promise<{
      focusToken: string;
      scrollX: number;
      scrollY: number;
      url: string;
      title: string;
  }>;
  abstract prepareP7cLiveProofForegroundProbe(): Promise<{
      success: boolean;
      state?: {
          tabId: string;
          url: string;
          title: string;
          focusToken: string;
          scrollX: number;
          scrollY: number;
      };
      error?: string;
  }>;
  abstract sampleP7cLiveProofActiveTabState(): Promise<{
      success: boolean;
      state?: {
          tabId: string;
          url: string;
          title: string;
          focusToken: string;
          scrollX: number;
          scrollY: number;
      };
      error?: string;
  }>;
  abstract createP7cLiveProofManualTab(): Promise<{
      success: boolean;
      tabId?: string;
      error?: string;
  }>;
  abstract startP7cLiveProofUserViewLease(): {
      success: boolean;
      leaseId?: string;
      tabId?: string;
      error?: string;
  };
  abstract sendP7cLiveProofUserKey(key?: string): {
      success: boolean;
      error?: string;
  };
  abstract sendP7cLiveProofAgentClick(x?: number, y?: number): Promise<{
      success: boolean;
      tabId?: string;
      x?: number;
      y?: number;
      error?: string;
  }>;
  abstract finishP7cLiveProofAgentAction(phase?: 'finish' | 'abort'): {
      success: boolean;
      phase?: 'finish' | 'abort';
      error?: string;
  };
  abstract checkP7cLiveProofWriteDenied(): {
      success: boolean;
      errorKind?: string;
      error?: string;
  };
  abstract clearP7cLiveProofState(): {
      success: boolean;
      error?: string;
  };
  protected abstract createBrowserError(code: BrowserCDPErrorCode, message: string): Error;
  protected abstract resolveTabView(tabId: string | null): {
      tabId: string;
      tab: Tab;
      view: BrowserHostView;
  };
  protected abstract handleWindowOpen(details: {
      url: string;
      frameName?: string;
      features?: string;
      disposition?: string;
      referrer?: {
          url?: string;
      };
  }, source: 'tab' | 'preview', sourceContentsId: number): {
      action: 'allow' | 'deny';
      overrideBrowserWindowOptions?: Electron.BrowserWindowConstructorOptions;
  };
  abstract importBookmarksFromDialog(): Promise<{
      success: boolean;
      canceled?: boolean;
      imported?: number;
      skipped?: number;
      error?: string;
      filePath?: string;
  }>;
  abstract exportBookmarksToDialog(): Promise<{
      success: boolean;
      canceled?: boolean;
      exported?: number;
      error?: string;
      filePath?: string;
  }>;
  abstract showUtilityMenu(payload: unknown): {
      success: boolean;
  };
  abstract previewOpen(url: string): Promise<{
      success: boolean;
      error?: string;
  }>;
  abstract previewNavigate(url: string): Promise<{
      success: boolean;
      error?: string;
  }>;
  abstract previewGoBack(): {
      success: boolean;
      error?: string;
  };
  abstract previewGoForward(): {
      success: boolean;
      error?: string;
  };
  abstract previewReload(): {
      success: boolean;
      error?: string;
  };
  abstract previewUpdateBounds(bounds: {
      x: number;
      y: number;
      width: number;
      height: number;
  }): {
      success: boolean;
  };
  abstract previewClose(): {
      success: boolean;
  };
  abstract previewGetState(): PreviewTabState;
  abstract detachPreviewView(): void;
  // ── Programmatic API (for tool calling, not IPC) ──────────────────
  abstract getBrowserDialog(tabId: string | null): Promise<BrowserDialogSnapshot | null>;
  abstract handleBrowserDialog(tabId: string | null, params: {
      accept: boolean;
      promptText?: string;
  }): Promise<{
      success: boolean;
  }>;
  abstract archivePage(tabId: string | null, path: string, format: 'pdf' | 'mhtml' | 'html' | 'markdown', options?: {
      signal?: AbortSignal;
  }): Promise<{
      success: boolean;
      path: string;
      format: string;
  }>;
  abstract collectConsoleMessages(tabId: string | null, options?: {
      durationMs?: number;
      limit?: number;
  }): Promise<Array<Record<string, unknown>>>;
  abstract clearConsoleMessages(tabId: string | null): Promise<{
      success: boolean;
  }>;
  abstract getBrowserSessionStatus(tabId: string | null, requestedOrigin?: string): Promise<Record<string, unknown>>;
  abstract clearBrowserOriginData(tabId: string | null, requestedOrigin?: string, dataTypes?: string[]): Promise<{
      success: boolean;
      origin: string;
      cleared: string[];
  }>;
  abstract getBrowserPermission(siteRequestId: string): BrowserSitePermissionRequestReadback;
  abstract setBrowserPermission(siteRequestId: string, decision: 'allow' | 'deny'): BrowserSitePermissionRequestReadback;
  abstract resetBrowserPermission(tabId: string, origin: string, permission: string): Record<string, unknown>;
  /**
   * Create a new tab and navigate to URL. Returns the tab ID.
   */
  abstract createTab(url: string, options?: {
      background?: boolean;
      openerTabId?: string | null;
      profile?: string | null;
      owner?: BrowserTabOwner;
  }): Promise<{
      success: boolean;
      tabId?: string;
      error?: string;
  }>;
  abstract getAgentWorkTab(browserTaskId: string): string | null;
  abstract createAgentWorkTab(browserTaskId: string, url: string, openerTabId: string | null): Promise<{ success: boolean; tabId?: string; error?: string }>;
  abstract getTaskWorkTabIds(browserTaskId: string): string[];
  abstract selectTaskWorkTab(browserTaskId: string, tabId: string): { success: boolean; tabId?: string; presented?: boolean; error?: string };
  abstract closeTaskTabs(request: { browserTaskId: string }): { success: boolean; closedTabIds: string[]; error?: string };
  abstract ensureAgentWorkTab(browserTaskId: string, url?: string): Promise<{
      success: boolean;
      tabId?: string;
      error?: string;
  }>;
  abstract registerDormantTabs(request: RegisterDormantBrowserTabsRequest): RegisterDormantBrowserTabsResult;
  abstract openForCaptureTarget(url: string): Promise<{
      success: boolean;
      tabId?: string;
      reused?: boolean;
      error?: string;
  }>;
  abstract hasReusableCaptureTarget(url: string): boolean;
  /**
   * Attach Chrome DevTools Protocol debugger to a tab's webContents.
   * Safe to call repeatedly.
   */
  abstract ensureDebugger(tabId: string | null): Promise<{
      tabId: string;
  }>;
  /**
   * Resolve viewport metrics in CSS pixels.
   * Prefers window.visualViewport and falls back to CDP layout metrics.
   */
  abstract getViewportMetrics(tabId: string | null): Promise<BrowserViewportMetrics>;
  abstract retainTrustedInputSequence(tabId: string | null): Promise<() => void>;
  /**
   * Map normalized coordinates (0..999) into CSS pixel coordinates in viewport.
   */
  abstract normalizedToCss(tabId: string | null, x: number, y: number): Promise<{
      x: number;
      y: number;
      width: number;
      height: number;
  }>;
  /**
   * Dispatch low-level mouse event through CDP.
   */
  abstract dispatchMouse(tabId: string | null, payload: BrowserMouseEventPayload): Promise<void>;
  /**
   * Dispatch low-level keyboard event through CDP.
   */
  abstract dispatchKey(tabId: string | null, payload: BrowserKeyEventPayload): Promise<void>;
  /**
   * Insert text at current focus target via CDP.
   */
  abstract typeTextDirectly(tabId: string | null, text: string, options?: {
      useShiftEnterForNewline?: boolean;
  }): Promise<void>;
  /**
   * Take screenshot in different modes.
   */
  abstract screenshotAdvanced(tabId: string | null, options?: BrowserScreenshotOptions): Promise<string>;
  /**
   * Execute JavaScript in a tab's webContents. Runs in BrowserView sandbox (isolated from Node).
   */
  abstract executeJS(tabId: string | null, code: string, options?: BrowserExecutionDeadlineOptions): Promise<unknown>;
  /** D10 frame 穿透：列出主帧+子帧（frameKey '0'=主帧，子帧 pid-rid）。 */
  abstract listContentFrames(tabId: string | null): any;
  /** D10 frame 穿透：在指定 frameKey 的帧内执行 JS（'0' 回落主帧路径）。 */
  abstract executeJSInFrame(tabId: string | null, frameKey: string, code: string, options?: BrowserExecutionDeadlineOptions): Promise<unknown>;
  /**
   * Get the plain text content of a page (document.body.innerText), truncated to 30K chars.
   */
  abstract getPageContent(tabId: string | null): Promise<string>;
  abstract captureBackgroundPage(url: string, options?: {
      timeoutMs?: number;
      settleMs?: number;
      script?: string;
      cookies?: Array<{
          url: string;
          name: string;
          value: string;
          domain?: string;
          path?: string;
          secure?: boolean;
          httpOnly?: boolean;
          expirationDate?: number;
          sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
      }>;
  }): Promise<unknown>;
  abstract captureLiveTabPage(url: string, options?: {
      timeoutMs?: number;
      settleMs?: number;
      script?: string;
  }): Promise<unknown | null>;
  /**
   * Get the HTML content of a page (document.documentElement.outerHTML), truncated to 50K chars.
   */
  abstract getPageHTML(tabId: string | null): Promise<string>;
  /**
   * Take a screenshot of the tab, returned as base64 PNG.
   */
  abstract screenshot(tabId: string | null): Promise<string>;
  abstract findUploadTargets(tabId: string | null): Promise<BrowserUploadTarget[]>;
  abstract setFileInputFiles(tabId: string | null, payload: {
      files: string[];
      selector?: string;
      targetToken?: string;
      frameDocumentToken?: string;
      backendDOMNodeId?: number;
  }): Promise<{
      ok: boolean;
      targetDescription: string;
      inputFound: boolean;
      filesAssigned?: boolean;
      assignedFileNames?: string[];
  }>;
  abstract uploadLocalMediaFiles(tabId: string | null, payload: {
      files: string[];
      x?: number;
      y?: number;
  }): Promise<{
      success: boolean;
      method?: 'file-input' | 'drop';
      targetDescription?: string;
      assignedFileNames?: string[];
      error?: string;
  }>;
  /**
   * Navigate the active tab (or specified tab) to a URL.
   */
  abstract navigate(tabId: string | null, url: string): Promise<{
      success: boolean;
      error?: string;
  }>;
  abstract materializeBrowserTab(tabId: string, options?: {
      preserveViewport?: boolean;
  }): {
      success: boolean;
      tabId?: string;
      error?: string;
  };
  /**
   * Go back in the active tab.
   */
  abstract goBack(tabId: string | null): {
      success: boolean;
      error?: string;
  };
  abstract goForward(tabId: string | null): {
      success: boolean;
      error?: string;
  };
  abstract reload(tabId: string | null): {
      success: boolean;
      error?: string;
  };
  abstract closeTab(tabId: string): {
      success: boolean;
      error?: string;
  };
  abstract reorderTabs(tabIds: string[]): {
      success: boolean;
      error?: string;
  };
  abstract switchTab(tabId: string): {
      success: boolean;
      error?: string;
      previousActiveTabId?: string | null;
      activeTabId?: string | null;
      url?: string;
      title?: string;
      domain?: string;
      favicon?: string | null;
      profile?: string | null;
      owner?: BrowserTabOwner;
      required?: boolean;
      activity?: BrowserTabActivity;
      lastAuditedAt?: number | null;
      canGoBack?: boolean;
      canGoForward?: boolean;
  };
  abstract updateViewBounds(bounds: BrowserViewBoundsUpdate): {
      success: boolean;
  };
  abstract hideAllHosts(payload?: {
      requestId?: number;
  }): {
      success: boolean;
  };
  abstract hideActiveHost(payload?: {
      requestId?: number;
  }): {
      success: boolean;
  };
  abstract showActiveHost(payload?: {
      requestId?: number;
  }): {
      success: boolean;
  };
  /**
   * Stage X4 PR-shell-1 — single intent boundary. Renderer pushes
   * declarative BrowserViewIntent through `browser:intent`; this method
   * is the only writer onto `tabShellService.applyIntent`. For
   * `hide-all` and `show` intents we go through the same visibility
   * monotonic-id gate used by the legacy preload endpoints so that ack
   * ordering remains intact for PR-shell-2.
   */
  abstract applyBrowserViewIntent(intent: import('../../../shared/browser-view-intent').BrowserViewIntent): {
      success: boolean;
  };
  abstract fitActiveTabToBounds(tabId?: string | null): Promise<{
      success: boolean;
      zoomFactor?: number;
      error?: string;
  }>;
  abstract captureWindowSnapshot(bounds: BrowserRect): Promise<{
      success: boolean;
      data?: string;
      error?: string;
  }>;
  abstract captureViewportSnapshot(tabId?: string | null): Promise<{
      success: boolean;
      data?: string;
      error?: string;
  }>;
  abstract downloadUrlToDirectory(payload: BrowserDownloadUrlToDirectoryPayload): Promise<BrowserDownloadUrlToDirectoryResult>;
  abstract startNetworkObserver(tabId: string, options?: BrowserNetworkObserverOptions): Promise<BrowserNetworkObserverHandle>;
  abstract sendCdpCommand(tabId: string | null, method: string, params?: Record<string, unknown>, options?: import('./cdp-session-service').BrowserCdpCommandOptions): Promise<unknown>;
  abstract callFunctionOnBackendNode(tabId: string | null, backendDOMNodeId: number, functionDeclaration: string, args?: unknown[]): Promise<unknown>;
  /**
   * D16 — tool-executor 在 agent 写租约生效的写动作前调用，武装该 tab 的
   * 文件选择器拦截（幂等、best-effort）。解除由租约转移监听统一处理。
   */
  abstract armAgentFileChooserGuard(tabId: string | null): Promise<void>;
}
