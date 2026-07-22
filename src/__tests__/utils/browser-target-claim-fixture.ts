import {
  BrowserTargetClaimService,
  MemoryBrowserTargetClaimRepository,
  type BrowserTargetClaim,
  type BrowserTargetClaimAcquireInput,
  type BrowserTargetClaimIdentity,
} from '../../main/modules/browser-engine/browser-target-claims'
import { isAgentBrowserError } from '../../main/modules/browser-engine/agent-browser-errors'

export const TARGET_A: BrowserTargetClaimAcquireInput = {
  partition: 'persist:browser',
  tabId: 'tab-a',
  physicalTargetToken: 'boot-test:tab-a:1',
  bootIncarnationId: 'boot-test',
  profileId: null,
  surface: 'user-view',
  parentTaskId: 'task-a',
  browserTaskId: 'browser-task-a',
  ownerRunId: 'run-a',
  scopeId: 'scope-a',
  sessionId: null,
}

export function createTargetClaimService(input: {
  now?: () => number
  defaultTtlMs?: number
  generateId?: () => string
} = {}): BrowserTargetClaimService {
  return new BrowserTargetClaimService(new MemoryBrowserTargetClaimRepository(), input)
}

export function acquireTarget(
  service: BrowserTargetClaimService,
  patch: Partial<BrowserTargetClaimAcquireInput> = {},
): BrowserTargetClaim {
  const claim = service.acquire({ ...TARGET_A, ...patch })
  if (isAgentBrowserError(claim)) throw new Error(`${claim.errorCode}: ${claim.message}`)
  return claim
}

export function identityOf(claim: BrowserTargetClaim): BrowserTargetClaimIdentity {
  if (!claim.physicalTargetToken || !claim.bootIncarnationId) throw new Error('claim has no physical identity')
  return {
    partition: claim.logicalKey.partition,
    tabId: claim.logicalKey.tabId,
    physicalTargetToken: claim.physicalTargetToken,
    bootIncarnationId: claim.bootIncarnationId,
    claimId: claim.claimId,
    generation: claim.generation,
    ownerRunId: claim.ownerRunId,
  }
}
