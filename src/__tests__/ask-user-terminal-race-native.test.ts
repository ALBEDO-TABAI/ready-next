import assert from 'node:assert/strict'
import test from 'node:test'

import { EphemeralExecutionStore } from '../main/modules/tools/skill-primitives/ephemeral-execution-store'

test('Electron runtime preserves the same terminal-before-answer fence semantics', () => {
  const store = new EphemeralExecutionStore()
  const outcomes: string[] = []
  store.register({
    executionId: 'eau-native1', sessionId: 'scope-native', scopeId: 'scope-native',
    agent: 'butler', requestId: 'run-native', skillId: null, question: 'q',
    options: null, placeholder: null, askedAt: 1,
    resolve: () => outcomes.push('resolved'),
    reject: (error) => outcomes.push(error.message),
    timeoutHandle: setTimeout(() => {}, 60_000),
  })
  store.prepareRunTerminalFence('scope-native', 'run-native')
  assert.equal(store.resolve('eau-native1', 'too-late'), false)
  assert.equal(store.commitRunTerminalFence(
    'scope-native', 'run-native', new Error('waiting_task_gone'),
  ), 1)
  assert.deepEqual(outcomes, ['waiting_task_gone'])
})
