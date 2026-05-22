import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseRunStateJson,
  validateRunStateRecord,
} from '../main/modules/agent-control/task-projection/run-state-schema'

test('run_state schema accepts snake_case and camelCase identity/progress fields', () => {
  const parsed = parseRunStateJson(JSON.stringify({
    task_id: 'task-1',
    childRunId: 'vabc12345',
    status: 'completed',
    current_stage: 'finalize',
    activeOutputDir: '/tmp/out',
    total_scenes: 10,
    completedScenes: 8,
    coverage_ratio: 0.8,
    unexpected_extra: { kept: true },
  }))

  assert.equal(parsed.ok, true)
  assert.equal(parsed.ok && parsed.value.taskId, 'task-1')
  assert.equal(parsed.ok && parsed.value.childRunId, 'vabc12345')
  assert.equal(parsed.ok && parsed.value.status, 'done')
  assert.equal(parsed.ok && parsed.value.currentStage, 'finalize')
  assert.equal(parsed.ok && parsed.value.activeOutputDir, '/tmp/out')
  assert.equal(parsed.ok && parsed.value.totalScenes, 10)
  assert.equal(parsed.ok && parsed.value.completedScenes, 8)
  assert.equal(parsed.ok && parsed.value.coverageRatio, 0.8)
  assert.deepEqual(parsed.ok && parsed.value.raw.unexpected_extra, { kept: true })
})

test('run_state schema rejects malformed JSON, arrays, unknown statuses, and wrong recognized field types', () => {
  assert.equal(parseRunStateJson('{nope').ok, false)
  assert.equal(validateRunStateRecord([]).ok, false)

  const unknownStatus = parseRunStateJson(JSON.stringify({ status: 'mystery' }))
  assert.equal(unknownStatus.ok, false)
  assert.equal(!unknownStatus.ok && unknownStatus.reason, 'invalid_status')

  const wrongType = parseRunStateJson(JSON.stringify({ task_id: 123 }))
  assert.equal(wrongType.ok, false)
  assert.equal(!wrongType.ok && wrongType.reason, 'invalid_field')
})

test('run_state schema allows structured error payloads while preserving a readable lastError', () => {
  const parsed = validateRunStateRecord({
    status: 'blocked',
    error: { kind: 'blocked_config', message: 'missing key' },
  })

  assert.equal(parsed.ok, true)
  assert.equal(parsed.ok && parsed.value.status, 'blocked')
  assert.match(parsed.ok ? parsed.value.lastError || '' : '', /blocked_config/)
})

test('run_state schema accepts current child-run status vocabulary while preserving raw status text', () => {
  const recoverable = parseRunStateJson(JSON.stringify({ status: 'recoverable_paused' }))
  assert.equal(recoverable.ok, true)
  assert.equal(recoverable.ok && recoverable.value.status, 'blocked')
  assert.equal(recoverable.ok && recoverable.value.statusText, 'recoverable_paused')

  const killed = parseRunStateJson(JSON.stringify({ status: 'killed' }))
  assert.equal(killed.ok, true)
  assert.equal(killed.ok && killed.value.status, 'cancelled')
  assert.equal(killed.ok && killed.value.statusText, 'killed')
})
