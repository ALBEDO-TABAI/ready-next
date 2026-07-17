import type { BrowserLeaseGate } from '../browser-engine/agent-browser-lease-gate'
import { beginLeaseGate } from '../browser-engine/agent-browser-lease-gate'
import { classifyBrowserToolCall } from '../browser-engine/browser-tool-write-classification'
import { resolveToolExecutionTimeoutMs } from './tool-execution-timeout-policy'
import { createBrowserStructuredOutput } from './browser-failure-output'
import {
  resolveBrowserToolInvocation,
  type BrowserToolInputSource,
  type BrowserToolInvocation,
} from './browser-tool-invocation'
import type { ToolExecutionOutput } from '../agent-control/tools-runtime/tool-result-types'
import {
  browserOriginInteractionBudget,
  type OriginInteractionBudget,
  type OriginInteractionSignal,
} from '../browser-engine/origin-interaction-budget'

export interface BrowserActionExecutorEvent {
  phase: 'start' | 'finish' | 'abort'
  toolName: string
  operation: string
  access: 'read' | 'write'
  args: Record<string, unknown>
}

export interface BrowserActionExecutorInput {
  toolName: string
  args: Record<string, unknown>
  inputSource?: BrowserToolInputSource
  abortSignal?: AbortSignal
  leaseGate?: BrowserLeaseGate
  origin?: string | null
  interactionBudget?: OriginInteractionBudget
  deadlineMs?: number
  abortDrainMs?: number
  beginInteractionObservation?: () => Promise<(() => Promise<OriginInteractionSignal | null>) | null>
  onEvent?: (event: BrowserActionExecutorEvent) => void
  dispatch: (
    invocation: Extract<BrowserToolInvocation, { ok: true }>,
    signal: AbortSignal,
  ) => Promise<string | ToolExecutionOutput>
}

export function interactionSignalFromResult(
  result: string | ToolExecutionOutput,
  authoritative: OriginInteractionSignal | null = null,
): OriginInteractionSignal {
  const data = typeof result === 'string'
    ? (() => {
        try {
          const parsed = JSON.parse(result) as unknown
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : { text: result }
        } catch {
          // silent-catch: non-JSON tool output remains observable as bounded text.
          return { text: result }
        }
      })()
    : result.data || { text: result.text }
  const status = Number(data.status || data.statusCode || data.httpStatus || 0)
  const retryAfter = data.retryAfter ?? data.retry_after ?? null
  const errorKind = String(data.errorKind || data.errorCode || data.reason || '').trim().toLowerCase()
  const challenge = data.challenge === true
    || errorKind === 'challenge_required'
    || errorKind === 'verification_required'
  const loginWall = data.loginWall === true
    || errorKind === 'login_required'
    || errorKind === 'auth_required'
  const explicitOk = typeof data.ok === 'boolean' ? data.ok : null
  const text = typeof result === 'string' ? result : result.text
  return {
    status: authoritative?.status ?? (Number.isFinite(status) && status > 0 ? status : null),
    retryAfter: authoritative?.retryAfter
      ?? (typeof retryAfter === 'string' || typeof retryAfter === 'number' ? retryAfter : null),
    challenge: authoritative?.challenge === true || challenge,
    loginWall: authoritative?.loginWall === true || loginWall,
    challengeCleared: authoritative?.challengeCleared === true || data.challengeCleared === true,
    actionSucceeded: authoritative?.actionSucceeded
      ?? (explicitOk === null ? !/(?:"errorKind"|"errorCode"|^Error:)/i.test(text) : explicitOk),
  }
}

