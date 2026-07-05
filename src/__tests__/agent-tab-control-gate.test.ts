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

  it('pending_confirm blocks writes but is NOT frozen — only confirm cancels the task', () => {
    // Codex result-review #1 residual: the runner's cancel probe (isFrozen) must
    // not fire while merely pending, or the task would cancel before the user
    // confirms. Writes are still blocked during pending (isWriteBlocked).
    const gate = new AgentTabControlGate()
    assert.equal(gate.isFrozen(), false)
    assert.equal(gate.isWriteBlocked(), false)

    gate.requestInterruption()
    assert.equal(gate.getState(), 'pending_confirm')
    assert.equal(gate.isWriteBlocked(), true, 'pending blocks writes')
    assert.equal(gate.isFrozen(), false, 'pending must NOT cancel the task')

    gate.confirmInterruption()
    assert.equal(gate.getState(), 'frozen')
    assert.equal(gate.isWriteBlocked(), true)
    assert.equal(gate.isFrozen(), true, 'only a confirmed freeze cancels')
  })

  it('dismiss from pending clears both write-block and frozen', () => {
    const gate = new AgentTabControlGate()
    gate.requestInterruption()
    gate.dismissInterruption()
    assert.equal(gate.isWriteBlocked(), false)
    assert.equal(gate.isFrozen(), false)
  })

  // D8（真机反复实锚）：用户擦碰 agent 页后走开，pending_confirm 无人
  // 确认也无人取消 → 横幅常驻 + agent 写入永久冻结。合同：超时惰性回落
  // 视同 dismiss；确认过的 frozen 不受 TTL 影响；回落后可再次 request。
  it('stale pending_confirm lazily expires back to active (banner TTL)', () => {
    let clock = 1_000
    const gate = new AgentTabControlGate({ pendingConfirmTtlMs: 45_000, now: () => clock })
    gate.requestInterruption()
    assert.equal(gate.getState(), 'pending_confirm')

    clock += 44_000
    assert.equal(gate.getState(), 'pending_confirm', 'within TTL stays pending')
    assert.equal(gate.isWriteBlocked(), true)

    clock += 2_000
    assert.equal(gate.getState(), 'active', 'stale pending expires like a dismiss')
    assert.equal(gate.isWriteBlocked(), false)
    assert.equal(gate.requestInterruption(), true, 'a fresh interruption can start after expiry')
  })

  it('confirmed frozen state never expires by TTL', () => {
    let clock = 1_000
    const gate = new AgentTabControlGate({ pendingConfirmTtlMs: 45_000, now: () => clock })
    gate.requestInterruption()
    gate.confirmInterruption()
    clock += 10 * 60_000
    assert.equal(gate.getState(), 'frozen')
    assert.equal(gate.isFrozen(), true)
  })

  it('expiry cannot race a confirm: confirm after TTL is a no-op', () => {
    let clock = 1_000
    const gate = new AgentTabControlGate({ pendingConfirmTtlMs: 45_000, now: () => clock })
    gate.requestInterruption()
    clock += 46_000
    assert.equal(gate.confirmInterruption(), false, 'stale confirm must not freeze a resumed agent')
    assert.equal(gate.getState(), 'active')
  })

  // R18：惰性 TTL 回落不通知任何人——ipc 层按此值安排过期后的状态推送，
  // 否则 renderer 的「等待确认」胶囊在主进程自愈后仍永远挂着（第十七轮实锚）。
  it('exposes the pending-confirm TTL so callers can schedule an expiry push', () => {
    assert.equal(new AgentTabControlGate({ pendingConfirmTtlMs: 32_000 }).getPendingConfirmTtlMs(), 32_000)
    assert.equal(new AgentTabControlGate().getPendingConfirmTtlMs(), 45_000)
  })
})
