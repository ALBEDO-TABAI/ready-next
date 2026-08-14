import { createHash } from 'node:crypto'
import type { BrowserTargetClaimGate } from '../browser-engine/agent-browser-lease-gate'
import { beginTargetClaimGate } from '../browser-engine/agent-browser-lease-gate'
import { browserOperationCapability } from '../../../shared/browser-capability-registry'
import { resolveToolExecutionTimeoutMs } from './tool-execution-timeout-policy'
import { createBrowserStructuredOutput } from './browser-failure-output'
import {
  resolveBrowserToolInvocation,
  type BrowserToolInputSource,
  type BrowserToolInvocation,
} from './browser-tool-invocation'
import { createToolExecutionOutput, type ToolExecutionOutput } from '../agent-control/tools-runtime/tool-result-types'
import type {
  BrowserActionOutcome,
  BrowserActionTargetIdentity,
  BrowserEnvironmentSummary,
} from '../../../shared/browser-action-outcome'
import { buildBrowserEnvironmentSummary } from '../browser-engine/browser-action-receipt'
import {
  browserOriginInteractionBudget,
  type OriginInteractionBudget,
  type OriginInteractionSignal,
} from '../browser-engine/origin-interaction-budget'

export interface BrowserActionExecutorEvent {
  phase: 'start' | 'finish' | 'abort'
  toolName: string
  operation: string
  access: 'read' | 'control' | 'write'
  args: Record<string, unknown>
  actionId?: string
  actionSeq?: number
  outcome?: BrowserActionOutcome
}

export interface BrowserWorkflowJournalPort {
  taskId: string
  ownerRunId: string
  beginAction(input: {
    operationId: BrowserActionOutcome['operationId']
    argsDigest: string
    identity: BrowserActionTargetIdentity
    searchActionId?: string
  }): {
    actionId: string
    actionSeq: number
    identity: BrowserActionTargetIdentity
    searchActionId?: string
  }
  settleAction(actionId: string, outcome: BrowserActionOutcome): {
    receiptId: string
    outcome: BrowserActionOutcome
  }
  recordObservation(input: {
    operationId: BrowserActionOutcome['operationId']
    identity: BrowserActionTargetIdentity
    resultDigest: string
    resourceContent: string
    resourceTruncated: boolean
  }): {
    receiptId: string
    observationSeq: number
    operationId: BrowserActionOutcome['operationId']
    ownerRunId: string
    observedAfterActionSeq: number
    identity: BrowserActionTargetIdentity
    searchActionId: string | null
    queryDigest: string | null
    causalActions: Array<{
      actionId: string
      actionSeq: number
      predecessorIdentity: BrowserActionTargetIdentity
      successorIdentity: BrowserActionTargetIdentity
      searchActionId: string | null
      queryDigest: string | null
    }>
    resultDigest: string
    observedAt: string
  }
}

export type BrowserSearchMutationPhase = 'fill' | 'submit'

export interface BrowserMutationSettlement {
  receiptId: string
  outcome: BrowserActionOutcome
}

export interface BrowserMechanicalMutationFact {
  delivery?: BrowserActionOutcome['delivery']
  effect?: 'navigation_identity' | 'popup' | 'dialog' | 'download' | 'target_value' | 'target_state' | 'region_digest' | 'target_frame_response'
  postActionTabId?: string | null
}

/**
 * The only mutation boundary exposed to browser leaves. A leaf may perform any
 * number of read-only probes first. The first call to invokeTransport writes
 * the durable in_flight row synchronously and invokes the physical transport
 * in the same JavaScript stack, with no awaitable gap between the two.
 */
export interface BrowserMutationBoundary {
  invokeTransport<T>(transport: () => T): T
  recordMechanicalFact(fact: BrowserMechanicalMutationFact): void
  runSearchStep<T>(
    phase: BrowserSearchMutationPhase,
    action: () => Promise<T>,
  ): Promise<{ value: T; settlement: BrowserMutationSettlement | null }>
  searchActionIds(): {
    searchActionId: string | null
    fillActionId: string | null
    submitActionId: string | null
  }
  isFenced(): boolean
}

