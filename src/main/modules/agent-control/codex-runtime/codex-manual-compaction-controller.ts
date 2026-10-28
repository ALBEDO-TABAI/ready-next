import { randomUUID } from 'node:crypto'

import type {
  CodexBindingRepository,
  CodexManualCompactionRecovery,
} from './codex-binding-repository'
import type { CodexModelGatewayRepository } from './codex-model-gateway-authority'
import { digestCanonicalJson } from './codex-model-gateway-contract'
import type { CodexProvisionalInboundBuffer } from './codex-provisional-inbound-buffer'
import type { CodexSidecarSession } from './codex-sidecar-session'
import { ReadyCodexLifecyclePortError, type ReadyAliasIdentity } from './ready-codex-lifecycle-adapter'
import type { CodexThread, CodexTurn } from './codex-native-runtime'

type ManualOperation = {
  identity: ReadyAliasIdentity
  connectionEpoch: string
  threadId: string
  deadlineAtMs: number
  session: CodexSidecarSession
  inboundBuffer: CodexProvisionalInboundBuffer
  upstreamProfileSnapshotDigest: string
  preDispatchTurnIds: string[]
}

function isManualRecoveryCancellation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message === 'manual_compaction_recovery_stopped'
    || message === 'manual_compaction_recovery_generation_advanced'
}

function manualRecoveryCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : ''
  if (code) return code
  return error instanceof Error ? error.message : String(error)
}

function isRetryableManualRecoveryError(error: unknown): boolean {
  const code = manualRecoveryCode(error)
  return code === 'SQLITE_BUSY'
    || code === 'SQLITE_LOCKED'
    || code === 'sidecar_stdin_closed'
    || code === 'child_write_failed'
}

export class CodexManualCompactionController {
  private readonly operations = new Map<string, ManualOperation>()
  private readonly recoveryJobs = new Map<string, Promise<void>>()
  private stopping = false
  private resolveRecoveryGenerationStop: (() => void) | null = null
  private recoveryGenerationStopSignal: Promise<void>

  constructor(private readonly deps: {
    repository: CodexBindingRepository
    gatewayRepository: CodexModelGatewayRepository
    getSession: () => CodexSidecarSession | null
    /** Compaction needs the thread loaded in this runtime process; resume it the way product turns do. */
    ensureThreadLoaded: (identity: ReadyAliasIdentity) => Promise<void>
    ownerMainBootId: string
    timeoutMs: number
    now: () => string
    nowMs: () => number
    wait?: (ms: number) => Promise<void>
    onRecoveryFailure?: (input: { manualCompactionId: string; reason: string }) => void
    onArchiveIntentReady?: (archiveIntentDigest: string) => void
  }) {
    this.recoveryGenerationStopSignal = this.createRecoveryGenerationStopSignal()
  }

  async beginBootGeneration(): Promise<boolean> {
    if (this.stopping) return false
    this.cancelBootGeneration()
    await Promise.all([...this.recoveryJobs.values()])
    if (this.stopping) return false
    this.recoveryGenerationStopSignal = this.createRecoveryGenerationStopSignal()
    return true
  }

  cancelBootGeneration(): void {
    this.resolveRecoveryGenerationStop?.()
  }

