import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ScopeRunState } from '../renderer/stores/useAgent'
import { buildRunDurationMeterModel, RunDurationMeter } from '../renderer/components/agent/chat-panel/RunDurationMeter'

function checkpoint(overrides: Partial<ScopeRunState>): ScopeRunState {
  return {
    scopeId: 'scope-paused-duration',
    agent: 'butler',
    requestId: 'run-paused-duration',
    phase: 'checkpoint',
    terminalReason: 'checkpoint_provider_transfer',
    toolTrace: [],
    startedAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:25:13.132Z',
    waitingFor: 'none',
    ...overrides,
  }
}

test('resumable checkpoint without an interaction is paused, not waiting', () => {
  const model = buildRunDurationMeterModel(checkpoint({
    taskContinuation: {
      taskId: 'task-paused-duration',
      resumeKind: 'paused',
      runStatePath: '/tmp/paused-run-state.json',
    } as never,
  }), Date.parse('2026-07-23T01:00:00.000Z'))

  assert.equal(model?.label, '本轮已暂停')
  assert.equal(model?.duration, '25:13')

  const markup = renderToStaticMarkup(createElement(RunDurationMeter, {
    run: checkpoint({
      taskContinuation: {
        taskId: 'task-paused-duration',
        resumeKind: 'paused',
        runStatePath: '/tmp/paused-run-state.json',
      } as never,
    }),
  }))
  assert.match(markup, /本轮已暂停/)
  assert.match(markup, /本轮用时 25:13/)
  assert.match(markup, /aria-label="本轮已暂停，本轮用时 25:13"/)
})

test('checkpoint waiting labels come only from waitingFor', () => {
  for (const waitingFor of ['confirmation', 'input', 'clarification'] as const) {
    const model = buildRunDurationMeterModel(checkpoint({ waitingFor }), Date.now())
    assert.equal(model?.label, '本轮等待中')
  }
})

test('checkpoint without a continuation remains incomplete and freezes duration', () => {
  const model = buildRunDurationMeterModel(checkpoint({
    terminalReason: 'checkpoint_incomplete',
    resumableActions: ['none'],
  }), Date.parse('2026-07-23T01:00:00.000Z'))

  assert.equal(model?.label, '本轮未完成')
  assert.equal(model?.duration, '25:13')
})
