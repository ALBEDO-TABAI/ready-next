import assert from 'node:assert/strict'
import test from 'node:test'

import { ReadyAgentOrchestrator } from '../main/modules/agent-control/runtime-core/orchestrator'
import {
  _resetEphemeralExecutionStoreForTests,
  getEphemeralExecutionStore,
} from '../main/modules/tools/skill-primitives/ephemeral-execution-store'
import {
  _resetAskUserQuestionsStoreForTests,
  getAskUserQuestionsStore,
} from '../main/modules/tools/builtins/ask-user-questions-store'

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

function registerPendingSkillAsk(params: {
  agent: string
  sessionId: string
  requestId: string
  executionId?: string
}): NodeJS.Timeout {
  const timeoutHandle = setTimeout(() => {}, 60_000)
  getEphemeralExecutionStore().register({
    executionId: params.executionId || `eau-${params.requestId}`,
    sessionId: params.sessionId,
    scopeId: params.sessionId,
    agent: params.agent,
    requestId: params.requestId,
    skillId: 'test-skill',
    question: 'Need input?',
    options: null,
    placeholder: null,
    askedAt: Date.now(),
    resolve: () => undefined,
    reject: () => undefined,
    timeoutHandle,
  })
  return timeoutHandle
}

function registerPendingQuestionCard(params: {
  agent: string
  sessionId: string
  requestId: string
  cardId?: string
}): NodeJS.Timeout {
  const timeoutHandle = setTimeout(() => {}, 60_000)
  getAskUserQuestionsStore().register({
    cardId: params.cardId || `auq-${params.requestId}`,
    sessionId: params.sessionId,
    conversationId: params.sessionId,
    scopeId: params.sessionId,
    agent: params.agent,
    requestId: params.requestId,
    questions: [
      { id: 'q1', question: 'Need input?', kind: 'free_text', options: null, placeholder: null, required: true },
    ],
    askedAt: Date.now(),
    resolve: () => undefined,
    reject: () => undefined,
    timeoutHandle,
  })
  return timeoutHandle
}

test.afterEach(() => {
  _resetEphemeralExecutionStoreForTests()
  _resetAskUserQuestionsStoreForTests()
})

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

test('B3 step3: an explicit per-run timeout shortens the guard', () => {
  const { orchestrator, timers, stops, setNow } = createHarness()
  // Global default is 1000; a proven-quick caller may pass a shorter 200.
  ;(orchestrator as any).registerActiveRun('butler', 'scope-A', 'req-A', 200)

  assert.equal(timers[0]?.delayMs, 200, 'guard scheduled at the explicit per-run timeout, not the global default')

  setNow(200)
  ;(orchestrator as any).handleRunNoProgressTimeout('butler::scope-A', 'req-A')

  assert.deepEqual(stops.map((s) => s.initiator), ['timeout', 'timeout'], 'quick run is stopped at its own short timeout')
})

test('B3 step3: a non-positive / omitted per-run timeout falls back to the long global default', () => {
  const { orchestrator, timers } = createHarness()
  ;(orchestrator as any).registerActiveRun('butler', 'scope-A', 'req-A', 0)
  assert.equal(timers[0]?.delayMs, 1000, '0 is not a valid shortening → global default')
})

test('B3 step3: a per-run timeout can only SHORTEN — a longer value is clamped to the global default', () => {
  const { orchestrator, timers } = createHarness()
  // A value LONGER than the 1000 global must NOT extend the guard.
  ;(orchestrator as any).registerActiveRun('butler', 'scope-A', 'req-A', 5000)
  assert.equal(timers[0]?.delayMs, 1000, 'longer per-run value clamped to global default (only-shorten)')

  // Non-finite is rejected → global default.
  ;(orchestrator as any).registerActiveRun('butler', 'scope-B', 'req-B', Number.POSITIVE_INFINITY)
  assert.equal(timers.at(-1)?.delayMs, 1000, 'non-finite value rejected → global default')
})

