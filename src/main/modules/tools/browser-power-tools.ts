/**
 * P3 Phase B4（2026-07-04，纯移动拆分）— browser-tools Power 工具组。
 *
 * 从 browser-tools.ts 逐字搬出七个 case 的实现体（browser_eval /
 * browser_eval / browser_cdp / browser_network /
 * browser_resources / browser_download /
 * internal_browser_action_composer，经 executeBrowserPowerTool 统一入口分发）与
 * Power 独占 helper（clampNumber / summarizeCodeForAudit / truncateJsonValue /
 * browserPowerDeniedOutput / resolvePowerDecisionForTool，后三者供
 * browser-tools 的 legacy power 前置路径回接导入）。
 * attachBrowserToolOutput（sitePermissionNotices 精确任务范围合同）留在
 * browser-tools，经 BrowserPowerToolContext 注入回接，防循环依赖。
 * 行为零变更。
 */
import type { BrowserController } from '../browser-engine/ipc-handler'
import { createHash, randomUUID } from 'node:crypto'
import { classifyBrowserPowerFailure, browserToolOriginFromUrl } from './browser-power-failure'
import { verifyDownloadedMedia } from '../browser-engine/media-verification'
import { inspectBrowserResources } from '../browser-engine/resource-sniffer'
import {
  browserPowerGrantRequiredPayload,
  inferBrowserPowerEffects,
  recordBrowserPowerAuditEvent,
  registerBrowserPowerGrant,
  resolveBrowserPowerAuthorization,
  type BrowserPowerDecision,
} from '../browser-engine/browser-power-policy'
import {
  createToolExecutionOutput,
  type ToolExecutionOutput,
} from '../agent-control/tools-runtime/tool-result-types'
import {
  browserEffectsIncludeDestructive,
  type BrowserPowerEffect,
} from '../../../shared/browser-power'
import type { BrowserPowerConfirmationSuspensionRequest } from '../../../shared/browser-workflow-control'
import {
  createBrowserStructuredOutput as browserStructuredOutput,
  stringifyBrowserJsonOrFailure,
} from './browser-failure-output'
import { downloadUrlsToDirectory, normalizeResourceKinds, resolveAuthorizedBrowserDownloadDirectory } from './browser-media-download'
import { createRotatingLogger } from '../../utils/rotating-logger'
import {
  activeBrowserToolUrl
} from './browser-tool-shared'
import { browserSnapshotService } from '../browser-engine/browser-snapshot-service'
import type { BrowserTaskEnvelope } from '../../../shared/browser-task-envelope'
import type { BrowserMutationBoundary } from './browser-action-executor'

