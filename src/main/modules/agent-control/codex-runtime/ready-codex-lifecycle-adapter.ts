import { createHash } from 'node:crypto'

import type {
  CreateSessionRequest,
  CreateSessionResult,
  LifecycleResult,
  ProductLifecycleRequest,
  StopLifecycleRequest,
} from '../../../../shared/ipc-contracts/agent-runtime'
import {
  classifyLifecycleOperation,
  type LifecycleOperationFacts,
  type LifecycleOperationSnapshot,
} from '../../../../shared/ipc-contracts/agent-lifecycle-snapshot'
import type { PreparedCodexProductRun } from './codex-product-run-preparer'
import type {
  CodexNativeRuntime,
  CodexThread,
  CodexThreadStartParams,
  CodexTurn,
  CodexTurnStatus,
} from './codex-native-runtime'
import type {
  CodexTurnCollectionContext,
  CoreTurnCandidate,
  CodexHostFailureStage,
} from './codex-turn-collector'
import {
  CodexTurnCollector,
  createHostFailureCandidate,
} from './codex-turn-collector'
import {
  CodexTurnInputBuilder,
  type CodexTurnBuildContext,
} from './codex-turn-input-builder'
import { isCodexNoActiveTurnInterruptError } from './codex-app-server-client'

export type ReadyAliasIdentity = {
  aliasId: string
  aliasGeneration: number
}

export type ReadyStopIdentity = ReadyAliasIdentity & Pick<StopLifecycleRequest, 'readyRunId'>
export type ReadyProductLifecycleIdentity = ReadyAliasIdentity & Pick<ProductLifecycleRequest, 'readyRunId'>
export type ReadyLifecycleAction = 'stop' | 'close' | 'reset'

export type ReadyThreadBindingResolution =
  | { state: 'unstarted'; params: CodexThreadStartParams }
  | { state: 'loaded'; threadId: string }
  | { state: 'resume_required'; threadId: string }

export type ProductTurnCloseoutEvidence = {
  aliasId: string
  aliasGeneration: number
  codexThreadId: string
  codexTurnId: string
  terminal: Exclude<CodexTurnStatus, 'inProgress'>
  closeoutDigest: string
  fenceReleaseRevision: number
  lifecycleAction?: ReadyLifecycleAction
  lifecycleActionEvidenceDigest?: string
  retiredGeneration?: number
  retirementTransactionDigest?: string
  archiveIntentDigest?: string
  scopeClosureEvidenceDigest?: string | null
  newGeneration?: number | null
  newThreadBindingId?: string | null
}

export const RECOVERED_CLOSEOUT_TOMBSTONE_LIMIT = 256

export type CloseRetirementEvidence = {
  aliasId: string
  retiredGeneration: number
  retirementTransactionDigest: string
  archiveDisposition: 'not_required' | 'durable_cleanup_pending'
  archiveIntentDigest: string | null
  scopeClosureEvidenceDigest: string
  lastCommittedReadyTerminalTransactionDigest: string | null
  idleThreadReadDigest: string | null
  lastCommittedProductTerminalDigest: string | null
}

export interface ReadyCodexLifecycleStore {
  createAlias(request: CreateSessionRequest): Promise<CreateSessionResult>
  readAliasIdentity(aliasId: string): Promise<ReadyAliasIdentity>
  resolveThreadBinding(
    identity: ReadyAliasIdentity,
    prepared: PreparedCodexProductRun,
  ): Promise<ReadyThreadBindingResolution>
  bindStartedThread(input: {
    identity: ReadyAliasIdentity
    threadId: string
    sessionId: string
    parentThreadId: string | null
    forkedFromId: string | null
    cwd: string
    source: CodexThread['source']
    threadSource: CodexThread['threadSource']
  }): Promise<void>
  markThreadResumed(input: {
    identity: ReadyAliasIdentity
    threadId: string
    connectionEpoch: string
    preResumeThreadReadDigest: string
    resumedThreadDigest: string
  }): Promise<void>
  readLifecycleOperation(request: ReadyAliasIdentity): Promise<{
    identity: ReadyAliasIdentity
    activeReadyRunId: string | null
    activeManualCompactionId: string | null
    requestedAction: ReadyLifecycleAction | null
    facts: LifecycleOperationFacts
  }>
  requestProductInterrupt(input: {
    action: ReadyLifecycleAction
    identity: ReadyAliasIdentity
    readyRunId: string
    codexThreadId: string
    codexTurnId: string
  }): Promise<void>
  acknowledgeProductInterrupt(input: {
    identity: ReadyAliasIdentity
    readyRunId: string
    codexThreadId: string
    codexTurnId: string
  }): Promise<void>
  markProductInterruptUnknown(input: {
    identity: ReadyAliasIdentity
    readyRunId: string
    codexThreadId: string
    codexTurnId: string
  }): Promise<void>
  failureEvidenceDigest(input: {
    identity: ReadyAliasIdentity
    action: 'reset' | 'stop' | 'close' | 'manual_compact'
    snapshot: LifecycleOperationSnapshot
  }): string
  resetIdleAlias(input: {
    identity: ReadyAliasIdentity
    snapshot: 'idle_never_started' | 'idle_ready_terminal_no_native' | 'idle_native_thread'
  }): Promise<Extract<LifecycleResult, { ok: true; action: 'reset' }>>
  quarantineUnknownManualCompaction(input: {
    identity: ReadyAliasIdentity
    manualCompactionId: string
  }): Promise<Extract<LifecycleResult, { ok: true; action: 'reset' }>>
  awaitProductCloseout(
    identity: ReadyAliasIdentity,
    readyRunId: string,
  ): Promise<ProductTurnCloseoutEvidence>
  settleEngineTerminalUserStop(
    identity: ReadyStopIdentity,
    action?: ReadyLifecycleAction,
  ): Promise<ProductTurnCloseoutEvidence>
  settleReadbackTerminalUserStop(input: ReadyStopIdentity & {
    codexThreadId: string
    turn: CodexTurn
  }, action?: ReadyLifecycleAction): Promise<ProductTurnCloseoutEvidence>
  retryEngineTerminalUserStopFinalization(
    identity: ReadyStopIdentity,
  ): Promise<ProductTurnCloseoutEvidence | null>
  settleHostFailureCloseout(identity: ReadyAliasIdentity): Promise<void>
  retireAliasForClose(input: {
    identity: ReadyAliasIdentity
    snapshot: 'idle_never_started' | 'idle_ready_terminal_no_native' | 'idle_native_thread'
  }): Promise<CloseRetirementEvidence>
  beginManualCompaction(identity: ReadyAliasIdentity): Promise<{
    manualCompactionId: string
    threadId: string
  }>
  awaitManualCompaction(input: {
    identity: ReadyAliasIdentity
    manualCompactionId: string
  }): Promise<{ notificationContextCompactionItemId: string; codexTurnId: string }>
  consumeManualCompaction(input: {
    identity: ReadyAliasIdentity
    manualCompactionId: string
    notificationContextCompactionItemId: string | null
    contextCompactionItemId: string
    codexTurnId: string
    threadReadDigest: string
    terminalEvidenceDigest: string
  }): Promise<void>
  markManualCompactionUnknown(input: {
    identity: ReadyAliasIdentity
    manualCompactionId: string
    reason: string
  }): Promise<void>
  digestThreadRead(thread: unknown): string
}

