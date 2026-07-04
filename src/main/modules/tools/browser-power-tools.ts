/**
 * P3 Phase B4（2026-07-04，纯移动拆分）— browser-tools Power 工具组。
 *
 * 从 browser-tools.ts 逐字搬出七个 case 的实现体（browser_execute_js /
 * browser_power_eval / browser_power_cdp / browser_power_network_trace /
 * browser_power_resource_forensics / browser_media_download_advanced /
 * browser_power_script_run，经 executeBrowserPowerTool 统一入口分发）与
 * Power 独占 helper（clampNumber / detectNetworkTransactionConfirmation /
 * summarizeCodeForAudit / truncateJsonValue / redactHeaders /
 * browserPowerDeniedOutput / resolvePowerDecisionForTool，后三者供
 * browser-tools 的 legacy power 前置路径回接导入）。
 * attachBrowserActionSessionOutput（sitePermissionNotices 排空合同）与
 * runWorkflowStep（与 browser_run_workflow 共享的守卫执行层）留在
 * browser-tools，经 BrowserPowerToolContext 注入回接，防循环依赖。
 * 行为零变更。
 */
import type { BrowserController } from '../browser-engine/ipc-handler'
import { classifyBrowserPowerFailure, browserToolOriginFromUrl } from './browser-power-failure'
import { verifyDownloadedMedia } from '../browser-engine/media-verification'
import { inspectBrowserResources } from '../browser-engine/resource-sniffer'
import {
  browserPowerGrantRequiredPayload,
  inferBrowserPowerEffects,
  recordBrowserPowerAuditEvent,
  resolveBrowserPowerAuthorization,
  type BrowserPowerDecision,
} from '../browser-engine/browser-power-policy'
import {
  createBrowserTransactionConfirmation,
  type BrowserTransactionConfirmation,
} from '../browser-engine/browser-action-session'
import {
  createToolExecutionOutput,
  type ToolExecutionOutput,
} from '../agent-control/tools-runtime/tool-result-types'
import type { BrowserPowerEffect } from '../../../shared/browser-power'
import {
  createBrowserStructuredOutput as browserStructuredOutput,
  stringifyBrowserJsonOrFailure,
} from './browser-failure-output'
import { downloadUrlsToDirectory, normalizeResourceKinds } from './browser-media-download'
import { sleepWithAbort } from './browser-input-actions'
import { createRotatingLogger } from '../../utils/rotating-logger'
import {
  activeBrowserToolUrl,
  detectBrowserPageTransactionConfirmation,
  normalizeTransactionText,
  truncate,
} from './browser-tool-shared'

const logger = createRotatingLogger('ready-tools.log')
function log(msg: string) {
  try { logger.append(`[${new Date().toISOString()}] ${msg}\n`) } catch { /* silent-catch: 日志写入失败不影响主流程。 */ }
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const next = Number(value)
  if (!Number.isFinite(next)) return fallback
  return Math.max(min, Math.min(max, Math.floor(next)))
}

