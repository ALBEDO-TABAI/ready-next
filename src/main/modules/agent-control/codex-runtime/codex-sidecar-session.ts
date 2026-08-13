import type { PreparedCodexRuntimeState, VerifiedCodexRuntime } from './codex-runtime-host'
import {
  CodexAppServerClient,
  type CodexInboundFramePort,
  type CodexThreadArchiveDispatchPort,
} from './codex-app-server-client'
import { CodexBindingRepository } from './codex-binding-repository'
import {
  CodexDurableStartDispatchPort,
  type CodexStartDeliveryEvidenceResolver,
} from './codex-durable-start-dispatch'
import {
  CodexProvisionalInboundBuffer,
  type CodexBoundServerRequestExecutor,
} from './codex-provisional-inbound-buffer'
import { CodexDurableManualCompactionDispatchPort } from './codex-manual-compaction-dispatch'
import type {
  CodexBootSidecarSession,
} from './codex-runtime-boot-reconciler'
import {
  CodexSidecarSupervisor,
  CodexSidecarSupervisorError,
} from './codex-sidecar-supervisor'

export class CodexSidecarSessionError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'CodexSidecarSessionError'
  }
}

export class CodexSidecarSession implements CodexBootSidecarSession {
  private active: {
    connectionEpoch: string
    client: CodexAppServerClient
    inboundBuffer: CodexProvisionalInboundBuffer
    connectionAbortController: AbortController
    unsubscribeTransportClose: () => void
    initialized: boolean
  } | null = null
  private stopping = false
  private readonly settlements = new Map<string, Promise<void>>()
  private readonly recentSettlements = new Set<string>()
  private failedClose: {
    active: NonNullable<CodexSidecarSession['active']>
    error: Error
  } | null = null

  constructor(private readonly deps: {
    runtime: VerifiedCodexRuntime
    state: PreparedCodexRuntimeState
    repository: CodexBindingRepository
    supervisor: CodexSidecarSupervisor
    evidenceResolver: CodexStartDeliveryEvidenceResolver
    serverRequestExecutor: CodexBoundServerRequestExecutor
    requestTimeoutMs: number
    inboundDeadlineMs: number
    inboundMaxFrames: number
    inboundMaxBytes: number
    threadArchiveDispatchPort?: CodexThreadArchiveDispatchPort
    now: () => string
    nowMs: () => number
    onProtocolFailure?: (event: { code: string; method: string | null }) => void
    onUnexpectedCloseDetected?: () => void
    onUnexpectedClose?: (settlement: Promise<void>) => void
  }) {}

  async startAndInitialize(input: Parameters<CodexBootSidecarSession['startAndInitialize']>[0]): Promise<{
    connectionEpoch: string
  }> {
    if (this.active || this.failedClose || this.settlements.size > 0) {
      throw new CodexSidecarSessionError('sidecar_session_already_active')
    }
    this.stopping = false
    const started = await this.deps.supervisor.start()
    const inboundBuffer = new CodexProvisionalInboundBuffer({
      maxFramesPerOwner: this.deps.inboundMaxFrames,
      maxBytesPerOwner: this.deps.inboundMaxBytes,
      nowMs: this.deps.nowMs,
      serverRequestExecutor: this.deps.serverRequestExecutor,
      startInboundQuarantinePort: {
        quarantine: (quarantine) => this.deps.repository.quarantineStartInbound({
          ...quarantine,
          quarantinedAt: this.deps.now(),
        }),
      },
    })
    const dispatchPort = new CodexDurableStartDispatchPort({
      repository: this.deps.repository,
      registry: input.registry,
      inboundBuffer,
      evidenceResolver: this.deps.evidenceResolver,
      now: this.deps.now,
      inboundDeadlineMs: this.deps.inboundDeadlineMs,
      pinnedThreadSource: this.deps.runtime.contracts.turnClientIdentityExtractionContract
        .thread_start.pinnedAppServerSource,
    })
    const client = new CodexAppServerClient({
      transport: started.transport,
      connectionEpoch: started.lease.connectionEpoch,
      requestTimeoutMs: this.deps.requestTimeoutMs,
      startDispatchPort: dispatchPort,
      manualCompactionDispatchPort: new CodexDurableManualCompactionDispatchPort({
        repository: this.deps.repository,
        now: this.deps.now,
      }),
      threadArchiveDispatchPort: this.deps.threadArchiveDispatchPort,
      inboundFramePort: inboundBuffer as CodexInboundFramePort,
      threadArchiveAuthorizationPort: {
        assertEligible: (threadId) => this.deps.repository.assertThreadArchiveEligible(threadId),
      },
    })
    const connectionAbortController = new AbortController()
    const unsubscribeTransportClose = started.transport.onClose((error) => {
      const active = this.active
      if (!active || active.connectionEpoch !== started.lease.connectionEpoch) return
      const wasInitialized = active.initialized
      const crash = !error || (
        error instanceof CodexSidecarSupervisorError
        && (error.code === 'sidecar_unexpected_exit' || error.code === 'sidecar_process_error')
      )
      if (!crash && error instanceof CodexSidecarSupervisorError) {
        const details = error.details
        this.deps.onProtocolFailure?.({
          code: error.code,
          method: details && typeof details === 'object' && !Array.isArray(details)
            && typeof (details as Record<string, unknown>).method === 'string'
            ? (details as Record<string, string>).method
            : null,
        })
      }
      this.closeActive(
        active,
        error || new CodexSidecarSessionError('sidecar_connection_closed'),
        crash ? 'sidecar_crash' : 'protocol_failure',
        !this.stopping && wasInitialized,
      )
    })
    this.active = {
      connectionEpoch: started.lease.connectionEpoch,
      client,
      inboundBuffer,
      connectionAbortController,
      unsubscribeTransportClose,
      initialized: false,
    }
    try {
      await client.initialize()
      if (this.active?.connectionEpoch !== started.lease.connectionEpoch) {
        throw new CodexSidecarSessionError('sidecar_connection_closed_during_initialize')
      }
      this.active.initialized = true
      return { connectionEpoch: started.lease.connectionEpoch }
    } catch (error) {
      if (this.active?.connectionEpoch === started.lease.connectionEpoch) {
        await this.closeActive(
          this.active,
          error instanceof Error ? error : new CodexSidecarSessionError('protocol_failure'),
          'protocol_failure',
          false,
        )
      } else {
        await this.settlements.get(started.lease.connectionEpoch)
      }
      throw error
    }
  }