const logger = createRotatingLogger('ready-tools.log', { buffered: true })
function log(msg: string) {
  try { logger.append(`[${new Date().toISOString()}] ${msg}\n`) } catch { /* silent-catch: 日志写入失败不影响主流程。 */ }
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const next = Number(value)
  if (!Number.isFinite(next)) return fallback
  return Math.max(min, Math.min(max, Math.floor(next)))
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

function powerInputHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function persistDestructivePowerPreflight(params: {
  controller: BrowserController
  decision: BrowserPowerDecision
  toolName: string
  sessionId?: string
  tabId: string | null
  url: string | null
  purpose: string
  objectRef: string | null
  input: unknown
}): Promise<{ ok: true; auditId: string | null } | { ok: false; output: ToolExecutionOutput }> {
  if (params.decision.destructiveEffects.length === 0) return { ok: true, auditId: null }
  if (!params.decision.grantId || !params.decision.confirmationSource) {
    return {
      ok: false,
      output: browserStructuredOutput({
        ok: false,
        errorKind: 'power_preflight_confirmation_missing',
        message: '高风险浏览器动作缺少绑定本轮对象的真实用户确认。',
      }),
    }
  }
  try {
    const identity = await browserSnapshotService.documentIdentity(params.controller, params.tabId)
    if (!identity.key) throw new Error('browser_document_identity_unavailable')
    const auditId = `browser-power-preflight-${randomUUID()}`
    params.controller.recordBrowserPowerPreflightAudit({
      id: auditId,
      tool_name: params.toolName,
      grant_id: params.decision.grantId,
      confirmation_source: params.decision.confirmationSource,
      scope_id: params.sessionId || null,
      tab_id: params.tabId,
      document_key_hash: powerInputHash(identity.key),
      url: params.url,
      object_ref: params.objectRef,
      effects_json: JSON.stringify(params.decision.effects),
      purpose: params.purpose,
      input_hash: powerInputHash(params.input),
      created_at: new Date().toISOString(),
    })
    return { ok: true, auditId }
  } catch (error) {
    log(`power preflight audit failed tool=${params.toolName}: ${error instanceof Error ? error.message : String(error)}`)
    return {
      ok: false,
      output: browserStructuredOutput({
        ok: false,
        errorKind: 'power_preflight_audit_failed',
        message: '高风险浏览器动作无法在执行前写入持久记录，已拒绝执行。',
        cause: error instanceof Error ? error.message : String(error),
      }),
    }
  }
}

export function browserPowerDeniedOutput(decision: BrowserPowerDecision, extra?: Record<string, unknown>): ToolExecutionOutput {
  const suspensionRequest = (decision as BrowserPowerDecisionWithSuspension).browserSuspensionRequest
  return browserStructuredOutput({
    ...browserPowerGrantRequiredPayload(decision, extra),
    ...(suspensionRequest
      ? {
          phase: 'confirmation_required',
          suspendAfterToolResult: true,
          browserSuspensionRequest: suspensionRequest,
        }
      : {}),
  })
}

type BrowserPowerDecisionWithSuspension = BrowserPowerDecision & {
  browserSuspensionRequest?: BrowserPowerConfirmationSuspensionRequest
}

export function resolvePowerDecisionForTool(params: {
  toolName: string
  args: Record<string, unknown>
  controller: BrowserController
  sessionId?: string
  tabId?: string | null
  url?: string | null
  destination?: string | null
  fallbackEffects?: BrowserPowerEffect[]
  taskEnvelope?: BrowserTaskEnvelope | null
  documentKeyHash?: string | null
  objectRef?: string | null
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
    scopeId: params.taskEnvelope?.scopeId || params.sessionId || null,
    runId: params.taskEnvelope?.runId || null,
    taskId: params.taskEnvelope?.browserTaskId || null,
    tabId,
    documentKeyHash: params.documentKeyHash || null,
    objectRef: params.objectRef || null,
    url,
    destination: params.destination || null,
  })
}

/**
 * B4 注入面：attachBrowserToolOutput 的实现体留在
 * browser-tools.ts，以函数引用注入，本模块不反向 import。
 */
export interface BrowserPowerToolContext {
  controller: BrowserController
  abortSignal?: AbortSignal
  sessionId?: string
  trustedRoots?: string[]
  taskEnvelope?: BrowserTaskEnvelope | null
  confirmedBrowserPowerRequest?: BrowserPowerConfirmationSuspensionRequest | null
  mutationBoundary: BrowserMutationBoundary
  requestPowerConfirmation?: (details: {
    toolName: string
    effects: BrowserPowerEffect[]
    purpose: string
    origin: string | null
    objectRef: string
    inputHash: string
  }) => Promise<boolean>
  attachBrowserToolOutput: (
    result: string | ToolExecutionOutput,
    params: {
      toolName: string
      args: Record<string, unknown>
      controller: BrowserController
      sessionId?: string
      tabId?: string | null
      frameId?: string | null
      confirmation?: unknown
      nextSuggestedAction?: string | null
    },
  ) => string | ToolExecutionOutput
}