function detectNetworkTransactionConfirmation(
  events: ReadonlyArray<Record<string, unknown>>,
  bodies: ReadonlyArray<Record<string, unknown>>,
): BrowserTransactionConfirmation | null {
  const bodyByRequestId = new Map<string, Record<string, unknown>>()
  for (const body of bodies) {
    const requestId = typeof body.requestId === 'string' ? body.requestId : ''
    if (requestId) bodyByRequestId.set(requestId, body)
  }
  for (const event of events) {
    const method = String(event.method || event.requestMethod || '').toUpperCase()
    if (!['POST', 'PUT', 'PATCH'].includes(method)) continue
    const status = Number(event.status || event.statusCode || 0)
    if (!Number.isFinite(status) || status < 200 || status >= 300) continue
    const url = String(event.url || '')
    if (/(?:autosave|auto-save|draft|preflight|log|track|metric|analytics|beacon|heartbeat|ping)/i.test(url)) continue
    const requestId = typeof event.requestId === 'string' ? event.requestId : ''
    const body = bodyByRequestId.get(requestId)
    const bodyText = normalizeTransactionText(body?.body)
    if (!bodyText || /(?:draft|autosave|草稿|自动保存)/i.test(bodyText)) continue
    const successSemantic = /(?:"success"\s*:\s*true|"code"\s*:\s*0\b|"ok"\s*:\s*true|发布成功|提交成功|已发布)/i.test(bodyText)
    const idMatch = bodyText.match(/(?:"(?:note|post|article|item)?_?id"\s*:\s*"([A-Za-z0-9_-]{6,})"|"(?:noteId|postId|articleId)"\s*:\s*"([A-Za-z0-9_-]{6,})")/i)
    if (!successSemantic && !idMatch) continue
    return createBrowserTransactionConfirmation({
      source: 'network',
      signal: successSemantic ? 'success_response' : 'resource_id_response',
      url,
      resourceId: idMatch?.[1] || idMatch?.[2] || null,
      statusCode: status,
      text: bodyText.slice(0, 1000),
    })
  }
  return null
}

export function summarizeCodeForAudit(code: string): string {
  return code.replace(/\s+/g, ' ').trim().slice(0, 240)
}

function truncateJsonValue(value: unknown, maxBytes: number): { value: unknown; truncated: boolean; bytes: number } {
  let text: string
  try {
    text = JSON.stringify(value)
  } catch {
    // silent-catch: 序列化失败回退 String()。
    text = String(value)
  }
  const bytes = Buffer.byteLength(text)
  if (bytes <= maxBytes) return { value, truncated: false, bytes }
  return {
    value: `${text.slice(0, maxBytes)}... (truncated, ${bytes} bytes)`,
    truncated: true,
    bytes,
  }
}

function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (/cookie|authorization|token|secret|set-cookie/i.test(key)) {
      out[key] = '[redacted]'
    } else {
      out[key] = value
    }
  }
  return out
}

export function browserPowerDeniedOutput(decision: BrowserPowerDecision, extra?: Record<string, unknown>): ToolExecutionOutput {
  return browserStructuredOutput(browserPowerGrantRequiredPayload(decision, extra))
}

export function resolvePowerDecisionForTool(params: {
  toolName: string
  args: Record<string, unknown>
  controller: BrowserController
  currentUserText?: string
  sessionId?: string
  tabId?: string | null
  url?: string | null
  destination?: string | null
  fallbackEffects?: BrowserPowerEffect[]
}): BrowserPowerDecision {
  const tabId = params.tabId ?? (typeof params.args.tab_id === 'string' ? params.args.tab_id : null)
  const url = params.url ?? activeBrowserToolUrl(params.controller, tabId)
  return resolveBrowserPowerAuthorization({
    toolName: params.toolName,
    args: params.args,
    effects: inferBrowserPowerEffects({
      toolName: params.toolName,
      args: params.args,
      fallback: params.fallbackEffects,
    }),
    grantId: typeof params.args.grant_id === 'string' ? params.args.grant_id : null,
    scopeId: params.sessionId || null,
    tabId,
    url,
    destination: params.destination || null,
    currentUserText: params.currentUserText || null,
  })
}

/**
 * B4 注入面：attachBrowserActionSessionOutput 与 runWorkflowStep 的实现体
 * 留在 browser-tools.ts（前者是 sitePermissionNotices 排空合同红线，后者
 * 与其余 workflow case 深度共享），以函数引用注入，本模块不反向 import。
 */