export interface BrowserActionExecutorInput {
  toolName: string
  args: Record<string, unknown>
  inputSource?: BrowserToolInputSource
  abortSignal?: AbortSignal
  leaseGate?: BrowserTargetClaimGate
  origin?: string | null
  interactionBudgetKey?: string | null
  interactionBudget?: OriginInteractionBudget
  deadlineMs?: number
  abortDrainMs?: number
  identityProbeTimeoutMs?: number
  beginInteractionObservation?: () => Promise<(() => Promise<OriginInteractionSignal | null>) | null>
  prepare?: (
    invocation: Extract<BrowserToolInvocation, { ok: true }>,
    signal: AbortSignal,
  ) => Promise<string | ToolExecutionOutput | null>
  resolveTargetIdentity?: (
    phase: 'predecessor' | 'successor',
    hint?: { tabId?: string | null },
  ) => BrowserActionTargetIdentity | Promise<BrowserActionTargetIdentity>
  journal?: BrowserWorkflowJournalPort
  /** Synchronous durable ownership read at the exact journal/transport stack.
   * A false result fences before the in-flight row and physical write. */
  writeAdmission?: () => boolean
  trustedPageRef?: {
    tabId: string
    physicalTargetToken: string
    mainFrameDocumentToken: string
  } | null
  onEvent?: (event: BrowserActionExecutorEvent) => void
  dispatch: (
    invocation: Extract<BrowserToolInvocation, { ok: true }>,
    signal: AbortSignal,
    mutationBoundary: BrowserMutationBoundary,
  ) => Promise<string | ToolExecutionOutput>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function environmentSummaryAllowedTabIds(
  predecessor: BrowserActionTargetIdentity,
  successor: BrowserActionTargetIdentity,
  postActionTabId: string | null,
): Set<string> {
  const allowed = new Set<string>()
  if (predecessor.documentState === 'document') allowed.add(predecessor.tabId)
  if (successor.documentState === 'document') allowed.add(successor.tabId)
  if (postActionTabId) allowed.add(postActionTabId)
  return allowed
}

function environmentSummaryFromResult(
  data: Record<string, unknown>,
  predecessor: BrowserActionTargetIdentity,
  successor: BrowserActionTargetIdentity,
  postActionTabId: string | null,
): BrowserEnvironmentSummary | null {
  const raw = data.environmentSummary
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const requestedTabId = typeof record.targetTabId === 'string' ? record.targetTabId.trim() : ''
  const allowedTabIds = environmentSummaryAllowedTabIds(predecessor, successor, postActionTabId)
  if (requestedTabId && allowedTabIds.size > 0 && !allowedTabIds.has(requestedTabId)) return null
  const boundTabId = requestedTabId
    || (successor.documentState === 'document' ? successor.tabId : '')
    || postActionTabId
    || (predecessor.documentState === 'document' ? predecessor.tabId : '')
  return buildBrowserEnvironmentSummary({
    targetTabId: boundTabId || null,
    url: typeof record.url === 'string' ? record.url : null,
    title: typeof record.title === 'string' ? record.title : null,
    dialogState: record.dialogState === 'open' || record.dialogState === 'closed'
      ? record.dialogState
      : undefined,
    fileChooserState: record.fileChooserState === 'open' || record.fileChooserState === 'closed'
      ? record.fileChooserState
      : undefined,
    downloadState: record.downloadState === 'in_flight' || record.downloadState === 'settled'
      ? record.downloadState
      : undefined,
    sampledAt: typeof record.sampledAt === 'string' ? record.sampledAt : null,
  })
}

function resultData(result: string | ToolExecutionOutput): Record<string, unknown> {
  if (typeof result !== 'string') return result.data || {}
  try {
    return asRecord(JSON.parse(result)) || {}
  } catch {
    // silent-catch: opaque legacy text carries no typed interaction signal.
    return {}
  }
}

function opaqueOriginalText(result: string | ToolExecutionOutput): string | null {
  if (typeof result !== 'string') return null
  try {
    return asRecord(JSON.parse(result)) ? null : result
  } catch {
    // silent-catch: invalid JSON remains opaque text and is never reclassified.
    return result
  }
}

/** Only typed transport fields affect rate/challenge state. Page prose and
 * legacy error strings are deliberately inert. */
export function interactionSignalFromResult(
  result: string | ToolExecutionOutput,
  authoritative: OriginInteractionSignal | null = null,
): OriginInteractionSignal {
  const data = resultData(result)
  const status = Number(data.status ?? data.statusCode ?? data.httpStatus ?? 0)
  const retryAfter = data.retryAfter ?? data.retry_after ?? null
  const errorKind = typeof data.errorKind === 'string' ? data.errorKind : ''
  const explicitOk = typeof data.ok === 'boolean' ? data.ok : undefined
  return {
    status: authoritative?.status ?? (Number.isFinite(status) && status > 0 ? status : null),
    retryAfter: authoritative?.retryAfter
      ?? (typeof retryAfter === 'string' || typeof retryAfter === 'number' ? retryAfter : null),
    challenge: authoritative?.challenge === true
      || data.challenge === true
      || errorKind === 'challenge_required'
      || errorKind === 'verification_required',
    loginWall: authoritative?.loginWall === true
      || data.loginWall === true
      || errorKind === 'login_required'
      || errorKind === 'auth_required',
    challengeCleared: authoritative?.challengeCleared === true || data.challengeCleared === true,
    actionSucceeded: authoritative?.actionSucceeded ?? explicitOk,
  }
}

/**
 * JSON leaves keep their typed result. Legacy strings remain opaque rather
 * than being reclassified from English words or regexes.
 */
export function normalizeBareBrowserToolError(result: string | ToolExecutionOutput): string | ToolExecutionOutput {
  if (typeof result !== 'string') return result
  try {
    const parsed = asRecord(JSON.parse(result))
    return parsed?.ok === false ? createBrowserStructuredOutput(parsed) : result
  } catch {
    // silent-catch: invalid JSON remains an opaque legacy result.
    return result
  }
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

function stableDigest(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize)
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, normalize(child)]))
    }
    return item
  }
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex')
}