export interface ReadyCodexThreadResumePort {
  readThenResume(input: {
    threadId: string
    validateRead(thread: CodexThread): void
  }): Promise<{
    connectionEpoch: string
    read: { thread: CodexThread }
    resumed: { thread: CodexThread; instructionSources: string[] }
  }>
}

export interface ReadyCodexCloseout<TExecutionResult> {
  closeCandidate(candidate: CoreTurnCandidate): Promise<TExecutionResult>
  recoverRejectedCandidate(input: {
    candidate: CoreTurnCandidate
    error: unknown
  }): TExecutionResult
  observeCandidateReadback(
    input: {
      candidate: CoreTurnCandidate | null
      readyTaskId: string
      readyRunId: string
      scopeId: string
      recoveryEvidenceDigest: string | null
    },
    onReadback: (result: TExecutionResult) => void,
  ): () => void
}

export type ReadyCodexExecutionOutcome<TExecutionResult> =
  | { state: 'closed'; result: TExecutionResult }
  | {
      state: 'ready_closeout_pending'
      pendingKind:
        | 'product_turn_engine_terminal_closeout_pending'
        | 'host_failure_closeout_pending'
      candidate: CoreTurnCandidate
      recoveryEvidenceDigest: string
      error: string
    }

export type CodexPreparedRunContext = {
  turnBuildContext: Omit<CodexTurnBuildContext, 'threadId'>
  collection: Omit<
    CodexTurnCollectionContext,
    'readyTaskId' | 'readyRunId' | 'scopeId' | 'codexThreadId' | 'startTurn'
  >
}

export type ExecutePreparedCodexRunInput = {
  prepared: PreparedCodexProductRun
  expectedScopeId: string
  emitStartedProjection: () => void
  resolveContext: () => Promise<CodexPreparedRunContext>
}

type LifecycleOperationRead = {
  snapshot: LifecycleOperationSnapshot
  facts: LifecycleOperationFacts
  activeReadyRunId: string | null
  activeManualCompactionId: string | null
  requestedAction: ReadyLifecycleAction | null
}

export class CodexIngressRejectedError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'CodexIngressRejectedError'
  }
}

export class ReadyCodexLifecyclePortError extends Error {
  constructor(
    readonly code:
      | 'interrupt_state_unknown'
      | 'compaction_state_unknown'
      | 'native_protocol_error'
      | 'binding_conflict'
      | 'thread_busy'
      | 'persistence_failed',
  ) {
    super(code)
    this.name = 'ReadyCodexLifecyclePortError'
  }
}

export class ReadyCodexLifecycleAdapter<TExecutionResult> {
  private readonly recoveredCloseoutWaiters = new Map<
    string,
    Set<(result: TExecutionResult) => void>
  >()
  private readonly recoveredCloseoutBuffer = new Map<string, TExecutionResult>()
  private readonly deliveredRecoveredCloseouts = new Set<string>()
  private readonly pendingRecoveredCloseoutRuns = new Set<string>()

  constructor(private readonly deps: {
    nativeRuntime: CodexNativeRuntime
    threadResumePort: ReadyCodexThreadResumePort
    collector: CodexTurnCollector
    inputBuilder: CodexTurnInputBuilder
    lifecycleStore: ReadyCodexLifecycleStore
    closeout: ReadyCodexCloseout<TExecutionResult>
  }) {}

  private async interruptExactTurn(input: {
    codexThreadId: string
    codexTurnId: string
  }): Promise<'acknowledged' | 'already_terminal'> {
    try {
      await this.deps.nativeRuntime.turnInterrupt({
        threadId: input.codexThreadId,
        turnId: input.codexTurnId,
      })
      return 'acknowledged'
    } catch (error) {
      if (!isCodexNoActiveTurnInterruptError(error)) throw error
      const read = await this.deps.nativeRuntime.threadRead({
        threadId: input.codexThreadId,
        includeTurns: true,
      })
      if (read.thread.id !== input.codexThreadId) throw error
      const matching = read.thread.turns.filter((turn) => turn.id === input.codexTurnId)
      if (matching.length !== 1 || matching[0].status === 'inProgress') throw error
      return 'already_terminal'
    }
  }

  private async readExactTurn(input: {
    codexThreadId: string
    codexTurnId: string
  }): Promise<CodexTurn> {
    const read = await this.deps.nativeRuntime.threadRead({
      threadId: input.codexThreadId,
      includeTurns: true,
    })
    if (read.thread.id !== input.codexThreadId) {
      throw new ReadyCodexLifecyclePortError('interrupt_state_unknown')
    }
    const matching = read.thread.turns.filter((turn) => turn.id === input.codexTurnId)
    if (matching.length !== 1) {
      throw new ReadyCodexLifecyclePortError('interrupt_state_unknown')
    }
    return matching[0]
  }

  async createSession(request: CreateSessionRequest): Promise<CreateSessionResult> {
    try {
      return await this.deps.lifecycleStore.createAlias(request)
    } catch {
      return {
        ok: false,
        action: 'create',
        code: 'persistence_failed',
        preserveUi: true,
        evidenceDigest: createHash('sha256')
          .update('codex-lifecycle:create:persistence_failed')
          .digest('hex'),
      }
    }
  }

