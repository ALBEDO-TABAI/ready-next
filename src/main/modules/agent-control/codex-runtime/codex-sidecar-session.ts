import { buildCodexChildEnvironment, type PreparedCodexRuntimeState, type VerifiedCodexRuntime } from './codex-runtime-host'
import {
  CodexAppServerClient,
  type CodexInboundFramePort,
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
    unsubscribeTransportClose: () => void
  } | null = null
  private stopping = false

  constructor(private readonly deps: {
    runtime: VerifiedCodexRuntime
    state: PreparedCodexRuntimeState
    gatewayToken: string
    repository: CodexBindingRepository
    supervisor: CodexSidecarSupervisor
    evidenceResolver: CodexStartDeliveryEvidenceResolver
    serverRequestExecutor: CodexBoundServerRequestExecutor
    requestTimeoutMs: number
    inboundDeadlineMs: number
    inboundMaxFrames: number
    inboundMaxBytes: number
    now: () => string
    nowMs: () => number
  }) {}

  async startAndInitialize(input: Parameters<CodexBootSidecarSession['startAndInitialize']>[0]): Promise<{
    connectionEpoch: string
  }> {
    if (this.active) throw new CodexSidecarSessionError('sidecar_session_already_active')
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
      inboundFramePort: inboundBuffer as CodexInboundFramePort,
      threadArchiveAuthorizationPort: {
        assertEligible: (threadId) => this.deps.repository.assertThreadArchiveEligible(threadId),
      },
    })
    const unsubscribeTransportClose = started.transport.onClose((error) => {
      if (this.active?.connectionEpoch === started.lease.connectionEpoch) this.active = null
      if (
        !this.stopping
        && (
          !error
          || (
            error instanceof CodexSidecarSupervisorError
            && (error.code === 'sidecar_unexpected_exit' || error.code === 'sidecar_process_error')
          )
        )
      ) {
        void this.deps.supervisor.hardReset('sidecar_crash')
      }
    })
    this.active = {
      connectionEpoch: started.lease.connectionEpoch,
      client,
      inboundBuffer,
      unsubscribeTransportClose,
    }
    try {
      await client.initialize()
      return { connectionEpoch: started.lease.connectionEpoch }
    } catch (error) {
      this.active = null
      unsubscribeTransportClose()
      client.dispose()
      await this.deps.supervisor.hardReset('protocol_failure')
      throw error
    }
  }

  isConnectionLive(connectionEpoch: string): boolean {
    return this.active?.connectionEpoch === connectionEpoch
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
    this.stopping = true
    this.active = null
    if (active) {
      active.unsubscribeTransportClose()
      active.client.dispose()
    }
    await this.deps.supervisor.hardReset('app_quit')
  }

  buildChildEnvironment(identities: {
    processLeaseId: string
    sidecarSpawnInstanceId: string
    connectionEpoch: string
  }): Record<string, string> {
    return buildCodexChildEnvironment({
      state: this.deps.state,
      ...identities,
      gatewayUrl: this.deps.state.gatewayUrl,
      gatewayToken: this.deps.gatewayToken,
    })
  }
}
