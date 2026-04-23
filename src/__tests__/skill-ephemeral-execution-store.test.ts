/**
 * B Phase 1 PR2 — ephemeral execution store contract.
 * Purely in-memory; intentionally decoupled from the DB-backed
 * `skill_executions` table.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EphemeralExecutionStore,
  EPHEMERAL_ASK_USER_ID_PREFIX,
  generateEphemeralAskUserId,
  isEphemeralAskUserId,
} from '../main/modules/tools/skill-primitives/ephemeral-execution-store'

test('generates ids with the eau- prefix and is recognized by isEphemeralAskUserId', () => {
  for (let i = 0; i < 5; i += 1) {
    const id = generateEphemeralAskUserId()
    assert.ok(id.startsWith(EPHEMERAL_ASK_USER_ID_PREFIX))
    assert.equal(isEphemeralAskUserId(id), true)
    // Real workflow execution ids (`e-xxxxxxxx`) must NOT be mistaken for ephemeral.
    assert.equal(isEphemeralAskUserId('e-12345678'), false)
  }
})

test('register / resolve / reject lifecycle', () => {
  const store = new EphemeralExecutionStore()
  const calls = { resolved: 0, rejected: 0 }

  const executionId = generateEphemeralAskUserId()
  store.register({
    executionId,
    sessionId: 's',
    skillId: 'skill',
    question: 'q',
    options: null,
    placeholder: null,
    askedAt: Date.now(),
    resolve: () => { calls.resolved += 1 },
    reject: () => { calls.rejected += 1 },
    timeoutHandle: setTimeout(() => {}, 1_000_000),
  })
  assert.equal(store.size(), 1)
  assert.ok(store.has(executionId))

  assert.equal(store.resolve(executionId, 'answer'), true)
  assert.equal(store.size(), 0)
  assert.equal(calls.resolved, 1)

  // Resolving the same id again is a no-op returning false (late submit).
  assert.equal(store.resolve(executionId, 'stale'), false)
  assert.equal(calls.resolved, 1)
})

test('list() snapshots pending records without exposing resolvers', () => {
  const store = new EphemeralExecutionStore()
  const id = generateEphemeralAskUserId()
  store.register({
    executionId: id,
    sessionId: 's',
    skillId: null,
    question: 'pick',
    options: ['x', 'y'],
    placeholder: null,
    askedAt: 123,
    resolve: () => {},
    reject: () => {},
    timeoutHandle: setTimeout(() => {}, 1_000_000),
  })
  try {
    const list = store.list()
    assert.equal(list.length, 1)
    assert.equal(list[0].executionId, id)
    assert.equal(list[0].question, 'pick')
    assert.deepEqual(list[0].options, ['x', 'y'])
    assert.equal(typeof list[0].askedAt, 'number')
    // `resolve` and `reject` functions must not leak out of the store.
    assert.equal(('resolve' in list[0]), false)
    assert.equal(('reject' in list[0]), false)
  } finally {
    // Clean up the pending timer so test runner can exit the event loop.
    store.clear()
  }
})
