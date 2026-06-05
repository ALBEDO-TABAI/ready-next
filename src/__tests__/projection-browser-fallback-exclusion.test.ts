import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { resolveProjectionForTaskRun } from '../renderer/components/agent/chat-panel/helpers/projection'

// Codex result-review #B: a running note_collect (module:'browser') projection
// must NOT be grabbed as the projection for an unrelated FOREGROUND task card
// via selectFallbackProjection — it owns its own background card (merge pass 4).

const browserProjection = {
  taskId: 'browser-task-1',
  scopeId: 'conv-1',
  module: 'browser',
  status: 'running',
  taskTitle: '浏览器逐篇采集',
  waitingFor: 'background',
} as never

const skillProjection = {
  taskId: 'skill-task-9',
  scopeId: 'conv-1',
  module: 'skill',
  status: 'running',
  taskTitle: '技能任务',
} as never

describe('resolveProjectionForTaskRun — browser fallback exclusion', () => {
  it('does NOT return a browser projection as the foreground fallback (no taskId match)', () => {
    const run = { taskId: 'unrelated-foreground', taskContinuation: null } as never
    const resolved = resolveProjectionForTaskRun([browserProjection], run)
    assert.equal(resolved, null, 'browser background task must not hijack a foreground card')
  })

  it('still returns a non-browser projection via the fallback', () => {
    const run = { taskId: 'unrelated-foreground', taskContinuation: null } as never
    const resolved = resolveProjectionForTaskRun([browserProjection, skillProjection], run)
    assert.equal((resolved as { taskId?: string } | null)?.taskId, 'skill-task-9')
  })

  it('still returns a browser projection by EXACT taskId match (its own card path)', () => {
    const run = { taskId: 'browser-task-1', taskContinuation: null } as never
    const resolved = resolveProjectionForTaskRun([browserProjection], run)
    assert.equal((resolved as { taskId?: string } | null)?.taskId, 'browser-task-1')
  })
})
