import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCanonicalCoreCloseoutMessage } from '../main/modules/repositories/canonical-core-closeout-message'

test('suspension notices occupy a checkpoint-scoped canonical id, never the run terminal id', () => {
  const notice = buildCanonicalCoreCloseoutMessage({
    parentTaskId: 'task-1',
    ownerRunId: 'run-1',
    conversationId: 'conv-1',
    finalText: '等待确认',
    timestamp: '2026-07-22T00:00:00.000Z',
    terminalReason: 'checkpoint_manual',
    checkpointId: 'ckpt-9',
  })
  const terminal = buildCanonicalCoreCloseoutMessage({
    parentTaskId: 'task-1',
    ownerRunId: 'run-1',
    conversationId: 'conv-1',
    finalText: '最终回复',
    timestamp: '2026-07-22T00:00:01.000Z',
    terminalReason: 'done',
  })
  assert.equal(notice.id, 'assistant:task-1:run-1:checkpoint:ckpt-9')
  assert.equal(terminal.id, 'assistant:task-1:run-1:terminal')
  assert.notEqual(notice.id, terminal.id, 'a pending notice must not preempt the terminal message id')
})
