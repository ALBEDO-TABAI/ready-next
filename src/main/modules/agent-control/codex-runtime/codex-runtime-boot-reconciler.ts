import type {
  CodexBindingRecoveryMember,
  CodexBindingRecoverySnapshot,
  CodexBindingRepository,
  CodexHostFailureRecovery,
  CodexManualCompactionRecovery,
  CodexProductFenceRecovery,
} from './codex-binding-repository'
import type { VerifiedCodexRuntime } from './codex-runtime-host'
import type { CodexSidecarSupervisor } from './codex-sidecar-supervisor'
import {
  createCodexStartIdentityRegistryForRuntime,
  type CodexStartIdentityRegistry,
} from './codex-start-identity-registry'

export type CodexRecoveredStartResolution =
  | {
      resolution: 'accepted'
      nativeId: string
      nativeResult: unknown
      evidenceDigest: string
      forkRecoveryEvidence?: {
        connectionEpoch: string
        preResumeThreadReadDigest: string
        resumedThreadDigest: string
      }
    }
  | { resolution: 'proven_absent'; evidenceDigest: string }
  | { resolution: 'unknown'; evidenceDigest: string }

export interface CodexRuntimeIngressGate {
  open(): void
  close(reason: string): void
}

export interface CodexBootSidecarSession {
  startAndInitialize(input: {
    registry: CodexStartIdentityRegistry
    snapshot: CodexBindingRecoverySnapshot
  }): Promise<{ connectionEpoch: string }>
  isConnectionLive(connectionEpoch: string): boolean
  sealBootReconciliation(): void
}

export interface CodexBootRecoveryActions {
  dispatchHeldStart(input: {
    member: CodexBindingRecoveryMember
    registry: CodexStartIdentityRegistry
  }): Promise<'accepted' | 'pending' | 'blocked'>
  resolveIntentStart(input: {
    member: CodexBindingRecoveryMember
    registry: CodexStartIdentityRegistry
    recoveryConnectionEpoch: string
  }): Promise<CodexRecoveredStartResolution>
  commitHostFailureProductTerminal(input: {
    failure: CodexHostFailureRecovery
  }): Promise<{ productTerminalDigest: string; closeoutAt: string }>
  deliverHostFailureProductTerminal(input: {
    failure: CodexHostFailureRecovery
  }): Promise<void>
  reconcileManualCompaction(input: CodexManualCompactionRecovery): Promise<void>
  reconcileProductFence(input: CodexProductFenceRecovery): Promise<void>
}

export class CodexRuntimeBootReconcilerError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'CodexRuntimeBootReconcilerError'
  }
}

export type CodexRuntimeBootResult = {
  connectionEpoch: string
  registry: CodexStartIdentityRegistry
  snapshot: CodexBindingRecoverySnapshot
  unresolvedStartBindings: string[]
}

export class CodexRuntimeBootReconciler {
  private booted = false

  constructor(private readonly deps: {
    runtime: VerifiedCodexRuntime
    repository: Pick<
      CodexBindingRepository,
      | 'readRecoverySnapshot'
      | 'recordHostFailureEvidence'
      | 'completeHostFailureCloseout'
      | 'reconcileStartAccepted'
      | 'closeLateResponseGuardsForConnection'
      | 'readProductRunForThreadBinding'
      | 'quarantineStartInbound'
      | 'markForkMaterializationProvenAbsent'
    >
    supervisor: Pick<CodexSidecarSupervisor, 'settleBootLease' | 'settleFenceOwnerLease'>
    sidecarSession: CodexBootSidecarSession
    actions: CodexBootRecoveryActions
    threadArchiveCleanup?: {
      reconcileForBoot(): Promise<unknown>
      drain(): Promise<unknown>
    }
    ingressGate: CodexRuntimeIngressGate
    canCommitBoot?: () => boolean
    now: () => string
  }) {}

