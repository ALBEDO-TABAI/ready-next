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
 * attachBrowserActionSessionOutput（sitePermissionNotices 排空合同）留在
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
import type { BrowserTransactionConfirmation } from '../browser-engine/browser-action-session'
import {
  createToolExecutionOutput,
  type ToolExecutionOutput,
} from '../agent-control/tools-runtime/tool-result-types'
import {
  browserEffectsIncludeDestructive,
  type BrowserPowerEffect,
  type BrowserPowerGrant,
} from '../../../shared/browser-power'
import {
  createBrowserStructuredOutput as browserStructuredOutput,
  stringifyBrowserJsonOrFailure,
} from './browser-failure-output'
import { downloadUrlsToDirectory, normalizeResourceKinds, resolveAuthorizedBrowserDownloadDirectory } from './browser-media-download'
import { createRotatingLogger } from '../../utils/rotating-logger'
import {
  activeBrowserToolUrl,
  detectBrowserPageTransactionConfirmation,
  truncate,
} from './browser-tool-shared'
import { browserSnapshotService } from '../browser-engine/browser-snapshot-service'
import type { BrowserTaskEnvelope } from '../../../shared/browser-task-envelope'

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
    taskId: params.taskEnvelope?.taskId || null,
    tabId,
    documentKeyHash: params.documentKeyHash || null,
    objectRef: params.objectRef || null,
    url,
    destination: params.destination || null,
    currentUserText: params.currentUserText || null,
  })
}

/**
 * B4 注入面：attachBrowserActionSessionOutput 的实现体留在
 * browser-tools.ts，以函数引用注入，本模块不反向 import。
 */
export interface BrowserPowerToolContext {
  controller: BrowserController
  abortSignal?: AbortSignal
  sessionId?: string
  currentUserText?: string
  trustedRoots?: string[]
  taskEnvelope?: BrowserTaskEnvelope | null
  requestPowerConfirmation?: (details: {
    toolName: string
    effects: BrowserPowerEffect[]
    purpose: string
    origin: string | null
    objectRef: string
    inputHash: string
  }) => Promise<boolean>
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
}

function currentInstructionAuthorizesPowerEffects(
  instruction: string,
  effects: readonly BrowserPowerEffect[],
): boolean {
  const text = String(instruction || '')
  return effects.every((effect) => {
    switch (effect) {
      case 'payment':
        return /(?:确认|立即|执行|帮我).{0,10}(?:支付|付款|下单|购买|转账)|(?:pay|place order|purchase|transfer).{0,10}(?:now|confirm|execute)/i.test(text)
      case 'remote_delete':
        return /(?:删除|撤回|销毁).{0,20}(?:帖子|消息|记录|远程|云端|内容)/i.test(text)
      case 'account_delete':
        return /(?:注销|删除|关闭).{0,12}(?:账号|账户)/i.test(text)
      case 'credential_change':
        return /(?:修改|更换|重置|更新).{0,12}(?:密码|凭据|登录信息|2fa|双重验证)/i.test(text)
      case 'secret_export':
        return /(?:导出|复制|读取并保存).{0,16}(?:cookie|token|令牌|密钥|secret|凭据)/i.test(text)
      case 'access_control_circumvention':
        return /(?:确认|明确).{0,10}(?:运行|执行|调用).{0,18}(?:动态脚本|混淆脚本|未知\s*cdp|未列出的\s*cdp)/i.test(text)
      default:
        return true
    }
  })
}

