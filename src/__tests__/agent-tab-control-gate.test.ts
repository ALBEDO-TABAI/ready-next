import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  beginAgentTabUserTakeover,
  createAgentTabUserInputTakeoverHandlers,
  persistAgentTabUserTakeover,
} from '../main/modules/browser-engine/agent-tab-control-gate'
import { BrowserWriteLeaseService } from '../main/modules/browser-engine/browser-write-lease'

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
    const leaseService = new BrowserWriteLeaseService()
    leaseService.acquire({ surface: 'agent-view', taskId: 'research-task', runId: 'run-1', tabId: 'agent-tab' })
    const handlers = createAgentTabUserInputTakeoverHandlers({
      isActivelyDriven: () => activelyDriven,
      isFrozen: () => leaseService.getState('agent-view') === 'takeover',
      isAgentKey: (key) => key === 'AgentKey',
      isAgentMouse: () => false,
      takeOver: () => {
        takeovers += 1
        beginAgentTabUserTakeover({
          isTakenOver: () => leaseService.getState('agent-view') === 'takeover',
          fenceGroundedTasks: () => { groundedFenced = true },
          recordLeaseTakeover: () => {
            leaseService.recordUserSignal({ surface: 'agent-view', source: 'explicit-button' })
          },
        })
      },
    })
    const electronEvent = { preventDefault: () => { prevented += 1 } }

    handlers.onKeyboardInput(electronEvent, { type: 'keyDown', key: 'a' })
    assert.equal(takeovers, 1)
    assert.equal(prevented, 0, 'the physical key must continue into the page')
    assert.equal(groundedFenced, true, 'the grounded task is fenced before the listener returns')
    assert.equal(leaseService.getState('agent-view'), 'takeover', 'the next agent-view write is rejected synchronously')

    leaseService.clearTakeover('agent-view')
    leaseService.acquire({ surface: 'agent-view', taskId: 'research-task-2', runId: 'run-2', tabId: 'agent-tab' })
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
    const leaseService = new BrowserWriteLeaseService()
    leaseService.acquire({ surface: 'user-view', taskId: 'browser-child', runId: 'owner-run', tabId: 'tab-a' })
    leaseService.recordUserSignal({ surface: 'user-view', source: 'explicit-button' })
    let successCleanup = 0
    let failures = 0

    const persisted = await persistAgentTabUserTakeover({
      persist: async () => { throw new Error('sqlite busy') },
      onPersisted: () => {
        successCleanup += 1
        leaseService.clearTakeover('user-view')
      },
      onPersistenceFailure: () => { failures += 1 },
    })

    assert.equal(persisted, false)
    assert.equal(failures, 1)
    assert.equal(successCleanup, 0)
    assert.equal(leaseService.getState('user-view'), 'takeover')
    assert.equal(leaseService.checkWrite({ surface: 'user-view', leaseId: 'stale' })?.errorCode, 'lease_takeover')
  })
})
