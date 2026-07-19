import type { BrowserController } from '../browser-engine/ipc-handler'
import { createHash } from 'node:crypto'
import type { BrowserLeaseGate } from '../browser-engine/agent-browser-lease-gate'
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
import { BrowserActionExecutor, type BrowserActionExecutorEvent } from './browser-action-executor'
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
  leaseGate?: BrowserLeaseGate,
  _legacyUserText?: string,
  runtime?: AgentControlRuntime | null,
  taskExecutionContext?: {
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
  },
): Promise<string | ToolExecutionOutput> {
  const origin = browserActionOrigin(args, controller)
  log(`executeBrowserTool ${JSON.stringify(sanitizeBrowserToolLogArgs(toolName, args))}`)
  try {
    const ownerRunId = String(taskExecutionContext?.ownerRunId || '').trim()
    const initialTabId = typeof args.tab_id === 'string' && args.tab_id.trim()
      ? args.tab_id
      : controller.getActiveTab?.()?.id || null
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
    const requiresPageLease = operationCapability?.requiresPageLease === true
    const tabList = controller.getTabList?.() || []
    const initialTarget = initialTabId
      ? tabList.find((tab) => tab.id === initialTabId) || null
      : null
    const requiresAgentView = initialTarget?.owner === 'agent'
    const leaseTargetTabId = initialTabId
    let workflowWriteTarget: BrowserWorkflowWriteTarget | null = null
    let effectiveLeaseGate = leaseGate
    if (!effectiveLeaseGate && requiresPageLease && taskExecutionContext?.browserTurnLease) {
      const surface = requiresAgentView ? 'agent-view' : 'user-view'
      const ensured = taskExecutionContext.browserTurnLease.ensureGateForSurface(surface, leaseTargetTabId)
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
        parentTaskId: taskExecutionContext.parentTaskId,
        ownerRunId,
        browserTaskId: taskExecutionContext.browserTaskId,
        surface: effectiveLeaseGate.surface,
        scopeId: sessionId || null,
        profileId: initialTarget?.profile || null,
        sessionId: null,
        tabId: initialTabId,
        physicalTargetToken,
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
          await armGuard.call(controller, leaseTargetTabId)
        }
      } catch {
        // silent-catch: chooser guard attachment must not fail browser work.
      }
    }

    const result = await actionExecutor.execute({
      toolName,
      args,
      inputSource: taskExecutionContext?.inputSource,
      abortSignal,
      leaseGate: effectiveLeaseGate,
      writeAdmission: workflowWriteTarget
        ? () => controller.isBrowserWorkflowWriteAdmitted(workflowWriteTarget!)
        : undefined,
      origin,
      interactionBudgetKey: browserInteractionBudgetKey(args, controller, sessionId, origin),
      beginInteractionObservation: () => beginAuthoritativeInteractionObservation(toolName, args, controller, origin),
      prepare: async (invocation) => {
        return handlePendingDialogBeforeAction(toolName, invocation.args, controller)
      },
      resolveTargetIdentity: (phase, hint) => {
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
          || (frameId === '0' ? currentIdentity?.frameDocumentToken || null : null)
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
          case 'act':
            return executeBrowserActTool(invocation.operation, invocation.args, {
              controller: actionController,
              abortSignal: signal,
              sessionId,
              mutationBoundary,
              requestPowerConfirmation: taskExecutionContext?.requestPowerConfirmation,
              createHumanTakeoverIntent: runtime
                && taskExecutionContext?.parentTaskId
                && taskExecutionContext.ownerRunId
                && taskExecutionContext.browserTaskId
                ? async () => {
                    const groundedTabId = initialTabId || controller.getActiveTab?.()?.id || null
                    const groundedTab = groundedTabId
                      ? controller.getTabList?.().find((tab) => tab.id === groundedTabId) || null
                      : null
                    const physicalTargetToken = groundedTabId
                      ? controller.getPhysicalTargetToken(groundedTabId)
                      : ''
                    if (!groundedTabId || !physicalTargetToken) {
                      throw new Error('takeover_physical_target_unavailable')
                    }
                    return runtime.createHumanTakeoverIntent({
                      parentTaskId: taskExecutionContext.parentTaskId!,
                      ownerRunId: taskExecutionContext.ownerRunId!,
                      browserTaskId: taskExecutionContext.browserTaskId!,
                      surface: groundedTab?.owner === 'agent' ? 'agent-view' : 'user-view',
                      scopeId: sessionId || null,
                      profileId: groundedTab?.profile || null,
                      sessionId: null,
                      tabId: groundedTabId,
                      physicalTargetToken,
                      source: 'supervision_button',
                    })
                  }
                : undefined,
              attachBrowserToolOutput: attach,
            })
          case 'observe':
            return executeBrowserObserveTool(invocation.operation, invocation.args, {
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
              taskExecutionContext,
            })
          case 'power':
            return executeBrowserPowerTool(invocation.operation, invocation.args, {
              controller: actionController,
              abortSignal: signal,
              sessionId,
              trustedRoots: taskExecutionContext?.workspaceRoots,
              taskEnvelope: taskExecutionContext?.taskEnvelope || null,
              confirmedBrowserPowerRequest: taskExecutionContext?.confirmedBrowserPowerRequest || null,
              mutationBoundary,
              attachBrowserToolOutput: attach,
            })
          case 'system':
            return executeBrowserSystemTool(invocation.operation, invocation.args, {
              controller: actionController,
              abortSignal: signal,
              trustedRoots: taskExecutionContext?.workspaceRoots,
              taskEnvelope: taskExecutionContext?.taskEnvelope || null,
              confirmedBrowserPermissionRequest: taskExecutionContext?.confirmedBrowserPermissionRequest || null,
              registerRunCleanup: taskExecutionContext?.registerRunCleanup,
            })
        }
      },
      })
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
