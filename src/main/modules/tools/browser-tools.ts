import { executeWebMcpTool } from './browser-webmcp-tools'
import type { PreparedWebMcpTool } from '../browser-engine/webmcp-service'
import type { BrowserController } from '../browser-engine/ipc-handler'
import { createHash } from 'node:crypto'
import type { BrowserTargetClaimGate } from '../browser-engine/agent-browser-lease-gate'
import {
  bootIncarnationIdFromPhysicalTargetToken,
  partitionForBrowserProfile,
} from '../browser-engine/browser-target-claims'
import type { BrowserTurnLease } from '../browser-engine/agent-browser-turn-lease'
import { isAgentBrowserError } from '../browser-engine/agent-browser-errors'
import type { BrowserActionReceipt } from '../browser-engine/browser-action-receipt'
import type { AgentControlRuntime } from '../agent-control/runtime-core/runtime'
import {
  createToolExecutionOutput,
  type ToolExecutionOutput,
} from '../agent-control/tools-runtime/tool-result-types'
import { createRotatingLogger } from '../../utils/rotating-logger'
import { getBrowserAnthropicTools, getBrowserOpenAITools } from './browser-tool-catalog'
import { BrowserActionExecutor, interactionSignalFromResult, type BrowserActionExecutorEvent } from './browser-action-executor'
import { browserMutationController } from './browser-mutation-controller'
import { resolveBrowserToolInvocation, type BrowserToolInputSource } from './browser-tool-invocation'
import { browserOperationCapability, isBrowserPublicToolName } from '../../../shared/browser-capability-registry'
import { browserEnvelopeMatchesInvocation } from './browser-task-envelope-binding'
import { executeBrowserActTool } from './browser-act-tools'
import { executeBrowserObserveTool } from './browser-observe-tools'
import { executeBrowserCollectionTool } from './browser-collection-tools'
import { executeBrowserPowerTool } from './browser-power-tools'
import { executeBrowserSystemTool } from './browser-system-tools'
import { isBrowserAbortError } from './browser-input-actions'
import { ToolDomainError } from './tool-errors'
import { activeBrowserToolUrl, type BrowserActionFollowedTab } from './browser-tool-shared'
import { browserSnapshotService, parseBrowserSnapshotRef } from '../browser-engine/browser-snapshot-service'
import { createBrowserStructuredOutput } from './browser-failure-output'
import type { BrowserTaskEnvelope } from '../../../shared/browser-task-envelope'
import type { BrowserPowerEffect } from '../../../shared/browser-power'
import type { BrowserWorkflowWriteTarget } from '../../../shared/browser-workflow-control'
import type { BrowserActionTargetIdentity } from '../../../shared/browser-action-outcome'
import { scopedOriginInteractionKey, type OriginInteractionSignal } from '../browser-engine/origin-interaction-budget'

const logger = createRotatingLogger('ready-tools.log', { buffered: true })
const actionExecutor = new BrowserActionExecutor()

export function shouldUseResearchWorkTab(input: {
  taskType: string | null | undefined
  browserTaskId: string | null | undefined
  parentTaskId: string | null | undefined
  requiresDocument: boolean
  explicitTabId: unknown
}): boolean {
  return input.taskType === 'research'
    && Boolean(input.browserTaskId && input.parentTaskId)
    && input.requiresDocument
    && !(typeof input.explicitTabId === 'string' && input.explicitTabId.trim())
}

export function resolveBrowserInitialTabId(
  explicitTabId: unknown,
  activeTabId: string | null | undefined,
): string | null {
  return typeof explicitTabId === 'string' && explicitTabId.trim()
    ? explicitTabId
    : activeTabId || null
}

function log(message: string): void {
  try { logger.append(`[${new Date().toISOString()}] ${message}\n`) } catch { /* silent-catch: diagnostics must not fail browser work. */ }
}

function browserValueHash(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return createHash('sha256').update(text || '').digest('hex').slice(0, 16)
}

function sanitizedBrowserUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    // silent-catch: malformed URLs are omitted from diagnostics instead of logging raw input.
    return null
  }
}

/** Ordinary diagnostics must never persist raw model input or token-bearing URLs. */
export function sanitizeBrowserToolLogArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const fields = Object.entries(args).map(([key, value]) => {
    if ((key === 'url' || key === 'page_url') && typeof value === 'string') {
      return { key, type: 'url', target: sanitizedBrowserUrl(value), length: value.length, hash: browserValueHash(value) }
    }
    if (key === 'urls' && Array.isArray(value)) {
      return {
        key,
        type: 'url_array',
        count: value.length,
        targets: value.slice(0, 12).map(sanitizedBrowserUrl),
        hash: browserValueHash(value),
      }
    }
    if (typeof value === 'string') {
      return { key, type: 'string', length: value.length, hash: browserValueHash(value) }
    }
    if (Array.isArray(value)) return { key, type: 'array', count: value.length, hash: browserValueHash(value) }
    if (value && typeof value === 'object') {
      return { key, type: 'object', keys: Object.keys(value as Record<string, unknown>).sort(), hash: browserValueHash(value) }
    }
    return { key, type: typeof value, value: typeof value === 'boolean' || typeof value === 'number' ? value : null }
  })
  return { toolName, fields }
}

export function getAnthropicTools(): Array<Record<string, unknown>> {
  return getBrowserAnthropicTools()
}

export function getOpenAITools(): Array<Record<string, unknown>> {
  return getBrowserOpenAITools()
}

function attachBrowserToolOutput(
  result: string | ToolExecutionOutput,
  params: {
    toolName: string
    args: Record<string, unknown>
    controller: BrowserController
    sessionId?: string
    tabId?: string | null
    followedTab?: BrowserActionFollowedTab | null
    confirmation?: unknown
    nextSuggestedAction?: string | null
    frameId?: string | null
    changeReceipt?: BrowserActionReceipt | null
    workflowTarget?: BrowserWorkflowWriteTarget | null
  },
): string | ToolExecutionOutput {
  const notices = params.workflowTarget
    ? params.controller.consumeBrowserSiteNotices(params.workflowTarget)
    : []
  if (!params.changeReceipt && notices.length === 0) return result
  const original = typeof result === 'string' ? null : result
  const data: Record<string, unknown> = typeof result === 'string'
    ? (() => {
        try {
          const parsed = JSON.parse(result) as unknown
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : { result }
        } catch {
          // silent-catch: non-JSON output remains observable under the result field.
          return { result }
        }
      })()
    : { ...(result.data || {}) }
  if (params.changeReceipt) data.changeReceipt = params.changeReceipt
  if (notices.length > 0) data.sitePermissionNotices = notices
  return createToolExecutionOutput(JSON.stringify(data, null, 2), {
    shape: original?.shape === 'multimodal' ? 'multimodal' : 'json',
    data,
    projectionPatch: original?.projectionPatch,
    interactionHint: original?.interactionHint,
    framePatch: original?.framePatch,
    contextModifier: original?.contextModifier,
    envelope: original?.envelope,
    content: original?.content,
  })
}

function publishActionEvent(controller: BrowserController, event: BrowserActionExecutorEvent): void {
  const publish = (controller as unknown as {
    publishAgentBrowserAction?: (event: BrowserActionExecutorEvent) => void
  }).publishAgentBrowserAction
  publish?.call(controller, event)
}

function browserActionOrigin(args: Record<string, unknown>, controller: BrowserController): string {
  const explicit = typeof args.url === 'string' ? args.url
    : typeof args.page_url === 'string' ? args.page_url
      : null
  if (explicit) {
    try { return new URL(explicit).origin } catch { /* silent-catch: malformed explicit URL falls back to the active tab. */ }
  }
  const tabId = typeof args.tab_id === 'string' ? args.tab_id : null
  const current = activeBrowserToolUrl(controller, tabId)
  try { return new URL(current || '').origin } catch { /* silent-catch: unknown/malformed tab URL uses a stable local budget bucket. */ return 'browser://unknown' }
}

