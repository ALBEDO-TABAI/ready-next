import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isAgentBrowserError } from '../main/modules/browser-engine/agent-browser-errors'
import {
  acquireTarget,
  createTargetClaimService,
  identityOf,
  releaseTargetWithoutServiceForTest,
  setTargetUserOwnedForTest,
  TARGET_A,
} from './utils/browser-target-claim-fixture'
import {
  BrowserTargetClaimService,
  MemoryBrowserTargetClaimRepository,
  type BrowserTargetClaimMutationStore,
} from '../main/modules/browser-engine/browser-target-claims'

describe('Browser target claims', () => {
  it('lets one Owner hold independent A and B targets on the same surface', () => {
    const service = createTargetClaimService()
    const a = acquireTarget(service)
    const b = acquireTarget(service, {
      tabId: 'tab-b',
      physicalTargetToken: 'boot-test:tab-b:1',
      browserTaskId: a.browserTaskId,
      parentTaskId: a.parentTaskId,
      ownerRunId: a.ownerRunId,
    })

    assert.notEqual(a.claimId, b.claimId)
    assert.equal(service.checkWrite(identityOf(a)), null)
    assert.equal(service.checkWrite(identityOf(b)), null)
  })

  it('keeps one current writer per logical target', () => {
    const service = createTargetClaimService()
    acquireTarget(service)
    const second = service.acquire({
      ...TARGET_A,
      ownerRunId: 'run-other',
      parentTaskId: 'task-other',
      browserTaskId: 'browser-task-other',
    })
    assert.ok(isAgentBrowserError(second))
    if (!isAgentBrowserError(second)) return
    assert.equal(second.errorCode, 'lease_held')
    assert.equal(second.detail?.tabId, 'tab-a')
  })

  it('audits a rejected competing claim once per operation', () => {
    const repository = new MemoryBrowserTargetClaimRepository()
    const service = new BrowserTargetClaimService(repository)
    const first = service.acquire({ ...TARGET_A, operationId: 'first-acquire' })
    if (isAgentBrowserError(first)) throw new Error(first.message)
    const rejectedInput = {
      ...TARGET_A,
      operationId: 'competing-acquire',
      ownerRunId: 'run-other',
      parentTaskId: 'task-other',
      browserTaskId: 'browser-task-other',
    }
    assert.ok(isAgentBrowserError(service.acquire(rejectedInput)))
    assert.ok(isAgentBrowserError(service.acquire(rejectedInput)))
    const rejected = repository.listReceipts().filter((receipt) => receipt.kind === 'claim_rejected')
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0]?.errorCode, 'lease_held')
  })

  it('rejects an old generation after close and reacquire', () => {
    const service = createTargetClaimService()
    const oldClaim = acquireTarget(service)
    service.closeTarget(oldClaim.logicalKey)
    const next = acquireTarget(service, { ownerRunId: 'run-next' })

    assert.ok(service.checkWrite(identityOf(oldClaim)))
    assert.equal(service.checkWrite(identityOf(next)), null)
    assert.ok(next.generation > oldClaim.generation)
  })

  it('fences only the exact target on trusted user input', () => {
    const service = createTargetClaimService()
    const a = acquireTarget(service)
    const b = acquireTarget(service, {
      tabId: 'tab-b',
      physicalTargetToken: 'boot-test:tab-b:1',
    })
    const taken = setTargetUserOwnedForTest(service, a, 'checkpoint-a')

    assert.equal(taken?.state, 'user_owned')
    assert.equal(service.checkWrite(identityOf(a))?.errorCode, 'lease_takeover')
    assert.equal(service.checkWrite(identityOf(b)), null)
  })

  it('keeps the old writer fenced when durable user takeover persistence fails', () => {
    class FailingTakeoverRepository extends MemoryBrowserTargetClaimRepository {
      failWrites = false

      override mutate<T>(body: (store: BrowserTargetClaimMutationStore) => T): T {
        if (!this.failWrites) return super.mutate(body)
        return super.mutate((store) => body({
          ...store,
          write: () => { throw new Error('takeover persistence failed') },
        }))
      }
    }
    const repository = new FailingTakeoverRepository()
    const service = new BrowserTargetClaimService(repository)
    const claim = acquireTarget(service)
    repository.failWrites = true

    const result = service.takeOver(identityOf(claim))

    assert.ok(isAgentBrowserError(result))
    if (!isAgentBrowserError(result)) return
    assert.equal(result.errorCode, 'lease_takeover')
    assert.equal(repository.read(claim.logicalKey)?.state, 'held')
    repository.failWrites = false
    assert.equal(service.checkWrite(identityOf(claim))?.errorCode, 'lease_takeover')
  })

  it('does not retain an in-memory fence after durable user takeover succeeds', () => {
    const service = createTargetClaimService()
    const claim = acquireTarget(service)

    const result = service.takeOver(identityOf(claim))

    assert.ok(!isAgentBrowserError(result))
    const fences = (service as unknown as { locallyFencedClaimIds: Set<string> }).locallyFencedClaimIds
    assert.equal(fences.size, 0)
    assert.equal(service.checkWrite(identityOf(claim))?.errorCode, 'lease_takeover')
  })

  it('settles logical close by current state without leaving a held owner', () => {
    const heldService = createTargetClaimService()
    const held = acquireTarget(heldService)
    assert.equal(heldService.closeTarget(held.logicalKey)?.state, 'expired')

    const userService = createTargetClaimService()
    const user = acquireTarget(userService)
    setTargetUserOwnedForTest(userService, user, 'checkpoint-user')
    assert.equal(userService.closeTarget(user.logicalKey)?.state, 'released')
  })

  it('turns a held owner into a resumable stale target on physical replacement', () => {
    const service = createTargetClaimService()
    const oldClaim = acquireTarget(service)
    const next = service.replacePhysicalTarget({
      partition: oldClaim.logicalKey.partition,
      tabId: oldClaim.logicalKey.tabId,
      physicalTargetToken: 'boot-test:tab-a:2',
      bootIncarnationId: 'boot-test',
    }, 'checkpoint-target-stale')

    assert.equal(next?.state, 'suspended')
    assert.equal(next?.suspensionReason, 'browser_target_replaced')
    assert.equal(next?.suspensionCheckpointId, 'checkpoint-target-stale')
    assert.ok(service.checkWrite(identityOf(oldClaim)))
  })

  it('expires physical target ownership from a previous app boot', () => {
    const service = createTargetClaimService()
    const oldClaim = acquireTarget(service, {
      physicalTargetToken: 'boot-old:tab-a:1',
      bootIncarnationId: 'boot-old',
    })
    const expired = service.expirePreviousBoot('boot-current')

    assert.equal(expired.length, 1)
    assert.equal(service.read(oldClaim.logicalKey)?.state, 'expired')
    assert.equal(service.read(oldClaim.logicalKey)?.physicalTargetToken, null)
  })

  it('durable SQL release still needs acknowledge to clear in-flight page control', () => {
    const service = createTargetClaimService()
    const claim = acquireTarget(service)
    const identity = identityOf(claim)
    const actionId = service.beginAgentAction(identity)
    if (typeof actionId !== 'string') throw new Error(actionId.message)
    assert.equal(service.hasActiveAgentAction(identity), true)

    releaseTargetWithoutServiceForTest(service, claim)
    assert.equal(service.closeoutRun({ ownerRunId: 'run-a', resumable: false }).length, 0)
    assert.equal(service.hasActiveAgentAction(identity), true)

    const transitions: Array<{ previousState: string | null; state: string }> = []
    service.onTransition((transition) => {
      transitions.push({ previousState: transition.previousState, state: transition.state })
    })
    service.acknowledgeExternalRelease('run-a')
    assert.equal(service.hasActiveAgentAction(identity), false)
    assert.ok(transitions.some((item) => item.previousState === 'held' && item.state === 'released'))
    const afterFirst = transitions.length
    service.acknowledgeExternalRelease('run-a')
    assert.equal(transitions.length, afterFirst)
  })

  it('closeout releases every target for the old run even when a historical checkpoint exists', () => {
    const service = createTargetClaimService()
    const a = acquireTarget(service)
    acquireTarget(service, {
      tabId: 'tab-b',
      physicalTargetToken: 'boot-test:tab-b:1',
    })
    setTargetUserOwnedForTest(service, a, 'checkpoint-a')
    service.closeoutRun({
      ownerRunId: 'run-a',
      resumable: true,
      suspensionCheckpointId: 'checkpoint-run',
      suspensionReason: 'provider_error',
    })

    const states = new Map(service.list().map((claim) => [claim.logicalKey.tabId, claim.state]))
    assert.equal(states.get('tab-a'), 'released')
    assert.equal(states.get('tab-b'), 'released')
    assert.equal(service.heldForRun('run-a').length, 0)
  })

  it('conversation reset releases only exact-scope claims and rejects the old owner after reacquire', () => {
    const service = createTargetClaimService()
    const old = acquireTarget(service, { scopeId: 'scope-reset', sessionId: 'scope-reset' })
    const oldIdentity = identityOf(old)
    setTargetUserOwnedForTest(service, old, 'checkpoint-old-context')
    const other = acquireTarget(service, {
      tabId: 'tab-other',
      physicalTargetToken: 'boot-test:tab-other:1',
      scopeId: 'scope-other',
      sessionId: 'scope-other',
      ownerRunId: 'run-other',
    })

    const closed = service.closeScopeContext('scope-reset')
    assert.equal(closed.length, 1)
    assert.equal(service.read(old.logicalKey)?.state, 'released')
    assert.equal(service.checkWrite(oldIdentity)?.errorCode, 'lease_required')
    assert.equal(service.checkWrite(identityOf(other)), null)

    const current = acquireTarget(service, {
      scopeId: 'scope-reset',
      sessionId: 'scope-reset',
      ownerRunId: 'run-new-context',
      parentTaskId: 'task-new-context',
      browserTaskId: 'browser-new-context',
    })
    assert.equal(service.checkWrite(identityOf(current)), null)
    assert.ok(current.generation > old.generation)
  })

  it('conversation reset closes every old claim even when a transition observer throws', () => {
    const service = createTargetClaimService()
    const oldClaims = ['tab-a', 'tab-b', 'tab-c'].map((tabId, index) => acquireTarget(service, {
      tabId,
      physicalTargetToken: `boot-test:${tabId}:1`,
      scopeId: 'scope-reset-observer',
      sessionId: 'scope-reset-observer',
      browserTaskId: `browser-task-${index}`,
    }))
    service.onTransition(() => {
      throw new Error('observer failed')
    })

    const closed = service.closeScopeContext('scope-reset-observer')

    assert.equal(closed.length, 3)
    for (const claim of oldClaims) {
      assert.notEqual(service.read(claim.logicalKey)?.state, 'held')
      assert.ok(service.checkWrite(identityOf(claim)))
    }
  })

  it('durable epoch permanently fences an old owner when reset cleanup writes keep failing', () => {
    let durableEpoch = 0
    class FailingClaimRepository extends MemoryBrowserTargetClaimRepository {
      failWrites = false

      override mutate<T>(body: (store: BrowserTargetClaimMutationStore) => T): T {
        if (!this.failWrites) return super.mutate(body)
        return super.mutate((store) => body({
          ...store,
          write: () => {
            throw new Error('browser claim database write failed')
          },
        }))
      }
    }
    const repository = new FailingClaimRepository(() => ({
      kind: 'open',
      messageVisibilityEpoch: durableEpoch,
    }))
    const service = new BrowserTargetClaimService(repository)
    const old = acquireTarget(service, {
      scopeId: 'scope-reset-failure',
      sessionId: 'scope-reset-failure',
      messageVisibilityEpoch: 0,
    })
    const oldIdentity = identityOf(old)

    durableEpoch = 1
    repository.failWrites = true
    assert.throws(() => service.closeScopeContext('scope-reset-failure'), /database write failed/)
    assert.throws(() => service.closeScopeContext('scope-reset-failure'), /database write failed/)
    repository.failWrites = false

    assert.equal(repository.read(old.logicalKey)?.state, 'held')
    assert.equal(service.checkWrite(oldIdentity)?.errorCode, 'lease_required')
    const lateOldAcquire = service.acquire({
      ...TARGET_A,
      scopeId: 'scope-reset-failure',
      sessionId: 'scope-reset-failure',
      messageVisibilityEpoch: 0,
      ownerRunId: 'late-old-run',
    })
    assert.ok(isAgentBrowserError(lateOldAcquire))
    if (!isAgentBrowserError(lateOldAcquire)) throw new Error('late old acquire unexpectedly succeeded')
    assert.equal(lateOldAcquire.errorCode, 'lease_required')

    const current = acquireTarget(service, {
      scopeId: 'scope-reset-failure',
      sessionId: 'scope-reset-failure',
      messageVisibilityEpoch: 1,
      ownerRunId: 'run-current-context',
      parentTaskId: 'task-current-context',
      browserTaskId: 'browser-current-context',
    })
    assert.equal(service.checkWrite(identityOf(current)), null)
    assert.equal(service.checkWrite(identityOf(current)), null, 'same-epoch stop preserves the current owner')
  })

})