function boundedObservationResource(value: unknown): { content: string; truncated: boolean } {
  const raw = JSON.stringify(value)
  if (Buffer.byteLength(raw, 'utf8') <= 65_536) return { content: raw, truncated: false }
  const operationId = asRecord(value)?.operationId
  let excerpt = Buffer.from(raw, 'utf8').subarray(0, 60_000).toString('utf8')
  let content = JSON.stringify({ operationId, truncated: true, excerpt })
  while (Buffer.byteLength(content, 'utf8') > 65_536 && excerpt.length > 0) {
    excerpt = excerpt.slice(0, Math.floor(excerpt.length * 0.9))
    content = JSON.stringify({ operationId, truncated: true, excerpt })
  }
  return { content, truncated: true }
}

function waitForDrain(ms: number): Promise<{ kind: 'drain_expired' }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'drain_expired' }), Math.max(0, ms))
    timer.unref?.()
  })
}

class BrowserMutationFenceError extends Error {
  readonly code: string

  constructor(code: string, message = code) {
    super(message)
    this.name = 'BrowserMutationFenceError'
    this.code = code
  }
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

    const capability = browserOperationCapability(invocation.operation)
    const access = capability.mode === 'mutate'
      ? 'write'
      : capability.mode === 'control'
        ? 'control'
        : 'read'
    if (!input.journal && capability.requiresWorkflowRoute) {
      return createBrowserStructuredOutput({
        ok: false,
        errorKind: 'browser_workflow_journal_required',
        operationId: invocation.operation,
      })
    }

    const leaseHandle = beginTargetClaimGate(input.leaseGate, input.toolName, invocation.args)
    const structuredDenial = (message: string, fallback = 'lease_denied') => {
      let data: Record<string, unknown> = {}
      try { data = asRecord(JSON.parse(message)) || {} } catch {
        // silent-catch: a non-JSON lease denial is preserved as opaque detail.
        data = { message }
      }
      return createBrowserStructuredOutput({
        ok: false,
        ...data,
        errorKind: String(data.errorCode || data.errorKind || fallback),
        operationId: invocation.operation,
      })
    }
    if (leaseHandle.deniedMessage !== null) return structuredDenial(leaseHandle.deniedMessage)

