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
  const repository = new MemoryBrowserTargetClaimRepository()
  const service = new BrowserTargetClaimService(repository, input)
  repositories.set(service, repository)
  return service
}

const repositories = new WeakMap<BrowserTargetClaimService, MemoryBrowserTargetClaimRepository>()

export function setTargetUserOwnedForTest(
  service: BrowserTargetClaimService,
  claim: BrowserTargetClaim,
  checkpointId = 'checkpoint-test-user-owned',
): BrowserTargetClaim {
  const repository = repositories.get(service)
  if (!repository) throw new Error('test_target_claim_repository_missing')
  const current = repository.read(claim.logicalKey)
  if (!current) throw new Error('test_target_claim_missing')
  const next = {
    ...current,
    claimId: `test-user-owned-${current.claimId}`,
    generation: current.generation + 1,
    state: 'user_owned' as const,
    suspensionCheckpointId: checkpointId,
    suspensionReason: 'browser_target_user_owned',
    expiresAt: current.updatedAt,
    updatedAt: current.updatedAt + 1,
  }
  repository.mutate((store) => {
    if (!store.write(next, current.generation)) throw new Error('test_target_claim_cas_conflict')
  })
  return next
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
