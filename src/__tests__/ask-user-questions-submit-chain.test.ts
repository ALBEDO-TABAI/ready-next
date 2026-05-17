/**
 * Stage U (PR 1) behavior tests for `submitAskUserQuestionsAnswersCore`.
 *
 * Pure module — uses an injected store + a fake DB to exercise B.1 (server-
 * side re-validation), B.2 (DB transient vs row-missing), and B.3 (resolver
 * miss rollback). No electron or SQLite involved.
 *
 * Each test asserts:
 *   - the returned IPC envelope (success/errorKind/recoverable),
 *   - DB write side effects (what the fake recorded),
 *   - in-memory store state (whether the Promise was resolved or rejected
 *     and how),
 *   - metric emissions (matching TOOL_ERROR_METRICS registry).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  submitAskUserQuestionsAnswersCore,
  type SubmitDbAccess,
} from '../main/modules/tools/builtins/ask-user-questions'
import {
  AskUserQuestionsStore,
  type AskUserAnswer,
  type AskUserQuestionsAnswerSet,
  type AskUserQuestionSpec,
} from '../main/modules/tools/builtins/ask-user-questions-store'
import { ToolDomainError } from '../main/modules/tools/tool-errors'
import { ASK_USER_ERROR_KINDS } from '../main/modules/agent-control/error-kinds'
import { TOOL_ERROR_METRICS } from '../main/modules/agent-control/tool-error-metrics'

function makeFakeDb(opts: {
  initialPendingMeta?: Record<string, unknown>
  /** Force the next updateChatMessageMeta call to behave a certain way. */
  updateBehavior?: 'success' | 'returns_false' | 'throws'
  /** Optional throw to use when updateBehavior === 'throws'. */
  throwError?: Error
} = {}): {
  db: SubmitDbAccess
  writes: Array<{
    id: string
    meta: Record<string, unknown>
    opts?: { content?: string }
  }>
  // After the first call, subsequent calls always succeed (so resolver-miss
  // rollback can land).
  trippedFirstCall: { value: boolean }
} {
  const writes: Array<{ id: string; meta: Record<string, unknown>; opts?: { content?: string } }> = []
  const trippedFirstCall = { value: false }
  const initialMeta = opts.initialPendingMeta ?? {
    askUserQuestions: { cardId: 'card-1', status: 'pending', questions: [], askedAt: 1 },
  }
  const db: SubmitDbAccess = {
    getChatMessageById(_id) {
      return { meta_json: JSON.stringify(initialMeta) }
    },
    updateChatMessageMeta(id, meta, options) {
      // Only the FIRST call honors the configured behavior; subsequent writes
      // (e.g. the resolver-miss rollback) always succeed.
      if (!trippedFirstCall.value) {
        trippedFirstCall.value = true
        if (opts.updateBehavior === 'returns_false') return false
        if (opts.updateBehavior === 'throws') {
          throw opts.throwError ?? new Error('SQLITE_BUSY: database is locked')
        }
      }
      writes.push({ id, meta, opts: options })
      return true
    },
  }
  return { db, writes, trippedFirstCall }
}

function registerPendingCard(
  store: AskUserQuestionsStore,
  cardId: string,
  questions: AskUserQuestionSpec[],
): {
  resolve: (a: AskUserQuestionsAnswerSet) => void
  reject: (e: Error) => void
  promise: Promise<AskUserQuestionsAnswerSet>
  /** Pre-attached `.catch` swallower so test cleanup `store.reject` calls
   *  don't produce unhandled-rejection warnings after the test body returns. */
  silent: Promise<AskUserQuestionsAnswerSet | null>
} {
  let resolveFn: (a: AskUserQuestionsAnswerSet) => void = () => {}
  let rejectFn: (e: Error) => void = () => {}
  const promise = new Promise<AskUserQuestionsAnswerSet>((resolve, reject) => {
    resolveFn = resolve
    rejectFn = reject
  })
  // Attach a catch handler immediately so any later reject (including the
  // cleanup `store.reject` calls in negative tests) doesn't surface as an
  // unhandled rejection.
  const silent: Promise<AskUserQuestionsAnswerSet | null> = promise.catch(() => null)
  store.register({
    cardId,
    sessionId: 'sess-1',
    conversationId: 'conv-1',
    questions,
    askedAt: 1,
    resolve: resolveFn,
    reject: rejectFn,
    // store.resolve / store.reject call clearTimeout so this is fine.
    timeoutHandle: setTimeout(() => {}, 86400000),
  })
  return { resolve: resolveFn, reject: rejectFn, promise, silent }
}