  async executePreparedRun(
    input: ExecutePreparedCodexRunInput,
  ): Promise<ReadyCodexExecutionOutcome<TExecutionResult>> {
    let stage: CodexHostFailureStage = 'prepared_run_validation'
    let context: CodexPreparedRunContext | null = null
    let threadId: string | null = null
    let candidate: CoreTurnCandidate
    try {
      if (input.prepared.readyToolHostIdentity.scopeId !== input.expectedScopeId) {
        throw new CodexIngressRejectedError('invalid_product_ingress')
      }
      stage = 'started_projection'
      input.emitStartedProjection()
      stage = 'prepared_run_context'
      context = await input.resolveContext()
      stage = 'identity_read'
      const identity = await this.deps.lifecycleStore.readAliasIdentity(
        input.prepared.conversationAlias.aliasId,
      )
      if (identity.aliasGeneration !== input.prepared.conversationAlias.aliasGeneration) {
        throw new CodexIngressRejectedError('binding_conflict')
      }
      stage = 'thread_resolution'
      threadId = await this.ensureThread(identity, input.prepared)
      stage = 'turn_input'
      const turnInput = this.deps.inputBuilder.build(input.prepared.ingress, {
        ...context.turnBuildContext,
        threadId,
      })
      if (!turnInput.ok) throw new CodexIngressRejectedError(turnInput.code)

      stage = 'collection'
      candidate = await this.deps.collector.collect({
        ...context.collection,
        readyTaskId: input.prepared.taskId,
        readyRunId: input.prepared.runId,
        scopeId: input.prepared.readyToolHostIdentity.scopeId,
        codexThreadId: threadId,
        startTurn: () => this.deps.nativeRuntime.turnStart(turnInput.params),
      })
    } catch (error) {
      candidate = createHostFailureCandidate({
        ...(context?.collection || {
          actionReceiptRefs: [],
          interactionState: null,
          waitingFor: null,
          abortInitiator: null,
          budgetState: { ...input.prepared.productBudgetSeed },
          contextState: {},
          providerDiagnostics: {},
          recoveryCheckpointRef: null,
          browserContinuationRef: null,
          browserProofRefs: [],
          otherProofRefs: [],
          projectionPatchRefs: [],
        }),
        readyTaskId: input.prepared.taskId,
        readyRunId: input.prepared.runId,
        scopeId: input.prepared.readyToolHostIdentity.scopeId,
        codexThreadId: threadId,
      }, {
        stage,
        code: error instanceof CodexIngressRejectedError
          ? error.code
          : stage === 'started_projection'
            ? 'started_projection_failed'
            : stage === 'prepared_run_context'
              ? 'prepared_run_context_resolution_failed'
              : 'codex_host_failure',
        error,
        codexTurnId: null,
      })
    }
    this.pendingRecoveredCloseoutRuns.add(candidate.readyRunId)
    try {
      const result = await this.deps.closeout.closeCandidate(candidate)
      this.finishImmediateCloseout(candidate.readyRunId)
      this.deps.collector.releaseRun(input.prepared.runId)
      return {
        state: 'closed',
        result,
      }
    } catch (closeoutError) {
      try {
        const result = this.deps.closeout.recoverRejectedCandidate({
          candidate,
          error: closeoutError,
        })
        this.finishImmediateCloseout(candidate.readyRunId)
        this.deps.collector.releaseRun(input.prepared.runId)
        return {
          state: 'closed',
          result,
        }
      } catch (recoveryError) {
        const pending = this.pendingCloseout(candidate, [closeoutError, recoveryError])
        this.deps.collector.releaseRun(input.prepared.runId)
        return pending
      }
    }
  }

  observeRunCloseout(
    input: {
      prepared: PreparedCodexProductRun
      expectedScopeId: string
      pending: Extract<ReadyCodexExecutionOutcome<TExecutionResult>, { state: 'ready_closeout_pending' }> | null
    },
    onReadback: (result: TExecutionResult) => void,
  ): () => void {
    let stopped = false
    let unsubscribeObserved: () => void = () => undefined
    const waiters = this.recoveredCloseoutWaiters.get(input.prepared.runId) || new Set()
    const deliver = (result: TExecutionResult) => {
      if (stopped) return
      stopped = true
      waiters.delete(deliver)
      if (waiters.size === 0) this.recoveredCloseoutWaiters.delete(input.prepared.runId)
      this.pendingRecoveredCloseoutRuns.delete(input.prepared.runId)
      this.rememberRecoveredCloseout(input.prepared.runId)
      unsubscribeObserved()
      onReadback(result)
    }
    waiters.add(deliver)
    this.recoveredCloseoutWaiters.set(input.prepared.runId, waiters)
    const buffered = this.recoveredCloseoutBuffer.get(input.prepared.runId)
    if (buffered !== undefined) {
      this.recoveredCloseoutBuffer.delete(input.prepared.runId)
      deliver(buffered)
      return () => undefined
    }
    try {
      unsubscribeObserved = this.deps.closeout.observeCandidateReadback({
        candidate: input.pending?.candidate || null,
        readyTaskId: input.prepared.taskId,
        readyRunId: input.prepared.runId,
        scopeId: input.expectedScopeId,
        recoveryEvidenceDigest: input.pending?.recoveryEvidenceDigest || null,
      }, deliver)
      if (stopped) unsubscribeObserved()
    } catch (error) {
      waiters.delete(deliver)
      if (waiters.size === 0) this.recoveredCloseoutWaiters.delete(input.prepared.runId)
      throw error
    }
    return () => {
      if (stopped) return
      stopped = true
      waiters.delete(deliver)
      if (waiters.size === 0) this.recoveredCloseoutWaiters.delete(input.prepared.runId)
      unsubscribeObserved()
    }
  }

  deliverRecoveredCloseout(
    readyRunId: string,
    result: TExecutionResult,
  ): 'delivered' | 'buffered' | 'publish_only' | 'duplicate' {
    if (this.deliveredRecoveredCloseouts.has(readyRunId)) return 'duplicate'
    const waiters = this.recoveredCloseoutWaiters.get(readyRunId)
    if (!waiters?.size) {
      if (!this.pendingRecoveredCloseoutRuns.has(readyRunId)) {
        return 'publish_only'
      }
      this.recoveredCloseoutBuffer.set(readyRunId, result)
      return 'buffered'
    }
    this.rememberRecoveredCloseout(readyRunId)
    for (const waiter of [...waiters]) waiter(result)
    return 'delivered'
  }

  acknowledgePublishedRecoveredCloseout(readyRunId: string): void {
    this.rememberRecoveredCloseout(readyRunId)
  }

  private pendingCloseout(
    candidate: CoreTurnCandidate,
    errors: unknown[],
  ): Extract<ReadyCodexExecutionOutcome<TExecutionResult>, { state: 'ready_closeout_pending' }> {
    this.pendingRecoveredCloseoutRuns.add(candidate.readyRunId)
    const messages = errors.map((error) => error instanceof Error ? error.message : String(error))
    return {
      state: 'ready_closeout_pending',
      pendingKind: candidate.kind === 'host_failure'
        ? 'host_failure_closeout_pending'
        : 'product_turn_engine_terminal_closeout_pending',
      candidate,
      recoveryEvidenceDigest: createHash('sha256')
        .update([
          'ready-closeout-pending',
          candidate.readyTaskId,
          candidate.readyRunId,
          candidate.kind,
        ].join('\u0000'))
        .digest('hex'),
      error: messages[messages.length - 1] || 'ready_closeout_pending',
    }
  }

  private finishImmediateCloseout(readyRunId: string): void {
    this.pendingRecoveredCloseoutRuns.delete(readyRunId)
    this.recoveredCloseoutBuffer.delete(readyRunId)
    this.rememberRecoveredCloseout(readyRunId)
  }

  private rememberRecoveredCloseout(readyRunId: string): void {
    this.deliveredRecoveredCloseouts.delete(readyRunId)
    this.deliveredRecoveredCloseouts.add(readyRunId)
    while (this.deliveredRecoveredCloseouts.size > RECOVERED_CLOSEOUT_TOMBSTONE_LIMIT) {
      const oldest = this.deliveredRecoveredCloseouts.values().next().value as string | undefined
      if (!oldest) break
      this.deliveredRecoveredCloseouts.delete(oldest)
    }
  }

  async resetSession(request: ReadyProductLifecycleIdentity): Promise<LifecycleResult> {
    const resolved = await this.resolveOperation(request, 'reset')
    if (!resolved.ok) return resolved.result
    if (resolved.operation.activeReadyRunId !== request.readyRunId) {
      return this.failure(resolved.identity, 'reset', 'no_active_operation', resolved.operation.snapshot)
    }
    return this.resetFromSnapshot(resolved.identity, resolved.operation, false)
  }

