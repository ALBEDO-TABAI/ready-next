import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BrowserTurnLease } from '../main/modules/browser-engine/agent-browser-turn-lease'
import { isAgentBrowserError } from '../main/modules/browser-engine/agent-browser-errors'
import type { BrowserTargetClaimAcquireInput } from '../main/modules/browser-engine/browser-target-claims'
import {
  createTargetClaimService,
  setTargetUserOwnedForTest,
  TARGET_A,
} from './utils/browser-target-claim-fixture'

function target(patch: Partial<BrowserTargetClaimAcquireInput> = {}) {
  const { parentTaskId: _parentTaskId, ownerRunId: _ownerRunId, ...input } = { ...TARGET_A, ...patch }
  return input
}

describe('BrowserTurnLease target claims', () => {
  it('lazily acquires and reuses the exact target claim', () => {
    const service = createTargetClaimService()
    const turn = new BrowserTurnLease({ taskId: 'task-a', runId: 'run-a' }, service)
    assert.equal(service.list().length, 0)

    const first = turn.ensureGateForTarget(target())
    const second = turn.ensureGateForTarget(target())
    assert.ok(!isAgentBrowserError(first))
    assert.ok(!isAgentBrowserError(second))
    if (isAgentBrowserError(first) || isAgentBrowserError(second)) return
    assert.equal(first.identity.claimId, second.identity.claimId)
  })

  it('acquires a distinct claim when the same turn moves from A to B', () => {
    const service = createTargetClaimService()
    const turn = new BrowserTurnLease({ taskId: 'task-a', runId: 'run-a' }, service)
    const a = turn.ensureGateForTarget(target())
    const b = turn.ensureGateForTarget(target({
      tabId: 'tab-b',
      physicalTargetToken: 'boot-test:tab-b:1',
    }))
    assert.ok(!isAgentBrowserError(a))
    assert.ok(!isAgentBrowserError(b))
    if (isAgentBrowserError(a) || isAgentBrowserError(b)) return
    assert.notEqual(a.identity.claimId, b.identity.claimId)
  })

  it('does not let takeover on A contaminate B', () => {
    const service = createTargetClaimService()
    const turn = new BrowserTurnLease({ taskId: 'task-a', runId: 'run-a' }, service)
    const a = turn.ensureGateForTarget(target())
    if (isAgentBrowserError(a)) throw new Error(a.message)
    const claim = service.read(a.identity)
    if (!claim) throw new Error('claim missing')
    setTargetUserOwnedForTest(service, claim, 'checkpoint-a')
    const b = turn.ensureGateForTarget(target({
      tabId: 'tab-b',
      physicalTargetToken: 'boot-test:tab-b:1',
    }))
    assert.ok(!isAgentBrowserError(b))
  })

  it('seals the turn without silently releasing durable claims before finalizer closeout', () => {
    const service = createTargetClaimService()
    const turn = new BrowserTurnLease({ taskId: 'task-a', runId: 'run-a' }, service)
    turn.ensureGateForTarget(target())
    turn.release()
    assert.equal(service.heldForRun('run-a').length, 1)
    assert.ok(isAgentBrowserError(turn.ensureGateForTarget(target())))

    service.closeoutRun({ ownerRunId: 'run-a', resumable: false })
    assert.equal(service.heldForRun('run-a').length, 0)
  })
})
