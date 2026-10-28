import { createHash } from 'node:crypto'

import type { ConversationScope, ScopeRunEventPayload } from '../contracts/types'
import type {
  ExecutionHostResult,
  RunCompletionHooks,
} from '../contracts/run-contracts'
import type { PreparedCodexProductRun } from '../codex-runtime/codex-product-run-preparer'
import type { ReadyCodexExecutionOutcome } from '../codex-runtime/ready-codex-lifecycle-adapter'
import { TURN_TERMINAL_REASONS } from '../runtime-core/turn-frame'

const CANCELLED_TERMINAL_REASONS = new Set<NonNullable<ScopeRunEventPayload['terminalReason']>>([
  'cancelled_user',
  'cancelled_runtime',
  'main_no_progress_timeout',
])
const CHECKPOINT_TERMINAL_REASONS = new Set<NonNullable<ScopeRunEventPayload['terminalReason']>>([
  'checkpoint_budget',
  'checkpoint_incomplete',
  'checkpoint_background',
  'checkpoint_user_input',
  'checkpoint_steered',
  'manual_suspend',
])
const TERMINAL_REASON_SET = new Set<string>(TURN_TERMINAL_REASONS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => keys.includes(key))
}

function digestText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function digestJson(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string'
      ? createHash('sha256').update(serialized).digest('hex')
      : null
  } catch {
    // silent-catch: a value JSON cannot serialize has no digest, so the canonical message digest check fails
    return null
  }
}

function isScopeRunAuthority(value: unknown): boolean {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (!keys.every((key) => key === 'state' || key === 'reason' || key === 'currentRunId')) return false
  return value.state === 'lost'
    && (
      value.reason === 'superseded_by_newer_send'
      || value.reason === 'preempted_by_newer_send'
      || value.reason === 'preempted_by_same_user'
    )
    && (
      value.currentRunId === undefined
      || value.currentRunId === null
      || typeof value.currentRunId === 'string'
    )
}

function matchesCloseoutBodyReadback(
  readback: unknown,
  prepared: PreparedCodexProductRun,
  scope: ConversationScope,
): readback is ReadyCodexCloseoutReadback {
  if (
    !isRecord(readback)
    || !hasExactKeys(readback, [
      'execution',
      'productOutcomeDigest',
      'candidateBodyDigest',
      'committedTerminalEvent',
    ])
    || !isRecord(readback.execution)
  ) return false
  const { execution, productOutcomeDigest, candidateBodyDigest } = readback
  if (
    typeof productOutcomeDigest !== 'string'
    || productOutcomeDigest.trim().length === 0
    || typeof execution.success !== 'boolean'
    || typeof execution.cancelled !== 'boolean'
    || typeof execution.finalText !== 'string'
    || !Array.isArray(execution.usedTools)
    || !execution.usedTools.every((tool) => typeof tool === 'string')
    || execution.taskId !== prepared.taskId
    || (
      execution.taskProjectionId !== undefined
      && execution.taskProjectionId !== null
      && (
        typeof execution.taskProjectionId !== 'string'
        || execution.taskProjectionId !== prepared.taskId
      )
    )
    || !TERMINAL_REASON_SET.has(String(execution.terminalReason || ''))
    || !isScopeRunAuthority(execution.scopeRunAuthority)
  ) return false

  const canonical = execution.canonicalMessage
  if (
    !isRecord(canonical)
    || !hasExactKeys(canonical, ['id', 'conversationId', 'role', 'content', 'timestamp', 'meta'])
    || typeof canonical.id !== 'string'
    || canonical.id.trim().length === 0
    || canonical.conversationId !== scope.id
    || canonical.role !== 'assistant'
    || typeof canonical.content !== 'string'
    || canonical.content !== execution.finalText
    || typeof canonical.timestamp !== 'string'
    || !Number.isFinite(Date.parse(canonical.timestamp))
    || !isRecord(canonical.meta)
    || typeof execution.canonicalMessageDigest !== 'string'
    || execution.canonicalMessageDigest !== digestJson(canonical)
  ) return false
  if (!execution.success) {
    return typeof execution.error === 'string'
      && execution.error.trim().length > 0
      && (
        candidateBodyDigest === null
        || (typeof candidateBodyDigest === 'string' && /^[a-f0-9]{64}$/.test(candidateBodyDigest))
      )
  }
  if (
    execution.error !== undefined
    || execution.scopeRunAuthority !== undefined
    || typeof candidateBodyDigest !== 'string'
    || candidateBodyDigest !== digestText(execution.finalText)
  ) return false
  return true
}

