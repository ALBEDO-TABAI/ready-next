import type { AgentBrowserSurface } from './agent-browser-errors'
import type { BrowserTargetClaim, BrowserTargetClaimService } from './browser-target-claims'
import type { BrowserLeaseSupervisionSnapshot, BrowserLeaseSurfaceSnapshot } from './ipc-supervision'

const SURFACES: AgentBrowserSurface[] = ['user-view', 'agent-view']

export function isLiveBrowserUserOwnedClaim(claim: Pick<BrowserTargetClaim, 'state' | 'physicalTargetToken' | 'bootIncarnationId'>): boolean {
  return claim.state === 'user_owned'
    && Boolean(claim.physicalTargetToken)
    && Boolean(claim.bootIncarnationId)
}

function surfaceState(claim: BrowserTargetClaim | undefined): BrowserLeaseSurfaceSnapshot['state'] {
  if (!claim || claim.state === 'released') return 'idle'
  if (isLiveBrowserUserOwnedClaim(claim)) return 'takeover'
  if (claim.state === 'held') return 'held'
  return 'expired'
}

function selectSurfaceClaim(
  claims: BrowserTargetClaim[],
  surface: AgentBrowserSurface,
  currentTabId?: string | null,
): BrowserTargetClaim | undefined {
  const surfaceClaims = claims.filter((candidate) => candidate.surface === surface && (
    candidate.state === 'held'
    || isLiveBrowserUserOwnedClaim(candidate)
    || candidate.state === 'suspended'
  ))
  const currentTakeover = currentTabId
    ? surfaceClaims.find((candidate) => (
      isLiveBrowserUserOwnedClaim(candidate)
      && candidate.logicalKey.tabId === currentTabId
    ))
    : undefined
  return currentTakeover
    || surfaceClaims.find((candidate) => candidate.state === 'held')
    || surfaceClaims.find((candidate) => isLiveBrowserUserOwnedClaim(candidate))
    || surfaceClaims.find((candidate) => candidate.state === 'suspended')
}

export function buildBrowserLeaseSupervisionSnapshot(
  service: BrowserTargetClaimService,
  currentTabId?: string | null,
): BrowserLeaseSupervisionSnapshot {
  const claims = service.list()
  const surfaces = Object.fromEntries(SURFACES.map((surface) => {
    const claim = selectSurfaceClaim(claims, surface, currentTabId)
    return [surface, {
      surface,
      state: surfaceState(claim),
      heldBy: claim?.parentTaskId ?? null,
      runId: claim?.ownerRunId ?? null,
      tabId: claim?.logicalKey.tabId ?? null,
      leaseId: claim?.claimId ?? null,
    }]
  })) as Record<AgentBrowserSurface, BrowserLeaseSurfaceSnapshot>
  const activeWriteSurface = SURFACES.find((surface) => claims.some((claim) => (
    claim.surface === surface && claim.state === 'held'
  ))) ?? null
  return {
    claims: claims
      .filter((claim) => (
        claim.state === 'held'
        || claim.state === 'suspended'
        || isLiveBrowserUserOwnedClaim(claim)
      ))
      .map((claim) => ({
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