  async stopSession(request: ReadyStopIdentity): Promise<LifecycleResult> {
    const resolved = await this.resolveOperation(request, 'stop')
    if (!resolved.ok) return resolved.result
    const { identity, operation } = resolved
    const { facts, snapshot } = operation
    if (operation.activeReadyRunId !== null && operation.activeReadyRunId !== request.readyRunId) {
      return this.failure(identity, 'stop', 'no_active_operation', snapshot)
    }
    const stopIdentity: ReadyStopIdentity = { ...identity, readyRunId: request.readyRunId }
    if (snapshot === 'product_turn_interruptible') {
      if (operation.activeReadyRunId !== request.readyRunId) {
        return this.failure(identity, 'stop', 'no_active_operation', snapshot)
      }
      let interruptRequested = false
      let interruptDisposition: 'acknowledged' | 'already_terminal' | null = null
      try {
        await this.deps.lifecycleStore.requestProductInterrupt({
          action: 'stop',
          identity,
          readyRunId: request.readyRunId,
          codexThreadId: facts.codexThreadId as string,
          codexTurnId: facts.codexTurnId as string,
        })
        interruptRequested = true
        interruptDisposition = await this.interruptExactTurn({
          codexThreadId: facts.codexThreadId as string,
          codexTurnId: facts.codexTurnId as string,
        })
        if (interruptDisposition === 'acknowledged') {
          await this.deps.lifecycleStore.acknowledgeProductInterrupt({
            identity,
            readyRunId: request.readyRunId,
            codexThreadId: facts.codexThreadId as string,
            codexTurnId: facts.codexTurnId as string,
          })
        }
      } catch (error) {
        if (interruptRequested) {
          await this.deps.lifecycleStore.markProductInterruptUnknown({
            identity,
            readyRunId: request.readyRunId,
            codexThreadId: facts.codexThreadId as string,
            codexTurnId: facts.codexTurnId as string,
          }).catch(() => undefined)
        }
        return this.failureFromError(
          identity,
          'stop',
          error,
          'interrupt_state_unknown',
          'product_turn_interrupt_unknown',
        )
      }
      try {
        return this.stopSuccess(await this.deps.lifecycleStore.awaitProductCloseout(
          identity,
          request.readyRunId,
        ))
      } catch (error) {
        if (interruptDisposition === 'acknowledged') {
          await this.deps.lifecycleStore.markProductInterruptUnknown({
            identity,
            readyRunId: request.readyRunId,
            codexThreadId: facts.codexThreadId as string,
            codexTurnId: facts.codexTurnId as string,
          }).catch(() => undefined)
        }
        return this.failureFromError(
          identity,
          'stop',
          error,
          interruptDisposition === 'already_terminal' ? 'persistence_failed' : 'interrupt_state_unknown',
          interruptDisposition === 'already_terminal'
            ? 'product_turn_engine_terminal_closeout_pending'
            : 'product_turn_interrupt_unknown',
        )
      }
    }
    if (snapshot === 'product_turn_interrupt_unknown') {
      if (operation.activeReadyRunId !== request.readyRunId) {
        return this.failure(identity, 'stop', 'no_active_operation', snapshot)
      }
      const codexThreadId = facts.codexThreadId as string
      const codexTurnId = facts.codexTurnId as string
      let turn: CodexTurn
      try {
        turn = await this.readExactTurn({ codexThreadId, codexTurnId })
      } catch (error) {
        return this.failureFromError(
          identity,
          'stop',
          error,
          'interrupt_state_unknown',
          snapshot,
        )
      }
      if (turn.status !== 'inProgress') {
        try {
          return this.stopSuccess(await this.deps.lifecycleStore.settleReadbackTerminalUserStop({
            ...stopIdentity,
            codexThreadId,
            turn,
          }))
        } catch (error) {
          return this.failureFromError(
            identity,
            'stop',
            error,
            'persistence_failed',
            'product_turn_engine_terminal_closeout_pending',
          )
        }
      }
      try {
        await this.deps.lifecycleStore.requestProductInterrupt({
          action: 'stop',
          identity,
          readyRunId: request.readyRunId,
          codexThreadId,
          codexTurnId,
        })
        const interruptDisposition = await this.interruptExactTurn({
          codexThreadId,
          codexTurnId,
        })
        if (interruptDisposition === 'acknowledged') {
          await this.deps.lifecycleStore.acknowledgeProductInterrupt({
            identity,
            readyRunId: request.readyRunId,
            codexThreadId,
            codexTurnId,
          })
        }
        return this.stopSuccess(await this.deps.lifecycleStore.awaitProductCloseout(
          identity,
          request.readyRunId,
        ))
      } catch (error) {
        await this.deps.lifecycleStore.markProductInterruptUnknown({
          identity,
          readyRunId: request.readyRunId,
          codexThreadId,
          codexTurnId,
        }).catch(() => undefined)
        return this.failureFromError(
          identity,
          'stop',
          error,
          'interrupt_state_unknown',
          snapshot,
        )
      }
    }
    if (snapshot === 'product_turn_engine_terminal_closeout_pending') {
      if (operation.activeReadyRunId !== request.readyRunId) {
        return this.failure(identity, 'stop', 'no_active_operation', snapshot)
      }
      try {
        return this.stopSuccess(
          await this.deps.lifecycleStore.settleEngineTerminalUserStop(stopIdentity),
        )
      } catch (error) {
        return this.failureFromError(identity, 'stop', error, 'persistence_failed', snapshot)
      }
    }
    if (snapshot === 'host_failure_closeout_pending') {
      try {
        await this.deps.lifecycleStore.settleHostFailureCloseout(identity)
      } catch (error) {
        return this.failureFromError(identity, 'stop', error, 'persistence_failed', snapshot)
      }
      return this.failure(identity, 'stop', 'no_active_operation', snapshot)
    }
    if (
      snapshot === 'idle_never_started'
      || snapshot === 'idle_ready_terminal_no_native'
      || snapshot === 'idle_native_thread'
    ) {
      try {
        const retried = await this.deps.lifecycleStore
          .retryEngineTerminalUserStopFinalization(stopIdentity)
        if (retried) return this.stopSuccess(retried)
      } catch (error) {
        return this.failureFromError(identity, 'stop', error, 'persistence_failed', snapshot)
      }
      return this.failure(identity, 'stop', 'no_active_operation', snapshot)
    }
    return this.failureForSnapshot(identity, 'stop', snapshot)
  }

