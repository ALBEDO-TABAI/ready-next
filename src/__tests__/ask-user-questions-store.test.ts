/**
 * Behavior tests for AskUserQuestionsStore.
 *
 * Pure module; no electron / no SQLite. Validates the lifecycle contracts
 * the handler depends on:
 *   - register + resolve unblocks the Promise and removes the record
 *   - reject clears the timeout and removes the record
 *   - rejectBySession only touches the matching session
 *   - hasPendingForSession is the single-pending guard the handler relies on
 *   - clear / size / list shapes
 *   - id prefix is `auq-`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  AskUserQuestionsStore,
  ASK_USER_QUESTIONS_ID_PREFIX,
  generateAskUserQuestionsCardId,
  isAskUserQuestionsCardId,
  type AskUserQuestionsCardRecord,
} from '../main/modules/tools/builtins/ask-user-questions-store'

function makeRecord(
  cardId: string,
  sessionId: string | null,
  options?: Partial<AskUserQuestionsCardRecord>,
): {
  record: AskUserQuestionsCardRecord
  promise: Promise<unknown>
  timeoutHandle: NodeJS.Timeout
} {
  let resolveFn: (v: unknown) => void = () => {}
  let rejectFn: (e: Error) => void = () => {}
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve as (v: unknown) => void
    rejectFn = reject
  })
  // Never-firing timer just to satisfy the record shape; tests don't wait it.
  const timeoutHandle = setTimeout(() => {}, 60_000)
  const record: AskUserQuestionsCardRecord = {
    cardId,
    sessionId,
    conversationId: sessionId,
    questions: [
      { id: 'q1', question: 'How do you feel?', kind: 'free_text', options: null, placeholder: null, required: true },
    ],
    askedAt: Date.now(),
    resolve: resolveFn as AskUserQuestionsCardRecord['resolve'],
    reject: rejectFn,
    timeoutHandle,
    ...options,
  }
  return { record, promise, timeoutHandle }
}

test('generateAskUserQuestionsCardId emits the auq- prefix', () => {
  const id = generateAskUserQuestionsCardId()
  assert.ok(id.startsWith(ASK_USER_QUESTIONS_ID_PREFIX))
  assert.equal(ASK_USER_QUESTIONS_ID_PREFIX, 'auq-')
  assert.ok(isAskUserQuestionsCardId(id))
  assert.ok(!isAskUserQuestionsCardId('eau-deadbeef'))
})

test('register + resolve fires the awaiting Promise and removes the record', async () => {
  const store = new AskUserQuestionsStore()
  const { record, promise, timeoutHandle } = makeRecord('auq-aaa', 'session-1')
  store.register(record)
  assert.equal(store.size(), 1)
  assert.ok(store.has('auq-aaa'))

  const answeredAt = 12345
  const ok = store.resolve('auq-aaa', { answers: [{ id: 'q1', answer: '挺好' }], answeredAt })
  assert.equal(ok, true)
  assert.equal(store.size(), 0)
  assert.equal(store.has('auq-aaa'), false)
  const value = await promise
  assert.deepEqual(value, { answers: [{ id: 'q1', answer: '挺好' }], answeredAt })
  // Resolved a second time returns false (the record is gone).
  const secondAttempt = store.resolve('auq-aaa', { answers: [], answeredAt })
  assert.equal(secondAttempt, false)
  clearTimeout(timeoutHandle)
})

test('reject rejects the awaiting Promise and removes the record', async () => {
  const store = new AskUserQuestionsStore()
  const { record, promise, timeoutHandle } = makeRecord('auq-bbb', 'session-2')
  store.register(record)
  const error = new Error('timeout')
  const ok = store.reject('auq-bbb', error)
  assert.equal(ok, true)
  assert.equal(store.size(), 0)
  await assert.rejects(promise, /timeout/)
  clearTimeout(timeoutHandle)
})

test('rejectBySession only rejects matching session', async () => {
  const store = new AskUserQuestionsStore()
  const a = makeRecord('auq-1', 'session-A')
  const b = makeRecord('auq-2', 'session-A')
  const c = makeRecord('auq-3', 'session-B')
  store.register(a.record)
  store.register(b.record)
  store.register(c.record)
  const rejected = store.rejectBySession('session-A', new Error('session reset'))
  assert.equal(rejected, 2)
  assert.equal(store.size(), 1)
  assert.ok(store.has('auq-3'))
  await assert.rejects(a.promise, /session reset/)
  await assert.rejects(b.promise, /session reset/)
  clearTimeout(a.timeoutHandle)
  clearTimeout(b.timeoutHandle)
  // c is still pending — resolve it to drain the Promise.
  store.resolve('auq-3', { answers: [], answeredAt: 0 })
  await c.promise
  clearTimeout(c.timeoutHandle)
})

test('hasPendingForSession + findPendingForSession power the single-pending guard', () => {
  const store = new AskUserQuestionsStore()
  const a = makeRecord('auq-x', 'session-S')
  store.register(a.record)
  assert.equal(store.hasPendingForSession('session-S'), true)
  assert.equal(store.hasPendingForSession('session-other'), false)
  assert.equal(store.findPendingForSession('session-S')?.cardId, 'auq-x')
  assert.equal(store.findPendingForSession('session-other'), null)
  assert.equal(store.hasPendingForSession(null), false)
  // Cleanup
  store.resolve('auq-x', { answers: [], answeredAt: 0 })
  void a.promise.catch(() => {})
  clearTimeout(a.timeoutHandle)
})

test('clear rejects every record and empties the store', async () => {
  const store = new AskUserQuestionsStore()
  const a = makeRecord('auq-c1', 'session-1')
  const b = makeRecord('auq-c2', null)
  store.register(a.record)
  store.register(b.record)
  store.clear()
  assert.equal(store.size(), 0)
  await assert.rejects(a.promise, /cleared/)
  await assert.rejects(b.promise, /cleared/)
  clearTimeout(a.timeoutHandle)
  clearTimeout(b.timeoutHandle)
})

test('list returns a snapshot view without resolvers', () => {
  const store = new AskUserQuestionsStore()
  const a = makeRecord('auq-l1', 'sess', {
    questions: [
      { id: 'q1', question: 'A', kind: 'single_choice', options: ['Y', 'N'], placeholder: null, required: true },
      { id: 'q2', question: 'B', kind: 'free_text', options: null, placeholder: 'tell me', required: false },
    ],
    askedAt: 999,
  })
  store.register(a.record)
  const list = store.list()
  assert.equal(list.length, 1)
  const view = list[0]
  assert.equal(view.cardId, 'auq-l1')
  assert.equal(view.askedAt, 999)
  assert.equal(view.questions.length, 2)
  // Ensure the snapshot view doesn't leak the resolver function.
  assert.equal('resolve' in view, false)
  assert.equal('reject' in view, false)
  store.resolve('auq-l1', { answers: [], answeredAt: 0 })
  void a.promise.catch(() => {})
  clearTimeout(a.timeoutHandle)
})
