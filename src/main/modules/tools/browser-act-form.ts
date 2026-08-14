import type { ToolExecutionOutput } from '../agent-control/tools-runtime/tool-result-types'
import { createBrowserStructuredOutput as browserStructuredOutput, stringifyBrowserJsonOrFailure } from './browser-failure-output'
import type { BrowserController } from '../browser-engine/ipc-handler'
import type { BrowserActToolContext } from './browser-act-shared'
import {
  browserActionResultSucceeded,
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

export async function runBrowserFillFormSequence(
  fields: unknown[],
  options: { tabId?: unknown; submit: boolean },
  invoke: (operation: string, args: Record<string, unknown>) => Promise<string | ToolExecutionOutput>,
): Promise<Record<string, unknown>> {
  const results: Array<{ index: number; ok: boolean; result: string | ToolExecutionOutput }> = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (!field || typeof field !== 'object' || Array.isArray(field)) {
      return {
        ok: false,
        errorKind: 'invalid_form_field',
        failedIndex: index,
        fields: results,
        submitted: false,
      }
    }
    const item = field as Record<string, unknown>
    const operation = typeof item.target_id === 'string'
      ? 'type_target'
      : typeof item.selector === 'string'
        ? 'type_selector'
        : 'type_smart'
    const result = await invoke(operation, {
      ...item,
      text: String(item.value ?? ''),
      target: item.label,
      tab_id: options.tabId,
      clear_first: true,
    })
    const ok = browserActionResultSucceeded(result)
    results.push({ index, ok, result })
    if (!ok) {
      return {
        ok: false,
        errorKind: 'form_field_failed',
        failedIndex: index,
        fields: results,
        submitted: false,
      }
    }
  }
  if (!options.submit) return { ok: true, fields: results, submitted: false }
  const submitResult = await invoke('press_key', { key: 'Enter', tab_id: options.tabId })
  const submitted = browserActionResultSucceeded(submitResult)
  return {
    ok: submitted,
    ...(!submitted ? { errorKind: 'form_submit_failed' } : {}),
    fields: results,
    submitResult,
    submitted,
  }
}

async function runTrustedSmartType(
  controller: BrowserController,
  tabId: string | null,
  options: {
    target: string
    text: string
    clearFirst: boolean
    submit: boolean
    allowPasswordFill: boolean
    confirmPasswordFill?: (target: string) => Promise<boolean>
  },
  signal?: AbortSignal,
): Promise<{ ok: boolean; output: string }> {
  const probe = await controller.executeJS(tabId, buildSmartTypeProbeJs(options))
  throwIfLiveTargetGuardBlocked(probe, { target: options.target })
  if (!probe || typeof probe !== 'object' || (probe as { ok?: unknown }).ok !== true) {
    return { ok: false, output: typeof probe === 'string' ? probe : 'Smart input target was not found.' }
  }
  const located = probe as {
    x?: unknown
    y?: unknown
    width?: unknown
    height?: unknown
    target?: unknown
    score?: unknown
    inputType?: unknown
  }
  const width = Number(located.width)
  const height = Number(located.height)
  if (!(width > 0 && height > 0)) return { ok: false, output: 'Smart input target has no visible viewport.' }
  let allowPasswordFill = options.allowPasswordFill
  if (String(located.inputType || '').toLowerCase() === 'password' && !allowPasswordFill) {
    allowPasswordFill = await options.confirmPasswordFill?.(String(located.target || options.target)) === true
    if (!allowPasswordFill) {
      return {
        ok: false,
        output: JSON.stringify({
          ok: false,
          errorKind: 'credential_confirmation_required',
          liveTargetKind: 'password',
        }),
      }
    }
  }
  const typed = await runGuardedCoordinateType(
    controller,
    tabId,
    (Number(located.x) / width) * 1000,
    (Number(located.y) / height) * 1000,
    options.text,
    {
      clearBefore: options.clearFirst,
      pressEnter: options.submit,
      useShiftEnter: false,
      allowPasswordFill,
    },
    signal,
  )
  return {
    ok: typed.typed,
    output: JSON.stringify({
      ok: typed.typed,
      trustedInput: true,
      target: String(located.target || options.target),
      score: Number(located.score || 0),
      ...typed,
    }),
  }
}