const SINGLE_REQUIRED_FREETEXT: AskUserQuestionSpec[] = [
  { id: 'q1', question: 'What?', kind: 'free_text', required: true },
]

const SINGLE_CHOICE_AB: AskUserQuestionSpec[] = [
  { id: 'q1', question: 'Pick', kind: 'single_choice', required: true, options: ['A', 'B'] },
]

const MULTI_CHOICE_XYZ: AskUserQuestionSpec[] = [
  { id: 'q1', question: 'Pick many', kind: 'multi_choice', required: true, options: ['X', 'Y', 'Z'] },
]

// ============================================================================
// Happy path
// ============================================================================

test('happy path: valid answers → DB write + store.resolve + success envelope', async () => {
  const store = new AskUserQuestionsStore()
  const { promise } = registerPendingCard(store, 'card-1', SINGLE_REQUIRED_FREETEXT)
  const { db, writes } = makeFakeDb()
  const metrics: Array<{ name: string; payload: Record<string, unknown> }> = []

  const result = submitAskUserQuestionsAnswersCore(
    'card-1',
    [{ id: 'q1', answer: 'my answer' }],
    {
      store,
      db,
      logMetric: (name, payload) => { metrics.push({ name, payload }) },
      now: () => 12345,
    },
  )

  assert.equal(result.success, true)
  assert.equal(writes.length, 1)
  const wroteMeta = writes[0].meta.askUserQuestions as { status: string; answers: AskUserAnswer[]; answeredAt: number }
  assert.equal(wroteMeta.status, 'submitted')
  assert.equal(wroteMeta.answers.length, 1)
  assert.equal(wroteMeta.answeredAt, 12345)
  assert.equal(metrics.length, 0, 'no metrics on happy path')
  // Promise should now be resolved.
  const ans = await promise
  assert.equal(ans.answers[0].answer, 'my answer')
  assert.equal(store.size(), 0, 'store record removed after resolve')
})

// ============================================================================
// B.1 — server-side re-validation
// ============================================================================

test('B.1: missing required answer → input_validation, no DB write, no resolve', () => {
  const store = new AskUserQuestionsStore()
  const { promise } = registerPendingCard(store, 'card-1', SINGLE_REQUIRED_FREETEXT)
  // Silence the unhandled-rejection warning if this Promise leaks (it shouldn't).
  promise.catch(() => {})
  const { db, writes } = makeFakeDb()

  const result = submitAskUserQuestionsAnswersCore('card-1', [], { store, db })

  assert.equal(result.success, false)
  if (result.success) throw new Error('unreachable')
  assert.equal(result.errorKind, ASK_USER_ERROR_KINDS.inputValidation.code)
  assert.match(result.error, /Required question not answered: q1/)
  assert.equal(writes.length, 0, 'no DB write on validation failure')
  assert.equal(store.size(), 1, 'pending record preserved on validation failure')
  // Cleanup to silence unhandled rejection warning
  store.reject('card-1', new Error('test cleanup'))
})

test('B.1: single_choice answer not in options → input_validation', () => {
  const store = new AskUserQuestionsStore()
  registerPendingCard(store, 'card-1', SINGLE_CHOICE_AB)
  const { db, writes } = makeFakeDb()

  const result = submitAskUserQuestionsAnswersCore(
    'card-1',
    [{ id: 'q1', answer: 'C' /* not in [A, B] */ }],
    { store, db },
  )

  assert.equal(result.success, false)
  if (result.success) throw new Error('unreachable')
  assert.equal(result.errorKind, ASK_USER_ERROR_KINDS.inputValidation.code)
  assert.match(result.error, /not in options/)
  assert.equal(writes.length, 0)
  store.reject('card-1', new Error('test cleanup'))
})

