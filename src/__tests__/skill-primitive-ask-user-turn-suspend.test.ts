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
      scopeId: 'scope-1',
      agent: 'butler',
      requestId: 'req-1',
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
  assert.equal(evt.scopeId, 'scope-1')
  assert.equal(evt.agent, 'butler')
  assert.equal(evt.requestId, 'req-1')
  assert.equal(evt.skillId, 'novel_writer_system')
  assert.equal(evt.question, '选一个')
  assert.deepEqual(evt.options, ['A', 'B'])
  assert.equal(evt.placeholder, '或自由输入')
  assert.equal(store.size(), 1, 'store has one pending record')
  assert.equal(store.hasPendingForRun('butler', 'scope-1', 'req-1'), true)
  assert.equal(store.hasPendingForRun('butler', 'scope-1', 'req-other'), false)

  // Answer via the store — handler should resolve with the value and clear.
  store.resolve(evt.executionId, 'B')
  const out = await handlerPromise
  assert.equal(out.text, 'B')
  assert.equal((out.data as { answer: string }).answer, 'B')
  assert.equal(store.size(), 0, 'record is cleared after resolve')
})

test('rejects options that mix multiple question dimensions', async () => {
  const store = new EphemeralExecutionStore()
  const events: AskUserQuestionEvent[] = []

  await assert.rejects(
    executeAskUser(
      {
        question: '请确认几个关键信息',
        options: [
          '触点类型：快闪店',
          '触点类型：线下门店',
          '主推产品：全线，重点果酸/精华',
          '用户场景：换季敏感修护',
        ],
      },
      {
        sessionId: 'session-1',
        store,
        emitAskUserQuestion: (e) => events.push(e),
      },
    ),
    (err: unknown) => {
      assert.equal((err as { errorKind?: string })?.errorKind, 'input_validation')
      assert.match(String((err as Error).message), /ask_user_questions/)
      return true
    },
  )
  assert.equal(events.length, 0, 'invalid multi-question options must not reach the renderer')
  assert.equal(store.size(), 0, 'invalid multi-question options must not create a pending record')
})

test('allows one question with multiple options from the same group', async () => {
  const store = new EphemeralExecutionStore()
  const events: AskUserQuestionEvent[] = []
  const handlerPromise = executeAskUser(
    {
      question: '触点类型选哪一种？',
      options: ['触点类型：快闪店', '触点类型：线下门店', '触点类型：直播间背景'],
    },
    {
      sessionId: 'session-1',
      store,
      emitAskUserQuestion: (e) => events.push(e),
    },
  )
  await new Promise((r) => setImmediate(r))
  assert.equal(events.length, 1)
  store.resolve(events[0].executionId, '触点类型：线下门店')
  const out = await handlerPromise
  assert.equal(out.text, '触点类型：线下门店')
})

test('rejects question-like options that should be separate ask_user_questions items', async () => {
  const store = new EphemeralExecutionStore()
  await assert.rejects(
    executeAskUser(
      {
        question: '请补充信息',
        options: ['是否需要可移动快闪？', '是否需要直播间背景？'],
      },
      { sessionId: 'session-1', store },
    ),
    (err: unknown) => {
      assert.equal((err as { errorKind?: string })?.errorKind, 'input_validation')
      assert.match(String((err as Error).message), /ask_user_questions/)
      return true
    },
  )
  assert.equal(store.size(), 0)
})

test('post-completion follow-up returns guidance without opening a blocking card', async () => {
  const store = new EphemeralExecutionStore()
  const events: AskUserQuestionEvent[] = []
  const out = await executeAskUser(
    {
      question: '方案已完成，需要我做什么？',
      options: ['完成', '调整', '生成效果图'],
    },
    {
      sessionId: 'session-1',
      store,
      emitAskUserQuestion: (e) => events.push(e),
    },
  )

  assert.equal(events.length, 0, 'post-completion follow-up must not reach the renderer')
  assert.equal(store.size(), 0, 'post-completion follow-up must not create a pending record')
  assert.match(out.text, /普通总结/)
  assert.equal((out.data as { reason?: string }).reason, 'post_completion_followup')
  assert.equal((out.data as { skipped?: boolean }).skipped, true)
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