  async begin(identity: ReadyAliasIdentity): Promise<{
    manualCompactionId: string
    threadId: string
  }> {
    const route = this.deps.repository.readManualCompactionRoute(identity)
    const snapshot = this.deps.gatewayRepository.readSnapshot(
      route.upstreamProfileSnapshotRef,
      route.upstreamProfileSnapshotDigest,
    )
    const session = this.deps.getSession()
    if (!session) throw new Error('manual_compaction_sidecar_unavailable')
    const preDispatchRead = await session.getClient().threadRead({
      threadId: route.codexThreadId,
      includeTurns: true,
    })
    if (preDispatchRead.thread.id !== route.codexThreadId) {
      throw new Error('manual_compaction_pre_dispatch_thread_mismatch')
    }
    // Nothing happened since the last compaction. Codex re-adds the thread's instructions only at the start of a
    // regular turn, so a second compaction now would summarize an empty history without them.
    const latestTurn = preDispatchRead.thread.turns.at(-1)
    if (latestTurn?.status === 'completed' && latestTurn.items.length > 0
      && latestTurn.items.every((item) => item.type === 'contextCompaction')) {
      throw new ReadyCodexLifecyclePortError('no_active_operation')
    }
    const preDispatchTurnIds = preDispatchRead.thread.turns.map((turn) => turn.id)
    const connectionEpoch = session.getActiveConnectionEpoch()
    const inboundBuffer = session.getInboundBuffer()
    const manualCompactionId = `manual-${randomUUID()}`
    const createdAt = this.deps.now()
    const deadlineAtMs = this.deps.nowMs() + this.deps.timeoutMs
    const binding = this.deps.repository.beginManualCompaction({
      manualCompactionId,
      threadBindingId: route.threadBindingId,
      ownerMainBootId: this.deps.ownerMainBootId,
      codexModel: route.codexModel,
      upstreamProfileSnapshotRef: route.upstreamProfileSnapshotRef,
      upstreamProfileSnapshotDigest: route.upstreamProfileSnapshotDigest,
      providerSnapshot: snapshot,
      credentialReferenceId: snapshot.credentialReferenceId,
      expectedToolsDigest: digestCanonicalJson([]),
      preDispatchThreadReadDigest: digestCanonicalJson(preDispatchRead.thread),
      preDispatchTurnIds,
      expiresAt: new Date(deadlineAtMs).toISOString(),
      createdAt,
    })
    inboundBuffer.registerProvisionalManualCompaction({
      manualCompactionId,
      connectionEpoch,
      threadId: binding.codexThreadId,
      deadlineAtMs,
    })
    this.operations.set(manualCompactionId, {
      identity: { ...identity },
      connectionEpoch,
      threadId: binding.codexThreadId,
      deadlineAtMs,
      session,
      inboundBuffer,
      upstreamProfileSnapshotDigest: route.upstreamProfileSnapshotDigest,
      preDispatchTurnIds,
    })
    return { manualCompactionId, threadId: binding.codexThreadId }
  }

  /**
   * Codex rejected the dispatch. When two readbacks show the thread exactly as before dispatch, nothing started:
   * settle the request, drop its inbound owner and release the fence. Returns false when that cannot be proven.
   */
  async settleRejected(input: {
    identity: ReadyAliasIdentity
    manualCompactionId: string
  }): Promise<boolean> {
    const operation = this.requireOperation(input)
    const provenAbsent = await this.proveRejectedDispatchAbsent(
      operation.session,
      operation.threadId,
      operation.preDispatchTurnIds,
      (value) => value,
    )
    if (!provenAbsent) return false
    operation.inboundBuffer.discardRejectedManualCompaction({
      manualCompactionId: input.manualCompactionId,
      connectionEpoch: operation.connectionEpoch,
    })
    this.deps.repository.settleRejectedManualCompaction({
      manualCompactionId: input.manualCompactionId,
      settledAt: this.deps.now(),
    })
    this.operations.delete(input.manualCompactionId)
    return true
  }

  private async proveRejectedDispatchAbsent(
    session: CodexSidecarSession,
    threadId: string,
    preDispatchTurnIds: readonly string[],
    guard: <T>(value: Promise<T>) => Promise<T>,
  ): Promise<boolean> {
    const wait = this.deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    for (let index = 0; index < 2; index += 1) {
      if (index > 0) await guard(wait(25))
      const read = await guard(session.getClient().threadRead({ threadId, includeTurns: true }))
      if (
        read.thread.id !== threadId
        || read.thread.turns.length !== preDispatchTurnIds.length
        || read.thread.turns.some((turn, order) => (
          turn.id !== preDispatchTurnIds[order] || turn.status === 'inProgress'
        ))
      ) return false
    }
    return true
  }

