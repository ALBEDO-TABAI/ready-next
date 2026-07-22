import type { AgentBrowserSurface } from './agent-browser-errors'
import type { BrowserTargetClaim, BrowserTargetClaimService } from './browser-target-claims'
import type { BrowserLeaseSupervisionSnapshot, BrowserLeaseSurfaceSnapshot } from './ipc-supervision'

const SURFACES: AgentBrowserSurface[] = ['user-view', 'agent-view']

function surfaceState(claim: BrowserTargetClaim | undefined): BrowserLeaseSurfaceSnapshot['state'] {
  if (!claim || claim.state === 'released') return 'idle'
  if (claim.state === 'user_owned') return 'takeover'
  if (claim.state === 'held') return 'held'
  return 'expired'
}

export function buildBrowserLeaseSupervisionSnapshot(
  service: BrowserTargetClaimService,
): BrowserLeaseSupervisionSnapshot {
  const claims = service.list()
  const surfaces = Object.fromEntries(SURFACES.map((surface) => {
    const claim = claims.find((candidate) => candidate.surface === surface && (
      candidate.state === 'held' || candidate.state === 'user_owned' || candidate.state === 'suspended'
    ))
    return [surface, {
      surface,
      state: surfaceState(claim),
      heldBy: claim?.parentTaskId ?? null,
      runId: claim?.ownerRunId ?? null,
      tabId: claim?.logicalKey.tabId ?? null,
      leaseId: claim?.claimId ?? null,
    }]
  })) as Record<AgentBrowserSurface, BrowserLeaseSurfaceSnapshot>
  const activeWriteSurface = SURFACES.find((surface) => surfaces[surface].state === 'held') ?? null
  return {
    claims: claims.map((claim) => ({
      partition: claim.logicalKey.partition,
      tabId: claim.logicalKey.tabId,
      surface: claim.surface,
      state: claim.state,
      parentTaskId: claim.parentTaskId,
      browserTaskId: claim.browserTaskId,
      ownerRunId: claim.ownerRunId,
      claimId: claim.claimId,
      generation: claim.generation,
      suspensionCheckpointId: claim.suspensionCheckpointId,
      suspensionReason: claim.suspensionReason,
    })),
    surfaces,
    activeWriteSurface,
  }
}