    const abortController = new AbortController()
    const unlinkAbort = linkAbortSignal(input.abortSignal, abortController)
    const timeoutMs = Math.max(1, input.deadlineMs ?? resolveToolExecutionTimeoutMs(input.toolName))
    const abortDrainMs = Math.max(0, input.abortDrainMs ?? 250)
    const identityProbeTimeoutMs = Math.max(
      1,
      Math.min(timeoutMs, input.identityProbeTimeoutMs ?? Math.min(250, timeoutMs)),
    )
    let timer: ReturnType<typeof setTimeout> | null = null
    let deadlineTriggered = false
    let authoritativeInteractionSignal: OriginInteractionSignal | null = null
    let finishObservation: (() => Promise<OriginInteractionSignal | null>) | null = null

    const noDocumentIdentity = (): BrowserActionTargetIdentity => ({
      documentState: 'no_document',
      tabId: null,
      physicalTargetToken: null,
      frameId: null,
      frameDocumentToken: null,
      targetRef: null,
    })
    const identityIsComplete = (identity: BrowserActionTargetIdentity): boolean => identity.documentState === 'document'
      && Boolean(identity.tabId)
      && Boolean(identity.physicalTargetToken)
      && Boolean(identity.frameId)
      && Boolean(identity.frameDocumentToken)
    const predecessorIdentity = (): BrowserActionTargetIdentity => {
      const resolved = input.resolveTargetIdentity?.('predecessor')
      if (!resolved) {
        if (!capability.requiresDocument) return noDocumentIdentity()
        throw new BrowserMutationFenceError('browser_target_identity_incomplete')
      }
      if (typeof (resolved as Promise<BrowserActionTargetIdentity>).then === 'function') {
        throw new Error('browser_predecessor_identity_must_be_synchronous')
      }
      const identity = resolved as BrowserActionTargetIdentity
      if (!identityIsComplete(identity) && !(!capability.requiresDocument && identity.documentState === 'no_document')) {
        throw new BrowserMutationFenceError('browser_target_identity_incomplete')
      }
      return identity
    }
    const successorIdentity = async (
      fallback: BrowserActionTargetIdentity,
      allowProbe = true,
      tabIdHint: string | null = null,
    ): Promise<{ identity: BrowserActionTargetIdentity; fresh: boolean }> => {
      if (!allowProbe || !input.resolveTargetIdentity) return { identity: fallback, fresh: false }
      let resolved: BrowserActionTargetIdentity | Promise<BrowserActionTargetIdentity>
      try {
        resolved = input.resolveTargetIdentity('successor', { tabId: tabIdHint })
      } catch {
        // silent-catch: a failed successor probe cannot replace the settled fallback identity.
        return { identity: fallback, fresh: false }
      }
      if (typeof (resolved as Promise<BrowserActionTargetIdentity>).then !== 'function') {
        const identity = resolved as BrowserActionTargetIdentity
        return identityIsComplete(identity)
          ? { identity, fresh: true }
          : { identity: fallback, fresh: false }
      }
      let timeout: ReturnType<typeof setTimeout> | null = null
      const bounded = new Promise<{ identity: BrowserActionTargetIdentity; fresh: boolean }>((resolve) => {
        timeout = setTimeout(() => resolve({ identity: fallback, fresh: false }), identityProbeTimeoutMs)
        timeout.unref?.()
      })
      const probed = Promise.resolve(resolved).then(
        (identity) => identityIsComplete(identity)
          ? { identity, fresh: true }
          : { identity: fallback, fresh: false },
        () => ({ identity: fallback, fresh: false }),
      )
      const result = await Promise.race([probed, bounded])
      if (timeout) clearTimeout(timeout)
      return result
    }
    type Active = ReturnType<NonNullable<BrowserWorkflowJournalPort['beginAction']>> & {
      phase: 'default' | BrowserSearchMutationPhase
      mechanicalFacts: BrowserMechanicalMutationFact[]
    }

