import { app, Notification } from 'electron'
import { randomUUID } from 'node:crypto'
import { BROWSER_ATTENTION_COPY, type BrowserAttentionReason, type BrowserAttentionTarget, type BrowserUserAttention } from '../../../shared/browser-user-attention'
import { readBrowserUserAttention } from './browser-user-attention'
import { getDatabase } from '../database'
import { ObjectRegistry } from '../object-service/registry'
import { AppSettingsRepository } from '../repositories/app-settings-repository'
import { VaultService } from '../settings-engine/vault-service'
import { browserDownloadDirectory, consumeBrowserDownload } from './download-receipt-consumer'
import type { BrowserDownloadReceipt } from '../../../shared/browser-download-receipt'
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
import { getBrowserTargetClaimService } from './browser-target-claim-singleton'
import type {
  BrowserTabContextData
} from './automation-types'
import { type BrowserAdblockState } from './data-service'
import {
  BROWSER_DIAGNOSTICS_LOG_PATH, type BrowserContinuityDiagnosticsSnapshot,
  type BrowserPageDiagnosticsSnapshot,
  type BrowserTaskDiagnosticsSnapshot
} from './diagnostics-service'
import type { BrowserHostPresentationState } from './host-layout-service'
import {
  type BrowserResearchAssessment,
  type BrowserResearchEvidenceBindingInput,
  type VerifiedBrowserWorkflowEvidence,
  type BrowserResearchWorkItemInput,
  type BeginBrowserWorkflowActionInput, type BrowserWorkflowObservationReceipt,
  type BrowserWorkflowObservationResource,
  type RecordBrowserWorkflowObservationInput,
  type SettledBrowserWorkflowAction
} from './task-persistence-service'
import type { BrowserActionOutcome } from '../../../shared/browser-action-outcome'
import type {
  BrowserWorkflowWriteAdmissionPort,
  BrowserWorkflowWriteTarget
} from '../../../shared/browser-workflow-control'
import {
  sameBrowserWorkflowWriteTarget,
  type BrowserWorkflowJournalUnitOfWorkPort,
  type Tab,
} from './browser-controller-contract-base'
import { BrowserControllerCaptureRuntime } from './browser-controller-capture-runtime'

export type { BrowserTabActivity, BrowserTabOwner } from './browser-controller-contract-base'
export { isAllowedBrowserURL } from './popup-policy'

export class BrowserController extends BrowserControllerCaptureRuntime {
  private attentionNotificationPort: (body: string) => void = body => {
    if (Notification.isSupported()) new Notification({ title: 'Ready Next', body }).show()
  }

  setAttentionNotificationPort(port: (body: string) => void): void {
    this.attentionNotificationPort = port
  }

  getTaskAttention(browserTaskId: string): BrowserUserAttention | null {
    const task = this.taskPersistenceService.getTask(browserTaskId)
    const payload = this.taskPersistenceService.getTaskPayload(browserTaskId)
    return task && payload ? readBrowserUserAttention(task, payload) : null
  }

  recordTaskAttention(target: BrowserAttentionTarget, reason: BrowserAttentionReason): void {
    const task = this.taskPersistenceService.getTask(target.browserTaskId)
    if (!task || task.createdByRunId !== target.ownerRunId || task.parentTaskId !== target.parentTaskId) {
      throw new Error('browser_attention_owner_mismatch')
    }
    if (this.getTaskAttention(target.browserTaskId)) return
    if (!this.taskPersistenceService.patchTaskPayload(target.browserTaskId, { userAttention: {
      id: randomUUID(), reason, tabId: target.tabId, physicalTargetToken: target.physicalTargetToken,
    } })) throw new Error('browser_attention_write_failed')
    if (reason === 'login' || reason === 'captcha') {
      if (this.getPhysicalTargetToken(target.tabId) !== target.physicalTargetToken) throw new Error('browser_attention_target_changed')
      const result = this.switchTab(target.tabId)
      if (!result.success) throw new Error(result.error || 'browser_attention_present_failed')
      const tab = this.getTabList().find(item => item.id === target.tabId)
      if (tab) this.sendToRenderer('browser:tabOpened', { ...tab, activate: true })
    }
    this.notifyTaskAttention(target.browserTaskId)
  }

  notifyTaskAttention(browserTaskId: string): void {
    const attention = this.getTaskAttention(browserTaskId)
    if (!attention || this.mainWindow.isDestroyed() || this.mainWindow.isFocused()) return
    try { this.attentionNotificationPort(BROWSER_ATTENTION_COPY[attention.reason].notification) } catch (error) {
      this.logBrowserDiag(`browser attention notification failed: ${String(error)}`)
    }
  }

  approveTaskWriteOrigin(browserTaskId: string, ownerRunId: string, origin: string): void {
    const task = this.taskPersistenceService.getTask(browserTaskId)
    if (!task || task.createdByRunId !== ownerRunId || ['completed', 'failed', 'cancelled'].includes(task.status)) throw new Error('browser_origin_task_not_active')
    const payload = this.taskPersistenceService.getTaskPayload(browserTaskId)
    const previous = Array.isArray(payload?.approvedWriteOrigins) ? payload.approvedWriteOrigins.filter((value): value is string => typeof value === 'string') : []
    if (!this.taskPersistenceService.patchTaskPayload(browserTaskId, { approvedWriteOrigins: [...new Set([...previous, origin])] })) throw new Error('browser_origin_grant_write_failed')
  }