  async closeSession(request: ReadyProductLifecycleIdentity): Promise<LifecycleResult> {
    const resolved = await this.resolveOperation(request, 'close')
    if (!resolved.ok) return resolved.result
    if (resolved.operation.activeReadyRunId !== request.readyRunId) {
      return this.failure(resolved.identity, 'close', 'no_active_operation', resolved.operation.snapshot)
    }
    const { identity, operation } = resolved
    const { facts, snapshot } = operation
    if (snapshot === 'product_turn_interruptible') {
      if (!operation.activeReadyRunId) {
        return this.failure(identity, 'close', 'no_active_operation', snapshot)
      }
      let interruptRequested = false
      let interruptDisposition: 'acknowledged' | 'already_terminal' | null = null
      try {
        await this.deps.lifecycleStore.requestProductInterrupt({
          action: 'close',
          identity,
          readyRunId: operation.activeReadyRunId,
          codexThreadId: facts.codexThreadId as string,
          codexTurnId: facts.codexTurnId as string,
        })
        interruptRequested = true
        interruptDisposition = await this.interruptExactTurn({
          codexThreadId: facts.codexThreadId as string,
          codexTurnId: facts.codexTurnId as string,
        })
        if (interruptDisposition === 'acknowledged') {
          await this.deps.lifecycleStore.acknowledgeProductInterrupt({
            identity,
            readyRunId: operation.activeReadyRunId,
            codexThreadId: facts.codexThreadId as string,
            codexTurnId: facts.codexTurnId as string,
          })
        }
      } catch (error) {
        if (interruptRequested) {
          await this.deps.lifecycleStore.markProductInterruptUnknown({
            identity,
            readyRunId: operation.activeReadyRunId,
            codexThreadId: facts.codexThreadId as string,
            codexTurnId: facts.codexTurnId as string,
          }).catch(() => undefined)
        }
        return this.failureFromError(
          identity,
          'close',
          error,
          'interrupt_state_unknown',
          'product_turn_interrupt_unknown',
        )
      }
      return this.closeCompletedProductTurn(
        identity,
        operation.activeReadyRunId,
        snapshot,
        interruptDisposition === 'already_terminal' ? 'persistence_failed' : 'interrupt_state_unknown',
        interruptDisposition === 'already_terminal'
          ? undefined
          : {
              codexThreadId: facts.codexThreadId as string,
              codexTurnId: facts.codexTurnId as string,
            },
      )
    }
    if (snapshot === 'product_turn_interrupt_unknown') {
      return this.reconcileUnknownProductLifecycleAction(identity, operation, 'close')
    }
    if (snapshot === 'product_turn_engine_terminal_closeout_pending') {
      if (!operation.activeReadyRunId) {
        return this.failure(identity, 'close', 'no_active_operation', snapshot)
      }
      return this.closeCompletedProductTurn(
        identity,
        operation.activeReadyRunId,
        snapshot,
        'persistence_failed',
      )
    }
    return this.closeFromSnapshot(identity, operation, false)
  }

  async compactSession(request: ReadyAliasIdentity): Promise<LifecycleResult> {
    const resolved = await this.resolveOperation(request, 'manual_compact')
    if (!resolved.ok) return resolved.result
    const { identity, operation: { snapshot } } = resolved
    if (snapshot !== 'idle_native_thread') {
      if (snapshot === 'idle_never_started' || snapshot === 'idle_ready_terminal_no_native') {
        return this.failure(identity, 'manual_compact', 'no_active_operation', snapshot)
      }
      return this.failureForSnapshot(identity, 'manual_compact', snapshot)
    }

    let binding: Awaited<ReturnType<ReadyCodexLifecycleStore['beginManualCompaction']>>
    try {
      binding = await this.deps.lifecycleStore.beginManualCompaction(identity)
    } catch (error) {
      return this.failureFromError(identity, 'manual_compact', error, 'persistence_failed', snapshot)
    }
    try {
      await this.deps.nativeRuntime.threadCompactStart({ threadId: binding.threadId })
    } catch (error) {
      return this.failureFromError(
        identity,
        'manual_compact',
        error,
        'compaction_state_unknown',
        'manual_compaction_unknown',
      )
    }
    let completed: Awaited<ReturnType<ReadyCodexLifecycleStore['awaitManualCompaction']>>
    try {
      completed = await this.deps.lifecycleStore.awaitManualCompaction({
        identity,
        manualCompactionId: binding.manualCompactionId,
      })
    } catch (error) {
      await this.markManualCompactionUnknown(identity, binding.manualCompactionId, error)
      return this.failureFromError(
        identity,
        'manual_compact',
        error,
        'compaction_state_unknown',
        'manual_compaction_unknown',
      )
    }
    let readback: Awaited<ReturnType<CodexNativeRuntime['threadRead']>>
    try {
      readback = await this.deps.nativeRuntime.threadRead({
        threadId: binding.threadId,
        includeTurns: true,
      })
    } catch (error) {
      await this.markManualCompactionUnknown(identity, binding.manualCompactionId, error)
      return this.failureFromError(
        identity,
        'manual_compact',
        error,
        'compaction_state_unknown',
        'manual_compaction_unknown',
      )
    }
    let threadReadDigest: string
    let terminalEvidenceDigest: string
    let contextCompactionItemId: string
    try {
      if (readback.thread.id !== binding.threadId) {
        throw new Error('manual_compaction_thread_readback_mismatch')
      }
      const turns = readback.thread.turns.filter((turn) => turn.id === completed.codexTurnId)
      if (turns.length !== 1 || turns[0].status !== 'completed') {
        throw new Error('manual_compaction_terminal_readback_mismatch')
      }
      const compactionItems = turns[0].items.filter((item) => item.type === 'contextCompaction')
      if (
        compactionItems.length !== 1
        || turns[0].items.some((item) => item.type === 'dynamicToolCall' || item.type === 'userMessage')
      ) throw new Error('manual_compaction_item_readback_mismatch')
      contextCompactionItemId = compactionItems[0].id
      threadReadDigest = this.deps.lifecycleStore.digestThreadRead(readback.thread)
      terminalEvidenceDigest = this.deps.lifecycleStore.digestThreadRead(turns[0])
    } catch (error) {
      await this.markManualCompactionUnknown(identity, binding.manualCompactionId, error)
      return this.failureFromError(
        identity,
        'manual_compact',
        error,
        'compaction_state_unknown',
        'manual_compaction_unknown',
      )
    }
    try {
      await this.deps.lifecycleStore.consumeManualCompaction({
        identity,
        manualCompactionId: binding.manualCompactionId,
        notificationContextCompactionItemId: completed.notificationContextCompactionItemId,
        contextCompactionItemId,
        codexTurnId: completed.codexTurnId,
        threadReadDigest,
        terminalEvidenceDigest,
      })
    } catch (error) {
      return this.failureFromError(identity, 'manual_compact', error, 'persistence_failed', snapshot)
    }
    return {
      ok: true,
      action: 'manual_compact',
      aliasId: identity.aliasId,
      manualCompactionId: binding.manualCompactionId,
      contextCompactionItemId,
      codexTurnId: completed.codexTurnId,
      threadReadDigest,
    }
  }

  private async markManualCompactionUnknown(
    identity: ReadyAliasIdentity,
    manualCompactionId: string,
    error: unknown,
  ): Promise<void> {
    try {
      await this.deps.lifecycleStore.markManualCompactionUnknown({
        identity,
        manualCompactionId,
        reason: error instanceof Error ? error.message : String(error),
      })
    } catch {
      // The lifecycle result must remain unknown even if its durable marker cannot be written.
    }
  }

