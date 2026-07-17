import type { BrowserController } from '../browser-engine/ipc-handler'
import type { BrowserLeaseGate } from '../browser-engine/agent-browser-lease-gate'
import { consumePendingBrowserSitePermissionNotices } from '../browser-engine/browser-permission-policy'
import {
  buildBrowserActionSessionProgress,
  noteBrowserActionSession,
  type BrowserActionSessionProgress,
  type BrowserTransactionConfirmation,
} from '../browser-engine/browser-action-session'
import type { BrowserActionReceipt } from '../browser-engine/browser-action-receipt'
import type { AgentControlRuntime } from '../agent-control/runtime-core/runtime'
import {
  createToolExecutionOutput,
  type ToolExecutionOutput,
} from '../agent-control/tools-runtime/tool-result-types'
import { resolveBrowserWorkflowIntent } from '../../../shared/browser-workflow-intent'
import { createRotatingLogger } from '../../utils/rotating-logger'
import { getBrowserAnthropicTools, getBrowserOpenAITools } from './browser-tool-catalog'
import { BrowserActionExecutor, type BrowserActionExecutorEvent } from './browser-action-executor'
import { executeBrowserActTool, runWorkflowStep } from './browser-act-tools'
import { executeBrowserObserveTool } from './browser-observe-tools'
import { executeBrowserCollectionTool } from './browser-collection-tools'
import { executeBrowserPowerTool } from './browser-power-tools'
import { executeBrowserSystemTool } from './browser-system-tools'
import { isBrowserAbortError } from './browser-input-actions'
import { ToolDomainError } from './tool-errors'
import { activeBrowserToolUrl, type BrowserActionFollowedTab } from './browser-tool-shared'
import { browserSnapshotService } from '../browser-engine/browser-snapshot-service'
import { createBrowserStructuredOutput } from './browser-failure-output'
import type { BrowserTaskEnvelope } from '../../../shared/browser-task-envelope'
import type { BrowserPowerEffect } from '../../../shared/browser-power'
import type { OriginInteractionSignal } from '../browser-engine/origin-interaction-budget'

export { normalizeDownloadTargets, pinimgOriginalsUrl } from './browser-media-download'

const logger = createRotatingLogger('ready-tools.log', { buffered: true })
const actionExecutor = new BrowserActionExecutor()

function log(message: string): void {
  try { logger.append(`[${new Date().toISOString()}] ${message}\n`) } catch { /* silent-catch: diagnostics must not fail browser work. */ }
}

export function getAnthropicTools(): Array<Record<string, unknown>> {
  return getBrowserAnthropicTools()
}

export function getOpenAITools(): Array<Record<string, unknown>> {
  return getBrowserOpenAITools()
}

function isBrowserTransactionTurn(currentUserText?: string | null): boolean {
  return resolveBrowserWorkflowIntent(currentUserText || '').kind === 'transaction'
}

function browserActionSessionPatch(params: {
  toolName: string
  args: Record<string, unknown>
  controller: BrowserController
  sessionId?: string
  currentUserText?: string
  tabId?: string | null
  followedTab?: BrowserActionFollowedTab | null
  confirmation?: BrowserTransactionConfirmation | null
  nextSuggestedAction?: string | null
  frameId?: string | null
}): { projectionPatch: Record<string, unknown>; session: BrowserActionSessionProgress } | null {
  if (!params.sessionId || !isBrowserTransactionTurn(params.currentUserText)) return null
  const targetTabId = params.followedTab?.tabId
    || params.tabId
    || (typeof params.args.tab_id === 'string' ? params.args.tab_id : null)
    || params.controller.getActiveTab?.()?.id
    || null
  const currentUrl = params.followedTab?.url || activeBrowserToolUrl(params.controller, targetTabId)
  const frameId = params.frameId || (typeof params.args.frame_id === 'string' ? params.args.frame_id : null)
  const session = noteBrowserActionSession(params.sessionId, {
    targetTabId,
    targetFrameId: frameId,
    frameUrl: typeof params.args.frame_url === 'string' ? params.args.frame_url : null,
    currentUrl,
    lastAction: params.toolName,
    lastFollowedTab: params.followedTab
      ? {
          tabId: params.followedTab.tabId,
          url: params.followedTab.url || null,
          title: params.followedTab.title || null,
          reason: params.followedTab.reason || null,
        }
      : null,
    confirmation: params.confirmation || null,
    nextSuggestedAction: params.nextSuggestedAction || null,
  })
  if (!session) return null
  return {
    session,
    projectionPatch: {
      taskType: 'browser_transaction',
      module: 'browser',
      progress: buildBrowserActionSessionProgress(session),
    },
  }
}