export function normalizeBareBrowserToolError(result: string | ToolExecutionOutput): string | ToolExecutionOutput {
  if (typeof result !== 'string') return result
  const message = result.trim()
  if (message.startsWith('{')) {
    try {
      const parsed = JSON.parse(message) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as { ok?: unknown }).ok === false) {
        return createBrowserStructuredOutput(parsed as Record<string, unknown>)
      }
    } catch {
      // silent-catch: malformed JSON falls through to the bounded plain-error matcher.
    }
  }
  if (!/^(?:Error(?::| executing\b)|Unknown browser tool:)/i.test(message)) return result
  const rules: Array<{ pattern: RegExp; errorKind: string; nextSuggestedAction: string }> = [
    { pattern: /stale_(?:page|document|snapshot)|document epoch|snapshot revision/i, errorKind: 'target_stale', nextSuggestedAction: 'call browser_snapshot once, then retry with the new target reference' },
    { pattern: /ambiguous|multiple matches|not unique/i, errorKind: 'target_ambiguous', nextSuggestedAction: 'call browser_find with a narrower role or name and choose one unique target' },
    { pattern: /target.*not found|selector.*not found|no matching (?:element|target)/i, errorKind: 'target_not_found', nextSuggestedAction: 'call browser_find on the current snapshot and use the returned target reference' },
    { pattern: /missing|required|invalid|must be|expected (?:a|an)/i, errorKind: 'invalid_arguments', nextSuggestedAction: 'correct the listed argument and retry once' },
    { pattern: /permission|authori[sz]|access denied|not allowed/i, errorKind: 'authorization_denied', nextSuggestedAction: 'stay within the current task scope or request the specific user authorization' },
    { pattern: /timed? ?out|timeout|deadline/i, errorKind: 'browser_operation_timeout', nextSuggestedAction: 'inspect the current tab state before deciding whether a retry is safe' },
    { pattern: /dialog|beforeunload|prompt|alert|confirm/i, errorKind: 'dialog_blocked', nextSuggestedAction: 'call browser_dialog to inspect and handle the open dialog' },
    { pattern: /unsupported|not supported|unavailable/i, errorKind: 'unsupported_operation', nextSuggestedAction: 'use the supported semantic browser tool for this task' },
  ]
  const matched = rules.find((rule) => rule.pattern.test(message))
  return createBrowserStructuredOutput({
    ok: false,
    errorKind: matched?.errorKind || 'browser_operation_failed',
    message: message.replace(/^Error(?::| executing\s+[^:]+:)?\s*/i, ''),
    nextSuggestedAction: matched?.nextSuggestedAction || 'inspect browser_status before choosing a different recovery path',
  })
}

function linkAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => {}
  if (source.aborted) {
    target.abort(source.reason)
    return () => {}
  }
  const abort = () => target.abort(source.reason)
  source.addEventListener('abort', abort, { once: true })
  return () => source.removeEventListener('abort', abort)
}

export class BrowserActionExecutor {
  async execute(input: BrowserActionExecutorInput): Promise<string | ToolExecutionOutput> {
    const invocation = resolveBrowserToolInvocation(input.toolName, input.args, input.inputSource)
    if (!invocation.ok) {
      return createBrowserStructuredOutput({
        ok: false,
        errorKind: invocation.errorCode,
        message: invocation.message,
      })
    }

    const access = classifyBrowserToolCall(input.toolName, invocation.args)
    const gate = beginLeaseGate(input.leaseGate, input.toolName, invocation.args)
    if (gate.deniedMessage !== null) {
      let deniedData: Record<string, unknown> | null = null
      try {
        const parsed = JSON.parse(gate.deniedMessage) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) deniedData = parsed as Record<string, unknown>
      } catch {
        // silent-catch: malformed lease output is preserved verbatim in the structured denial below.
      }
      return createBrowserStructuredOutput({
        ok: false,
        ...(deniedData || {}),
        errorKind: String(deniedData?.errorCode || deniedData?.errorKind || 'lease_denied'),
        message: String(deniedData?.message || gate.deniedMessage),
      })
    }

    const abortController = new AbortController()
    const unlinkAbort = linkAbortSignal(input.abortSignal, abortController)
    const timeoutMs = Math.max(1, input.deadlineMs ?? resolveToolExecutionTimeoutMs(input.toolName))
    let timer: ReturnType<typeof setTimeout> | null = null
    let ownershipReleased = false
    let settlementOwnsRelease = false
    let authoritativeInteractionSignal: OriginInteractionSignal | null = null
    const releaseOwnership = () => {
      if (ownershipReleased) return
      ownershipReleased = true
      unlinkAbort()
      gate.end()
    }
    const deadline = new Promise<{ kind: 'deadline' }>((resolve) => {
      timer = setTimeout(() => {
        const error = new Error(`browser_deadline_exceeded:${input.toolName}:${timeoutMs}`)
        abortController.abort(error)
        resolve({ kind: 'deadline' })
      }, timeoutMs)
    })

    const event = (phase: BrowserActionExecutorEvent['phase']) => input.onEvent?.({
      phase,
      toolName: input.toolName,
      operation: invocation.operation,
      access,
      args: invocation.args,
    })

