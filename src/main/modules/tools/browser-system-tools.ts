import type { BrowserController } from '../browser-engine/ipc-handler'
import type { BrowserNetworkObserverHandle, BrowserNetworkEventRecord } from '../browser-engine/network-observer-service'
import type { ToolExecutionOutput } from '../agent-control/tools-runtime/tool-result-types'
import { createBrowserStructuredOutput } from './browser-failure-output'
import { resolveAuthorizedBrowserOutputPath } from './browser-media-download'
import type { BrowserTaskEnvelope } from '../../../shared/browser-task-envelope'
import { createHash } from 'node:crypto'
import type { BrowserPermissionSuspensionRequest } from '../../../shared/browser-workflow-control'
import {
  type BrowserOperationId,
  type BrowserPublicToolName,
} from '../../../shared/browser-capability-registry'
import { browserEnvelopeMatchesInvocation } from './browser-task-envelope-binding'

interface ActiveNetworkTrace {
  handle: BrowserNetworkObserverHandle
  startedAt: string
}

const networkTraces = new WeakMap<BrowserController, Map<string, ActiveNetworkTrace>>()

function networkTraceMap(controller: BrowserController): Map<string, ActiveNetworkTrace> {
  let traces = networkTraces.get(controller)
  if (!traces) {
    traces = new Map()
    networkTraces.set(controller, traces)
  }
  return traces
}

function redactNetworkEvent(event: BrowserNetworkEventRecord): BrowserNetworkEventRecord {
  const responseHeaders = event.responseHeaders
    ? Object.fromEntries(Object.entries(event.responseHeaders).map(([name, value]) => [
        name,
        /cookie|authorization|token|secret/i.test(name) ? '[redacted]' : value,
      ]))
    : undefined
  return { ...event, responseHeaders }
}

type BrowserConsoleLevel = 'debug' | 'info' | 'warning' | 'error'

function browserConsoleLevel(message: Record<string, unknown>): BrowserConsoleLevel {
  if (message.method === 'Runtime.exceptionThrown') return 'error'
  const params = message.params && typeof message.params === 'object'
    ? message.params as Record<string, unknown>
    : message
  const entry = params.entry && typeof params.entry === 'object'
    ? params.entry as Record<string, unknown>
    : params
  const raw = String(entry.level || entry.type || '').toLowerCase()
  if (raw === 'error' || raw === 'assert') return 'error'
  if (raw === 'warning' || raw === 'warn') return 'warning'
  if (raw === 'debug' || raw === 'verbose' || raw === 'trace') return 'debug'
  return 'info'
}

