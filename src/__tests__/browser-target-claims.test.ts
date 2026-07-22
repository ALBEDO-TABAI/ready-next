import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isAgentBrowserError } from '../main/modules/browser-engine/agent-browser-errors'
import {
  acquireTarget,
  createTargetClaimService,
  identityOf,
  setTargetUserOwnedForTest,
  TARGET_A,
} from './utils/browser-target-claim-fixture'
import {
  BrowserTargetClaimService,
  MemoryBrowserTargetClaimRepository,
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

  it('closeout settles every held target for the old run while preserving user-owned A', () => {
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
    assert.equal(states.get('tab-a'), 'user_owned')
    assert.equal(states.get('tab-b'), 'suspended')
    assert.equal(service.heldForRun('run-a').length, 0)
  })

})