    let active: Active | null = null
    let closed = false
    let currentPhase: Active['phase'] = 'default'
    let searchActionId: string | null = null
    const searchQueryDigest = invocation.operation === 'search'
      ? stableDigest(String(invocation.args.query || '').normalize('NFC').replace(/\r\n?/g, '\n').trim())
      : null
    let fillActionId: string | null = null
    let submitActionId: string | null = null
    let lastSettlement: BrowserMutationSettlement | null = null
    let observationReceipt: ReturnType<BrowserWorkflowJournalPort['recordObservation']> | null = null
    let settledActionCount = 0

    const event = (
      phase: BrowserActionExecutorEvent['phase'],
      action?: Active | null,
      outcome?: BrowserActionOutcome,
    ) => input.onEvent?.({
      phase,
      toolName: input.toolName,
      operation: invocation.operation,
      access,
      args: invocation.args,
      ...(action ? { actionId: action.actionId, actionSeq: action.actionSeq } : {}),
      ...(outcome ? { outcome } : {}),
    })

    const buildOutcome = async (
      action: Active,
      value: string | ToolExecutionOutput | null,
      error: unknown = null,
      allowSuccessorProbe = !deadlineTriggered,
    ): Promise<BrowserActionOutcome> => {
      const data = value ? resultData(value) : {}
      const explicitOk = typeof data.ok === 'boolean' ? data.ok : null
      const deliveryFacts = action.mechanicalFacts.map((fact) => fact.delivery).filter(Boolean)
      const delivery = error
        ? 'unknown'
        : deliveryFacts.includes('delivered')
          ? 'delivered'
          : deliveryFacts.includes('not_delivered')
            ? 'not_delivered'
            : 'unknown'
      const dispatch = error
        ? 'unknown'
        : data.dispatchAccepted === false
          || (explicitOk === false && data.mayHaveCommitted !== true && delivery !== 'delivered')
          ? 'rejected'
          : 'accepted'
      const postActionTabId = action.mechanicalFacts
        .map((fact) => fact.postActionTabId)
        .find((tabId): tabId is string => typeof tabId === 'string' && Boolean(tabId.trim())) || null
      const successor = await successorIdentity(
        action.identity || predecessorIdentity(),
        allowSuccessorProbe,
        postActionTabId,
      )
      const predecessor = action.identity || predecessorIdentity()
      const identityChanged = successor.fresh
        && predecessor.documentState === 'document'
        && successor.identity.documentState === 'document'
        && (
          predecessor.tabId !== successor.identity.tabId
          || predecessor.physicalTargetToken !== successor.identity.physicalTargetToken
          || predecessor.frameId !== successor.identity.frameId
          || predecessor.frameDocumentToken !== successor.identity.frameDocumentToken
        )
      const effectObserved = identityChanged || action.mechanicalFacts.some((fact) => Boolean(fact.effect))
      const submitted = action.phase === 'submit' && delivery === 'delivered'
      const environmentSummary = environmentSummaryFromResult(
        data,
        predecessor,
        successor.identity,
        postActionTabId,
      )
      const outcome: BrowserActionOutcome = {
        actionId: action.actionId,
        actionSeq: action.actionSeq,
        taskId: input.journal!.taskId,
        ownerRunId: input.journal!.ownerRunId,
        operationId: invocation.operation,
        mode: capability.mode,
        dispatch,
        delivery: dispatch === 'rejected' ? 'not_delivered' : delivery,
        effect: effectObserved ? 'observed' : 'unknown',
        needsObservation: dispatch !== 'rejected' && !effectObserved && delivery !== 'not_delivered',
        mayHaveCommitted: dispatch !== 'rejected'
          && (data.mayHaveCommitted === true || delivery === 'delivered' || delivery === 'unknown'),
        identity: predecessor,
        successorIdentity: successor.identity,
        ...(postActionTabId ? { postActionTabId } : {}),
        ...(environmentSummary
          ? { environmentSummary }
          : {}),
      }
      if (invocation.operation === 'search') {
        outcome.search = {
          searchActionId: action.searchActionId || searchActionId || '',
          queryDigest: searchQueryDigest || '',
          fillActionId: action.phase === 'fill' ? action.actionId : fillActionId,
          submitActionId: action.phase === 'submit' ? action.actionId : submitActionId,
          phase: effectObserved ? 'effect_observed' : submitted ? 'submitted_needs_observation' : 'not_submitted',
          submitted,
          effectObserved,
        }
      }
      return outcome
    }

