import assert from 'node:assert/strict'
import test from 'node:test'

import { RunCleanupRegistry } from '../main/modules/agent-control/task-projection/run-cleanup-registry'

test('run cleanup registry drains registered callbacks exactly once', async () => {
  const registry = new RunCleanupRegistry()
  let cleanupCalls = 0
  registry.register('run-cleanup', async () => {
    cleanupCalls += 1
  })

  await registry.drain('run-cleanup')
  await registry.drain('run-cleanup')

  assert.equal(cleanupCalls, 1)
})