  isConnectionLive(connectionEpoch: string): boolean {
    return this.active?.connectionEpoch === connectionEpoch
  }

  getActiveConnectionEpoch(): string {
    if (!this.active) throw new CodexSidecarSessionError('sidecar_session_not_active')
    return this.active.connectionEpoch
  }

  getConnectionAbortSignal(connectionEpoch: string): AbortSignal | null {
    const active = this.active
    if (!active || active.connectionEpoch !== connectionEpoch) return null
    return active.connectionAbortController.signal
  }

  getClient(): CodexAppServerClient {
    if (!this.active) throw new CodexSidecarSessionError('sidecar_session_not_active')
    return this.active.client
  }

  getInboundBuffer(): CodexProvisionalInboundBuffer {
    if (!this.active) throw new CodexSidecarSessionError('sidecar_session_not_active')
    return this.active.inboundBuffer
  }

  sealBootReconciliation(): void {
    this.getClient().sealBootReconciliation()
  }

  async stop(): Promise<void> {
    const active = this.active
    const failedClose = this.failedClose
    this.stopping = true
    this.active = null
    if (active) {
      await this.closeActive(
        active,
        new CodexSidecarSessionError('sidecar_session_stopped'),
        'app_quit',
        false,
      )
      return
    }
    if (failedClose) {
      await this.closeActive(
        failedClose.active,
        failedClose.error,
        'app_quit',
        false,
      )
      return
    }
    if (this.settlements.size > 0) {
      await Promise.all(this.settlements.values())
      return
    }
    if (this.recentSettlements.size === 0) await this.deps.supervisor.hardReset('app_quit')
  }

  private closeActive(
    active: NonNullable<CodexSidecarSession['active']>,
    error: Error,
    reason: 'app_quit' | 'protocol_failure' | 'sidecar_crash',
    unexpected: boolean,
  ): Promise<void> {
    if (this.active === active) this.active = null
    active.connectionAbortController.abort(error)
    active.unsubscribeTransportClose()
    if (unexpected) this.deps.onUnexpectedCloseDetected?.()
    const clientSettlement = active.client.shutdown(error).catch((cleanupError) => {
      this.deps.onProtocolFailure?.({ code: 'client_close_cleanup_failed', method: null })
      throw cleanupError
    })
    const settlement = this.settleOnce(active.connectionEpoch, reason, clientSettlement)
    void settlement.then(() => {
      if (this.failedClose?.active === active) this.failedClose = null
    }, () => {
      this.failedClose = { active, error }
    }).catch(() => undefined)
    if (unexpected && this.deps.onUnexpectedClose) {
      this.deps.onUnexpectedClose(settlement)
    } else {
      void settlement.catch(() => undefined)
    }
    return settlement
  }

  private settleOnce(
    connectionEpoch: string,
    reason: 'app_quit' | 'protocol_failure' | 'sidecar_crash',
    prerequisite: Promise<void> = Promise.resolve(),
  ): Promise<void> {
    const existing = this.settlements.get(connectionEpoch)
    if (existing) return existing
    if (this.recentSettlements.has(connectionEpoch)) return Promise.resolve()
    const settlement = prerequisite.then(() => this.deps.supervisor.hardReset(reason))
    this.settlements.set(connectionEpoch, settlement)
    void settlement.then(() => {
      if (this.settlements.get(connectionEpoch) === settlement) {
        this.settlements.delete(connectionEpoch)
        this.recentSettlements.add(connectionEpoch)
        if (this.recentSettlements.size > 2_048) {
          const oldest = this.recentSettlements.values().next().value as string | undefined
          if (oldest) this.recentSettlements.delete(oldest)
        }
      }
    }, () => {
      if (this.settlements.get(connectionEpoch) === settlement) {
        this.settlements.delete(connectionEpoch)
      }
    }).catch(() => undefined)
    return settlement
  }

}