async function resolvePowerDecisionWithTaskAuthority(params: {
  toolName: string
  args: Record<string, unknown>
  controller: BrowserController
  sessionId?: string
  taskEnvelope?: BrowserTaskEnvelope | null
  tabId: string | null
  purpose: string
  objectRef: string
  input: unknown
  destination?: string | null
  fallbackEffects?: BrowserPowerEffect[]
  confirmedRequest?: BrowserPowerConfirmationSuspensionRequest | null
}): Promise<BrowserPowerDecisionWithSuspension> {
  const effects = inferBrowserPowerEffects({
    toolName: params.toolName,
    args: params.args,
    fallback: params.fallbackEffects,
  })
  if (!browserEffectsIncludeDestructive(effects)) return resolvePowerDecisionForTool(params)
  const envelope = params.taskEnvelope
  const publicToolName = params.toolName === 'eval' ? 'browser_eval' : 'browser_cdp'
  const hasSuppliedGrant = typeof params.args.grant_id === 'string' && params.args.grant_id.trim().length > 0
  const canMintBoundGrant = Boolean(
    envelope
    && envelope.toolName === publicToolName
    && envelope.tabId === params.tabId,
  )
  if (!hasSuppliedGrant && !canMintBoundGrant) return resolvePowerDecisionForTool(params)
  const identity = await browserSnapshotService.documentIdentity(params.controller, params.tabId)
  const documentKeyHash = identity.key ? powerInputHash(identity.key) : null
  const base = resolvePowerDecisionForTool({ ...params, documentKeyHash })
  if (base.action !== 'grant_required') return base
  if (
    !envelope
    || !envelope.browserTaskId
    || !documentKeyHash
    || envelope.toolName !== publicToolName
    || envelope.tabId !== params.tabId
  ) return base

  const currentUrl = activeBrowserToolUrl(params.controller, params.tabId)
  const origin = (() => {
    try { return currentUrl ? new URL(currentUrl).origin : null } catch {
      // silent-catch: malformed URL remains unbound and cannot widen authority.
      return null
    }
  })()
  const inputHash = powerInputHash(params.input)
  const targetDigest = powerInputHash({
    scopeId: envelope.scopeId,
    ownerRunId: envelope.runId,
    browserTaskId: envelope.browserTaskId,
    tabId: params.tabId,
    documentKeyHash,
    origin,
    objectRef: params.objectRef,
  })
  const confirmed = params.confirmedRequest
  const confirmedEffectSet = new Set(confirmed?.effects || [])
  const exactConfirmedEffects = Boolean(
    confirmed
    && confirmed.effects.length === base.effects.length
    && base.effects.every((effect) => confirmedEffectSet.has(effect)),
  )
  const confirmedTargetDigest = confirmed
    ? powerInputHash({
        scopeId: confirmed.target.scopeId,
        ownerRunId: confirmed.target.ownerRunId,
        browserTaskId: confirmed.target.browserTaskId,
        tabId: confirmed.target.tabId,
        documentKeyHash: confirmed.target.documentKeyHash,
        origin: confirmed.target.origin,
        objectRef: confirmed.actionIntent.objectRef,
      })
    : null
  if (
    confirmed
    && confirmed.toolName === publicToolName
    && exactConfirmedEffects
    && confirmed.actionIntent.objectRef === params.objectRef
    && confirmed.actionIntent.inputHash === inputHash
    && confirmed.target.scopeId === envelope.scopeId
    && confirmed.target.ownerRunId === envelope.runId
    && confirmed.target.browserTaskId === envelope.browserTaskId
    && confirmed.target.tabId === params.tabId
    && confirmed.target.documentKeyHash === documentKeyHash
    && confirmed.target.origin === origin
    && confirmed.target.targetDigest === confirmedTargetDigest
    && confirmed.target.targetDigest === targetDigest
  ) {
    const grant = registerBrowserPowerGrant({
      scopeId: envelope.scopeId,
      runId: envelope.runId,
      taskId: envelope.browserTaskId,
      tabId: params.tabId,
      documentKeyHash,
      objectRef: params.objectRef,
      effects: [...base.effects],
      expiresAt: Date.now() + 10 * 60_000,
      remainingCalls: 1,
      source: 'confirmation_card',
      reason: confirmed.requestId,
    })
    return resolveBrowserPowerAuthorization({
      toolName: params.toolName,
      args: params.args,
      effects: base.effects,
      grantId: grant.id,
      scopeId: envelope.scopeId,
      runId: envelope.runId,
      taskId: envelope.browserTaskId,
      tabId: params.tabId,
      documentKeyHash,
      objectRef: params.objectRef,
      url: currentUrl,
      destination: params.destination || null,
    })
  }
  // Public task continuation is retired. A grant-required operation remains
  // fail-closed in the current turn and must not create an unanswerable
  // confirmation checkpoint.
  return base
}

