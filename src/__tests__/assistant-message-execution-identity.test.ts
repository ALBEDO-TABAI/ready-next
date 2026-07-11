import assert from 'node:assert/strict'
import test from 'node:test'

import { rebuildAgentMessageFromRow } from '../renderer/stores/agent-store-helpers'

test('persisted assistant history restores the frozen execution agent instead of guessing from the conversation', () => {
  const message = rebuildAgentMessageFromRow({
    id: 'assistant-1', role: 'assistant', content: '完成', timestamp: '2026-07-11T00:00:00.000Z',
    meta: {
      runId: 'run-1', executionAgentId: 'copywriter', displayNameSnapshot: '文案',
      executionMaterialHash: 'hash-copywriter',
    },
  }, 'butler')
  assert.equal(message.agent, 'copywriter')
  assert.equal(message.meta?.displayNameSnapshot, '文案')
  assert.equal(message.meta?.executionMaterialHash, 'hash-copywriter')
})

test('legacy and user rows keep the conversation agent fallback', () => {
  assert.equal(rebuildAgentMessageFromRow({
    id: 'legacy', role: 'assistant', content: '旧消息', timestamp: '2026-07-11T00:00:00.000Z', meta: {},
  }, 'analyst').agent, 'analyst')
  assert.equal(rebuildAgentMessageFromRow({
    id: 'user', role: 'user', content: '我', timestamp: '2026-07-11T00:00:00.000Z', meta: { executionAgentId: 'copywriter' },
  }, 'butler').agent, 'butler')
})