function phaseAndReasonMatchExecution(
  event: Record<string, unknown>,
  execution: ExecutionHostResult,
): boolean {
  const reason = execution.terminalReason
  if (!reason || event.terminalReason !== reason) return false
  if (event.phase === 'done') {
    return execution.success && !execution.cancelled && reason === 'done'
  }
  if (event.phase === 'cancelled') {
    return !execution.success && execution.cancelled && CANCELLED_TERMINAL_REASONS.has(reason)
  }
  if (event.phase === 'checkpoint') {
    return !execution.success && !execution.cancelled && CHECKPOINT_TERMINAL_REASONS.has(reason)
  }
  if (event.phase === 'error') {
    return !execution.success
      && !execution.cancelled
      && reason !== 'done'
      && !CANCELLED_TERMINAL_REASONS.has(reason)
      && !CHECKPOINT_TERMINAL_REASONS.has(reason)
  }
  return false
}

function matchesCommittedTerminalEvent(
  event: unknown,
  execution: ExecutionHostResult,
  prepared: PreparedCodexProductRun,
  scope: ConversationScope,
): event is ScopeRunEventPayload {
  if (!isRecord(event)) return false
  return phaseAndReasonMatchExecution(event, execution)
    && event.type === 'updated'
    && event.scopeId === scope.id
    && event.agent === scope.agent
    && event.runId === prepared.runId
    && event.taskId === prepared.taskId
    && event.ownerAgentId === (scope.activeAgentId || scope.agent)
    && event.taskOrigin === 'user_root'
    && event.handoffGeneration === scope.handoffGeneration
    && event.taskProjectionId === (
      execution.taskProjectionId || execution.taskId || prepared.taskId
    )
    && typeof event.timestamp === 'string'
    && Number.isFinite(Date.parse(event.timestamp))
}

function isValidCloseoutReadback(
  value: unknown,
  prepared: PreparedCodexProductRun,
  scope: ConversationScope,
): value is ReadyCodexCloseoutReadback {
  return matchesCloseoutBodyReadback(value, prepared, scope)
    && matchesCommittedTerminalEvent(
      value.committedTerminalEvent,
      value.execution,
      prepared,
      scope,
    )
}

export type CodexRunCoordinatorRequest = {
  requestId: string
  scope: ConversationScope
  preparedCodexRun: PreparedCodexProductRun
}

export type CodexRunCoordinatorResult =
  | {
      success: true
      responseText: string
      canonicalMessage: NonNullable<ExecutionHostResult['canonicalMessage']>
      canonicalMessageDigest: string
      productOutcomeDigest: string
      productTurnReceipt: NonNullable<ExecutionHostResult['productTurnReceipt']>
    }
  | {
      success: false
      error: string
      errorKind: string
      productOutcomeDigest: string
      scopeRunAuthority?: ExecutionHostResult['scopeRunAuthority']
      canonicalMessage?: ExecutionHostResult['canonicalMessage']
      canonicalMessageDigest?: ExecutionHostResult['canonicalMessageDigest']
      productTurnReceipt?: ExecutionHostResult['productTurnReceipt']
    }

export type ReadyCodexCloseoutReadback = {
  execution: ExecutionHostResult
  productOutcomeDigest: string
  candidateBodyDigest: string | null
  committedTerminalEvent: ScopeRunEventPayload
}