  async boot(): Promise<CodexRuntimeBootResult> {
    if (this.booted) throw new CodexRuntimeBootReconcilerError('boot_reconciliation_already_completed')
    this.deps.ingressGate.close('boot_reconciliation_pending')
    try {
      await this.deps.supervisor.settleBootLease()
      const snapshot = this.deps.repository.readRecoverySnapshot(
        (epoch) => this.deps.sidecarSession.isConnectionLive(epoch),
      )
      for (const ownerMainBootId of new Set(
        snapshot.productFences
          .filter((fence) => !fence.quarantinedAt)
          .map((fence) => fence.ownerMainBootId),
      )) {
        await this.deps.supervisor.settleFenceOwnerLease(ownerMainBootId)
      }
      const registry = createCodexStartIdentityRegistryForRuntime(this.deps.runtime, {
        capacity: this.deps.runtime.manifest.startIdentityRegistryCapacity,
        capacityCharged: snapshot.members.length,
        members: snapshot.members.map((member) => ({
          reservationSetId: member.reservationSetId,
          reservationId: member.reservationId,
          scopeId: member.scopeId,
          method: member.method,
          requiredMemberCount: member.requiredMemberCount,
          state: member.state,
          bindingId: member.bindingId,
          connectionEpoch: member.connectionEpoch,
          rpcId: member.rpcId,
        })),
        lateResponseGuards: snapshot.lateResponseGuards.map((guard) => ({ ...guard })),
      })
      const session = await this.deps.sidecarSession.startAndInitialize({ registry, snapshot })
      const closedReservationSets = await this.completeRecordedHostFailures(
        snapshot.hostFailureCloseouts,
        registry,
      )
      const deferredReservationSets = new Set<string>()
      const deferredReadyRuns = new Set<string>()
      const unresolvedStartBindings: string[] = []
      const quarantinedFences = snapshot.productFences.filter((fence) => fence.quarantinedAt)
      const newlyQuarantinedReadyRuns = new Set<string>()
      for (const member of [...snapshot.members].sort((left, right) => (
        left.crashSeam - right.crashSeam || left.bindingId.localeCompare(right.bindingId)
      ))) {
        if (closedReservationSets.has(member.reservationSetId)) continue
        if (deferredReservationSets.has(member.reservationSetId)) continue
        const quarantined = quarantinedFences.some((fence) => (
          member.method !== 'turn/start'
            ? fence.threadBindingId === member.bindingId
            : fence.readyRunId === member.bindingId
        ))
        if (quarantined) {
          if (!unresolvedStartBindings.includes(member.bindingId)) {
            unresolvedStartBindings.push(member.bindingId)
          }
          if (member.method !== 'turn/start') {
            deferredReservationSets.add(member.reservationSetId)
          }
          continue
        }
        if (member.state === 'held') {
          const disposition = await this.deps.actions.dispatchHeldStart({ member, registry })
          if (disposition !== 'accepted') {
            unresolvedStartBindings.push(member.bindingId)
            if (member.method !== 'thread/fork') {
              deferredReadyRuns.add(member.method === 'turn/start'
                ? member.bindingId
                : this.deps.repository.readProductRunForThreadBinding(member.bindingId))
            }
          }
          if (member.method !== 'turn/start' && disposition !== 'accepted') {
            deferredReservationSets.add(member.reservationSetId)
          }
          continue
        }
        const resolution = await this.deps.actions.resolveIntentStart({
          member,
          registry,
          recoveryConnectionEpoch: session.connectionEpoch,
        })
        if (resolution.resolution === 'accepted') {
          this.deps.repository.reconcileStartAccepted({
            connectionEpoch: member.connectionEpoch as string,
            rpcId: member.rpcId as number,
            method: member.method,
            bindingId: member.bindingId,
            nativeId: resolution.nativeId,
            nativeResult: resolution.nativeResult,
            responseDigest: resolution.evidenceDigest,
            responsePending: true,
            reconciledAt: this.deps.now(),
            forkRecoveryEvidence: resolution.forkRecoveryEvidence,
          })
          registry.reconcileAccepted({
            connectionEpoch: member.connectionEpoch as string,
            rpcId: member.rpcId as number,
            method: member.method,
            bindingId: member.bindingId,
            nativeId: resolution.nativeId,
            responsePending: true,
          })
          this.deps.repository.closeLateResponseGuardsForConnection(
            member.connectionEpoch as string,
            this.deps.now(),
          )
          registry.markConnectionClosed(member.connectionEpoch as string)
          continue
        }
        if (resolution.resolution === 'proven_absent') {
          if (member.method === 'thread/fork') {
            this.deps.repository.markForkMaterializationProvenAbsent({
              threadBindingId: member.bindingId,
              evidenceDigest: resolution.evidenceDigest,
              recordedAt: this.deps.now(),
            })
            registry.releaseAfterProvenAbsence({
              reservationSetId: member.reservationSetId,
              evidenceDigest: resolution.evidenceDigest,
            })
            closedReservationSets.add(member.reservationSetId)
            continue
          }
          const readyRunId = member.method === 'turn/start'
            ? member.bindingId
            : this.deps.repository.readProductRunForThreadBinding(member.bindingId)
          const failure: CodexHostFailureRecovery = {
            readyRunId,
            reservationSetId: member.reservationSetId,
            kind: member.method === 'thread/start'
              ? 'thread_start_delivery_proven_absent'
              : 'turn_start_delivery_proven_absent',
            evidenceDigest: resolution.evidenceDigest,
            continuationBlockedReason: member.method === 'thread/start'
              ? 'start_delivery_absent'
              : 'publication_diverged',
          }
          this.deps.repository.recordHostFailureEvidence({
            readyRunId,
            kind: failure.kind as 'thread_start_delivery_proven_absent' | 'turn_start_delivery_proven_absent',
            evidenceDigest: failure.evidenceDigest,
            recordedAt: this.deps.now(),
          })
          await this.completeHostFailure(failure, registry)
          closedReservationSets.add(member.reservationSetId)
          continue
        }
        this.deps.repository.quarantineStartInbound({
          method: member.method,
          bindingId: member.bindingId,
          reason: `start_resolution_unknown:${resolution.evidenceDigest}`,
          quarantinedAt: this.deps.now(),
        })
        if (member.method !== 'thread/fork') {
          newlyQuarantinedReadyRuns.add(member.method === 'turn/start'
            ? member.bindingId
            : this.deps.repository.readProductRunForThreadBinding(member.bindingId))
        }
        unresolvedStartBindings.push(member.bindingId)
        if (member.method !== 'turn/start') {
          deferredReservationSets.add(member.reservationSetId)
        }
      }
      for (const manual of snapshot.manualCompactions) {
        try {
          await this.deps.actions.reconcileManualCompaction(manual)
        } catch {
          unresolvedStartBindings.push(`manual:${manual.manualCompactionId}`)
        }
      }
      for (const fence of snapshot.productFences) {
        if (fence.quarantinedAt
          || newlyQuarantinedReadyRuns.has(fence.readyRunId)
          || deferredReadyRuns.has(fence.readyRunId)) continue
        await this.deps.actions.reconcileProductFence(fence)
      }
      try {
        await this.deps.threadArchiveCleanup?.reconcileForBoot()
      } catch {
        // Durable intents remain pending; archive cleanup never blocks product boot.
      }
      this.deps.sidecarSession.sealBootReconciliation()
      if (this.deps.canCommitBoot && !this.deps.canCommitBoot()) {
        throw new CodexRuntimeBootReconcilerError('boot_reconciliation_cancelled')
      }
      this.deps.ingressGate.open()
      void this.deps.threadArchiveCleanup?.drain().catch(() => undefined)
      this.booted = true
      return {
        connectionEpoch: session.connectionEpoch,
        registry,
        snapshot,
        unresolvedStartBindings,
      }
    } catch (error) {
      this.deps.ingressGate.close(error instanceof Error ? error.message : 'boot_reconciliation_failed')
      throw error
    }
  }