function browserInteractionBudgetKey(
  args: Record<string, unknown>,
  controller: BrowserController,
  sessionId: string | undefined,
  origin: string,
): string {
  const tabId = typeof args.tab_id === 'string' ? args.tab_id : controller.getActiveTab?.()?.id
  const tab = tabId ? controller.getTabList?.().find((candidate) => candidate.id === tabId) : null
  const profile = String(tab?.profile || 'default')
  return scopedOriginInteractionKey({ profile, scopeId: sessionId, origin })
}

const NETWORK_FEEDBACK_TOOL_NAMES = new Set([
  'browser_tabs',
  'browser_navigate',
  'browser_search',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_select',
  'browser_hover',
  'browser_scroll',
  'browser_press_key',
  'browser_drag',
  'browser_upload',
  'browser_dialog',
  'browser_eval',
  'browser_cdp',
])

async function beginAuthoritativeInteractionObservation(
  toolName: string,
  args: Record<string, unknown>,
  controller: BrowserController,
  origin: string,
): Promise<(() => Promise<OriginInteractionSignal | null>) | null> {
  if (!NETWORK_FEEDBACK_TOOL_NAMES.has(toolName)) return null
  const start = (controller as unknown as {
    startNetworkObserver?: BrowserController['startNetworkObserver']
  }).startNetworkObserver
  if (typeof start !== 'function') return null
  const tabId = typeof args.tab_id === 'string'
    ? args.tab_id
    : controller.getActiveTab?.()?.id
  if (!tabId) return null
  const handle = await start.call(controller, tabId, { maxEvents: 80 })
  return async () => {
    const events = handle.events()
    await handle.stop()
    const sameOrigin = events.filter((event) => {
      try { return new URL(event.url).origin === origin } catch {
        // silent-catch: malformed observer URLs are not authoritative same-origin feedback.
        return false
      }
    })
    const limited = sameOrigin.slice().reverse().find((event) => event.status === 429)
    if (!limited) return null
    const retryAfter = Object.entries(limited.responseHeaders || {})
      .find(([name]) => name.toLowerCase() === 'retry-after')?.[1] ?? null
    return { status: 429, retryAfter, actionSucceeded: false }
  }
}

async function handlePendingDialogBeforeAction(
  toolName: string,
  args: Record<string, unknown>,
  controller: BrowserController,
): Promise<ToolExecutionOutput | null> {
  if (toolName === 'browser_dialog') return null
  const getDialog = (controller as unknown as {
    getBrowserDialog?: (tabId: string | null) => Promise<{ type: string; message: string } | null>
  }).getBrowserDialog
  if (typeof getDialog !== 'function') return null
  const tabId = typeof args.tab_id === 'string' ? args.tab_id : null
  const dialog = await getDialog.call(controller, tabId)
  if (!dialog) return null
  return createBrowserStructuredOutput({
    ok: false,
    errorKind: 'dialog_open',
    dialog,
    nextSuggestedAction: 'call browser_dialog with accept or dismiss before continuing the same action',
  })
}

