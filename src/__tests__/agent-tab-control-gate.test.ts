import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  beginAgentTabUserTakeover,
  createAgentTabUserInputTakeoverHandlers,
  persistAgentTabUserTakeover,
} from '../main/modules/browser-engine/agent-tab-control-gate'
import { acquireTarget, createTargetClaimService, identityOf, setTargetUserOwnedForTest } from './utils/browser-target-claim-fixture'

describe('agent tab immediate takeover', () => {
  it('records the lease takeover and fences grounded work exactly once', () => {
    let takenOver = false
    let fenced = 0
    let recorded = 0
    const takeOver = () => beginAgentTabUserTakeover({
      isTakenOver: () => takenOver,
      fenceGroundedTasks: () => { fenced += 1 },
      recordLeaseTakeover: () => { recorded += 1; takenOver = true },
    })
    assert.equal(takeOver(), true)
    assert.equal(takeOver(), false)
    assert.equal(recorded, 1)
    assert.equal(fenced, 1)
  })

  it('routes real before-input and before-mouse payloads to immediate takeover without blocking user input', () => {
    let takeovers = 0
    let prevented = 0
    let groundedFenced = false
    let activelyDriven = true
    const claimService = createTargetClaimService()
    let claim = acquireTarget(claimService, {
      surface: 'agent-view',
      parentTaskId: 'research-task',
      ownerRunId: 'run-1',
      tabId: 'agent-tab',
    })
    const handlers = createAgentTabUserInputTakeoverHandlers({
      isActivelyDriven: () => activelyDriven,
      isFrozen: () => claimService.read(claim.logicalKey)?.state === 'user_owned',
      isAgentKey: (key) => key === 'AgentKey',
      isAgentMouse: () => false,
      takeOver: () => {
        takeovers += 1
        beginAgentTabUserTakeover({
          isTakenOver: () => claimService.read(claim.logicalKey)?.state === 'user_owned',
          fenceGroundedTasks: () => { groundedFenced = true },
          recordLeaseTakeover: () => {
            setTargetUserOwnedForTest(claimService, claim, 'checkpoint-user')
          },
        })
      },
    })
    const electronEvent = { preventDefault: () => { prevented += 1 } }

    handlers.onKeyboardInput(electronEvent, { type: 'keyDown', key: 'a' })
    assert.equal(takeovers, 1)
    assert.equal(prevented, 0, 'the physical key must continue into the page')
    assert.equal(groundedFenced, true, 'the grounded task is fenced before the listener returns')
    assert.equal(claimService.read(claim.logicalKey)?.state, 'user_owned', 'the next write to that target is rejected synchronously')

    claimService.closeTarget(claim.logicalKey)
    claim = acquireTarget(claimService, {
      surface: 'agent-view',
      parentTaskId: 'research-task-2',
      ownerRunId: 'run-2',
      tabId: 'agent-tab',
    })
    takeovers = 0
    handlers.onKeyboardInput(electronEvent, { type: 'keyDown', key: 'AgentKey' })
    assert.equal(takeovers, 0, 'trusted injected input must not look like a user takeover')
    handlers.onMouseInput(electronEvent, { type: 'mouseDown' })
    assert.equal(takeovers, 1)
    assert.equal(prevented, 0, 'the physical mouse action must continue into the page')

    takeovers = 0
    activelyDriven = false
    handlers.onKeyboardInput(electronEvent, { type: 'keyDown', key: 'b' })
    assert.equal(takeovers, 0, 'an idle leftover agent tab must not capture user input')
  })

  it('retains the physical fence when durable takeover persistence fails', async () => {
    const claimService = createTargetClaimService()
    const claim = acquireTarget(claimService, {
      parentTaskId: 'browser-child',
      ownerRunId: 'owner-run',
      tabId: 'tab-a',
    })
    setTargetUserOwnedForTest(claimService, claim, 'checkpoint-user')
    let successCleanup = 0
    let failures = 0

    const persisted = await persistAgentTabUserTakeover({
      persist: async () => { throw new Error('sqlite busy') },
      onPersisted: () => {
        successCleanup += 1
        claimService.closeTarget(claim.logicalKey)
      },
      onPersistenceFailure: () => { failures += 1 },
    })

    assert.equal(persisted, false)
    assert.equal(failures, 1)
    assert.equal(successCleanup, 0)
    assert.equal(claimService.read(claim.logicalKey)?.state, 'user_owned')
    assert.equal(claimService.checkWrite(identityOf(claim))?.errorCode, 'lease_takeover')
  })
})
