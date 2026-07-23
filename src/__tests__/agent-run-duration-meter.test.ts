import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ScopeRunState } from '../renderer/stores/useAgent'
import {
  buildRunDurationMeterModel,
  formatRunDuration,
  RunDurationMeter,
} from '../renderer/components/agent/chat-panel/RunDurationMeter'

function run(overrides: Partial<ScopeRunState>): ScopeRunState {
  return {
    scopeId: 'scope-a',
    agent: 'butler',
    requestId: 'req-a',
    phase: 'planning',
    terminalReason: null,
    toolTrace: [],
    startedAt: '2026-06-27T03:00:00.000Z',
    updatedAt: '2026-06-27T03:00:00.000Z',
    ...overrides,
  }
}

test('formatRunDuration uses mm:ss below one hour and h:mm:ss after one hour', () => {
  assert.equal(formatRunDuration(7_400), '00:07')
  assert.equal(formatRunDuration(65_000), '01:05')
  assert.equal(formatRunDuration(3_725_000), '1:02:05')
})

test('running agent turn duration ticks against now and uses animated dot state', () => {
  const model = buildRunDurationMeterModel(
    run({ phase: 'tool_running' }),
    Date.parse('2026-06-27T03:00:09.500Z'),
  )

  assert.deepEqual(model, {
    label: '本轮进行中',
    duration: '00:09',
    glyph: 'running',
    tone: 'neutral',
    pulse: true,
    live: true,
  })
})

test('terminal agent turn duration freezes at updatedAt', () => {
  const model = buildRunDurationMeterModel(
    run({
      phase: 'done',
      terminalReason: 'done',
      updatedAt: '2026-06-27T03:02:04.000Z',
    }),
    Date.parse('2026-06-27T03:05:00.000Z'),
  )

  assert.deepEqual(model, {
    label: '本轮用时',
    duration: '02:04',
    glyph: 'done',
    tone: 'neutral',
    pulse: false,
    live: false,
  })
})

test('cancelled agent turn shows stopped copy and does not animate', () => {
  const model = buildRunDurationMeterModel(
    run({
      phase: 'cancelled',
      terminalReason: 'cancelled_user',
      updatedAt: '2026-06-27T03:00:31.000Z',
    }),
    Date.parse('2026-06-27T03:05:00.000Z'),
  )

  assert.equal(model?.label, '本轮已停止')
  assert.equal(model?.duration, '00:31')
  assert.equal(model?.pulse, false)
  assert.equal(model?.live, false)
})

test('checkpoint distinguishes paused continuation, real user wait, and incomplete state', () => {
  const orphan = buildRunDurationMeterModel(
    run({ phase: 'checkpoint', terminalReason: 'delivery_failed', updatedAt: '2026-06-27T03:00:31.000Z' }),
    Date.parse('2026-06-27T03:05:00.000Z'),
  )
  const resumable = buildRunDurationMeterModel(
    run({
      phase: 'checkpoint',
      terminalReason: 'checkpoint_budget',
      updatedAt: '2026-06-27T03:00:31.000Z',
      taskContinuation: { taskId: 'task-a', resumeKind: 'paused', runStatePath: '/tmp/run_state.json' } as never,
    }),
    Date.parse('2026-06-27T03:05:00.000Z'),
  )
  const waiting = buildRunDurationMeterModel(
    run({
      phase: 'checkpoint',
      waitingFor: 'confirmation',
      updatedAt: '2026-06-27T03:00:31.000Z',
    }),
    Date.parse('2026-06-27T03:05:00.000Z'),
  )

  assert.equal(orphan?.label, '本轮未完成')
  assert.equal(orphan?.glyph, 'error')
  assert.equal(resumable?.label, '本轮已暂停')
  assert.equal(waiting?.label, '本轮等待中')
})

test('empty or idle run does not render a duration model', () => {
  assert.equal(buildRunDurationMeterModel(null, Date.now()), null)
  assert.equal(buildRunDurationMeterModel(run({ phase: 'idle', startedAt: null }), Date.now()), null)
})

test('duration meter keeps its status and timer without an outer box', () => {
  const markup = renderToStaticMarkup(createElement(RunDurationMeter, {
    run: run({ phase: 'done', updatedAt: '2026-06-27T03:00:09.000Z' }),
  }))
  const meter = markup.match(/<div data-agent-run-duration-meter="true"[^>]*style="([^"]*)"/)
  assert.ok(meter, `duration meter rendered: ${markup}`)
  assert.doesNotMatch(meter[1], /(?:^|;)border:/)
  assert.doesNotMatch(meter[1], /(?:^|;)background:/)
  assert.doesNotMatch(meter[1], /backdrop-filter/)
  assert.match(markup, /本轮用时/)
  assert.match(markup, /00:09/)
})
