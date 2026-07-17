import type { BrowserController } from '../browser-engine/ipc-handler'
import type { BrowserNetworkObserverHandle, BrowserNetworkEventRecord } from '../browser-engine/network-observer-service'
import type { ToolExecutionOutput } from '../agent-control/tools-runtime/tool-result-types'
import { createBrowserStructuredOutput } from './browser-failure-output'
import { resolveAuthorizedBrowserOutputPath } from './browser-media-download'
import {
  browserTaskEnvelopeAllowsSensitiveOperation,
  type BrowserSensitiveOperation,
  type BrowserTaskEnvelope,
} from '../../../shared/browser-task-envelope'

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
    currentUserText?: string | null
    trustedRoots?: string[]
    taskEnvelope?: BrowserTaskEnvelope | null
    abortSignal?: AbortSignal
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
  const requireSensitiveIntent = (
    sensitiveOperation: BrowserSensitiveOperation,
    requestedOrigin?: string | null,
  ): ToolExecutionOutput | null => {
    const envelope = context.taskEnvelope
    if (!browserTaskEnvelopeAllowsSensitiveOperation(envelope, sensitiveOperation)) {
      return createBrowserStructuredOutput({
        ok: false,
        errorKind: 'browser_task_intent_mismatch',
        operation: sensitiveOperation,
        message: 'This state-changing browser operation was not explicitly requested by the current user turn.',
      })
    }
    if (!boundTab || !envelope?.tabId || envelope.tabId !== boundTab.id) {
      return createBrowserStructuredOutput({ ok: false, errorKind: 'browser_task_tab_mismatch', operation: sensitiveOperation })
    }
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
        operation: sensitiveOperation,
        requestedOrigin: requested,
        boundOrigin,
      })
    }
    return null
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
        currentUserText: context.currentUserText,
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
      const intentDenied = requireSensitiveIntent(
        operation === 'session_clear_origin' ? 'session.clear_origin' : 'session.clear_site_data',
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
      const intentDenied = requireSensitiveIntent('session.switch_profile')
      if (intentDenied) return intentDenied
      if (!context.taskEnvelope?.primaryInstruction.includes(profile)) {
        return createBrowserStructuredOutput({ ok: false, errorKind: 'browser_task_profile_mismatch', profile })
      }
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
      const permission = String(args.permission || '')
      const origin = String(args.origin || boundOrigin || '')
      if (!permission) return createBrowserStructuredOutput({ ok: false, errorKind: 'permission_required' })
      return createBrowserStructuredOutput({ ok: true, ...controller.getBrowserPermission(origin, permission) })
    }
    case 'permission_set':
    case 'permission_reset': {
      const permission = String(args.permission || '')
      const origin = String(args.origin || boundOrigin || '')
      const decision = operation === 'permission_reset' ? 'ask' : String(args.decision || 'ask') as 'allow' | 'deny' | 'ask'
      if (!permission) return createBrowserStructuredOutput({ ok: false, errorKind: 'permission_required' })
      const intentDenied = requireSensitiveIntent(
        operation === 'permission_reset' ? 'permission.reset' : 'permission.set',
        origin,
      )
      if (intentDenied) return intentDenied
      if (permission === 'media' && decision === 'allow') {
        return createBrowserStructuredOutput({
          ok: false,
          errorKind: 'human_takeover_required',
          message: 'Camera and microphone permission must be completed by the user in takeover mode.',
        })
      }
      return createBrowserStructuredOutput({ ok: true, ...controller.setBrowserPermission(origin, permission, decision) })
    }
    default:
      return createBrowserStructuredOutput({ ok: false, errorKind: 'tool_not_registered', operation })
  }
}