    const settleActive = async (
      value: string | ToolExecutionOutput | null,
      error: unknown = null,
      phase: BrowserActionExecutorEvent['phase'] = error ? 'abort' : 'finish',
      allowSuccessorProbe = !deadlineTriggered,
    ): Promise<BrowserMutationSettlement | null> => {
      const action = active
      if (!action || !input.journal) return null
      const outcome = await buildOutcome(action, value, error, allowSuccessorProbe)
      const persisted = input.journal.settleAction(action.actionId, outcome)
      const settlement = { receiptId: persisted.receiptId, outcome: persisted.outcome }
      if (action.phase === 'fill') fillActionId = action.actionId
      if (action.phase === 'submit') submitActionId = action.actionId
      active = null
      lastSettlement = settlement
      settledActionCount += 1
      event(phase, action, settlement.outcome)
      return settlement
    }

    const mutationBoundary: BrowserMutationBoundary = {
      invokeTransport: <T>(transport: () => T): T => {
        if (closed || abortController.signal.aborted) {
          throw new BrowserMutationFenceError('browser_action_fenced')
        }
        if (capability.mode === 'mutate' && input.writeAdmission && !input.writeAdmission()) {
          throw new BrowserMutationFenceError('browser_workflow_write_fenced')
        }
        const denied = leaseHandle.begin()
        if (denied) throw new BrowserMutationFenceError('lease_denied_at_dispatch', denied)
        if (!active) {
          const capturedIdentity = predecessorIdentity()
          const begun = input.journal!.beginAction({
            operationId: invocation.operation,
            argsDigest: stableDigest({ args: invocation.args, phase: currentPhase }),
            identity: capturedIdentity,
            ...(searchActionId ? { searchActionId } : {}),
          })
          active = { ...begun, identity: begun.identity || capturedIdentity, phase: currentPhase, mechanicalFacts: [] }
          if (invocation.operation === 'search') {
            searchActionId = begun.searchActionId || searchActionId
            if (currentPhase === 'fill') fillActionId = begun.actionId
            if (currentPhase === 'submit') submitActionId = begun.actionId
          }
          event('start', active)
        }
        // Synchronous CAS above and transport invocation below intentionally
        // share one stack. Do not insert an awaitable operation here.
        return transport()
      },
      recordMechanicalFact: (fact) => {
        if (closed || !active) return
        active.mechanicalFacts.push({
          ...(fact.delivery ? { delivery: fact.delivery } : {}),
          ...(fact.effect ? { effect: fact.effect } : {}),
          ...(typeof fact.postActionTabId === 'string' && fact.postActionTabId.trim()
            ? { postActionTabId: fact.postActionTabId.trim() }
            : {}),
        })
      },
      runSearchStep: async <T>(phase: BrowserSearchMutationPhase, action: () => Promise<T>) => {
        if (invocation.operation !== 'search') {
          throw new BrowserMutationFenceError('browser_search_step_outside_search')
        }
        if (active) throw new BrowserMutationFenceError('browser_search_step_overlap')
        currentPhase = phase
        try {
          const value = await action()
          const normalized = typeof value === 'string' || (value && typeof value === 'object' && 'text' in value)
            ? value as unknown as string | ToolExecutionOutput
            : createBrowserStructuredOutput({ ok: true, ...(asRecord(value) || { value }) })
          const settlement = await settleActive(normalized)
          return { value, settlement }
        } catch (error) {
          await settleActive(null, error)
          throw error
        } finally {
          currentPhase = 'default'
        }
      },
      searchActionIds: () => ({ searchActionId, fillActionId, submitActionId }),
      isFenced: () => closed,
    }

