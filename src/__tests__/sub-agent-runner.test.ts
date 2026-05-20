import assert from 'node:assert/strict'
import test from 'node:test'

import { __setMetricSinkForTests } from '../main/modules/agent-control/metrics'
import { TOOL_ERROR_METRICS } from '../main/modules/agent-control/tools-runtime/tool-error-metrics'
import { runSubAgent } from '../main/modules/agent-control/sub-agent/sub-agent-runner'
import type {
  SubAgent,
  SubAgentCleanupHandle,
  SubAgentCloseEvent,
  SubAgentContext,
  SubAgentEvent,
  SubAgentRunResult,
  SubAgentWorkEvent,
} from '../main/modules/agent-control/sub-agent/sub-agent-types'

async function collectRun(
  generator: AsyncGenerator<SubAgentEvent, SubAgentCloseEvent, void>,
): Promise<{ events: SubAgentEvent[]; closeEvent: SubAgentCloseEvent }> {
  const events: SubAgentEvent[] = []
  while (true) {
    const next = await generator.next()
    if (next.done) return { events, closeEvent: next.value }
    events.push(next.value)
  }
}

function makeCleanup(options: { throwOnDrain?: boolean } = {}): SubAgentCleanupHandle & { drained: number } {
  return {
    drained: 0,
    register() {},
    async drain() {
      this.drained += 1
      if (options.throwOnDrain) throw new Error('cleanup failed')
    },
  }
}

function makeSubAgent(
  run: SubAgent['run'],
  overrides: Partial<SubAgent> = {},
): SubAgent {
  return {
    lifecycleId: overrides.lifecycleId ?? `subagent-${Math.random()}`,
    durableRunId: overrides.durableRunId,
    subagentName: overrides.subagentName ?? 'TestSubAgent',
    artifactDir: overrides.artifactDir ?? null,
    run,
  }
}

function makeContext(
  cleanup: SubAgentCleanupHandle,
  abortSignal = new AbortController().signal,
): SubAgentContext {
  return {
    abortSignal,
    cleanup,
  }
}

test('runner preserves paused reason from a work event', async () => {
  const cleanup = makeCleanup()
  const subagent = makeSubAgent(async function* (): AsyncGenerator<SubAgentWorkEvent, SubAgentRunResult, void> {
    yield {
      type: 'paused',
      pauseReason: 'budget',
      reason: 'waiting for budget refresh',
    }
    return {
      state: 'blocked',
      terminalReason: 'checkpoint_budget',
    }
  })

  const { events, closeEvent } = await collectRun(runSubAgent(subagent, makeContext(cleanup)))
  const paused = events.find((event): event is Extract<SubAgentEvent, { type: 'paused' }> => event.type === 'paused')

  assert.equal(paused?.pauseReason, 'budget')
  assert.equal(closeEvent.state, 'blocked')
  assert.equal(closeEvent.terminalReason, 'checkpoint_budget')
  assert.equal(cleanup.drained, 1)
})

test('runner converts subagent throw into failed terminal and drains cleanup once', async () => {
  const cleanup = makeCleanup()
  const subagent = makeSubAgent(async function* (): AsyncGenerator<SubAgentWorkEvent, SubAgentRunResult, void> {
    yield { type: 'progress', message: 'before throw' }
    throw new Error('boom')
  })

  const { events, closeEvent } = await collectRun(runSubAgent(subagent, makeContext(cleanup)))

  assert.equal(events.at(-1)?.type, 'terminal')
  assert.equal(closeEvent.state, 'failed')
  assert.equal(closeEvent.terminalReason, 'failed_subagent')
  assert.equal(closeEvent.error?.message, 'boom')
  assert.equal(cleanup.drained, 1)
})

test('runner turns abort-before-start into a single cancelled terminal', async () => {
  const cleanup = makeCleanup()
  const controller = new AbortController()
  controller.abort()
  const subagent = makeSubAgent(async function* (): AsyncGenerator<SubAgentWorkEvent, SubAgentRunResult, void> {
    yield { type: 'progress', message: 'must not run' }
    return { state: 'completed', terminalReason: 'completed' }
  })

  const { events, closeEvent } = await collectRun(runSubAgent(subagent, makeContext(cleanup, controller.signal)))

  assert.deepEqual(events.map((event) => event.type), ['started', 'terminal'])
  assert.equal(closeEvent.state, 'cancelled')
  assert.equal(closeEvent.terminalReason, 'aborted')
  assert.equal(cleanup.drained, 1)
})

test('runner can abort while a subagent is stuck awaiting its next event', async () => {
  const cleanup = makeCleanup()
  const controller = new AbortController()
  const subagent = makeSubAgent(async function* (): AsyncGenerator<SubAgentWorkEvent, SubAgentRunResult, void> {
    await new Promise<never>(() => {})
    yield { type: 'progress', message: 'unreachable' }
  })

  const run = collectRun(runSubAgent(subagent, makeContext(cleanup, controller.signal)))
  setTimeout(() => controller.abort(), 10)
  const { events, closeEvent } = await run

  assert.deepEqual(events.map((event) => event.type), ['started', 'terminal'])
  assert.equal(closeEvent.state, 'cancelled')
  assert.equal(closeEvent.terminalReason, 'aborted')
  assert.equal(cleanup.drained, 1)
})

test('runner ignores duplicate aborts after emitting one terminal event', async () => {
  const cleanup = makeCleanup()
  const controller = new AbortController()
  const subagent = makeSubAgent(async function* (): AsyncGenerator<SubAgentWorkEvent, SubAgentRunResult, void> {
    await new Promise<never>(() => {})
    yield { type: 'progress', message: 'unreachable' }
  })

  const run = collectRun(runSubAgent(subagent, makeContext(cleanup, controller.signal)))
  setTimeout(() => {
    controller.abort()
    controller.abort()
  }, 10)
  const { events, closeEvent } = await run

  assert.equal(events.filter((event) => event.type === 'terminal').length, 1)
  assert.equal(closeEvent.state, 'cancelled')
  assert.equal(cleanup.drained, 1)
})

test('runner emits registered metric when cleanup drain fails without changing terminal result', async () => {
  const metrics: Array<{ metric: string }> = []
  __setMetricSinkForTests((event) => metrics.push({ metric: event.metric }))
  try {
    const cleanup = makeCleanup({ throwOnDrain: true })
    const subagent = makeSubAgent(async function* (): AsyncGenerator<SubAgentWorkEvent, SubAgentRunResult, void> {
      yield { type: 'progress', message: 'before cleanup' }
      return { state: 'completed', terminalReason: 'completed' }
    })

    const { closeEvent } = await collectRun(runSubAgent(subagent, makeContext(cleanup)))

    assert.equal(closeEvent.state, 'completed')
    assert.equal(closeEvent.terminalReason, 'completed')
    assert.ok(metrics.some((event) => event.metric === TOOL_ERROR_METRICS.subagentCleanupDrainFailed))
    assert.equal(cleanup.drained, 1)
  } finally {
    __setMetricSinkForTests(null)
  }
})
