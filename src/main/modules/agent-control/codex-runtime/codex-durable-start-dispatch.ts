import type {
  CodexStartDispatchPort,
} from './codex-app-server-client'
import type {
  CodexBindingRepository,
} from './codex-binding-repository'
import type { CodexProvisionalInboundBuffer } from './codex-provisional-inbound-buffer'
import type { CodexStartIdentityRegistry } from './codex-start-identity-registry'

type StartMethod = 'thread/start' | 'thread/fork' | 'turn/start'

export interface CodexStartDeliveryEvidenceResolver {
  resolveTypedRejection(input: {
    connectionEpoch: string
    rpcId: number
    method: StartMethod
    bindingId: string
    rpcError: unknown
    responseDigest: string
  }): Promise<
    | { resolution: 'unknown' }
    | { resolution: 'proven_absent'; evidenceDigest: string }
  >
}

export class CodexDurableStartDispatchPort implements CodexStartDispatchPort {
  constructor(private readonly deps: {
    repository: CodexBindingRepository
    registry: CodexStartIdentityRegistry
    inboundBuffer: CodexProvisionalInboundBuffer
    evidenceResolver: CodexStartDeliveryEvidenceResolver
    now: () => string
    inboundDeadlineMs: number
    pinnedThreadSource: string
  }) {}

  async activate(input: {
    connectionEpoch: string
    rpcId: number
    method: StartMethod
    bindingLookupKey: string
    requestDigest: string
  }): Promise<{ bindingId: string }> {
    this.deps.inboundBuffer.assertProvisionalOwnerCapacityAvailable()
    const dispatchedAt = this.deps.now()
    const activated = this.deps.repository.activateStartDispatch({
      ...input,
      dispatchedAt,
    })
    const deadlineAtMs = Date.parse(dispatchedAt) + this.deps.inboundDeadlineMs
    if (activated.inboundIdentity.method !== 'turn/start') {
      this.deps.inboundBuffer.registerProvisionalThread({
        bindingId: activated.bindingId,
        connectionEpoch: input.connectionEpoch,
        expectedCwd: activated.inboundIdentity.expectedCwd,
        expectedSource: this.deps.pinnedThreadSource,
        expectedParentThreadId: activated.inboundIdentity.expectedParentThreadId,
        expectedForkedFromId: activated.inboundIdentity.expectedForkedFromId,
        deadlineAtMs,
      })
    } else {
      this.deps.inboundBuffer.registerProvisionalTurn({
        bindingId: activated.bindingId,
        connectionEpoch: input.connectionEpoch,
        threadId: activated.inboundIdentity.threadId,
        clientUserMessageId: activated.inboundIdentity.clientUserMessageId,
        deadlineAtMs,
      })
    }
    this.deps.registry.activate({
      reservationSetId: activated.reservationSetId,
      reservationId: activated.reservationId,
      bindingId: activated.bindingId,
      connectionEpoch: input.connectionEpoch,
      rpcId: input.rpcId,
    })
    return { bindingId: activated.bindingId }
  }

  async markChildWriteConfirmed(input: {
    connectionEpoch: string
    rpcId: number
    method: StartMethod
    bindingId: string
    childWriteDigest: string
  }): Promise<void> {
    this.deps.repository.markStartChildWriteConfirmed({
      ...input,
      confirmedAt: this.deps.now(),
    })
  }

  async markUnresolved(input: {
    connectionEpoch: string
    rpcId: number
    method: StartMethod
    bindingId: string
    reason: 'response_timeout' | 'child_write_error' | 'connection_closed'
  }): Promise<void> {
    this.deps.repository.validateUnresolvedStart(input)
  }

