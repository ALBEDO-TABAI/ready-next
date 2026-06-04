import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { AgentTabControlGate } from '../main/modules/browser-engine/agent-tab-control-gate'

describe('AgentTabControlGate (freeze-then-confirm, §3.6)', () => {
  it('starts active and permits writes', () => {
    const gate = new AgentTabControlGate()
    assert.equal(gate.getState(), 'active')
    assert.equal(gate.isWriteBlocked(), false)
  })

  it('a user interruption freezes writes pending confirmation (does not cancel)', () => {
    const gate = new AgentTabControlGate()
    assert.equal(gate.requestInterruption(), true)
    assert.equal(gate.getState(), 'pending_confirm')
    assert.equal(gate.isWriteBlocked(), true, 'agent writes frozen while awaiting confirmation')
  })

  it('dismissing the confirmation unfreezes and the agent resumes', () => {
    const gate = new AgentTabControlGate()
    gate.requestInterruption()
    gate.dismissInterruption()
    assert.equal(gate.getState(), 'active')
    assert.equal(gate.isWriteBlocked(), false)
  })

  it('confirming the interruption moves to frozen (writes stay blocked for cancel/takeover)', () => {
    const gate = new AgentTabControlGate()
    gate.requestInterruption()
    assert.equal(gate.confirmInterruption(), true)
    assert.equal(gate.getState(), 'frozen')
    assert.equal(gate.isWriteBlocked(), true)
  })

  it('a second interruption while pending is a no-op', () => {
    const gate = new AgentTabControlGate()
    gate.requestInterruption()
    assert.equal(gate.requestInterruption(), false)
    assert.equal(gate.getState(), 'pending_confirm')
  })

  it('confirm/dismiss are no-ops when not pending', () => {
    const gate = new AgentTabControlGate()
    assert.equal(gate.confirmInterruption(), false)
    gate.dismissInterruption()
    assert.equal(gate.getState(), 'active')
  })

  it('reset returns the gate to active', () => {
    const gate = new AgentTabControlGate()
    gate.requestInterruption()
    gate.confirmInterruption()
    gate.reset()
    assert.equal(gate.getState(), 'active')
    assert.equal(gate.isWriteBlocked(), false)
  })
})