  async awaitCompletion(input: {
    identity: ReadyAliasIdentity
    manualCompactionId: string
  }): Promise<{ notificationContextCompactionItemId: string; codexTurnId: string }> {
    const operation = this.requireOperation(input)
    const wait = this.deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    while (this.deps.nowMs() < operation.deadlineAtMs) {
      if (!operation.session.isConnectionLive(operation.connectionEpoch)) {
        throw new Error('manual_compaction_connection_closed')
      }
      const evidence = operation.inboundBuffer.readManualCompactionEvidence(input.manualCompactionId)
      if (evidence) {
        if (evidence.terminalStatus !== 'completed') {
          throw new Error('manual_compaction_terminal_not_completed')
        }
        return {
          notificationContextCompactionItemId: evidence.contextCompactionItemId,
          codexTurnId: evidence.turnId,
        }
      }
      await wait(25)
    }
    throw new Error('manual_compaction_terminal_timeout')
  }

  async consume(input: {
    identity: ReadyAliasIdentity
    manualCompactionId: string
    notificationContextCompactionItemId: string | null
    contextCompactionItemId: string
    codexTurnId: string
    threadReadDigest: string
    terminalEvidenceDigest: string
  }): Promise<void> {
    const operation = this.requireOperation(input)
    const gatewayEvidence = this.deps.gatewayRepository.readManualCompactionGatewayEvidence({
      manualCompactionId: input.manualCompactionId,
      codexThreadId: operation.threadId,
      codexTurnId: input.codexTurnId,
    })
    if (
      !gatewayEvidence
      || gatewayEvidence.upstreamProfileSnapshotDigest !== operation.upstreamProfileSnapshotDigest
      || gatewayEvidence.toolsDigest !== digestCanonicalJson([])
      || gatewayEvidence.toolCount !== 0
    ) throw new Error('manual_compaction_gateway_evidence_invalid')
    const disposition = await operation.inboundBuffer.reconcileTurn({
      bindingId: input.manualCompactionId,
      connectionEpoch: operation.connectionEpoch,
      threadId: operation.threadId,
      nativeTurnId: input.codexTurnId,
    }, () => {
      this.deps.repository.consumeManualCompaction({
        manualCompactionId: input.manualCompactionId,
        codexCompactionTurnId: input.codexTurnId,
        notificationContextCompactionItemId: input.notificationContextCompactionItemId,
        contextCompactionItemId: input.contextCompactionItemId,
        threadReadDigest: input.threadReadDigest,
        terminalEvidenceDigest: input.terminalEvidenceDigest,
        gatewayRequestReceiptId: gatewayEvidence.receiptId,
        gatewayRequestEvidenceDigest: gatewayEvidence.requestEvidenceDigest,
        gatewayResponseEvidenceDigest: gatewayEvidence.responseEvidenceDigest,
        consumedAt: this.deps.now(),
      })
    })
    if (disposition !== 'released') throw new Error('manual_compaction_reconciliation_unknown')
    this.operations.delete(input.manualCompactionId)
  }

  markUnknown(input: {
    identity: ReadyAliasIdentity
    manualCompactionId: string
    reason: string
  }): void {
    const operation = this.requireOperation(input)
    this.deps.repository.recordManualCompactionUnknown({
      manualCompactionId: input.manualCompactionId,
      reason: input.reason,
      evidenceDigest: digestCanonicalJson({
        manualCompactionId: input.manualCompactionId,
        identity: input.identity,
        connectionEpoch: operation.connectionEpoch,
        threadId: operation.threadId,
        reason: input.reason,
      }),
      unknownAt: this.deps.now(),
    })
    this.operations.delete(input.manualCompactionId)
  }