export async function executeBrowserPowerTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: BrowserPowerToolContext,
): Promise<string | ToolExecutionOutput> {
  const {
    controller,
    abortSignal,
    sessionId,
    trustedRoots,
    taskEnvelope,
    confirmedBrowserPowerRequest,
    mutationBoundary,
    attachBrowserToolOutput,
  } = ctx
  switch (toolName) {
      case 'eval': {
        const code = String(args.code || '')
        if (!code.trim()) return 'Error: code is required'
        const purpose = String(args.purpose || '').trim()
        if (!purpose) return 'Error: purpose is required'
        const tabId = String(args.tab_id || taskEnvelope?.tabId || '').trim() || null
        const frameId = String(args.frame_id || '').trim() || null
        const world = args.world === 'main' ? 'main' : 'isolated'
        const maxResultBytes = clampNumber(args.max_result_bytes, 20_000, 1024, 200_000)
        const timeoutMs = clampNumber(args.timeout_ms, 5000, 250, 30_000)
        const objectRef = powerInputHash({ code, frameId, world })
        const decision = await resolvePowerDecisionWithTaskAuthority({
          toolName,
          args,
          controller,
          sessionId,
          tabId,
          taskEnvelope,
          purpose,
          objectRef,
          input: { code, frameId, world },
          fallbackEffects: ['observe'],
          confirmedRequest: confirmedBrowserPowerRequest,
        })
        if (decision.action !== 'allow') {
          return browserPowerDeniedOutput(decision, { tool: toolName, purpose })
        }
        const url = activeBrowserToolUrl(controller, tabId)
        const preflight = await persistDestructivePowerPreflight({
          controller,
          decision,
          toolName,
          sessionId,
          tabId,
          url,
          purpose,
          objectRef,
          input: { code, frameId, world },
        })
        if (!preflight.ok) return preflight.output
        let transportInvoked = false
        try {
          const run = (async () => {
            if (world === 'main') {
              if (frameId && typeof controller.executeJSInFrame === 'function') {
                const value = await mutationBoundary.invokeTransport(() => {
                  transportInvoked = true
                  return controller.executeJSInFrame!(tabId, frameId, code, { timeoutMs, signal: abortSignal })
                })
                mutationBoundary.recordMechanicalFact({ delivery: 'delivered' })
                return value
              }
              const value = await mutationBoundary.invokeTransport(() => {
                transportInvoked = true
                return controller.executeJS(tabId, code, { timeoutMs, signal: abortSignal })
              })
              mutationBoundary.recordMechanicalFact({ delivery: 'delivered' })
              return value
            }
            const sendCdpCommand = (controller as {
              sendCdpCommand?: (tabId: string | null, method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<unknown>
            }).sendCdpCommand
            if (typeof sendCdpCommand !== 'function') {
              throw new Error('browser_power_frame_eval_unavailable')
            }
            let targetFrameId = frameId
            if (!targetFrameId) {
              const tree = await sendCdpCommand.call(controller, tabId, 'Page.getFrameTree', undefined, {
                timeoutMs,
                signal: abortSignal,
              }) as { frameTree?: { frame?: { id?: string } } }
              targetFrameId = String(tree.frameTree?.frame?.id || '') || null
            }
            if (!targetFrameId) throw new Error('browser_eval_frame_context_unavailable')
            const isolatedWorld = await sendCdpCommand.call(controller, tabId, 'Page.createIsolatedWorld', {
              frameId: targetFrameId,
              worldName: 'ready_power_eval',
              grantUniveralAccess: true,
            }, { timeoutMs, signal: abortSignal }) as Record<string, unknown>
            const contextId = Number(isolatedWorld.executionContextId)
            if (!Number.isFinite(contextId)) {
              throw new Error('browser_power_frame_context_unavailable')
            }
            const evaluated = await mutationBoundary.invokeTransport(() => {
              transportInvoked = true
              return sendCdpCommand.call(controller, tabId, 'Runtime.evaluate', {
                expression: code,
                contextId,
                awaitPromise: true,
                returnByValue: true,
              }, { timeoutMs, signal: abortSignal })
            }) as Record<string, unknown>
            mutationBoundary.recordMechanicalFact({ delivery: 'delivered' })
            const resultObject = evaluated.result && typeof evaluated.result === 'object'
              ? evaluated.result as Record<string, unknown>
              : null
            if (evaluated.exceptionDetails) {
              throw new Error(JSON.stringify(evaluated.exceptionDetails).slice(0, 500))
            }
            return resultObject && 'value' in resultObject ? resultObject.value : resultObject
          })()
          const result = await run
          const limited = truncateJsonValue(result, maxResultBytes)
          const audit = recordBrowserPowerAuditEvent({
            toolName,
            grantId: decision.grantId,
            tabId,
            url,
            effects: decision.effects,
            purpose,
            codeSummary: summarizeCodeForAudit(code),
            paramsSummary: { timeoutMs, maxResultBytes, frameId, world },
            resultSummary: { bytes: limited.bytes, truncated: limited.truncated },
          })
          const confirmation = null
          return attachBrowserToolOutput(JSON.stringify({
            ok: true,
            tool: toolName,
            powerMode: true,
            grantId: decision.grantId,
            auditId: audit.id,
            preflightAuditId: preflight.auditId,
            effects: decision.effects,
            residualRisk: 'free_eval_scope_is_audit_only_for_side_effects',
            result: limited.value,
            resultTruncated: limited.truncated,
            resultBytes: limited.bytes,
            frameId,
            world,
          }, null, 2), {
            toolName,
            args,
            controller,
            sessionId,
            tabId,
            frameId,
            confirmation,
            nextSuggestedAction: confirmation ? 'finish with transaction proof' : 'read map again',
          })
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') throw error
          const message = error instanceof Error ? error.message : String(error)
          // silent-catch: P1-A1 — differentiated recovery advice + full target identity on
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
            paramsSummary: { timeoutMs, maxResultBytes, frameId, world },
            resultSummary: { failed: true, error: message.slice(0, 500) },
          })
          return attachBrowserToolOutput(JSON.stringify({
            ok: false,
            tool: toolName,
            powerMode: true,
            grantId: decision.grantId,
            auditId: audit.id,
            preflightAuditId: preflight.auditId,
            effects: decision.effects,
            errorKind: 'browser_eval_failed',
            mayHaveCommitted: transportInvoked,
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
            tabId,
            frameId,
            nextSuggestedAction: advice.nextSuggestedAction,
          })
        }
      }

      case 'cdp': {
        const method = String(args.method || '').trim()
        if (!method) return 'Error: method is required'
        const purpose = String(args.purpose || '').trim()
        if (!purpose) return 'Error: purpose is required'
        const tabId = String(args.tab_id || taskEnvelope?.tabId || '').trim() || null
        const frameId = String(args.frame_id || '').trim() || null
        const params = args.params && typeof args.params === 'object' ? args.params as Record<string, unknown> : {}
        const objectRef = powerInputHash({ method, params, frameId })
        const decision = await resolvePowerDecisionWithTaskAuthority({
          toolName,
          args,
          controller,
          sessionId,
          tabId,
          taskEnvelope,
          purpose,
          objectRef,
          input: { method, params, frameId },
          confirmedRequest: confirmedBrowserPowerRequest,
        })
        if (decision.action !== 'allow') {
          return browserPowerDeniedOutput(decision, { tool: toolName, purpose, method })
        }
        const sendCdpCommand = (controller as {
          sendCdpCommand?: (tabId: string | null, method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<unknown>
        }).sendCdpCommand
        if (typeof sendCdpCommand !== 'function') {
          return browserStructuredOutput({
            ok: false,
            errorKind: 'browser_cdp_unavailable',
            message: '当前 BrowserController 未暴露 CDP command 通道。',
            method,
          })
        }
        const currentUrl = activeBrowserToolUrl(controller, tabId)
        const preflight = await persistDestructivePowerPreflight({
          controller,
          decision,
          toolName,
          sessionId,
          tabId,
          url: currentUrl,
          purpose,
          objectRef,
          input: { method, params, frameId },
        })
        if (!preflight.ok) return preflight.output
        // P1-A1 — a failing CDP command previously threw into the generic
        // outer catch ("Error executing browser_cdp: …") and lost the
        // target/session state the model needs to recover.
        let transportInvoked = false
        try {
          const result = await mutationBoundary.invokeTransport(() => {
            transportInvoked = true
            return sendCdpCommand.call(controller, tabId, method, params, {
              timeoutMs: clampNumber(args.timeout_ms, 15_000, 250, 30_000),
              signal: abortSignal,
            })
          })
          mutationBoundary.recordMechanicalFact({ delivery: 'delivered' })
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
          const confirmation = null
          return attachBrowserToolOutput(JSON.stringify({
            ok: true,
            tool: toolName,
            grantId: decision.grantId,
            auditId: audit.id,
            preflightAuditId: preflight.auditId,
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
            tabId,
            frameId,
            confirmation,
            nextSuggestedAction: confirmation ? 'finish with transaction proof' : 'read map again',
          })
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') throw error
          // silent-catch: failure returns structured audit-backed error output with recovery advice
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
          return attachBrowserToolOutput(JSON.stringify({
            ok: false,
            tool: toolName,
            powerMode: true,
            grantId: decision.grantId,
            auditId: audit.id,
            preflightAuditId: preflight.auditId,
            effects: decision.effects,
            errorKind: 'browser_cdp_failed',
            mayHaveCommitted: transportInvoked,
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
            tabId,
            frameId,
            nextSuggestedAction: advice.nextSuggestedAction,
          })
        }
      }

      case 'resources_forensics': {
        const url = String(args.url || '').trim()
        const tabId = (args.tab_id as string) || null
        const purpose = String(args.purpose || 'resource forensics').trim()
        const decision = resolvePowerDecisionForTool({
          toolName,
          args,
          controller,
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
          if (error instanceof Error && error.name === 'AbortError') throw error
          // silent-catch: failure returns structured error output with recovery advice
          const message = error instanceof Error ? error.message : String(error)
          const advice = classifyBrowserPowerFailure(message)
          const currentUrl = url || activeBrowserToolUrl(controller, tabId)
          return attachBrowserToolOutput(JSON.stringify({
            ok: false,
            tool: toolName,
            powerMode: true,
            grantId: decision.grantId,
            errorKind: 'browser_resources_failed',
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
            tabId,
            nextSuggestedAction: advice.nextSuggestedAction,
          })
        }
      }

      case 'download_advanced': {
        const resolvedDirectory = resolveAuthorizedBrowserDownloadDirectory(args.directory, { trustedRoots })
        if (!resolvedDirectory.ok) {
          return browserStructuredOutput({ ok: false, errorKind: resolvedDirectory.errorCode, requested: resolvedDirectory.requested })
        }
        const directory = resolvedDirectory.directory
        const tabId = (args.tab_id as string) || null
        const pageUrl = String(args.page_url || '').trim()
        const decision = resolvePowerDecisionForTool({
          toolName,
          args,
          controller,
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
          .filter((item, index, arr) => /^(?:https?:\/\/|blob:|data:)/i.test(item) && arr.indexOf(item) === index)
          .slice(0, 20)
        if (urls.length === 0) {
          return browserStructuredOutput({
            ok: false,
            errorKind: 'media_candidates_missing',
            message: '未找到可下载媒体候选；请先 browser_resources 或播放/滚动/等待后重试。',
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
          maxTotalBytes: typeof args.max_total_bytes === 'number' ? args.max_total_bytes : undefined,
          abortSignal,
          mutationBoundary,
        })
        const text = typeof output === 'string' ? output : output.text
        const parsed = (() => {
          try { return JSON.parse(text) as Record<string, unknown> } catch { /* silent-catch: non-JSON downloader output degrades to raw-text failure */ return { ok: false, raw: text } }
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

      default:
        return `Unknown browser tool: ${toolName}`
  }
}
