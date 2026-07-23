/** Live duration stays factual instead of echoing transient provider narration. */
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

test('RunDurationMeter: planning heartbeat text does not become a second status line', () => {
  const model = buildRunDurationMeterModel(runState({ latestText: '正在调用模型…' }), NOW)
  assert.equal(model?.label, '本轮进行中')
  assert.equal(model?.live, true)
})

test('RunDurationMeter: raw status echo and long text keep the generic label', () => {
  assert.equal(buildRunDurationMeterModel(runState({ latestText: '状态：working' }), NOW)?.label, '本轮进行中')
  assert.equal(
    buildRunDurationMeterModel(runState({ latestText: '这是一段非常非常非常非常非常非常非常非常长的心跳文案不该上标签' }), NOW)?.label,
    '本轮进行中',
  )
})

test('RunDurationMeter: non-planning live phases keep the generic label', () => {
  const model = buildRunDurationMeterModel(runState({ phase: 'tool_running', latestText: '正在调用模型…' }), NOW)
  assert.equal(model?.label, '本轮进行中')
})