type PendingCodexCloseoutOutcome = Extract<
  ReadyCodexExecutionOutcome<ReadyCodexCloseoutReadback>,
  { state: 'ready_closeout_pending' }
>

function closedCloseoutReadback(value: unknown): unknown | null {
  return isRecord(value)
    && hasExactKeys(value, ['state', 'result'])
    && value.state === 'closed'
    ? value.result
    : null
}

function pendingCloseoutOutcome(
  value: unknown,
  prepared: PreparedCodexProductRun,
  scope: ConversationScope,
): PendingCodexCloseoutOutcome | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'state',
      'pendingKind',
      'candidate',
      'recoveryEvidenceDigest',
      'error',
    ])
    || value.state !== 'ready_closeout_pending'
    || (
      value.pendingKind !== 'product_turn_engine_terminal_closeout_pending'
      && value.pendingKind !== 'host_failure_closeout_pending'
    )
    || !isRecord(value.candidate)
    || value.candidate.readyTaskId !== prepared.taskId
    || value.candidate.readyRunId !== prepared.runId
    || value.candidate.scopeId !== scope.id
    || (value.candidate.kind !== 'native_terminal' && value.candidate.kind !== 'host_failure')
    || typeof value.recoveryEvidenceDigest !== 'string'
    || value.recoveryEvidenceDigest.trim().length === 0
    || typeof value.error !== 'string'
    || value.error.trim().length === 0
  ) return null
  return value as PendingCodexCloseoutOutcome
}

export type CodexRunCoordinatorDeps = {
  executeCodexPrepared: (input: {
    prepared: PreparedCodexProductRun
    scope: ConversationScope
    emitStartedProjection: () => void
  }) => Promise<unknown>
  observeCodexCloseoutReadback: (
    input: {
      prepared: PreparedCodexProductRun
      scope: ConversationScope
      pending: PendingCodexCloseoutOutcome | null
    },
    onReadback: (readback: unknown) => void,
  ) => () => void
  emitStartedScopeRunEvent: (payload: ScopeRunEventPayload) => void
  publishCommittedTerminalEvent: (payload: ScopeRunEventPayload) => void
  onRunStarted: (input: {
    requestId: string
    prepared: PreparedCodexProductRun
    scope: ConversationScope
  }) => void
  onRunSettled: (input: {
    requestId: string
    prepared: PreparedCodexProductRun
    scope: ConversationScope
  }) => void
}

export class RunCoordinator {
  constructor(private readonly deps: CodexRunCoordinatorDeps) {}