  resolveTaskDownloadDirectory(requested: unknown, roots: readonly string[]): string {
    const vault = new VaultService(new AppSettingsRepository(), {
      home: app.getPath('home'), userData: app.getPath('userData'), isPackaged: app.isPackaged,
    }).get()
    return browserDownloadDirectory(requested, roots, vault.status === 'ready' ? vault.root : null)
  }

  getTaskDownloadReceipts(request: { browserTaskId: string }): { success: boolean; downloadReceipts: BrowserDownloadReceipt[]; error?: string } {
    const payload = request && typeof request.browserTaskId === 'string'
      ? this.taskPersistenceService.getTaskPayload(request.browserTaskId) : null
    if (!payload) return { success: false, downloadReceipts: [], error: 'browser_task_not_found' }
    if (payload.downloadReceipts !== undefined && !Array.isArray(payload.downloadReceipts)) {
      return { success: false, downloadReceipts: [], error: 'download_receipts_corrupt' }
    }
    return { success: true, downloadReceipts: (payload.downloadReceipts || []) as BrowserDownloadReceipt[] }
  }

  consumeTaskDownload(file: unknown, directory: string, browserTaskId: string, ownerRunId: string): BrowserDownloadReceipt {
    const db = getDatabase().getRawDb()
    if (!db) throw new Error('download_receipt_database_unavailable')
    const task = this.taskPersistenceService.getTask(browserTaskId)
    if (!task || task.createdByRunId !== ownerRunId) throw new Error('download_receipt_task_mismatch')
    return consumeBrowserDownload({
      file, directory, browserTaskId, ownerRunId, registry: new ObjectRegistry(db),
      readReceipts: () => {
        const payload = this.taskPersistenceService.getTaskPayload(browserTaskId)
        return (payload?.downloadReceipts || []) as BrowserDownloadReceipt[]
      },
      saveReceipts: downloadReceipts => {
        if (!this.taskPersistenceService.patchTaskPayload(browserTaskId, { downloadReceipts })) {
          throw new Error('download_receipt_task_write_failed')
        }
      },
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
    return this.tabMetaService.getTabList().map(tab => {
      const owner = this.taskWorkTabs.get(tab.id)
      return owner ? { ...tab, browserTaskId: owner.browserTaskId, openerTabId: owner.openerTabId } : tab
    })
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

  setBrowserTargetCheckpointResolver(port: ((parentTaskId: string) => string | null) | null): void {
    this.targetCheckpointResolver = port
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
    const owner = this.taskWorkTabs.get(input.tabId)
    const view = this.tabs.get(input.tabId)?.view
    if (view && owner?.browserTaskId === input.browserTaskId && owner.physicalTargetToken === input.physicalTargetToken
      && !this.hostLayoutService.isHostVisible(view)) this.hostLayoutService.mountBackgroundWorkHost(view)
    return () => {
      if (this.workflowPhysicalBindings.get(input.tabId) === binding) {
        this.workflowPhysicalBindings.delete(input.tabId)
        const view = this.tabs.get(input.tabId)?.view
        if (view) this.hostLayoutService.releaseBackgroundWorkHost(view)
      }
    }
  }

  isBrowserWorkflowWriteAdmitted(input: BrowserWorkflowWriteTarget): boolean {
    if (this.getTaskAttention(input.browserTaskId)) return false
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
    backgroundWorkSurfaceAdmitted?: boolean
  } {
    const resolved = this.resolveTabView(tabId)
    const owner = this.taskWorkTabs.get(resolved.tabId)
    const binding = this.workflowPhysicalBindings.get(resolved.tabId)
    return {
      mainWindowForeground: !this.mainWindow.isDestroyed()
        && this.mainWindow.isVisible()
        && !this.mainWindow.isMinimized()
        && this.mainWindow.isFocused(),
      hostPresentation: this.hostLayoutService.getHostPresentationState(resolved.view),
      tabActive: resolved.tabId === this.activeTabId,
      backgroundWorkSurfaceAdmitted: process.env.READY_BROWSER_BACKGROUND_SURFACE === '1'
        && !!owner && !!binding && owner.browserTaskId === binding.browserTaskId
        && owner.physicalTargetToken === binding.physicalTargetToken
        && this.isBrowserWorkflowWriteAdmitted(binding),
    }
  }

  async waitForCondition(
    tabId: string | null,
    options: BrowserWaitForConditionOptions,
    signal?: AbortSignal,
  ): Promise<{ matched: boolean; elapsedMs: number; value?: unknown }> {
    return this.capabilityService.waitForCondition(tabId, options, signal)
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

  readBrowserWorkflowSettledOutcomes(taskId: string) {
    return this.taskPersistenceService.readSettledOutcomes(taskId)
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
}
