import assert from 'node:assert/strict'
import test from 'node:test'

import { EphemeralExecutionStore } from '../main/modules/tools/skill-primitives/ephemeral-execution-store'

function register(store: EphemeralExecutionStore, rejected: string[]): void {
  store.register({
    executionId: 'eau-race0001',
    sessionId: 'scope-race',
    scopeId: 'scope-race',
    agent: 'butler',
    requestId: 'run-race',
    skillId: 'fixture',
    question: 'continue?',
    options: null,
    placeholder: null,
    askedAt: 1,
    resolve: () => { throw new Error('answer_must_not_win_terminal_fence') },
    reject: (error) => { rejected.push(error.message) },
    timeoutHandle: setTimeout(() => {}, 60_000),
  })
}

test('skill ask-user terminal fence rejects late answers only after durable commit', () => {
  const store = new EphemeralExecutionStore()
  const rejected: string[] = []
  register(store, rejected)

  store.prepareRunTerminalFence('scope-race', 'run-race')
  assert.equal(store.resolve('eau-race0001', 'yes'), false)
  assert.equal(store.has('eau-race0001'), true)

  store.rollbackRunTerminalFence('scope-race', 'run-race')
  store.prepareRunTerminalFence('scope-race', 'run-race')
  assert.equal(store.commitRunTerminalFence(
    'scope-race',
    'run-race',
    new Error('waiting_task_gone'),
  ), 1)
  assert.deepEqual(rejected, ['waiting_task_gone'])
  assert.equal(store.resolve('eau-race0001', 'late'), false)
  assert.equal(store.size(), 0)
})