export async function executeBrowserTool(
  toolName: string,
  args: Record<string, unknown>,
  controller: BrowserController,
  abortSignal?: AbortSignal,
  sessionId?: string,
  leaseGate?: BrowserTargetClaimGate,
  _legacyUserText?: string,
  runtime?: AgentControlRuntime | null,
  taskExecutionContext?: {
    preparedPageTool?: PreparedWebMcpTool
    ownerAgentId?: string | null
    ownerRunId?: string | null
    browserTaskId?: string | null
    parentTaskId?: string | null
    executionBinding?: import('../../../shared/agent-execution-profile').TaskExecutionBinding | null
    workspaceRoots?: string[]
    taskEnvelope?: BrowserTaskEnvelope | null
    confirmedBrowserPowerRequest?: import('../../../shared/browser-workflow-control').BrowserPowerConfirmationSuspensionRequest | null
    confirmedBrowserPermissionRequest?: import('../../../shared/browser-workflow-control').BrowserPermissionSuspensionRequest | null
    requestPowerConfirmation?: (details: {
      toolName: string
      effects: BrowserPowerEffect[]
      purpose: string
      origin: string | null
      objectRef: string
      inputHash: string
    }) => Promise<boolean>
    registerRunCleanup?: (cleanup: () => void | Promise<void>) => void
    inputSource?: BrowserToolInputSource
    browserTurnLease?: BrowserTurnLease | null
    messageVisibilityEpoch?: number
    visibleTabIds?: string[]
    trustedPageRef?: {
      tabId: string
      physicalTargetToken: string
      mainFrameDocumentToken: string
    } | null
  },
): Promise<string | ToolExecutionOutput> {
  log(`executeBrowserTool ${JSON.stringify(sanitizeBrowserToolLogArgs(toolName, args))}`)
  // A sequence is only ever unfolded by the tool executor, where each step is admitted on its own.
  if (toolName === 'browser_sequence') return createBrowserStructuredOutput({ ok: false, errorKind: 'browser_sequence_requires_tool_executor' })
  try {
    const ownerRunId = String(taskExecutionContext?.ownerRunId || '').trim()
    const invocation = resolveBrowserToolInvocation(toolName, args, taskExecutionContext?.inputSource)
    if (
      invocation.ok
      && taskExecutionContext?.taskEnvelope
      && (
        !isBrowserPublicToolName(toolName)
        || !browserEnvelopeMatchesInvocation(
          taskExecutionContext.taskEnvelope,
          toolName,
          invocation.operation,
          args,
        )
      )
    ) {
      return createBrowserStructuredOutput({
        ok: false,
        errorKind: 'browser_task_invocation_mismatch',
        toolName,
        operationId: invocation.operation,
      })
    }
    const operationCapability = invocation.ok ? browserOperationCapability(invocation.operation) : null
    const browserTaskId = String(taskExecutionContext?.browserTaskId || '').trim()
    const parentTaskId = String(taskExecutionContext?.parentTaskId || '').trim()
    const taskType = browserTaskId && parentTaskId
      ? runtime?.getTaskProjection(parentTaskId)?.taskType
      : null
    const researchWorkTab = shouldUseResearchWorkTab({
      taskType,
      browserTaskId,
      parentTaskId,
      requiresDocument: operationCapability?.requiresDocument === true,
      explicitTabId: args.tab_id,
    })
    if (researchWorkTab) {
      const workTab = await controller.ensureAgentWorkTab(browserTaskId)
      if (!workTab.success || !workTab.tabId) {
        return createBrowserStructuredOutput({
          ok: false,
          errorKind: 'browser_agent_work_tab_unavailable',
          message: workTab.error || 'Agent work tab could not be created.',
        })
      }
      args = { ...args, tab_id: workTab.tabId }
    }
    if (toolName === 'browser_download' && invocation.ok && invocation.operation !== 'download_resolve') {
      try {
        args = { ...args, directory: controller.resolveTaskDownloadDirectory(args.directory, taskExecutionContext?.workspaceRoots || []) }
      } catch (error) {
        if (error instanceof Error && error.message === 'download_directory_not_authorized') {
          return createBrowserStructuredOutput({ ok: false, errorKind: error.message, delivery: 'not_delivered' })
        }
        throw error
      }
    }
    const origin = taskExecutionContext?.preparedPageTool?.origin || browserActionOrigin(args, controller)
    const initialTabId = resolveBrowserInitialTabId(args.tab_id, controller.getActiveTab?.()?.id)
    const attentionPhysicalTarget = initialTabId && operationCapability?.requiresDocument
      ? controller.getPhysicalTargetToken(initialTabId) : null
    const requiresPageLease = operationCapability?.requiresPageLease === true
    const tabList = controller.getTabList?.() || []
    const initialTarget = initialTabId
      ? tabList.find((tab) => tab.id === initialTabId) || null
      : null
    const requiresAgentView = initialTarget?.owner === 'agent'
    let workflowWriteTarget: BrowserWorkflowWriteTarget | null = null
    let effectiveLeaseGate = leaseGate
    if (
      !effectiveLeaseGate
      && requiresPageLease
      && initialTabId
      && taskExecutionContext?.browserTurnLease
      && taskExecutionContext.browserTaskId
    ) {
      const surface = requiresAgentView ? 'agent-view' : 'user-view'
      const physicalTargetToken = controller.getPhysicalTargetToken(initialTabId)
      if (!physicalTargetToken) {
        return createBrowserStructuredOutput({
          ok: false,
          errorCode: 'browser_physical_target_unavailable',
          errorKind: 'browser_physical_target_unavailable',
        })
      }
      const ensured = taskExecutionContext.browserTurnLease.ensureGateForTarget({
        partition: partitionForBrowserProfile(initialTarget?.profile),
        tabId: initialTabId,
        physicalTargetToken,
        bootIncarnationId: bootIncarnationIdFromPhysicalTargetToken(physicalTargetToken),
        profileId: initialTarget?.profile || null,
        surface,
        browserTaskId: taskExecutionContext.browserTaskId,
        scopeId: sessionId || null,
        sessionId: null,
        messageVisibilityEpoch: taskExecutionContext.messageVisibilityEpoch,
      })
      if (isAgentBrowserError(ensured)) {
        return createBrowserStructuredOutput({
          ...ensured,
          errorKind: ensured.errorCode,
        })
      }
      effectiveLeaseGate = ensured
    }
    if (requiresAgentView && requiresPageLease && effectiveLeaseGate?.surface !== 'agent-view') {
      return createBrowserStructuredOutput({
        ok: false,
        errorCode: 'browser_surface_binding_violation',
        errorKind: 'browser_surface_binding_violation',
        message: 'Writes to an agent-owned tab require the claimed agent-view surface.',
      })
    }
    if (
      requiresPageLease
      && initialTabId
      && effectiveLeaseGate
      && ownerRunId
      && taskExecutionContext?.parentTaskId
      && taskExecutionContext.browserTaskId
    ) {
      const physicalTargetToken = controller.getPhysicalTargetToken(initialTabId)
      if (!physicalTargetToken) {
        return createBrowserStructuredOutput({
          ok: false,
          errorCode: 'browser_physical_target_unavailable',
          errorKind: 'browser_physical_target_unavailable',
        })
      }
      workflowWriteTarget = {
        partition: effectiveLeaseGate.identity.partition,
        parentTaskId: taskExecutionContext.parentTaskId,
        ownerRunId,
        browserTaskId: taskExecutionContext.browserTaskId,
        surface: effectiveLeaseGate.surface,
        scopeId: sessionId || null,
        profileId: initialTarget?.profile || null,
        sessionId: null,
        tabId: initialTabId,
        physicalTargetToken,
        bootIncarnationId: effectiveLeaseGate.identity.bootIncarnationId,
        claimId: effectiveLeaseGate.identity.claimId,
        generation: effectiveLeaseGate.identity.generation,
      }
      const clearPhysicalBinding = controller.bindBrowserWorkflowPhysicalTarget({
        ...workflowWriteTarget,
      })
      taskExecutionContext.registerRunCleanup?.(clearPhysicalBinding)
    }
    if (requiresPageLease && effectiveLeaseGate) {
      // Arm only after the code-derived surface lease is valid. Takeover or a
      // competing writer must not leave the native chooser guard armed.
      try {
        const armGuard = (controller as unknown as {
          armAgentFileChooserGuard?: (tabId: string | null) => Promise<void>
        }).armAgentFileChooserGuard
        if (typeof armGuard === 'function') {
          await armGuard.call(controller, initialTabId)
        }
      } catch {
        // silent-catch: chooser guard attachment must not fail browser work.
      }
    }

    let preparedIdentity: Awaited<ReturnType<typeof browserSnapshotService.documentIdentity>> | null = null
    const result = await actionExecutor.execute({
      toolName,
      args,
      inputSource: taskExecutionContext?.inputSource,
      abortSignal,
      leaseGate: effectiveLeaseGate,
      writeAdmission: workflowWriteTarget
        ? () => controller.isBrowserWorkflowWriteAdmitted(workflowWriteTarget!)
        : undefined,
      trustedPageRef: taskExecutionContext?.trustedPageRef || null,
      origin,
      interactionBudgetKey: browserInteractionBudgetKey(args, controller, sessionId, origin),
      beginInteractionObservation: () => beginAuthoritativeInteractionObservation(toolName, args, controller, origin),
      prepare: async (invocation) => {
        const pending = await handlePendingDialogBeforeAction(toolName, invocation.args, controller)
        if (pending) return pending
        if (toolName === 'browser_navigate' || toolName === 'browser_press_key') {
          preparedIdentity = await browserSnapshotService.documentIdentity(controller, initialTabId)
        }
        return null
      },
      resolveTargetIdentity: (phase, hint) => {
        const pageTool = taskExecutionContext?.preparedPageTool
        if (pageTool && initialTabId) {
          const identity = (frameDocumentToken: string): BrowserActionTargetIdentity => ({
            documentState: 'document', tabId: initialTabId,
            physicalTargetToken: controller.getPhysicalTargetToken(initialTabId),
            frameId: pageTool.tool.frameId, frameDocumentToken, targetRef: null,
          })
          return phase === 'predecessor' ? identity(pageTool.frameDocumentToken)
            : controller.webMcp.frameIdentity(initialTabId, pageTool.tool).then(current => identity(current.frameDocumentToken))
        }
        const targetRef = typeof args.target_id === 'string'
          ? args.target_id
          : typeof args.input_target_id === 'string'
            ? args.input_target_id
            : null
        const parsedRef = targetRef ? parseBrowserSnapshotRef(targetRef) : null
        const tabId = typeof args.tab_id === 'string'
          ? args.tab_id
          : parsedRef?.tabId || controller.getActiveTab?.()?.id || null
        const currentIdentity = browserSnapshotService.currentDocumentIdentity(controller, tabId)
        const frameId = parsedRef?.frameId || (typeof args.frame_id === 'string' ? args.frame_id : '0')
        const physicalTargetToken = parsedRef?.physicalTargetToken
          || currentIdentity?.physicalTargetToken
          || (typeof controller.getPhysicalTargetToken === 'function' ? controller.getPhysicalTargetToken(tabId) : null)
        const frameDocumentToken = parsedRef?.frameDocumentToken
          || (frameId === '0' ? preparedIdentity?.frameDocumentToken || currentIdentity?.frameDocumentToken
            || (taskExecutionContext?.trustedPageRef?.tabId === tabId
              && taskExecutionContext.trustedPageRef.physicalTargetToken === physicalTargetToken
              ? taskExecutionContext.trustedPageRef.mainFrameDocumentToken : null) : null)
        const predecessor: BrowserActionTargetIdentity = tabId && physicalTargetToken && frameId && frameDocumentToken
          ? {
              documentState: 'document',
              tabId,
              physicalTargetToken,
              frameId,
              frameDocumentToken,
              targetRef,
            }
          : {
              documentState: 'no_document',
              tabId: null,
              physicalTargetToken: null,
              frameId: null,
              frameDocumentToken: null,
              targetRef: null,
            }
        if (phase === 'predecessor') return predecessor
        return (async () => {
          const currentTabId = typeof hint?.tabId === 'string' && hint.tabId.trim()
            ? hint.tabId.trim()
            : typeof args.tab_id === 'string'
              ? args.tab_id
              : parsedRef?.tabId || controller.getActiveTab?.()?.id || tabId
          if (targetRef && parsedRef && parsedRef.tabId === currentTabId && parsedRef.frameId !== '0') {
            const resolved = await browserSnapshotService.resolveRef(controller, currentTabId, targetRef)
            if (resolved.ok) {
              return {
                documentState: 'document' as const,
                tabId: currentTabId,
                physicalTargetToken: parsedRef.physicalTargetToken,
                frameId: parsedRef.frameId,
                frameDocumentToken: resolved.frameDocumentToken,
                targetRef: null,
              }
            }
            return {
              documentState: 'no_document' as const,
              tabId: null,
              physicalTargetToken: null,
              frameId: null,
              frameDocumentToken: null,
              targetRef: null,
            }
          }
          const identity = await browserSnapshotService.documentIdentity(controller, currentTabId)
          if (!currentTabId || !identity.physicalTargetToken || !identity.frameDocumentToken) {
            return {
              documentState: 'no_document' as const,
              tabId: null,
              physicalTargetToken: null,
              frameId: null,
              frameDocumentToken: null,
              targetRef: null,
            }
          }
          return {
            documentState: 'document' as const,
            tabId: currentTabId,
            physicalTargetToken: identity.physicalTargetToken,
            frameId: '0',
            frameDocumentToken: identity.frameDocumentToken,
            targetRef: null,
          }
        })()
      },
      onEvent: (event) => {
        publishActionEvent(controller, event)
      },
      journal: taskExecutionContext?.browserTaskId && ownerRunId
        ? {
            taskId: taskExecutionContext.browserTaskId,
            ownerRunId,
            beginAction: (input) => controller.beginBrowserWorkflowAction({
              taskId: taskExecutionContext.browserTaskId!,
              ownerRunId,
              ...input,
            }),
            settleAction: (actionId, outcome) => {
              const settled = controller.settleBrowserWorkflowAction(
                taskExecutionContext.browserTaskId!,
                actionId,
                outcome,
              )
              return { receiptId: settled.receiptId, outcome: settled.outcome }
            },
            recordObservation: (input) => controller.recordBrowserWorkflowObservation({
              taskId: taskExecutionContext.browserTaskId!,
              ownerRunId,
              ...input,
            }),
          }
        : undefined,
      dispatch: async (invocation, signal, mutationBoundary) => {
        const actionController = browserOperationCapability(invocation.operation).mode === 'mutate'
          ? browserMutationController(controller, invocation.operation, mutationBoundary)
          : controller
        const attach = (
          result: string | ToolExecutionOutput,
          params: Parameters<typeof attachBrowserToolOutput>[1],
        ) => attachBrowserToolOutput(result, { ...params, toolName, workflowTarget: workflowWriteTarget })

        switch (invocation.group) {
          case 'webmcp':
            return executeWebMcpTool(invocation.operation, invocation.args, controller.webMcp, signal, mutationBoundary, taskExecutionContext?.preparedPageTool)
          case 'act':
            return executeBrowserActTool(invocation.operation, invocation.args, {
              controller: actionController,
              abortSignal: signal,
              sessionId,
              messageVisibilityEpoch: taskExecutionContext?.messageVisibilityEpoch,
              mutationBoundary,
              agentOwnedWorkTab: browserTaskId ? { browserTaskId } : null,
              requestPowerConfirmation: taskExecutionContext?.requestPowerConfirmation,
              attachBrowserToolOutput: attach,
              trustedPageRef: taskExecutionContext?.trustedPageRef || null,
            })
          case 'observe':
            return executeBrowserObserveTool(invocation.operation, invocation.args, {
              visibleTabIds: taskExecutionContext?.visibleTabIds,
              snapshotTaskId: browserTaskId || undefined,
              registerRunCleanup: taskExecutionContext?.registerRunCleanup,
              controller: actionController,
              abortSignal: signal,
              sessionId,
              attachBrowserToolOutput: attach,
            })
          case 'collection':
            return executeBrowserCollectionTool(invocation.operation, invocation.args, {
              controller: actionController,
              abortSignal: signal,
              sessionId,
              mutationBoundary,
              taskExecutionContext: toolName === 'browser_download' ? { ...taskExecutionContext, workspaceRoots: [String(args.directory)] } : taskExecutionContext,
            })
          case 'power':
            return executeBrowserPowerTool(invocation.operation, invocation.args, {
              controller: actionController,
              abortSignal: signal,
              sessionId,
              trustedRoots: toolName === 'browser_download' ? [String(args.directory)] : taskExecutionContext?.workspaceRoots,
              taskEnvelope: taskExecutionContext?.taskEnvelope || null,
              confirmedBrowserPowerRequest: taskExecutionContext?.confirmedBrowserPowerRequest || null,
              mutationBoundary,
              attachBrowserToolOutput: attach,
            })
          case 'system':
            return executeBrowserSystemTool(invocation.operation, invocation.args, {
              controller: actionController,
              abortSignal: signal,
              trustedRoots: toolName === 'browser_download' ? [String(args.directory)] : taskExecutionContext?.workspaceRoots,
              taskEnvelope: taskExecutionContext?.taskEnvelope || null,
              confirmedBrowserPermissionRequest: taskExecutionContext?.confirmedBrowserPermissionRequest || null,
              registerRunCleanup: taskExecutionContext?.registerRunCleanup,
            })
        }
      },
      })
    const interaction = interactionSignalFromResult(result)
    const declaredAttention = toolName === 'browser_status' && typeof result !== 'string' && result.data?.ok !== false
      && (args.needs_user === 'login' || args.needs_user === 'captcha')
      ? args.needs_user : null
    const attentionReason = declaredAttention || (interaction.challenge ? 'captcha' : interaction.loginWall ? 'login' : null)
    if (attentionReason && initialTabId && attentionPhysicalTarget && browserTaskId && parentTaskId && ownerRunId) {
      if (controller.getPhysicalTargetToken(initialTabId) !== attentionPhysicalTarget) throw new Error('browser_attention_target_changed')
      controller.recordTaskAttention({ browserTaskId, parentTaskId, ownerRunId, tabId: initialTabId, physicalTargetToken: attentionPhysicalTarget }, attentionReason)
      await controller.requestAgentInterruption(initialTabId)
    }
    if (toolName === 'browser_download' && invocation.ok && invocation.operation !== 'download_resolve') {
      const data = typeof result === 'string' ? JSON.parse(result) : result.data
      if (data && Array.isArray(data.results)) {
        const downloadReceipts: import('../../../shared/browser-download-receipt').BrowserDownloadReceipt[] = []
        for (const file of data.results) {
          if (file && typeof file === 'object' && file.success === true) {
            try {
              downloadReceipts.push(controller.consumeTaskDownload(file, String(args.directory), browserTaskId, ownerRunId))
            } catch (error) {
              // silent-catch: returned to the model as download_receipt_failed; the files stay published.
              return createBrowserStructuredOutput({ ...data, ok: false, errorKind: 'download_receipt_failed',
                message: error instanceof Error ? error.message : String(error), filesPublished: true, replayAllowed: false, downloadReceipts })
            }
          }
        }
        const body = { ...data, downloadReceipts }
        return createToolExecutionOutput(JSON.stringify(body), { ...(typeof result === 'string' ? {} : result), shape: 'json', data: body })
      }
    }
    return result
  } catch (error) {
    if (isBrowserAbortError(error)) throw error
    if (error instanceof ToolDomainError) throw error
    const message = error instanceof Error ? error.message : String(error)
    log(`browserToolError tool=${toolName} kind=${error instanceof Error ? error.name : typeof error} length=${message.length} hash=${browserValueHash(message)}`)
    return createToolExecutionOutput(`Error executing ${toolName}: ${message}`, {
      shape: 'json',
      data: { ok: false, errorKind: 'browser_tool_failed', toolName, message },
    })
  }
}
