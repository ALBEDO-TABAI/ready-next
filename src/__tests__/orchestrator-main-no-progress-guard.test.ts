import assert from 'node:assert/strict'
import test from 'node:test'

import { ReadyAgentOrchestrator } from '../main/modules/agent-control/runtime-core/orchestrator'

interface FakeTimer {
  callback: () => void
  delayMs: number
  cleared: boolean
}

function createHarness() {
  let now = 0
  const timers: FakeTimer[] = []
  const orchestrator = new ReadyAgentOrchestrator({
    mainRunNoProgressTimeoutMs: 1000,
    nowMs: () => now,
    scheduleNoProgressCheck: (callback, delayMs) => {
      const timer: FakeTimer = { callback, delayMs, cleared: false }
      timers.push(timer)
      return timer
    },
    clearNoProgressCheck: (handle) => {
      ;(handle as FakeTimer).cleared = true
    },
  })
  const stops: Array<{ engine: string; key: string; initiator: string }> = []
  ;(orchestrator as any).domainAdapterEngine.stopGeneration = (key: string, initiator: string) => {
    stops.push({ engine: 'domain', key, initiator })
  }
  ;(orchestrator as any).sdkEngine.stopGeneration = (key: string, initiator: string) => {
    stops.push({ engine: 'sdk', key, initiator })
  }
  return {
    orchestrator,
    timers,
    stops,
    setNow(value: number) {
      now = value
    },
  }
}

test('main no-progress guard stops the active run with timeout initiator', () => {
  const { orchestrator, timers, stops, setNow } = createHarness()
  ;(orchestrator as any).registerActiveRun('butler', 'scope-A', 'req-A')

  assert.equal(timers[0]?.delayMs, 1000)

  setNow(1000)
  ;(orchestrator as any).handleRunNoProgressTimeout('butler::scope-A', 'req-A')

  assert.deepEqual(stops, [
    { engine: 'domain', key: 'butler::scope-A', initiator: 'timeout' },
    { engine: 'sdk', key: 'butler::scope-A', initiator: 'timeout' },
  ])
  assert.equal((orchestrator as any).activeRunIds.get('butler::scope-A'), undefined)
  assert.equal(timers[0]?.cleared, true)

  const session = orchestrator.listAllSessions().find((item) => item.sessionId === 'scope-A')
  assert.equal(session?.state, 'cancelled')
  assert.equal(session?.error, 'main_no_progress_timeout')
})

test('main no-progress guard refreshes on run progress before stopping', () => {
  const { orchestrator, timers, stops, setNow } = createHarness()
  ;(orchestrator as any).registerActiveRun('butler', 'scope-A', 'req-A')

  setNow(700)
  assert.equal((orchestrator as any).refreshActiveRunProgress('butler', 'scope-A', 'req-A'), true)
  assert.equal(timers[0]?.cleared, true)
  assert.equal(timers.at(-1)?.delayMs, 1000)

  setNow(1200)
  ;(orchestrator as any).handleRunNoProgressTimeout('butler::scope-A', 'req-A')

  assert.equal(stops.length, 0)
  assert.equal((orchestrator as any).activeRunIds.get('butler::scope-A'), 'req-A')
  assert.equal(timers.at(-1)?.delayMs, 500)
})

test('main no-progress guard ignores stale timer ticks after a newer run owns the scope', () => {
  const { orchestrator, timers, stops, setNow } = createHarness()
  ;(orchestrator as any).registerActiveRun('butler', 'scope-A', 'req-old')
  const oldTimer = timers[0]
  ;(orchestrator as any).registerActiveRun('butler', 'scope-A', 'req-new')

  assert.equal(oldTimer.cleared, true)

  setNow(1000)
  ;(orchestrator as any).handleRunNoProgressTimeout('butler::scope-A', 'req-old')

  assert.equal(stops.length, 0)
  assert.equal((orchestrator as any).activeRunIds.get('butler::scope-A'), 'req-new')
})
