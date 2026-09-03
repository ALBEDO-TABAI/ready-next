/** Live turns retain elapsed time but do not add a second running-state label. */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildRunDurationMeterModel } from '../renderer/components/agent/chat-panel/RunDurationMeter'

function runState(overrides: Record<string, unknown>): never {
  return {
    phase: 'planning',
    startedAt: new Date(1_780_000_000_000).toISOString(),
    updatedAt: new Date(1_780_000_005_000).toISOString(),
    toolTrace: [],
    ...overrides,
  } as never
}

const NOW = 1_780_000_006_000

test('RunDurationMeter: every live phase keeps one elapsed-time model', () => {
  for (const phase of ['queued', 'planning', 'tool_running', 'takeover', 'resuming', 'responding']) {
    const model = buildRunDurationMeterModel(runState({ phase, latestText: '正在调用模型…' }), NOW)
    assert.equal(model?.label, '本轮用时', phase)
    assert.equal(model?.duration, '00:06', phase)
    assert.equal(model?.live, true, phase)
  }
})

test('RunDurationMeter: terminal duration remains available after the turn settles', () => {
  const model = buildRunDurationMeterModel(runState({ phase: 'done' }), NOW)
  assert.equal(model?.label, '本轮用时')
  assert.equal(model?.duration, '00:05')
})