    const attachBrowserMetadata = (
      value: string | ToolExecutionOutput,
      settlement: BrowserMutationSettlement | null,
    ): ToolExecutionOutput => {
      const original = typeof value === 'string' ? null : value
      const data = {
        ...resultData(value),
        ...(opaqueOriginalText(value) !== null ? { opaqueOriginalText: opaqueOriginalText(value) } : {}),
        operationId: invocation.operation,
        ...(settlement
          ? {
              actionId: settlement.outcome.actionId,
              actionSeq: settlement.outcome.actionSeq,
              outcome: settlement.outcome,
              browserActionOutcome: settlement.outcome,
              browserActionReceiptId: settlement.receiptId,
            }
          : {}),
        ...(observationReceipt ? { browserObservationReceipt: observationReceipt } : {}),
      }
      return createToolExecutionOutput(JSON.stringify(data, null, 2), {
        shape: original?.shape === 'multimodal' ? 'multimodal' : 'json',
        data,
        projectionPatch: original?.projectionPatch,
        interactionHint: original?.interactionHint,
        content: original?.content,
        framePatch: original?.framePatch,
        contextModifier: original?.contextModifier,
        envelope: original?.envelope,
      })
    }

    type DispatchResult = { value: string | ToolExecutionOutput }
    const dispatch = async (): Promise<DispatchResult> => {
      const prepared = await input.prepare?.(invocation, abortController.signal)
      if (prepared) return { value: prepared }
      if (access === 'write' && input.beginInteractionObservation) {
        try { finishObservation = await input.beginInteractionObservation() } catch {
          // silent-catch: dispatch still returns typed transport facts when optional network observation is unavailable.
          finishObservation = null
        }
      }
      try {
        return { value: await input.dispatch(invocation, abortController.signal, mutationBoundary) }
      } finally {
        if (finishObservation) {
          try { authoritativeInteractionSignal = await finishObservation() } catch {
            // silent-catch: failed optional observation cannot override the typed dispatch result.
            authoritativeInteractionSignal = null
          }
        }
      }
    }

    const origin = String(input.origin || '').trim()
    const interactionBudgetKey = String(input.interactionBudgetKey || origin).trim()
    const execution = capability.mode === 'mutate'
      ? (input.interactionBudget || browserOriginInteractionBudget).runWrite(
          interactionBudgetKey,
          dispatch,
          abortController.signal,
        ).then((budgetResult): DispatchResult => budgetResult.gate.ok
          ? budgetResult.value as DispatchResult
          : {
              value: createBrowserStructuredOutput({
                ok: false,
                errorKind: budgetResult.gate.errorCode,
                retryAt: budgetResult.gate.retryAt,
              }),
            })
      : dispatch()
    type Resolution = { kind: 'result'; result: DispatchResult } | { kind: 'error'; error: unknown }
    const settled: Promise<Resolution> = execution.then(
      (result) => ({ kind: 'result', result }),
      (error) => ({ kind: 'error', error }),
    )
    const deadline = new Promise<{ kind: 'deadline' }>((resolve) => {
      timer = setTimeout(() => {
        closed = true
        deadlineTriggered = true
        abortController.abort(new Error(`browser_deadline_exceeded:${input.toolName}:${timeoutMs}`))
        resolve({ kind: 'deadline' })
      }, timeoutMs)
      timer.unref?.()
    })

    const deadlineResult = (
      settlement: BrowserMutationSettlement | null,
      abortDrained: boolean,
      ownershipRetained: boolean,
    ): string | ToolExecutionOutput => {
      const timeoutOutput = createBrowserStructuredOutput({
        ok: false,
        errorKind: 'browser_deadline_exceeded',
        toolName: input.toolName,
        timeoutMs,
        abortDrained,
        ownershipRetained,
        writesAfterReturn: abortDrained ? 0 : null,
        guardedTransportWritesAfterReturn: 0,
        mayHaveCommitted: settlement?.outcome.mayHaveCommitted ?? Boolean(active || settledActionCount > 0),
        ...(mutationBoundary.searchActionIds().searchActionId
          ? { search: mutationBoundary.searchActionIds() }
          : {}),
      })
      return attachBrowserMetadata(timeoutOutput, settlement)
    }