test('B.1: multi_choice value not in options → input_validation', () => {
  const store = new AskUserQuestionsStore()
  registerPendingCard(store, 'card-1', MULTI_CHOICE_XYZ)
  const { db } = makeFakeDb()
  const result = submitAskUserQuestionsAnswersCore(
    'card-1',
    [{ id: 'q1', answer: ['X', 'W' /* not in options */] }],
    { store, db },
  )
  assert.equal(result.success, false)
  if (result.success) throw new Error('unreachable')
  assert.equal(result.errorKind, ASK_USER_ERROR_KINDS.inputValidation.code)
  store.reject('card-1', new Error('test cleanup'))
})

test('B.1: unknown question id in answers → input_validation', () => {
  const store = new AskUserQuestionsStore()
  registerPendingCard(store, 'card-1', SINGLE_CHOICE_AB)
  const { db } = makeFakeDb()
  const result = submitAskUserQuestionsAnswersCore(
    'card-1',
    [{ id: 'q1', answer: 'A' }, { id: 'q-bogus', answer: 'sneak' }],
    { store, db },
  )
  assert.equal(result.success, false)
  if (result.success) throw new Error('unreachable')
  assert.equal(result.errorKind, ASK_USER_ERROR_KINDS.inputValidation.code)
  assert.match(result.error, /Unknown question id/)
  store.reject('card-1', new Error('test cleanup'))
})

// ============================================================================
// B.2 — DB transient vs row missing
// ============================================================================

test('B.2 transient: DB throws → persistence_failed (recoverable=true), pending kept', () => {
  const store = new AskUserQuestionsStore()
  registerPendingCard(store, 'card-1', SINGLE_REQUIRED_FREETEXT)
  const { db } = makeFakeDb({ updateBehavior: 'throws', throwError: new Error('SQLITE_BUSY') })
  const metrics: Array<{ name: string; payload: Record<string, unknown> }> = []
  const result = submitAskUserQuestionsAnswersCore(
    'card-1',
    [{ id: 'q1', answer: 'hello' }],
    { store, db, logMetric: (name, payload) => { metrics.push({ name, payload }) } },
  )

  assert.equal(result.success, false)
  if (result.success) throw new Error('unreachable')
  assert.equal(result.errorKind, ASK_USER_ERROR_KINDS.persistenceFailed.code)
  assert.equal(result.recoverable, true)
  assert.equal(store.size(), 1, 'pending preserved on transient DB error')
  assert.equal(metrics.length, 1)
  assert.equal(metrics[0].name, TOOL_ERROR_METRICS.askUserQuestionsSubmitDbFailed)
  assert.equal(metrics[0].payload.kind, 'throw')
  store.reject('card-1', new Error('test cleanup'))
})

test('B.2 row missing: updateChatMessageMeta returns false → waiting_task_gone + store.reject', async () => {
  const store = new AskUserQuestionsStore()
  const { promise } = registerPendingCard(store, 'card-1', SINGLE_REQUIRED_FREETEXT)
  const { db } = makeFakeDb({ updateBehavior: 'returns_false' })
  const metrics: Array<{ name: string; payload: Record<string, unknown> }> = []
  const result = submitAskUserQuestionsAnswersCore(
    'card-1',
    [{ id: 'q1', answer: 'hello' }],
    { store, db, logMetric: (name, payload) => { metrics.push({ name, payload }) } },
  )

  assert.equal(result.success, false)
  if (result.success) throw new Error('unreachable')
  assert.equal(result.errorKind, ASK_USER_ERROR_KINDS.waitingTaskGone.code)
  assert.equal(store.size(), 0, 'in-memory record terminated on row missing')
  assert.equal(metrics.length, 1)
  assert.equal(metrics[0].payload.kind, 'row_missing')
  // Promise must reject with waiting_task_gone errorKind so the awaiting tool
  // handler stops blocking the model.
  await assert.rejects(
    promise,
    (err: unknown) => err instanceof ToolDomainError
      && err.errorKind === ASK_USER_ERROR_KINDS.waitingTaskGone.code,
  )
})

