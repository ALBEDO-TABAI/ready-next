import type { ToolExecutionOutput } from '../agent-control/tools-runtime/tool-result-types'
import { createBrowserStructuredOutput as browserStructuredOutput, stringifyBrowserJsonOrFailure } from './browser-failure-output'
import type { BrowserActToolContext } from './browser-act-shared'
import {
  confirmLivePasswordFill,
  didBrowserActionChange,
  frameViewportOffset,
  invokeTargetFormSubmit,
  logBrowserAct,
  normalizedTargetPoint,
  readBrowserActionDeltaBestEffort,
  readTransientPageNotices,
  retainCompositeTrustedInputSequence,
  sameTargetFingerprint,
  targetFingerprint,
  snapshotBrowserTabs,
  submitResolvedTargetForm,
  trustedPointerExpected,
  waitForActionFollowedTab,
} from './browser-act-shared'
import { existsSync } from 'fs'
import { createHash } from 'node:crypto'
import { captureBrowserActionReceipt } from '../browser-engine/browser-action-receipt'
import { AgentRepository } from '../repositories/agent-repository'
import {
  findRecentBrowserAction,
  rememberBrowserAction,
} from '../agent-control/session/session-continuity'
import { agentBrowserError, isAgentBrowserError } from '../browser-engine/agent-browser-errors'
import { parseTargetId } from '../browser-engine/agent-browser-page-map'
import { browserSnapshotService, parseBrowserSnapshotRef } from '../browser-engine/browser-snapshot-service'
import { gateActOnTarget, type AgentBrowserAction, type AgentBrowserReadBack } from '../browser-engine/agent-browser-act'
import {
  buildBrowserBlockingChallengeProbeJs,
  buildFocusedEditableProbeJs,
  buildBrowserTargetProbeJs,
  throwIfLiveTargetGuardBlocked,
  normalizeBrowserBlockingChallengeProbe,
  probeCoordinateTargetOrThrow,
  callBrowserBackendTarget,
  buildBrowserControlValueJs,
  BROWSER_VALUE_INPUT_TYPES,
} from './browser-probe'
import { browserInputEnvironmentReadiness } from '../browser-engine/browser-input-readiness'
import {
  buildSmartTypeProbeJs,
  resolveCssPoint,
  runGuardedCoordinateClick,
  runGuardedCoordinateType,
  runGuardedTargetType,
  runGuardedSelectorClick,
  runGuardedSelectorType,
  sendKeyStroke,
  settleAfterAction,
  sleepWithAbort,
  throwIfAborted,
  dispatchTrustedPointer,
  dispatchTrustedText,
  pointerPhaseFailure,
  pointerPhaseOutput,
  trustedInputPageDenied,
  TrustedPointerBlockedError,
  waitForReady,
} from './browser-input-actions'
import { buildBrowserEnvironmentSummary } from '../browser-engine/browser-action-receipt'
import {
  describeComposedPointTarget,
  scanClosedShadowHostForClickPoint,
} from './browser-shadow-hit-test'
import {
  captureAgentPageMap,
  currentBrowserPageMapAmbiguity,
  DEFAULT_AGENT_PAGE_MAP_MAX_BYTES,
} from './browser-observe-tools'
import {
  activeBrowserToolUrl,
  activePageLikelyMatchesTarget,
  browserStructuredErrorOutput,
  listSubframesSafe,
  locateActionTargets,
  resolveToolContextMeta,
  uniqueStrings,
} from './browser-tool-shared'