  async reconcileAccepted(input: {
    connectionEpoch: string
    rpcId: number
    method: StartMethod
    bindingId: string
    nativeId: string
    nativeResult: unknown
    responseDigest: string
    responsePending: boolean
  }): Promise<void> {
    const inboundIdentity = this.deps.repository.readStartInboundIdentity(
      input.method,
      input.bindingId,
    )
    let committed = false
    const commitAccepted = () => {
      this.deps.repository.reconcileStartAccepted({
        ...input,
        reconciledAt: this.deps.now(),
      })
      this.deps.registry.reconcileAccepted(input)
      committed = true
    }
    let disposition: 'released' | 'unknown'
    if (inboundIdentity.method !== 'turn/start') {
      disposition = await this.deps.inboundBuffer.reconcileThread({
        bindingId: input.bindingId,
        connectionEpoch: input.connectionEpoch,
        nativeThreadId: input.nativeId,
      }, commitAccepted)
    } else {
      disposition = await this.deps.inboundBuffer.reconcileTurn({
        bindingId: input.bindingId,
        connectionEpoch: input.connectionEpoch,
        threadId: inboundIdentity.threadId,
        nativeTurnId: input.nativeId,
      }, commitAccepted)
    }
    if (disposition === 'unknown' || !committed) {
      throw new Error('start_inbound_identity_unknown')
    }
  }

  async reconcileRejected(input: {
    connectionEpoch: string
    rpcId: number
    method: StartMethod
    bindingId: string
    rpcError: unknown
    responseDigest: string
  }): Promise<'unknown' | 'proven_absent'> {
    const resolution = await this.deps.evidenceResolver.resolveTypedRejection(input)
    if (resolution.resolution === 'unknown') return 'unknown'
    if (input.method === 'thread/fork') {
      this.deps.repository.markForkMaterializationProvenAbsent({
        threadBindingId: input.bindingId,
        evidenceDigest: resolution.evidenceDigest,
        recordedAt: this.deps.now(),
      })
      return 'proven_absent'
    }
    this.deps.repository.recordHostFailureEvidence({
      readyRunId: input.method === 'turn/start'
        ? input.bindingId
        : this.deps.repository.readProductRunForThreadBinding(input.bindingId),
      kind: input.method === 'thread/start'
        ? 'thread_start_rpc_rejected'
        : 'turn_start_rpc_rejected',
      evidenceDigest: resolution.evidenceDigest,
      recordedAt: this.deps.now(),
    })
    return 'proven_absent'
  }

  async consumeLateResponse(input: {
    connectionEpoch: string
    rpcId: number
    method: StartMethod
    nativeId: string
    responseDigest: string
  }): Promise<boolean> {
    const guard = this.deps.registry.snapshot().lateResponseGuards.find((candidate) => (
      candidate.connectionEpoch === input.connectionEpoch
      && candidate.rpcId === input.rpcId
      && candidate.method === input.method
      && candidate.nativeId === input.nativeId
    ))
    if (!guard) return false
    const consumed = this.deps.repository.consumeLateStartResponse({
      ...input,
      closedAt: this.deps.now(),
    })
    if (!consumed) return false
    this.deps.registry.closeLateResponseGuard({
      ...guard,
      reason: 'response_received',
    })
    return true
  }

  async markConnectionClosed(connectionEpoch: string): Promise<void> {
    const closedAt = this.deps.now()
    const settle = (close: () => void): Promise<void> => {
      try {
        close()
        return Promise.resolve()
      } catch (error) {
        return Promise.reject(error)
      }
    }
    const results = await Promise.allSettled([
      settle(() => (
        this.deps.repository.closeLateResponseGuardsForConnection(connectionEpoch, closedAt)
      )),
      settle(() => this.deps.registry.markConnectionClosed(connectionEpoch)),
      settle(() => this.deps.inboundBuffer.markConnectionClosed(connectionEpoch)),
    ])
    const failures = results.flatMap((result) => (
      result.status === 'rejected' ? [result.reason] : []
    ))
    if (failures.length > 0) {
      throw new AggregateError(failures, 'start_dispatch_close_failed')
    }
  }

  completeHostFailureCloseout(input: {
    readyRunId: string
    productTerminalDigest: string
    continuationBlockedReason: 'start_delivery_absent' | 'publication_diverged'
  }): void {
    const completed = this.deps.repository.completeHostFailureCloseout({
      ...input,
      closeoutAt: this.deps.now(),
    })
    this.deps.registry.releaseAfterHostFailure({
      reservationSetId: completed.reservationSetId,
      productTerminalDigest: input.productTerminalDigest,
    })
  }
}