  async reconcileRecovery(
    recovery: CodexManualCompactionRecovery,
  ): Promise<'settled' | 'observing'> {
    const session = this.deps.getSession()
    if (!session) throw new Error('manual_compaction_sidecar_unavailable')
    if (recovery.state === 'quarantined') {
      if (!recovery.codexCompactionTurnId) return 'settled'
      const read = await this.awaitRecoveryActive(session.getClient().threadRead({
        threadId: recovery.codexThreadId,
        includeTurns: true,
      }))
      const turn = this.exactRecoveryTurn(recovery, read.thread)
      if (turn.status === 'inProgress') {
        this.trackRecovery(
          recovery.manualCompactionId,
          () => this.observeQuarantinedTurn(recovery, session),
        )
        return 'observing'
      }
      const reconciled = this.deps.repository.reconcileQuarantinedManualCompaction({
        manualCompactionId: recovery.manualCompactionId,
        threadReadDigest: digestCanonicalJson(read.thread),
        reconciledAt: this.deps.now(),
      })
      if (reconciled.archiveIntentDigest) {
        this.deps.onArchiveIntentReady?.(reconciled.archiveIntentDigest)
      }
      return 'settled'
    }
    if (recovery.latestAttempt?.responseKind === 'rejected' && !recovery.codexCompactionTurnId) {
      // Codex answered with an error, so the request reached it and was refused; prove nothing started instead of
      // treating the written request as possibly running.
      const provenAbsent = await this.proveRejectedDispatchAbsent(
        session,
        recovery.codexThreadId,
        recovery.preDispatchTurnIds,
        (value) => this.awaitRecoveryActive(value),
      )
      if (provenAbsent) {
        this.deps.repository.settleRejectedManualCompaction({
          manualCompactionId: recovery.manualCompactionId,
          settledAt: this.deps.now(),
        })
      } else if (!recovery.unknownAt) {
        this.markRecoveryUnknown(recovery, 'rejected_dispatch_unproven')
      }
      return 'settled'
    }
    if (recovery.unknownAt) return 'settled'
    if (recovery.codexCompactionTurnId) {
      try {
        const read = await this.awaitRecoveryActive(session.getClient().threadRead({
          threadId: recovery.codexThreadId,
          includeTurns: true,
        }))
        const turn = this.exactRecoveryTurn(recovery, read.thread)
        if (turn.status === 'inProgress') {
          this.trackRecovery(recovery.manualCompactionId, async () => {
            try {
              await this.observeClaimedTurn(recovery, session)
            } catch (error) {
              // silent-catch: cancellation ends observation; any other readback failure is recorded via markRecoveryUnknown
              if (isManualRecoveryCancellation(error)) return
              this.markRecoveryUnknown(
                recovery,
                `claimed_turn_readback_failed:${error instanceof Error ? error.message : String(error)}`,
              )
            }
          })
          return 'observing'
        }
        this.consumeClaimedTurn(recovery, read.thread, turn)
      } catch (error) {
        if (isManualRecoveryCancellation(error)) throw error
        this.markRecoveryUnknown(
          recovery,
          `claimed_turn_readback_failed:${error instanceof Error ? error.message : String(error)}`,
        )
      }
      return 'settled'
    }
    if (recovery.latestAttempt?.childWriteAttemptedAt) {
      this.markRecoveryUnknown(recovery, 'dispatch_may_have_reached_child')
      return 'settled'
    }
    if (recovery.latestAttempt) {
      this.deps.repository.proveManualCompactionAttemptAbsent({
        manualCompactionId: recovery.manualCompactionId,
        connectionEpoch: recovery.latestAttempt.connectionEpoch,
        rpcId: recovery.latestAttempt.rpcId,
        reason: 'write_not_attempted',
        evidenceDigest: digestCanonicalJson(recovery.latestAttempt),
        provenAt: this.deps.now(),
      })
    }
    this.trackRecovery(recovery.manualCompactionId, async () => {
      await this.retryProvenAbsentUntilResolved(recovery, session)
    })
    return 'observing'
  }

