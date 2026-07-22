import { getBrowserTargetClaimService } from './browser-target-claim-singleton'
import {
  type BrowserTargetClaimAcquireInput,
  type BrowserTargetClaimIdentity,
  type BrowserTargetClaimService,
} from './browser-target-claims'
import {
  agentBrowserError,
  isAgentBrowserError,
  type AgentBrowserStructuredError,
} from './agent-browser-errors'
import type { BrowserTargetClaimGate } from './agent-browser-lease-gate'

function targetKey(input: Pick<BrowserTargetClaimAcquireInput, 'partition' | 'tabId'>): string {
  return `${input.partition}\u0000${input.tabId}`
}

export class BrowserTurnLease {
  private ended = false
  private readonly claims = new Map<string, BrowserTargetClaimIdentity>()

  constructor(
    private readonly ids: { taskId: string; runId: string },
    private readonly service?: BrowserTargetClaimService,
  ) {}

  ensureGateForTarget(
    input: Omit<BrowserTargetClaimAcquireInput, 'parentTaskId' | 'ownerRunId'>,
  ): BrowserTargetClaimGate | AgentBrowserStructuredError {
    if (this.ended) {
      return agentBrowserError('lease_required', 'The turn has ended; no Browser target claim is available.')
    }
    const service = this.service ?? getBrowserTargetClaimService()
    const acquireInput: BrowserTargetClaimAcquireInput = {
      ...input,
      parentTaskId: this.ids.taskId,
      ownerRunId: this.ids.runId,
    }
    const key = targetKey(acquireInput)
    const existing = this.claims.get(key)
    if (existing) {
      const renewed = service.heartbeat(existing)
      if (!isAgentBrowserError(renewed)) {
        return { service, identity: existing, surface: renewed.surface }
      }
      this.claims.delete(key)
      if (renewed.detail?.state !== 'expired' && renewed.detail?.state !== 'released') return renewed
    }

    const acquired = service.acquire(acquireInput)
    if (isAgentBrowserError(acquired)) return acquired
    const identity: BrowserTargetClaimIdentity = {
      partition: acquired.logicalKey.partition,
      tabId: acquired.logicalKey.tabId,
      physicalTargetToken: acquired.physicalTargetToken!,
      bootIncarnationId: acquired.bootIncarnationId!,
      claimId: acquired.claimId,
      generation: acquired.generation,
      ownerRunId: acquired.ownerRunId,
    }
    this.claims.set(key, identity)
    return { service, identity, surface: acquired.surface }
  }

  get isHeld(): boolean {
    return this.claims.size > 0
  }

  release(): void {
    this.claims.clear()
    this.ended = true
  }
}

export function createBrowserTurnLease(
  ids: { taskId: string; runId: string },
  service?: BrowserTargetClaimService,
): BrowserTurnLease {
  return new BrowserTurnLease(ids, service)
}