export async function executeBrowserActTarget(
  toolName: string,
  args: Record<string, unknown>,
  ctx: BrowserActToolContext,
): Promise<string | ToolExecutionOutput> {
  const { controller, abortSignal, sessionId, mutationBoundary, attachBrowserToolOutput } = ctx
  switch (toolName) {
      case 'click_target':
      case 'type_target': {
        const targetId = String(args.target_id || args.targetId || '').trim()
        const action = String(typeof args.checked === 'boolean' ? 'choose' : toolName === 'type_target' ? 'fill' : (args.action || 'click')) as AgentBrowserAction
        const value = toolName === 'type_target'
          ? String(args.text || '')
          : args.value === undefined ? undefined : String(args.value)
        const disambiguation = String(args.disambiguation || '').trim()
        const readBack = String(args.read_back || args.readBack || 'delta') as AgentBrowserReadBack
        if (!targetId) return browserStructuredErrorOutput(agentBrowserError('target_not_found', 'target_id is required'))
        if (!['click', 'expand', 'choose', 'fill', 'hover'].includes(action)) {
          return browserStructuredErrorOutput(agentBrowserError('target_not_found', `Unsupported action: ${String(args.action || '')}`))
        }
        let tabId = (args.tab_id as string) || null
        const resolvedRef = await browserSnapshotService.resolveRef(controller, tabId, targetId)
        if (!resolvedRef.ok) {
          return browserStructuredErrorOutput(agentBrowserError(
            resolvedRef.errorCode === 'malformed_ref' || resolvedRef.errorCode === 'wrong_tab'
              ? 'target_not_found'
              : 'stale_page_map',
            resolvedRef.errorCode === 'stale_document'
              ? 'The target belongs to an earlier document and can never be used on the current page. Read browser_snapshot again.'
              : 'The target reference is no longer current. Read browser_snapshot again and choose one of the returned candidates.',
            {
              targetId,
              reason: resolvedRef.errorCode,
              previousTarget: resolvedRef.previousTarget,
              currentDocumentEpoch: resolvedRef.currentDocumentEpoch,
              currentSnapshotRevision: resolvedRef.currentSnapshotRevision,
            },
          ))
        }
        const parsed = parseTargetId(resolvedRef.rawTargetId)
        if (!parsed) return browserStructuredErrorOutput(agentBrowserError('target_not_found', `Malformed internal target id: ${targetId}`))
        const currentGeneration = resolvedRef.snapshotRevision
        const activeTargetId = resolvedRef.target.targetId
        // D10 frame 穿透：targetId 的 frameId 槽位路由回 map 索引该目标的
        // 帧（act 靠帧内元素重枚举定位，跨帧索引不通用）。帧已消失按
        // stale_page_map 收口，提示重读 map。
        const targetFrameKey = parsed.frameId || '0'
        const backendNodeId = /^b(\d+)$/.exec(parsed.node)?.[1]
        let backendFocusAllowPasswordFill = false
        const runInTargetFrame = async (code: string): Promise<unknown> => {
          if (targetFrameKey === '0' && backendNodeId) {
            const id = Number(backendNodeId)
            if (code.includes('__READY_AGENT_TARGET_PROBE__')) {
              return callBrowserBackendTarget(controller, tabId, id, 'probe', {
                roleHint: String(resolvedRef.target.role || ''),
              })
            }
            if (code.includes('__READY_AGENT_TARGET_FOCUS__')) {
              return callBrowserBackendTarget(controller, tabId, id, 'focus', {
                allowPasswordFill: backendFocusAllowPasswordFill,
                roleHint: String(resolvedRef.target.role || ''),
              })
            }
            if (code.includes('__READY_AGENT_TARGET_SELECT_ALL__')) {
              return callBrowserBackendTarget(controller, tabId, id, 'select_all', {
                roleHint: String(resolvedRef.target.role || ''),
              })
            }
            if (code.includes('__READY_AGENT_TARGET_READ__')) {
              return callBrowserBackendTarget(controller, tabId, id, 'read', {
                roleHint: String(resolvedRef.target.role || ''),
              })
            }
          }
          if (targetFrameKey === '0') return controller.executeJS(tabId, code)
          if (typeof controller.executeJSInFrame !== 'function') {
            throw Object.assign(new Error(`Frame ${targetFrameKey} is not reachable on this controller`), { code: 'FRAME_NOT_FOUND' })
          }
          return controller.executeJSInFrame(tabId, targetFrameKey, code)
        }
        const isFrameGoneError = (error: unknown): boolean =>
          Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'FRAME_NOT_FOUND')
        let liveProbe: {
          matchCount?: number
          disabled?: boolean
          target?: unknown
          clickPoint?: {
            x?: unknown
            y?: unknown
            vw?: unknown
            vh?: unknown
            hostShadow?: unknown
            rect?: { left?: unknown; top?: unknown; width?: unknown; height?: unknown } | null
          } | null
        } | null
        try {
          liveProbe = await runInTargetFrame(buildBrowserTargetProbeJs(parsed.node, resolvedRef.frameDocumentToken)) as {
            matchCount?: number
            disabled?: boolean
            target?: unknown
            clickPoint?: {
              x?: unknown
              y?: unknown
              vw?: unknown
              vh?: unknown
              hostShadow?: unknown
              rect?: { left?: unknown; top?: unknown; width?: unknown; height?: unknown } | null
            } | null
          } | null
        } catch (error) {
          if (isFrameGoneError(error)) {
            return browserStructuredErrorOutput(agentBrowserError(
              'stale_page_map',
              `Target ${targetId} belongs to frame ${targetFrameKey}, which is no longer present. Call browser_snapshot again.`,
              { targetId, frameKey: targetFrameKey },
            ))
          }
          throw error
        }
        const stableTarget = resolvedRef.target.unstable !== true
          && /^(?:h[0-9a-z]+|b\d+)$/i.test(parsed.node)
        if (stableTarget && !sameTargetFingerprint(resolvedRef.target, liveProbe?.target)) {
          return browserStructuredErrorOutput(agentBrowserError(
            'stale_page_map',
            `Target ${targetId} still resolves to a node, but its live identity no longer matches the captured target. Read browser_snapshot again.`,
            { targetId, captured: targetFingerprint(resolvedRef.target), live: targetFingerprint(liveProbe?.target) },
          ))
        }
        const gated = gateActOnTarget(
          { targetId, action, value, disambiguation, readBack },
          {
            currentGeneration,
            matchCount: Number(liveProbe?.matchCount || 0),
            candidates: liveProbe?.target ? [liveProbe.target] : [],
            ambiguityGroup: currentBrowserPageMapAmbiguity(controller, tabId, activeTargetId),
            resolvedRef: parsed,
            stableTarget,
            target: liveProbe?.target && typeof liveProbe.target === 'object'
              ? liveProbe.target as {
                  role?: unknown
                  name?: unknown
                  editable?: unknown
                  states?: Record<string, unknown>
                }
              : null,
          },
        )
        if (isAgentBrowserError(gated)) return browserStructuredErrorOutput(gated)
        if (!liveProbe) {
          return browserStructuredErrorOutput(agentBrowserError(
            'target_not_found',
            `Target ${activeTargetId} was not found on the current page.`,
            { targetId: activeTargetId },
          ))
        }
        if (liveProbe?.disabled === true) {
          return browserStructuredErrorOutput(agentBrowserError(
            'target_not_found',
            `Target ${targetId} is disabled.`,
            { targetId, target: liveProbe.target },
          ))
        }
        const targetRecord = liveProbe?.target && typeof liveProbe.target === 'object'
          ? liveProbe.target as {
              role?: string
              name?: string
              value?: string
              inputType?: string
              formAction?: string
              states?: Record<string, unknown>
              box?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
              rendered?: boolean
            }
          : null
        if (targetRecord?.states?.fileInput === true) {
          return browserStructuredErrorOutput(agentBrowserError(
            'script_blocked',
            `Target ${targetId} is a file input. Use browser_upload for file upload.`,
            { targetId, target: liveProbe.target },
          ))
        }
        const controlValue = typeof args.checked === 'boolean' ? args.checked : String(value ?? '')
        if (typeof controlValue === 'boolean' || (action === 'fill' && BROWSER_VALUE_INPUT_TYPES.includes(String(targetRecord?.inputType)))) {
          const denied = await trustedInputPageDenied(controller, tabId)
          if (denied) return denied
          const raw = await mutationBoundary.invokeTransport(() => targetFrameKey === '0' && backendNodeId
            ? callBrowserBackendTarget(controller, tabId, Number(backendNodeId), 'set_value', { value: controlValue, frameDocumentToken: resolvedRef.frameDocumentToken })
            : runInTargetFrame(buildBrowserControlValueJs({ nodeId: parsed.node, frameDocumentToken: resolvedRef.frameDocumentToken, value: controlValue })))
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('input_value_result_invalid')
          const result = raw as Record<string, unknown>
          mutationBoundary.recordMechanicalFact({ delivery: result.delivery === 'delivered' ? 'delivered' : result.delivery === 'unknown' ? 'unknown' : 'not_delivered', ...(result.ok === true ? { effect: 'target_value' } : {}) })
          return browserStructuredOutput(result)
        }
        if (action === 'fill') {
          const usesExactFormSubmit = args.submit === true && Boolean(String(targetRecord?.formAction || '').trim())
          const textReadiness = browserInputEnvironmentReadiness(controller, tabId, 'direct_text')
          const submitReadiness = args.submit === true && !usesExactFormSubmit
            ? browserInputEnvironmentReadiness(controller, tabId, 'trusted_keyboard')
            : null
          const blockedReadiness = !textReadiness.ready
            ? textReadiness
            : submitReadiness && !submitReadiness.ready
              ? submitReadiness
              : null
          if (blockedReadiness) {
            return browserStructuredOutput({
              ok: false,
              errorKind: blockedReadiness.reason === 'foreground_required' ? 'foreground_required' : 'browser_surface_required',
              reason: blockedReadiness.reason,
              targetId,
              writesPerformed: 0,
              readiness: blockedReadiness,
            })
          }
        }
        const beforeTabs = snapshotBrowserTabs(controller)
        const before = readBack === 'none' ? null : await readBrowserActionDeltaBestEffort(controller, tabId, 'before')
        let actionResult: unknown
        const point = await normalizedTargetPoint(
          controller,
          tabId,
          targetFrameKey,
          targetRecord?.box,
          { allowUnpresented: action === 'fill' },
        )
        if (!point) {
          return browserStructuredErrorOutput(agentBrowserError(
            'target_not_found',
            `Target ${activeTargetId} has no visible hit point. Refresh browser_snapshot after bringing it into view.`,
            { targetId: activeTargetId, frameKey: targetFrameKey },
          ))
        }
        const presentedPoint = point.x !== null && point.y !== null
          ? { x: point.x, y: point.y }
          : null
        if (action !== 'fill' && !presentedPoint) {
          return browserStructuredOutput({
            ok: false,
            errorKind: 'browser_surface_required',
            reason: 'host_not_presented',
            targetId: activeTargetId,
            writesPerformed: 0,
          })
        }
        const boxWidth = Number(targetRecord?.box?.width || 0)
        const boxHeight = Number(targetRecord?.box?.height || 0)
        const trustedClickPoint = {
          x: point.cssX,
          y: point.cssY,
          vw: point.width,
          vh: point.height,
          hostShadow: liveProbe.clickPoint?.hostShadow || null,
          rect: {
            left: point.cssX - boxWidth / 2,
            top: point.cssY - boxHeight / 2,
            width: boxWidth,
            height: boxHeight,
          },
        }
        if (action === 'fill') {
          const passwordTarget = String(targetRecord?.inputType || '').toLowerCase() === 'password'
            || targetRecord?.states?.password === true
          const usesExactFormSubmit = args.submit === true && Boolean(String(targetRecord?.formAction || '').trim())
          const passwordConfirmed = !passwordTarget || await confirmLivePasswordFill(
            ctx,
            tabId,
            targetId,
            String(value || ''),
          )
          if (!passwordConfirmed) {
            return browserStructuredOutput({
              ok: false,
              errorKind: 'credential_confirmation_required',
              liveTargetKind: 'password',
              targetId,
            })
          }
          backendFocusAllowPasswordFill = passwordConfirmed
          const typed = await runGuardedTargetType(controller, tabId, parsed.node, resolvedRef.frameDocumentToken, point, String(value || ''), {
            clearBefore: true,
            pressEnter: args.submit === true && !usesExactFormSubmit,
            useShiftEnter: false,
            allowPasswordFill: passwordConfirmed,
          }, runInTargetFrame, abortSignal)
          const textVerified = typed.typed
            && typed.textDelivery === 'delivered'
            && (passwordTarget || typed.typedInto?.textMatchesExpected === true)
          const formSubmit = usesExactFormSubmit && textVerified
            ? await invokeTargetFormSubmit(controller, mutationBoundary, tabId, {
                nodeId: parsed.node,
                frameId: targetFrameKey,
                frameDocumentToken: resolvedRef.frameDocumentToken,
                ...(backendNodeId ? { backendNodeId: Number(backendNodeId) } : {}),
                roleHint: String(targetRecord?.role || ''),
              })
            : null
          if (formSubmit) {
            typed.submitDelivery = formSubmit.delivery === 'delivered'
              ? 'delivered'
              : formSubmit.delivery === 'not_delivered'
                ? 'not_delivered'
                : 'unknown'
          }
          const submitSucceeded = args.submit !== true || typed.submitDelivery === 'delivered'
          const fillSucceeded = typed.typed
            && submitSucceeded
            && (!usesExactFormSubmit || (textVerified && formSubmit?.ok === true))
          actionResult = {
            ok: fillSucceeded,
            errorCode: fillSucceeded
              ? null
              : typed.typed
                ? String(
                    typed.submitError
                    || formSubmit?.reason
                    || (args.submit === true ? `submit_${typed.submitDelivery}` : 'text_delivery_unverified'),
                  )
                : typed.skipReason || 'target_not_fillable',
            mayHaveCommitted: typed.typed && typed.textDelivery !== 'not_delivered',
            trustedInput: true,
            typed,
            ...(formSubmit ? { formSubmit } : {}),
          }
        } else if (action === 'hover') {
          const blocked = await dispatchTrustedPointer(controller, tabId, {
            type: 'mouseMoved',
            x: point.cssX,
            y: point.cssY,
            button: 'none',
            buttons: 0,
          }, trustedPointerExpected(ctx, tabId))
          if (blocked) return blocked
          actionResult = { ok: true, trustedInput: true, hoverPoint: trustedClickPoint }
        } else if (action === 'choose') {
          const releaseInputSequence = await retainCompositeTrustedInputSequence(controller, tabId)
          try {
            await runGuardedCoordinateClick(controller, tabId, presentedPoint!.x, presentedPoint!.y, abortSignal)
            await dispatchTrustedText(controller, tabId, String(value || ''))
            await sendKeyStroke(controller, tabId, 'Enter')
          } finally {
            releaseInputSequence()
          }
          actionResult = { ok: true, trustedInput: true, value, clickPoint: trustedClickPoint }
        } else {
          const clicked = await runGuardedCoordinateClick(controller, tabId, presentedPoint!.x, presentedPoint!.y, abortSignal)
          actionResult = {
            ok: true,
            trustedInput: true,
            deliveryObserved: clicked.deliveryObserved,
            pointTarget: clicked.pointTarget,
            clickPoint: trustedClickPoint,
          }
        }
        await settleAfterAction(controller, tabId, abortSignal)
        let followedTab = await waitForActionFollowedTab(controller, tabId, beforeTabs, abortSignal)
        if (followedTab) mutationBoundary.recordMechanicalFact({ effect: 'popup', postActionTabId: followedTab.tabId })
        const actionFailed = typeof actionResult === 'object' && actionResult !== null && (actionResult as { ok?: unknown }).ok === false
        const failureKind = actionFailed
          ? String((actionResult as { errorCode?: unknown }).errorCode || 'action_failed')
          : null
        // 变更信号统一用前后 delta（url/title/bodyText）比较——旧实现在
        // readBack='map' 时拿动作前 delta 对比整张 map，形状必不同，changed
        // 恒为 true 是假信号（真机第十二轮实锚：发布按钮点了无反应，回读
        // 却报 changed:true，模型因此不升级）。
        let afterDelta = readBack === 'none' ? null : await readBrowserActionDeltaBestEffort(controller, tabId, 'after')
        let changed = didBrowserActionChange(before, afterDelta)
        // Closed-shadow hosts can expose a larger host rect than their actual
        // internal button. If the first trusted hit has no observable effect,
        // scan the composed tree once and retry another trusted coordinate.
        const rawClickPoint = !actionFailed && action === 'click' && actionResult && typeof actionResult === 'object'
          ? (actionResult as { clickPoint?: { x?: unknown; y?: unknown; vw?: unknown; vh?: unknown; hostShadow?: unknown } | null }).clickPoint
          : null
        const cpx = Number(rawClickPoint?.x)
        const cpy = Number(rawClickPoint?.y)
        const cpw = Number(rawClickPoint?.vw)
        const cph = Number(rawClickPoint?.vh)
        const clickPointValid = Number.isFinite(cpx) && Number.isFinite(cpy)
          && cpw > 0 && cph > 0 && cpx >= 0 && cpx <= cpw && cpy >= 0 && cpy <= cph
        // One public click owns exactly one physical click dispatch. A missing
        // effect is returned as unknown for a fresh observation; it is never a
        // license to click again inside the same tool call.
        if (action === 'click' && !actionFailed) {
          logBrowserAct(`act click outcome target=${targetId} changed=${changed} hostShadow=${String(rawClickPoint?.hostShadow ?? 'n/a')}${clickPointValid ? '' : ' clickPoint=invalid'}`)
        }
        const after = readBack === 'map'
          ? await captureAgentPageMap(controller, tabId, DEFAULT_AGENT_PAGE_MAP_MAX_BYTES)
          : afterDelta
        const actionMayHaveCommitted = actionFailed
          && actionResult && typeof actionResult === 'object'
          && (actionResult as { mayHaveCommitted?: unknown }).mayHaveCommitted === true
        const payload = {
          ok: !actionFailed,
          targetId: activeTargetId,
          originalTargetId: activeTargetId === targetId ? undefined : targetId,
          action,
          disambiguation: disambiguation || null,
          readBack,
          before,
          result: actionResult,
          after,
          changed,
          followedTab,
          failureKind,
          mayHaveCommitted: actionMayHaveCommitted,
          nextSuggestedAction: actionMayHaveCommitted
            ? 'read map again before any retry because part of the action may already be visible'
            : followedTab ? `read map again on tab ${followedTab.tabId}` : 'read map again',
        }
        const confirmation = null
        return attachBrowserToolOutput(
          actionFailed ? browserStructuredOutput(payload) : JSON.stringify(payload, null, 2),
          {
            toolName,
            args,
            controller,
            sessionId,
            tabId,
            followedTab,
            confirmation,
            nextSuggestedAction: confirmation
              ? 'finish with transaction proof'
              : (followedTab ? `read map again on tab ${followedTab.tabId}` : 'read map again'),
          },
        )
      }

    default:
      return `Unknown browser tool: ${toolName}`
  }
}