test('B.2 unknown card id (already swept from store) → waiting_task_gone, no DB write', () => {
  const store = new AskUserQuestionsStore()
  // No registerPendingCard — simulates a card that was timed out/aborted
  // BEFORE the submit IPC arrived.
  const { db, writes } = makeFakeDb()
  const result = submitAskUserQuestionsAnswersCore(
    'no-such-card',
    [{ id: 'q1', answer: 'x' }],
    { store, db },
  )
  assert.equal(result.success, false)
  if (result.success) throw new Error('unreachable')
  assert.equal(result.errorKind, ASK_USER_ERROR_KINDS.waitingTaskGone.code)
  assert.equal(writes.length, 0)
})

// ============================================================================
// B.3 — store.resolve miss → DB rollback
// ============================================================================

test('B.3: store.resolve miss → DB rolled back to cancelled(card_resolver_missed)', async () => {
  // Simulate the race: handler registered a card, then BEFORE submit arrives
  // the in-memory record is rejected (e.g. by an abort signal). Submit then
  // arrives, writes DB, but store.resolve returns false. The submit handler
  // must roll back the DB row.
  const store = new AskUserQuestionsStore()
  const { promise } = registerPendingCard(store, 'card-1', SINGLE_REQUIRED_FREETEXT)
  // Defuse the abort race manually:
  store.reject('card-1', new ToolDomainError('aborted', 'simulated abort'))
  // Swallow the rejection so the test runner doesn't see it.
  await promise.catch(() => {})

  // Now register a SECOND pending record with the same cardId — emulating a
  // record that exists at submit-time but disappears between the DB write
  // and store.resolve. To make this deterministic we replace the resolve fn.
  const { promise: secondPromise } = registerPendingCard(store, 'card-1', SINGLE_REQUIRED_FREETEXT)
  secondPromise.catch(() => {})

  let removedBetween = false
  // Custom DB that, after writing the first time, removes the in-memory
  // record so that the subsequent store.resolve will miss.
  const writes: Array<{ id: string; meta: Record<string, unknown> }> = []
  const db: SubmitDbAccess = {
    getChatMessageById() {
      return { meta_json: JSON.stringify({ askUserQuestions: { status: 'pending' } }) }
    },
    updateChatMessageMeta(id, meta) {
      writes.push({ id, meta })
      // After the "submit" write but before resolve: drop the record.
      if (!removedBetween) {
        removedBetween = true
        store.reject('card-1', new Error('simulated late abort'))
      }
      return true
    },
  }
  const metrics: Array<{ name: string; payload: Record<string, unknown> }> = []

  const result = submitAskUserQuestionsAnswersCore(
    'card-1',
    [{ id: 'q1', answer: 'late' }],
    { store, db, logMetric: (name, payload) => { metrics.push({ name, payload }) }, now: () => 99999 },
  )

  assert.equal(result.success, false)
  if (result.success) throw new Error('unreachable')
  assert.equal(result.errorKind, ASK_USER_ERROR_KINDS.cardResolverMissed.code)
  assert.equal(metrics.length, 1)
  assert.equal(metrics[0].name, TOOL_ERROR_METRICS.askUserQuestionsSubmitResolverMissed)
  // Two writes happened: the original submit (writes[0]) AND the rollback to
  // cancelled(card_resolver_missed) (writes[1]).
  assert.equal(writes.length, 2)
  const rollbackMeta = writes[1].meta.askUserQuestions as { status: string; cancelReason: string }
  assert.equal(rollbackMeta.status, 'cancelled')
  assert.equal(rollbackMeta.cancelReason, 'card_resolver_missed')
})
