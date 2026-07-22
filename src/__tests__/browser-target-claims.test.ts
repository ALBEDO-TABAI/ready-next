import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isAgentBrowserError } from '../main/modules/browser-engine/agent-browser-errors'
import {
  acquireTarget,
  createTargetClaimService,
  identityOf,
  TARGET_A,
} from './utils/browser-target-claim-fixture'

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
    const taken = service.recordUserSignal({
      target: identityOf(a),
      source: 'pointer',
      suspensionCheckpointId: 'checkpoint-a',
    })

    assert.equal(taken?.state, 'user_owned')
    assert.equal(service.checkWrite(identityOf(a))?.errorCode, 'lease_takeover')
    assert.equal(service.checkWrite(identityOf(b)), null)
  })

  it('suppresses an Agent navigation echo but accepts an explicit takeover mid-action', () => {
    const service = createTargetClaimService()
    const claim = acquireTarget(service)
    const identity = identityOf(claim)
    const correlationId = service.beginAgentAction(identity)
    if (isAgentBrowserError(correlationId)) throw new Error(correlationId.message)

    assert.equal(service.recordUserSignal({
      target: identity,
      source: 'navigation',
      suspensionCheckpointId: 'checkpoint-nav',
    }), null)
    assert.equal(service.read(claim.logicalKey)?.state, 'held')
    assert.equal(service.recordUserSignal({
      target: identity,
      source: 'explicit-button',
      suspensionCheckpointId: 'checkpoint-button',
    })?.state, 'user_owned')
  })

  it('settles logical close by current state without leaving a held owner', () => {
    const heldService = createTargetClaimService()
    const held = acquireTarget(heldService)
    assert.equal(heldService.closeTarget(held.logicalKey)?.state, 'expired')

    const userService = createTargetClaimService()
    const user = acquireTarget(userService)
    userService.recordUserSignal({
      target: identityOf(user),
      source: 'keyboard',
      suspensionCheckpointId: 'checkpoint-user',
    })
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
    service.recordUserSignal({
      target: identityOf(a),
      source: 'keyboard',
      suspensionCheckpointId: 'checkpoint-a',
    })
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

  it('invalidates the old physical identity on boot restart', () => {
    const service = createTargetClaimService()
    const claim = acquireTarget(service)
    service.expireBoot('boot-test')
    const readback = service.read(claim.logicalKey)
    assert.equal(readback?.state, 'expired')
    assert.equal(readback?.physicalTargetToken, null)
    assert.ok(service.checkWrite(identityOf(claim)))
  })
})