    try {
      event('start')
      const dispatch = async () => {
        if (access === 'write') {
          const boundaryDeniedMessage = gate.begin()
          if (boundaryDeniedMessage) {
            let boundaryDenied: Record<string, unknown> = {}
            try { boundaryDenied = JSON.parse(boundaryDeniedMessage) as Record<string, unknown> } catch {
              // silent-catch: preserve a malformed lease denial as a bounded message.
              boundaryDenied = { message: boundaryDeniedMessage }
            }
            return createBrowserStructuredOutput({
              ok: false,
              ...boundaryDenied,
              errorKind: String(boundaryDenied.errorCode || boundaryDenied.errorKind || 'lease_denied'),
            })
          }
        }
        let finishObservation: (() => Promise<OriginInteractionSignal | null>) | null = null
        if (access === 'write' && input.beginInteractionObservation) {
          try { finishObservation = await input.beginInteractionObservation() } catch {
            // silent-catch: best-effort network feedback must not block the user action.
          }
        }
        try {
          return await input.dispatch(invocation, abortController.signal)
        } finally {
          if (finishObservation) {
            try { authoritativeInteractionSignal = await finishObservation() } catch {
              // silent-catch: a detached tab can end observation without invalidating the action result.
            }
          }
        }
      }
      const origin = String(input.origin || '').trim()
      const controlPlaneWrite = input.toolName === 'browser_request_takeover'
        || input.toolName === 'browser_task'
      const recordOriginOutcome = input.toolName !== 'browser_task'
      const execution = access === 'write' && !controlPlaneWrite
        ? (input.interactionBudget || browserOriginInteractionBudget)
            .runWrite(origin, dispatch, abortController.signal)
            .then((budgetResult) => {
              if (!budgetResult.gate.ok) {
                return createBrowserStructuredOutput({
                  ok: false,
                  errorKind: budgetResult.gate.errorCode,
                  retryAt: budgetResult.gate.retryAt,
                  nextSuggestedAction: budgetResult.gate.errorCode === 'origin_challenge_blocked'
                    ? 'request user takeover and resume the same task after verification'
                    : 'retry after the current action is cancelled',
                })
              }
              return budgetResult.value as string | ToolExecutionOutput
            })
        : Promise.resolve().then(dispatch)
      type Settlement =
        | { kind: 'result'; value: string | ToolExecutionOutput }
        | { kind: 'error'; error: unknown }
      const settled: Promise<Settlement> = execution.then(
        (value) => ({ kind: 'result', value }),
        (error) => ({ kind: 'error', error }),
      )
      settlementOwnsRelease = true
      void settled.then(releaseOwnership)

      const first = await Promise.race([settled, deadline])
      if (first.kind === 'deadline') {
        event('abort')
        const abortDrainMs = Math.max(50, input.abortDrainMs ?? 1_000)
        let drainTimer: ReturnType<typeof setTimeout> | null = null
        const drained = await Promise.race([
          settled,
          new Promise<{ kind: 'drain_timeout' }>((resolve) => {
            drainTimer = setTimeout(() => resolve({ kind: 'drain_timeout' }), abortDrainMs)
          }),
        ])
        if (drainTimer) clearTimeout(drainTimer)
        if (drained.kind === 'result' && access === 'write' && recordOriginOutcome && origin) {
          ;(input.interactionBudget || browserOriginInteractionBudget).record(
            origin,
            interactionSignalFromResult(drained.value, authoritativeInteractionSignal),
          )
        }
        return createBrowserStructuredOutput({
          ok: false,
          errorKind: 'browser_deadline_exceeded',
          toolName: input.toolName,
          timeoutMs,
          mayHaveCommitted: access === 'write',
          abortDrained: drained.kind !== 'drain_timeout',
          ownershipRetained: drained.kind === 'drain_timeout',
        })
      }
      if (first.kind === 'error') throw first.error
      const result = normalizeBareBrowserToolError(first.value)
      if (access === 'write' && recordOriginOutcome && origin) {
        ;(input.interactionBudget || browserOriginInteractionBudget).record(
          origin,
          interactionSignalFromResult(result, authoritativeInteractionSignal),
        )
      }
      event('finish')
      return result
    } catch (error) {
      event('abort')
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      // The dispatch settlement releases the lease action window and linked
      // abort listener. A non-cooperative leaf keeps ownership after return.
      if (!settlementOwnsRelease) releaseOwnership()
    }
  }
}
