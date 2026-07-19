import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BrowserTurnLease } from '../main/modules/browser-engine/agent-browser-turn-lease'
import { BrowserWriteLeaseService } from '../main/modules/browser-engine/browser-write-lease'
import { isAgentBrowserError } from '../main/modules/browser-engine/agent-browser-errors'

function make() {
  const service = new BrowserWriteLeaseService()
  const turn = new BrowserTurnLease({ taskId: 't1', runId: 'r1' }, 'user-view', service)
  return { service, turn }
}

describe('BrowserTurnLease (free-loop turn lease, WP2)', () => {
  it('lazily acquires on first ensureGate and reuses the same lease', () => {
    const { service, turn } = make()
    assert.equal(service.getState('user-view'), 'idle', 'no lease until first write')
    const g1 = turn.ensureGate()
    assert.ok(!isAgentBrowserError(g1))
    if (isAgentBrowserError(g1)) return
    assert.equal(service.getState('user-view'), 'held')
    const g2 = turn.ensureGate()
    assert.ok(!isAgentBrowserError(g2))
    if (isAgentBrowserError(g2)) return
    assert.equal(g1.leaseId, g2.leaseId, 'same turn lease reused')
  })

  it('can bind the same turn owner to a grounded agent-view tab without taking user-view', () => {
    const { service, turn } = make()
    const gate = turn.ensureGateForSurface('agent-view', 'agent-tab-1')
    assert.ok(!isAgentBrowserError(gate))
    if (isAgentBrowserError(gate)) return
    assert.equal(gate.surface, 'agent-view')
    assert.equal(service.getLease('agent-view')?.tabId, 'agent-tab-1')
    assert.equal(service.getState('user-view'), 'idle')
  })

  it('heartbeats the active lease on each ensureGate so long turns do not expire mid-run', () => {
    let now = 1_000
    const service = new BrowserWriteLeaseService({
      now: () => now,
      defaultTtlMs: 1_000,
    })
    const turn = new BrowserTurnLease({ taskId: 't1', runId: 'r1' }, 'user-view', service)
    const g1 = turn.ensureGate()
    assert.ok(!isAgentBrowserError(g1))
    if (isAgentBrowserError(g1)) return

    now = 1_900
    const g2 = turn.ensureGate()
    assert.ok(!isAgentBrowserError(g2))
    if (isAgentBrowserError(g2)) return
    assert.equal(g1.leaseId, g2.leaseId, 'same active lease is renewed')

    now = 2_800
    const g3 = turn.ensureGate()
    assert.ok(!isAgentBrowserError(g3), 'renewed lease must still be usable after the original expiry')
    if (isAgentBrowserError(g3)) return
    assert.equal(g1.leaseId, g3.leaseId)
  })

  it('atomically replaces its own expired lease once instead of deadlocking the turn', () => {
    let now = 1_000
    const service = new BrowserWriteLeaseService({
      now: () => now,
      defaultTtlMs: 1_000,
      generateId: (() => {
        let sequence = 0
        return (prefix: string) => `${prefix}-${++sequence}`
      })(),
    })
    const turn = new BrowserTurnLease({ taskId: 't1', runId: 'r1' }, 'user-view', service)
    const first = turn.ensureGate()
    assert.ok(!isAgentBrowserError(first))
    if (isAgentBrowserError(first)) return

    now = 2_001
    const replacement = turn.ensureGate()
    assert.ok(!isAgentBrowserError(replacement), 'the same turn should recover its own expired lease')
    if (isAgentBrowserError(replacement)) return
    assert.notEqual(replacement.leaseId, first.leaseId)
    assert.equal(service.getState('user-view'), 'held')
  })

  it('returns lease_held when another task already owns the surface', () => {
    const { service, turn } = make()
    service.acquire({ surface: 'user-view', taskId: 'other', runId: 'r0' })
    const g = turn.ensureGate()
    assert.ok(isAgentBrowserError(g))
    if (!isAgentBrowserError(g)) return
    assert.equal(g.errorCode, 'lease_held')
  })

  it('does not treat a fresh turn as authority to clear a prior takeover', () => {
    const { service, turn } = make()
    // Simulate a previous turn that the user took over.
    const prior = service.acquire({ surface: 'user-view', taskId: 'prev', runId: 'r0' })
    if (isAgentBrowserError(prior)) throw new Error('expected lease')
    service.recordUserSignal({ surface: 'user-view', source: 'keyboard' })
    assert.equal(service.getState('user-view'), 'takeover')
    // Only a typed control-plane wake may clear durable takeover state.
    const g = turn.ensureGate()
    assert.ok(isAgentBrowserError(g))
    if (!isAgentBrowserError(g)) return
    assert.equal(g.errorCode, 'lease_takeover')
    assert.equal(service.getState('user-view'), 'takeover')
  })

  it('does NOT steal a surface actively held by a background task (lease_held, not cleared)', () => {
    const { service, turn } = make()
    // A background task holds the surface (held, not takeover).
    service.acquire({ surface: 'user-view', taskId: 'bg', runId: 'rbg' })
    const g = turn.ensureGate()
    assert.ok(isAgentBrowserError(g))
    if (!isAgentBrowserError(g)) return
    assert.equal(g.errorCode, 'lease_held')
  })

  it('releaseForBackgroundHandoff frees the surface so a background task can acquire', () => {
    const { service, turn } = make()
    turn.ensureGate()
    assert.equal(turn.isHeld, true)
    turn.releaseForBackgroundHandoff()
    assert.equal(turn.isHeld, false)
    assert.equal(service.getState('user-view'), 'idle', 'surface free for the background task')
    // The background task can now acquire its own lease.
    const bg = service.acquire({ surface: 'user-view', taskId: 'collect', runId: 'rc' })
    assert.ok(!isAgentBrowserError(bg))
    // The turn's subsequent foreground write now gets lease_held (single writer).
    const g = turn.ensureGate()
    assert.ok(isAgentBrowserError(g))
    if (!isAgentBrowserError(g)) return
    assert.equal(g.errorCode, 'lease_held')
  })

  it('after a visible_collect handoff, a mid-turn user takeover is NOT stolen back', () => {
    const { service, turn } = make()
    // Turn acquires (first acquire = re-authorization), then hands off to a bg task.
    turn.ensureGate()
    turn.releaseForBackgroundHandoff()
    // The background task owns the surface and the user takes it over.
    const bg = service.acquire({ surface: 'user-view', taskId: 'collect', runId: 'rc' })
    if (isAgentBrowserError(bg)) throw new Error('expected bg lease')
    service.recordUserSignal({ surface: 'user-view', source: 'keyboard' })
    assert.equal(service.getState('user-view'), 'takeover')
    // A subsequent foreground write in the SAME turn must NOT clear takeover.
    const g = turn.ensureGate()
    assert.ok(isAgentBrowserError(g), 'must not re-acquire a taken-over surface mid-turn')
    if (!isAgentBrowserError(g)) return
    assert.equal(g.errorCode, 'lease_takeover')
    assert.equal(service.getState('user-view'), 'takeover', 'surface stays under user control')
  })

  it('a new turn remains fenced until the control plane explicitly clears takeover', () => {
    const service = new BrowserWriteLeaseService()
    // A previous turn was taken over.
    const prev = service.acquire({ surface: 'user-view', taskId: 'prev', runId: 'r0' })
    if (isAgentBrowserError(prev)) throw new Error('expected lease')
    service.recordUserSignal({ surface: 'user-view', source: 'keyboard' })
    const turn = new BrowserTurnLease({ taskId: 't2', runId: 'r2' }, 'user-view', service)
    const blocked = turn.ensureGate()
    assert.ok(isAgentBrowserError(blocked))
    if (!isAgentBrowserError(blocked)) return
    assert.equal(blocked.errorCode, 'lease_takeover')
    service.clearTakeover('user-view')
    assert.ok(!isAgentBrowserError(turn.ensureGate()))
    assert.equal(service.getState('user-view'), 'held')
  })

  it('keeps every run blocked after takeover until a typed wake clears the fence', () => {
    const service = new BrowserWriteLeaseService()
    const oldTurn = new BrowserTurnLease({ taskId: 'research', runId: 'old-run' }, 'agent-view', service)
    assert.ok(!isAgentBrowserError(oldTurn.ensureGateForSurface('agent-view', 'agent-tab')))
    service.recordUserSignal({ surface: 'agent-view', source: 'keyboard' })

    const oldRetry = oldTurn.ensureGateForSurface('agent-view', 'agent-tab')
    assert.ok(isAgentBrowserError(oldRetry))
    if (!isAgentBrowserError(oldRetry)) return
    assert.equal(oldRetry.errorCode, 'lease_takeover')

    const freshTurn = new BrowserTurnLease({ taskId: 'research', runId: 'fresh-run' }, 'agent-view', service)
    const stillBlocked = freshTurn.ensureGateForSurface('agent-view', 'agent-tab')
    assert.ok(isAgentBrowserError(stillBlocked))
    if (!isAgentBrowserError(stillBlocked)) return
    assert.equal(stillBlocked.errorCode, 'lease_takeover')
    service.clearTakeover('agent-view')
    const resumed = freshTurn.ensureGateForSurface('agent-view', 'agent-tab')
    assert.ok(!isAgentBrowserError(resumed))
    assert.equal(service.getState('agent-view'), 'held')
  })

  it('release() (run cleanup) frees the surface and seals the turn lease', () => {
    const { service, turn } = make()
    turn.ensureGate()
    turn.release()
    assert.equal(service.getState('user-view'), 'idle')
    const g = turn.ensureGate()
    assert.ok(isAgentBrowserError(g), 'ended turn lease must not re-acquire')
    if (!isAgentBrowserError(g)) return
    assert.equal(g.errorCode, 'lease_required')
  })

  it('release() is a no-op when nothing was ever acquired', () => {
    const { service, turn } = make()
    turn.release()
    assert.equal(service.getState('user-view'), 'idle')
  })
})