  private async ensureThread(
    identity: ReadyAliasIdentity,
    prepared: PreparedCodexProductRun,
  ): Promise<string> {
    const resolution = await this.deps.lifecycleStore.resolveThreadBinding(identity, prepared)
    if (resolution.state === 'loaded') return resolution.threadId
    if (resolution.state === 'resume_required') {
      const { connectionEpoch, read, resumed } = await this.deps.threadResumePort.readThenResume({
        threadId: resolution.threadId,
        validateRead: (thread) => this.assertRootThread(thread, resolution.threadId, []),
      })
      const preResumeThreadReadDigest = this.deps.lifecycleStore.digestThreadRead(read.thread)
      this.assertRootThread(resumed.thread, resolution.threadId, resumed.instructionSources)
      await this.deps.lifecycleStore.markThreadResumed({
        identity,
        threadId: resolution.threadId,
        connectionEpoch,
        preResumeThreadReadDigest,
        resumedThreadDigest: this.deps.lifecycleStore.digestThreadRead(resumed.thread),
      })
      return resolution.threadId
    }
    const started = await this.deps.nativeRuntime.threadStart(resolution.params)
    this.assertRootThread(started.thread, started.thread.id, started.instructionSources)
    if (started.thread.cwd !== resolution.params.cwd) {
      throw new CodexIngressRejectedError('native_thread_cwd_mismatch')
    }
    await this.deps.lifecycleStore.bindStartedThread({
      identity,
      threadId: started.thread.id,
      sessionId: started.thread.sessionId,
      parentThreadId: started.thread.parentThreadId,
      forkedFromId: started.thread.forkedFromId,
      cwd: started.thread.cwd,
      source: started.thread.source,
      threadSource: started.thread.threadSource,
    })
    return started.thread.id
  }

  private async resolveOperation(
    request: ReadyAliasIdentity,
    action: 'reset' | 'stop' | 'close' | 'manual_compact',
  ): Promise<
    | { ok: true; identity: ReadyAliasIdentity; operation: LifecycleOperationRead }
    | { ok: false; result: Extract<LifecycleResult, { ok: false }> }
  > {
    let read: {
      identity: ReadyAliasIdentity
      activeReadyRunId: string | null
      activeManualCompactionId: string | null
      requestedAction: ReadyLifecycleAction | null
      facts: LifecycleOperationFacts
    }
    try {
      read = await this.deps.lifecycleStore.readLifecycleOperation(request)
    } catch {
      return {
        ok: false,
        result: this.failure(request, action, 'persistence_failed', 'invariant_violation'),
      }
    }
    const { identity } = read
    if (
      identity.aliasId !== request.aliasId
      || identity.aliasGeneration !== request.aliasGeneration
    ) {
      return {
        ok: false,
        result: this.failure(request, action, 'binding_conflict', 'invariant_violation'),
      }
    }
    if (read.requestedAction && read.requestedAction !== action) {
      return {
        ok: false,
        result: this.failure(identity, action, 'binding_conflict', 'invariant_violation'),
      }
    }
    const facts = { ...read.facts }
    return {
      ok: true,
      identity,
      operation: {
        facts,
        activeReadyRunId: read.activeReadyRunId,
        activeManualCompactionId: read.activeManualCompactionId,
        requestedAction: read.requestedAction,
        snapshot: classifyLifecycleOperation(facts),
      },
    }
  }

  private assertRootThread(
    thread: Pick<
      CodexThread,
      'id' | 'sessionId' | 'parentThreadId' | 'forkedFromId' | 'source' | 'threadSource'
    >,
    expectedThreadId: string,
    instructionSources: string[],
  ): void {
    if (
      thread.id !== expectedThreadId
      || thread.sessionId !== thread.id
      || thread.parentThreadId !== null
      || thread.forkedFromId !== null
      || thread.source !== 'vscode'
      || thread.threadSource !== null
      || instructionSources.length !== 0
    ) {
      throw new CodexIngressRejectedError('native_thread_identity_mismatch')
    }
  }

  private async resetFromSnapshot(
    identity: ReadyAliasIdentity,
    operation: LifecycleOperationRead,
    alreadyResnapshotted: boolean,
  ): Promise<LifecycleResult> {
    const { facts, snapshot } = operation
    if (
      snapshot === 'idle_never_started'
      || snapshot === 'idle_ready_terminal_no_native'
      || snapshot === 'idle_native_thread'
    ) {
      try {
        return await this.deps.lifecycleStore.resetIdleAlias({ identity, snapshot })
      } catch (error) {
        return this.failureFromError(identity, 'reset', error, 'persistence_failed', snapshot)
      }
    }
    if (snapshot === 'manual_compaction_unknown') {
      if (!operation.activeManualCompactionId) {
        return this.failure(identity, 'reset', 'native_protocol_error', 'invariant_violation')
      }
      try {
        return await this.deps.lifecycleStore.quarantineUnknownManualCompaction({
          identity,
          manualCompactionId: operation.activeManualCompactionId,
        })
      } catch (error) {
        return this.failureFromError(identity, 'reset', error, 'persistence_failed', snapshot)
      }
    }
    if (snapshot === 'product_turn_interruptible') {
      if (!operation.activeReadyRunId) {
        return this.failure(identity, 'reset', 'no_active_operation', snapshot)
      }
      let interruptRequested = false
      let interruptDisposition: 'acknowledged' | 'already_terminal' | null = null
      try {
        await this.deps.lifecycleStore.requestProductInterrupt({
          action: 'reset',
          identity,
          readyRunId: operation.activeReadyRunId,
          codexThreadId: facts.codexThreadId as string,
          codexTurnId: facts.codexTurnId as string,
        })
        interruptRequested = true
        interruptDisposition = await this.interruptExactTurn({
          codexThreadId: facts.codexThreadId as string,
          codexTurnId: facts.codexTurnId as string,
        })
        if (interruptDisposition === 'acknowledged') {
          await this.deps.lifecycleStore.acknowledgeProductInterrupt({
            identity,
            readyRunId: operation.activeReadyRunId,
            codexThreadId: facts.codexThreadId as string,
            codexTurnId: facts.codexTurnId as string,
          })
        }
        const closeout = await this.deps.lifecycleStore.awaitProductCloseout(
          identity,
          operation.activeReadyRunId,
        )
        return this.resetActionSuccess(closeout)
      } catch (error) {
        if (interruptRequested && interruptDisposition !== 'already_terminal') {
          await this.deps.lifecycleStore.markProductInterruptUnknown({
            identity,
            readyRunId: operation.activeReadyRunId,
            codexThreadId: facts.codexThreadId as string,
            codexTurnId: facts.codexTurnId as string,
          }).catch(() => undefined)
        }
        return this.failureFromError(
          identity,
          'reset',
          error,
          interruptDisposition === 'already_terminal' ? 'persistence_failed' : 'interrupt_state_unknown',
          interruptDisposition === 'already_terminal'
            ? 'product_turn_engine_terminal_closeout_pending'
            : 'product_turn_interrupt_unknown',
        )
      }
    }
    if (snapshot === 'product_turn_interrupt_unknown') {
      return this.reconcileUnknownProductLifecycleAction(identity, operation, 'reset')
    }
    if (snapshot === 'product_turn_engine_terminal_closeout_pending') {
      try {
        if (!operation.activeReadyRunId) {
          return this.failure(identity, 'reset', 'no_active_operation', snapshot)
        }
        return this.resetActionSuccess(
          await this.deps.lifecycleStore.settleEngineTerminalUserStop({
            ...identity,
            readyRunId: operation.activeReadyRunId,
          }, 'reset'),
        )
      } catch (error) {
        return this.failureFromError(identity, 'reset', error, 'persistence_failed', snapshot)
      }
    }
    if (snapshot === 'host_failure_closeout_pending' && !alreadyResnapshotted) {
      try {
        await this.deps.lifecycleStore.settleHostFailureCloseout(identity)
      } catch (error) {
        return this.failureFromError(identity, 'reset', error, 'persistence_failed', snapshot)
      }
      const resnapshot = await this.resolveOperation(identity, 'reset')
      if (!resnapshot.ok) return resnapshot.result
      if (
        resnapshot.operation.activeReadyRunId !== null
        || (
          resnapshot.operation.snapshot !== 'idle_never_started'
          && resnapshot.operation.snapshot !== 'idle_ready_terminal_no_native'
          && resnapshot.operation.snapshot !== 'idle_native_thread'
        )
      ) {
        return this.failure(identity, 'reset', 'binding_conflict', resnapshot.operation.snapshot)
      }
      return this.resetFromSnapshot(identity, resnapshot.operation, true)
    }
    return this.failureForSnapshot(identity, 'reset', snapshot)
  }

