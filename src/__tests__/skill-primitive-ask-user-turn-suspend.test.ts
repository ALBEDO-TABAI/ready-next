/**
 * B Phase 1 PR2 T1-7 — `skill_ask_user` handler.
 * Verifies:
 *   - Creates an ephemeral execution record keyed by a fresh id
 *   - Emits a push event describing the question
 *   - Resolves when `store.resolve` is called
 *   - Rejects with `errorKind: 'aborted'` on AbortSignal
 *   - Rejects with `errorKind: 'timeout'` past the configured timeout
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { executeAskUser, type AskUserQuestionEvent } from '../main/modules/tools/skill-primitives/ask-user'
import {
  EphemeralExecutionStore,
  isEphemeralAskUserId,
} from '../main/modules/tools/skill-primitives/ephemeral-execution-store'

test('creates an ephemeral record, emits a push event, and resolves on store.resolve', async () => {
  const store = new EphemeralExecutionStore()
  const events: AskUserQuestionEvent[] = []
  const handlerPromise = executeAskUser(
    { question: '选一个', options: ['A', 'B'], placeholder: '或自由输入' },
    {
      sessionId: 'session-1',
      skillId: 'novel_writer_system',
      store,
      emitAskUserQuestion: (e) => events.push(e),
    },
  )
  // Schedule resolve on the next tick so the handler has a chance to register.
  await new Promise((r) => setImmediate(r))
  assert.equal(events.length, 1, 'exactly one push event emitted')
  const evt = events[0]
  assert.ok(isEphemeralAskUserId(evt.executionId))
  assert.equal(evt.sessionId, 'session-1')
  assert.equal(evt.skillId, 'novel_writer_system')
  assert.equal(evt.question, '选一个')
  assert.deepEqual(evt.options, ['A', 'B'])
  assert.equal(evt.placeholder, '或自由输入')
  assert.equal(store.size(), 1, 'store has one pending record')

  // Answer via the store — handler should resolve with the value and clear.
  store.resolve(evt.executionId, 'B')
  const out = await handlerPromise
  assert.equal(out.text, 'B')
  assert.equal((out.data as { answer: string }).answer, 'B')
  assert.equal(store.size(), 0, 'record is cleared after resolve')
})

test('aborts with errorKind `aborted` when the AbortSignal fires', async () => {
  const store = new EphemeralExecutionStore()
  const ac = new AbortController()
  const handlerPromise = executeAskUser(
    { question: 'hi' },
    { sessionId: 's', store, signal: ac.signal },
  )
  await new Promise((r) => setImmediate(r))
  ac.abort()
  await assert.rejects(
    handlerPromise,
    (err: unknown) => (err as { errorKind?: string })?.errorKind === 'aborted',
  )
  assert.equal(store.size(), 0, 'aborted record removed from store')
})

test('timeouts surface as errorKind `timeout` past the configured deadline', async () => {
  const store = new EphemeralExecutionStore()
  const promise = executeAskUser(
    { question: 'hi' },
    { sessionId: 's', store, timeoutMs: 60 },
  )
  await assert.rejects(
    promise,
    (err: unknown) => (err as { errorKind?: string })?.errorKind === 'timeout',
  )
  assert.equal(store.size(), 0, 'timed-out record removed')
})

test('store.clear rejects every pending record (shutdown semantics)', async () => {
  const store = new EphemeralExecutionStore()
  const first = executeAskUser({ question: '1' }, { sessionId: 's', store })
  const second = executeAskUser({ question: '2' }, { sessionId: 's', store })
  await new Promise((r) => setImmediate(r))
  assert.equal(store.size(), 2)
  store.clear()
  await assert.rejects(first)
  await assert.rejects(second)
  assert.equal(store.size(), 0)
})

test('store.rejectBySession only drops records tied to the given session', async () => {
  const store = new EphemeralExecutionStore()
  const a = executeAskUser({ question: 'a' }, { sessionId: 's-alpha', store })
  const b = executeAskUser({ question: 'b' }, { sessionId: 's-beta', store })
  await new Promise((r) => setImmediate(r))
  const rejected = store.rejectBySession('s-alpha', new Error('scope tore down'))
  assert.equal(rejected, 1)
  await assert.rejects(a)
  // b still pending — clear it to keep the test clean.
  store.resolve(store.list()[0].executionId, 'ok')
  await b
})
