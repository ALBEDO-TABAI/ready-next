/**
 * Stage U (PR 1, B.4a) behavior tests for `cancelAskUserQuestionsCardCore`.
 *
 * Covers:
 *   - happy path: in-memory store.reject + DB write to cancelled
 *   - user_typed_instead → errorKind mapped to user_skipped on the Promise
 *   - user_cancelled → errorKind=user_cancelled on the Promise
 *   - DB throw: store.reject STILL runs (no 24h hang) + IPC returns
 *     cancel_persist_failed + metric emitted
 *   - cardId unknown to store: returns success (DB write happens or no-ops),
 *     no rejection (there's no Promise to reject)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  cancelAskUserQuestionsCardCore,
  type CancelDbAccess,
} from '../main/modules/tools/builtins/ask-user-questions'
import {
  AskUserQuestionsStore,
  type AskUserQuestionsAnswerSet,
  type AskUserQuestionSpec,
} from '../main/modules/tools/builtins/ask-user-questions-store'
import { ToolDomainError } from '../main/modules/tools/tool-errors'
import { ASK_USER_ERROR_KINDS } from '../main/modules/agent-control/contracts/error-kinds'
import { TOOL_ERROR_METRICS } from '../main/modules/agent-control/tools-runtime/tool-error-metrics'

function makeFakeDb(opts: {
  rowExists?: boolean
  /** When 'throws', updateChatMessageMeta throws on first call. */
  updateBehavior?: 'success' | 'returns_false' | 'throws'
  throwError?: Error
} = {}): {
  db: CancelDbAccess
  writes: Array<{ id: string; meta: Record<string, unknown> }>
} {
  const writes: Array<{ id: string; meta: Record<string, unknown> }> = []
  const rowExists = opts.rowExists ?? true
  let tripped = false
  const db: CancelDbAccess = {
    getChatMessageById(_id) {
      if (!rowExists) return null
      return {
        meta_json: JSON.stringify({
          askUserQuestions: { cardId: 'card-1', status: 'pending', questions: [], askedAt: 1 },
        }),
      }
    },
    updateChatMessageMeta(id, meta) {
      if (!tripped) {
        tripped = true
        if (opts.updateBehavior === 'returns_false') return false
        if (opts.updateBehavior === 'throws') {
          throw opts.throwError ?? new Error('SQLITE_BUSY')
        }
      }
      writes.push({ id, meta })
      return true
    },
  }
  return { db, writes }
}

const QS: AskUserQuestionSpec[] = [
  { id: 'q1', question: 'q', kind: 'free_text', required: false },
]

function registerPendingCard(store: AskUserQuestionsStore, cardId: string): {
  promise: Promise<AskUserQuestionsAnswerSet>
  silent: Promise<AskUserQuestionsAnswerSet | null>
} {
  let resolveFn: (a: AskUserQuestionsAnswerSet) => void = () => {}
  let rejectFn: (e: Error) => void = () => {}
  const promise = new Promise<AskUserQuestionsAnswerSet>((resolve, reject) => {
    resolveFn = resolve
    rejectFn = reject
  })
  const silent = promise.catch(() => null)
  store.register({
    cardId,
    sessionId: 'sess-1',
    conversationId: 'conv-1',
    questions: QS,
    askedAt: 1,
    resolve: resolveFn,
    reject: rejectFn,
    timeoutHandle: setTimeout(() => {}, 86400000),
  })
  return { promise, silent }
}

test('cancel happy path: store.reject + DB write to cancelled, IPC returns success', async () => {
  const store = new AskUserQuestionsStore()
  const { promise } = registerPendingCard(store, 'card-1')
  const { db, writes } = makeFakeDb()
  const result = cancelAskUserQuestionsCardCore('card-1', 'user_cancelled', {
    store, db, now: () => 9999,
  })
  assert.equal(result.success, true)
  assert.equal(writes.length, 1)
  const meta = writes[0].meta.askUserQuestions as { status: string; cancelReason: string; cancelledAt: number }
  assert.equal(meta.status, 'cancelled')
  assert.equal(meta.cancelReason, 'user_cancelled')
  assert.equal(meta.cancelledAt, 9999)
  assert.equal(store.size(), 0, 'in-memory record terminated')
  await assert.rejects(
    promise,
    (err: unknown) => err instanceof ToolDomainError
      && err.errorKind === ASK_USER_ERROR_KINDS.userCancelled.code,
  )
})

test('cancel with reason=user_typed_instead maps to errorKind=user_skipped on the Promise', async () => {
  const store = new AskUserQuestionsStore()
  const { promise } = registerPendingCard(store, 'card-1')
  const { db } = makeFakeDb()
  const result = cancelAskUserQuestionsCardCore('card-1', 'user_typed_instead', { store, db })
  assert.equal(result.success, true)
  await assert.rejects(
    promise,
    (err: unknown) => err instanceof ToolDomainError
      && err.errorKind === ASK_USER_ERROR_KINDS.userSkipped.code,
  )
})

test('B.4a: DB throw still rejects Promise + returns cancel_persist_failed + emits metric', async () => {
  const store = new AskUserQuestionsStore()
  const { promise } = registerPendingCard(store, 'card-1')
  const { db, writes } = makeFakeDb({ updateBehavior: 'throws', throwError: new Error('disk full') })
  const metrics: Array<{ name: string; payload: Record<string, unknown> }> = []
  const result = cancelAskUserQuestionsCardCore('card-1', 'user_cancelled', {
    store,
    db,
    logMetric: (name, payload) => { metrics.push({ name, payload }) },
  })
  assert.equal(result.success, false)
  if (result.success) throw new Error('unreachable')
  assert.equal(result.errorKind, ASK_USER_ERROR_KINDS.cancelPersistFailed.code)
  assert.match(result.error, /disk full/)
  assert.equal(writes.length, 0, 'no DB write recorded after throw')
  assert.equal(metrics.length, 1)
  assert.equal(metrics[0].name, TOOL_ERROR_METRICS.askUserQuestionsCancelPersistFailed)
  // Critical: Promise was STILL rejected so the handler isn't stuck 24h.
  await assert.rejects(
    promise,
    (err: unknown) => err instanceof ToolDomainError
      && err.errorKind === ASK_USER_ERROR_KINDS.userCancelled.code,
  )
})

test('cancel unknown cardId: success (DB row may or may not be written), no Promise to reject', () => {
  const store = new AskUserQuestionsStore()
  // No registerPendingCard — in-memory record absent.
  const { db, writes } = makeFakeDb({ rowExists: false })
  const result = cancelAskUserQuestionsCardCore('no-such-card', 'user_cancelled', { store, db })
  assert.equal(result.success, true)
  assert.equal(writes.length, 0)
})

test('cancel DB returns false (row already gone) is treated as benign no-op', async () => {
  // updateChatMessageMeta returning false should NOT poison the IPC result —
  // it's "row already gone" which is what cancel wants anyway. The Promise
  // is still rejected so the handler unblocks.
  const store = new AskUserQuestionsStore()
  const { promise } = registerPendingCard(store, 'card-1')
  const { db } = makeFakeDb({ updateBehavior: 'returns_false' })
  const result = cancelAskUserQuestionsCardCore('card-1', 'user_cancelled', { store, db })
  assert.equal(result.success, true)
  await assert.rejects(
    promise,
    (err: unknown) => err instanceof ToolDomainError,
  )
})
