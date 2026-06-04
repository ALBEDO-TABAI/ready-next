import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BrowserWriteLeaseService } from '../main/modules/browser-engine/browser-write-lease'
import { isAgentBrowserError } from '../main/modules/browser-engine/agent-browser-errors'

function makeService(start = 1_000) {
  let clock = start
  const service = new BrowserWriteLeaseService({
    now: () => clock,
    defaultTtlMs: 10_000,
    actionGraceMs: 1_000,
  })
  return { service, advance: (ms: number) => { clock += ms }, set: (v: number) => { clock = v } }
}

describe('BrowserWriteLease', () => {
  it('starts idle and rejects writes with lease_required', () => {
    const { service } = makeService()
    assert.equal(service.getState('user-view'), 'idle')
    const denied = service.checkWrite({ surface: 'user-view', leaseId: null })
    assert.ok(denied && isAgentBrowserError(denied))
    assert.equal(denied?.errorCode, 'lease_required')
  })

  it('acquire grants a held lease and permits writes only with the matching id', () => {
    const { service } = makeService()
    const lease = service.acquire({ surface: 'user-view', taskId: 't1', runId: 'r1', tabId: 'tab-1' })
    assert.ok(!isAgentBrowserError(lease))
    if (isAgentBrowserError(lease)) return
    assert.equal(service.getState('user-view'), 'held')
    assert.equal(service.checkWrite({ surface: 'user-view', leaseId: lease.leaseId }), null)
    const wrong = service.checkWrite({ surface: 'user-view', leaseId: 'nope' })
    assert.equal(wrong?.errorCode, 'lease_required')
  })

  it('refuses a second writer with lease_held (no preemption, no queue)', () => {
    const { service } = makeService()
    service.acquire({ surface: 'user-view', taskId: 't1', runId: 'r1' })
    const second = service.acquire({ surface: 'user-view', taskId: 't2', runId: 'r2' })
    assert.ok(isAgentBrowserError(second))
    if (!isAgentBrowserError(second)) return
    assert.equal(second.errorCode, 'lease_held')
    assert.equal(second.detail?.heldBy, 't1')
  })

  it('expires by TTL and rolls to idle so a new task can recover', () => {
    const { service, advance } = makeService()
    const lease = service.acquire({ surface: 'user-view', taskId: 't1', runId: 'r1' })
    if (isAgentBrowserError(lease)) throw new Error('expected lease')
    advance(20_000)
    assert.equal(service.getState('user-view'), 'expired')
    const denied = service.checkWrite({ surface: 'user-view', leaseId: lease.leaseId })
    assert.equal(denied?.errorCode, 'lease_required')
    service.clearTakeover('user-view')
    const reacquired = service.acquire({ surface: 'user-view', taskId: 't2', runId: 'r2' })
    assert.ok(!isAgentBrowserError(reacquired))
  })

  it('heartbeat extends the expiry window', () => {
    const { service, advance } = makeService()
    const lease = service.acquire({ surface: 'user-view', taskId: 't1', runId: 'r1' })
    if (isAgentBrowserError(lease)) throw new Error('expected lease')
    advance(8_000)
    service.heartbeat(lease.leaseId)
    advance(8_000) // 16s total, but heartbeat reset the 10s window at 8s
    assert.equal(service.getState('user-view'), 'held')
  })

  it('user keyboard signal outside an action window triggers takeover; writes then get lease_takeover', () => {
    const { service } = makeService()
    const lease = service.acquire({ surface: 'user-view', taskId: 't1', runId: 'r1' })
    if (isAgentBrowserError(lease)) throw new Error('expected lease')
    const took = service.recordUserSignal({ surface: 'user-view', source: 'keyboard' })
    assert.equal(took, true)
    assert.equal(service.getState('user-view'), 'takeover')
    const denied = service.checkWrite({ surface: 'user-view', leaseId: lease.leaseId })
    assert.equal(denied?.errorCode, 'lease_takeover')
  })

  it('suppresses signals while an agent action window is open (no false takeover from agent-driven nav)', () => {
    const { service } = makeService()
    service.acquire({ surface: 'user-view', taskId: 't1', runId: 'r1' })
    const corr = service.beginAgentAction('user-view')
    const took = service.recordUserSignal({ surface: 'user-view', source: 'navigation' })
    assert.equal(took, false)
    assert.equal(service.getState('user-view'), 'held')
    service.endAgentAction('user-view', corr)
  })

  it('still suppresses during the post-action grace, then takes over after it elapses', () => {
    const { service, advance } = makeService()
    service.acquire({ surface: 'user-view', taskId: 't1', runId: 'r1' })
    const corr = service.beginAgentAction('user-view')
    service.endAgentAction('user-view', corr)
    assert.equal(service.recordUserSignal({ surface: 'user-view', source: 'navigation' }), false)
    advance(1_500) // past the 1000ms grace
    assert.equal(service.recordUserSignal({ surface: 'user-view', source: 'navigation' }), true)
    assert.equal(service.getState('user-view'), 'takeover')
  })

  it('explicit takeover button wins even mid-action (no blind spot for the deliberate signal)', () => {
    const { service } = makeService()
    service.acquire({ surface: 'user-view', taskId: 't1', runId: 'r1' })
    service.beginAgentAction('user-view')
    const took = service.recordUserSignal({ surface: 'user-view', source: 'explicit-button' })
    assert.equal(took, true)
    assert.equal(service.getState('user-view'), 'takeover')
  })

  it('blocks a new acquire while the surface is under user takeover (no seizing)', () => {
    const { service } = makeService()
    service.acquire({ surface: 'user-view', taskId: 't1', runId: 'r1' })
    service.recordUserSignal({ surface: 'user-view', source: 'keyboard' })
    assert.equal(service.getState('user-view'), 'takeover')
    const second = service.acquire({ surface: 'user-view', taskId: 't2', runId: 'r2' })
    assert.ok(isAgentBrowserError(second))
    if (!isAgentBrowserError(second)) return
    assert.equal(second.errorCode, 'lease_takeover')
    // The surface stays in takeover; acquire did NOT overwrite it.
    assert.equal(service.getState('user-view'), 'takeover')
    // Only an explicit clear lets a new task in again.
    service.clearTakeover('user-view')
    const third = service.acquire({ surface: 'user-view', taskId: 't3', runId: 'r3' })
    assert.ok(!isAgentBrowserError(third))
  })

  it('release() during takeover does NOT reset the surface to idle (no clearTakeover bypass)', () => {
    const { service } = makeService()
    const lease = service.acquire({ surface: 'user-view', taskId: 't1', runId: 'r1' })
    if (isAgentBrowserError(lease)) throw new Error('expected lease')
    service.recordUserSignal({ surface: 'user-view', source: 'keyboard' })
    assert.equal(service.getState('user-view'), 'takeover')
    // The owning task ends and releases its (already-revoked) lease.
    service.release(lease.leaseId)
    // Surface must stay in takeover — a new task cannot seize it.
    assert.equal(service.getState('user-view'), 'takeover')
    const seize = service.acquire({ surface: 'user-view', taskId: 't2', runId: 'r2' })
    assert.ok(isAgentBrowserError(seize))
    if (!isAgentBrowserError(seize)) return
    assert.equal(seize.errorCode, 'lease_takeover')
    // Only an explicit clear restores availability.
    service.clearTakeover('user-view')
    assert.equal(service.getState('user-view'), 'idle')
    assert.ok(!isAgentBrowserError(service.acquire({ surface: 'user-view', taskId: 't3', runId: 'r3' })))
  })

  it('normal release (no takeover) resets the surface to idle', () => {
    const { service } = makeService()
    const lease = service.acquire({ surface: 'user-view', taskId: 't1', runId: 'r1' })
    if (isAgentBrowserError(lease)) throw new Error('expected lease')
    service.release(lease.leaseId)
    assert.equal(service.getState('user-view'), 'idle')
  })

  it('keeps user-view and agent-view leases independent', () => {
    const { service } = makeService()
    const a = service.acquire({ surface: 'user-view', taskId: 't1', runId: 'r1' })
    const b = service.acquire({ surface: 'agent-view', taskId: 't2', runId: 'r2' })
    assert.ok(!isAgentBrowserError(a))
    assert.ok(!isAgentBrowserError(b))
    service.recordUserSignal({ surface: 'user-view', source: 'keyboard' })
    assert.equal(service.getState('user-view'), 'takeover')
    assert.equal(service.getState('agent-view'), 'held')
  })
})