  private async retryProvenAbsentRecovery(
    recovery: CodexManualCompactionRecovery,
    session: CodexSidecarSession,
  ): Promise<void> {
    const deadlineAtMs = this.deps.nowMs() + this.deps.timeoutMs
    const connectionEpoch = session.getActiveConnectionEpoch()
    const inboundBuffer = session.getInboundBuffer()
    this.deps.repository.renewManualCompactionRecoveryWindow({
      manualCompactionId: recovery.manualCompactionId,
      expiresAt: new Date(deadlineAtMs).toISOString(),
      renewedAt: this.deps.now(),
    })
    inboundBuffer.registerProvisionalManualCompaction({
      manualCompactionId: recovery.manualCompactionId,
      connectionEpoch,
      threadId: recovery.codexThreadId,
      deadlineAtMs,
    })
    const identity = {
      aliasId: recovery.aliasId,
      aliasGeneration: recovery.aliasGeneration,
    }
    this.operations.set(recovery.manualCompactionId, {
      identity,
      connectionEpoch,
      threadId: recovery.codexThreadId,
      deadlineAtMs,
      session,
      inboundBuffer,
      upstreamProfileSnapshotDigest: recovery.upstreamProfileSnapshotDigest,
      preDispatchTurnIds: recovery.preDispatchTurnIds,
    })
    try {
      await this.awaitRecoveryActive(this.deps.ensureThreadLoaded(identity))
      await this.awaitRecoveryActive(
        session.getClient().threadCompactStart({ threadId: recovery.codexThreadId }),
      )
      const completed = await this.awaitRecoveryCompletion(recovery.manualCompactionId)
      const read = await this.awaitRecoveryActive(session.getClient().threadRead({
        threadId: recovery.codexThreadId,
        includeTurns: true,
      }))
      const validated = this.validateCompletionReadback(
        recovery,
        read.thread,
        completed.codexTurnId,
      )
      await this.consume({
        identity,
        manualCompactionId: recovery.manualCompactionId,
        codexTurnId: completed.codexTurnId,
        notificationContextCompactionItemId: completed.notificationContextCompactionItemId,
        contextCompactionItemId: validated.contextCompactionItemId,
        threadReadDigest: digestCanonicalJson(read.thread),
        terminalEvidenceDigest: digestCanonicalJson(validated.turn),
      })
    } catch (error) {
      this.operations.delete(recovery.manualCompactionId)
      const refreshed = this.deps.repository.readRecoverySnapshot(() => false)
        .manualCompactions.find((entry) => entry.manualCompactionId === recovery.manualCompactionId)
      if (refreshed?.latestAttempt?.childWriteAttemptedAt) {
        this.markRecoveryUnknown(refreshed, error instanceof Error ? error.message : String(error))
        return
      }
      throw error
    }
  }

  private async retryProvenAbsentUntilResolved(
    recovery: CodexManualCompactionRecovery,
    session: CodexSidecarSession,
  ): Promise<void> {
    const wait = this.deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    let retryCount = 0
    let lastReportedCode: string | null = null
    for (;;) {
      try {
        await this.retryProvenAbsentRecovery(recovery, session)
        return
      } catch (error) {
        if (isManualRecoveryCancellation(error)) throw error
        const code = manualRecoveryCode(error)
        if (code !== lastReportedCode) {
          lastReportedCode = code
          this.reportRecoveryFailure(recovery.manualCompactionId, error)
        }
        if (!isRetryableManualRecoveryError(error)) {
          this.markRecoveryUnknown(recovery, `redispatch_failed:${code}`)
          return
        }
        const backoffMs = Math.min(1_000, 25 * (2 ** Math.min(retryCount, 5)))
        retryCount += 1
        await this.awaitRecoveryActive(wait(backoffMs))
      }
    }
  }

  private async observeClaimedTurn(
    recovery: CodexManualCompactionRecovery,
    session: CodexSidecarSession,
  ): Promise<void> {
    const wait = this.deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    for (;;) {
      await this.awaitRecoveryActive(wait(25))
      const read = await this.awaitRecoveryActive(session.getClient().threadRead({
        threadId: recovery.codexThreadId,
        includeTurns: true,
      }))
      const turn = this.exactRecoveryTurn(recovery, read.thread)
      if (turn.status === 'inProgress') continue
      this.consumeClaimedTurn(recovery, read.thread, turn)
      return
    }
  }

