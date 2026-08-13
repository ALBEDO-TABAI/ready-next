import type { CodexManualCompactionDispatchPort } from './codex-app-server-client'
import type { CodexBindingRepository } from './codex-binding-repository'

export class CodexDurableManualCompactionDispatchPort implements CodexManualCompactionDispatchPort {
  constructor(private readonly deps: {
    repository: CodexBindingRepository
    now: () => string
  }) {}

  async activate(input: {
    connectionEpoch: string
    rpcId: number
    codexThreadId: string
    requestDigest: string
  }): Promise<{ manualCompactionId: string }> {
    return this.deps.repository.activateManualCompactionDispatch({
      ...input,
      dispatchIntentAt: this.deps.now(),
    })
  }

  async markWriteAttempted(input: {
    connectionEpoch: string
    rpcId: number
    manualCompactionId: string
  }): Promise<void> {
    this.deps.repository.markManualCompactionWriteAttempted({
      ...input,
      attemptedAt: this.deps.now(),
    })
  }

  async markChildWriteConfirmed(input: {
    connectionEpoch: string
    rpcId: number
    manualCompactionId: string
    childWriteDigest: string
  }): Promise<void> {
    this.deps.repository.markManualCompactionWriteConfirmed({
      ...input,
      confirmedAt: this.deps.now(),
    })
  }

  async markUnresolved(input: {
    connectionEpoch: string
    rpcId: number
    manualCompactionId: string
    reason: 'response_timeout' | 'child_write_error' | 'connection_closed'
  }): Promise<void> {
    this.deps.repository.markManualCompactionDispatchUnresolved({
      ...input,
      unresolvedAt: this.deps.now(),
    })
  }

  async reconcileResponse(input: {
    connectionEpoch: string
    rpcId: number
    manualCompactionId: string
    responseKind: 'accepted' | 'rejected'
    responseDigest: string
  }): Promise<void> {
    this.deps.repository.recordManualCompactionDispatchResponse({
      ...input,
      responseAt: this.deps.now(),
    })
  }

  async consumeLateResponse(input: {
    connectionEpoch: string
    rpcId: number
    responseKind: 'accepted' | 'rejected'
    responseDigest: string
  }): Promise<boolean> {
    return this.deps.repository.consumeLateManualCompactionResponse({
      ...input,
      responseAt: this.deps.now(),
    })
  }

  async markConnectionClosed(connectionEpoch: string): Promise<void> {
    this.deps.repository.markManualCompactionConnectionClosed(
      connectionEpoch,
      this.deps.now(),
    )
  }
}