  private async closeFromSnapshot(
    identity: ReadyAliasIdentity,
    operation: LifecycleOperationRead,
    alreadyResnapshotted: boolean,
  ): Promise<LifecycleResult> {
    const { snapshot } = operation
    if (
      snapshot !== 'idle_never_started'
      && snapshot !== 'idle_ready_terminal_no_native'
      && snapshot !== 'idle_native_thread'
    ) {
      if (snapshot === 'host_failure_closeout_pending' && !alreadyResnapshotted) {
        try {
          await this.deps.lifecycleStore.settleHostFailureCloseout(identity)
        } catch (error) {
          return this.failureFromError(identity, 'close', error, 'persistence_failed', snapshot)
        }
        const resnapshot = await this.resolveOperation(identity, 'close')
        if (!resnapshot.ok) return resnapshot.result
        if (
          resnapshot.operation.activeReadyRunId !== null
          || (
            resnapshot.operation.snapshot !== 'idle_never_started'
            && resnapshot.operation.snapshot !== 'idle_ready_terminal_no_native'
            && resnapshot.operation.snapshot !== 'idle_native_thread'
          )
        ) {
          return this.failure(identity, 'close', 'binding_conflict', resnapshot.operation.snapshot)
        }
        return this.closeFromSnapshot(identity, resnapshot.operation, true)
      }
      return this.failureForSnapshot(identity, 'close', snapshot)
    }

    let retirement: CloseRetirementEvidence
    try {
      retirement = await this.deps.lifecycleStore.retireAliasForClose({ identity, snapshot })
    } catch (error) {
      return this.failureFromError(identity, 'close', error, 'persistence_failed', snapshot)
    }
    if (snapshot === 'idle_never_started') {
      return {
        ok: true,
        action: 'close',
        closeoutDisposition: 'never_started',
        aliasId: retirement.aliasId,
        retiredGeneration: retirement.retiredGeneration,
        retirementTransactionDigest: retirement.retirementTransactionDigest,
        archiveDisposition: 'not_required',
        scopeClosureEvidenceDigest: retirement.scopeClosureEvidenceDigest,
      }
    }
    if (snapshot === 'idle_ready_terminal_no_native') {
      if (!retirement.lastCommittedReadyTerminalTransactionDigest) {
        return this.failure(identity, 'close', 'native_protocol_error', 'invariant_violation')
      }
      return {
        ok: true,
        action: 'close',
        closeoutDisposition: 'ready_terminal_no_native_thread',
        aliasId: retirement.aliasId,
        retiredGeneration: retirement.retiredGeneration,
        lastCommittedReadyTerminalTransactionDigest:
          retirement.lastCommittedReadyTerminalTransactionDigest,
        retirementTransactionDigest: retirement.retirementTransactionDigest,
        archiveDisposition: 'not_required',
        scopeClosureEvidenceDigest: retirement.scopeClosureEvidenceDigest,
      }
    }
    if (!retirement.idleThreadReadDigest || !retirement.lastCommittedProductTerminalDigest) {
      return this.failure(identity, 'close', 'native_protocol_error', 'invariant_violation')
    }
    if (!retirement.archiveIntentDigest
      || retirement.archiveDisposition !== 'durable_cleanup_pending') {
      return this.failure(identity, 'close', 'persistence_failed', 'invariant_violation')
    }
    return {
      ok: true,
      action: 'close',
      closeoutDisposition: 'native_thread_idle',
      aliasId: retirement.aliasId,
      retiredGeneration: retirement.retiredGeneration,
      idleThreadReadDigest: retirement.idleThreadReadDigest,
      lastCommittedProductTerminalDigest: retirement.lastCommittedProductTerminalDigest,
      retirementTransactionDigest: retirement.retirementTransactionDigest,
      archiveDisposition: retirement.archiveDisposition,
      archiveIntentDigest: retirement.archiveIntentDigest,
      scopeClosureEvidenceDigest: retirement.scopeClosureEvidenceDigest,
    }
  }

  private stopSuccess(evidence: ProductTurnCloseoutEvidence): LifecycleResult {
    return {
      ok: true,
      action: 'stop',
      aliasId: evidence.aliasId,
      codexThreadId: evidence.codexThreadId,
      codexTurnId: evidence.codexTurnId,
      terminal: evidence.terminal,
      closeoutDigest: evidence.closeoutDigest,
      fenceReleaseRevision: evidence.fenceReleaseRevision,
    }
  }

  private resetActionSuccess(evidence: ProductTurnCloseoutEvidence): LifecycleResult {
    if (evidence.lifecycleAction !== 'reset'
      || evidence.retiredGeneration !== evidence.aliasGeneration
      || evidence.newGeneration !== evidence.aliasGeneration + 1
      || !evidence.newThreadBindingId
      || !evidence.retirementTransactionDigest) {
      throw new ReadyCodexLifecyclePortError('persistence_failed')
    }
    return {
      ok: true,
      action: 'reset',
      aliasId: evidence.aliasId,
      retiredGeneration: evidence.retiredGeneration,
      newGeneration: evidence.newGeneration,
      transactionDigest: evidence.retirementTransactionDigest,
    }
  }