  async runScoped(
    request: CodexRunCoordinatorRequest,
    hooks?: RunCompletionHooks,
  ): Promise<CodexRunCoordinatorResult> {
    const prepared = request.preparedCodexRun
    const activeRun = {
      requestId: request.requestId,
      prepared,
      scope: request.scope,
    }
    let runOwnershipStarted = false
    let terminalCloseoutValidated = false
    try {
      let closeoutOutcome: unknown = null
      try {
        closeoutOutcome = await this.deps.executeCodexPrepared({
          prepared,
          scope: request.scope,
          emitStartedProjection: () => {
            this.deps.onRunStarted(activeRun)
            runOwnershipStarted = true
            this.deps.emitStartedScopeRunEvent({
              type: 'started',
              scopeId: request.scope.id,
              aliasGeneration: prepared.conversationAlias.aliasGeneration,
              messageVisibilityEpoch: request.scope.messageVisibilityEpoch,
              visibilityOwnerKind: 'product_alias',
              agent: request.scope.agent,
              runId: prepared.runId,
              taskId: prepared.taskId,
              ownerAgentId: request.scope.activeAgentId || request.scope.agent,
              taskOrigin: 'user_root',
              handoffGeneration: request.scope.handoffGeneration,
              phase: prepared.neutralProjectionSeed.phase,
              taskTitle: prepared.neutralProjectionSeed.taskTitle,
              taskSummary: prepared.neutralProjectionSeed.taskSummary,
              taskProjectionId: prepared.taskId,
              taskType: 'direct_answer',
              module: 'system',
              executionDiagnostics: {
                taskId: prepared.taskId,
                budget: prepared.productBudgetSeed,
              },
              timestamp: new Date().toISOString(),
            })
          },
        })
      } catch (error) {
        console.error('[RunCoordinator] Codex execution outcome unavailable:', error)
      }
      const immediateReadback = closedCloseoutReadback(closeoutOutcome)
      const pending = pendingCloseoutOutcome(closeoutOutcome, prepared, request.scope)
      const outcome = isValidCloseoutReadback(immediateReadback, prepared, request.scope)
        ? immediateReadback
        : await this.waitForValidCloseout({
            prepared,
            scope: request.scope,
            pending,
          })
      const { execution: result, productOutcomeDigest, committedTerminalEvent } = outcome
      terminalCloseoutValidated = true
      const canonicalMessage = result.canonicalMessage
      const canonicalMessageDigest = result.canonicalMessageDigest
      try {
        this.deps.publishCommittedTerminalEvent(committedTerminalEvent)
      } catch (error) {
        console.error('[RunCoordinator] committed terminal notification failed:', error)
      }

      if (!result.success) {
        try {
          await hooks?.onFailure?.(result.error || 'Agent execution failed', result)
        } catch (error) {
          console.error('[RunCoordinator] failure hook failed after Ready closeout:', error)
        }
        return {
          success: false,
          error: result.error || 'Agent execution failed',
          errorKind: result.terminalReason || 'persistence_failed',
          scopeRunAuthority: result.scopeRunAuthority,
          canonicalMessage: result.canonicalMessage,
          canonicalMessageDigest: result.canonicalMessageDigest,
          productTurnReceipt: result.productTurnReceipt,
          productOutcomeDigest,
        }
      }
      try {
        await hooks?.onSuccess?.(result)
      } catch (error) {
        console.error('[RunCoordinator] success hook failed after Ready closeout:', error)
      }
      return {
        success: true,
        responseText: result.finalText,
        canonicalMessage: canonicalMessage as NonNullable<typeof canonicalMessage>,
        canonicalMessageDigest: canonicalMessageDigest as string,
        productTurnReceipt: result.productTurnReceipt as NonNullable<typeof result.productTurnReceipt>,
        productOutcomeDigest,
      }
    } finally {
      if (runOwnershipStarted && terminalCloseoutValidated) {
        try {
          this.deps.onRunSettled(activeRun)
        } catch (error) {
          console.error('[RunCoordinator] active-run settlement failed:', error)
        }
      }
    }
  }

  private waitForValidCloseout(
    input: {
      prepared: PreparedCodexProductRun
      scope: ConversationScope
      pending: PendingCodexCloseoutOutcome | null
    },
  ): Promise<ReadyCodexCloseoutReadback> {
    return new Promise((resolve) => {
      let unsubscribe = () => {}
      let resolved = false
      const onReadback = (readback: unknown) => {
        if (
          resolved
          || !isValidCloseoutReadback(readback, input.prepared, input.scope)
        ) return
        resolved = true
        unsubscribe()
        resolve(readback)
      }
      try {
        const observerUnsubscribe = this.deps.observeCodexCloseoutReadback(input, onReadback)
        if (typeof observerUnsubscribe !== 'function') {
          console.error('[RunCoordinator] pending closeout observer returned no unsubscribe')
          return
        }
        unsubscribe = observerUnsubscribe
        if (resolved) unsubscribe()
      } catch (error) {
        // Ingress is already durable. Keep the same product operation active;
        // a boot-time durable observer may resume it, but no fifth wire result
        // or retryable rejection is legal here.
        console.error('[RunCoordinator] pending closeout observer registration failed:', error)
      }
    })
  }
}
