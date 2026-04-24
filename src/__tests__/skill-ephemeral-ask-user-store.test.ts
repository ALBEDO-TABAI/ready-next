/**
 * Tests for EphemeralExecutionStore
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { EphemeralExecutionStore } from '../main/modules/tools/skill-ephemeral-ask-user'

test('CRUD: should create a new ask record', () => {
  const store = new EphemeralExecutionStore()
  const askId = store.createAskUser('session-1', 'What is your name?')

  assert.match(askId, /^ask-\d+-[a-z0-9]+$/)

  const record = store.getAskUser(askId)
  assert.notEqual(record, null)
  assert.equal(record?.sessionId, 'session-1')
  assert.equal(record?.question, 'What is your name?')
  assert.equal(record?.status, 'pending')

  store.stopSweep()
})

test('CRUD: should retrieve an existing ask record', () => {
  const store = new EphemeralExecutionStore()
  const askId = store.createAskUser('session-1', 'Test question')
  const record = store.getAskUser(askId)

  assert.notEqual(record, null)
  assert.equal(record?.askId, askId)
  assert.equal(record?.question, 'Test question')

  store.stopSweep()
})

test('CRUD: should return null for non-existent ask record', () => {
  const store = new EphemeralExecutionStore()
  const record = store.getAskUser('non-existent-id')
  assert.equal(record, null)

  store.stopSweep()
})

test('CRUD: should update an existing ask record', () => {
  const store = new EphemeralExecutionStore()
  const askId = store.createAskUser('session-1', 'Original question')
  const updated = store.updateAskUser(askId, {
    status: 'answered',
    answer: 'My answer',
  })

  assert.equal(updated, true)

  const record = store.getAskUser(askId)
  assert.equal(record?.status, 'answered')
  assert.equal(record?.answer, 'My answer')

  store.stopSweep()
})

test('CRUD: should return false when updating non-existent record', () => {
  const store = new EphemeralExecutionStore()
  const updated = store.updateAskUser('non-existent-id', { status: 'answered' })
  assert.equal(updated, false)

  store.stopSweep()
})

test('CRUD: should delete an existing ask record', () => {
  const store = new EphemeralExecutionStore()
  const askId = store.createAskUser('session-1', 'Test question')
  const deleted = store.deleteAskUser(askId)

  assert.equal(deleted, true)
  assert.equal(store.getAskUser(askId), null)

  store.stopSweep()
})

test('CRUD: should return false when deleting non-existent record', () => {
  const store = new EphemeralExecutionStore()
  const deleted = store.deleteAskUser('non-existent-id')
  assert.equal(deleted, false)

  store.stopSweep()
})

test('Session queries: should return active asks for a session', () => {
  const store = new EphemeralExecutionStore()
  const askId1 = store.createAskUser('session-1', 'Question 1')
  const askId2 = store.createAskUser('session-1', 'Question 2')
  store.createAskUser('session-2', 'Question 3')

  const sessionAsks = store.getActiveAsksBySession('session-1')
  assert.equal(sessionAsks.length, 2)
  assert.ok(sessionAsks.some((a) => a.askId === askId1))
  assert.ok(sessionAsks.some((a) => a.askId === askId2))

  store.stopSweep()
})

test('Session queries: should return empty array for session with no asks', () => {
  const store = new EphemeralExecutionStore()
  const sessionAsks = store.getActiveAsksBySession('non-existent-session')
  assert.equal(sessionAsks.length, 0)

  store.stopSweep()
})

test('Session queries: should check if session has active ask', () => {
  const store = new EphemeralExecutionStore()
  store.createAskUser('session-1', 'Test question')

  assert.equal(store.hasActiveAsk('session-1'), true)
  assert.equal(store.hasActiveAsk('session-2'), false)

  store.stopSweep()
})

test('Session queries: should not return expired asks in active queries', async () => {
  const store = new EphemeralExecutionStore()
  store.createAskUser('session-1', 'Test question', 100) // 100ms TTL

  // Wait for expiration
  await new Promise((resolve) => setTimeout(resolve, 150))

  const sessionAsks = store.getActiveAsksBySession('session-1')
  assert.equal(sessionAsks.length, 0)
  assert.equal(store.hasActiveAsk('session-1'), false)

  store.stopSweep()
})

test('TTL: should create record with custom TTL', () => {
  const store = new EphemeralExecutionStore()
  const now = Date.now()
  const askId = store.createAskUser('session-1', 'Test question', 5000) // 5 seconds
  const record = store.getAskUser(askId)

  assert.ok(record?.expiresAt >= now + 4900)
  assert.ok(record?.expiresAt <= now + 5100)

  store.stopSweep()
})

test('TTL: should sweep expired records', async () => {
  const store = new EphemeralExecutionStore()
  store.createAskUser('session-1', 'Question 1', 100) // 100ms TTL
  store.createAskUser('session-2', 'Question 2', 10000) // 10s TTL

  assert.equal(store.getSize(), 2)

  // Wait for first record to expire
  await new Promise((resolve) => setTimeout(resolve, 150))

  const deleted = store.sweepExpired()

  assert.equal(deleted, 1)
  assert.equal(store.getSize(), 1)

  store.stopSweep()
})

test('TTL: should return 0 when sweeping empty store', () => {
  const store = new EphemeralExecutionStore()
  const deleted = store.sweepExpired()
  assert.equal(deleted, 0)

  store.stopSweep()
})

test('Session cleanup: should clear all asks for a session', () => {
  const store = new EphemeralExecutionStore()
  store.createAskUser('session-1', 'Question 1')
  store.createAskUser('session-1', 'Question 2')
  store.createAskUser('session-2', 'Question 3')

  assert.equal(store.getSize(), 3)

  const deleted = store.clearAllForSession('session-1')

  assert.equal(deleted, 2)
  assert.equal(store.getSize(), 1)
  assert.equal(store.getAskUser('session-1'), null)

  store.stopSweep()
})

test('Session cleanup: should return 0 when clearing non-existent session', () => {
  const store = new EphemeralExecutionStore()
  const deleted = store.clearAllForSession('non-existent-session')
  assert.equal(deleted, 0)

  store.stopSweep()
})

test('Session cleanup: should update session count after cleanup', () => {
  const store = new EphemeralExecutionStore()
  store.createAskUser('session-1', 'Question 1')
  store.createAskUser('session-2', 'Question 2')
  store.createAskUser('session-2', 'Question 3')

  assert.equal(store.getSessionCount(), 2)

  store.clearAllForSession('session-1')

  assert.equal(store.getSessionCount(), 1)

  store.stopSweep()
})

test('Utility: should return correct store size', () => {
  const store = new EphemeralExecutionStore()
  assert.equal(store.getSize(), 0)

  store.createAskUser('session-1', 'Question 1')
  assert.equal(store.getSize(), 1)

  store.createAskUser('session-1', 'Question 2')
  store.createAskUser('session-2', 'Question 3')
  assert.equal(store.getSize(), 3)

  store.stopSweep()
})

test('Utility: should return correct session count', () => {
  const store = new EphemeralExecutionStore()
  assert.equal(store.getSessionCount(), 0)

  store.createAskUser('session-1', 'Question 1')
  assert.equal(store.getSessionCount(), 1)

  store.createAskUser('session-1', 'Question 2')
  assert.equal(store.getSessionCount(), 1) // Same session

  store.createAskUser('session-2', 'Question 3')
  assert.equal(store.getSessionCount(), 2)

  store.stopSweep()
})

test('Sweep scheduling: should start and stop sweep timer', () => {
  const store = new EphemeralExecutionStore()

  // Should not throw
  store.startSweep()
  store.startSweep()
  store.startSweep()

  // Should not throw
  store.stopSweep()

  // Should handle multiple stop calls
  store.stopSweep()
  store.stopSweep()
})