test('B3 step3: a quick run does NOT shorten a coexisting long run (no false-kill of long tasks)', () => {
  const { orchestrator, timers, stops, setNow } = createHarness()
  // scope-A is a proven-quick run (200ms); scope-B keeps the long default (1000).
  ;(orchestrator as any).registerActiveRun('butler', 'scope-A', 'req-A', 200)
  ;(orchestrator as any).registerActiveRun('butler', 'scope-B', 'req-B')

  assert.equal(timers[0]?.delayMs, 200)
  assert.equal(timers[1]?.delayMs, 1000, 'the long run keeps its own long timeout')

  // At t=200 the quick run fires; the long run must NOT be killed.
  setNow(200)
  ;(orchestrator as any).handleRunNoProgressTimeout('butler::scope-A', 'req-A')
  ;(orchestrator as any).handleRunNoProgressTimeout('butler::scope-B', 'req-B')

  assert.deepEqual(stops.map((s) => s.key), ['butler::scope-A', 'butler::scope-A'],
    'only the quick run stopped; the long run survives its short-lived neighbor')
  assert.equal((orchestrator as any).activeRunIds.get('butler::scope-B'), 'req-B', 'long run still active')
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

test('main no-progress guard treats pending skill ask_user as progress without busy-looping', () => {
  const { orchestrator, timers, stops, setNow } = createHarness()
  ;(orchestrator as any).registerActiveRun('butler', 'scope-A', 'req-A')
  const timeoutHandle = registerPendingSkillAsk({ agent: 'butler', sessionId: 'scope-A', requestId: 'req-A' })

  setNow(1000)
  ;(orchestrator as any).handleRunNoProgressTimeout('butler::scope-A', 'req-A')

  assert.equal(stops.length, 0, 'pending user input is not a stall')
  assert.equal((orchestrator as any).activeRunIds.get('butler::scope-A'), 'req-A')
  assert.equal(timers.at(-1)?.delayMs, 1000, 'waiting is counted as progress, so the next check is not a 0ms spin')
  assert.equal(timers.at(-1)?.delayMs > 0, true)
  clearTimeout(timeoutHandle)
})

test('main no-progress guard does not let stale pending ask_user shield a newer run', () => {
  const { orchestrator, stops, setNow } = createHarness()
  ;(orchestrator as any).registerActiveRun('butler', 'scope-A', 'req-new')
  const timeoutHandle = registerPendingSkillAsk({
    agent: 'butler',
    sessionId: 'scope-A',
    requestId: 'req-old',
    executionId: 'eau-old',
  })

  setNow(1000)
  ;(orchestrator as any).handleRunNoProgressTimeout('butler::scope-A', 'req-new')

  assert.deepEqual(stops.map((item) => item.initiator), ['timeout', 'timeout'])
  assert.equal((orchestrator as any).activeRunIds.get('butler::scope-A'), undefined)
  clearTimeout(timeoutHandle)
})

test('main no-progress guard also recognizes ask_user_questions pending cards', () => {
  const { orchestrator, timers, stops, setNow } = createHarness()
  ;(orchestrator as any).registerActiveRun('butler', 'scope-A', 'req-A')
  const timeoutHandle = registerPendingQuestionCard({ agent: 'butler', sessionId: 'scope-A', requestId: 'req-A' })

  setNow(1000)
  ;(orchestrator as any).handleRunNoProgressTimeout('butler::scope-A', 'req-A')

  assert.equal(stops.length, 0)
  assert.equal((orchestrator as any).activeRunIds.get('butler::scope-A'), 'req-A')
  assert.equal(timers.at(-1)?.delayMs, 1000)
  clearTimeout(timeoutHandle)
})

test('main no-progress guard does not extend explicit short-timeout runs for ask_user', () => {
  const { orchestrator, stops, setNow } = createHarness()
  ;(orchestrator as any).registerActiveRun('butler', 'scope-A', 'req-A', 200)
  const timeoutHandle = registerPendingSkillAsk({ agent: 'butler', sessionId: 'scope-A', requestId: 'req-A' })

  setNow(200)
  ;(orchestrator as any).handleRunNoProgressTimeout('butler::scope-A', 'req-A')

  assert.deepEqual(stops.map((item) => item.initiator), ['timeout', 'timeout'])
  clearTimeout(timeoutHandle)
})
