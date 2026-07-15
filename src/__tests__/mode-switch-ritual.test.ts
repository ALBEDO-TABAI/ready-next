/**
 * Stage X4 PR-shell-2 — mode-switch hide-all ack waiter contract.
 *
 * Covers the four failure-protection cases called out in plan §9 lines
 * 680–684:
 *
 *   1. happy-path  — matching ack arrives within 100 ms → state flips
 *   2. timeout     — no ack within 100 ms → state flips anyway + log
 *   3. stale ack   — old intentId arrives → ignored; current waiter
 *                    keeps pending until its own ack or the timeout
 *   4. cancellation — user clicks a different mode mid-wait → A's
 *                    waiter is orphaned, late ack is dropped
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createModeSwitchAckWaiter,
  MODE_SWITCH_ACK_TIMEOUT_MS,
  type AckSource,
  type AckWaiterDeps,
} from '../renderer/modules/browser/modeSwitchAckWaiter'
import {
  __testing__ as ritualTesting,
  cancelRitual,
  useRitualOverlayStore,
  withRitual,
} from '../renderer/modules/overlay/useRitualOverlay'
import type { BrowserViewIntentAck } from '../shared/browser-view-intent'

interface FakeTimerSlot {
  id: number
  cb: () => void
  delay: number
  cleared: boolean
}

function makeFakeTimerDeps(): {
  deps: AckWaiterDeps
  logs: Array<{ event: string; detail: { intentId: number; staleIntentId?: number } }>
  fire: (id?: number) => void
  pending: () => FakeTimerSlot[]
} {
  const slots: FakeTimerSlot[] = []
  let next = 1
  const logs: Array<{ event: string; detail: { intentId: number; staleIntentId?: number } }> = []
  const deps: AckWaiterDeps = {
    setTimeout: (cb, ms) => {
      const slot: FakeTimerSlot = { id: next++, cb, delay: ms, cleared: false }
      slots.push(slot)
      return slot.id
    },
    clearTimeout: (handle) => {
      const slot = slots.find((s) => s.id === handle)
      if (slot) slot.cleared = true
    },
    log: (event, detail) => {
      logs.push({ event, detail })
    },
  }
  const fire = (id?: number) => {
    const slot = id === undefined ? slots.find((s) => !s.cleared) : slots.find((s) => s.id === id)
    if (slot && !slot.cleared) {
      slot.cleared = true
      slot.cb()
    }
  }
  const pending = () => slots.filter((s) => !s.cleared)
  return { deps, logs, fire, pending }
}

function makeAckSource(): {
  source: AckSource
  emit: (ack: BrowserViewIntentAck) => void
  listenerCount: () => number
} {
  const listeners = new Set<(ack: BrowserViewIntentAck) => void>()
  const source: AckSource = (cb) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  }
  return {
    source,
    emit: (ack) => {
      for (const l of Array.from(listeners)) l(ack)
    },
    listenerCount: () => listeners.size,
  }
}

test('happy path: matching ack within timeout resolves with outcome=ack and clears the timer', async () => {
  const { deps, logs, pending } = makeFakeTimerDeps()
  const { source, emit, listenerCount } = makeAckSource()
  const waiter = createModeSwitchAckWaiter(source, 42, deps)
  assert.equal(listenerCount(), 1, 'subscribes to ack source')
  emit({ intentId: 42 })
  const outcome = await waiter.wait
  assert.deepEqual(outcome, { outcome: 'ack', intentId: 42 })
  assert.equal(pending().length, 0, 'timer is cleared after ack')
  assert.equal(listenerCount(), 0, 'unsubscribes after ack')
  assert.equal(logs.length, 0, 'no warnings on happy path')
})

test('timeout path: no ack within 100 ms resolves with outcome=timeout and logs mode-switch-ack-timeout', async () => {
  const { deps, logs, fire } = makeFakeTimerDeps()
  const { source, listenerCount } = makeAckSource()
  const waiter = createModeSwitchAckWaiter(source, 7, deps)
  fire()
  const outcome = await waiter.wait
  assert.deepEqual(outcome, { outcome: 'timeout', intentId: 7 })
  assert.equal(logs.length, 1)
  assert.equal(logs[0].event, 'mode-switch-ack-timeout')
  assert.deepEqual(logs[0].detail, { intentId: 7 })
  assert.equal(listenerCount(), 0, 'unsubscribes after timeout')
})

test('stale ack: ack for a previous intentId is logged and ignored; waiter still pending', async () => {
  const { deps, logs } = makeFakeTimerDeps()
  const { source, emit } = makeAckSource()
  const waiter = createModeSwitchAckWaiter(source, 9, deps)
  let settled = false
  void waiter.wait.then(() => { settled = true })

  emit({ intentId: 5 }) // stale
  // give the microtask queue a tick
  await Promise.resolve()
  assert.equal(settled, false, 'waiter still pending after stale ack')
  assert.equal(logs.length, 1)
  assert.equal(logs[0].event, 'mode-switch-ack-stale')
  assert.deepEqual(logs[0].detail, { intentId: 9, staleIntentId: 5 })

  emit({ intentId: 9 })
  const outcome = await waiter.wait
  assert.deepEqual(outcome, { outcome: 'ack', intentId: 9 })
})

test('cancellation: cancel() orphans the waiter; late ack is dropped per stale-id rule', async () => {
  const { deps: depsA, logs: logsA } = makeFakeTimerDeps()
  const { source: sourceA, emit: emitA } = makeAckSource()
  const waiterA = createModeSwitchAckWaiter(sourceA, 100, depsA)

  // user clicks mode B while A is still in-flight — caller cancels A
  waiterA.cancel()
  const outcomeA = await waiterA.wait
  assert.deepEqual(outcomeA, { outcome: 'cancelled', intentId: 100 })
  assert.equal(logsA[0].event, 'mode-switch-ack-cancelled')
  assert.deepEqual(logsA[0].detail, { intentId: 100 })

  // late A ack arrives — must be ignored (waiterA is settled, unsubscribed)
  emitA({ intentId: 100 })
  // no listeners; nothing to assert beyond no throw
})

test('cancellation: caller spawns a fresh waiter with new intentId; old waiter does not interfere', async () => {
  const { deps, logs } = makeFakeTimerDeps()
  const { source, emit, listenerCount } = makeAckSource()
  const waiterA = createModeSwitchAckWaiter(source, 100, deps)
  waiterA.cancel()
  await waiterA.wait

  // fresh waiter for the second click
  const waiterB = createModeSwitchAckWaiter(source, 101, deps)
  assert.equal(listenerCount(), 1, 'only the live waiter is subscribed')

  emit({ intentId: 101 })
  const outcomeB = await waiterB.wait
  assert.deepEqual(outcomeB, { outcome: 'ack', intentId: 101 })

  // logs: 1 cancel (A) + no stale because emit(101) hit waiterB directly
  const events = logs.map((l) => l.event)
  assert.deepEqual(events, ['mode-switch-ack-cancelled'])
})

test('timeout constant is 100 ms per plan §9 line 682', () => {
  assert.equal(MODE_SWITCH_ACK_TIMEOUT_MS, 100)
})

test('idempotent settle: late ack arriving after cancellation does not change outcome', async () => {
  const { deps } = makeFakeTimerDeps()
  const { source, emit } = makeAckSource()
  const waiter = createModeSwitchAckWaiter(source, 5, deps)
  waiter.cancel()
  emit({ intentId: 5 })
  const outcome = await waiter.wait
  assert.deepEqual(outcome, { outcome: 'cancelled', intentId: 5 })
})

test('idempotent settle: ack arriving after timeout does not change outcome', async () => {
  const { deps, fire } = makeFakeTimerDeps()
  const { source, emit } = makeAckSource()
  const waiter = createModeSwitchAckWaiter(source, 11, deps)
  fire()
  const outcome = await waiter.wait
  assert.deepEqual(outcome, { outcome: 'timeout', intentId: 11 })
  emit({ intentId: 11 })
  // no second outcome possible — promise already resolved
})

test('a newer mode request can abort the active mode-switch ritual before it commits', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      matchMedia: () => ({ matches: false }),
    },
  })
  ritualTesting.resetRitualOverlay()
  let committed = false

  try {
    const pending = withRitual('mode-switch', () => {
      committed = true
    })
    assert.equal(useRitualOverlayStore.getState().session?.stage, 'mode-switch')

    cancelRitual('theme-transition')
    assert.equal(useRitualOverlayStore.getState().session?.stage, 'mode-switch', 'a different stage must not be cancelled')

    cancelRitual('mode-switch')
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
    )
    assert.equal(committed, false)
    assert.equal(useRitualOverlayStore.getState().session, null)
  } finally {
    ritualTesting.resetRitualOverlay()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else delete (globalThis as typeof globalThis & { window?: Window }).window
  }
})