  private consumeClaimedTurn(
    recovery: CodexManualCompactionRecovery,
    thread: CodexThread,
    turn: CodexTurn,
  ): void {
    if (turn.status !== 'completed') {
      this.markRecoveryUnknown(recovery, `terminal_${turn.status}`)
      return
    }
    const items = turn.items.filter((item) => item.type === 'contextCompaction')
    if (
      items.length !== 1
      || turn.items.some((item) => item.type === 'dynamicToolCall' || item.type === 'userMessage')
    ) {
      this.markRecoveryUnknown(recovery, 'terminal_item_shape_invalid')
      return
    }
    const gatewayEvidence = this.deps.gatewayRepository.readManualCompactionGatewayEvidence({
      manualCompactionId: recovery.manualCompactionId,
      codexThreadId: recovery.codexThreadId,
      codexTurnId: turn.id,
    })
    if (
      !gatewayEvidence
      || gatewayEvidence.upstreamProfileSnapshotDigest !== recovery.upstreamProfileSnapshotDigest
      || gatewayEvidence.toolsDigest !== digestCanonicalJson([])
      || gatewayEvidence.toolCount !== 0
    ) {
      this.markRecoveryUnknown(recovery, 'gateway_completion_evidence_invalid')
      return
    }
    this.deps.repository.consumeManualCompaction({
      manualCompactionId: recovery.manualCompactionId,
      codexCompactionTurnId: turn.id,
      notificationContextCompactionItemId: null,
      contextCompactionItemId: items[0].id,
      threadReadDigest: digestCanonicalJson(thread),
      terminalEvidenceDigest: digestCanonicalJson(turn),
      gatewayRequestReceiptId: gatewayEvidence.receiptId,
      gatewayRequestEvidenceDigest: gatewayEvidence.requestEvidenceDigest,
      gatewayResponseEvidenceDigest: gatewayEvidence.responseEvidenceDigest,
      consumedAt: this.deps.now(),
    })
  }

  private async observeQuarantinedTurn(
    recovery: CodexManualCompactionRecovery,
    session: CodexSidecarSession,
  ): Promise<void> {
    const wait = this.deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    for (;;) {
      try {
        await this.awaitRecoveryActive(wait(25))
        const read = await this.awaitRecoveryActive(session.getClient().threadRead({
          threadId: recovery.codexThreadId,
          includeTurns: true,
        }))
        const turn = this.exactRecoveryTurn(recovery, read.thread)
        if (turn.status === 'inProgress') continue
        const reconciled = this.deps.repository.reconcileQuarantinedManualCompaction({
          manualCompactionId: recovery.manualCompactionId,
          threadReadDigest: digestCanonicalJson(read.thread),
          reconciledAt: this.deps.now(),
        })
        if (reconciled.archiveIntentDigest) {
          this.deps.onArchiveIntentReady?.(reconciled.archiveIntentDigest)
        }
        return
      } catch (error) {
        if (isManualRecoveryCancellation(error)) throw error
        this.reportRecoveryFailure(recovery.manualCompactionId, error)
      }
    }
  }

  private exactRecoveryTurn(
    recovery: CodexManualCompactionRecovery,
    thread: CodexThread,
  ): CodexTurn {
    if (thread.id !== recovery.codexThreadId || !recovery.codexCompactionTurnId) {
      throw new Error('manual_recovery_thread_identity_mismatch')
    }
    if (recovery.preDispatchTurnIds.includes(recovery.codexCompactionTurnId)) {
      throw new Error('manual_recovery_turn_predates_dispatch')
    }
    const turns = thread.turns.filter((turn) => turn.id === recovery.codexCompactionTurnId)
    if (turns.length !== 1) throw new Error('manual_recovery_turn_readback_ambiguous')
    return turns[0]
  }