export async function executeBrowserActForm(
  toolName: string,
  args: Record<string, unknown>,
  ctx: BrowserActToolContext,
): Promise<string | ToolExecutionOutput> {
  const { controller, abortSignal, sessionId, mutationBoundary, attachBrowserToolOutput } = ctx
  switch (toolName) {
      case 'search': {
        const query = String(args.query || '')
        if (!query.normalize('NFC').replace(/\r\n?/g, '\n').trim()) return 'Error: query is required'
        const searchTabId = typeof args.tab_id === 'string' && args.tab_id.trim()
          ? args.tab_id.trim()
          : controller.getActiveTab?.()?.id || null
        if (!searchTabId) return browserStructuredOutput({ ok: false, errorKind: 'search_live_tab_required' })

        const state = normalizeBrowserBlockingChallengeProbe(
          await controller.executeJS(searchTabId, buildBrowserBlockingChallengeProbeJs()),
        )
        if (state.blocked) {
          return browserStructuredOutput({
            ok: false,
            errorKind: 'challenge_required',
            waitingHuman: true,
            evidence: [`visible_blocker:${state.blockerCount}`, ...state.matchedKinds.map((kind) => `challenge:${kind}`)],
          })
        }
        if (state.pageError || state.emptyShell) {
          return browserStructuredOutput({
            ok: false,
            errorKind: state.pageError ? 'page_error' : 'page_content_empty',
          })
        }

        type SearchTarget = {
          targetId?: string
          role?: string
          name?: string
          states?: Record<string, unknown>
          box?: { width?: number; height?: number }
          fingerprint?: { formAction?: string }
          rendered?: boolean
          visible?: boolean
          enabled?: boolean
          editable?: boolean
        }
        const requestedRefs = {
          input: typeof args.input_target_id === 'string' ? args.input_target_id.trim() : '',
          submit: typeof args.submit_target_id === 'string' ? args.submit_target_id.trim() : '',
          result: typeof args.result_target_id === 'string' ? args.result_target_id.trim() : '',
          empty: typeof args.empty_target_id === 'string' ? args.empty_target_id.trim() : '',
        }
        for (const kind of ['input', 'submit', 'result', 'empty'] as const) {
          const ref = requestedRefs[kind]
          if (!ref) continue
          const resolved = await browserSnapshotService.resolveRef(controller, searchTabId, ref)
          if (!resolved.ok) {
            return browserStructuredOutput({
              ok: false,
              errorKind: 'stale_page_map',
              targetKind: kind,
              targetId: ref,
              reason: resolved.errorCode,
              writesPerformed: 0,
            })
          }
        }

        const before = await captureAgentPageMap(controller, searchTabId, DEFAULT_AGENT_PAGE_MAP_MAX_BYTES, { force: true })
        const targets = Array.isArray((before.pageMap as { targets?: unknown } | null)?.targets)
          ? (before.pageMap as { targets: SearchTarget[] }).targets
          : []
        for (const kind of ['input', 'submit', 'result', 'empty'] as const) {
          const ref = requestedRefs[kind]
          if (!ref) continue
          const oldRef = parseBrowserSnapshotRef(ref)
          const oldTarget = oldRef ? parseTargetId(oldRef.rawTargetId) : null
          const currentRef = targets.find((target) => {
            const freshRef = typeof target.targetId === 'string' ? parseBrowserSnapshotRef(target.targetId) : null
            const freshTarget = freshRef ? parseTargetId(freshRef.rawTargetId) : null
            return Boolean(oldRef && oldTarget && freshRef && freshTarget
              && freshRef.tabId === oldRef.tabId
              && freshRef.physicalTargetToken === oldRef.physicalTargetToken
              && freshRef.frameId === oldRef.frameId
              && freshRef.frameDocumentToken === oldRef.frameDocumentToken
              && freshTarget.frameId === oldTarget.frameId
              && freshTarget.node === oldTarget.node)
          })?.targetId || ''
          if (!currentRef) {
            return browserStructuredOutput({
              ok: false,
              errorKind: 'stale_page_map',
              targetKind: kind,
              targetId: ref,
              reason: 'target_missing_after_refresh',
              writesPerformed: 0,
            })
          }
          requestedRefs[kind] = currentRef
        }

        const structuralInputs = targets.filter((target) => {
          const role = String(target.role || '').toLowerCase()
          const enabled = target.enabled !== false && target.states?.disabled !== true
          const rendered = target.rendered !== false
            && (!target.box || (Number(target.box.width || 0) > 0 && Number(target.box.height || 0) > 0))
          return enabled && rendered && target.editable !== false && ['searchbox', 'textbox', 'combobox'].includes(role)
        })
        const explicitInput = requestedRefs.input
          ? targets.find((target) => target.targetId === requestedRefs.input) || { targetId: requestedRefs.input }
          : null
        const preferredInputs = structuralInputs.filter((target) => String(target.role || '').toLowerCase() === 'searchbox')
        const candidates = preferredInputs.length > 0 ? preferredInputs : structuralInputs
        const inputTarget = explicitInput || (candidates.length === 1 ? candidates[0] : null)
        if (!inputTarget?.targetId) {
          return browserStructuredOutput({
            ok: false,
            errorKind: candidates.length === 0 ? 'search_input_target_missing' : 'search_input_target_ambiguous',
            query,
            tabId: searchTabId,
            pageIdentity: before.pageIdentity,
            count: candidates.length,
            matches: candidates.slice(0, 12),
            writesPerformed: 0,
          })
        }

        const explicitSubmitTarget = requestedRefs.submit
          ? targets.find((target) => target.targetId === requestedRefs.submit) || null
          : null
        const structuralSubmitAvailable = requestedRefs.submit
          ? Boolean(String(explicitSubmitTarget?.fingerprint?.formAction || '').trim())
          : Boolean(String(inputTarget.fingerprint?.formAction || '').trim())
        const fillReadiness = browserInputEnvironmentReadiness(controller, searchTabId, 'direct_text')
        if (!fillReadiness.ready) {
          return browserStructuredOutput({
            ok: false,
            errorKind: fillReadiness.reason === 'foreground_required' ? 'foreground_required' : 'browser_surface_required',
            reason: fillReadiness.reason,
            phase: 'not_submitted',
            submitted: false,
            writesPerformed: 0,
            readiness: fillReadiness,
          })
        }
        if (!structuralSubmitAvailable) {
          const submitReadiness = browserInputEnvironmentReadiness(
            controller,
            searchTabId,
            requestedRefs.submit ? 'trusted_pointer' : 'trusted_keyboard',
          )
          if (!submitReadiness.ready) {
            return browserStructuredOutput({
              ok: false,
              errorKind: submitReadiness.reason === 'foreground_required' ? 'foreground_required' : 'browser_surface_required',
              reason: submitReadiness.reason,
              phase: 'not_submitted',
              submitted: false,
              writesPerformed: 0,
              readiness: submitReadiness,
            })
          }
        }

        const fillStep = await mutationBoundary.runSearchStep('fill', () => ctx.invokeNested!('type_target', {
          target_id: inputTarget.targetId,
          text: query,
          clear_first: true,
          submit: false,
          tab_id: searchTabId,
        }))
        const outputData = (value: string | ToolExecutionOutput): Record<string, unknown> | null => {
          const text = typeof value === 'string' ? value : value.text
          try {
            const parsed = JSON.parse(text) as unknown
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
          } catch {
            // silent-catch: non-JSON tool output cannot prove a successful fill.
            return null
          }
        }
        const fillData = outputData(fillStep.value)
        const fillResult = fillData?.result && typeof fillData.result === 'object' && !Array.isArray(fillData.result)
          ? fillData.result as Record<string, unknown>
          : null
        const typed = fillResult?.typed && typeof fillResult.typed === 'object' && !Array.isArray(fillResult.typed)
          ? fillResult.typed as Record<string, unknown>
          : null
        const typedInto = typed?.typedInto && typeof typed.typedInto === 'object' && !Array.isArray(typed.typedInto)
          ? typed.typedInto as Record<string, unknown>
          : null
        const fillVerified = Boolean(
          fillStep.settlement
          && fillData?.ok !== false
          && typed?.typed === true
          && typed?.textDelivery === 'delivered'
          && typedInto?.textMatchesExpected === true,
        )
        if (!fillVerified) {
          const actionIds = mutationBoundary.searchActionIds()
          return browserStructuredOutput({
            ok: false,
            errorKind: 'search_fill_readback_mismatch',
            phase: 'not_submitted',
            submitted: false,
            delivery: 'not_delivered',
            effectObserved: false,
            needsObservation: false,
            searchActionId: actionIds.searchActionId,
            fillActionId: actionIds.fillActionId,
            submitActionId: null,
            fill: fillData,
          })
        }

        let submitTargetId = requestedRefs.submit
        if (structuralSubmitAvailable || submitTargetId) {
          const refreshed = await captureAgentPageMap(controller, searchTabId, DEFAULT_AGENT_PAGE_MAP_MAX_BYTES, { force: true })
          const refreshedTargets = Array.isArray((refreshed.pageMap as { targets?: unknown } | null)?.targets)
            ? (refreshed.pageMap as { targets: SearchTarget[] }).targets
            : []
          const refreshTargetId = (oldTargetId: string): string => {
            const oldRef = parseBrowserSnapshotRef(oldTargetId)
            return refreshedTargets.find((target) => {
              const freshRef = typeof target.targetId === 'string' ? parseBrowserSnapshotRef(target.targetId) : null
              const oldRawTarget = oldRef ? parseTargetId(oldRef.rawTargetId) : null
              const freshRawTarget = freshRef ? parseTargetId(freshRef.rawTargetId) : null
              return Boolean(oldRef && freshRef
                && oldRawTarget && freshRawTarget
                && freshRef.tabId === oldRef.tabId
                && freshRef.physicalTargetToken === oldRef.physicalTargetToken
                && freshRef.frameId === oldRef.frameId
                && freshRef.frameDocumentToken === oldRef.frameDocumentToken
                && freshRawTarget.frameId === oldRawTarget.frameId
                && freshRawTarget.node === oldRawTarget.node)
            })?.targetId || ''
          }
          submitTargetId = refreshTargetId(
            structuralSubmitAvailable && !requestedRefs.submit
              ? inputTarget.targetId
              : requestedRefs.submit,
          )
          if (!submitTargetId) {
            const actionIds = mutationBoundary.searchActionIds()
            return browserStructuredOutput({
              ok: false,
              errorKind: 'search_submit_target_stale_after_fill',
              phase: 'not_submitted',
              submitted: false,
              searchActionId: actionIds.searchActionId,
              fillActionId: actionIds.fillActionId,
              submitActionId: null,
            })
          }
        }
        const submitStep = await mutationBoundary.runSearchStep('submit', async () => {
          if (structuralSubmitAvailable && submitTargetId) {
            const result = await submitResolvedTargetForm(controller, mutationBoundary, searchTabId, submitTargetId)
            await settleAfterAction(controller, searchTabId, abortSignal)
            return browserStructuredOutput(result)
          }
          return ctx.invokeNested!(
            submitTargetId ? 'click_target' : 'press_key',
            submitTargetId
              ? { target_id: submitTargetId, action: 'click', tab_id: searchTabId }
              : { key: 'Enter', tab_id: searchTabId },
          )
        })
        const submitData = outputData(submitStep.value)
        const submitOutcome = submitStep.settlement?.outcome || null
        const submitDelivery = submitOutcome?.delivery || 'unknown'
        const effectObserved = submitOutcome?.effect === 'observed'
        const submitted = submitDelivery === 'delivered'
        if (submitted) rememberBrowserAction(sessionId, 'search', `${searchTabId}:${query}`, {
          messageVisibilityEpoch: ctx.messageVisibilityEpoch,
        })
        const actionIds = mutationBoundary.searchActionIds()
        return browserStructuredOutput({
          ok: submitted,
          query,
          tabId: searchTabId,
          searchTarget: { targetId: inputTarget.targetId, role: inputTarget.role, name: inputTarget.name },
          submitTargetId: submitTargetId || null,
          expectedEffectTargets: {
            resultTargetId: requestedRefs.result || null,
            emptyTargetId: requestedRefs.empty || null,
          },
          phase: effectObserved ? 'effect_observed' : submitted ? 'submitted_needs_observation' : 'not_submitted',
          submitted,
          delivery: submitDelivery,
          effectObserved,
          needsObservation: submitted && !effectObserved,
          mayHaveCommitted: !submitted && submitDelivery === 'unknown',
          searchActionId: actionIds.searchActionId,
          fillActionId: actionIds.fillActionId,
          submitActionId: actionIds.submitActionId,
          fill: fillData,
          submit: submitData,
        })
      }

      case 'fill_form': {
        const fields = Array.isArray(args.fields) ? args.fields : []
        if (fields.length === 0) return 'Error: fields is required'
        const outcome = await runBrowserFillFormSequence(
          fields,
          { tabId: args.tab_id, submit: args.submit === true },
          (operation, input) => ctx.invokeNested!(operation, input),
        )
        return browserStructuredOutput(outcome)
      }

      case 'select': {
        if (typeof args.target_id === 'string') {
          return ctx.invokeNested!('click_target', {
            ...args,
            action: 'choose',
            value: args.value ?? (Array.isArray(args.values) ? args.values[0] : undefined),
          })
        }
        const selector = String(args.selector || '').trim()
        const values = (Array.isArray(args.values) ? args.values.map(String) : [String(args.value || '')])
          .map((value) => value.trim())
          .filter(Boolean)
        if (!selector || values.length === 0) return 'Error: selector and value are required'
        const tabId = (args.tab_id as string) || null
        const probe = await controller.executeJS(tabId, `(() => {
          const node = document.querySelector(${JSON.stringify(selector)})
          if (!(node instanceof HTMLSelectElement)) return { ok: false, error: 'select_not_found' }
          const rect = node.getBoundingClientRect()
          return {
            ok: rect.width > 0 && rect.height > 0,
            rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
            viewport: { width: innerWidth, height: innerHeight },
            multiple: node.multiple === true,
            options: Array.from(node.options).map((option, index) => ({
              index,
              value: String(option.value || ''),
              text: String(option.text || '').trim(),
              disabled: option.disabled === true,
            })),
          }
        })()`)
        const select = probe as {
          ok?: boolean
          rect?: { x?: number; y?: number; width?: number; height?: number }
          viewport?: { width?: number; height?: number }
          multiple?: boolean
          options?: Array<{ index?: number; value?: string; text?: string; disabled?: boolean }>
        } | null
        const viewportWidth = Number(select?.viewport?.width)
        const viewportHeight = Number(select?.viewport?.height)
        const rect = select?.rect
        const options = Array.isArray(select?.options) ? select.options : []
        if (!select?.ok || !rect || !(viewportWidth > 0 && viewportHeight > 0)) {
          return browserStructuredOutput({ ok: false, errorKind: 'select_not_found', selector })
        }
        const matchedIndexes = values.map((wanted) => {
          const matches = options.filter((option) => !option.disabled && (option.value === wanted || option.text === wanted))
          return matches.length === 1 ? Number(matches[0].index) : -1
        })
        if (matchedIndexes.some((index) => index < 0)) {
          return browserStructuredOutput({
            ok: false,
            errorKind: 'select_option_not_unique',
            requested: values,
            options: options.slice(0, 80),
          })
        }
        const centerX = Number(rect.x) + Number(rect.width) / 2
        const centerY = Number(rect.y) + Number(rect.height) / 2
        const releaseInputSequence = await retainCompositeTrustedInputSequence(controller, tabId)
        try {
          await runGuardedCoordinateClick(
            controller,
            tabId,
            (centerX / viewportWidth) * 999,
            (centerY / viewportHeight) * 999,
            abortSignal,
          )
          if (select.multiple === true) {
            for (const index of [...matchedIndexes].sort((a, b) => a - b)) {
              await sendKeyStroke(controller, tabId, 'Home')
              for (let cursor = 0; cursor < index; cursor += 1) {
                await sendKeyStroke(controller, tabId, 'ArrowDown')
              }
              await sendKeyStroke(controller, tabId, 'Space', ['control'])
            }
          } else {
            await sendKeyStroke(controller, tabId, 'Home')
            for (let cursor = 0; cursor < matchedIndexes[0]; cursor += 1) {
              await sendKeyStroke(controller, tabId, 'ArrowDown')
            }
            await sendKeyStroke(controller, tabId, 'Enter')
          }
        } finally {
          releaseInputSequence()
        }
        return browserStructuredOutput({ ok: true, values, trustedInput: true })
      }

      case 'type_selector': {
        const selector = args.selector as string
        const text = args.text as string
        if (!selector || text === undefined) return 'Error: selector and text are required'
        const clearFirst = args.clear_first !== false // default true
        let tabId = (args.tab_id as string) || null
        // An opaque selector can resolve to a password or file input. Check
        // the live structural input type before sending any text.
        const inputKind = await controller.executeJS(tabId, `(() => {
          const node = document.querySelector(${JSON.stringify(selector)})
          return node instanceof HTMLInputElement
            ? { inputType: String(node.type || 'text').toLowerCase() }
            : { inputType: '' }
        })()`).catch(() => null) as { inputType?: unknown } | null
        const liveInputType = String(inputKind?.inputType || '').toLowerCase()
        if (liveInputType === 'file') {
          return browserStructuredOutput({ ok: false, errorKind: 'file_input_requires_upload', liveTargetKind: 'file' })
        }
        const passwordConfirmed = liveInputType !== 'password'
          || await confirmLivePasswordFill(ctx, tabId, `selector:${selector}`, text)
        if (!passwordConfirmed) {
          return browserStructuredOutput({ ok: false, errorKind: 'credential_confirmation_required', liveTargetKind: 'password' })
        }
        const typeBeforeUrl = activeBrowserToolUrl(controller, tabId)
        const result = await runGuardedSelectorType(controller, tabId, selector, text, {
          clearFirst,
          allowPasswordFill: passwordConfirmed,
          submit: args.submit === true,
        }, abortSignal)
        if (result.startsWith('Error:')) {
          return browserStructuredOutput({
            ok: false,
            errorKind: /not found|hidden|no visible viewport/i.test(result) ? 'target_not_found' : 'browser_operation_failed',
            message: result.slice('Error:'.length).trim(),
            nextSuggestedAction: 'call browser_snapshot and retry with a current target reference',
          })
        }
        // P1-E5 — change receipt after typing (focus/toast/validation signal).
        const typeReceipt = await captureBrowserActionReceipt(controller, tabId, typeBeforeUrl)
        return attachBrowserToolOutput(result, {
          toolName,
          args,
          controller,
          sessionId,
          tabId,
          changeReceipt: typeReceipt,
          nextSuggestedAction: 'read map again',
        })
      }

      case 'type_smart': {
        const target = String(args.target || 'input').trim()
        const text = String(args.text || '')
        if (!target || text === undefined) return 'Error: target and text are required'
        const clearFirst = args.clear_first !== false
        const submit = args.submit === true
        const tabId = (args.tab_id as string) || null
        const smartType = await runTrustedSmartType(controller, tabId, {
          target,
          text,
          clearFirst,
          submit,
          allowPasswordFill: false,
          confirmPasswordFill: (resolvedTarget) => confirmLivePasswordFill(ctx, tabId, `smart:${resolvedTarget}`, text),
        }, abortSignal)
        const result = smartType.output
        const confirmation = null
        return attachBrowserToolOutput(result, {
          toolName,
          args,
          controller,
          sessionId,
          tabId,
          confirmation,
          nextSuggestedAction: confirmation ? 'finish with transaction proof' : 'read map again',
        })
      }

      case 'type_compose': {
        const text = String(args.text || '')
        if (!text) return 'Error: text is required'
        const target = String(args.target || '')
        const clearFirst = args.clear_first !== false
        const submit = args.submit !== false
        const tabId = (args.tab_id as string) || null
        const composed = await runTrustedSmartType(controller, tabId, {
          target,
          text,
          clearFirst,
          submit,
          allowPasswordFill: false,
          confirmPasswordFill: (resolvedTarget) => confirmLivePasswordFill(ctx, tabId, `smart:${resolvedTarget}`, text),
        }, abortSignal)
        const result = composed.output
        const confirmation = null
        return attachBrowserToolOutput(result, {
          toolName,
          args,
          controller,
          sessionId,
          tabId,
          confirmation,
          nextSuggestedAction: confirmation ? 'finish with transaction proof' : 'read map again',
        })
      }

      case 'type_coordinate': {
        const x = Number(args.x)
        const y = Number(args.y)
        const text = String(args.text || '')
        if (!Number.isFinite(x) || !Number.isFinite(y)) return 'Error: x and y are required numbers'
        if (!text) return 'Error: text is required'
        let tabId = (args.tab_id as string) || null
        const pressEnter = args.submit === true || args.press_enter === true
        const clearBeforeTyping = args.clear_first !== false && args.clear_before_typing !== false
        const useShiftEnter = args.use_shift_enter_for_newline === true
        // Coordinate typing requires a structurally verified destination;
        // file and password inputs follow their explicit typed contracts.
        const probePoint = await resolveCssPoint(controller, tabId, x, y)
        const liveTarget = await probeCoordinateTargetOrThrow(
          controller,
          tabId,
          probePoint,
          { x, y, action: 'type' },
        ) as { password?: unknown; fileInput?: unknown } | null
        if (liveTarget?.fileInput === true) {
          return browserStructuredOutput({ ok: false, errorKind: 'file_input_requires_upload', liveTargetKind: 'file' })
        }
        const passwordConfirmed = liveTarget?.password !== true
          || await confirmLivePasswordFill(ctx, tabId, `coordinate:${probePoint.cssX}:${probePoint.cssY}`, text)
        if (!passwordConfirmed) {
          return browserStructuredOutput({ ok: false, errorKind: 'credential_confirmation_required', liveTargetKind: 'password' })
        }
        const point = await runGuardedCoordinateType(controller, tabId, x, y, text, {
          clearBefore: clearBeforeTyping,
          pressEnter,
          useShiftEnter,
          allowPasswordFill: passwordConfirmed,
        }, abortSignal)
        // D18-c（真机第十四轮实锚）：聚焦点击落在死区时焦点滞留上一控件，
        // 正文全文灌进标题框、模型盲试 4 分钟。typed=false 响亮失败；成功
        // 也回读 typedInto（打进了哪个框、框里现在是什么）供同轮自纠。
        logBrowserAct(`type_at resolved input=(${x},${y}) normalized=(${point.nx},${point.ny}) css=(${Math.round(point.cssX)},${Math.round(point.cssY)}) typed=${point.typed} focus=${JSON.stringify(point.focusTarget?.label ?? point.focusTarget?.kind ?? null)} typedInto=${JSON.stringify(point.typedInto?.label ?? null)}`)
        if (!point.typed) {
          // D18-d：三类机械拒因分档回话——焦点不可编辑 / 字段容量装不下 /
          // 单行框收多段文本（后两类=第十六轮"正文灌标题"循环的硬闸）。
          const refusal = point.skipReason === 'text_exceeds_field_capacity'
            ? {
              errorKind: 'type_field_capacity_exceeded',
              message: `焦点字段「${point.focusTarget?.label || point.focusTarget?.tag || '未知'}」上限 ${point.focusTarget?.maxLength} 字，本次文本 ${text.length} 字——这是标题/短字段，不是正文编辑器。已拒绝打字。请改用 act fill 正文 contenteditable target（read map 或 browser_snapshot(scope=forms) 可见），不要再微调坐标重试。`,
            }
            : point.skipReason === 'multiline_into_single_line'
              ? {
                errorKind: 'type_multiline_into_single_line',
                message: `焦点是单行输入框「${point.focusTarget?.label || 'input'}」，本次文本含换行/多段。已拒绝打字。请定位正文编辑器（contenteditable）后用 act fill。`,
              }
              : {
                errorKind: 'type_target_not_editable',
                message: '坐标点击后焦点不在可编辑控件上，已拒绝打字（避免文字灌进错误的框）。注意 x/y 是 0-1000 归一化坐标；用 browser_find 或 read map 拿准输入框位置，或直接 act fill 编辑器 target。',
              }
          return attachBrowserToolOutput(browserStructuredOutput({
            ok: false,
            errorKind: refusal.errorKind,
            normalized: { x: point.nx, y: point.ny },
            css: { x: point.cssX, y: point.cssY },
            focusTarget: point.focusTarget,
            message: refusal.message,
          }), {
            toolName,
            args,
            controller,
            sessionId,
            tabId,
            confirmation: null,
            nextSuggestedAction: 'locate input targets, then retype',
          })
        }
        const confirmation = null
        return attachBrowserToolOutput(JSON.stringify({
          ok: true,
          normalized: { x: point.nx, y: point.ny },
          css: { x: point.cssX, y: point.cssY },
          submitted: pressEnter,
          text_length: text.length,
          focusTarget: point.focusTarget,
          typedInto: point.typedInto,
        }, null, 2), {
          toolName,
          args,
          controller,
          sessionId,
          tabId,
          confirmation,
          nextSuggestedAction: confirmation ? 'finish with transaction proof' : 'read map again',
        })
      }

      case 'press_key': {
        const tabId = (args.tab_id as string) || null
        const key = String(args.key || '').trim()
        if (!key) return 'Error: key is required'
        const delivery = await sendKeyStroke(controller, tabId, key, args.modifiers)
        // D18-d：回报按键落点焦点——Cmd+A/Backspace 这类组合落错焦点是
        // 第十六轮正文被整段清空的元凶，落点必须当轮可见。
        const keyFocusProbe = await controller.executeJS(tabId, buildFocusedEditableProbeJs()).catch(() => null)
        const keyFocus = keyFocusProbe && typeof keyFocusProbe === 'object'
          ? (() => {
            const f = keyFocusProbe as { tag?: unknown; label?: unknown; kind?: unknown }
            const label = String(f.label || '').slice(0, 80)
            return ` (focus: ${label || String(f.kind || 'unknown')}<${String(f.tag || '?')}>)`
          })()
          : ''
        const confirmation = null
        return attachBrowserToolOutput(browserStructuredOutput({
          ok: delivery !== 'not_delivered',
          key,
          delivery,
          focus: keyFocus || null,
        }), {
          toolName,
          args,
          controller,
          sessionId,
          tabId,
          confirmation,
          nextSuggestedAction: confirmation ? 'finish with transaction proof' : 'read map again',
        })
      }

    default:
      return `Unknown browser tool: ${toolName}`
  }
}