async function resolvePowerDecisionWithTaskAuthority(params: {
  toolName: string
  args: Record<string, unknown>
  controller: BrowserController
  sessionId?: string
  currentUserText?: string
  taskEnvelope?: BrowserTaskEnvelope | null
  tabId: string | null
  purpose: string
  objectRef: string
  input: unknown
  destination?: string | null
  fallbackEffects?: BrowserPowerEffect[]
  requestPowerConfirmation?: BrowserPowerToolContext['requestPowerConfirmation']
}): Promise<BrowserPowerDecision> {
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
    && envelope.allowedToolNames.includes(publicToolName)
    && envelope.tabId === params.tabId,
  )
  if (!hasSuppliedGrant && !canMintBoundGrant) return resolvePowerDecisionForTool(params)
  const identity = await browserSnapshotService.documentIdentity(params.controller, params.tabId)
  const documentKeyHash = identity.key ? powerInputHash(identity.key) : null
  const base = resolvePowerDecisionForTool({ ...params, documentKeyHash })
  if (base.action !== 'grant_required') return base
  if (
    !envelope
    || !documentKeyHash
    || !envelope.allowedToolNames.includes(publicToolName)
    || envelope.tabId !== params.tabId
  ) return base

  const currentUrl = activeBrowserToolUrl(params.controller, params.tabId)
  const explicit = currentInstructionAuthorizesPowerEffects(envelope.primaryInstruction, base.destructiveEffects)
  const confirmed = explicit || await params.requestPowerConfirmation?.({
    toolName: publicToolName,
    effects: base.effects,
    purpose: params.purpose,
    origin: (() => {
      try { return currentUrl ? new URL(currentUrl).origin : null } catch {
        // silent-catch: a malformed current URL cannot authorize an origin-bound grant.
        return null
      }
    })(),
    objectRef: params.objectRef,
    inputHash: powerInputHash(params.input),
  }) === true
  if (!confirmed) return base

  const grant: BrowserPowerGrant = registerBrowserPowerGrant({
    source: explicit ? 'current_user_verbatim' : 'confirmation_card',
    scopeId: envelope.scopeId,
    runId: envelope.runId,
    taskId: envelope.taskId,
    tabId: params.tabId,
    documentKeyHash,
    objectRef: params.objectRef,
    hostname: (() => {
      try { return currentUrl ? new URL(currentUrl).hostname : null } catch {
        // silent-catch: a malformed current URL fails closed to an unbound hostname.
        return null
      }
    })(),
    destination: params.destination || null,
    effects: base.effects,
    expiresAt: Date.now() + 10 * 60_000,
    remainingCalls: 1,
    reason: explicit
      ? 'current user explicitly requested this exact destructive effect'
      : 'one-shot browser power confirmation card',
  })
  return resolvePowerDecisionForTool({
    ...params,
    args: { ...params.args, grant_id: grant.id },
    documentKeyHash,
  })
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
    currentUserText,
    trustedRoots,
    taskEnvelope,
    requestPowerConfirmation,
    attachBrowserActionSessionOutput,
  } = ctx
  switch (toolName) {
      case 'eval': {
        const code = String(args.code || '')
        if (!code.trim()) return 'Error: code is required'
        const purpose = String(args.purpose || '').trim()
        if (!purpose) return 'Error: purpose is required'
        const tabId = (args.tab_id as string) || null
        const frameId = String(args.frame_id || '').trim() || null
        const world = args.world === 'main' ? 'main' : 'isolated'
        const maxResultBytes = clampNumber(args.max_result_bytes, 20_000, 1024, 200_000)
        const timeoutMs = clampNumber(args.timeout_ms, 5000, 250, 30_000)
        const objectRef = powerInputHash({ code, frameId, world })
        const decision = await resolvePowerDecisionWithTaskAuthority({
          toolName,
          args,
          controller,
          currentUserText,
          sessionId,
          tabId,
          taskEnvelope,
          purpose,
          objectRef,
          input: { code, frameId, world },
          requestPowerConfirmation,
          fallbackEffects: ['observe'],
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
        try {
          const run = (async () => {
            if (world === 'main') {
              if (frameId && typeof controller.executeJSInFrame === 'function') {
                return controller.executeJSInFrame(tabId, frameId, code, { timeoutMs, signal: abortSignal })
              }
              return controller.executeJS(tabId, code, { timeoutMs, signal: abortSignal })
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
            const evaluated = await sendCdpCommand.call(controller, tabId, 'Runtime.evaluate', {
              expression: code,
              contextId,
              awaitPromise: true,
              returnByValue: true,
            }, { timeoutMs, signal: abortSignal }) as Record<string, unknown>
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
          const confirmation = await detectBrowserPageTransactionConfirmation(controller, tabId)
          // D18-b（第十三轮实锚）：模型反复用 power_eval 直写表单值
          // （`el.value = ...` / innerText 赋值），React/ProseMirror 受控组件
          // 会吞掉这种写入——DOM 有字、框架状态为空，发布校验静默失败且
          // 人点也救不回来。检测到该模式时附劝阻注记（不拦截，Power 合同
          // 语义不变），引导回原生 setter 的 fill/type 工具。
          const formWritePattern = /\.(value|innerText|innerHTML|textContent)\s*=(?!=)/
          const formWriteAdvisory = formWritePattern.test(code)
            ? '检测到对 value/innerText/innerHTML 的直接赋值：React/ProseMirror 受控组件会吞掉这种写入（DOM 显示已填、框架状态仍为空，表单校验静默失败，页面会进入人点也无效的坏状态）。请改用 browser_click/browser_type 的 fill 或 browser_type / browser_type（原生 setter + 真实输入事件）。'
            : undefined
          return attachBrowserActionSessionOutput(JSON.stringify({
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
            ...(formWriteAdvisory ? { formWriteAdvisory } : {}),
            frameId,
            world,
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
          return attachBrowserActionSessionOutput(JSON.stringify({
            ok: false,
            tool: toolName,
            powerMode: true,
            grantId: decision.grantId,
            auditId: audit.id,
            preflightAuditId: preflight.auditId,
            effects: decision.effects,
            errorKind: 'browser_eval_failed',
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

      case 'cdp': {
        const method = String(args.method || '').trim()
        if (!method) return 'Error: method is required'
        const purpose = String(args.purpose || '').trim()
        if (!purpose) return 'Error: purpose is required'
        const tabId = (args.tab_id as string) || null
        const frameId = String(args.frame_id || '').trim() || null
        const params = args.params && typeof args.params === 'object' ? args.params as Record<string, unknown> : {}
        const objectRef = powerInputHash({ method, params, frameId })
        const decision = await resolvePowerDecisionWithTaskAuthority({
          toolName,
          args,
          controller,
          currentUserText,
          sessionId,
          tabId,
          taskEnvelope,
          purpose,
          objectRef,
          input: { method, params, frameId },
          requestPowerConfirmation,
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
        try {
          const result = await sendCdpCommand.call(controller, tabId, method, params, {
            timeoutMs: clampNumber(args.timeout_ms, 15_000, 250, 30_000),
            signal: abortSignal,
          })
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
            currentUserText,
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
          return attachBrowserActionSessionOutput(JSON.stringify({
            ok: false,
            tool: toolName,
            powerMode: true,
            grantId: decision.grantId,
            auditId: audit.id,
            preflightAuditId: preflight.auditId,
            effects: decision.effects,
            errorKind: 'browser_cdp_failed',
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

      case 'resources_forensics': {
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
          if (error instanceof Error && error.name === 'AbortError') throw error
          // silent-catch: failure returns structured error output with recovery advice
          const message = error instanceof Error ? error.message : String(error)
          const advice = classifyBrowserPowerFailure(message)
          const currentUrl = url || activeBrowserToolUrl(controller, tabId)
          return attachBrowserActionSessionOutput(JSON.stringify({
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
            currentUserText,
            tabId,
            nextSuggestedAction: advice.nextSuggestedAction,
          })
        }
      }

      case 'download_advanced': {
        const resolvedDirectory = resolveAuthorizedBrowserDownloadDirectory(args.directory, { currentUserText, trustedRoots })
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