  private validateCompletionReadback(
    recovery: CodexManualCompactionRecovery,
    thread: CodexThread,
    codexTurnId: string,
  ): { turn: CodexTurn; contextCompactionItemId: string } {
    const turn = this.exactRecoveryTurn({ ...recovery, codexCompactionTurnId: codexTurnId }, thread)
    const items = turn.items.filter((item) => item.type === 'contextCompaction')
    if (
      turn.status !== 'completed'
      || items.length !== 1
      || turn.items.some((item) => item.type === 'dynamicToolCall' || item.type === 'userMessage')
    ) throw new Error('manual_compaction_recovery_readback_invalid')
    return { turn, contextCompactionItemId: items[0].id }
  }

  private markRecoveryUnknown(recovery: CodexManualCompactionRecovery, reason: string): void {
    this.deps.repository.recordManualCompactionUnknown({
      manualCompactionId: recovery.manualCompactionId,
      reason,
      evidenceDigest: digestCanonicalJson({ recovery, reason }),
      unknownAt: this.deps.now(),
    })
  }

  private requireOperation(input: {
    identity: ReadyAliasIdentity
    manualCompactionId: string
  }): ManualOperation {
    const operation = this.operations.get(input.manualCompactionId)
    if (
      !operation
      || operation.identity.aliasId !== input.identity.aliasId
      || operation.identity.aliasGeneration !== input.identity.aliasGeneration
    ) throw new Error('manual_compaction_operation_mismatch')
    return operation
  }

  private async awaitRecoveryCompletion(manualCompactionId: string): Promise<{
    notificationContextCompactionItemId: string
    codexTurnId: string
  }> {
    const operation = this.operations.get(manualCompactionId)
    if (!operation) throw new Error('manual_compaction_operation_mismatch')
    const wait = this.deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    while (this.deps.nowMs() < operation.deadlineAtMs) {
      if (!operation.session.isConnectionLive(operation.connectionEpoch)) {
        throw new Error('manual_compaction_connection_closed')
      }
      const evidence = operation.inboundBuffer.readManualCompactionEvidence(manualCompactionId)
      if (evidence) {
        if (evidence.terminalStatus !== 'completed') {
          throw new Error('manual_compaction_terminal_not_completed')
        }
        return {
          notificationContextCompactionItemId: evidence.contextCompactionItemId,
          codexTurnId: evidence.turnId,
        }
      }
      await this.awaitRecoveryActive(wait(25))
    }
    throw new Error('manual_compaction_terminal_timeout')
  }

  private trackRecovery(manualCompactionId: string, task: () => Promise<void>): void {
    if (this.stopping || this.recoveryJobs.has(manualCompactionId)) return
    const job = task()
      .catch((error) => {
        if (!isManualRecoveryCancellation(error)) {
          this.reportRecoveryFailure(manualCompactionId, error)
        }
      })
      .finally(() => {
        if (this.recoveryJobs.get(manualCompactionId) === job) {
          this.recoveryJobs.delete(manualCompactionId)
        }
      })
    this.recoveryJobs.set(manualCompactionId, job)
  }

  private async awaitRecoveryActive<T>(operation: Promise<T>): Promise<T> {
    if (this.stopping) throw new Error('manual_compaction_recovery_stopped')
    const generationStopSignal = this.recoveryGenerationStopSignal
    return Promise.race([
      operation,
      generationStopSignal.then(() => {
        throw new Error(this.stopping
          ? 'manual_compaction_recovery_stopped'
          : 'manual_compaction_recovery_generation_advanced')
      }),
    ])
  }

  private reportRecoveryFailure(manualCompactionId: string, error: unknown): void {
    this.deps.onRecoveryFailure?.({
      manualCompactionId,
      reason: error instanceof Error ? error.message : String(error),
    })
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.cancelBootGeneration()
    await Promise.all([...this.recoveryJobs.values()])
  }

  private createRecoveryGenerationStopSignal(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolveRecoveryGenerationStop = resolve
    })
  }
}
