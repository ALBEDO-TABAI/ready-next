import assert from 'node:assert/strict'
import test from 'node:test'

import { recoverUndeliveredAnswerForRetry } from '../main/modules/agent-control/runtime-core/undelivered-answer-recovery'
import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'

function projection(overrides: Partial<TaskProjectionRecord> = {}): TaskProjectionRecord {
  return {
    taskId: 'task-weather',
    scopeId: 'scope-weather',
    runId: 'run-weather',
    taskType: 'research',
    module: 'browser',
    status: 'failed',
    interactionState: 'suspended',
    steps: [],
    createdAt: '2026-06-29T00:00:00.000Z',
    updatedAt: '2026-06-29T00:00:01.000Z',
    ...overrides,
  } as TaskProjectionRecord
}

test('recovers a hidden final answer from failed browser proof-gap runs', () => {
  const recovered = recoverUndeliveredAnswerForRetry({
    projection: projection(),
    runMeta: {
      status: 'error',
      terminalReason: 'proof_gap',
      lastMessageText: '## 广州未来一周天气预报\n\n06-29 小雨 27~32°C',
    },
  })

  assert.match(recovered || '', /刚才的结果没有成功显示/)
  assert.match(recovered || '', /广州未来一周天气预报/)
})

test('does not steal failed skill retries or fallback-only text', () => {
  const skill = recoverUndeliveredAnswerForRetry({
    projection: projection({ module: 'skill', taskType: 'multi_step_task' }),
    runMeta: {
      status: 'error',
      terminalReason: 'proof_gap',
      lastMessageText: '技能失败后需要重试',
    },
  })
  const fallback = recoverUndeliveredAnswerForRetry({
    projection: projection(),
    runMeta: {
      status: 'error',
      terminalReason: 'proof_gap',
      lastMessageText: '这轮还没完整完成，可以继续发送',
    },
  })

  assert.equal(skill, null)
  assert.equal(fallback, null)
})