export interface BrowserPowerToolContext {
  controller: BrowserController
  abortSignal?: AbortSignal
  sessionId?: string
  currentUserText?: string
  attachBrowserActionSessionOutput: (
    result: string | ToolExecutionOutput,
    params: {
      toolName: string
      args: Record<string, unknown>
      controller: BrowserController
      sessionId?: string
      currentUserText?: string
      tabId?: string | null
      frameId?: string | null
      confirmation?: BrowserTransactionConfirmation | null
      nextSuggestedAction?: string | null
    },
  ) => string | ToolExecutionOutput
  runWorkflowStep: (
    controller: BrowserController,
    step: Record<string, unknown>,
    fallbackTabId: string | null,
    signal?: AbortSignal,
  ) => Promise<string>
}

export async function executeBrowserPowerTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: BrowserPowerToolContext,
): Promise<string | ToolExecutionOutput> {
  const { controller, abortSignal, sessionId, currentUserText, attachBrowserActionSessionOutput, runWorkflowStep } = ctx
  switch (toolName) {
      case 'browser_execute_js': {
        const code = typeof args.code === 'string' ? args.code : ''
        if (!code) return 'Error: code is required'
        const tabId = (args.tab_id as string) || null
        log(`Executing JS: ${code.slice(0, 100)}`)
        const result = await controller.executeJS(tabId, code)
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
        return truncate(resultStr ?? 'undefined')
      }

      case 'browser_power_eval': {
        const code = String(args.code || '')
        if (!code.trim()) return 'Error: code is required'
        const purpose = String(args.purpose || '').trim()
        if (!purpose) return 'Error: purpose is required'
        const tabId = (args.tab_id as string) || null
        const frameId = String(args.frame_id || '').trim() || null
        const maxResultBytes = clampNumber(args.max_result_bytes, 20_000, 1024, 200_000)
        const timeoutMs = clampNumber(args.timeout_ms, 5000, 250, 30_000)
        const decision = resolvePowerDecisionForTool({
          toolName,
          args,
          controller,
          currentUserText,
          sessionId,
          tabId,
          fallbackEffects: ['observe'],
        })
        if (decision.action !== 'allow') {
          return browserPowerDeniedOutput(decision, { tool: toolName, purpose })
        }
        const url = activeBrowserToolUrl(controller, tabId)
        try {
          const run = (async () => {
            if (!frameId) return controller.executeJS(tabId, code)
            const sendCdpCommand = (controller as {
              sendCdpCommand?: (tabId: string | null, method: string, params?: Record<string, unknown>) => Promise<unknown>
            }).sendCdpCommand
            if (typeof sendCdpCommand !== 'function') {
              throw new Error('browser_power_frame_eval_unavailable')
            }
            const world = await sendCdpCommand.call(controller, tabId, 'Page.createIsolatedWorld', {
              frameId,
              worldName: 'ready_power_eval',
              grantUniveralAccess: true,
            }) as Record<string, unknown>
            const contextId = Number(world.executionContextId)
            if (!Number.isFinite(contextId)) {
              throw new Error('browser_power_frame_context_unavailable')
            }
            const evaluated = await sendCdpCommand.call(controller, tabId, 'Runtime.evaluate', {
              expression: code,
              contextId,
              awaitPromise: true,
              returnByValue: true,
            }) as Record<string, unknown>
            const resultObject = evaluated.result && typeof evaluated.result === 'object'
              ? evaluated.result as Record<string, unknown>
              : null
            if (evaluated.exceptionDetails) {
              throw new Error(JSON.stringify(evaluated.exceptionDetails).slice(0, 500))
            }
            return resultObject && 'value' in resultObject ? resultObject.value : resultObject
          })()
          const result = await Promise.race([
            run,
            sleepWithAbort(timeoutMs, abortSignal).then(() => {
              throw new Error(`browser_power_eval timed out after ${timeoutMs}ms`)
            }),
          ])
          const limited = truncateJsonValue(result, maxResultBytes)
          const audit = recordBrowserPowerAuditEvent({
            toolName,
            grantId: decision.grantId,
            tabId,
            url,
            effects: decision.effects,
            purpose,
            codeSummary: summarizeCodeForAudit(code),
            paramsSummary: { timeoutMs, maxResultBytes, frameId },
            resultSummary: { bytes: limited.bytes, truncated: limited.truncated },
          })
          const confirmation = await detectBrowserPageTransactionConfirmation(controller, tabId)
          return attachBrowserActionSessionOutput(JSON.stringify({
            ok: true,
            tool: toolName,
            powerMode: true,
            grantId: decision.grantId,
            auditId: audit.id,
            effects: decision.effects,
            residualRisk: 'free_eval_scope_is_audit_only_for_side_effects',
            result: limited.value,
            resultTruncated: limited.truncated,
            resultBytes: limited.bytes,
            frameId,
          }, null, 2), {
            toolName,
            args,
            controller,
            sessionId,
            currentUserText,
            tabId,
            frameId,
            confirmation,
            nextSuggestedAction: confirmation ? 'finish with transaction proof' : 'read map again',
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          // P1-A1 — differentiated recovery advice + full target identity on
          // every Power failure (tabId/origin were missing before; the hint
          // was a static "read map again").
          const advice = classifyBrowserPowerFailure(message)
          const audit = recordBrowserPowerAuditEvent({
            toolName,
            grantId: decision.grantId,
            tabId,
            url,
            effects: decision.effects,
            purpose,
            codeSummary: summarizeCodeForAudit(code),
            paramsSummary: { timeoutMs, maxResultBytes, frameId },
            resultSummary: { failed: true, error: message.slice(0, 500) },
          })
          return attachBrowserActionSessionOutput(JSON.stringify({
            ok: false,
            tool: toolName,
            powerMode: true,
            grantId: decision.grantId,
            auditId: audit.id,
            effects: decision.effects,
            errorKind: 'browser_power_eval_failed',
            failureClass: advice.failureClass,
            errorMessage: message,
            codeSummary: summarizeCodeForAudit(code),
            tabId,
            frameId,
            currentUrl: url,
            origin: browserToolOriginFromUrl(url),
            nextSuggestedAction: advice.nextSuggestedAction,
          }, null, 2), {
            toolName,
            args,
            controller,
            sessionId,
            currentUserText,
            tabId,
            frameId,
            nextSuggestedAction: advice.nextSuggestedAction,
          })
        }
      }

      case 'browser_power_cdp': {
        const method = String(args.method || '').trim()
        if (!method) return 'Error: method is required'
        const purpose = String(args.purpose || '').trim()
        if (!purpose) return 'Error: purpose is required'
        const tabId = (args.tab_id as string) || null
        const frameId = String(args.frame_id || '').trim() || null
        const params = args.params && typeof args.params === 'object' ? args.params as Record<string, unknown> : {}
        const decision = resolvePowerDecisionForTool({
          toolName,
          args,
          controller,
          currentUserText,
          sessionId,
          tabId,
        })
        if (decision.action !== 'allow') {
          return browserPowerDeniedOutput(decision, { tool: toolName, purpose, method })
        }
        const sendCdpCommand = (controller as {
          sendCdpCommand?: (tabId: string | null, method: string, params?: Record<string, unknown>) => Promise<unknown>
        }).sendCdpCommand
        if (typeof sendCdpCommand !== 'function') {
          return browserStructuredOutput({
            ok: false,
            errorKind: 'browser_power_cdp_unavailable',
            message: '当前 BrowserController 未暴露 CDP command 通道。',
            method,
          })
        }
        // P1-A1 — a failing CDP command previously threw into the generic
        // outer catch ("Error executing browser_power_cdp: …") and lost the
        // target/session state the model needs to recover.
        try {
          const result = await sendCdpCommand.call(controller, tabId, method, params)
          const limited = truncateJsonValue(result, 80_000)
          const audit = recordBrowserPowerAuditEvent({
            toolName,
            grantId: decision.grantId,
            tabId,
            url: activeBrowserToolUrl(controller, tabId),
            effects: decision.effects,
            purpose,
            paramsSummary: { method, frameId, paramKeys: Object.keys(params).slice(0, 20) },
            resultSummary: { bytes: limited.bytes, truncated: limited.truncated },
          })
          const confirmation = await detectBrowserPageTransactionConfirmation(controller, tabId)
          return attachBrowserActionSessionOutput(JSON.stringify({
            ok: true,
            tool: toolName,
            grantId: decision.grantId,
            auditId: audit.id,
            method,
            effects: decision.effects,
            result: limited.value,
            resultTruncated: limited.truncated,
            frameId,
          }, null, 2), {
            toolName,
            args,
            controller,
            sessionId,
            currentUserText,
            tabId,
            frameId,
            confirmation,
            nextSuggestedAction: confirmation ? 'finish with transaction proof' : 'read map again',
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const advice = classifyBrowserPowerFailure(message)
          const currentUrl = activeBrowserToolUrl(controller, tabId)
          const audit = recordBrowserPowerAuditEvent({
            toolName,
            grantId: decision.grantId,
            tabId,
            url: currentUrl,
            effects: decision.effects,
            purpose,
            paramsSummary: { method, frameId, paramKeys: Object.keys(params).slice(0, 20) },
            resultSummary: { failed: true, error: message.slice(0, 500) },
          })
          return attachBrowserActionSessionOutput(JSON.stringify({
            ok: false,
            tool: toolName,
            powerMode: true,
            grantId: decision.grantId,
            auditId: audit.id,
            effects: decision.effects,
            errorKind: 'browser_power_cdp_failed',
            failureClass: advice.failureClass,
            errorMessage: message,
            method,
            tabId,
            frameId,
            currentUrl,
            origin: browserToolOriginFromUrl(currentUrl),
            nextSuggestedAction: advice.nextSuggestedAction,
          }, null, 2), {
            toolName,
            args,
            controller,
            sessionId,
            currentUserText,
            tabId,
            frameId,
            nextSuggestedAction: advice.nextSuggestedAction,
          })
        }
      }

      case 'browser_power_network_trace': {
        let tabId = (args.tab_id as string) || null
        const url = String(args.url || '').trim()
        const durationMs = clampNumber(args.duration_ms, 3000, 250, 30_000)
        const maxEvents = clampNumber(args.max_events, 120, 1, 500)
        const includeBodies = args.include_response_bodies === true
        const bodyMaxBytes = clampNumber(args.body_max_bytes, 4096, 256, 65_536)
        const purpose = String(args.purpose || 'resource/network trace').trim()
        const decision = resolvePowerDecisionForTool({
          toolName,
          args,
          controller,
          currentUserText,
          sessionId,
          tabId,
          url: url || undefined,
          fallbackEffects: url ? ['observe', 'navigate'] : ['observe'],
        })
        if (decision.action !== 'allow') {
          return browserPowerDeniedOutput(decision, { tool: toolName, purpose })
        }
        const active = controller.getActiveTab?.()
        tabId = tabId || active?.id || null
        if (!tabId) return 'Error: no active tab for network trace'
        if (typeof controller.startNetworkObserver !== 'function') {
          return browserStructuredOutput({
            ok: false,
            errorKind: 'browser_power_trace_unavailable',
            message: '当前 BrowserController 未暴露 network observer。',
          })
        }
        const observer = await controller.startNetworkObserver(tabId, { maxEvents })
        try {
          if (url) {
            const nav = await controller.navigate(tabId, url)
            if (!nav.success) {
              // P1-A1 — a navigate failure is structured, not a bare string.
              const advice = classifyBrowserPowerFailure(nav.error || 'target_stale navigation failed')
              const currentUrl = activeBrowserToolUrl(controller, tabId)
              return attachBrowserActionSessionOutput(JSON.stringify({
                ok: false,
                tool: toolName,
                powerMode: true,
                grantId: decision.grantId,
                errorKind: 'browser_power_trace_failed',
                failureClass: advice.failureClass,
                errorMessage: nav.error || 'failed to navigate target url',
                tabId,
                targetUrl: url,
                currentUrl,
                origin: browserToolOriginFromUrl(url || currentUrl),
                nextSuggestedAction: advice.nextSuggestedAction,
              }, null, 2), {
                toolName,
                args,
                controller,
                sessionId,
                currentUserText,
                tabId,
                nextSuggestedAction: advice.nextSuggestedAction,
              })
            }
          }
          await sleepWithAbort(durationMs, abortSignal)
          const events = observer.events().map((event) => ({
            ...event,
            responseHeaders: redactHeaders(event.responseHeaders),
          }))
          const bodies: Array<Record<string, unknown>> = []
          if (includeBodies) {
            for (const event of events.slice(0, 40)) {
              if (!event.requestId || event.failed) continue
              try {
                const body = await observer.getResponseBody(event.requestId)
                const limited = truncateJsonValue(body.body, bodyMaxBytes)
                bodies.push({
                  requestId: event.requestId,
                  url: event.url,
                  mimeType: event.mimeType,
                  base64Encoded: body.base64Encoded,
                  body: limited.value,
                  truncated: limited.truncated,
                  bytes: limited.bytes,
                })
              } catch {
                // Some response bodies are unavailable after redirects/cors/cache; trace still succeeds.
              }
            }
          }
          const audit = recordBrowserPowerAuditEvent({
            toolName,
            grantId: decision.grantId,
            tabId,
            url: url || activeBrowserToolUrl(controller, tabId),
            effects: decision.effects,
            purpose,
            paramsSummary: { durationMs, maxEvents, includeBodies },
            resultSummary: { eventCount: events.length, bodyCount: bodies.length },
          })
          const confirmation = detectNetworkTransactionConfirmation(events, bodies)
            || await detectBrowserPageTransactionConfirmation(controller, tabId)
          return attachBrowserActionSessionOutput(JSON.stringify({
            ok: true,
            tool: toolName,
            grantId: decision.grantId,
            auditId: audit.id,
            durationMs,
            eventCount: events.length,
            events,
            bodies,
            transactionConfirmed: confirmation || undefined,
          }, null, 2), {
            toolName,
            args,
            controller,
            sessionId,
            currentUserText,
            tabId,
            confirmation,
            nextSuggestedAction: confirmation ? 'finish with transaction proof' : 'read map again',
          })
        } catch (error) {
          // P1-A1 — observer / body-retrieval failures stay structured.
          const message = error instanceof Error ? error.message : String(error)
          const advice = classifyBrowserPowerFailure(message)
          const currentUrl = url || activeBrowserToolUrl(controller, tabId)
          return attachBrowserActionSessionOutput(JSON.stringify({
            ok: false,
            tool: toolName,
            powerMode: true,
            grantId: decision.grantId,
            errorKind: 'browser_power_trace_failed',
            failureClass: advice.failureClass,
            errorMessage: message,
            tabId,
            currentUrl,
            origin: browserToolOriginFromUrl(currentUrl),
            nextSuggestedAction: advice.nextSuggestedAction,
          }, null, 2), {
            toolName,
            args,
            controller,
            sessionId,
            currentUserText,
            tabId,
            nextSuggestedAction: advice.nextSuggestedAction,
          })
        } finally {
          await observer.stop().catch(() => undefined)
        }
      }

      case 'browser_power_resource_forensics': {
        const url = String(args.url || '').trim()
        const tabId = (args.tab_id as string) || null
        const purpose = String(args.purpose || 'resource forensics').trim()
        const decision = resolvePowerDecisionForTool({
          toolName,
          args,
          controller,
          currentUserText,
          sessionId,
          tabId,
          url: url || undefined,
          fallbackEffects: url ? ['observe', 'navigate', 'download'] : ['observe', 'download'],
        })
        if (decision.action !== 'allow') {
          return browserPowerDeniedOutput(decision, { tool: toolName, purpose })
        }
        // P1-A1 — resource inspection failures stay structured with target
        // identity + differentiated recovery advice.
        try {
          const result = await inspectBrowserResources(controller, {
            tabId,
            url: url || null,
            kinds: normalizeResourceKinds(args.kinds),
            waitMs: typeof args.wait_ms === 'number' ? args.wait_ms : (typeof args.trace_ms === 'number' ? args.trace_ms : undefined),
            maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : 40,
            signal: abortSignal,
          })
          const audit = recordBrowserPowerAuditEvent({
            toolName,
            grantId: decision.grantId,
            tabId,
            url: url || activeBrowserToolUrl(controller, tabId),
            effects: decision.effects,
            purpose,
            paramsSummary: { kinds: args.kinds || null },
            resultSummary: { candidateCount: result.candidates.length },
          })
          return stringifyBrowserJsonOrFailure({
            ...result,
            tool: toolName,
            powerMode: true,
            grantId: decision.grantId,
            auditId: audit.id,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const advice = classifyBrowserPowerFailure(message)
          const currentUrl = url || activeBrowserToolUrl(controller, tabId)
          return attachBrowserActionSessionOutput(JSON.stringify({
            ok: false,
            tool: toolName,
            powerMode: true,
            grantId: decision.grantId,
            errorKind: 'browser_power_forensics_failed',
            failureClass: advice.failureClass,
            errorMessage: message,
            tabId,
            currentUrl,
            origin: browserToolOriginFromUrl(currentUrl),
            nextSuggestedAction: advice.nextSuggestedAction,
          }, null, 2), {
            toolName,
            args,
            controller,
            sessionId,
            currentUserText,
            tabId,
            nextSuggestedAction: advice.nextSuggestedAction,
          })
        }
      }

      case 'browser_media_download_advanced': {
        const directory = String(args.directory || '').trim()
        if (!directory) return 'Error: directory is required'
        const tabId = (args.tab_id as string) || null
        const pageUrl = String(args.page_url || '').trim()
        const decision = resolvePowerDecisionForTool({
          toolName,
          args,
          controller,
          currentUserText,
          sessionId,
          tabId,
          url: pageUrl || undefined,
          destination: directory,
          fallbackEffects: ['download'],
        })
        if (decision.action !== 'allow') {
          return browserPowerDeniedOutput(decision, { tool: toolName, directory })
        }
        let candidates = Array.isArray(args.candidates) ? args.candidates as Array<Record<string, unknown>> : []
        if (candidates.length === 0) {
          const inspected = await inspectBrowserResources(controller, {
            tabId,
            url: pageUrl || null,
            kinds: ['video', 'audio', 'stream'],
            waitMs: 1200,
            maxCandidates: 12,
            signal: abortSignal,
          })
	          candidates = Array.isArray(inspected.candidates)
	            ? inspected.candidates.map((candidate) => candidate as unknown as Record<string, unknown>)
	            : []
        }
        const urls = candidates
          .map((item) => String(item.url || item.downloadUrl || '').trim())
          .filter((item, index, arr) => /^https?:\/\//i.test(item) && arr.indexOf(item) === index)
          .slice(0, 20)
        if (urls.length === 0) {
          return browserStructuredOutput({
            ok: false,
            errorKind: 'media_candidates_missing',
            message: '未找到可下载媒体候选；请先 browser_power_resource_forensics 或播放/滚动/等待后重试。',
            candidateCount: candidates.length,
          })
        }
        const output = await downloadUrlsToDirectory(controller, {
          urls,
          directory,
          filenamePrefix: String(args.filename_prefix || 'media'),
          overwrite: args.overwrite === true,
          tabId,
          referer: pageUrl || null,
        })
        const text = typeof output === 'string' ? output : output.text
        const parsed = (() => {
          try { return JSON.parse(text) as Record<string, unknown> } catch { return { ok: false, raw: text } }
        })()
        const success = Number(parsed.success || 0)
        const failed = Number(parsed.failed || 0)
        // P1-W5 — real, honest verification: each claimed-success file must
        // exist on disk with non-zero bytes. No ffprobe claim (none runs).
        const downloadResults = Array.isArray(parsed.results)
          ? parsed.results as Array<Record<string, unknown>>
          : []
        const mediaVerification = verifyDownloadedMedia(downloadResults)
        const audit = recordBrowserPowerAuditEvent({
          toolName,
          grantId: decision.grantId,
          tabId,
          url: pageUrl || activeBrowserToolUrl(controller, tabId),
          effects: decision.effects,
          purpose: 'advanced media download',
          paramsSummary: { candidateCount: candidates.length, urlCount: urls.length, directory },
          resultSummary: { success, failed, verifiedBytes: mediaVerification.nonZero, invalid: mediaVerification.invalidPaths.length },
        })
        const payload = {
          // Completion now requires the saved bytes to verify, not just a 200.
          ok: success > 0 && failed === 0 && mediaVerification.ok,
          tool: toolName,
          grantId: decision.grantId,
          auditId: audit.id,
          candidateCount: candidates.length,
          attemptedUrlCount: urls.length,
          verification: {
            ok: mediaVerification.ok,
            method: mediaVerification.method,
            checked: mediaVerification.checked,
            nonZero: mediaVerification.nonZero,
            invalidPaths: mediaVerification.invalidPaths,
            note: mediaVerification.invalidPaths.length > 0
              ? '部分文件缺失或为空字节，未通过下载校验'
              : '已校验保存文件存在且非空字节',
          },
          ...parsed,
        }
        if (typeof output === 'string') return JSON.stringify(payload, null, 2)
        return createToolExecutionOutput(JSON.stringify(payload, null, 2), {
          shape: 'json',
          data: payload,
          projectionPatch: output.projectionPatch,
          contextModifier: output.contextModifier,
        })
      }

      case 'browser_power_script_run': {
        const stepsRaw = args.steps
        if (!Array.isArray(stepsRaw)) return 'Error: steps must be an array'
        const purpose = String(args.purpose || '').trim()
        if (!purpose) return 'Error: purpose is required'
        const tabId = (args.tab_id as string) || null
        const decision = resolvePowerDecisionForTool({
          toolName,
          args,
          controller,
          currentUserText,
          sessionId,
          tabId,
          fallbackEffects: ['page_mutation'],
        })
        if (decision.action !== 'allow') {
          return browserPowerDeniedOutput(decision, { tool: toolName, purpose })
        }
        const continueOnError = args.continue_on_error === true
        const lines: string[] = []
        for (let index = 0; index < stepsRaw.length; index += 1) {
          const step = stepsRaw[index]
          if (!step || typeof step !== 'object') {
            lines.push(`Step ${index + 1}: Error: invalid step`)
            if (!continueOnError) break
            continue
          }
          const result = await runWorkflowStep(controller, step as Record<string, unknown>, tabId, abortSignal)
          lines.push(`Step ${index + 1}: ${result}`)
          if (!continueOnError && result.startsWith('Error:')) break
        }
        const audit = recordBrowserPowerAuditEvent({
          toolName,
          grantId: decision.grantId,
          tabId,
          url: activeBrowserToolUrl(controller, tabId),
          effects: decision.effects,
          purpose,
          paramsSummary: { stepCount: stepsRaw.length },
          resultSummary: { lineCount: lines.length },
        })
        return truncate(JSON.stringify({
          ok: true,
          tool: toolName,
          grantId: decision.grantId,
          auditId: audit.id,
          output: lines,
        }, null, 2))
      }

      default:
        return `Unknown browser tool: ${toolName}`
  }
}