  private closeActionSuccess(evidence: ProductTurnCloseoutEvidence): LifecycleResult {
    if (evidence.lifecycleAction !== 'close'
      || evidence.retiredGeneration !== evidence.aliasGeneration
      || evidence.newGeneration !== null
      || evidence.newThreadBindingId !== null
      || !evidence.retirementTransactionDigest
      || !evidence.archiveIntentDigest
      || evidence.scopeClosureEvidenceDigest !== evidence.retirementTransactionDigest) {
      throw new ReadyCodexLifecyclePortError('persistence_failed')
    }
    return {
      ok: true,
      action: 'close',
      closeoutDisposition: 'completed_active_product_turn',
      aliasId: evidence.aliasId,
      retiredGeneration: evidence.retiredGeneration,
      codexThreadId: evidence.codexThreadId,
      codexTurnId: evidence.codexTurnId,
      terminal: evidence.terminal,
      closeoutDigest: evidence.closeoutDigest,
      retirementTransactionDigest: evidence.retirementTransactionDigest,
      archiveDisposition: 'durable_cleanup_pending',
      archiveIntentDigest: evidence.archiveIntentDigest,
      scopeClosureEvidenceDigest: evidence.scopeClosureEvidenceDigest,
    }
  }

  private async reconcileUnknownProductLifecycleAction(
    identity: ReadyAliasIdentity,
    operation: LifecycleOperationRead,
    action: 'close' | 'reset',
  ): Promise<LifecycleResult> {
    const { facts, snapshot } = operation
    if (!operation.activeReadyRunId || operation.requestedAction !== action) {
      return this.failure(identity, action, 'binding_conflict', snapshot)
    }
    const readyRunId = operation.activeReadyRunId
    const codexThreadId = facts.codexThreadId as string
    const codexTurnId = facts.codexTurnId as string
    let turn: CodexTurn
    try {
      turn = await this.readExactTurn({ codexThreadId, codexTurnId })
    } catch (error) {
      return this.failureFromError(
        identity,
        action,
        error,
        'interrupt_state_unknown',
        snapshot,
      )
    }
    let closeout: ProductTurnCloseoutEvidence
    if (turn.status !== 'inProgress') {
      try {
        closeout = await this.deps.lifecycleStore.settleReadbackTerminalUserStop({
          ...identity,
          readyRunId,
          codexThreadId,
          turn,
        }, action)
      } catch (error) {
        return this.failureFromError(
          identity,
          action,
          error,
          'persistence_failed',
          'product_turn_engine_terminal_closeout_pending',
        )
      }
    } else {
      try {
        await this.deps.lifecycleStore.requestProductInterrupt({
          action,
          identity,
          readyRunId,
          codexThreadId,
          codexTurnId,
        })
        const interruptDisposition = await this.interruptExactTurn({
          codexThreadId,
          codexTurnId,
        })
        if (interruptDisposition === 'acknowledged') {
          await this.deps.lifecycleStore.acknowledgeProductInterrupt({
            identity,
            readyRunId,
            codexThreadId,
            codexTurnId,
          })
        }
        closeout = await this.deps.lifecycleStore.awaitProductCloseout(identity, readyRunId)
      } catch (error) {
        await this.deps.lifecycleStore.markProductInterruptUnknown({
          identity,
          readyRunId,
          codexThreadId,
          codexTurnId,
        }).catch(() => undefined)
        return this.failureFromError(
          identity,
          action,
          error,
          'interrupt_state_unknown',
          snapshot,
        )
      }
    }
    try {
      return action === 'close'
        ? this.closeActionSuccess(closeout)
        : this.resetActionSuccess(closeout)
    } catch (error) {
      return this.failureFromError(identity, action, error, 'persistence_failed', snapshot)
    }
  }

  private async closeCompletedProductTurn(
    identity: ReadyAliasIdentity,
    readyRunId: string,
    snapshot: LifecycleOperationSnapshot,
    fallbackCode: 'interrupt_state_unknown' | 'persistence_failed',
    interruptedIdentity?: { codexThreadId: string; codexTurnId: string },
  ): Promise<LifecycleResult> {
    let closeout: ProductTurnCloseoutEvidence
    try {
      closeout = snapshot === 'product_turn_engine_terminal_closeout_pending'
        ? await this.deps.lifecycleStore.settleEngineTerminalUserStop({
            ...identity,
            readyRunId,
          }, 'close')
        : await this.deps.lifecycleStore.awaitProductCloseout(
            identity,
            readyRunId,
          )
    } catch (error) {
      if (interruptedIdentity) {
        await this.deps.lifecycleStore.markProductInterruptUnknown({
          identity,
          readyRunId,
          ...interruptedIdentity,
        }).catch(() => undefined)
      }
      return this.failureFromError(
        identity,
        'close',
        error,
        fallbackCode,
        fallbackCode === 'interrupt_state_unknown'
          ? 'product_turn_interrupt_unknown'
          : snapshot,
      )
    }
    try {
      return this.closeActionSuccess(closeout)
    } catch (error) {
      return this.failureFromError(identity, 'close', error, 'persistence_failed', snapshot)
    }
  }

  private failureFromError(
    identity: ReadyAliasIdentity,
    action: 'reset' | 'stop' | 'close' | 'manual_compact',
    error: unknown,
    fallbackCode: Extract<LifecycleResult, { ok: false }>['code'],
    snapshot: LifecycleOperationSnapshot,
  ): LifecycleResult {
    const code = error instanceof ReadyCodexLifecyclePortError ? error.code : fallbackCode
    return this.failure(identity, action, code, snapshot)
  }

  private failureForSnapshot(
    identity: ReadyAliasIdentity,
    action: 'reset' | 'stop' | 'close' | 'manual_compact',
    snapshot: LifecycleOperationSnapshot,
  ): LifecycleResult {
    if (snapshot === 'product_turn_interrupt_unknown') {
      return this.failure(identity, action, 'interrupt_state_unknown', snapshot)
    }
    if (snapshot === 'manual_compaction_unknown') {
      return this.failure(identity, action, 'compaction_state_unknown', snapshot)
    }
    if (
      snapshot === 'thread_start_pending'
      || snapshot === 'turn_start_pending'
      || snapshot === 'manual_compaction_pending'
    ) {
      return this.failure(identity, action, 'thread_busy', snapshot)
    }
    return this.failure(identity, action, 'native_protocol_error', snapshot)
  }

  private failure(
    identity: ReadyAliasIdentity,
    action: 'reset' | 'stop' | 'close' | 'manual_compact',
    code: Extract<LifecycleResult, { ok: false }>['code'],
    snapshot: LifecycleOperationSnapshot,
  ): Extract<LifecycleResult, { ok: false }> {
    let evidenceDigest = ''
    try {
      evidenceDigest = this.deps.lifecycleStore.failureEvidenceDigest({
        identity,
        action,
        snapshot,
      })
    } catch {
      // A diagnostic helper cannot turn an exact lifecycle failure into a rejected Promise.
    }
    if (!evidenceDigest.trim()) {
      evidenceDigest = createHash('sha256')
        .update(JSON.stringify({
          contract: 'ready-codex-lifecycle-failure-v1',
          identity,
          action,
          code,
          snapshot,
        }))
        .digest('hex')
    }
    return {
      ok: false,
      action,
      code,
      preserveUi: true,
      aliasId: identity.aliasId,
      aliasGeneration: identity.aliasGeneration,
      evidenceDigest,
    }
  }
}