export async function executeBrowserSystemTool(
  operation: string,
  args: Record<string, unknown>,
  context: {
    controller: BrowserController
    trustedRoots?: string[]
    taskEnvelope?: BrowserTaskEnvelope | null
    abortSignal?: AbortSignal
    registerRunCleanup?: (cleanup: () => void | Promise<void>) => void
    confirmedBrowserPermissionRequest?: BrowserPermissionSuspensionRequest | null
  },
): Promise<string | ToolExecutionOutput> {
  const { controller } = context
  const tabId = typeof args.tab_id === 'string' ? args.tab_id : null
  const boundTab = tabId
    ? controller.getTabList().find((tab) => tab.id === tabId) || null
    : controller.getActiveTab() || null
  const boundOrigin = (() => {
    try { return boundTab?.url ? new URL(boundTab.url).origin : null } catch {
      // silent-catch: malformed tab URLs cannot satisfy a sensitive-operation origin binding.
      return null
    }
  })()
  const requireSensitiveConfirmation = async (
    operationId: Extract<BrowserOperationId,
      | 'session_clear_origin'
      | 'session_clear_site_data'
      | 'session_switch_profile'
      | 'permission_set'
      | 'permission_reset'>,
    publicToolName: Extract<BrowserPublicToolName, 'browser_session' | 'browser_permission'>,
    requestedOrigin?: string | null,
  ): Promise<ToolExecutionOutput | null> => {
    const envelope = context.taskEnvelope
    if (!browserEnvelopeMatchesInvocation(envelope, publicToolName, operationId, args)) {
      return createBrowserStructuredOutput({
        ok: false,
        errorKind: 'browser_task_invocation_mismatch',
        operation: operationId,
      })
    }
    if (!boundTab || !envelope?.tabId || envelope.tabId !== boundTab.id) {
      return createBrowserStructuredOutput({ ok: false, errorKind: 'browser_task_tab_mismatch', operation: operationId })
    }
    if (operationId !== 'session_switch_profile') {
      const requested = (() => {
        if (!requestedOrigin) return boundOrigin
        try { return new URL(requestedOrigin).origin } catch {
          // silent-catch: malformed requested origins fail the exact-origin comparison below.
          return null
        }
      })()
      if (!requested || !boundOrigin || requested !== boundOrigin || envelope.origin !== boundOrigin) {
        return createBrowserStructuredOutput({
          ok: false,
          errorKind: 'browser_task_origin_mismatch',
          operation: operationId,
          requestedOrigin: requested,
          boundOrigin,
        })
      }
    }
    return null
  }
  const readExactPermissionRequest = (): {
    readback: ReturnType<BrowserController['getBrowserPermission']> | null
    denied: ToolExecutionOutput | null
  } => {
    const siteRequestId = String(args.site_request_id || '').trim()
    if (!siteRequestId) {
      return {
        readback: null,
        denied: createBrowserStructuredOutput({ ok: false, errorKind: 'site_permission_request_id_required' }),
      }
    }
    const readback = controller.getBrowserPermission(siteRequestId)
    if (readback.state === 'expired' || !readback.target) {
      return {
        readback,
        denied: createBrowserStructuredOutput({
          ok: false,
          errorKind: 'browser_permission_request_expired',
          ...readback,
        }),
      }
    }
    const envelope = context.taskEnvelope
    const target = readback.target
    if (
      !boundTab
      || !envelope
      || !envelope.browserTaskId
      || envelope.parentTaskId !== target.parentTaskId
      || envelope.browserTaskId !== target.browserTaskId
      || envelope.scopeId !== target.scopeId
      || boundTab.id !== target.tabId
      || envelope.tabId !== target.tabId
      || controller.getPhysicalTargetToken(target.tabId) !== target.physicalTargetToken
    ) {
      return {
        readback,
        denied: createBrowserStructuredOutput({
          ok: false,
          errorKind: 'browser_permission_request_target_mismatch',
          requestId: siteRequestId,
        }),
      }
    }
    const requestedPermission = String(args.permission || '').toLowerCase()
    const requestedOrigin = String(args.origin || '')
    if (
      (requestedPermission && requestedPermission !== readback.permission)
      || (requestedOrigin && requestedOrigin !== readback.origin)
    ) {
      return {
        readback,
        denied: createBrowserStructuredOutput({
          ok: false,
          errorKind: 'browser_permission_request_identity_mismatch',
          requestId: siteRequestId,
        }),
      }
    }
    return { readback, denied: null }
  }
  switch (operation) {
    case 'dialog_get': {
      const dialog = await controller.getBrowserDialog(tabId)
      return createBrowserStructuredOutput({ ok: true, dialog })
    }
    case 'dialog_accept':
    case 'dialog_dismiss': {
      const dialog = await controller.getBrowserDialog(tabId)
      if (!dialog) return createBrowserStructuredOutput({ ok: false, errorKind: 'dialog_not_open' })
      await controller.handleBrowserDialog(tabId, {
        accept: operation === 'dialog_accept',
        ...(typeof args.prompt_text === 'string' ? { promptText: args.prompt_text } : {}),
      })
      return createBrowserStructuredOutput({ ok: true, handled: operation === 'dialog_accept' ? 'accepted' : 'dismissed', dialog })
    }
    case 'archive': {
      const resolvedPath = resolveAuthorizedBrowserOutputPath(args.path, {
        trustedRoots: context.trustedRoots,
      })
      const format = String(args.format || '') as 'pdf' | 'mhtml' | 'html' | 'markdown'
      if (!resolvedPath.ok) {
        return createBrowserStructuredOutput({
          ok: false,
          errorKind: 'archive_path_not_bound',
          message: 'Archive path must be bound to the current workspace, task resource, Ready output folder, or explicit user instruction.',
          requested: resolvedPath.requested,
        })
      }
      const archived = await controller.archivePage(tabId, resolvedPath.path, format, { signal: context.abortSignal })
      return createBrowserStructuredOutput({
        ok: archived.success === true,
        ...archived,
        authority: resolvedPath.authority,
      })
    }
    case 'console_list': {
      const requestedLevels = new Set(
        (Array.isArray(args.levels) ? args.levels : [])
          .map(String)
          .filter((level): level is BrowserConsoleLevel => ['debug', 'info', 'warning', 'error'].includes(level)),
      )
      const collected = await controller.collectConsoleMessages(tabId, {
        durationMs: Number(args.duration_ms || 250),
        limit: Number(args.limit || 100),
      })
      const messages = collected
        .map((message) => ({ ...message, level: browserConsoleLevel(message) }))
        .filter((message) => requestedLevels.size === 0 || requestedLevels.has(message.level))
      return createBrowserStructuredOutput({ ok: true, messages, count: messages.length })
    }
    case 'console_clear':
      return createBrowserStructuredOutput(await controller.clearConsoleMessages(tabId))
    case 'network_start': {
      const resolvedTabId = tabId || controller.getActiveTab()?.id || null
      if (!resolvedTabId) return createBrowserStructuredOutput({ ok: false, errorKind: 'browser_tab_missing' })
      const traces = networkTraceMap(controller)
      const existing = traces.get(resolvedTabId)
      if (existing) {
        return createBrowserStructuredOutput({ ok: true, traceId: existing.handle.id, startedAt: existing.startedAt, alreadyRunning: true })
      }
      const handle = await controller.startNetworkObserver(resolvedTabId, {
        maxEvents: Math.max(1, Math.min(500, Number(args.limit || 120))),
      })
      const trace = { handle, startedAt: new Date().toISOString() }
      traces.set(resolvedTabId, trace)
      context.registerRunCleanup?.(async () => {
        if (traces.get(resolvedTabId)?.handle !== handle) return
        await handle.stop()
        traces.delete(resolvedTabId)
      })
      return createBrowserStructuredOutput({ ok: true, traceId: handle.id, tabId: resolvedTabId, startedAt: trace.startedAt })
    }
    case 'network_list':
    case 'network_details':
    case 'network_stop': {
      const resolvedTabId = tabId || controller.getActiveTab()?.id || null
      if (!resolvedTabId) return createBrowserStructuredOutput({ ok: false, errorKind: 'browser_tab_missing' })
      const traces = networkTraceMap(controller)
      const trace = traces.get(resolvedTabId)
      if (!trace) {
        return createBrowserStructuredOutput({
          ok: false,
          errorKind: 'network_trace_not_started',
          nextSuggestedAction: 'browser_network(action=start)',
        })
      }
      const events = trace.handle.events().map(redactNetworkEvent)
      if (operation === 'network_details') {
        const requestId = String(args.request_id || '').trim()
        const event = events.find((item) => item.requestId === requestId) || null
        return createBrowserStructuredOutput(event
          ? { ok: true, traceId: trace.handle.id, event }
          : { ok: false, errorKind: 'network_request_not_found', requestId })
      }
      if (operation === 'network_stop') {
        await trace.handle.stop()
        traces.delete(resolvedTabId)
      }
      const limit = Math.max(1, Math.min(500, Number(args.limit || 120)))
      return createBrowserStructuredOutput({
        ok: true,
        traceId: trace.handle.id,
        startedAt: trace.startedAt,
        running: operation !== 'network_stop',
        eventCount: events.length,
        events: events.slice(-limit),
      })
    }
    case 'session_status':
      return createBrowserStructuredOutput({ ok: true, ...(await controller.getBrowserSessionStatus(tabId, String(args.origin || '') || undefined)) })
    case 'session_clear_origin':
    case 'session_clear_site_data': {
      const intentDenied = await requireSensitiveConfirmation(
        operation,
        'browser_session',
        String(args.origin || '') || null,
      )
      if (intentDenied) return intentDenied
      return createBrowserStructuredOutput(await controller.clearBrowserOriginData(
        tabId,
        String(args.origin || '') || undefined,
        Array.isArray(args.data_types) ? args.data_types.map(String) : undefined,
      ))
    }
    case 'session_switch_profile': {
      const profile = String(args.profile || '').trim()
      if (!profile) return createBrowserStructuredOutput({ ok: false, errorKind: 'profile_required' })
      const intentDenied = await requireSensitiveConfirmation('session_switch_profile', 'browser_session')
      if (intentDenied) return intentDenied
      const current = tabId
        ? controller.getTabList().find((tab) => tab.id === tabId)
        : controller.getActiveTab()
      const created = await controller.createTab(current?.url || 'about:blank', {
        profile,
        openerTabId: current?.id || null,
      })
      return createBrowserStructuredOutput({ ok: created.success === true, ...created, profile, previousTabId: current?.id || null })
    }
    case 'permission_status': {
      const exact = readExactPermissionRequest()
      if (exact.denied) return exact.denied
      return createBrowserStructuredOutput({ ok: true, ...exact.readback! })
    }
    case 'permission_set': {
      const exact = readExactPermissionRequest()
      if (exact.denied) return exact.denied
      const pending = exact.readback!
      const permission = String(pending.permission || '')
      const origin = String(pending.origin || '')
      const decision = String(args.decision || '') as 'allow' | 'deny'
      if (!permission) return createBrowserStructuredOutput({ ok: false, errorKind: 'permission_required' })
      if (decision !== 'allow' && decision !== 'deny') {
        return createBrowserStructuredOutput({ ok: false, errorKind: 'permission_decision_required' })
      }
      if (pending.state === 'applied') {
        return createBrowserStructuredOutput({
          ok: false,
          errorKind: 'browser_permission_request_already_applied',
          requestedDecision: decision,
          ...pending,
        })
      }
      if (permission === 'media' && decision === 'allow') {
        return createBrowserStructuredOutput({
          ok: false,
          errorKind: 'human_takeover_required',
          message: 'Camera and microphone permission must be completed by the user in takeover mode.',
        })
      }
      const intentDenied = await requireSensitiveConfirmation(
        'permission_set',
        'browser_permission',
        boundOrigin,
      )
      if (intentDenied) return intentDenied
      const siteRequestId = pending.requestId
      const pendingPermission = permission.toLowerCase()
      const pendingOrigin = origin
      if (decision === 'allow') {
        const envelope = context.taskEnvelope!
        const inputHash = createHash('sha256').update(JSON.stringify({
          siteRequestId,
          permission: pendingPermission,
          origin: pendingOrigin,
          decision,
          argsDigest: envelope.argsDigest,
        })).digest('hex')
        const targetDigest = createHash('sha256').update(JSON.stringify({
          scopeId: pending.target!.scopeId,
          ownerRunId: pending.target!.ownerRunId,
          browserTaskId: pending.target!.browserTaskId,
          tabId: pending.target!.tabId,
          siteRequestId,
          permission: pendingPermission,
          origin: pendingOrigin,
        })).digest('hex')
        const confirmed = context.confirmedBrowserPermissionRequest
        const exactConfirmation = Boolean(
          confirmed
          && confirmed.actionIntent.siteRequestId === siteRequestId
          && confirmed.actionIntent.permission === pendingPermission
          && confirmed.actionIntent.origin === pendingOrigin
          && confirmed.actionIntent.decision === decision
          && confirmed.actionIntent.inputHash === inputHash
          && confirmed.target.scopeId === pending.target!.scopeId
          && confirmed.target.ownerRunId === pending.target!.ownerRunId
          && confirmed.target.browserTaskId === pending.target!.browserTaskId
          && confirmed.target.tabId === pending.target!.tabId
          && confirmed.target.targetDigest === targetDigest,
        )
        if (!exactConfirmation) {
          return createBrowserStructuredOutput({
            ok: false,
            errorKind: 'browser_permission_confirmation_unavailable',
            phase: 'blocked',
          })
        }
      }
      const applied = controller.setBrowserPermission(siteRequestId, decision)
      if (
        applied.state !== 'applied'
        || applied.applied !== true
        || applied.decision !== decision
        || applied.requestId !== siteRequestId
        || applied.permission !== pending.permission
        || applied.origin !== pending.origin
        || !applied.target
        || JSON.stringify(applied.target) !== JSON.stringify(pending.target)
      ) {
        return createBrowserStructuredOutput({
          ok: false,
          errorKind: applied.state === 'expired'
            ? 'browser_permission_request_expired'
            : 'browser_permission_readback_mismatch',
          ...applied,
        })
      }
      return createBrowserStructuredOutput({ ok: true, ...applied })
    }
    case 'permission_reset': {
      const permission = String(args.permission || '')
      const origin = String(args.origin || boundOrigin || '')
      if (!permission) return createBrowserStructuredOutput({ ok: false, errorKind: 'permission_required' })
      const intentDenied = await requireSensitiveConfirmation(
        'permission_reset',
        'browser_permission',
        origin,
      )
      if (intentDenied) return intentDenied
      if (!boundTab) return createBrowserStructuredOutput({ ok: false, errorKind: 'browser_tab_missing' })
      return createBrowserStructuredOutput({
        ok: true,
        ...controller.resetBrowserPermission(boundTab.id, origin, permission),
      })
    }
    default:
      return createBrowserStructuredOutput({ ok: false, errorKind: 'tool_not_registered', operation })
  }
}