    try {
      let timedOut = false
      let resolution = await Promise.race([settled, deadline])
      if (resolution.kind === 'deadline') {
        timedOut = true
        const drained = await Promise.race([settled, waitForDrain(abortDrainMs)])
        if (drained.kind === 'drain_expired') {
          // A transport already handed to Chromium may still affect the page
          // after JavaScript cancellation. Keep the lease and withhold the
          // public tool result until that transport actually terminates.
          resolution = await settled
        } else {
          resolution = drained
        }
      }

      if (resolution.kind === 'error') {
        const failureSettlement = await settleActive(null, resolution.error, 'abort', !timedOut) || lastSettlement
        if (timedOut) return deadlineResult(failureSettlement, true, false)
        if (!failureSettlement) event('abort')
        throw resolution.error
      }

      const result = normalizeBareBrowserToolError(resolution.result.value)
      const settlement = await settleActive(result, null, 'finish', !timedOut) || lastSettlement
      const data = resultData(result)
      const explicitlyFailed = data.ok === false
      const mutationContractError = capability.mode === 'mutate' && !explicitlyFailed
        ? settledActionCount === 0
          ? 'browser_mutation_transport_not_invoked'
          : invocation.operation === 'search' && settledActionCount !== 2
            ? 'browser_search_transport_incomplete'
            : null
        : null
      if (mutationContractError) {
        const failure = createBrowserStructuredOutput({
          ok: false,
          errorKind: mutationContractError,
          operationId: invocation.operation,
          settledActionCount,
          requiredSettlementCount: invocation.operation === 'search' ? 2 : 1,
          mayHaveCommitted: settledActionCount > 0,
        })
        if (!settlement) event('abort')
        return attachBrowserMetadata(failure, settlement)
      }
      if (capability.mode === 'mutate' && origin) {
        ;(input.interactionBudget || browserOriginInteractionBudget).record(
          interactionBudgetKey,
          interactionSignalFromResult(result, authoritativeInteractionSignal),
        )
      }
      if (timedOut) return deadlineResult(settlement, true, false)
      if (capability.requiresDocument && input.journal && data.observationFresh === true) {
        const observedIdentity = await successorIdentity(noDocumentIdentity(), true, null)
        const pinned = input.trustedPageRef
        const observationLeavesPinnedPage = Boolean(
          pinned
          && observedIdentity.identity.documentState === 'document'
          && (
            observedIdentity.identity.tabId !== pinned.tabId
            || observedIdentity.identity.physicalTargetToken !== pinned.physicalTargetToken
            || observedIdentity.identity.frameDocumentToken !== pinned.mainFrameDocumentToken
          ),
        )
        if (observationLeavesPinnedPage && pinned) {
          return attachBrowserMetadata(createBrowserStructuredOutput({
            ok: false,
            errorKind: 'browser_reference_stale',
            tabId: pinned.tabId,
          }), settlement)
        }
        const observationIsFresh = observedIdentity.fresh
          && identityIsComplete(observedIdentity.identity)
          && data.cached !== true
          && data.fromCache !== true
          && data.fresh !== false
        if (observationIsFresh) {
          const resource = boundedObservationResource({
            operationId: invocation.operation,
            result: data,
          })
          observationReceipt = input.journal.recordObservation({
            operationId: invocation.operation,
            identity: observedIdentity.identity,
            resultDigest: stableDigest(JSON.parse(resource.content)),
            resourceContent: resource.content,
            resourceTruncated: resource.truncated,
          })
        }
      }
      if (!settlement) event('finish')
      return attachBrowserMetadata(result, settlement)
    } finally {
      if (timer) clearTimeout(timer)
      leaseHandle.end()
      unlinkAbort()
    }
  }
}