function attachBrowserActionSessionOutput(
  result: string | ToolExecutionOutput,
  params: {
    toolName: string
    args: Record<string, unknown>
    controller: BrowserController
    sessionId?: string
    currentUserText?: string
    tabId?: string | null
    followedTab?: BrowserActionFollowedTab | null
    confirmation?: BrowserTransactionConfirmation | null
    nextSuggestedAction?: string | null
    frameId?: string | null
    changeReceipt?: BrowserActionReceipt | null
  },
): string | ToolExecutionOutput {
  const patch = browserActionSessionPatch(params)
  const notices = consumePendingBrowserSitePermissionNotices()
  if (!patch && !params.changeReceipt && notices.length === 0) return result
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
  if (params.confirmation) data.transactionConfirmed = params.confirmation
  if (params.changeReceipt) data.changeReceipt = params.changeReceipt
  if (notices.length > 0) data.sitePermissionNotices = notices
  if (patch) data.browserActionSession = patch.session
  return createToolExecutionOutput(JSON.stringify(data, null, 2), {
    shape: original?.shape === 'multimodal' ? 'multimodal' : 'json',
    data,
    projectionPatch: patch
      ? { ...(original?.projectionPatch || {}), ...patch.projectionPatch }
      : original?.projectionPatch,
    interactionHint: original?.interactionHint,
    framePatch: original?.framePatch,
    contextModifier: original?.contextModifier,
    envelope: original?.envelope,
    content: original?.content,
  })
}

function candidateTargetUrls(args: Record<string, unknown>, controller: BrowserController): string[] {
  const urls = new Set<string>()
  const active = controller.getActiveTab?.()?.url
  if (active) urls.add(active)
  if (typeof args.url === 'string') urls.add(args.url)
  if (typeof args.page_url === 'string') urls.add(args.page_url)
  if (Array.isArray(args.urls)) for (const url of args.urls) if (typeof url === 'string') urls.add(url)
  return Array.from(urls)
}

function publishActionEvent(controller: BrowserController, event: BrowserActionExecutorEvent): void {
  if (event.phase === 'finish' && event.access === 'write') {
    browserSnapshotService.markDirty(
      controller,
      typeof event.args.tab_id === 'string' ? event.args.tab_id : null,
    )
  }
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
  const canAcceptWithoutInterrupt = dialog.type === 'alert'
    || (dialog.type === 'beforeunload' && toolName === 'browser_navigate')
  if (canAcceptWithoutInterrupt) {
    await controller.handleBrowserDialog(tabId, { accept: true })
    return null
  }
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
  currentUserText?: string,
  runtime?: AgentControlRuntime | null,
  taskExecutionContext?: {
    ownerAgentId?: string | null
    ownerRunId?: string | null
    parentTaskId?: string | null
    executionBinding?: import('../../../shared/agent-execution-profile').TaskExecutionBinding | null
    workspaceRoots?: string[]
    taskEnvelope?: BrowserTaskEnvelope | null
    requestPowerConfirmation?: (details: {
      toolName: string
      effects: BrowserPowerEffect[]
      purpose: string
      origin: string | null
      objectRef: string
      inputHash: string
    }) => Promise<boolean>
  },
): Promise<string | ToolExecutionOutput> {
  const origin = browserActionOrigin(args, controller)
  log(`executeBrowserTool: ${toolName} args=${JSON.stringify(args).slice(0, 300)}`)
  try {
    return await actionExecutor.execute({
      toolName,
      args,
      abortSignal,
      leaseGate,
      origin,
      beginInteractionObservation: () => beginAuthoritativeInteractionObservation(toolName, args, controller, origin),
      onEvent: (event) => publishActionEvent(controller, event),
      dispatch: async (invocation, signal) => {
        const dialogBlocked = await handlePendingDialogBeforeAction(toolName, invocation.args, controller)
        if (dialogBlocked) return dialogBlocked
        const attach = (
          result: string | ToolExecutionOutput,
          params: Parameters<typeof attachBrowserActionSessionOutput>[1],
        ) => attachBrowserActionSessionOutput(result, { ...params, toolName })

        switch (invocation.group) {
          case 'act':
            return executeBrowserActTool(invocation.operation, invocation.args, {
              controller,
              abortSignal: signal,
              sessionId,
              currentUserText,
              attachBrowserActionSessionOutput: attach,
            })
          case 'observe':
            return executeBrowserObserveTool(invocation.operation, invocation.args, {
              controller,
              abortSignal: signal,
              sessionId,
              currentUserText,
              attachBrowserActionSessionOutput: attach,
            })
          case 'collection':
            return executeBrowserCollectionTool(invocation.operation, invocation.args, {
              controller,
              abortSignal: signal,
              sessionId,
              currentUserText,
              leaseGate,
              runtime,
              candidateTargetUrls: candidateTargetUrls(invocation.args, controller),
              runWorkflowStep,
              taskExecutionContext,
            })
          case 'power':
            return executeBrowserPowerTool(invocation.operation, invocation.args, {
              controller,
              abortSignal: signal,
              sessionId,
              currentUserText,
              trustedRoots: taskExecutionContext?.workspaceRoots,
              taskEnvelope: taskExecutionContext?.taskEnvelope || null,
              requestPowerConfirmation: taskExecutionContext?.requestPowerConfirmation,
              attachBrowserActionSessionOutput: attach,
            })
          case 'system':
            return executeBrowserSystemTool(invocation.operation, invocation.args, {
              controller,
              abortSignal: signal,
              currentUserText,
              trustedRoots: taskExecutionContext?.workspaceRoots,
              taskEnvelope: taskExecutionContext?.taskEnvelope || null,
            })
        }
      },
    })
  } catch (error) {
    if (isBrowserAbortError(error)) throw error
    if (error instanceof ToolDomainError) throw error
    const message = error instanceof Error ? error.message : String(error)
    log(`Browser tool error: ${message}`)
    return createToolExecutionOutput(`Error executing ${toolName}: ${message}`, {
      shape: 'json',
      data: { ok: false, errorKind: 'browser_tool_failed', toolName, message },
    })
  }
}
