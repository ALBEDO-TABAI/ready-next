import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { runUnderBrowserViewLease, runUnderUserViewLease } from '../main/modules/browser-engine/agent-browser-lane'
import { BrowserWriteLeaseService } from '../main/modules/browser-engine/browser-write-lease'

describe('lane-A runUnderUserViewLease', () => {
  it('grants the lease, runs fn with a working gate, then releases (idle after)', async () => {
    const service = new BrowserWriteLeaseService()
    const outcome = await runUnderUserViewLease(
      service,
      { taskId: 't1', runId: 'r1', tabId: 'tab-1' },
      async (gate) => {
        // Inside the run the write is permitted.
        assert.equal(service.getState('user-view'), 'held')
        assert.equal(service.checkWrite({ surface: 'user-view', leaseId: gate.leaseId }), null)
        return 'done'
      },
    )
    assert.deepEqual(outcome, { ok: true, value: 'done' })
    // Released after the run.
    assert.equal(service.getState('user-view'), 'idle')
  })

  it('releases the lease even when fn throws', async () => {
    const service = new BrowserWriteLeaseService()
    await assert.rejects(
      runUnderUserViewLease(service, { taskId: 't1', runId: 'r1' }, async () => {
        throw new Error('boom')
      }),
      /boom/,
    )
    assert.equal(service.getState('user-view'), 'idle')
  })

  it('does not seize the surface when it is already held (returns blocked)', async () => {
    const service = new BrowserWriteLeaseService()
    service.acquire({ surface: 'user-view', taskId: 'other', runId: 'r0' })
    let ran = false
    const outcome = await runUnderUserViewLease(service, { taskId: 't1', runId: 'r1' }, async () => {
      ran = true
      return 'x'
    })
    assert.equal(ran, false, 'fn must not run when the surface is busy')
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.blocked.errorCode, 'lease_held')
  })

  it('does not seize the surface when the user has taken over (returns blocked)', async () => {
    const service = new BrowserWriteLeaseService()
    // Simulate a prior run that the user took over.
    const prior = service.acquire({ surface: 'user-view', taskId: 'prev', runId: 'r0' })
    assert.ok(!('errorCode' in prior))
    service.recordUserSignal({ surface: 'user-view', source: 'keyboard' })
    assert.equal(service.getState('user-view'), 'takeover')

    const outcome = await runUnderUserViewLease(service, { taskId: 't1', runId: 'r1' }, async () => 'x')
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.blocked.errorCode, 'lease_takeover')
  })

  it('a takeover during the run survives the finally release (surface stays taken over)', async () => {
    const service = new BrowserWriteLeaseService()
    const outcome = await runUnderUserViewLease(service, { taskId: 't1', runId: 'r1' }, async () => {
      // User grabs the page mid-run.
      service.recordUserSignal({ surface: 'user-view', source: 'keyboard' })
      return 'partial'
    })
    assert.deepEqual(outcome, { ok: true, value: 'partial' })
    // The finally-release must NOT have reset the surface to idle.
    assert.equal(service.getState('user-view'), 'takeover')
    // A follow-up run is blocked until the takeover is cleared.
    const next = await runUnderUserViewLease(service, { taskId: 't2', runId: 'r2' }, async () => 'x')
    assert.equal(next.ok, false)
    if (next.ok) return
    assert.equal(next.blocked.errorCode, 'lease_takeover')
  })

  it('heartbeat keeps a long run alive past the original TTL', async () => {
    let clock = 0
    const service = new BrowserWriteLeaseService({ now: () => clock, defaultTtlMs: 1_000 })
    const outcome = await runUnderUserViewLease(
      service,
      { taskId: 't1', runId: 'r1', ttlMs: 1_000 },
      async (gate, heartbeat) => {
        clock += 800
        heartbeat()
        clock += 800 // 1600 total, but heartbeat reset at 800
        assert.equal(service.checkWrite({ surface: 'user-view', leaseId: gate.leaseId }), null)
        return 'ok'
      },
    )
    assert.equal(outcome.ok, true)
  })

  it('can run the same lifecycle on the agent-view surface', async () => {
    const service = new BrowserWriteLeaseService()
    const outcome = await runUnderBrowserViewLease(
      service,
      { surface: 'agent-view', taskId: 'foreground-browser', runId: 'run-1', tabId: 'agent-tab-1' },
      async (gate) => {
        assert.equal(gate.surface, 'agent-view')
        assert.equal(service.getState('agent-view'), 'held')
        assert.equal(service.checkWrite({ surface: 'agent-view', leaseId: gate.leaseId }), null)
        assert.equal(service.getState('user-view'), 'idle')
        return 'agent-done'
      },
    )
    assert.deepEqual(outcome, { ok: true, value: 'agent-done' })
    assert.equal(service.getState('agent-view'), 'idle')
  })
})