  private async completeRecordedHostFailures(
    failures: CodexHostFailureRecovery[],
    registry: CodexStartIdentityRegistry,
  ): Promise<Set<string>> {
    const closed = new Set<string>()
    for (const failure of failures) {
      await this.completeHostFailure(failure, registry)
      closed.add(failure.reservationSetId)
    }
    return closed
  }

  private async completeHostFailure(
    failure: CodexHostFailureRecovery,
    registry: CodexStartIdentityRegistry,
  ): Promise<void> {
    const terminal = await this.deps.actions.commitHostFailureProductTerminal({ failure })
    const completed = this.deps.repository.completeHostFailureCloseout({
      readyRunId: failure.readyRunId,
      productTerminalDigest: terminal.productTerminalDigest,
      continuationBlockedReason: failure.continuationBlockedReason,
      closeoutAt: terminal.closeoutAt,
    })
    if (completed.reservationSetId !== failure.reservationSetId) {
      throw new CodexRuntimeBootReconcilerError('host_failure_reservation_set_mismatch')
    }
    registry.releaseAfterHostFailure({
      reservationSetId: completed.reservationSetId,
      productTerminalDigest: terminal.productTerminalDigest,
    })
    await this.deps.actions.deliverHostFailureProductTerminal({ failure })
  }
}
